// The terminal streams of one view (design-web.md §5.2, plan Task 11): which tabs the view
// follows in the headless mirror (terminals/mirror.ts), and the `term.snapshot` / `term.data`
// frames it gets for them (protocol.ts).
//
// Only the visible tab is snapshotted: a view joining a window with ten Claude tabs gets one
// snapshot (up to 5,000 lines of scrollback, several MiB), not ten. Another tab is joined when the
// view selects it. A tab joined once stays live while the view lasts, as the desktop keeps every
// tab's terminal parsing whether it shows or not: going back to it costs nothing, and its xterm in
// the page is current. A tab that closes, or whose stream ends for any other reason (mirror.ts
// `MirrorView.closed`), is forgotten; selecting it again joins it afresh.
//
// The connection wires `select` to the view's own tab selection (Task 12). Never trusted: the tab
// must pass `canFollow` (a tab of the view's own window, checked by main), whatever id the page
// sent.

import type { TermDataFrame, TermSnapshotFrame } from '../../shared/web-protocol'
import type { MirrorView } from '../terminals/mirror'
import { MAX_FRAME_BYTES, termDataFrame, termSnapshotFrames } from './protocol'

/** The part of TerminalMirror a view uses. */
export interface TerminalSource {
  join(tabId: string, view: MirrorView): (() => void) | undefined
}

export interface ViewTerminalsDeps {
  mirror: TerminalSource
  /** Whether this view may follow the tab: one of its window's tabs, by main's own table. */
  canFollow(tabId: string): boolean
  /** Sends one frame on the view's socket, in order. */
  send(frame: TermSnapshotFrame | TermDataFrame): void
  /** The frame cap; tests pass a small one to see a snapshot split. */
  maxFrameBytes?: number
}

export class ViewTerminals {
  /** Followed tabs: the mirror's leave function of each. */
  private readonly joined = new Map<string, () => void>()
  private disposed = false

  constructor(private readonly deps: ViewTerminalsDeps) {}

  /**
   * The view shows this tab now. Joins it (a snapshot follows, then live items) unless the view
   * already follows it. False when the tab cannot be followed: not the view's, or the mirror does
   * not hold it (web access going off, a tab started before the mirror).
   */
  select(tabId: string): boolean {
    if (this.disposed) return false
    if (this.joined.has(tabId)) return true
    if (!this.deps.canFollow(tabId)) return false
    const leave = this.deps.mirror.join(tabId, this.viewOf(tabId))
    if (!leave) return false
    this.joined.set(tabId, leave)
    return true
  }

  /** Stop following a tab (a resync joins it again). */
  leave(tabId: string): void {
    const leave = this.joined.get(tabId)
    if (!leave) return
    this.joined.delete(tabId)
    leave()
  }

  /** Tabs the view follows now (tests, diagnostics). */
  following(): string[] {
    return [...this.joined.keys()]
  }

  /** The view is gone: leave every tab; nothing is sent after this. */
  dispose(): void {
    this.disposed = true
    for (const tabId of [...this.joined.keys()]) this.leave(tabId)
  }

  private viewOf(tabId: string): MirrorView {
    const maxBytes = this.deps.maxFrameBytes ?? MAX_FRAME_BYTES
    return {
      // The parts go out back to back, in one call: nothing of this tab can come between them.
      snapshot: (snapshot) => {
        if (this.disposed) return
        for (const frame of termSnapshotFrames(tabId, snapshot, maxBytes)) this.deps.send(frame)
      },
      item: (item) => {
        if (this.disposed) return
        const frame = termDataFrame(tabId, item)
        if (frame) this.deps.send(frame)
      },
      // The mirror already dropped this view; only the bookkeeping is left.
      closed: () => {
        this.joined.delete(tabId)
      }
    }
  }
}
