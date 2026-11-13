'use strict'
// Claude's changes in the gutter, the host's half (design-editor.md §4 "Claude's changes in the
// gutter"): the file as git `HEAD` has it, read through ctx.processes.spawn with the argv
//
//   git -c safe.bareRepository=explicit -c protocol.allow=never ... cat-file blob HEAD:./<path>
//
// (the `-c` config: SAFE_CONFIG below)
// run in the project folder. `./` makes the path relative to that folder (it may be a subfolder of
// the repository), and the whole `HEAD:./<path>` is ONE argument that starts with `HEAD`, so a path
// that begins with `-` (or holds a `:`, a space, a newline) can never be an option or another
// revision. Only the tab's own path (its params, put there by this plugin) is ever used; the page
// asks "the base of my file" and names nothing. `cat-file blob` prints the stored bytes: no
// textconv, no filter, no hook, no pager, and it writes nothing of its own (no index refresh, no lock; only in a partial clone
// git may fetch a blob it lacks from the promisor remote).
//
// Not a repository, no commit yet, git not installed, a file HEAD does not have (untracked, new in
// the index, ignored) or one it has as a link, a binary or too large blob, bytes that are not UTF-8:
// all the same answer, `has: false`, and the page draws no marks. The page does the line diff (it
// holds the buffer); this side only hands over the text the way the page sees a file: BOM off, CRLF
// as LF (files.decodeBytes), so a Windows file or a core.autocrlf checkout does not show as changed.
//
// Protocol (page <-> host, beside lib/files.js's):
//   page -> host  { t: 'git-base', req }                  the file's text at HEAD
//   host -> page  { t: 'git-base', req, has, part?, parts?, text? }   has: false: no marks; else in parts under the message cap
//   page -> host  { t: 'git-review' }                     a click on a mark: the Reviewer's diff of this file
//   host -> page  { t: 'git-review-error', message }      it could not be opened (no Reviewer, the overlay refused)
// One read per tab instance: a new one kills the one before. At most MAX_GIT_PROCESSES git children
// for the whole plugin; a read over that waits for a slot, so the answer is only late (they share ctx.processes' per-plugin cap of 16 with the language servers and rg).

const fs = require('node:fs')
const path = require('node:path')
const files = require('./files.js')
const { programPath } = require('./lsp/servers.js')

/** A blob over this many bytes gets no marks: the page diffs it on every pause in typing, and a 5 MB+ file is read-only there anyway. */
const MAX_BASE_BYTES = 2 * 1024 * 1024
/** git is killed after this long (a network filesystem, a huge repository's cold object store). */
const GIT_TIMEOUT_MS = 10 * 1000
/** A NUL in the first this-many bytes makes a blob binary (git's heuristic, as files.js). */
const BINARY_SNIFF_BYTES = 8000
/** At most this many git children of this plugin at once, every tab instance together. */
const MAX_GIT_PROCESSES = 2

/**
 * Config put before the command (`git -c k=v ...`): command-line config wins over every config file,
 * and git hands it to the children it starts (GIT_CONFIG_PARAMETERS), a lazy fetch's included.
 * The read runs in the file's own folder, so git's discovery would also take an EMBEDDED BARE
 * repository a cloned project ships (a folder with HEAD, config, objects/, refs/ beside the file):
 * its config is the project author's, and with `extensions.partialClone`, a promisor remote and
 * `core.sshCommand` a blob missing from its HEAD tree would make `cat-file` fetch it and run that
 * command when the file merely opens. `safe.bareRepository=explicit` (git 2.38+) refuses to discover
 * a bare repository at all; for an older git, every transport is refused: `protocol.allow=never`,
 * and again per protocol, since a repository's own `protocol.<name>.allow` would win over the
 * general key. An unknown key is ignored by an older git, so none of this can fail the read.
 * (`--no-lazy-fetch` would fail on a git older than 2.45, and ctx.processes takes no env for
 * GIT_NO_LAZY_FETCH.)
 */
const SAFE_CONFIG = [
  'safe.bareRepository=explicit',
  'protocol.allow=never',
  ...['file', 'git', 'ssh', 'http', 'https', 'ext', 'fd'].map((p) => `protocol.${p}.allow=never`),
].flatMap((kv) => ['-c', kv])

/** The argv for the file at `rel` (project-relative, as the tab's params hold it). */
function blobArgv(rel, bin = 'git') {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) throw new Error('no file')
  // The tab's params are the plugin's own, but a saved record outlives this code: never a path that leaves the folder.
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('not a project path')
  return [bin, ...SAFE_CONFIG, 'cat-file', 'blob', `HEAD:./${rel}`]
}

/** The git slots of this plugin: the module is loaded once per plugin host, so every tab shares them. */
const pluginSlots = { used: 0, max: MAX_GIT_PROCESSES, queue: [] }

/**
 * Reads `rel`'s text at HEAD: `{ result: Promise<{ text: string | null }>, cancel }`. `text` is null
 * for every case that means "no marks" (see the top); the promise rejects only when nothing could be
 * asked at all (ctx.processes' own cap, a cwd that is not a directory). A read over the plugin's git
 * cap waits for a slot.
 */
function readBase(spawn, cwd, rel, opts = {}) {
  const slots = opts.slots || pluginSlots
  const none = { result: Promise.resolve({ text: null }), cancel() {} }
  let argv
  try {
    argv = blobArgv(rel, opts.bin)
  } catch {
    return none
  }
  // git runs in the file's own directory (`HEAD:./<name>`), so a file in a submodule or in a nested
  // repository under a project folder that is no repository itself finds its own repository. A directory
  // that resolves outside the project (a symlink) never gets a git run in it; one that is gone (deleted
  // under an open tab) or not a real path (a test) falls back to the project folder and `HEAD:./<rel>`.
  let runIn = cwd
  try {
    const dir = path.dirname(path.join(cwd, rel))
    const real = fs.realpathSync(dir)
    const root = fs.realpathSync(cwd)
    if (real !== root) {
      if (!real.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) return none
      runIn = dir
      argv[argv.length - 1] = `HEAD:./${path.basename(rel)}`
    }
  } catch {
    // Fall back as above.
  }
  // A tracked link: HEAD has the link's target path as text, the page shows the target's content.
  // A file gone from disk (deleted under an open tab) is not a link: its buffer is still compared with HEAD.
  try {
    if (fs.lstatSync(path.join(cwd, rel)).isSymbolicLink()) return none
  } catch {
    // Not there (or unreadable): git says what HEAD has.
  }

  let child = null
  let stopped = false
  let over = false
  let timedOut = false
  let started = false
  let finish = () => {}
  let fail = () => {}
  const result = new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  const chunks = []
  let bytes = 0
  const stop = () => {
    if (stopped) return
    stopped = true
    if (!started) {
      // Still waiting for a slot: leave the line, nothing was spawned.
      const i = slots.queue ? slots.queue.indexOf(start) : -1
      if (i >= 0) slots.queue.splice(i, 1)
      finish({ text: null })
      return
    }
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  // Gives the slot back and lets the next waiting read run: a busy plugin queues the ask, so the page
  // never takes "busy" for "this file has no base" and drops the marks it had.
  const release = () => {
    slots.used--
    runNext()
  }
  // The next waiting read, when a slot is free. Also after a spawn that threw: that read took no
  // slot and never exits, so without this the reads queued behind it would wait for a git that is
  // not running (no marks until the page asks again).
  const runNext = () => {
    if (slots.used >= slots.max) return
    const next = slots.queue && slots.queue.shift()
    if (next) next()
  }
  function start() {
    if (stopped) return
    try {
      child = spawn(argv, { cwd: runIn })
    } catch (e) {
      // "cannot run" (ENOENT, EACCES: ctx.processes' own words) is git missing: no marks, not an error.
      if (e && typeof e.message === 'string' && e.message.includes('cannot run')) finish({ text: null })
      else fail(e instanceof Error ? e : new Error(String(e)))
      return runNext()
    }
    started = true
    slots.used++
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs ?? GIT_TIMEOUT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    child.onData((b) => {
      if (stopped) return
      bytes += b.length
      if (bytes > (opts.maxBytes ?? MAX_BASE_BYTES)) {
        over = true
        stop()
        return
      }
      chunks.push(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
    })
    // git's complaint (not a repository, not in HEAD) says nothing the page needs; drained, not kept.
    if (typeof child.onStderr === 'function') child.onStderr(() => {})
    let exited = false
    child.onExit(({ code }) => {
      // Once, whatever the stream says: a slot given back twice would let a third git in.
      if (exited) return
      exited = true
      clearTimeout(timer)
      release()
      if (code !== 0 || over || timedOut || stopped) return finish({ text: null })
      finish({ text: textOf(Buffer.concat(chunks)) })
    })
    try {
      if (typeof child.end === 'function') child.end()
    } catch {
      // The child may already be gone.
    }
  }
  if (slots.used >= slots.max) {
    if (!slots.queue) slots.queue = []
    slots.queue.push(start)
  } else {
    start()
  }
  return { result, cancel: stop }
}

/** The blob as the page sees a file (BOM off, LF), or null for a binary or non-UTF-8 one. */
function textOf(buf) {
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null
  const d = files.decodeBytes(buf)
  return d.encoding ? d.text : null
}

/**
 * Serves `git-base` and `git-review` for one tab instance. `rel` is the tab's own project-relative
 * path (undefined for a tab with none: a file outside the project), `review(rel)` opens the Reviewer's
 * diff (a promise). Returns `handle(m)`: true when it took the message.
 */
function serveGit(tab, { spawn, root, rel, review, log, bin, slots }) {
  let running = null
  let closed = false
  const post = (m) => {
    if (!closed) tab.post(m)
  }
  const cancel = () => {
    if (!running) return
    running.cancelled = true
    running.cancel()
    running = null
  }
  tab.onClose(() => {
    closed = true
    cancel()
  })

  return function handle(m) {
    if (!m || typeof m !== 'object') return false
    if (m.t === 'git-base') {
      const req = m.req
      // git by its absolute path from the absolute PATH entries (lsp/servers.js programPath): the bare
      // name would let the spawn's PATH search take `.` or `node_modules/.bin` from the project. Not
      // installed there: no marks, as for a git that cannot run.
      const program = bin !== undefined ? bin : programPath('git')
      if (typeof spawn !== 'function' || typeof rel !== 'string' || !program) {
        post({ t: 'git-base', req, has: false })
        return true
      }
      cancel()
      const job = readBase(spawn, root, rel, { bin: program, slots })
      running = job
      job.result.then(
        ({ text }) => {
          // Superseded or cancelled: the page asked again since, only the newest answer counts.
          if (running !== job || job.cancelled) return
          running = null
          if (text === null) return post({ t: 'git-base', req, has: false })
          const parts = files.chunkText(text)
          parts.forEach((part, i) => post({ t: 'git-base', req, has: true, part: i, parts: parts.length, text: part }))
        },
        (e) => {
          if (running !== job || job.cancelled) return
          running = null
          // Nothing is sent: `has: false` would wipe the marks the page has, and a failed read says nothing about the file.
          if (log) log.warn(`git base: ${e.message}`)
        }
      )
      return true
    }
    if (m.t === 'git-review') {
      if (typeof review !== 'function' || typeof rel !== 'string') return true
      Promise.resolve()
        .then(() => review(rel))
        .catch((e) => post({ t: 'git-review-error', message: `Could not open the diff: ${e && e.message ? e.message : e}` }))
      return true
    }
    return false
  }
}

module.exports = { MAX_BASE_BYTES, MAX_GIT_PROCESSES, blobArgv, readBase, serveGit }
