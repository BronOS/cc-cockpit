// The person-given name of a Claude tab (ctx.sessions.rename, the tab's Rename menu entry): shown
// instead of the topic Claude Code put in the terminal title, kept over a restore. One rule for
// the host, main (the authority) and the restore plan, since the saved record is user-writable.

export const MAX_SESSION_NAME_CHARS = 60

/** C0 and C1 control characters and DEL: a name is one line of plain text (a NUL or ESC could rewrite what the tab strip shows). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export type SessionNameCheck = { ok: true; value: string | null } | { ok: false; reason: string }

/** `null` (or undefined) clears the name; a string is trimmed and must be 1-60 characters without control characters. */
export function checkSessionName(raw: unknown): SessionNameCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, reason: 'name must be a string or null' }
  if (CONTROL.test(raw)) return { ok: false, reason: 'name may not contain control characters' }
  const value = raw.trim()
  if (value === '') return { ok: false, reason: 'name must not be empty (null clears it)' }
  if ([...value].length > MAX_SESSION_NAME_CHARS) {
    return { ok: false, reason: `name is longer than ${MAX_SESSION_NAME_CHARS} characters` }
  }
  return { ok: true, value }
}
