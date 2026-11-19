// D-9 (design-guests §7, spec-review 6): a write guest closes only the tabs it opened; closing any other tab asks
// the owner. The ask is a shared one (asks/shared-asks.ts) on every view of the window: the guest's own views never
// get it (GUEST_EVENT drops `tabs.guestCloseAsk` and `tabs.guestCloseSettled`, and `tabs.guestCloseAnswer` is
// GUEST_CLASS `no`), so the first owner view to answer wins; nobody answering within GUEST_CLOSE_ASK_MS keeps
// the tab. The asking guest's own views hear the outcome (`tabs.guestCloseDone`: closed or kept) as soon as an
// owner answers or the wait runs out, so its page says "kept the tab open" at once instead of after its own
// timer; a moot ask (tab gone, window closed, the guest ended) tells it nothing: the tab's removal or the closed
// socket says it all. Out of index.ts so a unit test drives the hooks and the timeout with the real wiring.

import type { IpcEventMap } from '../../shared/ipc'
import { SharedAsks } from '../asks/shared-asks'

/** How long the owner has to answer before the tab is kept (spec-review 6). */
export const GUEST_CLOSE_ASK_MS = 60_000

export type GuestCloseAsk = Omit<IpcEventMap['tabs.guestCloseAsk'], 'requestId'>
export type GuestCloseAsks = SharedAsks<GuestCloseAsk, boolean>

export interface GuestCloseAskViews {
  /** The ViewRegistry's `toWindow`: the ask and its settle go to every view of the window (guest sinks drop them). */
  toWindow(windowId: number, channel: 'tabs.guestCloseAsk' | 'tabs.guestCloseSettled', payload: unknown): boolean
  /** The outcome to the asking guest's own views of the window only (never an owner view, never another guest's). */
  toGuest(windowId: number, guestId: string, channel: 'tabs.guestCloseDone', payload: IpcEventMap['tabs.guestCloseDone']): void
}

/** The shared ask on every view of the window. */
export function createGuestCloseAsks(views: GuestCloseAskViews, timeoutMs = GUEST_CLOSE_ASK_MS): GuestCloseAsks {
  return new SharedAsks<GuestCloseAsk, boolean>({
    hooks: {
      send: (windowId, ask) => views.toWindow(windowId, 'tabs.guestCloseAsk', ask),
      settled: (windowId, requestId, how) => {
        views.toWindow(windowId, 'tabs.guestCloseSettled', { requestId })
        if (how.why === 'gone') return
        views.toGuest(windowId, how.info.guestId, 'tabs.guestCloseDone', { tabId: how.info.tabId, closed: how.answer === true })
      }
    },
    prefix: 'guest-close',
    refused: false,
    timeoutMs
  })
}

/** A tab ended another way while its ask waited (closed by the owner, exited): the ask is moot and every dialog goes. */
export function settleGoneCloseAsks(asks: GuestCloseAsks, isLive: (tabId: string) => boolean): void {
  if (asks.size === 0) return
  asks.settleWhere((ask) => !isLive(ask.tabId))
}

/**
 * The guest ended (kicked, revoked, expired: GuestStore `ended`): its asks go from every owner's screen at once, and
 * no tab closes on a Close given to a dialog nobody is behind any more.
 */
export function settleGuestCloseAsks(asks: GuestCloseAsks, guestId: string): void {
  if (asks.size === 0) return
  asks.settleWhere((ask) => ask.guestId === guestId)
}
