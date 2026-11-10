// The desktop view's terminal output while main is the pty's flow consumer (design-web.md §5.2
// "Every view, desktop included, drops and resyncs", plan Task 12).
//
// With web access on, the headless copy acks the pty (mirror.ts), so the desktop's `tabs.ack` no
// longer pauses Claude: a renderer that cannot keep up (`cat` of a big file, a window busy
// elsewhere) would otherwise be sent output without bound, the freeze HIGH_WATER exists to prevent.
// So the desktop is flow-controlled on its own, per tab, like a remote view:
//
// - `live`: TabManager emits each flushed chunk to the desktop as before (the same chunks, in the
//   same order, the mirror numbers), counting what the renderer has not acked yet;
// - `behind`: past `highWater` unacked, the desktop stops getting live output. Its xterm still
//   parses (and acks) what it was sent; once that is down to `lowWater`, it is resynced:
// - `joining`: the tab is joined in the mirror (mirror.ts `join`): a snapshot comes, sent as one
//   `tabs.data` with `reset` (the renderer starts its terminal over with it), then the items after
//   it. When the item delivered is the newest one the mirror numbered, the desktop has caught up:
//   it leaves the mirror and is `live` again, so in steady state its output never waits on the
//   worker.
//
// The snapshot is never counted (the renderer does not ack it, terminal-session.ts): it is one
// screen, sent only once the renderer has caught up, and counting it would trip a large one
// straight back into `behind`. Acks of output from before a resync can still arrive after it (up to
// `lowWater`); they land on the fresh count, clamped at zero, so the limit is a little loose, never
// stuck.
//
// A page that reloads asks for its tabs again (`TabManager.attach`): instead of today's
// `resetFlow`, every tab held here is resynced, so a reload gets its screens back.
//
// Only tabs the mirror `take`s are held here; every other tab (web access off, a tab started before
// the mirror) keeps today's path untouched: emitted as read, acked to the pty.

import { HIGH_WATER } from '../pty/pty-service'
import type { MirrorView } from './mirror'

/**
 * Unacked characters past which a view stops getting live output. The same as the pty's own
 * HIGH_WATER (pty-service.ts): what the desktop's xterm was trusted to hold before.
 */
export const VIEW_HIGH_WATER = HIGH_WATER
/** Rejoin once the view is down to this, as the pty resumes at LOW_WATER (no flapping). */
export const VIEW_LOW_WATER = VIEW_HIGH_WATER / 2

export interface DesktopFlowDeps {
  /** Output for the desktop view (`tabs.data`); `reset`: a whole screen, the terminal starts over. */
  emit(tabId: string, data: string, reset: boolean): void
  /** The mirror's `join` (TerminalTap); undefined when it does not hold the tab. */
  join(tabId: string, view: MirrorView): (() => void) | undefined
  /** The newest item the mirror numbered for the tab. */
  seq(tabId: string): number | undefined
  log(message: string): void
  highWater?: number
  lowWater?: number
}

type Mode = 'live' | 'behind' | 'joining'

interface TabFlow {
  mode: Mode
  /** Characters emitted live and not acked by the renderer yet. */
  unacked: number
  /** The current join (identity: callbacks of an older one are ignored) and its leave function. */
  join: object | null
  leave: (() => void) | null
}

export class DesktopFlow {
  private readonly tabs = new Map<string, TabFlow>()
  private readonly high: number
  private readonly low: number

  constructor(private readonly deps: DesktopFlowDeps) {
    this.high = deps.highWater ?? VIEW_HIGH_WATER
    this.low = deps.lowWater ?? VIEW_LOW_WATER
  }

  /** Main consumes this tab's pty now: the desktop is counted from here, live. A restart keeps the state. */
  take(tabId: string): void {
    if (!this.tabs.has(tabId)) this.tabs.set(tabId, { mode: 'live', unacked: 0, join: null, leave: null })
  }

  /** Back to today's path (the mirror stopped or gave up, the tab closed). */
  release(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.tabs.delete(tabId)
    this.leave(t)
    // Nothing is left to resync from: the screen stays as it was until new output redraws it.
    if (t.mode !== 'live') this.deps.log(`terminal flow: tab ${tabId} released while the desktop was behind; its screen may be stale`)
  }

  /** Whether the desktop's output and acks for this tab go through here. */
  holds(tabId: string): boolean {
    return this.tabs.has(tabId)
  }

  /** The mode of a held tab (tests, diagnostics). */
  modeOf(tabId: string): Mode | undefined {
    return this.tabs.get(tabId)?.mode
  }

  /** Unacked characters of a held tab (tests, diagnostics). */
  unackedOf(tabId: string): number {
    return this.tabs.get(tabId)?.unacked ?? 0
  }

  /**
   * A flushed chunk of the tab: true when TabManager emits it to the desktop now. False while the
   * desktop is behind, or joining (the join delivers it).
   */
  data(tabId: string, chunk: string): boolean {
    const t = this.tabs.get(tabId)
    if (!t) return true
    if (t.mode !== 'live') return false
    if (t.unacked >= this.high) {
      t.mode = 'behind'
      return false
    }
    t.unacked += chunk.length
    return true
  }

  /** The renderer wrote `count` characters of live output into its xterm. */
  ack(tabId: string, count: number): void {
    const t = this.tabs.get(tabId)
    if (!t || !(count > 0)) return
    t.unacked = Math.max(0, t.unacked - count)
    if (t.mode === 'behind' && t.unacked <= this.low) this.rejoin(tabId, t)
  }

  /** The page (re)attached: what the old page was sent is gone with it; it gets a snapshot. */
  resync(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.unacked = 0
    this.rejoin(tabId, t)
  }

  /** The tab is gone. */
  closed(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.tabs.delete(tabId)
    this.leave(t)
  }

  private leave(t: TabFlow): void {
    const leave = t.leave
    t.join = null
    t.leave = null
    leave?.()
  }

  private rejoin(tabId: string, t: TabFlow): void {
    this.leave(t)
    const join = {}
    const current = (): boolean => this.tabs.get(tabId) === t && t.join === join
    const view: MirrorView = {
      snapshot: (snapshot) => {
        if (!current()) return
        this.deps.emit(tabId, snapshot.data, true)
        this.caughtUp(tabId, t, snapshot.seq)
      },
      item: (item) => {
        if (!current()) return
        if (item.kind === 'data') {
          if (t.unacked >= this.high) {
            // Behind again before it caught up (the stream outran the page): drop, resync later.
            this.leave(t)
            t.mode = 'behind'
            return
          }
          t.unacked += item.data.length
          this.deps.emit(tabId, item.data, false)
        }
        // Sizes and a restart's spawn: the desktop's xterm sizes the pty itself (Task 15 per view).
        this.caughtUp(tabId, t, item.seq)
      },
      closed: () => {
        if (!current()) return
        t.join = null
        t.leave = null
        // The snapshot never came (timed out, out of step) and the mirror still holds the tab: ask
        // again. A mirror that stopped returns no join, and its release follows.
        this.rejoin(tabId, t)
      }
    }
    t.mode = 'joining'
    t.join = join
    const leave = this.deps.join(tabId, view)
    if (!current()) {
      // Ended or replaced from inside the join itself (cannot happen today; kept safe).
      leave?.()
      return
    }
    if (!leave) {
      // The mirror does not hold the tab (stopping, or closed): live as it is; a release follows.
      t.join = null
      t.mode = 'live'
      return
    }
    t.leave = leave
  }

  /** The desktop has every item up to `seq`: when that is the newest, it goes back to the direct path. */
  private caughtUp(tabId: string, t: TabFlow, seq: number): void {
    if (t.mode !== 'joining' || seq !== this.deps.seq(tabId)) return
    this.leave(t)
    t.mode = 'live'
  }
}
