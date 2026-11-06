// A tab's flag: the person marks the tab they must come back to while Claude works in many
// others. `{ color, note? }`, on any tab kind (Claude, shell, command), sticky until cleared and
// saved with the tab (TabRecord.flag, restore.ts). main owns it: only the person sets it, through
// the shell renderer's `tabs.flag` / `tabs.toggleFlag` IPC, which main scopes to the sender's own
// project's tabs; no plugin API writes it (plugins only read SessionInfo.flag). One rule for main,
// the renderer and the restore plan, since the saved record is user-writable.
import { CONTROL } from './session-name'

/**
 * Six named colours, theme tokens `--cc-flag-<name>` (src/themes/*.json). Fewer than the project
 * palette on purpose: a flag must be picked at a glance from one menu row, and teal/grey read too
 * close to blue and to "no flag" on a tab strip.
 */
export const FLAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const

export type FlagColor = (typeof FLAG_COLORS)[number]

/** A flag as main stores it and every surface reads it. `note` is present only when non-empty. */
export interface TabFlag {
  color: FlagColor
  note?: string
}

/** What the tab menu calls each colour ("Flag: Red"). */
export const FLAG_COLOR_LABEL: Readonly<Record<FlagColor, string>> = Object.freeze({
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple'
})

/** The longest note, in characters (code points): a reminder, shown as a tooltip and in a menu row. */
export const MAX_FLAG_NOTE_CHARS = 80

/** The colour a fresh toggle uses before the person ever picked one. */
export const DEFAULT_FLAG_COLOR: FlagColor = 'red'

/** The command that toggles the current tab's flag (CORE_COMMANDS in command-registry.ts). */
export const TOGGLE_FLAG_COMMAND = 'tab.toggleFlag'

export function isFlagColor(value: unknown): value is FlagColor {
  return typeof value === 'string' && (FLAG_COLORS as readonly string[]).includes(value)
}

/** The CSS value of a flag colour: its theme token, so a theme switch re-colours every stripe. */
export function flagColorCss(color: FlagColor): string {
  return `var(--cc-flag-${color})`
}

// Line breaks, tabs and the Unicode line/paragraph separators become a space (a pasted two-line
// reminder still reads as words); every other control, bidi or invisible character is dropped, as
// a session name refuses them (session-name.ts CONTROL says why each is dangerous in a label).
const SPACE_LIKE = /[\t\n\v\f\r\u0085\u2028\u2029]/g
const STRIP = new RegExp(CONTROL.source, 'g')

/**
 * A note as stored: control characters stripped, whitespace runs folded to one space, trimmed.
 * Stripped rather than refused (a session name is refused): a note is typed or pasted in one go
 * into a small field, and a stray newline from a paste should not cost the person the note.
 */
export function cleanFlagNote(raw: string): string {
  return raw.replace(SPACE_LIKE, ' ').replace(STRIP, '').replace(/ {2,}/g, ' ').trim()
}

/**
 * What the renderer asks for (`tabs.flag`): a colour, a note, or both. A missing `color` keeps
 * the tab's colour (or takes the last-used one for an unflagged tab: "Edit note…" on a tab with
 * no flag flags it); a missing `note` keeps the tab's note, `null` or `''` removes it.
 */
export interface FlagPatch {
  color?: FlagColor
  note?: string | null
}

export type FlagPatchCheck = { ok: true; value: FlagPatch | null } | { ok: false; reason: string }

/**
 * Checks a `tabs.flag` payload strictly: renderer input, never trusted to match the declared type.
 * `null` clears the flag. Only `color` and `note` are read; anything else riding along is ignored.
 */
export function checkFlagPatch(raw: unknown): FlagPatchCheck {
  if (raw === null) return { ok: true, value: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'flag must be an object or null' }
  const { color, note } = raw as Record<string, unknown>
  const out: FlagPatch = {}
  if (color !== undefined) {
    if (!isFlagColor(color)) return { ok: false, reason: `flag color must be one of ${FLAG_COLORS.join(', ')}` }
    out.color = color
  }
  if (note !== undefined) {
    if (note !== null && typeof note !== 'string') return { ok: false, reason: 'flag note must be a string or null' }
    const text = note === null ? '' : cleanFlagNote(note)
    if ([...text].length > MAX_FLAG_NOTE_CHARS) {
      return { ok: false, reason: `flag note is longer than ${MAX_FLAG_NOTE_CHARS} characters` }
    }
    out.note = text === '' ? null : text
  }
  return { ok: true, value: out }
}

/** The flag after a checked patch (see FlagPatch for what a missing field keeps). */
export function applyFlagPatch(current: TabFlag | undefined, patch: FlagPatch, lastColor: FlagColor): TabFlag {
  const color = patch.color ?? current?.color ?? lastColor
  const note = patch.note === undefined ? current?.note : (patch.note ?? undefined)
  return note === undefined ? { color } : { color, note }
}

/**
 * A saved flag (TabRecord.flag), read leniently: the projects file is user-writable, so a damaged
 * value reads as no flag rather than failing the tab, and a damaged note costs only the note. The
 * note goes through the same cleaning as a typed one.
 */
export function tabFlagOf(raw: unknown): TabFlag | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { color, note } = raw as Record<string, unknown>
  if (!isFlagColor(color)) return undefined
  if (typeof note !== 'string') return { color }
  const text = cleanFlagNote(note)
  return text === '' || [...text].length > MAX_FLAG_NOTE_CHARS ? { color } : { color, note: text }
}

/** Two flags (or none) say the same: what the tab manager compares before reporting a change. */
export function sameFlag(a: TabFlag | undefined, b: TabFlag | undefined): boolean {
  return a?.color === b?.color && a?.note === b?.note
}
