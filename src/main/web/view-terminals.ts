// The terminal streams of one view (design-web.md §5.2, plan Tasks 11 and 12): which tabs the view
// follows in the headless mirror (terminals/mirror.ts), the `term.snapshot` / `term.data` frames it
// gets for them (protocol.ts), and its flow control.
//
// Only the visible tab is snapshotted: a view joining a window with ten Claude tabs gets one
// snapshot (up to 5,000 lines of scrollback, several MiB), not ten. Another tab is joined when the
// view selects it. A tab joined once stays followed while the view lasts, as the desktop keeps every
// tab's terminal parsing whether it shows or not: going back to it costs nothing, and its xterm in
// the page is current. A tab that closes is forgotten; a stream that ends for any other reason
// (mirror.ts `MirrorView.closed`: the snapshot never came, or came out of step) is joined again
// while the mirror still holds the tab.
//
// Flow (Task 12, "every view drops and resyncs"): main is the pty's consumer, so a view never pauses
// Claude; instead each view counts the output characters it was sent and has not acked
// (`tabs.ack` from the page, the router's `viewAck`). Past `highWater` the tab stops getting live
// data (it leaves the mirror); once the page has acked down to `lowWater`, it is joined again and
// gets a fresh snapshot. Snapshots are not counted (the page does not ack them, terminal-session.ts):
// a big one would otherwise trip the limit at once and resync forever. The page's acks of output
// from before a resync may land after it (up to `lowWater`), clamped at zero: a looser limit for a
// moment, never a stuck one.
//
// The connection wires `select` to the view's own tab selection and `ack` to its acks. Never
// trusted: the tab must pass `canFollow` (a tab of the view's own window, checked by main), whatever
// id the page sent.

import type { TermDataFrame, TermSnapshotFrame } from '../../shared/web-protocol'
import type { MirrorView } from '../terminals/mirror'
import { VIEW_HIGH_WATER, VIEW_LOW_WATER } from '../terminals/desktop-flow'
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
  /** A send failed for this tab; the view already left it, so the page must resync (select again). */
  failed?(tabId: string, err: unknown): void
  /** Flow limits in output characters (VIEW_HIGH_WATER / VIEW_LOW_WATER); tests pass small ones. */
  highWater?: number
  lowWater?: number
}

interface Followed {
  /** The mirror's leave function of the current join; null while behind. */
  leave: (() => void) | null
  /** Identity of the current join: callbacks of an older one are ignored. */
  join: object | null
  /** Output characters sent live and not acked by the page. */
  unacked: number
  /** Over the limit: no live data until the page acks down to the low mark, then a fresh join. */
  behind: boolean
}

export class ViewTerminals {
  private readonly followed = new Map<string, Followed>()
  private disposed = false
  private readonly high: number
  private readonly low: number

  constructor(private readonly deps: ViewTerminalsDeps) {
    this.high = deps.highWater ?? VIEW_HIGH_WATER
    this.low = deps.lowWater ?? VIEW_LOW_WATER
  }

  /**
   * The view shows this tab now. Joins it (a snapshot follows, then live items) unless the view
   * already follows it. False when the tab cannot be followed: not the view's, or the mirror does
   * not hold it (web access going off, a tab started before the mirror).
   */
  select(tabId: string): boolean {
    if (this.disposed) return false
    if (this.followed.has(tabId)) return true
    if (!this.deps.canFollow(tabId)) return false
    const f: Followed = { leave: null, join: null, unacked: 0, behind: false }
    this.followed.set(tabId, f)
    if (this.join(tabId, f)) return true
    this.followed.delete(tabId)
    return false
  }

  /** The page wrote `count` characters of the tab's live output into its terminal. */
  ack(tabId: string, count: number): void {
    const f = this.followed.get(tabId)
    if (!f || this.disposed || !(count > 0)) return
    f.unacked = Math.max(0, f.unacked - count)
    if (f.behind && f.unacked <= this.low) {
      f.behind = false
      // The tab went while the view was behind: nothing to resync.
      if (!this.join(tabId, f)) this.followed.delete(tabId)
    }
  }

  /** Stop following a tab (a resync joins it again). */
  leave(tabId: string): void {
    const f = this.followed.get(tabId)
    if (!f) return
    this.followed.delete(tabId)
    this.part(f)
  }

  /** Tabs the view follows now, behind ones included (tests, diagnostics). */
  following(): string[] {
    return [...this.followed.keys()]
  }

  /** Whether the tab is behind: no live data until the page catches up (tests, diagnostics). */
  isBehind(tabId: string): boolean {
    return this.followed.get(tabId)?.behind === true
  }

  /** The view is gone: leave every tab; nothing is sent after this. */
  dispose(): void {
    this.disposed = true
    for (const tabId of [...this.followed.keys()]) this.leave(tabId)
  }

  private part(f: Followed): void {
    const leave = f.leave
    f.leave = null
    f.join = null
    leave?.()
  }

  /** Join the mirror for `f` (a snapshot, then live items); false when the mirror does not hold the tab. */
  private join(tabId: string, f: Followed): boolean {
    this.part(f)
    const join = {}
    f.join = join
    const leave = this.deps.mirror.join(tabId, this.viewOf(tabId, f, join))
    if (!leave) {
      f.join = null
      return false
    }
    if (f.join !== join) leave()
    else f.leave = leave
    return true
  }

  /**
   * A failed send (socket closing, a part over the cap) may leave the page with a partial snapshot
   * or a gap in the stream; the mirror would keep the view live and the screen would diverge. So
   * the tab is left and the connection told: it resyncs by selecting the tab again.
   */
  private guarded(tabId: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.leave(tabId)
      this.deps.failed?.(tabId, err)
    }
  }

  private viewOf(tabId: string, f: Followed, join: object): MirrorView {
    const maxBytes = this.deps.maxFrameBytes ?? MAX_FRAME_BYTES
    const current = (): boolean => !this.disposed && this.followed.get(tabId) === f && f.join === join
    return {
      // The parts go out back to back, in one call: nothing of this tab can come between them.
      snapshot: (snapshot) => {
        if (!current()) return
        this.guarded(tabId, () => {
          for (const frame of termSnapshotFrames(tabId, snapshot, maxBytes)) this.deps.send(frame)
        })
      },
      item: (item) => {
        if (!current()) return
        if (item.kind === 'data') {
          if (f.unacked >= this.high) {
            // Behind: no live data until the page catches up, then a fresh snapshot (ack).
            this.part(f)
            f.behind = true
            return
          }
          f.unacked += item.data.length
        }
        this.guarded(tabId, () => {
          const frame = termDataFrame(tabId, item)
          if (frame) this.deps.send(frame)
        })
      },
      closed: () => {
        if (!current()) return
        // The mirror dropped this join. A closed tab (or a mirror that stopped) cannot be joined
        // again and is forgotten; a snapshot that never came, or came out of step, is asked again.
        f.leave = null
        f.join = null
        if (!this.join(tabId, f)) this.followed.delete(tabId)
      }
    }
  }
}
