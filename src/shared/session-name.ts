// The person-given name of a Claude tab (ctx.sessions.rename, the tab's Rename menu entry): shown
// instead of the topic Claude Code put in the terminal title, kept over a restore. One rule for
// the host, main (the authority) and the restore plan, since the saved record is user-writable.

export const MAX_SESSION_NAME_CHARS = 60

/**
 * C0 and C1 control characters and DEL: a name is one line of plain text (a NUL or ESC could
 * rewrite what the tab strip shows). Also the line and paragraph separators (U+2028/2029, a second
 * line), the bidi marks, embeddings, overrides and isolates (U+061C, U+200E/200F, U+202A-202E,
 * U+2066-2069: a plugin could show a reversed, spoofed label) and the invisible zero-width space,
 * word joiner, invisible operators and BOM (U+200B, U+2060-2064, U+FEFF). Not all of \p{Cf}: ZWNJ
 * and ZWJ (U+200C/200D) are part of Persian and Indic words and of emoji sequences, and the tag
 * characters of subdivision flags; neither reorders nor hides the rest of the label.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/

export type SessionNameCheck = { ok: true; value: string | null } | { ok: false; reason: string }

/** `null` (or undefined) clears the name; a string is trimmed and must be 1-60 characters without control, bidi or invisible format characters. */
export function checkSessionName(raw: unknown): SessionNameCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'name must be a string or null' }
  if (CONTROL.test(raw)) return { ok: false, reason: 'name may not contain control, bidi or invisible format characters' }
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'name must not be empty (null clears it)' }
  if ([...value].length > MAX_SESSION_NAME_CHARS) {
    return { ok: false, reason: `name is longer than ${MAX_SESSION_NAME_CHARS} characters` }
  }
  return { ok: true, value }
}
