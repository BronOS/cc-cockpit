// Auto-hiding the side zones when the terminal gets narrow (app settings `zoneAutoHide` and
// `minTerminalWidth`, design §4 "Auto-hide"). Shared by main (which validates and applies the
// defaults) and the renderer (its defaults before main answers, and the settings field's range).
// The decision itself is the renderer's (renderer/zones/auto-hide.ts): it needs the window's width.

/** On unless app.json says exactly `false`. */
export const ZONE_AUTO_HIDE_DEFAULT = true
/** The terminal's minimum width in CSS px before a side zone gives way. */
export const MIN_TERMINAL_WIDTH_DEFAULT = 720
/**
 * 400 is about 50 columns at the default font, the least a Claude prompt is usable at; 2000 is
 * wider than most displays (a minimum above the window's width just keeps both zones hidden).
 */
export const MIN_TERMINAL_WIDTH_RANGE = { min: 400, max: 2000 } as const

/**
 * The stored `zoneAutoHide`, default applied: only an explicit `false` turns it off. A damaged value
 * (`"no"`, 0) reads as the default, like `claudeTabOnOpen`: a wrong "on" hides a zone the person
 * can bring back with one click.
 */
export function zoneAutoHideOf(stored: unknown): boolean {
  return stored !== false
}

/**
 * The stored `minTerminalWidth`, default applied: an integer in range, else the default. app.json is
 * user-writable, so a damaged value (`"720"`, 0, 2.5) reads as 720, never as "hide at any width".
 */
export function minTerminalWidthOf(stored: unknown): number {
  return typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= MIN_TERMINAL_WIDTH_RANGE.min &&
    stored <= MIN_TERMINAL_WIDTH_RANGE.max
    ? stored
    : MIN_TERMINAL_WIDTH_DEFAULT
}
