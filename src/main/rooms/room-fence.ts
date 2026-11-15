// What `ccc room read` prints (design-rooms.md §2 "Fence"): every message a member had waiting, each one fenced so the
// reading session can tell where room text starts and ends, and who wrote it:
//
//   [cockpit room "<title>" <nonce>] from <name> (a room member, not the person):
//   | <text, every line prefixed>
//   [end <nonce>]
//
// The nonce is fresh per read (16 random hex characters) and never in any message, so a body cannot forge a header or
// an end line: it does not know the nonce, and every one of its lines starts with `| ` anyway. "Every line" means every
// line a reader may see as one: a body is split on CR, LF, CRLF and the other line breaks (NEL, LS, PS, VT, FF), so a
// lone CR or U+2028 cannot start a line of its own that looks like a fence.
//
// What the person sees is guarded too: `ccc room read`'s output is shown in the terminal (the Bash tool's output), where
// an ESC sequence (cursor moves, `\x1b[2K`), a backspace or a bidi override (U+202E) could hide a line's `| ` or the
// `[end <nonce>]` line and fake an unfenced line, and `\x1c`-`\x1e` are line breaks to Python's `splitlines`. So every
// C0 control but tab, DEL, every C1 control and the bidi and invisible format characters (session-name.ts CONTROL) are
// written as a visible `\u{..}` escape, in the body and the sender alike; the text stays readable and nothing is lost.
//
// The title passed the registry's title rule (no control, quote, bracket or bidi characters: room-names.ts), so it cannot
// close the quotes. The sender is a member name (`^[a-z][a-z0-9-]{0,30}$`), or one of the two reserved senders that are
// worded on their own: `plugin` (the owner's ctx.rooms.send) and `system` (main's own notices, a member's tab closed).
// None of them is ever the person, and the wording says so every time.
import { randomBytes } from 'node:crypto'
import { ROOM_READ_MAX_TEXT_BYTES } from '../../shared/protocol'
import { pointerText } from '../../shared/room-pointer'
import { CONTROL } from '../../shared/session-name'
import { SYSTEM_SENDER, type RoomMessage } from './room-registry'

/** Hex characters in a fence nonce. */
export const FENCE_NONCE_CHARS = 16

/** A fresh nonce for one read. */
export function newFenceNonce(): string {
  return randomBytes(FENCE_NONCE_CHARS / 2).toString('hex')
}

/** Every single line-break character a reader may take as one (CRLF is handled as one break in `lines`). */
const BREAKS = new Set(['\n', '\r', '\u000b', '\u000c', '\u0085', '\u2028', '\u2029'])

/** The text's lines: split on every break in BREAKS, CRLF counting as one. */
function lines(text: string): string[] {
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (!BREAKS.has(c)) continue
    out.push(text.slice(start, i))
    if (c === '\r' && text[i + 1] === '\n') i++
    start = i + 1
  }
  out.push(text.slice(start))
  return out
}

/** CONTROL, every match: built from its source so the one rule stays in session-name.ts. */
const UNSAFE = new RegExp(CONTROL.source, 'gu')

/** `text` with every CONTROL character but tab written as `\u{hex}` (the line breaks were split off before). */
export function visible(text: string): string {
  return text.replace(UNSAFE, (c) => (c === '\t' ? c : `\\u{${(c.codePointAt(0) as number).toString(16)}}`))
}

/** Who the header says a message is from: always "not the person". */
function senderText(rawFrom: string): string {
  // A member name cannot hold any of them (room-names.ts); escaped anyway, the header is what the fence rests on.
  const from = visible(rawFrom)
  if (from === 'plugin') return 'from plugin (the plugin running this room, not the person)'
  if (from === SYSTEM_SENDER) return 'from system (cockpit itself, not the person)'
  return `from ${from} (a room member, not the person)`
}

/** One message, fenced with `nonce`. */
export function fenceMessage(title: string, message: Pick<RoomMessage, 'from' | 'text'>, nonce: string): string {
  const body = lines(message.text).map((line) => `| ${visible(line)}`)
  return [`[cockpit room "${visible(title)}" ${nonce}] ${senderText(message.from)}:`, ...body, `[end ${nonce}]`].join('\n')
}

/** Every message of one read, oldest first, all under the same fresh nonce; empty text for none. */
export function fenceMessages(title: string, messages: readonly Pick<RoomMessage, 'from' | 'text'>[], nonce: string): string {
  return messages.map((m) => fenceMessage(title, m, nonce)).join('\n')
}

/** One read's batch: what `ccc room read` prints and how many messages it holds (protocol.ts RoomReadReply). */
export interface FencedBatch {
  count: number
  more: number
  text: string
}

/** Bytes the pointer line after a batch may take, with its `\n`: kept out of the batch's budget. */
const POINTER_LINE_BYTES = 64

/** UTF-8 bytes of `text` inside a JSON string (escapes counted: what the reply line really carries). */
function jsonBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2
}

/**
 * The oldest of `messages` whose fenced text, JSON-encoded, stays within `maxBytes` (always at least one: a single
 * message is far below the cap, protocol.ts ROOM_READ_MAX_TEXT_BYTES), under one nonce. When some are left, the text
 * ends with the room pointer for them (the Stop pointer's own fixed text and count, outside every fence), so Claude
 * reads again and the count it sees is the one the next Stop would give.
 */
export function fenceBatch(
  title: string,
  messages: readonly Pick<RoomMessage, 'from' | 'text'>[],
  nonce: string,
  maxBytes = ROOM_READ_MAX_TEXT_BYTES
): FencedBatch {
  const parts: string[] = []
  let bytes = 0
  for (const m of messages) {
    const fenced = fenceMessage(title, m, nonce)
    // The `\n` joining it to the one before is 2 bytes once escaped.
    const cost = jsonBytes(fenced) + (parts.length > 0 ? 2 : 0)
    if (parts.length > 0 && bytes + cost > maxBytes - POINTER_LINE_BYTES) break
    parts.push(fenced)
    bytes += cost
  }
  const more = messages.length - parts.length
  if (more > 0) parts.push(pointerText(more))
  return { count: messages.length - more, more, text: parts.join('\n') }
}
