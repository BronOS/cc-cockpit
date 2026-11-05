// ctx.sessions.close goes through the person's close path (design-next §4.1): the window's tab pane
// decides, exactly as for its own × button, whether a running tab asks first (CloseTabDialog, the
// `confirmTabClose` setting), and only it can tell whether the person pressed Close or Cancel. So
// main asks the window (`sessions.closeAsk` with a request id) and waits for its answer
// (`sessions.closeAnswer`). This is the waiting half: one pending ask per request id, answered only
// by the window it went to, settled `false` when that window closes or the wait runs out, so the
// plugin's call always ends.
//
// No Electron import: `send` is a function (index.ts posts to the window), so vitest drives it.

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

interface PendingAsk {
  windowId: number
  resolve: (closed: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class CloseAsks {
  private next = 1
  private readonly pending = new Map<string, PendingAsk>()

  constructor(
    /** Post the ask to the window; false when the window is gone (nothing will answer). */
    private readonly send: (windowId: number, ask: { requestId: string; tabId: string }) => boolean,
    private readonly timeoutMs = CLOSE_ASK_MS
  ) {}

  /** Ask `windowId` to close `tabId` the person's way; true once it closed. */
  ask(windowId: number, tabId: string): Promise<boolean> {
    const requestId = `close-${this.next++}`
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, false), this.timeoutMs)
      // A pending ask must not keep main alive at quit.
      timer.unref?.()
      this.pending.set(requestId, { windowId, resolve, timer })
      let sent: boolean
      try {
        sent = this.send(windowId, { requestId, tabId })
      } catch {
        sent = false
      }
      if (!sent) this.settle(requestId, false)
    })
  }

  /**
   * The window's answer. Only the window the ask went to settles it (the router took the window from
   * the sender): another window naming the id is ignored. False for an unknown or settled id.
   */
  answer(windowId: number, requestId: string, closed: boolean): boolean {
    const ask = this.pending.get(requestId)
    if (!ask || ask.windowId !== windowId) return false
    this.settle(requestId, closed === true)
    return true
  }

  /** The window closed: its asks will never be answered. Its tabs are gone with it, but the plugin did not close them. */
  windowClosed(windowId: number): void {
    for (const [id, ask] of [...this.pending]) if (ask.windowId === windowId) this.settle(id, false)
  }

  /** Asks still waiting (tests). */
  get size(): number {
    return this.pending.size
  }

  private settle(requestId: string, closed: boolean): void {
    const ask = this.pending.get(requestId)
    if (!ask) return
    this.pending.delete(requestId)
    clearTimeout(ask.timer)
    ask.resolve(closed)
  }
}
