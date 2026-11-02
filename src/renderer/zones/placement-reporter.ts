// The throttle between a webview panel's placeholder and main (`webviews.placement`). DOM-free so
// unit tests drive it with a fake frame scheduler.
//
// - A change of `visible` goes out at once: a view left showing over a menu or an overlay for a
//   few frames is exactly what hiding is for, and one coming back late is merely slow.
// - Bounds alone (a resize, a window drag) go out at most once per frame, the latest only.
// - Nothing is sent that main already has (a re-render measuring the same rect).

export interface Placement {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

/** Run `fn` on the next frame; returns a cancel. (requestAnimationFrame in the page.) */
export type FrameScheduler = (fn: () => void) => () => void

const HIDDEN: Placement = { x: 0, y: 0, width: 0, height: 0, visible: false }

function same(a: Placement, b: Placement): boolean {
  return a.visible === b.visible && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export class PlacementReporter {
  /** What main was last told (it starts out hidden: no report yet). */
  private sent: Placement = HIDDEN
  private pending: Placement | undefined
  private cancel: (() => void) | undefined
  private disposed = false

  constructor(
    private readonly send: (placement: Placement) => void,
    private readonly schedule: FrameScheduler
  ) {}

  /** The placeholder as measured now. */
  update(next: Placement): void {
    if (this.disposed) return
    // Whole CSS px: sub-pixel jitter from layout must not count as a move.
    const p: Placement = {
      x: Math.round(next.x),
      y: Math.round(next.y),
      width: Math.round(next.width),
      height: Math.round(next.height),
      visible: next.visible
    }
    if (p.visible !== this.sent.visible) {
      this.flushNow(p)
      return
    }
    if (same(p, this.sent)) {
      // Where main already has it (a re-render; or back there before a queued move went out).
      this.drop()
      return
    }
    this.pending = p
    this.cancel ??= this.schedule(() => {
      this.cancel = undefined
      const queued = this.pending
      this.pending = undefined
      if (queued && !this.disposed) this.emit(queued)
    })
  }

  /** The placeholder is going away (unmount): the view hides now, and nothing is sent after. */
  dispose(): void {
    if (this.disposed) return
    this.drop()
    if (this.sent.visible) this.emit({ ...this.sent, visible: false })
    this.disposed = true
  }

  private flushNow(p: Placement): void {
    this.drop()
    this.emit(p)
  }

  private drop(): void {
    this.cancel?.()
    this.cancel = undefined
    this.pending = undefined
  }

  private emit(p: Placement): void {
    this.sent = p
    this.send(p)
  }
}
