// A plugin's close ask (`sessions.closeAsk`) for a tab this view's strip does not show yet. The usual
// case is a plugin's `ctx.sessions.open` followed at once by `ctx.sessions.close`: main sent the tab's
// `tabs.added` before the ask, on the same channel, but the tab pane reads its tabs from the last
// React commit, so the ask can come in before the tab is in the strip. Declining it then would make
// the plugin's close fail (with web access off the desktop is the only view, so its decline settles
// the ask), where before the shared asks it closed the tab.
//
// So an ask that arrives once the view has its list waits here for the tab to show up and is then
// asked the normal way (a running tab still asks first). One whose tab never shows up (closed in the
// meantime) is handed back after UNLISTED_ASK_MS, and the pane declines it as it declines every ask
// about a tab it does not hold. Asks replayed before the list never come here: they wait for the
// list itself, and an unknown tab then is declined at once (never closed unconfirmed).
//
// Pure (timers only), so vitest drives it without a DOM.

/** How long an ask waits for its tab to reach the strip before the pane declines it. */
export const UNLISTED_ASK_MS = 2000

export class UnlistedCloseAsks {
  private readonly parked = new Map<string, { tabId: string; timer: ReturnType<typeof setTimeout> }>()

  /** `run`: ask about the tab now (found, or the wait ran out); called once per parked ask. */
  constructor(
    private readonly run: (requestId: string, tabId: string) => void,
    private readonly waitMs = UNLISTED_ASK_MS
  ) {}

  /** Wait for `tabId` to reach the strip. A repeat of a parked request id is ignored. */
  park(requestId: string, tabId: string): void {
    if (this.parked.has(requestId)) return
    const timer = setTimeout(() => this.release(requestId), this.waitMs)
    this.parked.set(requestId, { tabId, timer })
  }

  /** The strip changed: every parked ask whose tab it now holds is asked, oldest first. */
  tabsChanged(holds: (tabId: string) => boolean): void {
    for (const [requestId, { tabId }] of [...this.parked]) if (holds(tabId)) this.release(requestId)
  }

  /** Asks still waiting (tests). */
  get size(): number {
    return this.parked.size
  }

  /** The pane is going: drop every wait, run nothing. */
  clear(): void {
    for (const { timer } of this.parked.values()) clearTimeout(timer)
    this.parked.clear()
  }

  private release(requestId: string): void {
    const ask = this.parked.get(requestId)
    if (!ask) return
    this.parked.delete(requestId)
    clearTimeout(ask.timer)
    this.run(requestId, ask.tabId)
  }
}
