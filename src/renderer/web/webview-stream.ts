// The DOM-free halves of a server's streamed webview panel (web/webview-canvas.tsx,
// design-web-browser.md §3): where a frame is drawn in the canvas (the letterbox) and its inverse
// (canvas px → frame px, for input in Task 7), the placement reports to main (`webviews.place`),
// and the latest-only frame pipeline. Timers, decoding and the frame source are injected, so the
// unit tests run them in plain Node.

import type { WebviewFrame } from '../../shared/web-protocol'

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
