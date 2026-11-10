// The in-page confirm of `ccc plugin link` while a browser view is attached (design-web.md §5.1 and
// §6.1, plan Task 25). The native message box is the desktop's own screen: a person working from a
// browser cannot see or answer it. So with a remote view in the window the confirm becomes a shared
// ask, like a plugin's close ask (close-asks.ts): every view of the window shows the same dialog, the
// first answer from any of them wins, main tells the others it is settled (`links.settled`), and a
// view joining mid-ask finds it in its `ready` snapshot. With no remote view attached the native
// dialog (link-dialog.ts) is used as before, so a desktop-only person sees no change.
//
// Only the desktop can Allow (plan Task 25, review): a linked plugin runs with full access to the
// host, and design-web.md §6.1 keeps plugin linking off remote views ("do it on the desktop"). A
// browser view sees the ask and may Deny it, but its Allow is refused and the ask keeps waiting for
// the desktop (or runs out). Whether the answer is remote is the router's (the view main bound to
// the call), never anything the page sent.
//
// Never allows by itself: no view to show it, a closed window, a vanished `ccc` caller (`signal`) or
// the wait running out all settle Deny. The CLI waits for the person with no timeout, but this ask
// must end (a window can sit unattended), so it carries LINK_ASK_MS like the close ask.
//
// No Electron import: the hooks are functions (index.ts posts through the ViewRegistry).

import type { LinkDialogInfo } from './link-request'

/** How long the dialog waits for an answer; past it the link is not made. */
export const LINK_ASK_MS = 5 * 60_000

/** One pending confirm as the views get it (the `links.ask` payload, and `ready`'s list). */
export interface LinkAskInfo extends LinkDialogInfo {
  requestId: string
}

export interface LinkAskHooks {
  /** Post the ask to every view of the window; false when no view took it. */
  send(windowId: number, ask: LinkAskInfo): boolean
  /** The ask is over: tell every view of the window. */
  settled?(windowId: number, requestId: string): void
}

interface Pending {
  windowId: number
  info: LinkAskInfo
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
  offAbort?: () => void
}

export class LinkAsks {
  private next = 1
  private readonly pending = new Map<string, Pending>()

  constructor(
    private readonly hooks: LinkAskHooks,
    private readonly timeoutMs = LINK_ASK_MS
  ) {}

  /** Ask every view of `windowId`; true only when a view answered Allow. */
  ask(windowId: number, info: LinkDialogInfo, signal?: AbortSignal): Promise<boolean> {
    const requestId = `link-${this.next++}`
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) return resolve(false)
      const timer = setTimeout(() => this.settle(requestId, false), this.timeoutMs)
      timer.unref?.()
      const entry: Pending = { windowId, info: { requestId, ...info }, resolve, timer }
      if (signal) {
        const onAbort = (): void => this.settle(requestId, false)
        signal.addEventListener('abort', onAbort, { once: true })
        entry.offAbort = () => signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, entry)
      let sent: boolean
      try {
        sent = this.hooks.send(windowId, entry.info)
      } catch {
        sent = false
      }
      if (!sent) this.settle(requestId, false)
    })
  }

  /**
   * A view's answer. The router took the window and `remote` from the sender, never from the
   * payload: another window naming the id is ignored. First answer wins; false for an unknown or
   * settled id, and for a remote view's Allow, which leaves the ask waiting for the desktop.
   */
  answer(windowId: number, requestId: string, allow: boolean, from: { remote: boolean }): boolean {
    const entry = this.pending.get(requestId)
    if (!entry || entry.windowId !== windowId) return false
    const allowed = allow === true
    if (allowed && from.remote !== false) return false
    this.settle(requestId, allowed)
    return true
  }

  /** The asks still waiting in `windowId`, oldest first (`ready`'s `linkAsks`). */
  pendingFor(windowId: number): LinkAskInfo[] {
    const out: LinkAskInfo[] = []
    for (const entry of this.pending.values()) if (entry.windowId === windowId) out.push({ ...entry.info })
    return out
  }

  /** The window closed: nobody can answer, so Deny. */
  windowClosed(windowId: number): void {
    for (const [id, entry] of [...this.pending]) if (entry.windowId === windowId) this.settle(id, false)
  }

  get size(): number {
    return this.pending.size
  }

  private settle(requestId: string, allow: boolean): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.offAbort?.()
    entry.resolve(allow)
    try {
      this.hooks.settled?.(entry.windowId, requestId)
    } catch {
      // Best effort: a view that missed it still has its dialog, whose late answer finds nothing.
    }
  }
}

/**
 * The confirm `ccc plugin link` uses: the shared in-page ask when the window has a browser view
 * attached, else the native dialog. Decided per call from the live view list, so a browser that
 * joins while a native dialog is up is not shown a second one (the desktop's sheet stays the
 * answer for that request).
 */
export function chooseLinkConfirm(options: {
  hasRemoteView(windowId: number): boolean
  shared: (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean>
  native: (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean>
}): (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean> {
  return (windowId, info, signal) =>
    options.hasRemoteView(windowId) ? options.shared(windowId, info, signal) : options.native(windowId, info, signal)
}
