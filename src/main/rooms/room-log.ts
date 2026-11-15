import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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
  private size: number | null = null

  constructor(
    private readonly path: string,
    private readonly maxBytes: number = ROOM_LOG_MAX_BYTES,
    private readonly now: () => number = Date.now
  ) {}

  append(type: RoomLogType, fields: Record<string, unknown> = {}): void {
    // `at` and `type` last so a caller's field can never override them.
    const line = JSON.stringify({ ...fields, at: this.now(), type }) + '\n'
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    appendFileSync(this.path, line, { mode: 0o600 })
    this.size = (this.size ?? this.statSize()) + Buffer.byteLength(line)
    if (this.size > this.maxBytes) this.trim()
  }

  read(opts: RoomLogReadOptions = {}): RoomLogEntry[] {
    let out = parseLines(this.readText()).filter((e) => opts.since === undefined || e.at > opts.since)
    if (opts.limit !== undefined && opts.limit >= 0 && out.length > opts.limit) {
      out = opts.limit === 0 ? [] : out.slice(-opts.limit)
    }
    return out
  }

  /** Drop the oldest half of the lines (by count) and say so in a line of its own. */
  private trim(): void {
    const lines = this.readText().split('\n').filter((l) => l !== '')
    const dropped = Math.ceil(lines.length / 2)
    const kept = lines.slice(dropped)
    kept.push(JSON.stringify({ at: this.now(), type: 'trimmed', dropped }))
    const text = kept.join('\n') + '\n'
    writeFileSync(this.path, text, { mode: 0o600 })
    this.size = Buffer.byteLength(text)
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
