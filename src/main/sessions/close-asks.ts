// ctx.sessions.close goes through the person's close path (design-next §4.1): the window's tab pane
// decides, exactly as for its own × button, whether a running tab asks first (CloseTabDialog, the
// `confirmTabClose` setting), and only it can tell whether the person pressed Close or Cancel. So
// main asks the window (`sessions.closeAsk` with a request id) and waits for its answer
// (`sessions.closeAnswer`). This is the waiting half: one pending ask per request id, answered only
// by the window it went to, settled `false` when that window closes or the wait runs out, so the
// plugin's call always ends.
//
// Shared ask (design-web.md §5.1, plan Task 23): a window can have several live views (the desktop
// page and browser views), and every one of them shows the ask. The first answer from any view of
// that window wins; main then tells every view (`settled`, the `sessions.closeSettled` event) so the
// others take their dialog down, and a view joining mid-ask finds it in its `ready` snapshot
// (`pending`). One exception to "first answer": a view that could not ask at all (another dialog, a
// screen or an overlay over it) says `declined`, which only counts once every live view of the
// window declined. Otherwise a browser left on the settings screen would cancel, unseen, the dialog
// the person is looking at on the desktop.
//
// No Electron import: the hooks are functions (index.ts posts through the ViewRegistry), so vitest
// drives it.

import type { ViewId } from '../../shared/views'

/**
 * How long a close waits for the window's answer. The dialog waits for the person; a plugin call must
 * still end (the host passes no RPC timeout for it). Past this the call answers `closed: false`.
 */
export const CLOSE_ASK_MS = 5 * 60_000

/**
 * Whether a plugin's close of this tab will put a dialog in front of the person: the renderer asks
 * for every tab whose process is alive (close-confirm.ts `closeQuestion`, an idle Claude included)
 * while the setting is on. Main raises the window only then, so a close that never asks does not
 * pull the window forward.
 */
export function closeWillAsk(tab: { exit?: unknown }, confirmTabClose: boolean): boolean {
  return tab.exit === undefined && confirmTabClose
}

/** How main reaches a window's views for its asks (index.ts: the ViewRegistry). */
export interface CloseAskHooks {
  /** Post the ask to every view of the window; false when no view took it (nothing will answer). */
  send(windowId: number, ask: CloseAskInfo): boolean
  /** The ask is over: tell every view of the window, so the ones still asking stop. */
  settled?(windowId: number, requestId: string): void
  /**
   * Close the ask's tab: a Close answer from `viewId` won the ask. The tab id is the one main asked
   * about, never one a view sent. True for a tab already gone (it is closed, as asked); false (or a
   * throw) when it could not be closed: the plugin hears `closed: false`.
   */
  close(windowId: number, viewId: ViewId, tabId: string): boolean
  /**
   * The window's live views now (ViewRegistry.viewsOf). Absent: a decline settles at once, as a
   * window with one view would.
   */
  viewsOf?(windowId: number): readonly ViewId[]
}

/** One pending ask as the views get it (the `sessions.closeAsk` payload, and `ready`'s list). */
export interface CloseAskInfo {
  requestId: string
  tabId: string
}

/** A view's answer: `declined` when it could not ask (see the top of the file). */
export interface CloseAskAnswer {
  closed: boolean
  declined?: boolean
}

interface PendingAsk {
  windowId: number
  tabId: string
  resolve: (closed: boolean) => void
  timer: ReturnType<typeof setTimeout>
  /** Views of the window that said they could not ask. */
  declined: Set<ViewId>
}

export class CloseAsks {
  private next = 1
  private readonly pending = new Map<string, PendingAsk>()

  constructor(
    private readonly hooks: CloseAskHooks,
    private readonly timeoutMs = CLOSE_ASK_MS
  ) {}

  /** Ask `windowId` to close `tabId` the person's way; true once it closed. */
  ask(windowId: number, tabId: string): Promise<boolean> {
    const requestId = `close-${this.next++}`
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, false), this.timeoutMs)
      // A pending ask must not keep main alive at quit.
      timer.unref?.()
      this.pending.set(requestId, { windowId, tabId, resolve, timer, declined: new Set() })
      let sent: boolean
      try {
        sent = this.hooks.send(windowId, { requestId, tabId })
      } catch {
        sent = false
      }
      if (!sent) this.settle(requestId, false)
    })
  }

  /**
   * A view's answer. Only a view of the window the ask went to settles it (the router took the
   * window and the view from the sender, never from the payload): another window naming the id is
   * ignored. The first answer wins; a decline waits for the others (see the top of the file). False
   * for an unknown or settled id, and for another window's view. A winning Close closes the tab here
   * (the `close` hook) and answers whether it did: the view drops the tab only on true.
   */
  answer(windowId: number, viewId: ViewId, requestId: string, answer: CloseAskAnswer): boolean {
    const ask = this.pending.get(requestId)
    if (!ask || ask.windowId !== windowId) return false
    if (answer.declined === true) {
      ask.declined.add(viewId)
      this.settleIfAllDeclined(requestId, ask)
      return true
    }
    if (answer.closed !== true) {
      this.settle(requestId, false)
      return true
    }
    let closed: boolean
    try {
      closed = this.hooks.close(ask.windowId, viewId, ask.tabId)
    } catch {
      closed = false
    }
    this.settle(requestId, closed)
    return closed
  }

  /**
   * The asks still waiting in `windowId`, oldest first: a view joining mid-ask gets them in its
   * `ready` snapshot and shows them as the others do.
   */
  pendingFor(windowId: number): CloseAskInfo[] {
    const out: CloseAskInfo[] = []
    for (const [requestId, ask] of this.pending) if (ask.windowId === windowId) out.push({ requestId, tabId: ask.tabId })
    return out
  }

  /**
   * A view left (a browser closed its socket). An ask every remaining view declined will never be
   * answered: it ends now rather than at the timeout.
   */
  viewGone(): void {
    for (const [id, ask] of [...this.pending]) if (ask.declined.size > 0) this.settleIfAllDeclined(id, ask)
  }

  /** The window closed: its asks will never be answered. Its tabs are gone with it, but the plugin did not close them. */
  windowClosed(windowId: number): void {
    for (const [id, ask] of [...this.pending]) if (ask.windowId === windowId) this.settle(id, false)
  }

  /** Asks still waiting (tests). */
  get size(): number {
    return this.pending.size
  }

  private settleIfAllDeclined(requestId: string, ask: PendingAsk): void {
    // Without a view list a decline is the window's answer (one view). A view that joined after the
    // ask went out has not declined: it got the ask in `ready` and may still show it.
    const views = this.hooks.viewsOf?.(ask.windowId)
    if (views === undefined || views.every((v) => ask.declined.has(v))) this.settle(requestId, false)
  }

  private settle(requestId: string, closed: boolean): void {
    const ask = this.pending.get(requestId)
    if (!ask) return
    this.pending.delete(requestId)
    clearTimeout(ask.timer)
    ask.resolve(closed)
    try {
      this.hooks.settled?.(ask.windowId, requestId)
    } catch {
      // Best effort: a view that missed it still has its dialog, whose late answer finds nothing.
    }
  }
}
