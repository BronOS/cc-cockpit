// The Ask channels of a perView overlay copy (shared/design.md §5, spec-review S5, design-parts.md §7):
// `overlays.ask.start`, `.say`, `.close`, `.pick` and `.continue`, which the shell sends for a page's `ccPanel.ask`.
//
// 00 contract: a stub that refuses every call (no service = refused). Task 02 fills it, on these rules:
// - the caller's copy must be its own live copy (`overlays.copyOwner` equals the bound view), on an overlay with a
//   notes key (`overlays.notesOf`); a read guest is refused (GUEST_CLASS, and again here);
// - "the person" is `isOwner(view)`, never `view.remote`: anything else gets the guest mode (no tools, D12), its pick is
//   never saved (S5), and `continue` is the owner's alone (D14).
import type { AskApi } from '../ask/ask-api'
import type { OverlayManager } from '../overlays/overlay-manager'
import type { IpcRouter } from './router'

export interface AskHandlerDeps {
  /** The Ask service (task 02); absent: every call is refused. */
  asks?: AskApi
  overlays: Pick<OverlayManager, 'copyOwner' | 'notesOf'>
}

/** The channels, for the stub and its test. */
export const ASK_CHANNELS = [
  'overlays.ask.start',
  'overlays.ask.say',
  'overlays.ask.close',
  'overlays.ask.pick',
  'overlays.ask.continue'
] as const

export function registerAskHandlers(router: IpcRouter, deps: AskHandlerDeps): void {
  void deps
  for (const channel of ASK_CHANNELS) {
    router.handleProject(channel, () => {
      throw new Error(`${channel}: refused (Ask is not available in this build)`)
    })
  }
}
