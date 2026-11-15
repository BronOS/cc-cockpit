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
// The title passed the registry's title rule (no control, quote, bracket or bidi characters: room-names.ts), so it cannot
// close the quotes. The sender is a member name (`^[a-z][a-z0-9-]{0,30}$`), or one of the two reserved senders that are
// worded on their own: `plugin` (the owner's ctx.rooms.send) and `system` (main's own notices, a member's tab closed).
// None of them is ever the person, and the wording says so every time.
import { randomBytes } from 'node:crypto'
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

/** Who the header says a message is from: always "not the person". */
function senderText(from: string): string {
  if (from === 'plugin') return 'from plugin (the plugin running this room, not the person)'
  if (from === SYSTEM_SENDER) return 'from system (cockpit itself, not the person)'
  return `from ${from} (a room member, not the person)`
}

/** One message, fenced with `nonce`. */
export function fenceMessage(title: string, message: Pick<RoomMessage, 'from' | 'text'>, nonce: string): string {
  const body = lines(message.text).map((line) => `| ${line}`)
  return [`[cockpit room "${title}" ${nonce}] ${senderText(message.from)}:`, ...body, `[end ${nonce}]`].join('\n')
}

/** Every message of one read, oldest first, all under the same fresh nonce; empty text for none. */
export function fenceMessages(title: string, messages: readonly Pick<RoomMessage, 'from' | 'text'>[], nonce: string): string {
  return messages.map((m) => fenceMessage(title, m, nonce)).join('\n')
}
