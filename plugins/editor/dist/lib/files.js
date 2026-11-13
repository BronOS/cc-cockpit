'use strict'
// The editor host's files: reading a file for a file tab, saving it by compare-and-swap, and watching
// open files for writes from elsewhere (Claude in a terminal tab, git, another view of the same tab).
// design-editor.md §2 "Files, saving, Claude writing the same file", revision 2: each PAGE keeps its
// own base (the text and hash it last loaded or saved) and does the merge; the host keeps no merge
// state at all. It only answers "your base is still on disk, written" (`saved {hash}`) or "it is
// not, here is what is" (`changed {theirs, hash}`), so two views and a host restart are just more
// writers.
//
// Every path comes from the page, which is untrusted (a page is a plugin page any browser view of
// the project can drive): it is a project-relative path, resolved by realpath, and must still lie in
// the project's realpath. Writes go to that realpath, so a symlink inside the project is followed and
// kept (never replaced by a regular file), and one pointing outside the project is refused.
//
// Plain JS with no build (CLAUDE.md: the editor host is plain JS).

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

/** Text over this many bytes opens read-only: a CodeMirror buffer that size is slow, and a 50 MB log is not edited. */
const MAX_EDIT_BYTES = 5 * 1024 * 1024
/** A read-only file over this many bytes is not shown at all (the tab says why): the chunks would be ~100 messages. */
const MAX_VIEW_BYTES = 16 * 1024 * 1024
/** A NUL in the first this-many bytes makes a file binary (git's heuristic). */
const BINARY_SNIFF_BYTES = 8000
/**
 * Text per message, in UTF-16 code units. A page-tab message is JSON of at most 1 MiB (MAX_PORT_MESSAGE_LENGTH);
 * JSON.stringify writes a control character as `\u00XX` (6 bytes) and a BMP character as at most 3 bytes
 * of UTF-8, so 128 Ki units are at most 768 KiB, leaving room for the envelope (path, hash, flags).
 */
const CHUNK_CHARS = 128 * 1024
/** A save's text, assembled from its parts, may be at most this long (UTF-16 units): what can be edited at all. */
const MAX_SAVE_CHARS = MAX_EDIT_BYTES
/** At most this many saves assembling at once per page line: a page that never sends the last part cannot pile them up. */
const MAX_PENDING_SAVES = 4
/** Watch events within this window are one check: an editor's save is often a truncate, writes and a chmod. */
const WATCH_DEBOUNCE_MS = 80

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** The hash a page keeps as its base and sends back with a save: sha256 of the file's bytes on disk, hex. */
function hashBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * A project-relative path, or a thrown Error: no absolute path, no `..`, no NUL. A backslash is a
 * separator only where the OS says so (Windows): on macOS and Linux `a\b.js` is one valid file name.
 * (The same rule as host.js's relativePath, kept here so this file has no dependency on the host.)
 */
function relativePath(p) {
  if (typeof p !== 'string' || !p.trim() || p.includes('\0')) throw new Error('path must be a non-empty string')
  if (path.isAbsolute(p)) throw new Error(`path must be relative to the project folder: ${p}`)
  const norm = path.posix.normalize(path.sep === '\\' ? p.replace(/\\/g, '/') : p)
  if (norm === '..' || norm.startsWith('../') || norm === '.') throw new Error(`path leaves the project folder: ${p}`)
  return norm.replace(/^\.\//, '')
}

function inside(realRoot, real) {
  return real === realRoot || real.startsWith(realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep)
}

/**
 * Where a page's `rel` really is: `{ rel, real, exists }`. `real` is the file's realpath when it
 * exists (a symlink followed), else the realpath of its folder plus the name (a deleted file being
 * saved again). Throws when the path is malformed, or it, its target or its folder is outside the
 * project's realpath (a link to ~/.ssh/config is refused, not opened). Resolved again on every call:
 * a link Claude re-points between two saves is followed to where it points now.
 */
function resolveInProject(root, rel) {
  const clean = relativePath(rel)
  const realRoot = fs.realpathSync(root)
  const joined = path.join(realRoot, clean)
  let real
  let exists = true
  try {
    real = fs.realpathSync(joined)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    exists = false
    // A dangling symlink is ENOENT too: refuse it rather than create the file wherever it points.
    let link = false
    try {
      link = fs.lstatSync(joined).isSymbolicLink()
    } catch {
      link = false
    }
    if (link) throw new Error(`${clean} is a link to a missing file`)
    real = path.join(fs.realpathSync(path.dirname(joined)), path.basename(joined))
  }
  if (!inside(realRoot, real) || real === realRoot) throw new Error(`${clean} is outside the project folder`)
  return { rel: clean, real, exists }
}

/** The line ending a file uses: CRLF only when every LF has a CR before it (a mixed file is left as it is). */
function detectEol(text) {
  const lf = (text.match(/\n/g) || []).length
  if (lf === 0) return '\n'
  const crlf = (text.match(/\r\n/g) || []).length
  return crlf === lf ? '\r\n' : '\n'
}

/**
 * The file's bytes as the page gets them: `{ text, bom, eol, encoding }`. The BOM is taken off and
 * CRLF made LF (CodeMirror's own model), and both are put back by encodeText at save, so a Windows
 * file stays CRLF and a BOM stays. The final newline needs nothing: it is part of the text either way.
 * `encoding` is false for bytes that are not valid UTF-8; the text is then the lossy decode, shown
 * read-only (saving it would replace every bad byte with U+FFFD).
 */
function decodeBytes(buf) {
  const bom = buf.length >= 3 && buf.subarray(0, 3).equals(UTF8_BOM)
  const body = bom ? buf.subarray(3) : buf
  let text
  let encoding = true
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    encoding = false
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(body)
  }
  const eol = detectEol(text)
  if (eol === '\r\n') text = text.replace(/\r\n/g, '\n')
  return { text, bom, eol, encoding }
}

/** The page's text as the bytes to write, with the file's line ending and BOM put back. */
function encodeText(text, { eol, bom }) {
  const body = Buffer.from(eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text, 'utf8')
  return bom ? Buffer.concat([UTF8_BOM, body]) : body
}

/**
 * An open descriptor's contents, from offset 0 (pread: the descriptor's own position is never used),
 * read to EOF rather than to the fstat size so a file growing under us is read whole: `{ buf, hash,
 * size }`. The hash covers every byte; `buf` keeps only the first MAX_VIEW_BYTES + 1 (past that the
 * file is never shown, so a 2 GB log costs a hash, not 2 GB of memory).
 */
function readFd(fd) {
  const h = crypto.createHash('sha256')
  const chunks = []
  let kept = 0
  let size = 0
  const buf = Buffer.allocUnsafe(1024 * 1024)
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, size)
    if (n === 0) break
    const part = buf.subarray(0, n)
    h.update(part)
    size += n
    if (kept <= MAX_VIEW_BYTES) {
      const take = Math.min(n, MAX_VIEW_BYTES + 1 - kept)
      chunks.push(Buffer.from(part.subarray(0, take)))
      kept += take
    }
  }
  return { buf: Buffer.concat(chunks, kept), hash: h.digest('hex'), size }
}

/**
 * Opens the file read-only without blocking and checks it is a regular file. A FIFO or a device
 * would block the read (and the whole plugin host), so O_NONBLOCK, then fstat on the descriptor.
 * O_NOFOLLOW: `real` is a realpath, so a symlink there now was put there since we resolved it.
 */
function openRegular(real) {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0))
  const st = fs.fstatSync(fd)
  if (!st.isFile()) {
    fs.closeSync(fd)
    throw new Error('not a regular file')
  }
  return { fd, st }
}

/**
 * What a page needs to show a file's bytes: `{ hash, text?, readOnly, why?, eol, bom, size }`.
 * Read-only (`why`): `binary` (a NUL in the first 8000 bytes: no text), `large` (over 5 MB: shown
 * when up to 16 MB, else no text), `encoding` (not valid UTF-8: the lossy text). A save of a
 * read-only file is refused by the host too, not only greyed out in the page.
 */
function describeBytes({ buf, hash, size }) {
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { hash, readOnly: true, why: 'binary', eol: '\n', bom: false, size }
  if (size > MAX_VIEW_BYTES) return { hash, readOnly: true, why: 'large', eol: '\n', bom: false, size }
  const d = decodeBytes(buf)
  if (!d.encoding) return { hash, text: d.text, readOnly: true, why: 'encoding', eol: d.eol, bom: d.bom, size }
  if (size > MAX_EDIT_BYTES) return { hash, text: d.text, readOnly: true, why: 'large', eol: d.eol, bom: d.bom, size }
  return { hash, text: d.text, readOnly: false, eol: d.eol, bom: d.bom, size }
}

/**
 * Reads a file of the project for a page: describeBytes plus `{ rel, exists: true }`, or
 * `{ rel, exists: false }` for a missing file (the tab says "deleted on disk").
 */
function readFile(root, rel) {
  const r = resolveInProject(root, rel)
  if (!r.exists) return { rel: r.rel, exists: false }
  const { fd } = openRegular(r.real)
  try {
    return { rel: r.rel, exists: true, real: r.real, ...describeBytes(readFd(fd)) }
  } finally {
    fs.closeSync(fd)
  }
}

function tempPathFor(real) {
  return path.join(path.dirname(real), `.${path.basename(real)}.cc-editor-${crypto.randomBytes(6).toString('hex')}.tmp`)
}

/** Writes `bytes` to a new temp file beside `real` (O_EXCL, `mode`) and syncs it; returns its path. */
function writeTemp(real, bytes, mode) {
  const tmp = tempPathFor(real)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
  let ok = false
  try {
    // writeSync may write less than asked (a full disk part way, a signal): loop to the end.
    for (let off = 0; off < bytes.length; ) off += fs.writeSync(fd, bytes, off, bytes.length - off, off)
    // openSync's mode is cut by the umask: set the file's own mode exactly (0755 scripts stay 0755).
    fs.fchmodSync(fd, mode)
    fs.fsyncSync(fd)
    ok = true
  } finally {
    fs.closeSync(fd)
    if (!ok) rmQuiet(tmp)
  }
  return tmp
}

function rmQuiet(p) {
  try {
    fs.unlinkSync(p)
  } catch {
    // already gone
  }
}

/**
 * What a save answers when the file is not the page's base: the file as it is now (describeBytes of
 * the current bytes, or `{ deleted: true }`), with `hash` the base for the page's next save.
 */
function changedAnswer(root, rel) {
  const now = readFile(root, rel)
  if (!now.exists) return { result: 'changed', deleted: true, hash: null }
  return { result: 'changed', ...describeNoReal(now) }
}

function describeNoReal(r) {
  const out = { ...r }
  delete out.real
  delete out.rel
  delete out.exists
  return out
}

/**
 * Saves `text` over the file a page loaded as `baseHash`, by compare-and-swap on the inode
 * (design-editor.md §2 "Saving"). Answers one of:
 * - `{ result: 'saved', hash }`: written; `hash` is the page's new base.
 * - `{ result: 'changed', hash, text?, readOnly, why?, ... }` or `{ result: 'changed', deleted: true }`:
 *   the file is not the page's base (Claude wrote it), nothing was written; the page merges `text`
 *   (theirs) and saves again with `hash`.
 * - `{ result: 'changed', written: true, hash, text, ... }`: written, but a write into the OLD file
 *   landed between our check and the rename (it is lost from disk); `text` is that write, so the page
 *   merges it into what it just wrote and saves again with `hash` (what is on disk now: its own text).
 * `baseHash: null` saves a file the page knows as deleted: it is created only when it is still
 * absent (a hard link of the temp file, which fails when the name exists), else `changed`.
 *
 * Steps for an existing file: open and hold a descriptor on the current inode, hash it against
 * `baseHash`, write a temp file in the same folder (same filesystem, so the rename is atomic) with
 * the file's mode, re-check just before the rename that the name still points at the held inode and
 * its bytes still hash to `baseHash`, rename, then re-hash the held descriptor: the old inode, which
 * only a writer that opened it before the rename can still change.
 */
function saveFile(root, rel, text, baseHash) {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (text.length > MAX_SAVE_CHARS) throw new Error('the text is too large to save')
  const r = resolveInProject(root, rel)

  if (baseHash === null) {
    if (r.exists) return changedAnswer(root, r.rel)
    const bytes = encodeText(text, { eol: '\n', bom: false })
    // 0666 minus the umask, as any editor creating a file: the mode of the deleted file is gone with it.
    const umask = process.umask()
    const tmp = writeTemp(r.real, bytes, 0o666 & ~umask)
    try {
      fs.linkSync(tmp, r.real)
    } catch (e) {
      if (e.code === 'EEXIST') return changedAnswer(root, r.rel)
      throw e
    } finally {
      rmQuiet(tmp)
    }
    return { result: 'saved', hash: hashBytes(bytes) }
  }

  if (typeof baseHash !== 'string') throw new Error('baseHash must be a string or null')
  if (!r.exists) return { result: 'changed', deleted: true, hash: null }

  const { fd, st } = openRegular(r.real)
  try {
    const current = readFd(fd)
    if (current.hash !== baseHash) return { result: 'changed', ...describeBytes(current) }
    const shape = describeBytes(current)
    if (shape.readOnly) throw new Error(`the file is read-only here (${shape.why})`)

    const bytes = encodeText(text, shape)
    const newHash = hashBytes(bytes)
    if (newHash === baseHash) return { result: 'saved', hash: newHash } // nothing to write
    const tmp = writeTemp(r.real, bytes, st.mode & 0o7777)
    let renamed = false
    try {
      // The last check before the swap: the name still points at the inode we hold (no
      // rename-replace since the open) and that inode still holds the base (no write into it).
      let now
      try {
        now = fs.statSync(r.real)
      } catch {
        now = null
      }
      if (!now || now.ino !== st.ino || now.dev !== st.dev) return changedAnswer(root, r.rel)
      const again = readFd(fd)
      if (again.hash !== baseHash) return { result: 'changed', ...describeBytes(again) }
      fs.renameSync(tmp, r.real)
      renamed = true
    } finally {
      if (!renamed) rmQuiet(tmp)
    }
    // A writer that opened the old file before the rename and wrote after our check wrote into the
    // inode the name no longer points at: its write is not on disk. Hand it to the page to merge.
    const old = readFd(fd)
    if (old.hash !== baseHash) {
      const theirs = describeBytes(old)
      return { result: 'changed', written: true, ...theirs, theirsHash: theirs.hash, hash: newHash }
    }
    return { result: 'saved', hash: newHash }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Splits `text` into parts of at most CHUNK_CHARS UTF-16 units, never between the two halves of a
 * surrogate pair (each part is valid on its own, so JSON keeps it as it is). '' is one empty part.
 */
function chunkText(text, size = CHUNK_CHARS) {
  if (!text) return ['']
  const parts = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + size)
    if (end < text.length) {
      const c = text.charCodeAt(end - 1)
      if (c >= 0xd800 && c <= 0xdbff) end -= 1
    }
    parts.push(text.slice(i, end))
    i = end
  }
  return parts
}

/**
 * Watches the FOLDERS of open files (a watch on the file itself ends when Claude's tools or git
 * rename a new file over it, the usual way to write one) and calls `onChange(real, { change, hash })`
 * for each watched file whose bytes changed (`change: 'changed'`) or that went (`'deleted'`).
 * Each file is refcounted (two tabs or two views of one file share a watch), and so is each folder.
 * The last hash seen is kept per file only to tell a real change from an event that changed nothing
 * (an atime, our own save, a chmod); `seen(real, hash)` records a hash the host itself read or wrote.
 * `watchImpl` is fs.watch, replaceable in tests.
 */
class FolderWatcher {
  constructor(onChange, { watchImpl = fs.watch, debounceMs = WATCH_DEBOUNCE_MS, log } = {}) {
    this.onChange = onChange
    this.watchImpl = watchImpl
    this.debounceMs = debounceMs
    this.log = log
    /** real path -> { count, hash, timer } */
    this.files = new Map()
    /** folder -> { count, watcher } */
    this.folders = new Map()
  }

  /** Watches `real`; returns the function that stops this one watch. */
  add(real, hash) {
    let f = this.files.get(real)
    if (f) {
      f.count++
      if (hash !== undefined) f.hash = hash
    } else {
      f = { count: 1, hash: hash === undefined ? null : hash, timer: null }
      this.files.set(real, f)
      this.addFolder(path.dirname(real))
    }
    let done = false
    return () => {
      if (done) return
      done = true
      this.remove(real)
    }
  }

  /** The host read or wrote `real` as `hash` (null: absent): no event for it. */
  seen(real, hash) {
    const f = this.files.get(real)
    if (f) f.hash = hash
  }

  remove(real) {
    const f = this.files.get(real)
    if (!f) return
    if (--f.count > 0) return
    if (f.timer) clearTimeout(f.timer)
    this.files.delete(real)
    this.removeFolder(path.dirname(real))
  }

  addFolder(dir) {
    const d = this.folders.get(dir)
    if (d) {
      d.count++
      return
    }
    const entry = { count: 1, watcher: null }
    this.folders.set(dir, entry)
    try {
      entry.watcher = this.watchImpl(dir, { persistent: false }, (_event, name) => this.event(dir, name))
      if (entry.watcher && typeof entry.watcher.on === 'function') {
        // A folder that goes (or a watch the OS drops) ends quietly: the page re-checks on focus and before each save.
        entry.watcher.on('error', (e) => this.log && this.log.warn(`watch ${dir}: ${e.message}`))
      }
    } catch (e) {
      if (this.log) this.log.warn(`watch ${dir}: ${e.message}`)
    }
  }

  removeFolder(dir) {
    const d = this.folders.get(dir)
    if (!d) return
    if (--d.count > 0) return
    this.folders.delete(dir)
    if (d.watcher) d.watcher.close()
  }

  event(dir, name) {
    // `name` can be missing (some platforms, an overflow): check every watched file of the folder.
    for (const [real, f] of this.files) {
      if (path.dirname(real) !== dir) continue
      if (name && String(name) !== path.basename(real)) continue
      if (f.timer) clearTimeout(f.timer)
      f.timer = setTimeout(() => {
        f.timer = null
        this.check(real)
      }, this.debounceMs)
    }
  }

  check(real) {
    const f = this.files.get(real)
    if (!f) return
    let hash = null
    try {
      const { fd } = openRegular(real)
      try {
        hash = readFd(fd).hash
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      hash = null
    }
    if (hash === f.hash) return
    f.hash = hash
    this.onChange(real, hash === null ? { change: 'deleted', hash: null } : { change: 'changed', hash })
  }

  /** Stops every watch (the plugin stops). */
  close() {
    for (const f of this.files.values()) if (f.timer) clearTimeout(f.timer)
    for (const d of this.folders.values()) if (d.watcher) d.watcher.close()
    this.files.clear()
    this.folders.clear()
  }
}

/**
 * Serves one page-tab line (a PageTabInstance: the tab's page in one view) for `type: 'file'`.
 * The page speaks this, every message a JSON object with `t` and a `req` it chose (echoed back):
 *
 *   page -> host
 *   { t: 'open', req, path? }          read the file (default: the tab's params.path) and watch it
 *   { t: 'read', req, path }           read it again (the page re-checks on focus and before a save)
 *   { t: 'save', req, path, baseHash, part, parts, text }
 *                                      a save in `parts` messages (text split by the page, each part
 *                                      under the 1 MiB message cap); `baseHash` null recreates a deleted file
 *   { t: 'unwatch', path }             the page closed this file
 *
 *   host -> page
 *   { t: 'file', req, path, exists, hash, readOnly, why?, eol, bom, size, part, parts, text }
 *                                      the answer to open/read, in `parts` messages (`text` the part)
 *   { t: 'saved', req, path, hash }
 *   { t: 'changed', req, path, hash, deleted?, written?, theirsHash?, readOnly, why?, part, parts, text }
 *                                      the save was not done (or, `written`, done with a write lost
 *                                      in between): `text` (in parts) is theirs, `hash` the next base
 *   { t: 'disk', path, change: 'changed'|'deleted', hash }
 *                                      a watched file changed on disk
 *   { t: 'error', req, path?, message }
 *
 * `files` is the shared { root, watcher, lines } of the plugin (makeFiles).
 */
function serveFileTab(files, tab, log) {
  const watches = new Map() // rel -> { real, stop }
  const saves = new Map() // req -> { path, baseHash, parts, got: [] }
  let closed = false

  const post = (m) => {
    if (!closed) tab.post(m)
  }
  const fail = (req, p, e) => post({ t: 'error', req, path: p, message: e && e.message ? e.message : String(e) })

  function postParts(head, text) {
    const parts = text === undefined ? [undefined] : chunkText(text)
    parts.forEach((part, i) => {
      const m = { ...head, part: i, parts: parts.length }
      if (part !== undefined) m.text = part
      post(m)
    })
  }

  function watch(rel, real, hash) {
    const w = watches.get(rel)
    if (w && w.real === real) {
      files.watcher.seen(real, hash)
      return
    }
    if (w) w.stop()
    watches.set(rel, { real, stop: files.watcher.add(real, hash) })
    files.lines.add(lineEntry)
  }

  const lineEntry = {
    disk(real, ev) {
      for (const [rel, w] of watches) if (w.real === real) post({ t: 'disk', path: rel, change: ev.change, hash: ev.hash })
    },
  }

  function read(req, p, isOpen) {
    let r
    try {
      r = readFile(files.root, p)
    } catch (e) {
      return fail(req, typeof p === 'string' ? p : undefined, e)
    }
    if (isOpen || watches.has(r.rel)) {
      // A missing file is watched at the name it would have: a recreate shows as `changed`.
      const real = r.exists ? r.real : resolveInProject(files.root, r.rel).real
      watch(r.rel, real, r.exists ? r.hash : null)
    }
    if (!r.exists) return post({ t: 'file', req, path: r.rel, exists: false, part: 0, parts: 1 })
    const head = describeNoReal(r)
    delete head.text
    postParts({ t: 'file', req, path: r.rel, exists: true, ...head }, r.text)
  }

  function save(m) {
    const req = m.req
    let s = saves.get(req)
    if (!s) {
      if (m.part !== 0) return fail(req, m.path, new Error('save parts out of order'))
      if (saves.size >= MAX_PENDING_SAVES) return fail(req, m.path, new Error('too many saves at once'))
      const parts = Number.isInteger(m.parts) && m.parts >= 1 ? m.parts : 1
      // At most this many parts: a page that announces a million parts cannot hold memory forever.
      if (parts > Math.ceil(MAX_SAVE_CHARS / 1024) + 1) return fail(req, m.path, new Error('too many save parts'))
      s = { path: m.path, baseHash: m.baseHash, parts, got: [], length: 0 }
      saves.set(req, s)
    } else if (m.part !== s.got.length || m.path !== s.path) {
      saves.delete(req)
      return fail(req, m.path, new Error('save parts out of order'))
    }
    if (typeof m.text !== 'string') {
      saves.delete(req)
      return fail(req, m.path, new Error('text must be a string'))
    }
    s.got.push(m.text)
    s.length += m.text.length
    if (s.length > MAX_SAVE_CHARS) {
      saves.delete(req)
      return fail(req, m.path, new Error('the text is too large to save'))
    }
    if (s.got.length < s.parts) return
    saves.delete(req)
    let answer
    let rel
    try {
      const r = resolveInProject(files.root, s.path)
      rel = r.rel
      answer = saveFile(files.root, rel, s.got.join(''), s.baseHash === null ? null : s.baseHash)
    } catch (e) {
      return fail(req, s.path, e)
    }
    if (answer.result === 'saved') {
      // Our own write is not news for this line, nor for the other lines watching the file: they
      // hear about it from the watcher only if the bytes differ from what we wrote.
      const real = resolveInProject(files.root, rel).real
      files.watcher.seen(real, answer.hash)
      if (!watches.has(rel)) watch(rel, real, answer.hash)
      return post({ t: 'saved', req, path: rel, hash: answer.hash })
    }
    if (answer.written) {
      const real = resolveInProject(files.root, rel).real
      files.watcher.seen(real, answer.hash)
    }
    const head = { ...answer }
    delete head.result
    delete head.text
    postParts({ t: 'changed', req, path: rel, ...head }, answer.text)
  }

  tab.onMessage((m) => {
    if (closed || !m || typeof m !== 'object' || Array.isArray(m)) return
    const req = typeof m.req === 'string' || typeof m.req === 'number' ? m.req : undefined
    try {
      switch (m.t) {
        case 'open': {
          const params = tab.params && typeof tab.params === 'object' ? tab.params : {}
          return read(req, m.path === undefined ? params.path : m.path, true)
        }
        case 'read':
          return read(req, m.path, false)
        case 'save':
          if (req === undefined) return fail(req, m.path, new Error('a save needs a req'))
          return save({ ...m, req })
        case 'unwatch': {
          let rel
          try {
            rel = relativePath(m.path)
          } catch {
            return
          }
          const w = watches.get(rel)
          if (w) {
            w.stop()
            watches.delete(rel)
          }
          return
        }
        default:
          return // an unknown message is a newer page's: ignored, never an error
      }
    } catch (e) {
      if (log) log.warn(`file tab ${tab.id}: ${e.message}`)
      fail(req, typeof m.path === 'string' ? m.path : undefined, e)
    }
  })

  tab.onClose(() => {
    closed = true
    for (const w of watches.values()) w.stop()
    watches.clear()
    saves.clear()
    files.lines.delete(lineEntry)
  })
}

/** The plugin's shared file state: the project root, one watcher, the page lines it reports to. */
function makeFiles(root, opts = {}) {
  const lines = new Set()
  const watcher = new FolderWatcher((real, ev) => {
    for (const line of lines) line.disk(real, ev)
  }, opts)
  return { root, watcher, lines }
}

module.exports = {
  MAX_EDIT_BYTES,
  MAX_VIEW_BYTES,
  CHUNK_CHARS,
  hashBytes,
  relativePath,
  resolveInProject,
  decodeBytes,
  encodeText,
  describeBytes,
  readFile,
  saveFile,
  chunkText,
  FolderWatcher,
  serveFileTab,
  makeFiles,
}
