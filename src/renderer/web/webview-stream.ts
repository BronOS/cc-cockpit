// The DOM-free halves of a server's streamed webview panel (web/webview-canvas.tsx,
// design-web-browser.md §3): where a frame is drawn in the canvas (the letterbox) and its inverse
// (canvas px → frame px → page px, for input), the placement reports to main (`webviews.place`),
// the latest-only frame pipeline, and the input layer's key split and outbox (`webviews.input`). Timers, decoding and the frame source are injected, so the
// unit tests run them in plain Node.

import type { WebviewInputEventWire, WebviewInputModifier } from '../../shared/ipc'
import type { KeyEventLike } from '../../shared/keys'
import type { WebviewFrame } from '../../shared/web-protocol'
import { isClipboardChord, webviewKeyCode } from '../../shared/webview-keys'

/** The page's CSS size of a frame: the header's scale is encoded size over page size (Task 5). */
export function framePageSize(frame: { width: number; height: number; scale: number }): { width: number; height: number } {
  const scale = frame.scale > 0 && Number.isFinite(frame.scale) ? frame.scale : 1
  return { width: frame.width / scale, height: frame.height / scale }
}

/** Where a frame is drawn in a box: its top-left corner and size in the box's CSS px. */
export interface Letterbox {
  x: number
  y: number
  width: number
  height: number
  /** Box CSS px per encoded frame px (the drawn size over the frame's encoded size). */
  scale: number
}

/**
 * Where a frame goes in a box of `boxWidth` x `boxHeight` CSS px: scaled to fit with its aspect
 * kept, centred (the rest is the letterbox). The size owner's box is the page's size, so its frame
 * lands 1:1 at the top left; another view sees the owner's page scaled (design-web-browser.md §3.2).
 * Sized by the frame's own header, not by the last size reported: right after a resize one frame of
 * the old size may still come. An empty box or frame draws nothing (all zero).
 */
export function letterbox(boxWidth: number, boxHeight: number, frame: { width: number; height: number; scale: number }): Letterbox {
  const page = framePageSize(frame)
  if (!(boxWidth > 0 && boxHeight > 0 && page.width > 0 && page.height > 0 && frame.width > 0 && frame.height > 0)) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  }
  const fit = Math.min(boxWidth / page.width, boxHeight / page.height)
  const width = page.width * fit
  const height = page.height * fit
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height, scale: width / frame.width }
}

/**
 * A point in the box (CSS px from its top left) as encoded frame px, or undefined when it is in the
 * letterbox (outside the drawn frame). Task 7 sends these to main, which maps them to the page
 * through the header's scale. The far edges are clamped into the frame (a pointer on the last pixel
 * row must not read as outside by rounding).
 */
export function boxToFrame(box: Letterbox, frame: { width: number; height: number }, x: number, y: number): { x: number; y: number } | undefined {
  if (box.scale <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  const fx = (x - box.x) / box.scale
  const fy = (y - box.y) / box.scale
  if (fx < 0 || fy < 0 || fx > frame.width || fy > frame.height) return undefined
  return { x: Math.min(fx, frame.width - 1), y: Math.min(fy, frame.height - 1) }
}

/** Whether "Fit to this screen" is worth offering: the page has another view's size (a whole px off). */
export function sizeDiffers(boxWidth: number, boxHeight: number, frame: { width: number; height: number; scale: number }): boolean {
  const page = framePageSize(frame)
  return Math.abs(Math.round(boxWidth) - Math.round(page.width)) > 1 || Math.abs(Math.round(boxHeight) - Math.round(page.height)) > 1
}

/** One `webviews.place` report, less the panel key. */
export interface PlaceReport {
  width: number
  height: number
  visible: boolean
  hidden: boolean
}

/** A report waits this long for the next one (a dragged splitter sends one report, not one per frame). */
export const PLACE_DEBOUNCE_MS = 50

export interface PlaceTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/**
 * The placement reports of one mounted panel (Task 4's wire: visible = mounted with an area, hidden
 * = `document.hidden`). Debounced, latest wins, nothing main already has. `dispose` (unmount) says
 * `visible: false` at once: main then drops this view as a viewer and stops its frames.
 */
export class PlaceReporter {
  private sent: PlaceReport | undefined
  private pending: PlaceReport | undefined
  private timer: unknown
  private disposed = false

  constructor(
    private readonly send: (report: PlaceReport) => void,
    private readonly timers: PlaceTimers,
    private readonly delayMs = PLACE_DEBOUNCE_MS
  ) {}

  /** The panel's area as measured now and the page's visibility. */
  update(width: number, height: number, hidden: boolean): void {
    if (this.disposed) return
    const w = Math.round(Number.isFinite(width) ? width : 0)
    const h = Math.round(Number.isFinite(height) ? height : 0)
    this.pending = { width: w, height: h, visible: w >= 1 && h >= 1, hidden }
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = this.timers.set(() => {
      this.timer = undefined
      this.flush()
    }, this.delayMs)
  }

  private flush(): void {
    const next = this.pending
    this.pending = undefined
    if (!next || this.disposed) return
    const s = this.sent
    if (s && s.width === next.width && s.height === next.height && s.visible === next.visible && s.hidden === next.hidden) return
    this.sent = next
    this.send(next)
  }

  /** Unmounted: tell main at once (also when nothing was sent yet: a report may be in flight). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer !== undefined) this.timers.clear(this.timer)
    this.timer = undefined
    this.pending = undefined
    const last = this.sent ?? { width: 0, height: 0, visible: false, hidden: false }
    this.send({ ...last, visible: false })
  }
}

/** Where the panel gets its frames: the web bridge's `onWebviewFrame` (web/main.tsx sets it). */
export type FrameSource = (key: string, listener: (frame: WebviewFrame) => void) => () => void

let frameSource: FrameSource | undefined

/** Set once by the web shell's entry, before the shell renders. */
export function setWebviewFrameSource(source: FrameSource | undefined): void {
  frameSource = source
}

export function webviewFrameSource(): FrameSource | undefined {
  return frameSource
}

/** A decoded frame: what the canvas draws (`close` frees the bitmap). */
export interface DecodedFrame<B> {
  bitmap: B
  frame: Omit<WebviewFrame, 'jpeg'>
}

/**
 * Frames in, decoded bitmaps out, latest only: while one decode runs, a newer frame replaces the
 * waiting one (a slow decode never builds a backlog). Decodes run one at a time, so the order of
 * the socket is kept; `seq` is never compared (it restarts per page, Task 5). A bitmap that is no
 * longer the newest, and every one after `dispose`, is closed.
 */
export class FrameDecoder<B> {
  private waiting: WebviewFrame | undefined
  private busy = false
  private disposed = false

  constructor(
    private readonly decode: (jpeg: Uint8Array) => Promise<B>,
    private readonly close: (bitmap: B) => void,
    private readonly onDecoded: (decoded: DecodedFrame<B>) => void
  ) {}

  push(frame: WebviewFrame): void {
    if (this.disposed) return
    this.waiting = frame
    if (!this.busy) void this.next()
  }

  private async next(): Promise<void> {
    while (this.waiting && !this.disposed) {
      const frame = this.waiting
      this.waiting = undefined
      this.busy = true
      let bitmap: B
      try {
        bitmap = await this.decode(frame.jpeg)
      } catch {
        // A frame the browser cannot decode is skipped; the next paint replaces it.
        continue
      } finally {
        this.busy = false
      }
      // A newer frame came while decoding: it is drawn instead, this one never is.
      if (this.disposed || this.waiting) {
        this.close(bitmap)
        continue
      }
      this.onDecoded({ bitmap, frame: { key: frame.key, seq: frame.seq, width: frame.width, height: frame.height, scale: frame.scale } })
    }
  }

  dispose(): void {
    this.disposed = true
    this.waiting = undefined
  }
}

// ---------------------------------------------------------------------------------------------
// Input (Task 7, design-web-browser.md §4.1): what the canvas's input layer sends with
// `webviews.input`. Main checks it all again (main/webview/webview-input.ts); these only keep a
// browser of ours from sending what main would refuse, and keep the shell's own keys the shell's.

/**
 * A point in the box (CSS px from its top left) as the page's CSS px: the letterbox and then the
 * frame's scale undone (frame px over scale, Task 5). Undefined in the letterbox bars, unless
 * `clamp` (a drag that left the frame, under pointer capture: the page sees it reach the edge and
 * gets its release).
 */
export function boxToPage(
  box: Letterbox,
  frame: { width: number; height: number; scale: number },
  x: number,
  y: number,
  clamp = false
): { x: number; y: number } | undefined {
  if (box.scale <= 0 || !Number.isFinite(x) || !Number.isFinite(y)) return undefined
  const cx = clamp ? Math.max(box.x, Math.min(box.x + box.width, x)) : x
  const cy = clamp ? Math.max(box.y, Math.min(box.y + box.height, y)) : y
  const at = boxToFrame(box, frame, cx, cy)
  if (!at) return undefined
  const scale = frame.scale > 0 && Number.isFinite(frame.scale) ? frame.scale : 1
  return { x: at.x / scale, y: at.y / scale }
}

/** The modifier and held-button state of a DOM pointer, wheel or key event. */
export interface ModifierEventLike {
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  /** Pointer events: the held buttons (1 left, 2 right, 4 middle). */
  buttons?: number
  /** Key events: held down and repeating. */
  repeat?: boolean
}

/** A DOM event's modifiers as `webviews.input` names them (Electron's names). */
export function inputModifiers(e: ModifierEventLike): WebviewInputModifier[] {
  const out: WebviewInputModifier[] = []
  if (e.shiftKey) out.push('shift')
  if (e.ctrlKey) out.push('control')
  if (e.altKey) out.push('alt')
  if (e.metaKey) out.push('meta')
  const buttons = e.buttons ?? 0
  if (buttons & 1) out.push('leftbuttondown')
  if (buttons & 4) out.push('middlebuttondown')
  if (buttons & 2) out.push('rightbuttondown')
  if (e.repeat) out.push('isautorepeat')
  return out
}

/** A DOM `button` as the page gets it; undefined for back, forward and the rest (not forwarded). */
export function pointerButton(button: number): 'left' | 'middle' | 'right' | undefined {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return undefined
}

/** Two presses this close in time (ms) and space (CSS px) make a double click, as in a desktop browser. */
export const MULTI_CLICK_MS = 500
export const MULTI_CLICK_DISTANCE = 4

/**
 * Click counts for presses (a PointerEvent's `detail` is always 0 in Chromium): 1, 2, 3, then 1
 * again, for the same button pressed again within MULTI_CLICK_MS and MULTI_CLICK_DISTANCE.
 */
export class ClickCounter {
  private last: { button: string; x: number; y: number; at: number; count: number } | undefined

  press(button: string, x: number, y: number, at: number): number {
    const l = this.last
    const again = l !== undefined && l.button === button && at - l.at <= MULTI_CLICK_MS && Math.hypot(x - l.x, y - l.y) <= MULTI_CLICK_DISTANCE
    const count = again && l.count < 3 ? l.count + 1 : 1
    this.last = { button, x, y, at, count }
    return count
  }

  /** The count of the last press, for its release. */
  current(): number {
    return this.last?.count ?? 1
  }
}

/** Pixels per line of a DOM wheel event in line mode (Firefox with a mouse wheel). */
export const WHEEL_LINE_PX = 16

/** A DOM wheel event's deltas in CSS px (line and page modes converted; a page is `pageHeight`). */
export function wheelPixels(deltaMode: number, deltaX: number, deltaY: number, pageHeight: number): { deltaX: number; deltaY: number } {
  const unit = deltaMode === 1 ? WHEEL_LINE_PX : deltaMode === 2 ? Math.max(1, pageHeight) : 1
  const px = (v: number): number => (Number.isFinite(v) ? v * unit : 0)
  return { deltaX: px(deltaX), deltaY: px(deltaY) }
}

/** The fields of a DOM KeyboardEvent the input layer reads. */
export interface InputKeyEventLike extends KeyEventLike {
  isComposing?: boolean
  defaultPrevented?: boolean
  /** KeyboardEvent.getModifierState: AltGr, which Windows reports as Ctrl+Alt. */
  getModifierState?(key: string): boolean
}

/**
 * What the input layer does with a key event:
 * - `shell`: a command chord of the shell (the same table and matching the window's own key
 *   handler and the terminals use, `commandForEvent`): the shell's, never the page's (the window's
 *   capture-phase handler has usually taken it already, `defaultPrevented`).
 * - `clipboard`: Ctrl/Cmd+C, X, V (Shift or Alt with them too), Ctrl+Insert, Shift+Insert and
 *   Shift+Delete: never forwarded (design-web-browser.md §4.2: the server's clipboard is shared by
 *   every page there, and a forwarded paste would double the browser's own `paste`), nor
 *   prevented, so the browser's own copy and paste events still fire (Task 8).
 * - `forward`: a key of the allow-list (shared/webview-keys.ts), to the page; the browser's default
 *   (Tab moving focus, Space scrolling the shell, F5 reloading it) is prevented.
 * - `ignore`: anything else (a lone modifier, a dead key, an IME's composition, a non-ASCII
 *   character, a character typed with AltGr): left alone, so the hidden textarea types it and its
 *   text goes as `webviews.insertText` (Task 8). Not prevented, or the textarea would never see it.
 *
 * The split between keys and text (no character ever goes both ways): one printable ASCII key or
 * Space with no Ctrl, Meta or Alt is `forward`ed and prevented here, and main sends it as key down +
 * `char` (shared/webview-keys.ts webviewKeyChar: the page sees the events a real keyboard gives,
 * and a page that prevents the key down gets no character, as with a real one); everything that is
 * text but not that is the textarea's. Enter is a key too ('\r' as its char: a textarea's newline
 * and a form's submit), as are Tab, Backspace, Delete, the arrows, Escape and the F-keys, and any
 * key with Ctrl, Meta or Alt (Ctrl+A selects; it types nothing).
 */
export function webviewKeyAction(e: InputKeyEventLike, isShellCommand: (e: KeyEventLike) => boolean): 'shell' | 'clipboard' | 'forward' | 'ignore' {
  if (e.isComposing || e.key === 'Process' || e.key === 'Dead') return 'ignore'
  if (e.defaultPrevented || isShellCommand(e)) return 'shell'
  if (isClipboardChord(e)) return 'clipboard'
  // AltGr text ('@' on a German layout): on Windows it also reads as Ctrl+Alt, which would make it
  // a shortcut with no char. A character is text, and the textarea types it.
  if (e.key.length === 1 && e.getModifierState?.('AltGraph') === true) return 'ignore'
  return webviewKeyCode(e.key) === undefined ? 'ignore' : 'forward'
}

/** Most UTF-16 units per `webviews.insertText` call: at most 3 bytes each, under main's 64 KB. */
export const TEXT_CHUNK_UNITS = 16 * 1024
/** Most calls one paste makes (1 Mi units); the rest of a larger paste is dropped. */
export const MAX_TEXT_CHUNKS = 64

/**
 * Text cut into `webviews.insertText` calls of at most TEXT_CHUNK_UNITS, never between the two
 * halves of a surrogate pair (an emoji stays whole), at most MAX_TEXT_CHUNKS of them.
 */
export function textChunks(text: string, units = TEXT_CHUNK_UNITS, maxChunks = MAX_TEXT_CHUNKS): string[] {
  const out: string[] = []
  let at = 0
  while (at < text.length && out.length < maxChunks) {
    let end = Math.min(text.length, at + units)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && end - at > 1 && last >= 0xd800 && last <= 0xdbff) end--
    out.push(text.slice(at, end))
    at = end
  }
  return out
}

export interface InputScheduler {
  /** Run `fn` on the next animation frame. */
  frame(fn: () => void): unknown
  cancel(handle: unknown): void
}

/** Most events per `webviews.input` call (main's MAX_INPUT_EVENTS). */
export const MAX_INPUT_BATCH = 64

/**
 * The input layer's outbox, the one ordered way out for a panel's input: events go out once per
 * animation frame, in order, at most MAX_INPUT_BATCH per call. A pointer move right after a move
 * replaces it, a wheel right after a wheel adds to it (one per frame each: the rate main allows is
 * far above it), so a fast pointer costs one move per frame however many the browser fires. Nothing
 * else is merged, and nothing is merged across anything else: a press, a release and every key keep
 * their place. What is not an event (an inserted text, a select choice) goes through `call`, which
 * sends the events before it first, so the page gets it all in the order the person produced it
 * (main keeps that order, webview-input.ts).
 */
export class InputQueue {
  private pending: WebviewInputEventWire[] = []
  private handle: unknown
  private disposed = false

  constructor(
    private readonly send: (events: WebviewInputEventWire[]) => void,
    private readonly scheduler: InputScheduler
  ) {}

  push(event: WebviewInputEventWire): void {
    if (this.disposed) return
    const last = this.pending[this.pending.length - 1]
    if (event.kind === 'pointer' && event.type === 'move' && last?.kind === 'pointer' && last.type === 'move') {
      this.pending[this.pending.length - 1] = event
    } else if (event.kind === 'wheel' && last?.kind === 'wheel') {
      this.pending[this.pending.length - 1] = { ...event, deltaX: last.deltaX + event.deltaX, deltaY: last.deltaY + event.deltaY }
    } else {
      this.pending.push(event)
    }
    if (this.pending.length >= MAX_INPUT_BATCH) this.flush()
    else if (this.handle === undefined) {
      this.handle = this.scheduler.frame(() => {
        this.handle = undefined
        this.flush()
      })
    }
  }

  /**
   * Send `fn`'s call in its place: the events pushed before it go first (in one or more batches),
   * then `fn` runs. After `dispose` nothing runs.
   */
  call(fn: () => void): void {
    if (this.disposed) return
    this.flush()
    fn()
  }

  /** Send what is waiting now (also before the layer goes: a release must not be lost). */
  flush(): void {
    if (this.handle !== undefined) {
      this.scheduler.cancel(this.handle)
      this.handle = undefined
    }
    while (this.pending.length > 0) this.send(this.pending.splice(0, MAX_INPUT_BATCH))
  }

  dispose(): void {
    this.flush()
    this.disposed = true
  }
}
