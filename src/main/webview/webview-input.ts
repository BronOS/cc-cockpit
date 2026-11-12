// Pointer, wheel and keys from a server's browser view into its streamed webview
// (`webviews.input`, design-web-browser.md §4.1, §5; plan 20261111-streamed-webviews.md Task 7).
//
// The browser draws the off-screen page on a canvas and sends what the person does over it, in
// the page's CSS px (the browser undid its letterbox and the frame's scale, web/webview-stream.ts).
// Everything here is untrusted text from a socket, and what comes out is *trusted* input to a page
// (`webContents.sendInputEvent`: a click the page cannot tell from a real one), so:
//
//   who        only a current viewer of the panel (webview-viewers.ts): a browser view of the panel's
//              own window that shows it now. The router resolved the panel key through the caller's
//              own window's layout and passes main's view id, never the payload's.
//   what       ≤ MAX_INPUT_EVENTS per call; pointer `move|down|up` with finite x, y, a button
//              (left, middle, right) and a click count 1..3 for down and up; wheel with finite x, y
//              and deltas clamped to ±MAX_WHEEL_DELTA; key `down|up` with a DOM key name from the
//              allow-list (shared/webview-keys.ts); modifiers from MODIFIERS only. A call with
//              anything else is refused whole (a browser of ours never sends it).
//   where      a pointer or wheel outside the page's current size is dropped, the rest of the call
//              goes: right after a resize the browser may still map against one frame of the old
//              size, which is no reason to lose a button release in the same call.
//   how often  INPUT_RATE events per second per browser view, a token bucket (INPUT_BURST deep);
//              over-rate events are dropped silently. Pointer moves are coalesced per animation
//              frame in the browser, so a person never gets near it.
//   the size   a button press, a key or a wheel makes the sender the page's size owner (claimOwner;
//              §3.2, the terminal's rule); a pointer move does not (passing over a letterboxed
//              view must not resize the page under the person typing in another).
//   clipboard  a copy, cut or paste chord (Ctrl/Cmd+C, X, V, Ctrl/Shift+Insert, Shift+Delete;
//              shared/webview-keys.ts isClipboardChord) is dropped, down and up: our browser never
//              sends one (its own copy and paste events carry the text, Task 8), and the server's
//              clipboard is every page's there, so a forwarded Ctrl+V from a client of its own
//              would paste whatever another page or session left in it (review finding).
//
// Mapping (checked headless, Electron 45.1.0): mouseMove / mouseDown / mouseUp / mouseWheel /
// keyDown / keyUp / char. A wheel's deltas are negated: Chromium's wheel delta is positive
// scrolling up, the DOM's positive scrolling down. A key down that types (webviewKeyChar: a
// printable key, Space, Enter as '\r', with no Ctrl, Meta or Alt) is followed by its `char`: a raw
// key down inserts nothing. Held buttons travel as the `leftbuttondown`-style modifiers on moves,
// so a page's drag code sees `buttons` (selection by drag works without, `buttons` reads 0).
//
// Text, paste and copy (Task 8, design-web-browser.md §4.2): `webviews.insertText` carries what is
// not one key: an IME's or a dead key's composition, a non-ASCII character, AltGr text and pasted
// text (the browser's hidden textarea, web/webview-canvas.tsx), ≤ MAX_TEXT_BYTES per call, the same
// gate as `webviews.input` (a viewer, one token of the bucket per call, it claims the size). One
// printable ASCII key keeps its key down + `char` above: the page then sees exactly what a real
// keyboard gives it (keydown, keypress, input, keyup; a page's preventDefault on the keydown, a
// `/` shortcut that focuses a search box, still suppresses the char), and the browser prevents
// that key's default, so its textarea never types it a second time.
//
// The page's selection lives on the server, and a browser's `copy` event wants text at once, so
// main pushes it (`webviews.selection`) to the view whose input may have changed it: after a button
// release (a drag, a double or triple click), any key down (shift-arrows, Ctrl+A; typing and
// Backspace collapse a selection, which must not stay copyable) and inserted text, debounced by
// SELECTION_DEBOUNCE_MS, one read in flight per view and panel (a hung page holds one promise,
// not one per key), deduplicated against the last push. The read runs SELECTION_SCRIPT in
// WEBVIEW_WORLD_ID, an isolated world: the page's scripts can neither see it nor replace the
// `getSelection` it calls. What comes back is cleaned (cleanSelection): control characters but
// \n and \t stripped (a selection of them, JSON-escaped at six bytes each, could pass the socket's
// frame limit, and an oversize event closes the browser view, terminals included) and capped at
// MAX_SELECTION_BYTES of the JSON-encoded string.
//
// `<select>` popups (Task 9, design-web-browser.md §4.4, select-hit.ts): a left press is held while
// main hit-tests its point in the same isolated world; the events after it in this call and later
// calls, and inserted text, queue behind it (in order, at most MAX_HELD_EVENTS) until the answer or
// HIT_TIMEOUT_MS, whichever is first (text typed right after a click into a field must not land
// before the click focused it). A select: the press and its release never reach the page, the popup goes to
// this view (`webviews.select`) and its answer (`acceptChoice`) sets the value. Anything else, a
// failed hit-test or one too slow: the press goes, then what queued, as if nothing had waited.
//
// Order (design-web-browser.md §4.2): everything one browser view sends for one panel (pointer,
// wheel, keys, inserted text, select choices) reaches the page in the order the person produced
// it, through one lane per view and panel (PressLane) shared by the three channels. The browser
// sends them in that order (web/webview-stream.ts InputQueue); main keeps it. Input events and text
// take different roads into the page, though: `sendInputEvent` goes through the widget's input
// pipe and the renderer's input queue, while a text or a choice is a separate call whose own
// promise says when the page has it. The e2e typing 'héllo ü' got "hlélo ü" and "éhllo ü" about one
// run in ten with main's calls in the right order (logged): Electron's `webContents.insertText` is
// an IPC to the renderer that a key sent just before or after it can overtake. So the view inserts
// text on the input pipe itself (electron-offscreen-webview.ts: the protocol's `Input.insertText`,
// queued behind the keys already sent), and the lane holds what comes after a text or a choice
// until its promise settles (PAGE_WAIT_MS at most: a hung page must not hold the person's input
// forever), so nothing sent later can pass it either.
//
// Pure: no Electron (the view's sendInput, insertText, readSelection, hitSelect and chooseSelect
// are injected), clock, timers and popup ids injected.

import { isPlainObject } from '../../shared/guards'
import type { IpcEventMap, WebviewInputModifier } from '../../shared/ipc'
import { isClipboardChord, MAX_KEY_NAME_LENGTH, webviewCursor, webviewKeyChar, webviewKeyCode } from '../../shared/webview-keys'
import type { ViewId } from '../../shared/views'
import type { PlaceSize, WebviewPanelOf } from './webview-viewers'
import { HIT_TIMEOUT_MS, MAX_HELD_EVENTS, MAX_SELECT_OPTIONS, newSelectId, parseHitResult, SelectPopups } from './select-hit'

/** Most events one `webviews.input` call may carry. */
export const MAX_INPUT_EVENTS = 64
/** Events per second per browser view (design-web-browser.md §5). */
export const INPUT_RATE = 600
/** The bucket's depth: a second's worth, so a burst (a fast drag after a pause) is not cut. */
export const INPUT_BURST = INPUT_RATE
/** Largest wheel delta per event, CSS px either way (the browser turns lines and pages into px). */
export const MAX_WHEEL_DELTA = 2000
/** Largest coordinate that can be inside any page (webview-viewers.ts MAX_PLACE_SIDE). */
const MAX_COORDINATE = 4096
/** Most UTF-8 bytes one `webviews.insertText` call may carry (design-web-browser.md §5). */
export const MAX_TEXT_BYTES = 64 * 1024
/**
 * Most bytes of a pushed selection, counted as the JSON-encoded string the event frame carries
 * (escapes included), so the frame stays far under MAX_FRAME_BYTES (4 MiB, web-protocol.ts) whatever
 * the page selected.
 */
export const MAX_SELECTION_BYTES = 256 * 1024
/**
 * Most UTF-16 units the selection script returns: the text is cut in the page's world before it
 * crosses to main (a 50 MB selection is never copied whole); never fewer than MAX_SELECTION_BYTES
 * can hold (a unit is at least one byte).
 */
export const MAX_SELECTION_CHARS = MAX_SELECTION_BYTES
/** Quiet time after the last selection-changing input before main reads the selection. */
export const SELECTION_DEBOUNCE_MS = 100
/**
 * The isolated world main reads a streamed page in (`executeJavaScriptInIsolatedWorld`; Task 9's
 * select hit-test uses it too). Fixed and unlike Electron's own: 0 is the page's main world and 999
 * the world of Electron's contextIsolation preloads (none in a webview, but never shared).
 */
export const WEBVIEW_WORLD_ID = 1717
/**
 * The longest the lane holds later input behind a text or a select choice the page has not
 * confirmed yet (usually a few ms): after that the rest goes, so a hung page costs order, not input.
 */
export const PAGE_WAIT_MS = 500

/**
 * The selection script, run in WEBVIEW_WORLD_ID (fresh globals, the page's DOM): the selected slice
 * of a focused text field (walking into open shadow roots), never anything of a password field, else
 * the document's selection; cut to MAX_SELECTION_CHARS here, before it crosses. Fields whose type
 * has no selection API (email, number) throw on `selectionStart` and fall back to the document's
 * selection, which Chromium keeps empty for a password field anyway.
 */
export const SELECTION_SCRIPT = `(() => {
  const cap = ${MAX_SELECTION_CHARS};
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  const tag = el && typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' && String(el.type).toLowerCase() === 'password') return '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    try {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number') {
        return end > start ? String(el.value).slice(start, Math.min(end, start + cap)) : '';
      }
    } catch (e) {}
  }
  const selection = getSelection();
  return selection ? String(selection).slice(0, cap) : '';
})()`

/** The modifiers a browser may name (Electron's names). */
export const MODIFIERS = [
  'shift',
  'control',
  'alt',
  'meta',
  'leftbuttondown',
  'middlebuttondown',
  'rightbuttondown',
  'isautorepeat'
] as const satisfies readonly WebviewInputModifier[]
export type InputModifier = (typeof MODIFIERS)[number]
const MODIFIER_SET: ReadonlySet<string> = new Set(MODIFIERS)

export type PointerButton = 'left' | 'middle' | 'right'

/** One checked event, as the browser described it (page CSS px, DOM key names, DOM wheel sign). */
export type WebviewInputEvent =
  | { kind: 'pointer'; type: 'move'; x: number; y: number; modifiers: InputModifier[] }
  | { kind: 'pointer'; type: 'down' | 'up'; x: number; y: number; button: PointerButton; clickCount: number; modifiers: InputModifier[] }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: InputModifier[] }
  | { kind: 'key'; type: 'down' | 'up'; key: string; modifiers: InputModifier[] }

/** What goes to `webContents.sendInputEvent` (structurally Electron's MouseInputEvent & co). */
export type ElectronInputEvent =
  | { type: 'mouseMove'; x: number; y: number; modifiers: InputModifier[] }
  | { type: 'mouseDown' | 'mouseUp'; x: number; y: number; button: PointerButton; clickCount: number; modifiers: InputModifier[] }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: InputModifier[] }
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers: InputModifier[] }

function fail(message: string): never {
  throw new Error(`webviews.input: ${message}`)
}

function coordinate(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_COORDINATE) fail(`${name} must be a finite number in the page`)
  return v
}

function delta(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${name} must be a finite number`)
  return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, v))
}

function modifiersOf(v: unknown): InputModifier[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MODIFIERS.length) fail('modifiers must be a short list')
  const out: InputModifier[] = []
  for (const m of v) {
    if (typeof m !== 'string' || !MODIFIER_SET.has(m)) fail('unknown modifier')
    if (!out.includes(m as InputModifier)) out.push(m as InputModifier)
  }
  return out
}

function parseOne(raw: unknown): WebviewInputEvent {
  if (!isPlainObject(raw)) fail('an event must be an object')
  const modifiers = modifiersOf(raw.modifiers)
  if (raw.kind === 'pointer') {
    const x = coordinate(raw.x, 'x')
    const y = coordinate(raw.y, 'y')
    if (raw.type === 'move') return { kind: 'pointer', type: 'move', x, y, modifiers }
    if (raw.type !== 'down' && raw.type !== 'up') fail('a pointer event is move, down or up')
    const button = raw.button
    if (button !== 'left' && button !== 'middle' && button !== 'right') fail('button must be left, middle or right')
    const clickCount = raw.clickCount === undefined ? 1 : raw.clickCount
    if (clickCount !== 1 && clickCount !== 2 && clickCount !== 3) fail('clickCount must be 1, 2 or 3')
    return { kind: 'pointer', type: raw.type, x, y, button, clickCount, modifiers }
  }
  if (raw.kind === 'wheel') {
    return { kind: 'wheel', x: coordinate(raw.x, 'x'), y: coordinate(raw.y, 'y'), deltaX: delta(raw.deltaX, 'deltaX'), deltaY: delta(raw.deltaY, 'deltaY'), modifiers }
  }
  if (raw.kind === 'key') {
    if (raw.type !== 'down' && raw.type !== 'up') fail('a key event is down or up')
    // Length first: a huge string is not looked at any further.
    if (typeof raw.key !== 'string' || raw.key.length > MAX_KEY_NAME_LENGTH || webviewKeyCode(raw.key) === undefined) fail('unknown key')
    return { kind: 'key', type: raw.type, key: raw.key, modifiers }
  }
  fail('an event is a pointer, wheel or key event')
}

/** A call's `events`, checked whole: a list of at most MAX_INPUT_EVENTS valid events, or it throws. */
export function parseInputEvents(raw: unknown): WebviewInputEvent[] {
  if (!Array.isArray(raw)) fail('events must be a list')
  if (raw.length > MAX_INPUT_EVENTS) fail(`at most ${MAX_INPUT_EVENTS} events per call`)
  return raw.map(parseOne)
}

/** Whether an event's point is on the page (keys have none). The far edges count as inside. */
export function inPage(event: WebviewInputEvent, size: PlaceSize): boolean {
  if (event.kind === 'key') return true
  return event.x <= size.width && event.y <= size.height
}

/** Whether a key event is a clipboard chord, which never reaches the page (see the top of the file). */
export function isClipboardKeyEvent(event: WebviewInputEvent): boolean {
  if (event.kind !== 'key') return false
  const m = event.modifiers
  return isClipboardChord({
    key: event.key,
    ctrlKey: m.includes('control'),
    metaKey: m.includes('meta'),
    shiftKey: m.includes('shift'),
    altKey: m.includes('alt')
  })
}

/** Whether the event makes its sender the size owner: a press, a key or a wheel, never a move or a release. */
export function claimsOwner(event: WebviewInputEvent): boolean {
  if (event.kind === 'pointer') return event.type === 'down'
  if (event.kind === 'key') return event.type === 'down'
  return true
}

/** A point as Electron takes it: whole CSS px, on the page (the far edge is its last pixel). */
function point(v: number, side: number): number {
  return Math.max(0, Math.min(Math.max(0, side - 1), Math.round(v)))
}

/** The sendInputEvent calls for one checked event on a page of `size`. */
export function toElectronEvents(event: WebviewInputEvent, size: PlaceSize): ElectronInputEvent[] {
  const modifiers = event.modifiers
  if (event.kind === 'key') {
    const keyCode = webviewKeyCode(event.key)
    if (keyCode === undefined) return []
    if (event.type === 'up') return [{ type: 'keyUp', keyCode, modifiers }]
    const char = webviewKeyChar(event.key, {
      control: modifiers.includes('control'),
      meta: modifiers.includes('meta'),
      alt: modifiers.includes('alt')
    })
    const down: ElectronInputEvent = { type: 'keyDown', keyCode, modifiers }
    return char === undefined ? [down] : [down, { type: 'char', keyCode: char, modifiers }]
  }
  const x = point(event.x, size.width)
  const y = point(event.y, size.height)
  if (event.kind === 'wheel') {
    // The DOM's sign → Chromium's (positive deltaY scrolls up there): checked headless.
    return [{ type: 'mouseWheel', x, y, deltaX: -event.deltaX, deltaY: -event.deltaY, modifiers }]
  }
  if (event.type === 'move') return [{ type: 'mouseMove', x, y, modifiers }]
  return [{ type: event.type === 'down' ? 'mouseDown' : 'mouseUp', x, y, button: event.button, clickCount: event.clickCount, modifiers }]
}

// Control characters but \t (9) and \n (10): C0, DEL and C1. \r is turned into \n first.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// A UTF-16 surrogate without its other half (JSON.stringify escapes it as six bytes).
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Text as the page should get it: line breaks as \n, no other control character but \t. */
export function cleanText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '')
}

/** Bytes of `text` as an event frame carries it: the JSON string, quotes and escapes included. */
export function encodedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), 'utf8')
}

/**
 * The selection script's result as main pushes it: a string (anything else is no selection), cut to
 * MAX_SELECTION_CHARS again (the script's cap is main's own, but the result is still a page's
 * text), control characters stripped, lone surrogates as U+FFFD, then cut until its JSON-encoded
 * string is at most `maxBytes` (never inside a surrogate pair).
 */
export function cleanSelection(raw: unknown, maxBytes = MAX_SELECTION_BYTES): string {
  if (typeof raw !== 'string') return ''
  let text = cleanText(raw.slice(0, MAX_SELECTION_CHARS)).replace(LONE_SURROGATE, '\ufffd')
  let bytes = encodedBytes(text)
  while (bytes > maxBytes && text.length > 0) {
    // Proportional, and at least one unit shorter each time, so it ends in a few steps.
    let keep = Math.min(text.length - 1, Math.floor((text.length * maxBytes) / bytes))
    const last = text.charCodeAt(keep - 1)
    if (keep > 0 && last >= 0xd800 && last <= 0xdbff) keep--
    text = text.slice(0, keep)
    bytes = encodedBytes(text)
  }
  return text
}

/**
 * The `webviews.cursor` event for the page's `cursor-changed`: the panel's key as the browser names
 * it and a CSS cursor from the fixed table (shared/webview-keys.ts), never the page's own text.
 */
export function cursorEvent(panel: WebviewPanelOf, type: unknown): { panelKey: string; cursor: string } {
  return { panelKey: `${panel.pluginId}/${panel.panelId}`, cursor: webviewCursor(type) }
}

/** Where a panel's input goes: its off-screen page's size, its sendInputEvent, its text and selection. */
export interface InputTarget {
  size(): PlaceSize
  send(events: readonly ElectronInputEvent[]): void
  /**
   * Committed text into the page's focused field (absent: the view takes no text). A promise that
   * settles once the page has it: the lane holds later input until then.
   */
  insertText?(text: string): Promise<unknown> | void
  /** SELECTION_SCRIPT's result in WEBVIEW_WORLD_ID; rejects or never settles for a page that is gone or hung. */
  readSelection?(): Promise<unknown>
  /**
   * select-hit.ts hitScript at page CSS px (x, y) in WEBVIEW_WORLD_ID, keeping the select under
   * `id` (absent: presses go to the page unasked). Rejects or never settles for a gone or hung page.
   */
  hitSelect?(x: number, y: number, id: string): Promise<unknown>
  /** select-hit.ts chooseScript for popup `id` in WEBVIEW_WORLD_ID (null: forget it). */
  chooseSelect?(id: string, index: number | null): Promise<unknown>
}

/** Timers for the selection debounce (tests drive them by hand). */
export interface SelectionTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface WebviewInputDeps {
  /** Whether `viewId` is a viewer of `panel` now (WebviewViewers.isViewer). */
  isViewer(panel: WebviewPanelOf, viewId: ViewId): boolean
  /** A press, a key or a wheel from a viewer (WebviewViewers.claimOwner). */
  claimOwner(panel: WebviewPanelOf, viewId: ViewId): void
  /** The panel's live off-screen page, or undefined (no view yet, gone). */
  target(panel: WebviewPanelOf): InputTarget | undefined
  /**
   * Push a selection to the one view whose input changed it (index.ts: ViewRegistry.toView with
   * `webviews.selection`). Absent: no selection is read.
   */
  pushSelection?(viewId: ViewId, event: { panelKey: string; text: string }): void
  /**
   * Send a select popup to the one view whose press hit it (index.ts: ViewRegistry.toView with
   * `webviews.select`). Absent: presses are never held, a select stays keyboard-only.
   */
  pushSelect?(viewId: ViewId, event: IpcEventMap['webviews.select']): void
  /** A new popup id (default select-hit.ts newSelectId, 32 random hex digits). */
  newSelectId?: () => string
  /** Clock in ms (default Date.now; tests pin it). */
  now?: () => number
  /** The selection debounce's and the hit-test's timers (default setTimeout). */
  timers?: SelectionTimers
}

type PressEvent = Extract<ElectronInputEvent, { type: 'mouseDown' | 'mouseUp' }>
/** One item of a lane: an input event, a committed text or a select choice, in the order they came. */
type QueuedInput = ElectronInputEvent | { type: 'insertText'; text: string } | { type: 'choose'; id: string; index: number | null }

/** What a lane waits for before the rest of its input goes. */
type LaneWait =
  /** A left press's hit-test: its press (held), its popup id. */
  | { kind: 'hit'; seq: number; timer: unknown; press: PressEvent; selectId: string }
  /** A text or a choice the page has not confirmed yet. */
  | { kind: 'page'; seq: number; timer: unknown }

/** One view's input path for one panel (kept while something waits or a release is to be dropped). */
interface PressLane {
  id: string
  panel: WebviewPanelOf
  viewId: ViewId
  wait: LaneWait | undefined
  /** Events, texts and choices that came while the lane waited, in order. */
  held: QueuedInput[]
  /** The last left press went to a popup: its release (the next left mouseUp) does not go either. */
  dropRelease: boolean
}

interface Bucket {
  tokens: number
  at: number
}

/** One view's selection state for one panel. */
interface SelectionEntry {
  /** Its key in the view's map. */
  id: string
  panel: WebviewPanelOf
  viewId: ViewId
  timer: unknown
  /** A read is in flight; `again`: input came meanwhile, so its result is stale and another follows. */
  reading: boolean
  again: boolean
  /** The text last pushed to this view for this panel ('' before any: the browser starts with none). */
  last: string
}

function panelKeyOf(panel: WebviewPanelOf): string {
  return `${panel.pluginId}/${panel.panelId}`
}

/** A panel within a view's maps: its window too (one view only ever has one window, but be exact). */
function laneIdOf(panel: WebviewPanelOf): string {
  return `${panel.windowId}/${panelKeyOf(panel)}`
}

const defaultTimers: SelectionTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

function textFail(message: string): never {
  throw new Error(`webviews.insertText: ${message}`)
}

/**
 * The `webviews.input` gate: one per app (index.ts, server mode). Buckets are per browser view
 * (all its panels together: one person's input rate), forgotten with the view (viewGone).
 */
export class WebviewInput {
  private readonly buckets = new Map<ViewId, Bucket>()
  /** By view id, then panel key (`windowId/pluginId/panelId`): forgotten with the view. */
  private readonly selections = new Map<ViewId, Map<string, SelectionEntry>>()
  /** By view id, then panel key (`windowId/pluginId/panelId`): forgotten with the view. */
  private readonly lanes = new Map<ViewId, Map<string, PressLane>>()
  private readonly popups = new SelectPopups()
  /** Numbers each wait of every lane, so a late answer to an earlier one changes nothing. */
  private waitSeq = 0
  private readonly now: () => number
  private readonly timers: SelectionTimers

  constructor(private readonly deps: WebviewInputDeps) {
    this.now = deps.now ?? Date.now
    this.timers = deps.timers ?? defaultTimers
  }

  /**
   * One call from `viewId` for `panel` (both main's). Throws for a non-viewer and a malformed call;
   * returns how many events went to the page (over-rate and off-page ones are dropped silently, and
   * a panel with no page yet takes nothing).
   */
  accept(panel: WebviewPanelOf, viewId: ViewId, raw: unknown): number {
    if (!this.deps.isViewer(panel, viewId)) fail('not a viewer of this panel')
    const events = parseInputEvents(raw)
    if (events.length === 0) return 0
    const allowed = this.take(viewId, events.length)
    if (allowed === 0) return 0
    const target = this.deps.target(panel)
    if (!target) return 0
    const size = target.size()
    const out: ElectronInputEvent[] = []
    let claim = false
    let sent = 0
    for (const event of events.slice(0, allowed)) {
      if (!inPage(event, size) || isClipboardKeyEvent(event)) continue
      if (claimsOwner(event)) claim = true
      out.push(...toElectronEvents(event, size))
      sent++
    }
    // Claimed before the page gets them, so the size the press asks for is already on its way;
    // the events themselves are in the coordinates of the frame the person saw.
    if (claim) this.deps.claimOwner(panel, viewId)
    if (out.length > 0) this.deliver(panel, viewId, target, out)
    return sent
  }

  /**
   * One `webviews.selectChoose` call from `viewId` for `panel`: the same viewer check as `accept`.
   * Taken only with the view's current popup id for the panel (once: the popup is closed by it);
   * any other id, an index the popup did not list or listed disabled, and an over-rate call are
   * ignored. Returns whether a choice went to the page (null: the popup closed with none).
   */
  acceptChoice(panel: WebviewPanelOf, viewId: ViewId, id: unknown, index: unknown): boolean {
    if (!this.deps.isViewer(panel, viewId)) fail('not a viewer of this panel')
    if (index !== null && (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_SELECT_OPTIONS)) {
      fail('index must be an option index or null')
    }
    const open = this.popups.take(viewId, laneIdOf(panel), id)
    if (!open) return false
    const target = this.deps.target(panel)
    if (!target?.chooseSelect) return false
    // In the lane like any input: keys typed before the choice reach the page before it, and
    // what comes after waits for it.
    if (index === null || !open.choosable.has(index) || this.take(viewId, 1) === 0) {
      // Forget the element in the page's world either way (it is capped there too).
      this.deliver(panel, viewId, target, [{ type: 'choose', id: open.id, index: null }])
      return false
    }
    this.deliver(panel, viewId, target, [{ type: 'choose', id: open.id, index }])
    return true
  }

  /**
   * One `webviews.insertText` call from `viewId` for `panel`: the same viewer check as `accept`, a
   * string of at most MAX_TEXT_BYTES (anything else throws), one token of the view's bucket (none
   * left: dropped silently), cleaned (cleanText) and inserted as the page's committed text. A
   * non-empty text claims the size, as a key does. Returns whether text went to the page.
   */
  acceptText(panel: WebviewPanelOf, viewId: ViewId, raw: unknown): boolean {
    if (!this.deps.isViewer(panel, viewId)) textFail('not a viewer of this panel')
    if (typeof raw !== 'string') textFail('text must be a string')
    // Units first (a unit is at least one byte): a huge string is not measured.
    if (raw.length > MAX_TEXT_BYTES || Buffer.byteLength(raw, 'utf8') > MAX_TEXT_BYTES) textFail(`at most ${MAX_TEXT_BYTES} bytes per call`)
    const text = cleanText(raw)
    if (text.length === 0) return false
    if (this.take(viewId, 1) === 0) return false
    const target = this.deps.target(panel)
    if (!target?.insertText) return false
    this.deps.claimOwner(panel, viewId)
    // In the lane like any key: text typed right after a click must land where the click put the
    // caret (the press goes first), never before it, and a key typed after it never passes it.
    this.deliver(panel, viewId, target, [{ type: 'insertText', text }])
    return true
  }

  /** The view's socket closed: its bucket, its held presses, its popups and its selection reads go. */
  viewGone(viewId: ViewId): void {
    this.buckets.delete(viewId)
    this.popups.viewGone(viewId)
    const lanes = this.lanes.get(viewId)
    this.lanes.delete(viewId)
    // A held press never went, so no release is owed to the page.
    for (const lane of lanes?.values() ?? []) if (lane.wait) this.timers.clear(lane.wait.timer)
    const entries = this.selections.get(viewId)
    if (!entries) return
    this.selections.delete(viewId)
    for (const entry of entries.values()) if (entry.timer !== undefined) this.timers.clear(entry.timer)
  }

  /** Checked, mapped input for the page, behind whatever the lane waits for. */
  private deliver(panel: WebviewPanelOf, viewId: ViewId, target: InputTarget, events: QueuedInput[]): void {
    const lane = this.lanes.get(viewId)?.get(laneIdOf(panel))
    if (lane?.wait) {
      // Over the cap the newest go: a browser of ours sends a few per animation frame.
      const room = MAX_HELD_EVENTS - lane.held.length
      if (room > 0) lane.held.push(...events.slice(0, room))
      return
    }
    this.run(panel, viewId, target, events, lane)
  }

  /**
   * Send `events` in order, up to a left press that needs a hit-test (the target can hit-test and
   * a popup can be sent): it and the rest wait (startHit). A text or a choice goes after the events
   * before it, and the rest waits for the page to confirm it (startPageWait). A release owed to a
   * popup is dropped.
   */
  private run(panel: WebviewPanelOf, viewId: ViewId, target: InputTarget, events: readonly QueuedInput[], lane: PressLane | undefined): void {
    let out: ElectronInputEvent[] = []
    const canHit = target.hitSelect !== undefined && this.deps.pushSelect !== undefined
    for (let i = 0; i < events.length; i++) {
      const event = events[i] as QueuedInput
      if (event.type === 'insertText' || event.type === 'choose') {
        this.send(panel, viewId, target, out)
        out = []
        let pending: Promise<unknown> | void
        try {
          pending = event.type === 'insertText' ? target.insertText?.(event.text) : target.chooseSelect?.(event.id, event.index)
        } catch {
          pending = undefined
        }
        if (event.type === 'insertText') this.selectionMayChange(panel, viewId)
        if (pending && typeof pending.then === 'function') {
          this.startPageWait(panel, viewId, pending, events.slice(i + 1))
          return
        }
        continue
      }
      const left = (event.type === 'mouseDown' || event.type === 'mouseUp') && event.button === 'left'
      if (left && event.type === 'mouseDown') {
        // A new press: whatever release a popup was owed is moot (it never came, or came before).
        if (lane) lane.dropRelease = false
        if (canHit) {
          this.send(panel, viewId, target, out)
          this.startHit(panel, viewId, target, event, events.slice(i + 1))
          return
        }
      } else if (left && lane?.dropRelease) {
        lane.dropRelease = false
        continue
      } else if (lane?.dropRelease && event.type === 'mouseMove' && event.modifiers.includes('leftbuttondown')) {
        // The page never saw that press: no drag of it either.
        out.push({ ...event, modifiers: event.modifiers.filter((m) => m !== 'leftbuttondown') })
        continue
      }
      out.push(event)
    }
    this.send(panel, viewId, target, out)
  }

  private send(panel: WebviewPanelOf, viewId: ViewId, target: InputTarget, out: readonly ElectronInputEvent[]): void {
    if (out.length === 0) return
    target.send(out)
    if (out.some((e) => e.type === 'mouseUp' || e.type === 'keyDown')) this.selectionMayChange(panel, viewId)
  }

  private lane(panel: WebviewPanelOf, viewId: ViewId): PressLane {
    let lanes = this.lanes.get(viewId)
    if (!lanes) {
      lanes = new Map()
      this.lanes.set(viewId, lanes)
    }
    const id = laneIdOf(panel)
    let lane = lanes.get(id)
    if (!lane) {
      lane = { id, panel, viewId, wait: undefined, held: [], dropRelease: false }
      lanes.set(id, lane)
    }
    return lane
  }

  /** Hold `rest` until the page has the text or choice `pending` is for (or PAGE_WAIT_MS passes). */
  private startPageWait(panel: WebviewPanelOf, viewId: ViewId, pending: Promise<unknown>, rest: readonly QueuedInput[]): void {
    const lane = this.lane(panel, viewId)
    const seq = ++this.waitSeq
    lane.held = rest.slice(0, MAX_HELD_EVENTS)
    lane.wait = { kind: 'page', seq, timer: this.timers.set(() => this.pageDone(lane, seq), PAGE_WAIT_MS) }
    // A rejection (a page gone or navigated meanwhile) lets the rest go all the same.
    pending.then(
      () => this.pageDone(lane, seq),
      () => this.pageDone(lane, seq)
    )
  }

  /** The text or choice `seq` reached the page, failed or timed out: what waited goes, in order. */
  private pageDone(lane: PressLane, seq: number): void {
    const wait = lane.wait
    if (!wait || wait.kind !== 'page' || wait.seq !== seq || this.lanes.get(lane.viewId)?.get(lane.id) !== lane) return
    this.timers.clear(wait.timer)
    lane.wait = undefined
    const held = lane.held
    lane.held = []
    const target = this.deps.target(lane.panel)
    if (target) this.run(lane.panel, lane.viewId, target, held, lane)
  }

  /** Hold `press` and `rest` while the page says what is under the press (or HIT_TIMEOUT_MS passes). */
  private startHit(panel: WebviewPanelOf, viewId: ViewId, target: InputTarget, press: PressEvent, rest: QueuedInput[]): void {
    const lane = this.lane(panel, viewId)
    const seq = ++this.waitSeq
    const selectId = (this.deps.newSelectId ?? newSelectId)()
    lane.held = rest.slice(0, MAX_HELD_EVENTS)
    lane.wait = { kind: 'hit', seq, press, selectId, timer: this.timers.set(() => this.hitDone(lane, seq, undefined), HIT_TIMEOUT_MS) }
    let pending: Promise<unknown>
    try {
      pending = (target.hitSelect as NonNullable<InputTarget['hitSelect']>)(press.x, press.y, selectId)
    } catch {
      this.hitDone(lane, seq, undefined)
      return
    }
    // A page that went or failed: the press goes on as a click (hitDone with nothing).
    pending.then(
      (raw) => this.hitDone(lane, seq, raw),
      () => this.hitDone(lane, seq, undefined)
    )
  }

  /**
   * The hit-test `seq` answered (`raw`), failed or timed out (undefined). Only the first of these for
   * the lane's current hit counts; a late answer finds the press already gone to the page.
   */
  private hitDone(lane: PressLane, seq: number, raw: unknown): void {
    const hit = lane.wait
    if (!hit || hit.kind !== 'hit' || hit.seq !== seq || this.lanes.get(lane.viewId)?.get(lane.id) !== lane) return
    this.timers.clear(hit.timer)
    lane.wait = undefined
    const held = lane.held
    lane.held = []
    const target = this.deps.target(lane.panel)
    if (!target) return
    const select = parseHitResult(raw)
    // A view that stopped viewing the panel meanwhile gets no popup: the press goes as it came.
    if (select && this.deps.pushSelect && this.deps.isViewer(lane.panel, lane.viewId)) {
      this.popups.set(lane.viewId, lane.id, select, hit.selectId)
      lane.dropRelease = true
      this.deps.pushSelect(lane.viewId, { panelKey: panelKeyOf(lane.panel), id: hit.selectId, ...select })
      this.run(lane.panel, lane.viewId, target, held, lane)
      return
    }
    // Not a select: the press goes first, then what waited for it; a press among those is asked
    // about in turn. Not through run for the press itself: it would be hit-tested again.
    this.send(lane.panel, lane.viewId, target, [hit.press])
    this.run(lane.panel, lane.viewId, target, held, lane)
  }

  /** Input from `viewId` may have changed `panel`'s selection: (re)start the debounce. */
  private selectionMayChange(panel: WebviewPanelOf, viewId: ViewId): void {
    if (!this.deps.pushSelection) return
    let entries = this.selections.get(viewId)
    if (!entries) {
      entries = new Map()
      this.selections.set(viewId, entries)
    }
    const id = `${panel.windowId}/${panelKeyOf(panel)}`
    let entry = entries.get(id)
    if (!entry) {
      entry = { id, panel, viewId, timer: undefined, reading: false, again: false, last: '' }
      entries.set(id, entry)
    }
    if (entry.reading) entry.again = true
    if (entry.timer !== undefined) this.timers.clear(entry.timer)
    const e = entry
    e.timer = this.timers.set(() => {
      e.timer = undefined
      this.readSelection(e)
    }, SELECTION_DEBOUNCE_MS)
  }

  private readSelection(entry: SelectionEntry): void {
    // One read in flight: the debounce that ends meanwhile waits for it (see `settle`).
    if (entry.reading) return
    const read = this.deps.target(entry.panel)?.readSelection
    if (!read) return
    entry.reading = true
    entry.again = false
    const settle = (raw: unknown): void => {
      entry.reading = false
      if (!this.isCurrent(entry)) return
      if (entry.again) {
        // Input came while it read: the result may be stale. Read again unless a debounce is
        // still running (it reads when it ends).
        entry.again = false
        if (entry.timer === undefined) this.readSelection(entry)
        return
      }
      // A view that stopped viewing the panel gets nothing more of it.
      if (!this.deps.isViewer(entry.panel, entry.viewId)) return
      const text = cleanSelection(raw)
      if (text === entry.last) return
      entry.last = text
      this.deps.pushSelection?.(entry.viewId, { panelKey: panelKeyOf(entry.panel), text })
    }
    let pending: Promise<unknown>
    try {
      pending = read()
    } catch {
      entry.reading = false
      return
    }
    // A page that navigated or went: no selection to report (and nothing to log, it is common).
    pending.then(settle, () => settle(undefined))
  }

  /** Whether `entry` is still the view's entry (its socket did not close meanwhile). */
  private isCurrent(entry: SelectionEntry): boolean {
    return this.selections.get(entry.viewId)?.get(entry.id) === entry
  }

  /** Take up to `want` tokens from the view's bucket; how many it had. */
  private take(viewId: ViewId, want: number): number {
    const now = this.now()
    let bucket = this.buckets.get(viewId)
    if (!bucket) {
      bucket = { tokens: INPUT_BURST, at: now }
      this.buckets.set(viewId, bucket)
    }
    // A clock that went back refills nothing (and never drains).
    const elapsed = Math.max(0, now - bucket.at)
    bucket.tokens = Math.min(INPUT_BURST, bucket.tokens + (elapsed * INPUT_RATE) / 1000)
    bucket.at = now
    const got = Math.min(want, Math.floor(bucket.tokens))
    bucket.tokens -= got
    return got
  }
}
