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
const os = require('node:os')

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
/** A save that stops sending parts is dropped after this long. */
const SAVE_PART_TIMEOUT_MS = 10 * 1000
/** Files one page line may watch, and folders the whole plugin may hold an inotify watch on (fs.inotify.max_user_watches is the user's, shared with their IDE). */
const MAX_LINE_WATCHES = 32
const MAX_WATCHED_FOLDERS = 128
/** A watch that died (its folder was deleted and recreated, renamed) is re-armed this often, this many times. */
const REARM_MS = 1000
const REARM_TRIES = 30
/** A temp file of an interrupted save older than this is swept when its file is opened. */
const STALE_TEMP_MS = 60 * 1000
/** Watch events within this window are one check: an editor's save is often a truncate, writes and a chmod. */
const WATCH_DEBOUNCE_MS = 80

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/** The hash a page keeps as its base and sends back with a save: sha256 of the file's bytes on disk, hex. */
function hashBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * A project-relative path, or a thrown Error: no absolute path, no `..`, no NUL. A backslash is a
 * separator only where the OS says so (Windows): on macOS and Linux `a\b.js` is one valid file name,
 * and turning it into `a/b.js` opened a different file. The host's `editor.open`, `ccc edit` and the
 * page's picks all go through this one.
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

/**
 * Whether the file at `real` (a realpath resolveInProject checked) is binary: a NUL in its first
 * BINARY_SNIFF_BYTES. Only a regular file is read (a FIFO or a device would block the read, and with
 * it the whole plugin host): anything else throws.
 */
function sniffBinary(real) {
  let fd
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) throw new Error('not a regular file')
    fd = fs.openSync(real, 'r')
    const buf = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, st.size))
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
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
 * An open descriptor's contents, from offset 0 (pread: the descriptor's own position is never used):
 * `{ buf, hash, size }`. It runs in the project's one plugin host, so it is bounded: at most
 * MAX_VIEW_BYTES + 1 bytes are read, hashed and kept. A file past that is never shown or saved, so
 * its `hash` is not a content hash but `big:<size>:<mtime>` (cheap to compare: a 100 GB sparse file
 * or a log growing under us costs one capped read, never a hash to EOF), and `size` is fstat's.
 */
function readFd(fd) {
  const h = crypto.createHash('sha256')
  const chunks = []
  let size = 0
  const buf = Buffer.allocUnsafe(1024 * 1024)
  while (size <= MAX_VIEW_BYTES) {
    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, MAX_VIEW_BYTES + 1 - size), size)
    if (n === 0) break
    const part = buf.subarray(0, n)
    h.update(part)
    chunks.push(Buffer.from(part))
    size += n
  }
  if (size > MAX_VIEW_BYTES) {
    const st = fs.fstatSync(fd)
    return { buf: Buffer.concat(chunks, size), hash: `big:${st.size}:${Math.floor(st.mtimeMs)}`, size: Math.max(st.size, size) }
  }
  return { buf: Buffer.concat(chunks, size), hash: h.digest('hex'), size }
}

/**
 * Opens the file read-only without blocking and checks it is a regular file. A FIFO or a device
 * would block the read (and the whole plugin host), so O_NONBLOCK, then fstat on the descriptor.
 * O_NOFOLLOW covers only the LAST component: a symlink put on `real` since we resolved it. A parent
 * folder swapped for a link in that window is caught by resolving `real` again after the open (it
 * must still be its own realpath); what is left is the gap between that realpath and the open's
 * own walk, a race only a local process could win, which the saves' inode and hash checks keep from
 * becoming a write outside the project.
 */
function openRegular(real) {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0))
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile()) throw new Error('not a regular file')
    let again = null
    try {
      again = fs.realpathSync(real)
    } catch {
      again = null
    }
    if (again !== real) throw new Error('the path changed while it was opened')
    return { fd, st }
  } catch (e) {
    fs.closeSync(fd)
    throw e
  }
}

/**
 * Why a file may not be saved by us though its text is fine: `linked` (more than one hard link: a
 * rename-replace would cut this name off from the other, and a link to a file outside the project
 * looks like a project file to realpath), `permission` (the file or its folder is not writable by us:
 * a 0444 file would otherwise be replaced by rename and keep its mode, silently bypassing it).
 * A rename-replace also drops owner, group, xattrs and ACLs: only the mode is kept.
 */
function lockOf(real, st) {
  if (st.nlink > 1) return 'linked'
  try {
    fs.accessSync(real, fs.constants.W_OK)
    fs.accessSync(path.dirname(real), fs.constants.W_OK)
  } catch {
    return 'permission'
  }
  return undefined
}

/**
 * What a page needs to show a file's bytes: `{ hash, text?, readOnly, why?, eol, bom, size }`.
 * Read-only (`why`): `binary` (a NUL in the first 8000 bytes: no text), `large` (over 5 MB: shown
 * when up to 16 MB, else no text), `encoding` (not valid UTF-8: the lossy text), or `lock` (lockOf:
 * `linked` or `permission`, the text shown). A save of a
 * read-only file is refused by the host too, not only greyed out in the page.
 */
function describeBytes({ buf, hash, size }, lock) {
  if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { hash, readOnly: true, why: 'binary', eol: '\n', bom: false, size }
  if (size > MAX_VIEW_BYTES) return { hash, readOnly: true, why: 'large', eol: '\n', bom: false, size }
  const d = decodeBytes(buf)
  if (!d.encoding) return { hash, text: d.text, readOnly: true, why: 'encoding', eol: d.eol, bom: d.bom, size }
  if (size > MAX_EDIT_BYTES) return { hash, text: d.text, readOnly: true, why: 'large', eol: d.eol, bom: d.bom, size }
  if (lock) return { hash, text: d.text, readOnly: true, why: lock, eol: d.eol, bom: d.bom, size }
  return { hash, text: d.text, readOnly: false, eol: d.eol, bom: d.bom, size }
}

/**
 * Reads a file of the project for a page: describeBytes plus `{ rel, exists: true }`, or
 * `{ rel, exists: false }` for a missing file (the tab says "deleted on disk").
 */
function readFile(root, rel) {
  const r = resolveInProject(root, rel)
  if (!r.exists) return { rel: r.rel, exists: false }
  const { fd, st } = openRegular(r.real)
  try {
    return { rel: r.rel, exists: true, real: r.real, ...describeBytes(readFd(fd), lockOf(r.real, st)) }
  } finally {
    fs.closeSync(fd)
  }
}

/** System trees no definition lives in (process memory and environment, devices, sockets). */
const REFUSED_OUTSIDE_ROOTS = ['/proc', '/sys', '/dev', '/run']
/**
 * Folders and files of the home holding credentials, shell history or app data (this app's own data
 * dir among them): package registry tokens, git's stored credentials, database passwords, histories
 * with secrets typed on a command line.
 */
const REFUSED_OUTSIDE_HOME = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.config', '.netrc', '.password-store', '.local/share/keyrings',
  'Library/Keychains', 'Library/Application Support',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.git-credentials', '.pypirc', '.cargo/credentials', '.cargo/credentials.toml',
  '.gem/credentials', '.pgpass', '.my.cnf', '.vault-token', '.terraform.d', '.local/share/fish',
  '.bash_history', '.zsh_history', '.history', '.sh_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', '.lesshst',
]

/**
 * Whether an outside path is one a read-only tab never shows, whoever named it. Defense in depth
 * for the outside allow-list (lib/lsp/manager.js allowsOutside): a server returns what the document
 * text it was told leads to, and a page decides that text, so a page could make a server "return"
 * any path (tsserver's `/// <reference path>`); these never open.
 */
function outsideRefused(abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs)) return true
  const p = path.resolve(abs)
  const under = (dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
  if (REFUSED_OUTSIDE_ROOTS.some(under)) return true
  const home = os.homedir()
  return !!home && REFUSED_OUTSIDE_HOME.some((d) => under(path.join(home, d)))
}

/**
 * A file OUTSIDE the project for a read-only tab (design-editor.md §3: a definition in
 * `node_modules`, the module cache or vendor "opens read-only, and only for a location the server
 * returned"). The caller decides that it may be shown: the host opens such a tab only for a path a
 * language server returned (lib/lsp/manager.js allowsOutside) and keeps it in the tab's params,
 * which main holds and no page can set. Read like a project file (a regular file, bounded, binary
 * and encoding checked), always read-only (`why: 'outside'` unless a stronger reason applies), never
 * saved and not watched. `rel` is the absolute path.
 */
function readOutside(abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs) || abs.includes('\0')) throw new Error('not an absolute path')
  if (outsideRefused(abs)) throw new Error('this file is not shown outside the project')
  let real
  try {
    real = fs.realpathSync(abs)
  } catch (e) {
    if (e.code === 'ENOENT') return { rel: abs, exists: false }
    throw e
  }
  // A link in node_modules pointing at one of them is refused too.
  if (outsideRefused(real)) throw new Error('this file is not shown outside the project')
  const { fd } = openRegular(real)
  try {
    const d = describeBytes(readFd(fd), undefined)
    return { rel: abs, exists: true, real, ...d, readOnly: true, why: d.readOnly ? d.why : 'outside' }
  } finally {
    fs.closeSync(fd)
  }
}

function tempPathFor(real) {
  return path.join(path.dirname(real), `.${path.basename(real)}.cc-editor-${crypto.randomBytes(6).toString('hex')}.tmp`)
}

/** writeSync may write less than asked (a full disk part way, a signal): loop to the end. */
function writeAll(fd, bytes) {
  for (let off = 0; off < bytes.length; ) off += fs.writeSync(fd, bytes, off, bytes.length - off, off)
}

/** Writes `bytes` to a new temp file beside `real` (O_EXCL, `mode`) and syncs it; returns its path. */
function writeTemp(real, bytes, mode) {
  const tmp = tempPathFor(real)
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
  let ok = false
  try {
    writeAll(fd, bytes)
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

/**
 * Removes the temp files an interrupted save (host killed between writeTemp and the rename) left
 * beside `real`. Only ones older than STALE_TEMP_MS: a save in progress in another window is not touched.
 */
function sweepTemps(real) {
  const dir = path.dirname(real)
  const prefix = `.${path.basename(real)}.cc-editor-`
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue
      const p = path.join(dir, name)
      try {
        const st = fs.lstatSync(p)
        if (st.isFile() && Date.now() - st.mtimeMs > STALE_TEMP_MS) rmQuiet(p)
      } catch {
        // gone already
      }
    }
  } catch {
    // an unreadable folder: nothing to sweep
  }
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
 * absent (a hard link of the temp file, which fails when the name exists; an exclusive create where
 * the filesystem has no hard links), else `changed`. `opts` `{ eol, bom }` is the page's last line
 * ending and BOM of that file, which the deleted file can no longer tell.
 *
 * Steps for an existing file: open and hold a descriptor on the current inode, hash it against
 * `baseHash`, write a temp file in the same folder (same filesystem, so the rename is atomic) with
 * the file's mode, re-check just before the rename that the held inode still hashes to `baseHash`
 * and then that the name still points at it (stat last: the window to the rename is two syscalls),
 * rename, then re-hash the held descriptor: the old inode, which only a writer that opened it before
 * the rename can still change. Two windows remain and cannot be closed without a lock: a
 * rename-replace by another writer between that stat and our rename is overwritten, and a write
 * into the old inode after the final re-hash is lost, both unnoticed.
 */
function saveFile(root, rel, text, baseHash, opts = {}) {
  if (typeof text !== 'string') throw new Error('text must be a string')
  if (text.length > MAX_SAVE_CHARS) throw new Error('the text is too large to save')
  const r = resolveInProject(root, rel)

  if (baseHash === null) {
    if (r.exists) return changedAnswer(root, r.rel)
    const bytes = encodeText(text, { eol: opts.eol === '\r\n' ? '\r\n' : '\n', bom: opts.bom === true })
    if (bytes.length > MAX_EDIT_BYTES) throw new Error('the text is too large to save')
    // 0666 minus the umask, as any editor creating a file: the mode of the deleted file is gone with it.
    const mode = 0o666 & ~process.umask()
    const tmp = writeTemp(r.real, bytes, mode)
    let linked = false
    try {
      fs.linkSync(tmp, r.real)
      linked = true
    } catch (e) {
      if (e.code === 'EEXIST') return changedAnswer(root, r.rel)
      // No hard links here (FAT/exFAT, some network mounts): create it exclusively and write in place.
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'].includes(e.code)) throw e
    } finally {
      rmQuiet(tmp)
    }
    if (!linked) {
      let fd
      try {
        fd = fs.openSync(r.real, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
      } catch (e) {
        if (e.code === 'EEXIST') return changedAnswer(root, r.rel)
        throw e
      }
      let ok = false
      try {
        writeAll(fd, bytes)
        fs.fsyncSync(fd)
        ok = true
      } finally {
        fs.closeSync(fd)
        if (!ok) rmQuiet(r.real)
      }
    }
    return { result: 'saved', hash: hashBytes(bytes) }
  }

  if (typeof baseHash !== 'string') throw new Error('baseHash must be a string or null')
  if (!r.exists) return { result: 'changed', deleted: true, hash: null }

  const { fd, st } = openRegular(r.real)
  try {
    const lock = lockOf(r.real, st)
    const current = readFd(fd)
    if (current.hash !== baseHash) return { result: 'changed', ...describeBytes(current, lock) }
    const shape = describeBytes(current, lock)
    if (shape.readOnly) throw new Error(`the file is read-only here (${shape.why})`)

    const bytes = encodeText(text, shape)
    // MAX_SAVE_CHARS counts UTF-16 units, up to 3 bytes each: the file written must still reopen editable.
    if (bytes.length > MAX_EDIT_BYTES) throw new Error('the text is too large to save')
    const newHash = hashBytes(bytes)
    if (newHash === baseHash) return { result: 'saved', hash: newHash } // nothing to write
    const tmp = writeTemp(r.real, bytes, st.mode & 0o7777)
    let renamed = false
    try {
      // The last check before the swap: the name still points at the inode we hold (no
      // rename-replace since the open) and that inode still holds the base (no write into it).
      // The (slow) re-hash goes first and the stat last, so the window for a rename-replace is short.
      const again = readFd(fd)
      if (again.hash !== baseHash) return { result: 'changed', ...describeBytes(again, lock) }
      let now
      try {
        now = fs.statSync(r.real)
      } catch {
        now = null
      }
      if (!now || now.ino !== st.ino || now.dev !== st.dev) return changedAnswer(root, r.rel)
      fs.renameSync(tmp, r.real)
      renamed = true
    } finally {
      if (!renamed) rmQuiet(tmp)
    }
    // A writer that opened the old file before the rename and wrote after our check wrote into the
    // inode the name no longer points at: its write is not on disk. Hand it to the page to merge.
    const old = readFd(fd)
    if (old.hash !== baseHash) {
      const theirs = describeBytes(old, lock)
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
      // Step back before the pair, or (size 1: stepping back would leave an empty part and loop
      // forever) take the whole pair, one unit over the size.
      if (c >= 0xd800 && c <= 0xdbff) end = end - 1 > i ? end - 1 : end + 1
    }
    parts.push(text.slice(i, end))
    i = end
  }
  return parts
}

/**
 * Watches the FOLDERS of open files (a watch on the file itself ends when Claude's tools or git
 * rename a new file over it, the usual way to write one) and tells each subscriber of a file whose
 * bytes changed (`change: 'changed'`) or that went (`'deleted'`): `notify(real, { change, hash })`.
 * Each file is refcounted (two tabs or two views of one file share a watch), and so is each folder.
 * The last hash seen is kept PER SUBSCRIBER (a page line), only to tell a real change from an event
 * that changed nothing (an atime, its own save, a chmod): `add` returns a stop function whose
 * `seen(hash)` records a hash that subscriber itself read or wrote. A line's save is news to every
 * other line watching the file, so one line's read or save never mutes another.
 * `add(real, hash, notify)` falls back to `onChange` when it has no `notify`. `watchImpl` is fs.watch,
 * replaceable in tests.
 *
 * A watch that dies (the folder deleted and recreated by git checkout, renamed, an OS error) is
 * re-armed after `rearmMs`, up to REARM_TRIES times, and the folder's files are checked once it is.
 * At most `maxFolders` folders hold an OS watch (the user's inotify budget is shared with their IDE).
 */
class FolderWatcher {
  constructor(onChange, { watchImpl = fs.watch, debounceMs = WATCH_DEBOUNCE_MS, rearmMs = REARM_MS, maxFolders = MAX_WATCHED_FOLDERS, log } = {}) {
    this.onChange = onChange || (() => {})
    this.watchImpl = watchImpl
    this.debounceMs = debounceMs
    this.rearmMs = rearmMs
    this.maxFolders = maxFolders
    this.log = log
    /** real path -> { subs: Set<{ hash, notify }>, timer } */
    this.files = new Map()
    /** folder -> { count, watcher, retry, tries } */
    this.folders = new Map()
    /** Who hears every named event of a watched folder (the language servers' didChangeWatchedFiles). */
    this.folderListeners = new Set()
  }

  /**
   * `listener(real)` for every entry of a watched folder an OS event names, open in a tab or not
   * (a sibling file Claude wrote, a new file): the language servers hear about project changes
   * from the same watches (design-editor.md §3 "Lifecycle"). Undebounced; returns the stop function.
   */
  onFolderEvent(listener) {
    this.folderListeners.add(listener)
    return () => this.folderListeners.delete(listener)
  }

  /** Watches `real`; returns the function that stops this one watch (its `seen(hash)` records what it read or wrote). */
  add(real, hash, notify) {
    let f = this.files.get(real)
    if (!f) {
      f = { subs: new Set(), timer: null }
      this.files.set(real, f)
      this.addFolder(path.dirname(real))
    }
    const sub = { hash: hash === undefined ? null : hash, notify: notify || this.onChange }
    f.subs.add(sub)
    let done = false
    const stop = () => {
      if (done) return
      done = true
      this.remove(real, sub)
    }
    stop.seen = (h) => {
      sub.hash = h
    }
    return stop
  }

  remove(real, sub) {
    const f = this.files.get(real)
    if (!f) return
    f.subs.delete(sub)
    if (f.subs.size > 0) return
    if (f.timer) clearTimeout(f.timer)
    this.files.delete(real)
    this.removeFolder(path.dirname(real))
  }

  armedCount() {
    let n = 0
    for (const d of this.folders.values()) if (d.watcher) n++
    return n
  }

  addFolder(dir) {
    const d = this.folders.get(dir)
    if (d) {
      d.count++
      return
    }
    const entry = { count: 1, watcher: null, retry: null, tries: 0, overCap: false }
    this.folders.set(dir, entry)
    this.arm(dir, entry)
  }

  /**
   * Starts the OS watch of `dir` (again); false when it could not (the folder is gone: retried; over
   * the cap: `overCap`, armed when another folder's watch is released, removeFolder).
   */
  arm(dir, entry) {
    if (entry.watcher) {
      try {
        entry.watcher.close()
      } catch {
        // already closed
      }
      entry.watcher = null
    }
    if (this.armedCount() >= this.maxFolders) {
      if (!entry.overCap && this.log) this.log.warn(`watch ${dir}: too many watched folders, not watching it until another one is closed`)
      entry.overCap = true
      return false
    }
    entry.overCap = false
    try {
      const w = this.watchImpl(dir, { persistent: false }, (event, name) => {
        this.event(dir, name)
        // inotify reports the watched folder's own deletion or rename as `rename` with its own name.
        if (event === 'rename' && name && String(name) === path.basename(dir) && entry.watcher === w) this.dropped(dir, entry, w)
      })
      if (w && typeof w.on === 'function') w.on('error', (e) => {
        if (this.log) this.log.warn(`watch ${dir}: ${e.message}`)
        this.dropped(dir, entry, w)
      })
      entry.watcher = w
      return true
    } catch (e) {
      if (this.log) this.log.warn(`watch ${dir}: ${e.message}`)
      this.scheduleRearm(dir, entry)
      return false
    }
  }

  /** The OS watch `w` of `dir` is no longer to be trusted: close it and arm a new one soon. */
  dropped(dir, entry, w) {
    if (entry.watcher !== w) return
    try {
      w.close()
    } catch {
      // already closed
    }
    entry.watcher = null
    this.scheduleRearm(dir, entry)
  }

  scheduleRearm(dir, entry) {
    if (entry.retry || entry.tries >= REARM_TRIES) return
    entry.tries++
    entry.retry = setTimeout(() => {
      entry.retry = null
      if (this.folders.get(dir) !== entry) return
      if (this.arm(dir, entry)) {
        entry.tries = 0
        // Whatever happened while it was blind: look at every file of the folder once.
        this.event(dir, undefined)
      }
    }, this.rearmMs)
    if (entry.retry.unref) entry.retry.unref()
  }

  removeFolder(dir) {
    const d = this.folders.get(dir)
    if (!d) return
    if (--d.count > 0) return
    this.folders.delete(dir)
    if (d.retry) clearTimeout(d.retry)
    if (!d.watcher) return
    d.watcher.close()
    d.watcher = null
    // A slot is free: the first folder left out over the cap gets it, and its files are checked once
    // (whatever changed while it was blind). Otherwise they would get no `disk` event for the rest of
    // the session, only the page's focus re-check.
    for (const [waiting, e] of this.folders) {
      if (!e.overCap || e.watcher || e.retry) continue
      if (this.arm(waiting, e)) this.event(waiting, undefined)
      break
    }
  }

  event(dir, name) {
    if (name && this.folderListeners.size) {
      const real = path.join(dir, String(name))
      for (const l of [...this.folderListeners]) {
        try {
          l(real)
        } catch (e) {
          if (this.log) this.log.warn(`watch ${dir}: ${e.message}`)
        }
      }
    }
    // `name` can be missing (some platforms, an overflow): check every watched file of the folder.
    for (const [real, f] of this.files) {
      if (path.dirname(real) !== dir) continue
      if (name && String(name) !== path.basename(real)) continue
      // The first event of a burst starts the timer and later ones ride on it: a file written more
      // often than the debounce (a log) is still checked, not starved until it goes quiet.
      if (f.timer) continue
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
    const ev = hash === null ? { change: 'deleted', hash: null } : { change: 'changed', hash }
    for (const sub of [...f.subs]) {
      if (sub.hash === hash) continue
      sub.hash = hash
      sub.notify(real, ev)
    }
  }

  /** Stops every watch (the plugin stops). */
  close() {
    for (const f of this.files.values()) if (f.timer) clearTimeout(f.timer)
    for (const d of this.folders.values()) {
      if (d.retry) clearTimeout(d.retry)
      if (d.watcher) d.watcher.close()
    }
    this.files.clear()
    this.folders.clear()
    this.folderListeners.clear()
  }
}

const FS_ERROR_TEXT = {
  ENOENT: 'no such file or folder',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  ENOTDIR: 'not a folder',
  EISDIR: 'is a folder',
  ELOOP: 'too many links',
  ENOSPC: 'no space left on the device',
  EROFS: 'read-only file system',
}

/**
 * An error as the page may read it. A Node fs error carries absolute paths ("EACCES: permission
 * denied, open '/home/<user>/...'"), and a browser view that drives the page must not learn the
 * user's home or project location: an fs error becomes its code's text plus the project-relative
 * path, and any other message has the project's own paths cut out.
 */
function safeMessage(e, root, rel) {
  const where = typeof rel === 'string' && rel ? `: ${rel}` : ''
  if (e && typeof e.code === 'string' && e.code.startsWith('E')) return `${FS_ERROR_TEXT[e.code] || e.code}${where}`
  let msg = e && e.message ? String(e.message) : String(e)
  const roots = [root]
  try {
    roots.push(fs.realpathSync(root))
  } catch {
    // the root itself is gone
  }
  for (const r of roots) if (r) msg = msg.split(r).join('<project>')
  return msg
}

/**
 * Serves one page-tab line (a PageTabInstance: the tab's page in one view) for `type: 'file'`.
 * The page speaks this, every message a JSON object with `t` and a `req` it chose (echoed back):
 *
 *   page -> host
 *   { t: 'open', req, path?, headOnly? }
 *                                      read the file (default: the tab's params.path) and watch it;
 *                                      `headOnly`: no text (a reconnect of a page that holds its base)
 *   { t: 'read', req, path, headOnly? } read it again (the page re-checks on focus); `headOnly`: no text in the answer
 *   { t: 'save', req, path, baseHash, part, parts, text }
 *                                      a save in `parts` messages (text split by the page, each part
 *                                      under the 1 MiB message cap); `baseHash` null recreates a deleted file
 *                                      (the first part may carry `eol` and `bom`: the file's last ones)
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
 * `files` is the shared { root, watcher } of the plugin (makeFiles).
 */
function serveFileTab(files, tab, log) {
  const watches = new Map() // rel -> { real, stop }
  const saves = new Map() // req -> { path, baseHash, eol, bom, parts, got: [], length, timer }
  let closed = false

  const post = (m) => {
    if (!closed) tab.post(m)
  }
  const fail = (req, p, e) => post({ t: 'error', req, path: p, message: safeMessage(e, files.root, p) })
  const dropSave = (req) => {
    const s = saves.get(req)
    if (s && s.timer) clearTimeout(s.timer)
    saves.delete(req)
  }

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
      w.stop.seen(hash)
      return
    }
    if (w) w.stop()
    else if (watches.size >= MAX_LINE_WATCHES) throw new Error('too many files open in this tab')
    // This line's own subscription: its hash is its own, so another line's read or save never mutes it.
    watches.set(rel, {
      real,
      stop: files.watcher.add(real, hash, (_r, ev) => post({ t: 'disk', path: rel, change: ev.change, hash: ev.hash })),
    })
  }

  // A read-only tab of a file outside the project (readOutside): only the path the host put in the
  // tab's params, never one the page names.
  const tabParams = tab.params && typeof tab.params === 'object' ? tab.params : {}
  const outsidePath = typeof tabParams.outside === 'string' ? tabParams.outside : null

  function read(req, p, isOpen, headOnly) {
    if (outsidePath !== null && p === outsidePath) {
      let o
      try {
        o = readOutside(p)
      } catch (e) {
        return fail(req, p, e)
      }
      if (!o.exists) return post({ t: 'file', req, path: p, exists: false, part: 0, parts: 1 })
      const head = describeNoReal(o)
      delete head.text
      return postParts({ t: 'file', req, path: p, exists: true, ...head }, headOnly ? undefined : o.text)
    }
    let r
    try {
      r = readFile(files.root, p)
    } catch (e) {
      return fail(req, typeof p === 'string' ? p : undefined, e)
    }
    if (isOpen && r.exists) sweepTemps(r.real)
    if (isOpen || watches.has(r.rel)) {
      // A missing file is watched at the name it would have: a recreate shows as `changed`.
      const real = r.exists ? r.real : resolveInProject(files.root, r.rel).real
      watch(r.rel, real, r.exists ? r.hash : null)
    }
    if (!r.exists) return post({ t: 'file', req, path: r.rel, exists: false, part: 0, parts: 1 })
    const head = describeNoReal(r)
    delete head.text
    // A head-only read (the page's re-check on window focus) answers the hash and flags without the
    // text: a 5 MB file would otherwise cross the port on every click back into the tab.
    postParts({ t: 'file', req, path: r.rel, exists: true, ...head }, headOnly ? undefined : r.text)
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
      s = { path: m.path, baseHash: m.baseHash, eol: m.eol, bom: m.bom, parts, got: [], length: 0, timer: null }
      saves.set(req, s)
    } else if (m.part !== s.got.length || m.path !== s.path) {
      dropSave(req)
      return fail(req, m.path, new Error('save parts out of order'))
    }
    if (typeof m.text !== 'string') {
      dropSave(req)
      return fail(req, m.path, new Error('text must be a string'))
    }
    s.got.push(m.text)
    s.length += m.text.length
    if (s.length > MAX_SAVE_CHARS) {
      dropSave(req)
      return fail(req, m.path, new Error('the text is too large to save'))
    }
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    if (s.got.length < s.parts) {
      // Nothing bounds saves across lines, so a save whose last part never comes is dropped, not held.
      s.timer = setTimeout(() => {
        if (saves.get(req) === s) {
          saves.delete(req)
          fail(req, s.path, new Error('the save timed out'))
        }
      }, SAVE_PART_TIMEOUT_MS)
      if (s.timer.unref) s.timer.unref()
      return
    }
    saves.delete(req)
    let answer
    let rel
    try {
      const r = resolveInProject(files.root, s.path)
      rel = r.rel
      answer = saveFile(files.root, rel, s.got.join(''), s.baseHash === null ? null : s.baseHash, { eol: s.eol, bom: s.bom })
    } catch (e) {
      return fail(req, s.path, e)
    }
    if (answer.result === 'saved') {
      // Our own write is not news for THIS line (its hash moves on); every other line watching the
      // file still has the old one and hears about it from the watcher.
      const real = resolveInProject(files.root, rel).real
      try {
        watch(rel, real, answer.hash)
      } catch {
        // over the line's watch cap: the save is done all the same
      }
      return post({ t: 'saved', req, path: rel, hash: answer.hash })
    }
    if (answer.written) {
      const w = watches.get(rel)
      if (w) w.stop.seen(answer.hash)
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
          return read(req, m.path === undefined ? (outsidePath !== null ? outsidePath : tabParams.path) : m.path, true, m.headOnly === true)
        }
        case 'read':
          return read(req, m.path, false, m.headOnly === true)
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
    for (const s of saves.values()) if (s.timer) clearTimeout(s.timer)
    saves.clear()
  })
}

/** The plugin's shared file state: the project root and the one watcher every page line subscribes to. */
function makeFiles(root, opts = {}) {
  return { root, watcher: new FolderWatcher(null, opts) }
}

module.exports = {
  MAX_EDIT_BYTES,
  MAX_VIEW_BYTES,
  BINARY_SNIFF_BYTES,
  CHUNK_CHARS,
  safeMessage,
  relativePath,
  resolveInProject,
  sniffBinary,
  decodeBytes,
  encodeText,
  readFile,
  readOutside,
  outsideRefused,
  saveFile,
  chunkText,
  FolderWatcher,
  serveFileTab,
  makeFiles,
}
