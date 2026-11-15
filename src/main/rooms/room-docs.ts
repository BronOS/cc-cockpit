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
// Pure Node, no Electron.
import { randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readVerified } from '../verified-read'
import { warnLog } from '../warn-log'
import type { RoomLogType } from './room-log'
import { isPathPart, isRoomName } from './room-names'
import { RoomError, isUuid } from './room-registry'

/** Per doc, in UTF-8 bytes: a `ccc` reply is one socket line (1 MiB) and plugin CLI I/O is 256 KiB (design §3). */
export const MAX_DOC_BYTES = 256 * 1024
/** Per room, every file under `docs/` together. */
export const MAX_ROOM_DOCS_BYTES = 20 * 1024 * 1024
/** Parts below an area's root (`shared/` or `members/<name>/`), the file's own name included. */
export const MAX_DOC_DEPTH = 4
/** The temp-file marker: a part containing it is refused, so a doc can never be confused with a write in flight. */
const TMP_MARK = '.tmp-'

/** The answer to a refused doc and to a missing one: the same code and the same words. */
const NO_DOC = 'no such doc'

/** Who asks: the owning plugin, or a member as main resolved it from the tab's token. */
export type RoomDocCaller = 'plugin' | { name: string; coordinator: boolean }

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
  if (caller === 'plugin' || caller.coordinator) return true
  return p.area === 'shared' || p.member === caller.name
}

function mayWrite(caller: RoomDocCaller, p: DocPath): boolean {
  if (caller === 'plugin') return true
  // A coordinator reads a member's folder but never writes it: what is there is that member's own word.
  return p.area === 'shared' ? caller.coordinator : p.member === caller.name
}

function byOf(caller: RoomDocCaller): string {
  return caller === 'plugin' ? 'plugin' : caller.name
}

/**
 * Text a doc may hold: a well-formed string (a lone surrogate would turn into U+FFFD on the way to UTF-8, so the
 * doc read back would differ from the one written) with no NUL (a doc is text, not a binary smuggled through).
 */
function isDocText(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0) return false
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

  constructor(private readonly options: RoomDocsOptions) {
    this.warn = options.log ?? warnLog
    this.random = options.random ?? randomBytes
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
        text = new TextDecoder('utf-8', { fatal: true }).decode(read.data)
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
      throw new RoomError('invalid', 'a doc must be UTF-8 text (no NUL, no lone surrogate)')
    }
    const data = Buffer.from(text, 'utf8')
    if (data.length > MAX_DOC_BYTES) throw new RoomError('limit', `a doc may be at most ${MAX_DOC_BYTES} bytes`)
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
      const parent = await this.walkDirs(docs, dirs, true)
      if (parent === null) throw new Refused('missing')
      const target = join(parent, last(p.parts))
      const old = await lstatOrNull(target)
      // A link or a folder where the doc goes is refused, never replaced: a link in the store means someone planted it.
      if (old !== null && !old.isFile()) throw new Refused(old.isSymbolicLink() ? 'symlink' : 'not-file')
      const total = await this.storeBytes(docs)
      if (total - (old?.size ?? 0) + data.length > MAX_ROOM_DOCS_BYTES) {
        throw new RoomError('limit', `a room's docs may be at most ${MAX_ROOM_DOCS_BYTES} bytes together`)
      }
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
    if (!(err instanceof RoomError)) {
      this.warn(`rooms: doc ${op} ${path} in ${roomId} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return err
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

  /** Bytes of every regular file under the store (temp leftovers too: they take the space as well). */
  private async storeBytes(dir: string, depth = 0): Promise<number> {
    let total = 0
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const e of entries) {
      const at = join(dir, e.name)
      if (e.isDirectory() && depth < MAX_DOC_DEPTH + 2) total += await this.storeBytes(at, depth + 1)
      else if (e.isFile()) total += (await lstatOrNull(at))?.size ?? 0
    }
    return total
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
