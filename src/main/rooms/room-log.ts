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
  /** Epoch ms; `since` compares against it. */
  at: number
  type: RoomLogType
  /** Free fields per event: member, why, path, delivery, text... Plain data only. */
  [key: string]: unknown
}

export interface RoomLogReadOptions {
  /** Only entries with `at` greater than this. */
  since?: number
  /** At most this many, the newest ones (a reader polling with `since` wants the tail). */
  limit?: number
}

/**
 * Append-only JSON-lines log of one room's events, message text included (the person's record).
 * Synchronous on purpose: callers log from inside decisions and must keep the order of events, and
 * a line is one `appendFileSync` so a crash leaves at most a torn last line, which `read` skips.
 */
export class RoomLog {
  /** Set once this instance has checked the file ends in a newline (a torn last line has none). */
  private checkedTail = false

  constructor(
    private readonly path: string,
    private readonly maxBytes: number = ROOM_LOG_MAX_BYTES,
    private readonly now: () => number = Date.now
  ) {}

  append(type: RoomLogType, fields: Record<string, unknown> = {}): void {
    // `at` and `type` last so a caller's field can never override them.
    const entry = JSON.stringify({ ...fields, at: this.now(), type }) + '\n'
    this.ensureDir()
    // A torn last line has no newline: without one first, this entry would glue onto the fragment and be lost on read.
    const line = !this.checkedTail && !this.endsInNewline() ? '\n' + entry : entry
    this.checkedTail = true
    // The log carries text members choose, so a planted link must never turn an append into a write elsewhere:
    // O_NOFOLLOW refuses a linked log.jsonl and fstat refuses anything but a regular file.
    const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
    let size: number
    try {
      if (!fstatSync(fd).isFile()) throw new Error('room log is not a regular file')
      writeSync(fd, line)
      // Stat each time: another instance or process may have appended, and a cached size would let the cap be exceeded.
      size = fstatSync(fd).size
    } finally {
      closeSync(fd)
    }
    if (size > this.maxBytes) this.trim()
  }

  read(opts: RoomLogReadOptions = {}): RoomLogEntry[] {
    // A non-number or NaN `since` / a negative `limit` is treated as absent, never as "match nothing".
    const since = typeof opts.since === 'number' && !Number.isNaN(opts.since) ? opts.since : undefined
    let out = parseLines(this.readText()).filter((e) => since === undefined || e.at > since)
    if (typeof opts.limit === 'number' && opts.limit >= 0 && out.length > opts.limit) {
      out = opts.limit === 0 ? [] : out.slice(-opts.limit)
    }
    return out
  }

  /** Keep the newest lines that fit in half the cap (by bytes, so a few huge lines cannot stay over it) and say so in a line of its own. */
  private trim(): void {
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
    kept.push(JSON.stringify({ at: this.now(), type: 'trimmed', dropped }))
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

  private endsInNewline(): boolean {
    const f = this.openRead()
    if (f === null || f.size === 0) return true
    try {
      const b = Buffer.alloc(1)
      readSync(f.fd, b, 0, 1, f.size - 1)
      return b[0] === 0x0a
    } finally {
      closeSync(f.fd)
    }
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

/** A line that is not a JSON object with a numeric `at` and a string `type` (a torn write) is skipped. */
function parseLines(text: string): RoomLogEntry[] {
  const out: RoomLogEntry[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const v: unknown = JSON.parse(line)
      if (v && typeof v === 'object' && typeof (v as RoomLogEntry).at === 'number' && typeof (v as RoomLogEntry).type === 'string') {
        out.push(v as RoomLogEntry)
      }
    } catch {
      // torn line
    }
  }
  return out
}
