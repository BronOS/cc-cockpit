'use strict'
// The incremental scan: which transcript bytes are new since the last pass, read into the aggregate
// (store.js). Only the window holding the lease (share.js) runs it; its state is saved to one file in
// ctx.appDataDir, so the next leader (another window, or the app after a restart) continues from the
// same offsets instead of reading hundreds of MB again. The file has one writer at a time (the
// lease) and is replaced by a rename, so a reader never sees half of it; a missing or unreadable one
// is only a full rescan.
//
// Per file it remembers { dev, ino, size, mtimeMs, offset, head, titled }:
// - same size and mtime: skipped without opening it;
// - grown: the head bytes are compared (a file rewritten under the same name and inode) and only
//   [offset, size) is read;
// - shrunk, another inode, or another head: read again from 0. The message keys make that safe:
//   what was counted before is not counted twice, what is new is added.
// A file last written before the kept window (store.RETAIN_DAYS) is not read at all: none of its
// messages could count.
const fs = require('node:fs')
const path = require('node:path')
const store = require('./store')
const transcripts = require('./transcripts')

const STATE_VERSION = 1

/** Bytes of transcript read between two pauses, and the pause: a full first pass stays in the background. */
const BUDGET_BYTES = 2 * 1024 * 1024
const PAUSE_MS = 25

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const yieldNow = () => new Promise((r) => setImmediate(r))

class Scanner {
  /**
   * `roots`: the transcripts' `projects` folders; `statePath`: the state file (null: memory only);
   * `now`: the clock; `budgetBytes` / `pauseMs`: the CPU cap (tests pass small ones).
   */
  constructor({ roots, statePath = null, now = Date.now, log = null, budgetBytes = BUDGET_BYTES, pauseMs = PAUSE_MS }) {
    this.roots = roots
    this.statePath = statePath
    this.now = now
    this.log = log
    this.budgetBytes = budgetBytes
    this.pauseMs = pauseMs
    this.state = store.emptyState()
    this.files = {}
    this.loaded = false
    this.stopped = false
    this.dirty = false
    this.sinceRest = 0
    /** Transcript bytes read since this scanner was made (tests and the log). */
    this.bytesRead = 0
  }

  /** Load the saved state (once); a missing or bad file starts empty. */
  async load() {
    if (this.loaded) return
    this.loaded = true
    if (!this.statePath) return
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8'))
      if (!raw || raw.version !== STATE_VERSION) return
      this.state = store.fromJSON(raw.aggregate)
      if (raw.files && typeof raw.files === 'object') {
        for (const [p, f] of Object.entries(raw.files)) {
          if (f && typeof f === 'object' && Number.isFinite(f.offset) && Number.isFinite(f.size)) this.files[p] = f
        }
      }
    } catch (e) {
      if (e && e.code !== 'ENOENT' && this.log) this.log.warn(`state: ${e.message}; scanning from scratch`)
    }
  }

  /** Write the state file if a pass changed anything: a temp file, then a rename over the old one. */
  async save() {
    if (!this.statePath || !this.dirty) return
    const data = JSON.stringify({ version: STATE_VERSION, files: this.files, aggregate: store.toJSON(this.state) })
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    await fs.promises.writeFile(tmp, data, { mode: 0o600 })
    await fs.promises.rename(tmp, this.statePath)
    this.dirty = false
  }

  /** Forget everything in memory; the next scan loads the state file again. */
  reset() {
    this.state = store.emptyState()
    this.files = {}
    this.loaded = false
    this.dirty = false
  }

  stop() {
    this.stopped = true
  }

  /** The CPU budget: a macrotask yield after each chunk, a short sleep after every budgetBytes. */
  async pace(bytes) {
    this.bytesRead += bytes
    this.sinceRest += bytes
    if (this.sinceRest >= this.budgetBytes) {
      this.sinceRest = 0
      await sleep(this.pauseMs)
    } else await yieldNow()
  }

  /**
   * One pass over every transcript. `onProgress()` is called after each file that added something
   * (the host publishes a first, partial aggregate during a long first pass). Resolves whether
   * anything was counted.
   */
  async scan(onProgress = () => {}) {
    await this.load()
    const now = this.now()
    const oldest = new Date(store.dayBefore(now, store.RETAIN_DAYS - 1) + 'T00:00:00').getTime()
    const found = await transcripts.discover(this.roots)
    const seen = new Set()
    let changed = false
    for (const file of found) {
      if (this.stopped) break
      seen.add(file.path)
      let added = false
      try {
        added = await this.scanFile(file, now, oldest)
      } catch (e) {
        // A file deleted between the listing and the read, or unreadable: next pass tries again.
        if (this.log && e && e.code !== 'ENOENT') this.log.warn(`scan ${file.path}: ${e.message}`)
      }
      if (added) {
        changed = true
        onProgress()
      }
    }
    if (!this.stopped) {
      // A transcript that is gone keeps what it added (the messages happened); only its offset goes.
      for (const p of Object.keys(this.files)) {
        if (!seen.has(p)) {
          delete this.files[p]
          this.dirty = true
        }
      }
    }
    store.prune(this.state, now)
    return changed
  }

  async scanFile(file, now, oldest) {
    const st = await fs.promises.stat(file.path)
    if (!st.isFile()) return false
    const prev = this.files[file.path]
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && prev.ino === st.ino && prev.dev === st.dev) return false
    if (!prev && st.mtimeMs < oldest) {
      // Last written before the kept window: nothing in it can count. Remember where it ends, so an
      // append (a resumed session) is read from there.
      this.files[file.path] = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset: st.size, head: null, headLen: 0, titled: true }
      this.dirty = true
      return false
    }
    let from = 0
    let titled = file.sidechain
    if (prev && prev.dev === st.dev && prev.ino === st.ino && st.size >= prev.offset) {
      from = prev.offset
      titled = prev.titled
      if (from > 0 && prev.head && Number.isInteger(prev.headLen) && prev.headLen > 0) {
        // The head as it was first read (headLen bytes, fewer than HEAD_BYTES for a tiny first read).
        const handle = await fs.promises.open(file.path, 'r')
        let head
        try {
          head = await transcripts.readHead(handle, prev.headLen)
        } finally {
          await handle.close()
        }
        if (head !== prev.head) {
          from = 0
          titled = file.sidechain
        }
      }
    }
    let added = false
    const state = this.state
    const onLine = (line) => {
      if (line.includes('"usage"')) {
        const msg = transcripts.parseUsageLine(line)
        if (msg && store.addMessage(state, msg, file.sessionId, now, file.projectDir)) added = true
        return
      }
      if (!titled && line.includes('"type":"user"')) {
        const title = transcripts.parseTitleLine(line)
        if (title) {
          store.setTitle(state, file.sessionId, title)
          titled = true
        }
      }
    }
    const offset = await transcripts.readLines(file.path, from, st.size, onLine, (n) => this.pace(n), () => this.stopped)
    let head = prev && from > 0 ? prev.head : null
    let headLen = prev && from > 0 ? prev.headLen : 0
    if (!head && offset > 0) {
      headLen = Math.min(transcripts.HEAD_BYTES, offset)
      const handle = await fs.promises.open(file.path, 'r')
      try {
        head = await transcripts.readHead(handle, headLen)
      } finally {
        await handle.close()
      }
    }
    // Remember the size only when the read reached it: a partial last line, or a stop, keeps the
    // file "changed" for the next pass.
    const size = offset === st.size ? st.size : offset
    this.files[file.path] = { dev: st.dev, ino: st.ino, size, mtimeMs: st.mtimeMs, offset, head, headLen, titled }
    this.dirty = true
    return added
  }

  /** What other windows read: the aggregate fitted to appStorage's value cap (store.fittedSnapshot). */
  snapshot() {
    return store.fittedSnapshot(this.state, this.now())
  }
}

module.exports = { Scanner, STATE_VERSION, BUDGET_BYTES, PAUSE_MS }
