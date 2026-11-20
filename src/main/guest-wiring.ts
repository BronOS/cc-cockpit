// The guest deps that 03, 03b, 04 and 04b's modules take, built in one place from main's live services (task 07a,
// design-guests §2). index.ts calls these once and passes the pieces; every one reads the guest store live on each
// call (a kick or a role switch holds at once), never a cached answer.
//
// Why a module and not lambdas in index.ts: the router's and the tab handlers' guest deps are optional (their own
// unit tests leave them out, and an unwired dep fails closed: guests get nothing). A forgotten one would type-check.
// `guestRouterDeps` answers `Required<GuestRouterDeps>`, so a dep added to the router later and not wired here does
// not compile; test/unit/guest-wiring-07a.test.ts checks what each one answers and that index.ts passes them.

import type { GuestOnlyAccess } from '../shared/guests'
import type { SlotHost } from '../shared/slots'
import { desktopViewId, type GuestRole, type ViewId, type Who } from '../shared/views'
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
  /** OverlayManager's visibility record: visibleTo (origin and via) and hiddenFrom (the guest's own hides). */
  overlays: OverlayVisibilitySource
  /** LayoutService.slotFrame: the slot frame's record, whose page is `info.pluginId`'s, placed by `host`. */
  slotFrame(projectId: string, frameId: string): { info: { pluginId: string }; host: SlotHost } | undefined
  /** TrashAsks.pluginOf: the plugin behind a pending trash ask. */
  trashAsks: { pluginOf(windowId: number, requestId: string): string | undefined }
  /** Downloads.offerOrigin (03b): a pending offer's origin tab. */
  downloads: { offerOrigin(windowId: number, requestId: string): { originTab?: string } | undefined }
  /** The project's folder (the registry's record), for guestSessions' project-relative files. */
  projectPath(projectId: string): string | undefined
}

/** The router's guest deps (IpcRouter.setGuestDeps). */
export function guestRouterDeps(s: GuestRouterSources): Required<GuestRouterDeps> {
  return {
    guests: s.guests,
    presence: s.presence,
    pluginAccess: s.pluginAccess,
    // Only the `slots.*` channels name a frame: the guest must see the plugin whose page it is and, for a frame a
    // panel placed, that panel's plugin too (guestLayout's rule: a hidden plugin's panel, and so the slots in it, is
    // not in a guest's layout). An app slot (the top bar) has no host plugin: the provider alone decides.
    frameOwner: (projectId, frameId) => {
      const frame = s.slotFrame(projectId, frameId)
      if (frame === undefined) return undefined
      if (frame.host.kind === 'panel' && !s.guests.pluginVisible(projectId, frame.host.pluginId)) return undefined
      return frame.info.pluginId
    },
    overlayVisible: overlayVisibleOf(s),
    // Only trash asks and download offers can be a guest's (asks/guest-asks.ts); any other id is unknown, refused.
    askInfo: askInfoFrom([trashAskSource(s.trashAsks), downloadOfferSource(s.downloads)]),
    personOf: (viewId) => s.presence.personOf(viewId),
    projectRoot: (projectId) => s.projectPath(projectId)
  }
}

/** What the overlay visibility rule reads from OverlayManager. */
export interface OverlayVisibilitySource {
  visibleTo(windowId: number, overlayId: string, tabVisible: (tabId: string) => boolean, pluginVisible: (pluginId: string) => boolean): boolean
  hiddenFrom(windowId: number, overlayId: string, guestId: string): boolean
}

/**
 * The one overlay rule for a guest (design-guests §9, docs/design-overlay-views.md §4, §5), shared by the router's
 * target check, the guest sink's filters (index.ts guestSources) and a copy's connect (mayConnectCopyOf), so they
 * cannot drift apart: opened from a tab the guest sees or by a plugin it sees, every plugin of `via` visible to it
 * (D-4), and not hidden by that guest (its ✕ on a perView overlay). Read live on every call.
 */
export function overlayVisibleOf(s: {
  guests: Pick<GuestService, 'tabVisible' | 'pluginVisible'>
  windowIdOf(projectId: string): number | undefined
  overlays: OverlayVisibilitySource
}): (projectId: string, overlayId: string, access: GuestOnlyAccess) => boolean {
  return (projectId, overlayId, access) => {
    const windowId = s.windowIdOf(projectId)
    if (windowId === undefined) return false
    if (s.overlays.hiddenFrom(windowId, overlayId, access.id)) return false
    return s.overlays.visibleTo(
      windowId,
      overlayId,
      (tabId) => s.guests.tabVisible(access.id, tabId),
      (pluginId) => s.guests.pluginVisible(projectId, pluginId)
    )
  }
}

/** What a guest's copy of a perView overlay is decided from (index.ts wires main's live services). */
export interface OverlayCopySources {
  whoOf(viewId: ViewId): Who | undefined
  guests: Pick<GuestService, 'access'>
  windowIdOf(projectId: string): number | undefined
  /** overlayVisibleOf over the same services. */
  overlayVisible(projectId: string, overlayId: string, access: GuestOnlyAccess): boolean
  /** OverlayManager.isPerView / openerPluginOf. */
  overlays: { isPerView(windowId: number, overlayId: string): boolean; openerPluginOf(windowId: number, overlayId: string): string | undefined }
  /** PluginGuestAccessStore.port (shared/guest-access.ts guestPort, D-17). */
  port(projectId: string, pluginId: string, role: GuestRole): 'none' | 'oneWay' | 'full'
}

/**
 * The port a guest's view has to a perView overlay's opener now, read live (GuestStore, the plugin's guest
 * setting): `none` unless the view is a live guest of the overlay's own window's project, the overlay is perView
 * and visible to that guest (overlayVisibleOf: origin, via, its hides) and the opener plugin's guest port is not
 * `none`; else that port (`oneWay` for a read guest of a plugin that is not guests.aware, D-17). An owner's view
 * or a gone one: `none` (owner views never ask; a gone view is nobody).
 */
export function overlayCopyPortOf(s: OverlayCopySources): (windowId: number, overlayId: string, viewId: ViewId) => 'none' | 'oneWay' | 'full' {
  return (windowId, overlayId, viewId) => {
    const who = s.whoOf(viewId)
    if (who === undefined || who === 'owner') return 'none'
    const access = s.guests.access(who)
    if (access.kind !== 'guest' || s.windowIdOf(access.projectId) !== windowId) return 'none'
    if (!s.overlays.isPerView(windowId, overlayId) || !s.overlayVisible(access.projectId, overlayId, access)) return 'none'
    const opener = s.overlays.openerPluginOf(windowId, overlayId)
    if (opener === undefined) return 'none'
    return s.port(access.projectId, opener, access.role)
  }
}

/**
 * OverlayManager's `mayConnectCopy` (docs/design-overlay-views.md §5): a guest's view may load a copy of a perView
 * overlay exactly when its port is not `none` (overlayCopyPortOf). Owner views never ask (D-1); server mode's
 * hidden page is the owner's and the manager refuses it before asking.
 */
export function mayConnectCopyOf(s: OverlayCopySources): (windowId: number, overlayId: string, viewId: ViewId) => boolean {
  const port = overlayCopyPortOf(s)
  return (windowId, overlayId, viewId) => port(windowId, overlayId, viewId) !== 'none'
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

/** Where a plugin's page tab `focus` selects (ctx.tabs.openPage / focus): every view, one view, or none. */
export type PageSelectTarget = 'project' | 'none' | { viewId: ViewId }

/**
 * A plugin's `focus` acts where the plugin acted (design-guests §7, 03e): the view a plugin call came from
 * (HostApi.originOf, a hint) decides. None or an owner's view: the project's views select it, as before. A guest's
 * view: that view only, so a guest's click never moves the owner's selection or active tab. A remote view that
 * is gone: nowhere (fail closed: it might have been a guest's).
 */
export function pageSelectTargetOf(whoOf: (viewId: ViewId) => Who | undefined): (view: ViewId | undefined) => PageSelectTarget {
  return (view) => {
    if (view === undefined) return 'project'
    const who = whoOf(view)
    if (who === 'owner') return 'project'
    return who === undefined ? 'none' : { viewId: view }
  }
}

/**
 * Where a plugin-opened tab's `focus` selects (ctx.sessions.open / openShell / openCommand, announcePluginTab; 03f).
 * `target` is pageSelectTargetOf's answer for the call's origin view; `to` is TabGroups.pluginFocus's answer, worked
 * out for `selectIn` (pluginFocusViewOf). The owner's path is unchanged: a plain tab selects in every view of the
 * project, a placed one in its view. A guest's view: that view only, a plain tab included. None: nowhere.
 */
export type PluginFocusSelect = { to: 'project'; tabId: string } | { to: 'view'; view: ViewId; tabId: string } | undefined

export function pluginFocusSelectOf(
  target: PageSelectTarget,
  to: { to: 'window'; tabId: string } | { to: 'view'; view: string; tabId: string } | undefined
): PluginFocusSelect {
  if (target === 'none' || to === undefined) return undefined
  if (target === 'project') return to.to === 'window' ? { to: 'project', tabId: to.tabId } : { to: 'view', view: to.view as ViewId, tabId: to.tabId }
  // A guest's: whatever pluginFocus answered, it lands in the guest's own view and nowhere else.
  return { to: 'view', view: target.viewId, tabId: to.tabId }
}

/**
 * The view pluginFocus works for: a guest's own view; for the owner's path the origin view when it is one of the
 * window's, else the desktop page (as before 03f). None for 'none' (nothing selects).
 */
export function pluginFocusViewOf(
  target: PageSelectTarget,
  origin: ViewId | undefined,
  windowId: number,
  windowOf: (viewId: ViewId) => number | undefined
): ViewId | undefined {
  if (target === 'none') return undefined
  if (target !== 'project') return windowOf(target.viewId) === windowId ? target.viewId : undefined
  return origin !== undefined && windowOf(origin) === windowId ? origin : desktopViewId(windowId)
}

/**
 * SessionRegistry's `guestMayDeliver` (03e A): a guest's queued Discuss text is pasted only while that guest is
 * still a live write guest of the tab's project that sees the tab. Anything else (kicked, ended, made read-only,
 * the tab unshared, a tab of another project or gone): false, and the text is dropped.
 */
export function guestMayDeliverOf(
  guests: Pick<GuestService, 'access' | 'tabVisible'>,
  projectOfTab: (tabId: string) => string | undefined
): (guestId: string, tabId: string) => boolean {
  return (guestId, tabId) => {
    const access = guests.access({ guest: guestId })
    if (access.kind !== 'guest' || access.role !== 'write') return false
    return projectOfTab(tabId) === access.projectId && guests.tabVisible(access.id, tabId)
  }
}
