import { closeSync, constants, fstatSync, mkdirSync, lstatSync, openSync, readFileSync, readSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { writeFileAtomic } from '../hooks/write-file-atomic'

/** Per-room cap on `log.jsonl` (design-rooms.md §4): past it the oldest half is dropped. */
export const ROOM_LOG_MAX_BYTES = 20 * 1024 * 1024

/** The events main logs (design-rooms.md §4); `trimmed` is the line the cap itself appends. */
export type RoomLogType =
  | 'create'
  | 'invite'
  | 'join'
  | 'leave'
  | 'send'
  | 'doc-read'
  | 'doc-write'
  | 'doc-refused'
  | 'pause'
  | 'resume'
  | 'auto-pause'
  | 'end'
  | 'trimmed'

export interface RoomLogEntry {
  /**
   * The entry's number in its room: 1, 2, 3... in the order appended, never reused (a trim keeps the numbers, so the
   * next one after a trim jumps). The cursor of `read({ since })`: `at` cannot be one, since several events share a
   * millisecond (an end logs its leaves and the end together; a send to `all`).
   */
  seq: number
  /** Epoch ms. */
  at: number
  type: RoomLogType
  /** Free fields per event: member, why, path, delivery, text... Plain data only. */
  [key: string]: unknown
}

export interface RoomLogReadOptions {
  /**
   * A cursor: only entries with `seq` greater than this, the OLDEST first up to `limit` (a poller that fell behind
   * catches up page by page and loses nothing between). Without it, the newest `limit`.
   */
  since?: number
  /** At most this many. */
  limit?: number
}

/** A read's answer: `more` says entries were left out past `limit` (newer ones with `since`, older ones without). */
export interface RoomLogPage {
  entries: RoomLogEntry[]
  more: boolean
}

/** The unit of a read: a read never parses the whole file but at a trim, only the lines it answers with and their neighbours. */
const CHUNK = 64 * 1024

/**
 * Append-only JSON-lines log of one room's events, message text included (the person's record).
 * Synchronous on purpose: callers log from inside decisions and must keep the order of events, and
 * a line is one write so a crash leaves at most a torn last line, which a read skips.
 *
 * Reads stay off main's loop budget (`ctx.rooms.log` is polled, and a log may hold 20 MiB): the newest entries are
 * read backwards from the end, and a `since` cursor finds its place by a binary search over byte offsets (the lines
 * are in `seq` order), so a read costs about the bytes it answers with, never a parse of the whole file.
 */
export class RoomLog {
  constructor(
    private readonly path: string,
    private readonly maxBytes: number = ROOM_LOG_MAX_BYTES,
    private readonly now: () => number = Date.now
  ) {}

  append(type: RoomLogType, fields: Record<string, unknown> = {}): void {
    this.ensureDir()
    // The log carries text members choose, so a planted link must never turn an append into a write elsewhere:
    // O_NOFOLLOW refuses a linked log.jsonl and fstat refuses anything but a regular file. Read and write on one
    // descriptor: the next `seq` comes from the file's own last entry (another instance or process may have
    // appended), so it is the file the line goes to.
    const fd = openSync(this.path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
    let size: number
    let seq: number
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) throw new Error('room log is not a regular file')
      seq = (newest(fd, st.size, 1).entries[0]?.seq ?? 0) + 1
      // `seq`, `at` and `type` last so a caller's field can never override them.
      const entry = JSON.stringify({ ...fields, seq, at: this.now(), type }) + '\n'
      // A torn last line has no newline: without one first, this entry would glue onto the fragment and be lost on read.
      writeSync(fd, st.size > 0 && lastByte(fd, st.size) !== 0x0a ? '\n' + entry : entry)
      // Stat each time: another instance or process may have appended, and a cached size would let the cap be exceeded.
      size = fstatSync(fd).size
    } finally {
      closeSync(fd)
    }
    if (size > this.maxBytes) this.trim(seq + 1)
  }

  /** The entries a read answers (`page` without the flag). */
  read(opts: RoomLogReadOptions = {}): RoomLogEntry[] {
    return this.page(opts).entries
  }

  page(opts: RoomLogReadOptions = {}): RoomLogPage {
    // A non-number or NaN `since` / a negative `limit` is treated as absent, never as "match nothing".
    const since = typeof opts.since === 'number' && !Number.isNaN(opts.since) ? opts.since : undefined
    const limit = typeof opts.limit === 'number' && opts.limit >= 0 ? Math.floor(opts.limit) : undefined
    const f = this.openRead()
    if (f === null) return { entries: [], more: false }
    try {
      return since === undefined ? newest(f.fd, f.size, limit) : after(f.fd, f.size, since, limit)
    } catch {
      return { entries: [], more: false }
    } finally {
      closeSync(f.fd)
    }
  }

  /** Keep the newest lines that fit in half the cap (by bytes, so a few huge lines cannot stay over it) and say so in a line of its own. */
  private trim(seq: number): void {
    const lines = this.readText().split('\n').filter((l) => l !== '')
    let bytes = 0
    let keep = 0
    for (let i = lines.length - 1; i >= 0; i--) {
      bytes += Buffer.byteLength(lines[i] ?? '') + 1
      if (bytes > this.maxBytes / 2) break
      keep++
    }
    // Always drop at least one line, or the log would trim on every append.
    keep = Math.min(keep, lines.length - 1)
    const dropped = lines.length - keep
    const kept = lines.slice(dropped)
    kept.push(JSON.stringify({ dropped, seq, at: this.now(), type: 'trimmed' }))
    writeFileAtomic(this.path, kept.join('\n') + '\n', 0o600)
  }

  /**
   * The room folder must be a real directory directly under the real rooms dir: `mkdirSync` recursive would follow
   * a folder replaced by a link after the registry loaded (it skips linked folders only at load).
   */
  private ensureDir(): void {
    const room = dirname(this.path)
    const rooms = dirname(room)
    mkdirSync(rooms, { recursive: true, mode: 0o700 })
    try {
      mkdirSync(room, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    // The data dir itself may sit behind a link (a moved home); the room folder may not.
    if (!lstatSync(room).isDirectory() || realpathSync(room) !== join(realpathSync(rooms), basename(room))) {
      throw new Error('room folder is not a plain directory')
    }
  }

  /** Open for reading without following a link or blocking on a FIFO; null when missing or not a regular file. */
  private openRead(): { fd: number; size: number } | null {
    let fd: number
    try {
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    } catch {
      return null
    }
    try {
      const st = fstatSync(fd)
      if (st.isFile()) return { fd, size: st.size }
    } catch {
      // fall through
    }
    closeSync(fd)
    return null
  }

  private readText(): string {
    const f = this.openRead()
    if (f === null) return ''
    try {
      return readFileSync(f.fd, 'utf8')
    } catch {
      return ''
    } finally {
      closeSync(f.fd)
    }
  }
}

/** A line that is not a JSON object with a positive whole `seq`, a numeric `at` and a string `type` (a torn write) is undefined. */
function parseLine(line: Buffer): RoomLogEntry | undefined {
  if (line.length === 0) return undefined
  try {
    const v: unknown = JSON.parse(line.toString('utf8'))
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
    const e = v as RoomLogEntry
    return Number.isSafeInteger(e.seq) && e.seq > 0 && typeof e.at === 'number' && typeof e.type === 'string' ? e : undefined
  } catch {
    return undefined // torn line
  }
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.alloc(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got)
    if (n === 0) break
    got += n
  }
  return got === len ? buf : buf.subarray(0, got)
}

function lastByte(fd: number, size: number): number | undefined {
  return readAt(fd, size - 1, 1)[0]
}

/** The lines from `start` on (each without its newline), with the offset after each; the last may have no newline. */
function* linesFrom(fd: number, size: number, start: number): Generator<{ line: Buffer; start: number; end: number }> {
  let pos = start
  let carry: Buffer = Buffer.alloc(0)
  let carryAt = start
  while (pos < size) {
    const chunk = readAt(fd, pos, Math.min(CHUNK, size - pos))
    if (chunk.length === 0) break
    pos += chunk.length
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
    let from = 0
    for (let nl = data.indexOf(0x0a, from); nl !== -1; nl = data.indexOf(0x0a, from)) {
      yield { line: data.subarray(from, nl), start: carryAt + from, end: carryAt + nl + 1 }
      from = nl + 1
    }
    carry = data.subarray(from)
    carryAt += from
  }
  if (carry.length > 0) yield { line: carry, start: carryAt, end: carryAt + carry.length }
}

/** The newest `limit` entries (all without one), oldest first, read backwards from the end. */
function newest(fd: number, size: number, limit: number | undefined): RoomLogPage {
  const out: RoomLogEntry[] = [] // newest first while reading
  const full = (): boolean => limit !== undefined && out.length > limit
  let pos = size
  let carry: Buffer = Buffer.alloc(0)
  while (pos > 0 && !full()) {
    const len = Math.min(CHUNK, pos)
    pos -= len
    const data = carry.length > 0 ? Buffer.concat([readAt(fd, pos, len), carry]) : readAt(fd, pos, len)
    // Everything after the first newline of `data` is whole lines; the part before it may continue further back.
    let end = data.length
    for (let nl = data.lastIndexOf(0x0a, end - 1); nl !== -1 && !full(); nl = end > 0 ? data.lastIndexOf(0x0a, end - 1) : -1) {
      const e = parseLine(data.subarray(nl + 1, end))
      if (e) out.push(e)
      end = nl
    }
    carry = data.subarray(0, end)
  }
  if (pos === 0 && !full()) {
    const e = parseLine(carry)
    if (e) out.push(e)
  }
  const more = full()
  if (more) out.length = limit as number
  return { entries: out.reverse(), more }
}

/**
 * The oldest `limit` entries with `seq` after `since`. Lines are in `seq` order, so a binary search over byte offsets
 * narrows to the first line past the cursor (`lo` only ever moves past a line known to be at or before it), and only
 * the last stretch is read line by line.
 */
function after(fd: number, size: number, since: number, limit: number | undefined): RoomLogPage {
  let lo = 0
  let hi = size
  while (hi - lo > CHUNK) {
    const mid = lo + Math.floor((hi - lo) / 2)
    // The first whole entry starting at or after `mid`: reading from `mid - 1` makes the first line the rest of the
    // one `mid` falls in (empty when `mid` starts a line), which is skipped.
    let found: { seq: number; end: number } | undefined
    let first = true
    for (const l of linesFrom(fd, size, mid - 1)) {
      if (first) {
        first = false
        continue
      }
      if (l.start >= hi) break
      const e = parseLine(l.line)
      if (e) {
        found = { seq: e.seq, end: l.end }
        break
      }
    }
    if (found === undefined || found.seq > since) hi = mid
    else lo = found.end
  }
  const out: RoomLogEntry[] = []
  for (const l of linesFrom(fd, size, lo)) {
    const e = parseLine(l.line)
    if (!e || e.seq <= since) continue
    if (limit !== undefined && out.length >= limit) return { entries: out, more: true }
    out.push(e)
  }
  return { entries: out, more: false }
}
