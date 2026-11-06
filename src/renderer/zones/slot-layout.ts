// The DOM-free half of slot frames (design-next §2), for SlotFrame and the panel column: which
// frames go above and below a panel's own frame, how tall each is drawn, how a page's
// `ccPanel.slot.setHeight` reaches main and how a top-bar page's `ccPanel.slot.setWidth` sizes its
// frame. Split out so unit tests run it in plain Node.
import { SLOT_HEIGHT_MESSAGE, SLOT_MESSAGE, SLOT_WIDTH_MESSAGE } from '../../sdk/panel-core'
import type { SlotFrameInfo } from '../../shared/ipc'
import { clampSlotHeight, SLOT_WIDTH_MAX, SLOT_WIDTH_MIN } from '../../shared/slots'

/** A panel's column: its slot frames above and below its own frame, each in placement order. */
export interface SlotColumn {
  top: SlotFrameInfo[]
  bottom: SlotFrameInfo[]
}

/**
 * Split a panel's frames (`PanelInfo.slots`) by position, keeping main's order within each. A
 * `top-bar` frame never belongs to a panel (main puts those in `LayoutView.appSlots`); one that
 * strayed here is left out rather than drawn in a column it was not placed in.
 */
export function slotColumn(frames: readonly SlotFrameInfo[] | undefined): SlotColumn {
  const top: SlotFrameInfo[] = []
  const bottom: SlotFrameInfo[] = []
  for (const frame of frames ?? []) {
    if (frame.position === 'top') top.push(frame)
    else if (frame.position === 'bottom') bottom.push(frame)
  }
  return { top, bottom }
}

/**
 * The bounds a frame's page may size itself within: [minHeight, placement height]. Main sends
 * both clamped already; this keeps a frame drawable even if they arrived crossed (min over max),
 * in which case the placement height wins. The host panel's room is the harder limit still: the
 * column caps each side's frames to a share of the panel and shrinks them within it (styles.css,
 * `.slot-frames`), so a frame may be drawn shorter than this.
 */
function boundsOf(frame: SlotFrameInfo): { min: number; max: number } {
  const max = Math.max(1, Math.round(frame.height))
  return { min: Math.min(Math.max(1, Math.round(frame.minHeight)), max), max }
}

/** The height a column frame is drawn at: the page's request (`pageHeight`) within its bounds, else the placement height. */
export function slotFrameHeight(frame: SlotFrameInfo): number {
  const { min, max } = boundsOf(frame)
  return frame.pageHeight === undefined ? max : clampSlotHeight(frame.pageHeight, min, max)
}

/**
 * A page's message to its parent read as a height request: `{ type: SLOT_HEIGHT_MESSAGE, height }`
 * with a finite number, kept within the frame's bounds; undefined for anything else. The page is
 * untrusted: its SDK clamps too, but a page can post whatever it likes.
 */
export function slotHeightRequest(data: unknown, frame: SlotFrameInfo): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { type, height } = data as { type?: unknown; height?: unknown }
  if (type !== SLOT_HEIGHT_MESSAGE || typeof height !== 'number' || !Number.isFinite(height)) return undefined
  const { min, max } = boundsOf(frame)
  return clampSlotHeight(height, min, max)
}

/**
 * A top-bar page's message to its parent read as a width request: `{ type: SLOT_WIDTH_MESSAGE,
 * width }` with a finite number, rounded and kept within [SLOT_WIDTH_MIN, SLOT_WIDTH_MAX];
 * undefined for anything else. Untrusted like a height request. This is only the number's sanity:
 * the cap that keeps part of the bar a drag region depends on the bar's width at every moment (a
 * window resize moves it with no message from the page), so it is the stylesheet's `max-width`
 * (`.slot-frame-top-bar`), which the browser applies on every layout.
 */
export function slotWidthRequest(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { type, width } = data as { type?: unknown; width?: unknown }
  if (type !== SLOT_WIDTH_MESSAGE || typeof width !== 'number' || !Number.isFinite(width)) return undefined
  return Math.min(SLOT_WIDTH_MAX, Math.max(SLOT_WIDTH_MIN, Math.round(width)))
}

/** What the shell tells a slot page on every load, before its port: it is a slot of `type` (the SDK's `ccPanel.slot`). */
export function slotIntro(type: string): { type: string; slot: { type: string } } {
  return { type: SLOT_MESSAGE, slot: { type } }
}

/**
 * Carries a frame's height requests to main (`slots.height`) one at a time: a page calling
 * `setHeight` in a loop (a ResizeObserver feeding back on itself) would otherwise make one IPC
 * call per frame of animation. While a call is out, only the latest request waits; a request for
 * the height last sent is not sent again. Main answers by publishing the layout with the frame's
 * new `pageHeight`, which is what resizes the frame.
 */
export class SlotHeightRelay {
  private sent: number | undefined
  private pending: number | undefined
  private busy = false
  private closed = false

  constructor(private readonly send: (height: number) => Promise<unknown>) {}

  request(height: number): void {
    if (this.closed) return
    if (this.busy) {
      this.pending = height
      return
    }
    if (height === this.sent) return
    this.busy = true
    this.sent = height
    this.send(height)
      .catch(() => {
        // Refused or failed: let the same height be asked for again.
        this.sent = undefined
      })
      .finally(() => {
        this.busy = false
        const next = this.pending
        this.pending = undefined
        if (next !== undefined) this.request(next)
      })
  }

  /** The frame unmounted: nothing more goes out. */
  close(): void {
    this.closed = true
    this.pending = undefined
  }
}

/** Changes a top-bar frame takes within one WIDTH_BURST_MS before the gate holds further ones. */
export const WIDTH_BURST_CHANGES = 20
export const WIDTH_BURST_MS = 1000

/**
 * The loop guard of a top-bar frame's width (`ccPanel.slot.setWidth`). The width is the shell's own
 * layout and goes to no one (no IPC, unlike a height), but every applied change is a React render
 * and a relayout of the bar, and a page can feed back on itself: a ResizeObserver whose content
 * width depends on the frame's (a wrapping row, a scrollbar that comes and goes) flips between two
 * widths forever. So:
 * - requests are coalesced to one per animation frame, the latest winning (`schedule`, rAF in the
 *   shell), and a width equal to the one applied is not applied again;
 * - at most WIDTH_BURST_CHANGES changes within WIDTH_BURST_MS: past that the frame keeps its width
 *   until the window has passed, then takes the latest request. A page that settles never hits it
 *   (the sessions strip changes once per entry change); one in a loop costs a relayout a few times
 *   a second instead of on every frame.
 * `schedule` returns its cancel; `now` is a clock in ms (injected for tests).
 */
export class SlotWidthGate {
  private applied: number | undefined
  private pending: number | undefined
  private cancel: (() => void) | undefined
  private changes: number[] = []
  private closed = false

  constructor(
    private readonly apply: (width: number) => void,
    private readonly schedule: (run: () => void, delayMs?: number) => () => void,
    private readonly now: () => number
  ) {}

  request(width: number): void {
    if (this.closed) return
    this.pending = width
    if (!this.cancel) this.cancel = this.schedule(() => this.flush())
  }

  private flush(): void {
    this.cancel = undefined
    if (this.closed || this.pending === undefined) return
    const width = this.pending
    if (width === this.applied) {
      this.pending = undefined
      return
    }
    const t = this.now()
    this.changes = this.changes.filter((at) => t - at < WIDTH_BURST_MS)
    if (this.changes.length >= WIDTH_BURST_CHANGES) {
      // Held: retry once the oldest change in the window has aged out, with whatever is latest then.
      const wait = WIDTH_BURST_MS - (t - this.changes[0]!)
      this.cancel = this.schedule(() => this.flush(), wait)
      return
    }
    this.pending = undefined
    this.applied = width
    this.changes.push(t)
    this.apply(width)
  }

  /** The frame unmounted: nothing more is applied. */
  close(): void {
    this.closed = true
    this.pending = undefined
    this.cancel?.()
    this.cancel = undefined
  }
}
