// Quick open (Ctrl+P) and find in files (Ctrl+Shift+F) in the file tab page, with no DOM (file.js
// draws them; node:test drives this with fakes). The host runs rg (dist/lib/search.js) and answers in
// parts; this keeps which request is current, joins the parts, filters the file list fuzzily and
// groups the matches by file. An answer to a request that is no longer current (the person typed
// on, the panel closed) is dropped.

/** At most this many rows in the quick open list. */
export const MAX_ROWS = 200
/** The file list is fetched again when it is older than this (files come and go while you work). */
export const FILES_TTL_MS = 15 * 1000
/** Find in files waits this long after the last key before it asks the host. */
export const GREP_DEBOUNCE_MS = 250

const SEPARATORS = '/._- '

/**
 * Fuzzy match of `query` in `path` (case-insensitive, every query character in order; spaces in the
 * query are ignored): `{ score, positions }` or null. Higher is better: consecutive characters, a
 * character at a word start (after / . _ - or a lower-to-upper change) and characters in the file
 * name (after the last /) score more; a shorter path wins a tie.
 */
export function fuzzyMatch(query, path) {
  const q = query.replace(/\s+/g, '').toLowerCase()
  if (q === '') return { score: 0, positions: [] }
  const lower = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  // The file name first: `fq` should find `src/file-quick.ts` in its name, not in `src/`.
  const tryFrom = (from) => {
    const positions = []
    let i = from
    for (const c of q) {
      const at = lower.indexOf(c, i)
      if (at === -1) return null
      positions.push(at)
      i = at + 1
    }
    return positions
  }
  let positions = nameStart > 0 ? tryFrom(nameStart) : null
  if (!positions) positions = tryFrom(0)
  if (!positions) return null
  let score = 0
  let prev = -2
  for (const at of positions) {
    let s = 1
    if (at === prev + 1) s += 5
    const before = at > 0 ? path[at - 1] : '/'
    if (SEPARATORS.includes(before)) s += 4
    else if (before === before.toLowerCase() && path[at] !== path[at].toLowerCase()) s += 3
    if (at >= nameStart) s += 2
    score += s
    prev = at
  }
  // Ties: the shorter path.
  score -= path.length / 1000
  return { score, positions }
}

/** The best MAX_ROWS of `paths` for `query`: `[{ path, positions }]`; an empty query keeps rg's order. */
export function fuzzyFilter(query, paths, limit = MAX_ROWS) {
  if (query.replace(/\s+/g, '') === '') return paths.slice(0, limit).map((path) => ({ path, positions: [] }))
  const hits = []
  for (const path of paths) {
    const m = fuzzyMatch(query, path)
    if (m) hits.push({ path, positions: m.positions, score: m.score })
  }
  hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return hits.slice(0, limit).map(({ path, positions }) => ({ path, positions }))
}

/** Matches grouped by file, in the order rg gave: `[{ path, matches }]`. */
export function groupMatches(matches) {
  const groups = []
  const byPath = new Map()
  for (const m of matches) {
    let g = byPath.get(m.path)
    if (!g) {
      g = { path: m.path, matches: [] }
      byPath.set(m.path, g)
      groups.push(g)
    }
    g.matches.push(m)
  }
  return groups
}

/** `text` split by `ranges` ([[from, to]], sorted or not) into `[{ text, hit }]` pieces for drawing. */
export function highlightPieces(text, ranges) {
  const sorted = [...ranges].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out = []
  let i = 0
  for (const [a0, b0] of sorted) {
    const a = Math.max(a0, i)
    const b = Math.min(b0, text.length)
    if (b <= a) continue
    if (a > i) out.push({ text: text.slice(i, a), hit: false })
    out.push({ text: text.slice(a, b), hit: true })
    i = b
  }
  if (i < text.length) out.push({ text: text.slice(i), hit: false })
  return out
}

/**
 * The page's side of the search protocol. `deps`: `post(m)`, `now()` (ms), `onFiles(state)`,
 * `onGrep(state)`. `receive(m)` is true when the message was a search answer (taken here).
 *   files state: { loading, paths, truncated, error, missing }
 *   grep state:  { loading, query, groups, count, files, truncated, error, missing }
 */
export function createSearch(deps) {
  let req = 0
  const files = { req: null, at: 0, paths: [], got: [], truncated: false, loading: false, error: null, missing: false }
  const grep = { req: null, query: '', opts: {}, got: [], groups: [], count: 0, files: 0, truncated: false, loading: false, error: null, missing: false }
  let grepTimer = null

  const filesState = () => ({ loading: files.loading, paths: files.paths, truncated: files.truncated, error: files.error, missing: files.missing })
  const grepState = () => ({
    loading: grep.loading,
    query: grep.query,
    groups: grep.groups,
    count: grep.count,
    files: grep.files,
    truncated: grep.truncated,
    error: grep.error,
    missing: grep.missing,
  })

  function askGrep() {
    grepTimer = null
    grep.req = ++req
    grep.got = []
    grep.loading = true
    grep.error = null
    grep.missing = false
    deps.post({ t: 'grep', req: grep.req, query: grep.query, ...grep.opts })
    deps.onGrep(grepState())
  }

  return {
    /** Quick open was opened: the file list, fetched again when stale; the cached one shows meanwhile. */
    loadFiles() {
      if (files.loading) return
      if (files.req !== null && !files.error && deps.now() - files.at < FILES_TTL_MS) return deps.onFiles(filesState())
      files.req = ++req
      files.got = []
      files.loading = true
      files.error = null
      files.missing = false
      deps.post({ t: 'files', req: files.req })
      deps.onFiles(filesState())
    },
    /**
     * The find panel's query or toggles changed: asks after GREP_DEBOUNCE_MS (at once with
     * `now`). An empty query clears the results and stops what runs.
     */
    setGrep(query, opts, now = false) {
      grep.query = query
      grep.opts = { regex: opts.regex === true, caseSensitive: opts.caseSensitive === true, word: opts.word === true }
      if (grepTimer !== null) clearTimeout(grepTimer)
      grepTimer = null
      if (query === '') {
        if (grep.loading) deps.post({ t: 'grep-cancel' })
        grep.req = null
        grep.loading = false
        grep.groups = []
        grep.count = 0
        grep.files = 0
        grep.truncated = false
        grep.error = null
        grep.missing = false
        return deps.onGrep(grepState())
      }
      if (now) return askGrep()
      grepTimer = setTimeout(askGrep, GREP_DEBOUNCE_MS)
    },
    /** The find panel closed: a running search is stopped, its answer dropped. */
    stopGrep() {
      if (grepTimer !== null) clearTimeout(grepTimer)
      grepTimer = null
      if (grep.loading) deps.post({ t: 'grep-cancel' })
      grep.req = null
      grep.loading = false
    },
    /** A new line to the host (reconnect): what was asked and not answered is asked again. */
    connect() {
      if (files.loading) {
        files.loading = false
        files.req = null
        this.loadFiles()
      }
      if (grep.loading) askGrep()
    },
    receive(m) {
      if (!m || typeof m !== 'object') return false
      if (m.t === 'files') {
        if (m.req !== files.req || !files.loading) return true
        if (Array.isArray(m.paths)) files.got.push(...m.paths.filter((p) => typeof p === 'string'))
        if (m.part + 1 < m.parts) return true
        files.paths = files.got
        files.got = []
        files.truncated = m.truncated === true
        files.loading = false
        files.at = deps.now()
        deps.onFiles(filesState())
        return true
      }
      if (m.t === 'grep') {
        if (m.req !== grep.req || !grep.loading) return true
        if (Array.isArray(m.matches)) grep.got.push(...m.matches)
        if (m.part + 1 < m.parts) return true
        grep.groups = groupMatches(grep.got)
        grep.count = grep.got.length
        grep.files = typeof m.files === 'number' ? m.files : grep.groups.length
        grep.got = []
        grep.truncated = m.truncated === true
        grep.loading = false
        deps.onGrep(grepState())
        return true
      }
      if (m.t === 'search-error') {
        const target = m.kind === 'files' ? files : m.kind === 'grep' ? grep : null
        if (target === null) {
          // An open that failed (kind 'open'): said in the panel that asked.
          deps.onOpenError?.(typeof m.message === 'string' ? m.message : 'could not open the file')
          return true
        }
        if (m.req !== target.req) return true
        target.loading = false
        target.error = typeof m.message === 'string' ? m.message : 'search failed'
        target.missing = m.missing === true
        if (target === files) deps.onFiles(filesState())
        else deps.onGrep(grepState())
        return true
      }
      return false
    },
  }
}
