// The web access log (design-web.md §4.1 "Log"): who signed in, connected, disconnected or was
// revoked, and when the auth mode changed. `<data>/logs/web-access.log`, one JSON object per line,
// rotated at 1 MiB (`.1` keeps the previous file). Plugin logs share the folder, but a plugin id
// always has a dot, so `web-access.log` can never be one of theirs.
//
// What it never holds: terminal text, prompts, panel messages, and secrets (an access token, a
// one-time token, a device cookie or its hash, a password). The entry type only has room for ids,
// names and a short detail, and every string is cleaned and capped here, so a caller cannot pass a
// frame through by accident. A device name is the requester's own text: it is kept as plain text
// (control and bidi characters dropped) and shown as such.
//
// Synchronous appends, like plugin-log.ts: entries are rare (a sign-in, a socket opening), and an
// entry written just before a crash must not be lost. A recent ring stays in memory for the
// desktop's device list (plan Task 9).
import * as nodeFs from 'node:fs'
import { dirname } from 'node:path'

export const MAX_ACCESS_LOG_BYTES = 1024 * 1024
/** Entries kept in memory for the desktop's view. */
export const ACCESS_LOG_RING = 200
/** Longest string kept in an entry field. */
const MAX_FIELD = 120

export type AccessEvent =
  | 'sign-in'
  | 'sign-in-failed'
  | 'connect'
  | 'disconnect'
  | 'revoke'
  | 'expired'
  | 'regenerate'
  | 'mode'

export interface AccessEntry {
  event: AccessEvent
  /** The device id (never its secret). */
  device?: string
  /** The device's name, the requester's own text. */
  name?: string
  /** How it signed in, why it was revoked, `from → to` for a mode change. */
  detail?: string
}

export interface LoggedAccessEntry extends AccessEntry {
  /** ISO time. */
  at: string
}

export interface AccessLogFs {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown
  statSync(path: string): { size: number }
  appendFileSync(path: string, data: string, options: { mode: number }): void
  renameSync(from: string, to: string): void
}

export interface AccessLogOptions {
  /** `<data>/logs/web-access.log`; undefined keeps the ring only (tests). */
  filePath?: string
  maxBytes?: number
  fs?: AccessLogFs
  now?: () => number
  log?: (message: string) => void
}

/** Drops control characters (C0, DEL, C1) and bidi overrides, trims and caps. No regexes. */
export function plainText(text: string, max = MAX_FIELD): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f) continue
    out += ch
  }
  return [...out.trim()].slice(0, max).join('')
}

export class AccessLog {
  private readonly filePath: string | undefined
  private readonly maxBytes: number
  private readonly fs: AccessLogFs
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly ring: LoggedAccessEntry[] = []
  private size: number | undefined
  private dirReady = false

  constructor(options: AccessLogOptions = {}) {
    this.filePath = options.filePath
    this.maxBytes = options.maxBytes ?? MAX_ACCESS_LOG_BYTES
    this.fs = options.fs ?? nodeFs
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((m) => console.warn(m))
  }

  /** Appends one entry. Never throws: a failed write is logged and the entry stays in the ring. */
  write(entry: AccessEntry): void {
    // Only the known fields, rebuilt: an object with extra fields (a frame, a token) passed in by
    // mistake loses them here.
    const out: LoggedAccessEntry = { at: new Date(this.now()).toISOString(), event: entry.event }
    if (entry.device !== undefined) out.device = plainText(entry.device, 40)
    if (entry.name !== undefined) out.name = plainText(entry.name)
    if (entry.detail !== undefined) out.detail = plainText(entry.detail)
    this.ring.push(out)
    if (this.ring.length > ACCESS_LOG_RING) this.ring.shift()
    if (this.filePath === undefined) return
    const line = JSON.stringify(out) + '\n'
    try {
      if (!this.dirReady) {
        this.fs.mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
        this.dirReady = true
      }
      if (this.size === undefined) {
        try {
          this.size = this.fs.statSync(this.filePath).size
        } catch {
          this.size = 0
        }
      }
      if (this.size > 0 && this.size + Buffer.byteLength(line) > this.maxBytes) {
        this.fs.renameSync(this.filePath, `${this.filePath}.1`)
        this.size = 0
      }
      this.fs.appendFileSync(this.filePath, line, { mode: 0o600 })
      this.size += Buffer.byteLength(line)
    } catch (err) {
      this.size = undefined
      this.log(`web access: cannot write the access log: ${String(err)}`)
    }
  }

  /** The latest entries, oldest first. */
  recent(): LoggedAccessEntry[] {
    return this.ring.map((e) => ({ ...e }))
  }
}
