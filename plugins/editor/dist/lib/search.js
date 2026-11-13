'use strict'
// Quick open (Ctrl+P) and find in files (Ctrl+Shift+F) for the file tab page (design-editor.md §5
// "Editing" and "Security"). Both run ripgrep in the project folder through ctx.processes.spawn, so
// the output is read as it comes and the child is killed at a cap (ctx.exec buffers all of it and
// rejects past 10 MiB, which a big repository's file list or a common word reaches):
//
//   rg --no-config --files --null -- .                      the project's files, rg's ignore rules
//   rg --no-config --json ... -e <query> -- .               matches, one JSON object per line
//
// The query is the page's text, so untrusted: it only ever follows `-e` (a query `--pre=sh` or `-f`
// stays a pattern, never an option) and the paths come after `--`. `--no-config` keeps a
// RIPGREP_CONFIG_PATH file from changing the output format this parser reads. The page asks in
// editor terms (`files`, `grep` with three toggles); it never names a program, a flag or a folder.
//
// Protocol (page <-> host, beside lib/files.js's):
//   page -> host  { t: 'files', req }                     the project's files for quick open
//   host -> page  { t: 'files', req, paths, part, parts, truncated }   in parts under the message cap
//   page -> host  { t: 'grep', req, query, regex?, caseSensitive?, word? }
//   host -> page  { t: 'grep', req, matches, part, parts, truncated, files }
//   page -> host  { t: 'grep-cancel' }                    stop a running search (the panel closed)
//   host -> page  { t: 'search-error', req, kind: 'files' | 'grep', message, missing? }
// One search of each kind per tab instance: a new one kills the one before (typing a new query).

/** At most this many files for quick open: far more than a fuzzy list is useful for. */
const MAX_FILES = 50000
/** At most this many matches, and this many files with a match, per search. */
const MAX_MATCHES = 2000
const MAX_MATCH_FILES = 500
/** A match line is cut to about this many characters, around its first match. */
const MAX_LINE_CHARS = 300
/** How much of a cut line comes before its first match. */
const LINE_LEAD_CHARS = 60
/** A query longer than this is refused (a pattern, not a document). */
const MAX_QUERY_CHARS = 1000
/** rg is killed after this long; what it found so far is the (truncated) answer. */
const SEARCH_TIMEOUT_MS = 20 * 1000
/** A line of rg's JSON output over this many bytes is skipped (a minified file's one line), not buffered on. */
const MAX_JSON_LINE_BYTES = 4 * 1024 * 1024
/** One message's text budget, well under the 1 MiB message cap (paths and lines are JSON-escaped). */
const PART_CHARS = 256 * 1024

const RG_HINT =
  'ripgrep (rg) is not installed, or not on your login-shell PATH; quick open and find in files need it. ' +
  'Install it with `brew install ripgrep` (macOS), `sudo pacman -S ripgrep` (Arch) or `sudo apt install ripgrep` ' +
  '(Debian, Ubuntu), or see https://github.com/BurntSushi/ripgrep.'

/** The quick open argv: NUL-separated paths (a file name may hold a newline). */
function filesArgv(bin = 'rg') {
  return [bin, '--no-config', '--files', '--null', '--no-messages', '--', '.']
}

/**
 * The find-in-files argv for the page's query and toggles. Throws on a query that is not a
 * non-empty single-line string within MAX_QUERY_CHARS (rg refuses a newline in a pattern anyway).
 * Literal unless `regex`; case-insensitive unless `caseSensitive`; whole words with `word`.
 */
function grepArgv(query, opts = {}, bin = 'rg') {
  if (typeof query !== 'string' || query === '') throw new Error('the search text is empty')
  if (query.length > MAX_QUERY_CHARS) throw new Error(`the search text is longer than ${MAX_QUERY_CHARS} characters`)
  if (/[\n\r\0]/.test(query)) throw new Error('the search text must be one line')
  const argv = [bin, '--no-config', '--json', '--no-messages']
  argv.push(opts.caseSensitive === true ? '--case-sensitive' : '--ignore-case')
  if (opts.regex !== true) argv.push('--fixed-strings')
  if (opts.word === true) argv.push('--word-regexp')
  // The query only ever right after -e: whatever it starts with, it is the pattern.
  argv.push('-e', query, '--', '.')
  return argv
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** A path rg printed, made project-relative (`./a/b` -> `a/b`), or null when it is not UTF-8 text. */
function cleanPath(bytes) {
  let p
  try {
    p = decoder.decode(bytes)
  } catch {
    return null // not UTF-8: no tab could name it either
  }
  if (p.startsWith('./')) p = p.slice(2)
  return p === '' ? null : p
}

/**
 * Splits a byte stream on `sep` (0 or 10), across chunks. `onItem(bytes)` per complete item;
 * an item over `maxBytes` is dropped whole (its rest is skipped up to the next separator).
 */
function splitter(sep, onItem, maxBytes = Infinity) {
  let held = []
  let heldBytes = 0
  let skipping = false
  return {
    push(chunk) {
      let start = 0
      for (let i = chunk.indexOf(sep); i !== -1; i = chunk.indexOf(sep, start)) {
        const piece = chunk.subarray(start, i)
        if (!skipping) {
          const item = held.length ? Buffer.concat([...held, piece]) : Buffer.from(piece)
          if (item.length <= maxBytes) onItem(item)
        }
        held = []
        heldBytes = 0
        skipping = false
        start = i + 1
      }
      if (start < chunk.length && !skipping) {
        const rest = chunk.subarray(start)
        heldBytes += rest.length
        if (heldBytes > maxBytes) {
          held = []
          heldBytes = 0
          skipping = true
        } else held.push(Buffer.from(rest))
      }
    },
    /** The last item, when the stream did not end with a separator. */
    end() {
      if (!skipping && held.length) onItem(Buffer.concat(held))
      held = []
      heldBytes = 0
    },
  }
}

/** UTF-16 offset in `text` of byte offset `byte` of its UTF-8 form. */
function charOffset(bytes, byte) {
  return bytes.subarray(0, Math.max(0, Math.min(byte, bytes.length))).toString('utf8').length
}

/**
 * One line of `rg --json` as a match `{ path, line, col, text, ranges: [[from, to]], cut }`, or null
 * (not a match, a path or line that is not UTF-8 text, malformed). `col` is the first match's
 * 1-based column in the whole line (UTF-16, as the page's editor counts); `text` is the line, cut to
 * about MAX_LINE_CHARS around the first match, `cut` how many characters were dropped before it, and
 * `ranges` are the matches in `text`. Exported for tests.
 */
function parseMatch(line) {
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return null
  }
  if (!o || o.type !== 'match' || !o.data || typeof o.data !== 'object') return null
  const d = o.data
  const p = d.path && typeof d.path.text === 'string' ? d.path.text : null
  const full = d.lines && typeof d.lines.text === 'string' ? d.lines.text : null
  if (p === null || full === null || !Number.isInteger(d.line_number) || d.line_number < 1) return null
  const rel = p.startsWith('./') ? p.slice(2) : p
  const text = full.replace(/\r?\n$/, '')
  const bytes = Buffer.from(text, 'utf8')
  const subs = Array.isArray(d.submatches) ? d.submatches : []
  const ranges = []
  for (const s of subs) {
    if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || s.end < s.start) continue
    const from = charOffset(bytes, s.start)
    const to = charOffset(bytes, s.end)
    if (from <= text.length) ranges.push([from, Math.min(to, text.length)])
  }
  const first = ranges.length ? ranges[0][0] : 0
  let cut = 0
  let shown = text
  if (text.length > MAX_LINE_CHARS) {
    cut = Math.max(0, Math.min(first - LINE_LEAD_CHARS, text.length - MAX_LINE_CHARS))
    shown = text.slice(cut, cut + MAX_LINE_CHARS)
  }
  // The matches inside the shown part, clipped to it; one wholly cut off is dropped.
  const inShown = []
  for (const [a, b] of ranges) {
    const from = a - cut
    const to = b - cut
    if (to < 0 || from > shown.length || (to === 0 && from < 0)) continue
    inShown.push([Math.max(0, from), Math.min(shown.length, to)])
  }
  return { path: rel, line: d.line_number, col: first + 1, text: shown, cut, ranges: inShown }
}

/**
 * Runs `argv` through `spawn` (ctx.processes.spawn's shape) in `cwd`, feeding stdout to
 * `onBytes(chunk, stop)`; `stop()` kills the child once a cap is reached. Resolves
 * `{ code, stderr, stopped, timedOut }`; rejects only when the program cannot be started.
 */
function run(spawn, argv, cwd, onBytes, timeoutMs = SEARCH_TIMEOUT_MS) {
  let child
  try {
    child = spawn(argv, { cwd })
  } catch (e) {
    const err = new Error(RG_HINT)
    err.missing = true
    err.cause = e
    return { result: Promise.reject(err), cancel() {} }
  }
  let stopped = false
  let timedOut = false
  let stderr = ''
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.onData((bytes) => {
      if (!stopped) onBytes(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), stop)
    })
    child.onStderr((bytes) => {
      if (stderr.length < 4000) stderr += Buffer.from(bytes).toString('utf8')
    })
    child.onExit(({ code }) => {
      clearTimeout(timer)
      resolve({ code, stderr: stderr.trim(), stopped, timedOut })
    })
  })
  // rg reads no stdin with a path given; closed so nothing could wait on it.
  try {
    if (typeof child.end === 'function') child.end()
  } catch {
    // The child may already be gone.
  }
  return { result, cancel: stop }
}

/** The project's files for quick open: `{ result: Promise<{ paths, truncated }>, cancel }`. */
function listFiles(spawn, cwd, opts = {}) {
  const max = opts.maxFiles ?? MAX_FILES
  const paths = []
  let truncated = false
  const split = splitter(0, (bytes) => {
    const p = cleanPath(bytes)
    if (p !== null && paths.length < max) paths.push(p)
  })
  const r = run(spawn, filesArgv(opts.bin), cwd, (chunk, stop) => {
    split.push(chunk)
    if (paths.length >= max) {
      truncated = true
      stop()
    }
  }, opts.timeoutMs)
  return {
    cancel: r.cancel,
    result: r.result.then((x) => {
      if (!x.stopped) split.end()
      // rg: 0 found some, 1 found none, 2 an error (with --no-messages, a fatal one).
      if (x.code === 2 && paths.length === 0 && !x.stopped) throw new Error(x.stderr || 'rg failed')
      return { paths: paths.slice(0, max), truncated: truncated || x.timedOut }
    }),
  }
}

/** Find in files: `{ result: Promise<{ matches, files, truncated }>, cancel }`; throws on a bad query. */
function grep(spawn, cwd, query, opts = {}) {
  const argv = grepArgv(query, opts, opts.bin)
  const maxMatches = opts.maxMatches ?? MAX_MATCHES
  const maxFiles = opts.maxMatchFiles ?? MAX_MATCH_FILES
  const matches = []
  const files = new Set()
  let truncated = false
  let full = false
  const split = splitter(10, (bytes) => {
    if (full) return
    const m = parseMatch(bytes.toString('utf8'))
    if (!m) return
    if (!files.has(m.path) && files.size >= maxFiles) {
      full = true
      return
    }
    files.add(m.path)
    matches.push(m)
    if (matches.length >= maxMatches) full = true
  }, MAX_JSON_LINE_BYTES)
  const r = run(spawn, argv, cwd, (chunk, stop) => {
    split.push(chunk)
    if (full) {
      truncated = true
      stop()
    }
  }, opts.timeoutMs)
  return {
    cancel: r.cancel,
    result: r.result.then((x) => {
      if (!x.stopped) split.end()
      if (x.code === 2 && matches.length === 0 && !x.stopped) {
        // A regex rg cannot compile is the usual case: its own words say where.
        throw new Error(x.stderr ? x.stderr.split('\n').slice(0, 6).join('\n') : 'rg failed')
      }
      return { matches, files: files.size, truncated: truncated || full || x.timedOut }
    }),
  }
}

/** Splits `items` into arrays whose summed size (by `size`) stays near PART_CHARS; at least one part. */
function partsOf(items, size, budget = PART_CHARS) {
  const parts = [[]]
  let used = 0
  for (const it of items) {
    const n = size(it) + 16
    if (used + n > budget && parts[parts.length - 1].length) {
      parts.push([])
      used = 0
    }
    parts[parts.length - 1].push(it)
    used += n
  }
  return parts
}

const matchSize = (m) => m.path.length + m.text.length * 2 + 40

/**
 * Serves `files`, `grep` and `grep-cancel` for one tab instance (its line to the page). Returns
 * `handle(m)`: true when it took the message. `spawn` is ctx.processes.spawn; `root` the project.
 * A closed line kills what runs and posts nothing more.
 */
function serveSearch(tab, { spawn, root, log, bin }) {
  const running = { files: null, grep: null }
  let closed = false
  const post = (m) => {
    if (!closed) tab.post(m)
  }
  const fail = (kind, req, e) =>
    post({ t: 'search-error', kind, req, message: e && e.message ? e.message : String(e), ...(e && e.missing ? { missing: true } : {}) })

  /**
   * Runs `job` as this line's one search of `kind`, killing the one before; `onDone` and `onFail`
   * are called only while it is still the current one (a superseded or cancelled search's partial
   * answer is never posted: the page asked something else since).
   */
  function start(kind, job, onDone, onFail) {
    if (running[kind]) running[kind].cancel()
    running[kind] = job
    job.result.then(
      (r) => {
        if (running[kind] !== job || job.cancelled) return
        running[kind] = null
        onDone(r)
      },
      (e) => {
        if (running[kind] !== job || job.cancelled) return
        running[kind] = null
        onFail(e)
      }
    )
  }
  const cancel = (kind) => {
    const job = running[kind]
    if (!job) return
    job.cancelled = true
    running[kind] = null
    job.cancel()
  }

  tab.onClose(() => {
    closed = true
    cancel('files')
    cancel('grep')
  })

  return function handle(m) {
    if (!m || typeof m !== 'object') return false
    if (m.t === 'files') {
      const req = m.req
      if (typeof spawn !== 'function') {
        fail('files', req, new Error('quick open needs a newer cockpit (ctx.processes)'))
        return true
      }
      start(
        'files',
        listFiles(spawn, root, { bin }),
        ({ paths, truncated }) => {
          const parts = partsOf(paths, (p) => p.length)
          parts.forEach((list, i) => post({ t: 'files', req, paths: list, part: i, parts: parts.length, truncated }))
        },
        (e) => {
          if (log && !e.missing) log.warn(`quick open: ${e.message}`)
          fail('files', req, e)
        }
      )
      return true
    }
    if (m.t === 'grep') {
      const req = m.req
      if (typeof spawn !== 'function') {
        fail('grep', req, new Error('find in files needs a newer cockpit (ctx.processes)'))
        return true
      }
      let job
      try {
        job = grep(spawn, root, m.query, { regex: m.regex === true, caseSensitive: m.caseSensitive === true, word: m.word === true, bin })
      } catch (e) {
        fail('grep', req, e)
        return true
      }
      start(
        'grep',
        job,
        ({ matches, files, truncated }) => {
          const parts = partsOf(matches, matchSize)
          parts.forEach((list, i) => post({ t: 'grep', req, matches: list, part: i, parts: parts.length, truncated, files }))
        },
        (e) => fail('grep', req, e)
      )
      return true
    }
    if (m.t === 'grep-cancel') {
      cancel('grep')
      return true
    }
    return false
  }
}

module.exports = {
  MAX_FILES,
  MAX_MATCHES,
  MAX_MATCH_FILES,
  MAX_LINE_CHARS,
  MAX_QUERY_CHARS,
  RG_HINT,
  filesArgv,
  grepArgv,
  parseMatch,
  splitter,
  listFiles,
  grep,
  partsOf,
  serveSearch,
}
