// How many changed files each session lists in the Sessions panel before the rest go behind a
// "Show all" button (app setting `sessionFilesShown`). Shared by main (which validates and applies the
// default) and the renderer (its default before main answers, and the settings field's range).
export const SESSION_FILES_SHOWN_DEFAULT = 10
export const SESSION_FILES_SHOWN_RANGE = { min: 1, max: 500 } as const

/**
 * The stored `sessionFilesShown`, default applied: an integer in range, else the default. app.json
 * is user-writable, so a damaged value (`"10"`, 0, 2.5) reads as the default, never as "show none".
 */
export function sessionFilesShownOf(stored: unknown): number {
  return typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= SESSION_FILES_SHOWN_RANGE.min &&
    stored <= SESSION_FILES_SHOWN_RANGE.max
    ? stored
    : SESSION_FILES_SHOWN_DEFAULT
}
