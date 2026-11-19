// The guest deps that 03, 03b, 04 and 04b's modules take, built in one place from main's live services (task 07a,
// design-guests §2). index.ts calls these once and passes the pieces; every one reads the guest store live on each
// call (a kick or a role switch holds at once), never a cached answer.
//
// Why a module and not lambdas in index.ts: the router's and the tab handlers' guest deps are optional (their own
// unit tests leave them out, and an unwired dep fails closed: guests get nothing). A forgotten one would type-check.
// `guestRouterDeps` answers `Required<GuestRouterDeps>`, so a dep added to the router later and not wired here does
// not compile; test/unit/guest-wiring-07a.test.ts checks what each one answers and that index.ts passes them.

import type { GuestOnlyAccess } from '../shared/guests'
import type { ViewId, Who } from '../shared/views'
import { askInfoFrom, downloadOfferSource, trashAskSource } from './asks/guest-asks'
import type { GuestService, PluginGuestAccessService, PresenceService } from './ipc/guest-deps'
import type { GuestRouterDeps, GuestTabDeps } from './ipc/router'
import type { GuestCloseAsks } from './tabs/guest-close-asks'
import { guestViewInputHandler } from './tabs/view-input'

/** Presence as the wiring feeds and reads it (web/presence.ts). */
export interface PresenceFeed extends PresenceService {
  personOf(viewId: string | null): string | undefined
  viewSelected(viewId: ViewId, tabId: string | null): void
  typed(viewId: ViewId, tabId: string): void
}

export interface GuestRouterSources {
  guests: GuestService
  presence: PresenceFeed
  pluginAccess: PluginGuestAccessService
  windowIdOf(projectId: string): number | undefined
  /** OverlayManager.visibleTo: an overlay opened from a tab or plugin the guest sees. */
  overlays: { visibleTo(windowId: number, overlayId: string, tabVisible: (tabId: string) => boolean, pluginVisible: (pluginId: string) => boolean): boolean }
  /** LayoutService.slotFrame: the slot frame's record, whose page is `info.pluginId`'s. */
  slotFrame(projectId: string, frameId: string): { info: { pluginId: string } } | undefined
  /** TrashAsks.pluginOf: the plugin behind a pending trash ask. */
  trashAsks: { pluginOf(windowId: number, requestId: string): string | undefined }
  /** Downloads.offerOrigin (03b): a pending offer's origin tab. */
  downloads: { offerOrigin(windowId: number, requestId: string): { originTab?: string } | undefined }
}

/** The router's guest deps (IpcRouter.setGuestDeps). */
export function guestRouterDeps(s: GuestRouterSources): Required<GuestRouterDeps> {
  return {
    guests: s.guests,
    presence: s.presence,
    pluginAccess: s.pluginAccess,
    // Only the `slots.*` channels name a frame: the guest must see the plugin whose page it is.
    frameOwner: (projectId, frameId) => s.slotFrame(projectId, frameId)?.info.pluginId,
    overlayVisible: (projectId: string, overlayId: string, access: GuestOnlyAccess) => {
      const windowId = s.windowIdOf(projectId)
      return (
        windowId !== undefined &&
        s.overlays.visibleTo(
          windowId,
          overlayId,
          (tabId) => s.guests.tabVisible(access.id, tabId),
          (pluginId) => s.guests.pluginVisible(projectId, pluginId)
        )
      )
    },
    // Only trash asks and download offers can be a guest's (asks/guest-asks.ts); any other id is unknown, refused.
    askInfo: askInfoFrom([trashAskSource(s.trashAsks), downloadOfferSource(s.downloads)]),
    personOf: (viewId) => s.presence.personOf(viewId)
  }
}

export interface GuestTabSources {
  presence: Pick<PresenceFeed, 'viewSelected' | 'typed'>
  /** Whether the tab is one of the project's live tabs (presence takes no unknown id). */
  tabExists(projectId: string, tabId: string): boolean
  selections: {
    guestActed(projectId: string, viewId: ViewId, tabId: string): void
    guestTyped(projectId: string, viewId: ViewId, tabId: string): void
  }
  tabs: {
    guestResize(projectId: string, tabId: string, cols: number, rows: number, viewId: ViewId): void
    viewInput(projectId: string, tabId: string, data: string, viewId: ViewId): string
  }
  /** SessionRegistry.userInput: `typed` for the tab (D-3), as an owner's keys set it. */
  userInput(projectId: string, tabId: string, data: string): void
  closeAsks: Pick<GuestCloseAsks, 'ask' | 'answer'>
}

/** registerTabHandlers' `guest` (design-guests §7, §8). */
export function guestTabDeps(s: GuestTabSources): GuestTabDeps {
  return {
    // The view's own selection and presence, never the project's active tab.
    select: (projectId, tabId, viewId) => {
      s.selections.guestActed(projectId, viewId, tabId)
      if (s.tabExists(projectId, tabId)) s.presence.viewSelected(viewId, tabId)
    },
    resize: (projectId, tabId, cols, rows, viewId) => s.tabs.guestResize(projectId, tabId, cols, rows, viewId),
    input: guestViewInputHandler({
      viewInput: (projectId, tabId, data, viewId) => s.tabs.viewInput(projectId, tabId, data, viewId),
      userInput: (projectId, tabId, data) => s.userInput(projectId, tabId, data),
      // The owner's path (the project's active tab); guestViewInputHandler never calls it.
      acted: () => undefined,
      guestActed: (projectId, tabId, viewId) => {
        s.selections.guestTyped(projectId, viewId, tabId)
        s.presence.typed(viewId, tabId)
      }
    }),
    closeAsk: (windowId, ask) => s.closeAsks.ask(windowId, ask),
    closeAnswer: (windowId, requestId, close) => s.closeAsks.answer(windowId, requestId, close)
  }
}

/**
 * Downloads' `hasBrowserView` for `ccc download` offers (D-23): a browser view of the window that can take an offer from
 * `originTab`: an owner's, or a guest's for which `sees` holds (askVisible('download'), the rule guest-events.ts's sink
 * drops the offer by, so a view counted here is one the offer reaches).
 */
export function offerTakerOf(s: {
  remoteViews(windowId: number): readonly ViewId[]
  whoOf(viewId: ViewId): Who | undefined
  guests: Pick<GuestService, 'access'>
  sees(viewId: ViewId, access: GuestOnlyAccess, originTab: string | undefined): boolean
}): (windowId: number, originTab?: string) => boolean {
  return (windowId, originTab) =>
    s.remoteViews(windowId).some((viewId) => {
      const who = s.whoOf(viewId)
      if (who === undefined) return false
      if (who === 'owner') return true
      const access = s.guests.access(who)
      return access.kind === 'guest' && s.sees(viewId, access, originTab)
    })
}

/**
 * Whether a browser view may get a download (D-23): an owner's, or a write guest's. A read guest never, whatever a
 * plugin asks: a guest-aware plugin gets a read guest's full port (shared/guest-access.ts guestPort) and its
 * `ctx.files.download` names that view as the origin, so main refuses here rather than trust the plugin's check.
 */
export function downloadViewAllowedOf(
  whoOf: (viewId: ViewId) => Who | undefined,
  guests: Pick<GuestService, 'access'>
): (viewId: ViewId) => boolean {
  return (viewId) => {
    const who = whoOf(viewId)
    if (who === undefined) return false
    if (who === 'owner') return true
    const access = guests.access(who)
    return access.kind === 'guest' && access.role === 'write'
  }
}

/** A view is the owner's (the desktop page, the hidden page and owner browsers); a gone view is not. */
export function ownerViewOf(whoOf: (viewId: ViewId) => Who | undefined): (viewId: ViewId) => boolean {
  return (viewId) => whoOf(viewId) === 'owner'
}

/** A guest's view sees the tab now (ViewSelections.exitFocus hands it only such a pane). False for owners and gone views. */
export function guestSeesOf(
  whoOf: (viewId: ViewId) => Who | undefined,
  guests: Pick<GuestService, 'access' | 'tabVisible'>
): (viewId: ViewId, tabId: string) => boolean {
  return (viewId, tabId) => {
    const who = whoOf(viewId)
    if (who === undefined || who === 'owner') return false
    const access = guests.access(who)
    return access.kind === 'guest' && guests.tabVisible(access.id, tabId)
  }
}

/**
 * GuestStore's `unsavedOf`: the titles of the guest's own project's page tabs with unsaved changes in one of the
 * guest's views (a role downgrade warns the owner about them). Another guest's or the owner's dirty pages are not its.
 */
export function guestUnsavedOf(
  whoOf: (viewId: ViewId) => Who | undefined,
  guests: Pick<GuestService, 'access'>,
  unsavedTitlesIn: (projectId: string, inView: (viewId: ViewId) => boolean) => string[]
): (guestId: string) => string[] {
  return (guestId) => {
    const access = guests.access({ guest: guestId })
    if (access.kind !== 'guest') return []
    return unsavedTitlesIn(access.projectId, (viewId) => {
      const who = whoOf(viewId)
      return who !== undefined && who !== 'owner' && who.guest === guestId
    })
  }
}
