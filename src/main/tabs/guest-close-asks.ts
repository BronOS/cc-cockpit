// D-9 (design-guests §7, spec-review 6): a write guest closes only the tabs it opened; closing any other tab asks
// the owner. The ask is a shared one (asks/shared-asks.ts) on every view of the window: the guest's own views never
// get it (GUEST_EVENT drops `tabs.guestCloseAsk` and `tabs.guestCloseSettled`, and `tabs.guestCloseAnswer` is
// GUEST_CLASS `no`), so the first owner view to answer wins; nobody answering within GUEST_CLOSE_ASK_MS keeps
// the tab. Out of index.ts so a unit test drives the hooks and the timeout with the real wiring.

import type { IpcEventMap } from '../../shared/ipc'
import { SharedAsks } from '../asks/shared-asks'

/** How long the owner has to answer before the tab is kept (spec-review 6). */
export const GUEST_CLOSE_ASK_MS = 60_000

export type GuestCloseAsk = Omit<IpcEventMap['tabs.guestCloseAsk'], 'requestId'>
export type GuestCloseAsks = SharedAsks<GuestCloseAsk, boolean>

/** The shared ask on every view of the window (`views` is the ViewRegistry's `toWindow` only). */
export function createGuestCloseAsks(
  views: { toWindow(windowId: number, channel: 'tabs.guestCloseAsk' | 'tabs.guestCloseSettled', payload: unknown): boolean },
  timeoutMs = GUEST_CLOSE_ASK_MS
): GuestCloseAsks {
  return new SharedAsks<GuestCloseAsk, boolean>({
    hooks: {
      send: (windowId, ask) => views.toWindow(windowId, 'tabs.guestCloseAsk', ask),
      settled: (windowId, requestId) => views.toWindow(windowId, 'tabs.guestCloseSettled', { requestId })
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
