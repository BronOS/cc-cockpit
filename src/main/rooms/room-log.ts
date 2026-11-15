import { appendFileSync, mkdirSync, openSync, closeSync, readSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../hooks/write-file-atomic'

/** Per-room cap on `log.jsonl` (design-rooms.md §4): past it the oldest half is dropped. */
export const ROOM_LOG_MAX_BYTES = 20 * 1024 * 1024

/** The events main logs (design-rooms.md §4); `trimmed` is the line the cap itself appends. */
export type RoomLogType =
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
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    // A torn last line has no newline: without one first, this entry would glue onto the fragment and be lost on read.
    const line = !this.checkedTail && !this.endsInNewline() ? '\n' + entry : entry
    this.checkedTail = true
    appendFileSync(this.path, line, { mode: 0o600 })
    // Stat each time: another instance or process may have appended, and a cached size would let the cap be exceeded.
    if (this.statSize() > this.maxBytes) this.trim()
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

  private endsInNewline(): boolean {
    let fd: number
    try {
      fd = openSync(this.path, 'r')
    } catch {
      return true
    }
    try {
      const size = statSync(this.path).size
      if (size === 0) return true
      const b = Buffer.alloc(1)
      readSync(fd, b, 0, 1, size - 1)
      return b[0] === 0x0a
    } finally {
      closeSync(fd)
    }
  }

  private readText(): string {
    try {
      return readFileSync(this.path, 'utf8')
    } catch {
      return ''
    }
  }

  private statSize(): number {
    try {
      return statSync(this.path).size
    } catch {
      return 0
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
