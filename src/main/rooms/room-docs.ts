// The doc store of a room (design-rooms.md §3): `<data>/rooms/<id>/docs/{shared,members/<name>}/...`,
// written only by main. Members reach it through `ccc room doc ...` and the owning plugin through
// `ctx.rooms.docs`; both arrive here with the caller already resolved by main (Task 8): a member's
// name and coordinator flag from its tab token, `'plugin'` for the owner. Nothing in a path is
// trusted: every part is checked against room-names.ts's character set, no `.` or `..`, a bounded
// depth, and every directory on the way is lstat'd (a planted link anywhere is refused, not
// followed). Files are read through one verified descriptor (verified-read.ts: O_NOFOLLOW, fstat,
// the name still naming that file) and written to a temp file next to the target, then renamed.
// A refused doc answers exactly like a missing one ("blind work stays blind"): a member must not be
// able to learn what another member's private folder holds by the error it gets.
// Known limit (design §3): the 20 MiB cap is one total for the whole room, member folders included, so a member can
// fill the room until a coordinator cannot write `shared/`, and can estimate what others hold privately from where
// `limit` starts. Per-area quotas would fix both and are not in v1.
// Pure Node, no Electron.
import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readVerified } from '../verified-read'
import { warnLog } from '../warn-log'
import type { RoomLogType } from './room-log'
import { isPathPart, isRoomName } from '../../shared/room-names'
import { CONTROL } from '../../shared/session-name'
import { RoomError, isUuid } from './room-registry'

/** Per doc, in UTF-8 bytes: a `ccc` reply is one socket line (1 MiB) and plugin CLI I/O is 256 KiB (design §3). */
export const MAX_DOC_BYTES = 256 * 1024
/** Per room, every file under `docs/` together. */
export const MAX_ROOM_DOCS_BYTES = 20 * 1024 * 1024
/** Parts below an area's root (`shared/` or `members/<name>/`), the file's own name included. */
export const MAX_DOC_DEPTH = 4
/** Per room, files and folders together: logical bytes alone let empty docs and folders pile up, and every put walks them all. */
export const MAX_ROOM_DOC_ENTRIES = 1000
/** The temp-file marker: a part containing it is refused, so a doc can never be confused with a write in flight. */
const TMP_MARK = '.tmp-'

/** The answer to a refused doc and to a missing one: the same code and the same words. */
const NO_DOC = 'no such doc'

/**
 * Who asks: the owning plugin, the person (the room view, main checked the window: reads every folder, never writes),
 * or a member as main resolved it from the tab's token.
 */
export type RoomDocCaller = 'plugin' | 'person' | { name: string; coordinator: boolean }

export interface RoomDocEntry {
  /** `shared/...` or `members/<name>/...`. */
  path: string
  /** Bytes. */
  size: number
}

/** A parsed doc path: the area, the member for `members/`, the parts below the area root. */
export type DocPath = { area: 'shared'; parts: string[] } | { area: 'members'; member: string; parts: string[] }

export interface RoomDocsOptions {
  /** `<data>/rooms`, the registry's dir. */
  dir: string
  /** The room's log (the registry's `logOf`); an append that throws is a warning. */
  logOf: (roomId: string) => { append(type: RoomLogType, fields?: Record<string, unknown>): void }
  log?: (message: string) => void
  /** Temp-file suffix bytes (tests pin them). */
  random?: (bytes: number) => Buffer
  /** The room total (default MAX_ROOM_DOCS_BYTES); tests use a small one, 20 MiB in a quota'd temp dir fails with EDQUOT. */
  maxRoomBytes?: number
}

/** Parse `shared/a/b.md` or `members/<name>/a.md`; null when anything is off (a `..`, a bad character, too deep). */
export function parseDocPath(raw: unknown): DocPath | null {
  if (typeof raw !== 'string') return null
  const all = raw.split('/')
  const head = all[0]
  if (head === 'shared') {
    const parts = all.slice(1)
    return checkParts(parts) ? { area: 'shared', parts } : null
  }
  if (head === 'members') {
    const member = all[1]
    const parts = all.slice(2)
    if (!isRoomName(member)) return null
    return checkParts(parts) ? { area: 'members', member, parts } : null
  }
  return null
}

function checkParts(parts: string[]): boolean {
  if (parts.length === 0 || parts.length > MAX_DOC_DEPTH) return false
  return parts.every((p) => isPathPart(p) && !p.includes(TMP_MARK))
}

function docPathText(p: DocPath): string {
  return p.area === 'shared' ? ['shared', ...p.parts].join('/') : ['members', p.member, ...p.parts].join('/')
}

function mayRead(caller: RoomDocCaller, p: DocPath): boolean {
  if (caller === 'plugin' || caller === 'person' || caller.coordinator) return true
  return p.area === 'shared' || p.member === caller.name
}

function mayWrite(caller: RoomDocCaller, p: DocPath): boolean {
  if (caller === 'plugin') return true
  // The room view is read-only: what is in a doc is the plugin's or a member's word, never the person's by the back door.
  if (caller === 'person') return false
  // A coordinator reads a member's folder but never writes it: what is there is that member's own word.
  return p.area === 'shared' ? caller.coordinator : p.member === caller.name
}

function byOf(caller: RoomDocCaller): string {
  return caller === 'plugin' || caller === 'person' ? caller : caller.name
}

/**
 * Text a doc may hold: a well-formed string (a lone surrogate would turn into U+FFFD on the way to UTF-8, so the
 * doc read back would differ from the one written) with no control, bidi or invisible format character but tab, LF
 * and CRLF (and a leading BOM): the one character test of a fence and a session name (session-name.ts CONTROL), minus what a text
 * needs. `ccc room doc get` prints a doc exactly (it is piped on, so no fence) into a terminal: DEL, a C1 control
 * (U+009B is a CSI in xterm.js), a bidi override or isolate (Trojan Source) and a lone CR (it overwrites the line)
 * would let a member hide what it wrote from the person watching the tab, so they never get in. The controls are
 * also what keeps every doc readable: JSON writes each of them as a six-byte `\u00XX`, so a 256 KiB doc of them
 * would be a 1.5 MiB reply, past the client's 1 MiB line; with only these left no character takes more than twice
 * its UTF-8 size in JSON (`"`, `\`, tab, LF, CR).
 */
function isDocText(text: string): boolean {
  // CRLF is the one place a CR may be; what is left of CONTROL after tab and LF are taken out is refused.
  // A leading BOM stays (a file from a Windows editor round-trips exactly; at the start it hides nothing).
  const body = text.startsWith('\ufeff') ? text.slice(1) : text
  if (CONTROL.test(body.replace(/\r\n/g, '\n').replace(/[\t\n]/g, ''))) return false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)

/** A refusal the caller sees as "no such doc"; `reason` goes to the log only. */
class Refused extends Error {}

export class RoomDocs {
  /** The tail of each room's write chain: one write at a time per room, in call order, so the last call wins. */
  private readonly writes = new Map<string, Promise<unknown>>()
  private readonly warn: (message: string) => void
  private readonly random: (bytes: number) => Buffer
  private readonly maxRoomBytes: number

  constructor(private readonly options: RoomDocsOptions) {
    this.warn = options.log ?? warnLog
    this.random = options.random ?? randomBytes
    this.maxRoomBytes = options.maxRoomBytes ?? MAX_ROOM_DOCS_BYTES
  }

  /** The docs the caller may read, sorted by path. A missing store is an empty list. */
  async list(roomId: string, caller: RoomDocCaller): Promise<RoomDocEntry[]> {
    const docs = await this.docsDir(roomId, false)
    if (docs === null) return []
    const out: RoomDocEntry[] = []
    await this.walk(docs, [], out)
    return out
      .filter((e) => {
        const p = parseDocPath(e.path)
        return p !== null && mayRead(caller, p)
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  /**
   * The folder the room view's Reveal shows: the room's `docs/`, or the room's own folder while no doc was written;
   * every level checked to be a plain folder (never a link). Null when neither is there.
   */
  async folder(roomId: string): Promise<string | null> {
    const docs = await this.docsDir(roomId, false)
    if (docs !== null) return docs
    let base: string
    try {
      base = await realpath(this.options.dir)
    } catch {
      return null
    }
    return this.walkDirs(base, [roomId], false)
  }

  /** The text of a doc. Refused, missing, a link, not a file: all `not-found` with the same words. */
  async get(roomId: string, caller: RoomDocCaller, rawPath: unknown): Promise<string> {
    const p = this.parse(roomId, caller, rawPath, 'get')
    const path = docPathText(p)
    try {
      if (!mayRead(caller, p)) throw new Refused('not allowed')
      const docs = await this.docsDir(roomId, false)
      if (docs === null) throw new Refused('missing')
      const dirs = dirParts(p)
      if ((await this.walkDirs(docs, dirs, false)) === null) throw new Refused('missing')
      const read = await readVerified(join(docs, ...dirs, last(p.parts)), MAX_DOC_BYTES)
      if (!read.ok) throw new Refused(read.problem)
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.data)
      } catch {
        throw new Refused('not UTF-8')
      }
      this.logEvent(roomId, 'doc-read', { by: byOf(caller), path, bytes: read.data.length })
      return text
    } catch (err) {
      throw this.refusal(err, roomId, caller, path, 'get')
    }
  }

  /** Write a doc (created or replaced), one write at a time per room. */
  async put(roomId: string, caller: RoomDocCaller, rawPath: unknown, text: unknown): Promise<void> {
    const p = this.parse(roomId, caller, rawPath, 'put')
    const path = docPathText(p)
    if (!mayWrite(caller, p)) throw this.refusal(new Refused('not allowed'), roomId, caller, path, 'put')
    // Text checks only after access: a refused caller learns nothing more than "no such doc".
    if (typeof text !== 'string' || !isDocText(text)) {
      this.logEvent(roomId, 'doc-refused', { by: byOf(caller), path, op: 'put', reason: 'bad text' })
      throw new RoomError('invalid', 'a doc must be UTF-8 text (no control, bidi or invisible format character but tab and line breaks, no lone CR, no lone surrogate)')
    }
    const data = Buffer.from(text, 'utf8')
    if (data.length > MAX_DOC_BYTES) {
      this.logEvent(roomId, 'doc-refused', { by: byOf(caller), path, op: 'put', reason: 'too large' })
      throw new RoomError('limit', `a doc may be at most ${MAX_DOC_BYTES} bytes`)
    }
    const run = (this.writes.get(roomId) ?? Promise.resolve()).then(() => this.write(roomId, caller, p, path, data))
    // The chain must survive a failed write, and is dropped once it is idle.
    const tail = run.catch(() => {})
    this.writes.set(roomId, tail)
    void tail.then(() => {
      if (this.writes.get(roomId) === tail) this.writes.delete(roomId)
    })
    return run
  }

  private async write(roomId: string, caller: RoomDocCaller, p: DocPath, path: string, data: Buffer): Promise<void> {
    try {
      const docs = await this.docsDir(roomId, true)
      if (docs === null) throw new Refused('missing')
      const dirs = dirParts(p)
      // Totals first (and leftover temp files swept), so nothing is made on disk for a put that will be refused.
      const store = await this.storeStats(docs)
      let parent = await this.walkDirs(docs, dirs, false)
      const name = last(p.parts)
      const old = parent === null ? null : await lstatOrNull(join(parent, name))
      // A link or a folder where the doc goes is refused, never replaced: a link in the store means someone planted it.
      if (old !== null && !old.isFile()) throw new Refused(old.isSymbolicLink() ? 'symlink' : 'not-file')
      if (old === null && store.entries >= MAX_ROOM_DOC_ENTRIES) {
        throw new RoomError('limit', `a room's docs may be at most ${MAX_ROOM_DOC_ENTRIES} files and folders together`)
      }
      if (store.bytes - (old?.size ?? 0) + data.length > this.maxRoomBytes) {
        throw new RoomError('limit', `a room's docs may be at most ${this.maxRoomBytes} bytes together`)
      }
      parent ??= await this.walkDirs(docs, dirs, true)
      if (parent === null) throw new Refused('missing')
      const target = join(parent, name)
      // No ancestor swapped for a link since the walk, before anything is created (and again after the write).
      if ((await realpath(parent)) !== parent) throw new Refused('changed')
      const tmp = `${target}${TMP_MARK}${this.random(6).toString('hex')}`
      const fh = await open(tmp, WRITE_FLAGS, 0o600)
      try {
        try {
          await fh.writeFile(data)
        } finally {
          await fh.close()
        }
        // The folder must still be the one checked (no ancestor swapped for a link meanwhile), as in verified-read.ts.
        if ((await realpath(parent)) !== parent) throw new Refused('changed')
        await rename(tmp, target)
      } catch (err) {
        await unlink(tmp).catch(() => {})
        throw err
      }
      this.logEvent(roomId, 'doc-write', { by: byOf(caller), path, bytes: data.length })
    } catch (err) {
      throw this.refusal(err, roomId, caller, path, 'put')
    }
  }

  /** A checked path, or `invalid` (logged): the path's shape says nothing about what the store holds. */
  private parse(roomId: string, caller: RoomDocCaller, rawPath: unknown, op: 'get' | 'put'): DocPath {
    if (!isUuid(roomId)) throw new RoomError('not-found', 'no such room')
    const p = parseDocPath(rawPath)
    if (p === null) {
      this.logEvent(roomId, 'doc-refused', { by: byOf(caller), path: String(rawPath).slice(0, 300), op, reason: 'bad path' })
      throw new RoomError(
        'invalid',
        `a doc path is shared/... or members/<name>/..., at most ${MAX_DOC_DEPTH} parts of A-Z a-z 0-9 . _ - below it, no . or ..`
      )
    }
    return p
  }

  /** Log a refusal and turn it into the caller's error: every Refused is "no such doc"; other errors pass through. */
  private refusal(err: unknown, roomId: string, caller: RoomDocCaller, path: string, op: 'get' | 'put'): unknown {
    const reason = err instanceof Refused ? err.message : err instanceof RoomError ? err.code : 'error'
    this.logEvent(roomId, 'doc-refused', { by: byOf(caller), path, op, reason })
    if (err instanceof Refused) return new RoomError('not-found', NO_DOC)
    if (err instanceof RoomError) return err
    // An fs error carries the data dir's absolute path: log it, answer with words that name nothing.
    this.warn(`rooms: doc ${op} ${path} in ${roomId} failed: ${err instanceof Error ? err.message : String(err)}`)
    return new RoomError('error', `could not ${op === 'get' ? 'read' : 'write'} the doc`)
  }

  /**
   * `<real rooms dir>/<id>/docs`, every level checked to be a real folder (not a link); made when `create`.
   * Null when a level is missing (and not made) or is not a plain folder.
   */
  private async docsDir(roomId: string, create: boolean): Promise<string | null> {
    if (!isUuid(roomId)) throw new RoomError('not-found', 'no such room')
    if (create) await mkdir(this.options.dir, { recursive: true, mode: 0o700 })
    let base: string
    try {
      // The data dir itself may sit behind a link (a moved home); everything below it may not.
      base = await realpath(this.options.dir)
    } catch {
      return null
    }
    return this.walkDirs(base, [roomId, 'docs'], create)
  }

  /** Walk `parts` below `from`, each a plain folder (lstat: a link is refused), made (0700) when `create`. */
  private async walkDirs(from: string, parts: string[], create: boolean): Promise<string | null> {
    let at = from
    for (const part of parts) {
      at = join(at, part)
      let st = await lstatOrNull(at)
      if (st === null) {
        if (!create) return null
        try {
          await mkdir(at, { mode: 0o700 })
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
        st = await lstatOrNull(at)
      }
      if (st === null || !st.isDirectory()) return null
    }
    return at
  }

  /** Every regular file the caller could list, as store paths; links and odd files are skipped, never followed. */
  private async walk(dir: string, rel: string[], out: RoomDocEntry[]): Promise<void> {
    // shared/ + 4 parts, members/<name>/ + 4 parts: deeper than that is nothing the store wrote.
    if (rel.length > MAX_DOC_DEPTH + 2) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const next = [...rel, e.name]
      if (e.isDirectory()) await this.walk(join(dir, e.name), next, out)
      else if (e.isFile() && !e.name.includes(TMP_MARK)) {
        const st = await lstatOrNull(join(dir, e.name))
        if (st !== null && st.isFile()) out.push({ path: next.join('/'), size: st.size })
      }
    }
  }

  /**
   * Bytes of every regular file under the store and the count of files and folders. A `.tmp-` file is a leftover of a
   * write that never finished (writes are serialized per room, so none is in flight when this runs inside the chain):
   * it is removed, not counted.
   */
  private async storeStats(dir: string, depth = 0): Promise<{ bytes: number; entries: number }> {
    const out = { bytes: 0, entries: 0 }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) {
      const at = join(dir, e.name)
      if (e.isDirectory() && depth < MAX_DOC_DEPTH + 2) {
        const sub = await this.storeStats(at, depth + 1)
        out.bytes += sub.bytes
        out.entries += sub.entries + 1
      } else if (e.isFile()) {
        if (e.name.includes(TMP_MARK)) {
          await unlink(at).catch(() => {})
          continue
        }
        out.bytes += (await lstatOrNull(at))?.size ?? 0
        out.entries++
      }
    }
    return out
  }

  private logEvent(roomId: string, type: RoomLogType, fields: Record<string, unknown>): void {
    try {
      this.options.logOf(roomId).append(type, fields)
    } catch (err) {
      this.warn(`rooms: could not log to ${roomId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

/** The folders from the store root to the doc's own folder. */
function dirParts(p: DocPath): string[] {
  const head = p.area === 'shared' ? ['shared'] : ['members', p.member]
  return [...head, ...p.parts.slice(0, -1)]
}

function last(parts: string[]): string {
  return parts[parts.length - 1] as string
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw err
  }
}
