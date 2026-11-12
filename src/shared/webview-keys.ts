// The keys a server's browser view may send to a streamed webview (`webviews.input`,
// design-web-browser.md §4.1; plan 20261111-streamed-webviews.md Task 7), as one table both sides
// read: the browser forwards only what is here (web/webview-canvas.tsx), main refuses anything else
// (main/webview/webview-input.ts). Keys are named by the DOM's `KeyboardEvent.key` and mapped to
// the `keyCode` names Electron's `webContents.sendInputEvent` takes.
//
// What is not here is not a key the page gets from a browser: a lone modifier (the page reads the
// modifiers off each event), a dead key or an IME's `Process`, a non-ASCII character (text goes
// through the hidden textarea and `insertText`, Task 8), media and browser keys, F13 and up.
//
// Checked headless (Electron 45.1.0, off-screen window, 2026-11-11): a single printable ASCII
// character as `keyCode` gives the page that `key` with its US-layout `code` (`!` → Digit1 with
// Shift set, `"` → Quote with Shift, `+` → Equal with Shift); a letter's case comes from the
// `shift` modifier ('A' without it is key 'a'), so the browser's modifiers are passed on as they
// are. Named keys: `Up` gives ArrowUp, `Enter` and `Return` both Enter.
//
// A Map, never a plain object: the key name is untrusted text (`constructor`, `__proto__`).

/** Named keys (DOM `key`) and Electron's keyCode for each. */
const NAMED: ReadonlyMap<string, string> = new Map([
  ['Enter', 'Enter'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Escape', 'Escape'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  [' ', 'Space'],
  ...Array.from({ length: 12 }, (_, i): [string, string] => [`F${i + 1}`, `F${i + 1}`])
])

/** Longest DOM key name in the table (`ArrowRight`): a longer string is no key, unread. */
export const MAX_KEY_NAME_LENGTH = 10

/** Whether `key` is one printable ASCII character other than space (letters, digits, punctuation). */
export function isPrintableKey(key: string): boolean {
  if (key.length !== 1) return false
  const c = key.charCodeAt(0)
  return c >= 0x21 && c <= 0x7e
}

/** Electron's sendInputEvent keyCode for a DOM key name, or undefined: not a key a page gets. */
export function webviewKeyCode(key: unknown): string | undefined {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_NAME_LENGTH) return undefined
  if (isPrintableKey(key)) return key
  return NAMED.get(key)
}

/**
 * The text a key down also types, as Chromium wants it: a `char` event after the `keyDown`
 * (`sendInputEvent` sends a raw key down, which inserts nothing by itself). A printable key and
 * Space type themselves, Enter types '\r' (without it a textarea gets no newline and a form is not
 * submitted, checked headless). None while Ctrl, Meta or Alt is down: those are shortcuts (Ctrl+A
 * selects, it does not type an 'a'), and AltGr text arrives as its own character. Undefined: no
 * char event.
 */
export function webviewKeyChar(key: string, mods: { control: boolean; meta: boolean; alt: boolean }): string | undefined {
  if (mods.control || mods.meta || mods.alt) return undefined
  if (isPrintableKey(key) || key === ' ') return key
  if (key === 'Enter') return '\r'
  return undefined
}

/**
 * Chromium's cursor type names (`cursor-changed`) → the CSS `cursor` a browser view shows over the
 * canvas. Fixed: the page names the type, the browser only ever gets one of these values. Note that
 * Chromium's `pointer` is the plain arrow and `hand` the link hand. A custom image cursor (`custom`)
 * and anything unknown show the arrow.
 */
const CURSORS: ReadonlyMap<string, string> = new Map([
  ['default', 'default'],
  ['pointer', 'default'],
  ['null', 'default'],
  ['custom', 'default'],
  ['hand', 'pointer'],
  ['crosshair', 'crosshair'],
  ['text', 'text'],
  ['vertical-text', 'vertical-text'],
  ['wait', 'wait'],
  ['progress', 'progress'],
  ['help', 'help'],
  ['move', 'move'],
  ['cell', 'cell'],
  ['context-menu', 'context-menu'],
  ['alias', 'alias'],
  ['copy', 'copy'],
  ['none', 'none'],
  ['nodrop', 'no-drop'],
  ['not-allowed', 'not-allowed'],
  ['zoom-in', 'zoom-in'],
  ['zoom-out', 'zoom-out'],
  ['grab', 'grab'],
  ['grabbing', 'grabbing'],
  ['e-resize', 'e-resize'],
  ['n-resize', 'n-resize'],
  ['ne-resize', 'ne-resize'],
  ['nw-resize', 'nw-resize'],
  ['s-resize', 's-resize'],
  ['se-resize', 'se-resize'],
  ['sw-resize', 'sw-resize'],
  ['w-resize', 'w-resize'],
  ['ns-resize', 'ns-resize'],
  ['ew-resize', 'ew-resize'],
  ['nesw-resize', 'nesw-resize'],
  ['nwse-resize', 'nwse-resize'],
  ['col-resize', 'col-resize'],
  ['row-resize', 'row-resize'],
  ['ns-no-resize', 'not-allowed'],
  ['ew-no-resize', 'not-allowed'],
  ['nesw-no-resize', 'not-allowed'],
  ['nwse-no-resize', 'not-allowed'],
  ['m-panning', 'all-scroll'],
  ['e-panning', 'all-scroll'],
  ['n-panning', 'all-scroll'],
  ['ne-panning', 'all-scroll'],
  ['nw-panning', 'all-scroll'],
  ['s-panning', 'all-scroll'],
  ['se-panning', 'all-scroll'],
  ['sw-panning', 'all-scroll'],
  ['w-panning', 'all-scroll'],
  ['drag-drop-none', 'no-drop'],
  ['drag-drop-move', 'move'],
  ['drag-drop-copy', 'copy'],
  ['drag-drop-link', 'alias']
])

/** Every CSS value `webviewCursor` can give (the browser applies nothing else). */
export const WEBVIEW_CURSORS: ReadonlySet<string> = new Set(CURSORS.values())

/** The CSS cursor for a Chromium cursor type; the arrow for anything unknown. */
export function webviewCursor(type: unknown): string {
  return (typeof type === 'string' ? CURSORS.get(type) : undefined) ?? 'default'
}
