// The DOM-free half of slot frames (design-next §2), for SlotFrame and the panel column: which
// frames go above and below a panel's own frame, how tall each is drawn, and how a page's
// `ccPanel.slot.setHeight` reaches main. Split out so unit tests run it in plain Node.
import { SLOT_HEIGHT_MESSAGE, SLOT_MESSAGE } from '../../sdk/panel-core'
import type { SlotFrameInfo } from '../../shared/ipc'
import { clampSlotHeight } from '../../shared/slots'

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
 * in which case the placement height wins (the host panel's room is the harder limit).
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
