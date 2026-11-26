// The Notes API's caps (shared/design.md §3, spec-review S2/S4): one leaf with no imports, read by main (the
// authority: notes-service refuses past a cap, never cuts), the overlay spec's check (overlay-buttons.ts) and the
// page SDK (a fast refusal before the round trip). A leaf like overlay-message.ts, so panel.js's own IIFE build can
// take it in without a shared chunk (electron.vite.config.ts).

/** Notes per (project, plugin, key). An add past it is refused. */
export const MAX_NOTES = 200
/** One note's text, in characters (UTF-16 code units, as `String.length`). */
export const MAX_NOTE_TEXT = 4000
/** The note for Claude (the store's `global`). */
export const MAX_GLOBAL_NOTE = 4000
/** A note's quote: the selection it is on. The note text's cap, so a quote never outweighs the store. */
export const MAX_NOTE_QUOTE = 4000
/** A note's `anchor` (opaque JSON only the page reads), as characters of JSON. */
export const MAX_NOTE_ANCHOR_JSON = 2048
/**
 * One key's whole store as JSON (the Reviewer's draft cap, reviewer lib/review.js:23-26): under ctx.storage's 1 MiB
 * value and the 1,040,384-character page message, so the connect-time list always fits one message.
 */
export const MAX_NOTES_JSON = 400_000
/** Keys per (project, plugin): an add under a new key past it is refused (spec-review S4). */
export const MAX_NOTES_KEYS = 1000
/** A notes key (`notes: { key }` in an overlay spec, `ctx.notes(key)`): 1 to this many characters. */
export const MAX_NOTES_KEY = 200

/**
 * The key's characters: the Reviewer's annotate keys (ANNOTATE_KEY_CHARS, reviewer lib/review.js:43), a plain set
 * with no spaces, quotes or controls, so a key reads cleanly in a log line and a Discuss header (the store hashes it for the file name).
 */
const NOTES_KEY_CHARS = /^[A-Za-z0-9._:@#+=~/-]+$/

/** A notes key as `notes: { key }` and `ctx.notes(key)` take it; anything else (a non-string included) is false. */
export function isNotesKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NOTES_KEY && NOTES_KEY_CHARS.test(value)
}
