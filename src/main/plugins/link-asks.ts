// The in-page confirm of `ccc plugin link` while a browser view is attached (design-web.md §5.1 and
// §6.1, plan Task 25). The native message box is the desktop's own screen: a person working from a
// browser cannot see or answer it. So with a remote view in the window the confirm becomes a shared
// ask, like a plugin's close ask (close-asks.ts): every view of the window shows the same dialog, the
// first answer from any of them wins, main tells the others it is settled (`links.settled`), and a
// view joining mid-ask finds it in its `ready` snapshot. With no remote view attached the native
// dialog (link-dialog.ts) is used as before, so a desktop-only person sees no change. In server mode
// it is always the shared ask (chooseLinkConfirm).
//
// Who may Allow (plan Task 25, review; design-web.md §9.6): a linked plugin runs with full access to
// the host. On the desktop, §6.1 keeps plugin linking off remote views ("do it on the desktop"): a
// browser view sees the ask and may Deny it, but its Allow is refused and the ask keeps waiting for
// the desktop (or runs out). In server mode there is no desktop, every signed-in device is the owner,
// so any view may Allow (`!view.remote || server`). Whether the answer is remote is the router's (the
// view main bound to the call) and `server` is main's flag for the run, never anything the page sent.
//
// Never allows by itself: no view to show it, a closed window, a vanished `ccc` caller (`signal`) or
// the wait running out all settle Deny. The CLI waits for the person with no timeout, but this ask
// must end (a window can sit unattended), so it carries LINK_ASK_MS like the close ask. The waiting
// itself (first answer wins, `settled`, the timeout, `pendingFor`) is the shared-ask core
// (asks/shared-asks.ts), which the trash confirm uses too.
//
// No Electron import: the hooks are functions (index.ts posts through the ViewRegistry).

import { SharedAsks } from '../asks/shared-asks'
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

export interface LinkAskOptions {
  /** Main's server-mode flag (server-mode.ts): every view is the owner and may Allow. */
  server?: boolean
}

export class LinkAsks {
  private readonly core: SharedAsks<LinkDialogInfo, boolean>
  private readonly server: boolean

  constructor(hooks: LinkAskHooks, timeoutMs = LINK_ASK_MS, options: LinkAskOptions = {}) {
    this.core = new SharedAsks<LinkDialogInfo, boolean>({ hooks, prefix: 'link', refused: false, timeoutMs })
    this.server = options.server === true
  }

  /** Ask every view of `windowId`; true only when a view answered Allow. */
  ask(windowId: number, info: LinkDialogInfo, signal?: AbortSignal): Promise<boolean> {
    return this.core.ask(windowId, info, signal)
  }

  /**
   * A view's answer. The router took the window and `remote` from the sender, never from the
   * payload: another window naming the id is ignored. First answer wins; false for an unknown or
   * settled id, and on the desktop for a remote view's Allow, which leaves the ask waiting for the
   * desktop. In server mode any view of the window is the owner: its Allow is taken.
   */
  answer(windowId: number, requestId: string, allow: boolean, from: { remote: boolean }): boolean {
    if (!this.core.isPending(windowId, requestId)) return false
    const allowed = allow === true
    // A `remote` that is not exactly false is never the desktop.
    const owner = from.remote === false || this.server
    if (allowed && !owner) return false
    return this.core.answer(windowId, requestId, allowed)
  }

  /** The asks still waiting in `windowId`, oldest first (`ready`'s `linkAsks`). */
  pendingFor(windowId: number): LinkAskInfo[] {
    return this.core.pendingFor(windowId)
  }

  /** The window closed: nobody can answer, so Deny. */
  windowClosed(windowId: number): void {
    this.core.windowClosed(windowId)
  }

  get size(): number {
    return this.core.size
  }
}

/**
 * The confirm `ccc plugin link` uses: the shared in-page ask when the window has a browser view
 * attached, else the native dialog. Decided per call from the live view list, so a browser that
 * joins while a native dialog is up is not shown a second one (the desktop's sheet stays the
 * answer for that request).
 *
 * In server mode always the shared ask (design-web.md §9.6): the native dialog aborts main under
 * Ozone headless, and a test run's queued fake (the `native` passed in a test run) would answer what
 * the browser should. With no browser attached the hidden page takes the ask, so it waits there for
 * a browser to join (`ready.linkAsks`) or runs out.
 */
export function chooseLinkConfirm(options: {
  /** Main's server-mode flag for the run. */
  server?: boolean
  hasRemoteView(windowId: number): boolean
  shared: (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean>
  native: (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean>
}): (windowId: number, info: LinkDialogInfo, signal?: AbortSignal) => Promise<boolean> {
  return (windowId, info, signal) =>
    options.server === true || options.hasRemoteView(windowId) ? options.shared(windowId, info, signal) : options.native(windowId, info, signal)
}
