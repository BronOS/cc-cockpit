// The Ask channels of a perView overlay copy (shared/design.md §5, spec-review S5, design-parts.md §7):
// `overlays.ask.start`, `.say`, `.close`, `.pick` and `.continue`, which the shell sends for a page's `ccPanel.ask`.
//
// The router bound the caller (window, project, view, who); the service (ask-service.ts) checks the rest from main's
// own records. Here, the person: "the person" is `isOwner(view)`, never `view.remote` (no-remote-authority.test.ts);
// a guest is a write guest by the access the router read for this call (GUEST_CLASS already refused a read guest's
// `write` call; refused again here, fail closed: a guest with no access bound, or not write, is no asker), and anything
// that is not the owner gets the guest mode (no tools, D12). `continue` is the owner's alone (D14), as its GUEST_CLASS
// `no` row says too.
import type { AskApi, AskCaller, AskPerson } from '../ask/ask-api'
import type { OverlayManager } from '../overlays/overlay-manager'
import { guestCall, isOwner, type CallView, type IpcRouter } from './router'

export interface AskHandlerDeps {
  /** The Ask service (task 02); absent: every call is refused. */
  asks?: AskApi
  /** Wired by 00; the service reads the overlay manager itself (AskApiDeps), so the handlers do not. */
  overlays?: Pick<OverlayManager, 'copyOwner' | 'notesOf'>
}

/** The channels, for the handlers and their test. */
export const ASK_CHANNELS = [
  'overlays.ask.start',
  'overlays.ask.say',
  'overlays.ask.close',
  'overlays.ask.pick',
  'overlays.ask.continue'
] as const

/** Who may Ask on this call: the owner, a write guest by the access the router bound, or nobody. */
export function askPersonOf(view: CallView, channel: string): AskPerson | undefined {
  if (isOwner(view)) return 'owner'
  const access = guestCall(view, channel)
  if (access === undefined || access.role !== 'write') return undefined
  return { guest: access.id }
}

export function registerAskHandlers(router: IpcRouter, deps: AskHandlerDeps): void {
  const caller = (ctx: { windowId: number; projectId: string }, view: CallView, channel: string): { asks: AskApi; who: AskCaller } => {
    const asks = deps.asks
    if (!asks) throw new Error(`${channel}: refused (Ask is not available in this build)`)
    const person = askPersonOf(view, channel)
    if (person === undefined) throw new Error(`${channel}: refused`)
    return { asks, who: { windowId: ctx.windowId, projectId: ctx.projectId, view: view.viewId, person } }
  }
  router.handleProject('overlays.ask.start', async (ctx, payload, view) => {
    const { asks, who } = caller(ctx, view, 'overlays.ask.start')
    await asks.start(who, payload)
  })
  router.handleProject('overlays.ask.say', async (ctx, payload, view) => {
    const { asks, who } = caller(ctx, view, 'overlays.ask.say')
    await asks.say(who, payload)
  })
  router.handleProject('overlays.ask.close', (ctx, payload, view) => {
    const { asks, who } = caller(ctx, view, 'overlays.ask.close')
    asks.close(who, payload)
  })
  router.handleProject('overlays.ask.pick', (ctx, payload, view) => {
    const { asks, who } = caller(ctx, view, 'overlays.ask.pick')
    return asks.pick(who, payload)
  })
  router.handleProject('overlays.ask.continue', (ctx, payload, view) => {
    if (!isOwner(view)) throw new Error('overlays.ask.continue: refused')
    const { asks, who } = caller(ctx, view, 'overlays.ask.continue')
    return asks.continueInTab(who, payload)
  })
}
