// The words of a room (design-rooms.md §1, §3): a member's name, the room's title and the parts of
// a doc path. One rule for the registry (names, titles), the docs store (path parts) and the saved tab
// record (tab-room.ts; here in shared for that reason, the renderer reads it too), since the
// fence (`[cockpit room "<title>" <nonce>] from <name> ...`) and the doc paths are built from them.
import { CONTROL } from './session-name'

/** Names a member may not take: `all` is the send-to-everyone word, the rest would read as someone other than a member in a fence header. */
const RESERVED_ROOM_NAMES: readonly string[] = Object.freeze(['all', 'plugin', 'person', 'user', 'system'])

/**
 * A member name: a lower-case letter then up to 30 of `[a-z0-9-]`, and none of the reserved names. One anchored
 * pattern (the reserved names in its lookahead) so no caller can check the shape and forget the list. Linear: no
 * nested quantifier.
 */
export const ROOM_NAME = /^(?!(?:all|plugin|person|user|system)$)[a-z][a-z0-9-]{0,30}$/

/** The longest title, in characters (code points): one line in the room view and in every fence header. */
const MAX_ROOM_TITLE_CHARS = 60

/**
 * Characters a title may not hold besides CONTROL's (control, bidi, invisible): quotes, because the fence puts the
 * title inside `"..."`, and brackets, because a fence header is `[cockpit room ...]`; a title with either could fake
 * the end of the header. Typographic quotes and angle quotes too, since they read the same to a model.
 */
const TITLE_FORBIDDEN = new Set([...'"\'`“”„‟‘’‚‛«»‹›()[]{}<>'])

/** The longest doc path part, in characters: under NAME_MAX (255) with room for the store's `.tmp-<rand>` suffix. */
const MAX_PATH_PART_CHARS = 128

export type RoomWordCheck = { ok: true; value: string } | { ok: false; reason: string }

export function isRoomName(value: unknown): value is string {
  return typeof value === 'string' && ROOM_NAME.test(value)
}

/** A member name, unchanged (no trimming or case folding: the name a member is told is the one it typed). */
export function checkRoomName(raw: unknown): RoomWordCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'name must be a string' }
  if (RESERVED_ROOM_NAMES.includes(raw)) return { ok: false, reason: `name "${raw}" is reserved` }
  if (!ROOM_NAME.test(raw)) {
    return { ok: false, reason: 'name must be a lower-case letter then up to 30 of a-z, 0-9 and -' }
  }
  return { ok: true, value: raw }
}

/** A title: trimmed, 1-60 characters, each checked on its own (no control, bidi, invisible, quote or bracket character). */
export function checkRoomTitle(raw: unknown): RoomWordCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'title must be a string' }
  for (const ch of raw) {
    if (CONTROL.test(ch)) return { ok: false, reason: 'title may not contain control, bidi or invisible format characters' }
    if (TITLE_FORBIDDEN.has(ch)) return { ok: false, reason: 'title may not contain quote or bracket characters' }
  }
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'title must not be empty' }
  if ([...value].length > MAX_ROOM_TITLE_CHARS) {
    return { ok: false, reason: `title is longer than ${MAX_ROOM_TITLE_CHARS} characters` }
  }
  return { ok: true, value }
}

/** One character of a doc path part: ASCII letters, digits, `.`, `_` and `-` (design-rooms.md §3), checked without a regex. */
export function isPathPartChar(ch: string): boolean {
  if (ch.length !== 1) return false
  const c = ch.charCodeAt(0)
  return (
    (c >= 0x30 && c <= 0x39) || // 0-9
    (c >= 0x41 && c <= 0x5a) || // A-Z
    (c >= 0x61 && c <= 0x7a) || // a-z
    ch === '.' ||
    ch === '_' ||
    ch === '-'
  )
}

/** A doc path part: 1-128 of the part characters, never `.` or `..` (no way out of the store). */
export function isPathPart(part: unknown): part is string {
  if (typeof part !== 'string' || part === '' || part === '.' || part === '..') return false
  if (part.length > MAX_PATH_PART_CHARS) return false
  for (const ch of part) if (!isPathPartChar(ch)) return false
  return true
}

/**
 * The most characters an id a caller hands in may have (a room id, a read's ack, a tab id) before it is junk rather than
 * an id to look up: a cut-off before any lookup or error text, not the id's shape (isRoomId is that, for a room id).
 */
export const MAX_ID_CHARS = 64

/**
 * A room id's shape (`randomUUID`, lower case): the registry checks it before joining an id into a path, and the saved
 * tab record (tab-room.ts) before keeping a membership. No regex, like the path parts.
 */
export function isRoomId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 36) return false
  for (let i = 0; i < 36; i++) {
    const ch = value[i] as string
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (ch !== '-') return false
    } else if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false
  }
  return true
}
