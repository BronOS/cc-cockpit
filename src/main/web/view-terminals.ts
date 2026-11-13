// The terminal streams of one view (design-web.md §5.2, plan Tasks 11 and 12): which tabs the view
// follows in the headless mirror (terminals/mirror.ts), the `term.snapshot` / `term.data` frames it
// gets for them (protocol.ts), and its flow control.
//
// Only the visible tab is snapshotted: a view joining a window with ten Claude tabs gets one
// snapshot (up to 5,000 lines of scrollback, several MiB), not ten. Another tab is joined when the
// view selects it. A tab joined once stays followed while the view lasts, as the desktop keeps every
// tab's terminal parsing whether it shows or not: going back to it costs nothing, and its xterm in
// the page is current. A tab that closes is forgotten; a stream that ends for any other reason
// (mirror.ts `MirrorView.closed`: the worker had no terminal for it, or the snapshot came out of
// step) is joined again while the mirror still holds the tab, MAX_REJOINS times in a row at most;
// then the tab is left and the connection told (`failed`), as for a send that failed.
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
// A tab the view selected while the mirror did not hold it (a restored command tab waiting for its
// first Restart has no pty, so nothing to mirror) is remembered and joined when it starts
// (`started`, from TabManager's lifecycle): a restart keeps the page's selection, so the page never
// selects it again, and its terminal would stay blank until the person switched tabs. A tab closed
// before it ever started is forgotten (`closed`, from the lifecycle too): ids are never reused, so it
// would only sit in the set for the connection's life.
//
// Split groups (team run 001 design §1 "Web and cost"): a view that selects a member of a group shows
// every pane of it, so it follows every member (`selectGroup`, the list from main's own TabGroups,
// never from the page). The selected (focused) pane is joined first; the others one at a time, each
// only after the previous one's snapshot went out and the socket drained below JOIN_DRAIN_BYTES: a
// 4-pane Claude group is ~4 snapshots of several MiB, which joined at once would sit in the socket
// together against SOCKET_HIGH_WATER (connection.ts) and close the view. A member already followed
// costs nothing and is skipped. Selecting again (another group, or the same group after it gained a
// member) replaces whatever is still queued.
//
// The connection wires `select` to the view's own tab selection and `ack` to its acks. Never
// trusted: the tab must pass `canFollow` (a tab of the view's own window, checked by main), whatever
// id the page sent.

import type { TermDataFrame, TermSnapshotFrame } from '../../shared/web-protocol'
import type { MirrorView } from '../terminals/mirror'
import { MAX_REJOINS, VIEW_HIGH_WATER, VIEW_LOW_WATER } from '../terminals/desktop-flow'
import { MAX_FRAME_BYTES, termDataFrame, termSnapshotFrames } from './protocol'

/**
 * The next member of a group is joined only once the view's socket holds less than this unsent: the
 * previous snapshot has left, give or take live output.
 */
export const JOIN_DRAIN_BYTES = 1024 * 1024
/** How often a queued join looks at the socket again while it is above JOIN_DRAIN_BYTES. */
export const JOIN_DRAIN_POLL_MS = 50

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
  /** The tab's snapshot went out whole: the page's screen is in step again. */
  synced?(tabId: string): void
  /** Flow limits in output characters (VIEW_HIGH_WATER / VIEW_LOW_WATER); tests pass small ones. */
  highWater?: number
  lowWater?: number
  /** Bytes the view's socket holds unsent (`ws.bufferedAmount`); absent = always drained. */
  buffered?(): number
  /** Runs `fn` after `ms` (a later turn even at 0: never inside a mirror callback); tests pass their own. */
  defer?(fn: () => void, ms: number): void
}

/** What a join attempt did: a snapshot is on its way, the tab was already followed, or neither. */
type Start = 'joined' | 'followed' | 'none'

interface Followed {
  /** The mirror's leave function of the current join; null while behind. */
  leave: (() => void) | null
  /** Identity of the current join: callbacks of an older one are ignored. */
  join: object | null
  /** Output characters sent live and not acked by the page. */
  unacked: number
  /** Over the limit: no live data until the page acks down to the low mark, then a fresh join. */
  behind: boolean
  /** Joins in a row that ended before their snapshot (MAX_REJOINS). */
  failedJoins: number
}

export class ViewTerminals {
  private readonly followed = new Map<string, Followed>()
  /** Tabs selected while the mirror did not hold them: joined at their start (see the header). */
  private readonly waiting = new Set<string>()
  /** Group members still to join, in order (`selectGroup`). */
  private queue: string[] = []
  /** The member whose snapshot the queue waits for; undefined when nothing is in flight. */
  private head: string | undefined
  private pumpScheduled = false
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
    return this.start(tabId) !== 'none'
  }

  /**
   * The view shows a group: `tabIds` is the selected (focused) pane first, then the group's other
   * members (main's TabGroups.joinOrder). The first is joined now; each of the others after the one
   * before it is synced and the socket drained (header). Replaces any earlier queue. The answer is
   * `select`'s for the first.
   */
  selectGroup(tabIds: readonly string[]): boolean {
    if (this.disposed) return false
    const [first, ...rest] = tabIds
    this.queue = rest.filter((t) => t !== first)
    this.head = undefined
    if (first === undefined) return false
    const started = this.start(first)
    if (started === 'joined') this.head = first
    else this.schedulePump(0)
    return started !== 'none'
  }

  /** Group members still waiting for their turn (tests, diagnostics). */
  queued(): string[] {
    return this.head === undefined ? [...this.queue] : [this.head, ...this.queue]
  }

  private start(tabId: string): Start {
    if (this.disposed) return 'none'
    if (this.followed.has(tabId)) return 'followed'
    if (!this.deps.canFollow(tabId)) return 'none'
    const f: Followed = { leave: null, join: null, unacked: 0, behind: false, failedJoins: 0 }
    this.followed.set(tabId, f)
    if (this.join(tabId, f)) {
      this.waiting.delete(tabId)
      return 'joined'
    }
    this.followed.delete(tabId)
    this.waiting.add(tabId)
    return 'none'
  }

  /** The tab's snapshot went out, or it stopped being followed: the next queued member may go. */
  private unblock(tabId: string): void {
    if (this.head !== tabId) return
    this.head = undefined
    this.schedulePump(0)
  }

  private schedulePump(ms: number): void {
    if (this.pumpScheduled || this.disposed || this.queue.length === 0) return
    this.pumpScheduled = true
    const defer = this.deps.defer ?? ((fn: () => void, wait: number) => void setTimeout(fn, wait))
    defer(() => {
      this.pumpScheduled = false
      this.pump()
    }, ms)
  }

  /** Join queued members until one sends a snapshot (then wait for it), skipping ones already followed. */
  private pump(): void {
    if (this.disposed || this.head !== undefined) return
    if ((this.deps.buffered?.() ?? 0) > JOIN_DRAIN_BYTES) return this.schedulePump(JOIN_DRAIN_POLL_MS)
    while (this.queue.length > 0) {
      const tabId = this.queue.shift()!
      if (this.start(tabId) === 'joined') {
        this.head = tabId
        return
      }
    }
  }

  /**
   * The tab's process started (a new tab, a restart, a restored tab's first run): the mirror holds
   * it now. A tab the view selected before, when there was nothing to join, is joined; any other
   * is left alone (the view joins it when it selects it).
   */
  started(tabId: string): void {
    if (this.disposed || !this.waiting.has(tabId)) return
    this.waiting.delete(tabId)
    this.select(tabId)
  }

  /** The tab is gone (TabManager's lifecycle `closed`): one still waiting for its start never will. */
  closed(tabId: string): void {
    this.waiting.delete(tabId)
  }

  /** Tabs selected and waiting for their start (tests, diagnostics). */
  waitingFor(): string[] {
    return [...this.waiting]
  }

  /** The page wrote `count` characters of the tab's live output into its terminal. */
  ack(tabId: string, count: number): void {
    const f = this.followed.get(tabId)
    // Page-supplied: an ack beyond what was sent (Infinity) only clamps to zero, and the socket's own
    // bound (connection.ts SOCKET_HIGH_WATER) still closes a view that keeps acking and never reads.
    if (!f || this.disposed || !(count > 0) || !Number.isFinite(count)) return
    f.unacked = Math.max(0, f.unacked - count)
    if (f.behind && f.unacked <= this.low) {
      f.behind = false
      // The tab went while the view was behind: nothing to resync.
      if (!this.join(tabId, f)) {
        this.followed.delete(tabId)
        this.unblock(tabId)
      }
    }
  }

  /** Stop following a tab (a resync joins it again). */
  leave(tabId: string): void {
    const f = this.followed.get(tabId)
    if (!f) return
    this.followed.delete(tabId)
    this.part(f)
    this.unblock(tabId)
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
    this.waiting.clear()
    this.queue = []
    this.head = undefined
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
        let sent = false
        this.guarded(tabId, () => {
          for (const frame of termSnapshotFrames(tabId, snapshot, maxBytes)) this.deps.send(frame)
          sent = true
        })
        if (!sent) return
        f.failedJoins = 0
        this.deps.synced?.(tabId)
        this.unblock(tabId)
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
        if (++f.failedJoins >= MAX_REJOINS) {
          // Not looping between main and the worker: the connection resyncs once, then closes.
          this.followed.delete(tabId)
          this.unblock(tabId)
          this.deps.failed?.(tabId, new Error(`no snapshot after ${MAX_REJOINS} joins`))
          return
        }
        if (!this.join(tabId, f)) {
          this.followed.delete(tabId)
          this.unblock(tabId)
        }
      }
    }
  }
}
