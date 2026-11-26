// What a guest's connection may receive (design-guests §5, shared/design.md §16.3, D-18): `GUEST_EVENT`, one
// rule per event channel, applied at ONE sink, the guest connection's `WebConnection.event`, and the same
// filters on the `ready` snapshot (`guestSnapshot`). The rules are drop, pass, or one of the pure filters of
// shared/guest-filter.ts (task 01), which 03's router uses for the invoke answers too, so the two routes
// cannot drift apart.
//
// The table is `{ [E in EventChannel]: rule }`: a new event channel without a guest rule fails to compile,
// and the runtime lookup (`guestEvent`) treats a name the table does not have as `drop`. The owner never
// reaches this file: `who === 'owner'` short-circuits at the sink, and a unit test runs every channel through
// the owner path to prove it unchanged.
//
// D-33 and the asks: a trash confirm and a download offer name a host path; a guest gets the file's name only
// (the host's folder layout is the owner's). The asks' visibility itself is shared/guest-filter.ts
// `askVisible` (a download offer's origin tab is main's own, never on the wire: `downloadOrigin`).

import { basename } from 'node:path'
import {
  askVisible,
  guestByOverlay,
  guestByPanel,
  guestByTab,
  guestCommands,
  guestExitFocus,
  guestGroups,
  guestLayout,
  guestLinkNotice,
  guestOverlays,
  guestPanelsReload,
  guestPresence,
  guestProject,
  guestSessions,
  guestTab,
  guestTabRemoved,
  guestTabs,
  guestTabsMoved,
  guestTyped,
  type GuestFilterContext
} from '../../shared/guest-filter'
import type { GuestOnlyAccess } from '../../shared/guests'
import type { EventChannel, IpcEventMap } from '../../shared/ipc'
import type { WebSnapshot } from '../../shared/web-protocol'
import type { GuestService } from '../ipc/guest-deps'

/** A guest connection's filter context: shared/guest-filter.ts's, plus what only main knows about the asks. */
export interface GuestEventContext extends GuestFilterContext {
  /** The tab a `ccc download` offer came from (Downloads' main-only origin, D-23); undefined: none or unknown. */
  downloadOrigin(requestId: string): string | undefined
  /** The owner's name for the banner (the Web access setting, D-24). */
  ownerName(): string
  /**
   * Whether `copy` is (or, just released, was) the receiving view's own copy of the perView overlay
   * (OverlayManager.copyViewOf, main's record). Absent: false, so no per-copy event reaches a guest.
   */
  ownCopy?(overlayId: string, copy: string): boolean
}

/** Main's live sources a guest view's filter context reads (index.ts wires them, task 07). */
export interface GuestContextSources {
  guests: Pick<GuestService, 'tabVisible' | 'pluginVisible'>
  /**
   * Whether the guest sees the overlay (guest-wiring.ts overlayVisibleOf): opened from a tab it sees or by a plugin
   * it sees, AND every plugin of the overlay's `via` visible to it (D-4), and not hidden by that guest.
   */
  overlayVisible(guestId: string, overlayId: string): boolean
  /** `copy` of the overlay is `viewId`'s own, live or just released (OverlayManager.copyViewOf). Absent: never. */
  ownCopy?(viewId: string, overlayId: string, copy: string): boolean
  /** The person behind a view (presence.ts `personOf`). */
  personOf(viewId: string | null): string | undefined
  /** The project's tab order now (TabManager). */
  tabOrder(projectId: string): readonly string[]
  /**
   * A `ccc download` offer's origin tab as the view `viewId` sees it: `Downloads.offerOrigin(<the view's window>,
   * requestId)?.originTab` (03b). Absent: none, so no offer reaches a guest.
   */
  downloadOrigin?(viewId: string, requestId: string): string | undefined
  /** The owner's name (Web access settings, D-24). */
  ownerName(): string
  /** The project's folder, for guestSessions' project-relative files (D-33). Absent: no file reaches a guest. */
  projectPath?(projectId: string): string | undefined
}

/**
 * A guest view's filter context. `access` is the guest's as read when the event is sent: the caller reads it
 * live (GuestStore.access) for every event, so a role or scope change applies to the next event even
 * before the view's reconnect (4461 / 4464) lands.
 */
export function guestContext(src: GuestContextSources, viewId: string, access: GuestOnlyAccess): GuestEventContext {
  return {
    viewId,
    access,
    tabVisible: (tabId) => src.guests.tabVisible(access.id, tabId),
    pluginVisible: (pluginId) => src.guests.pluginVisible(access.projectId, pluginId),
    overlayVisible: (overlayId) => src.overlayVisible(access.id, overlayId),
    personOf: (v) => src.personOf(v),
    tabOrder: () => src.tabOrder(access.projectId),
    downloadOrigin: (requestId) => src.downloadOrigin?.(viewId, requestId),
    ownerName: () => src.ownerName(),
    ownCopy: (overlayId, copy) => src.ownCopy?.(viewId, overlayId, copy) === true,
    projectRoot: () => src.projectPath?.(access.projectId)
  }
}

export type GuestEventRule<E extends EventChannel> = 'drop' | 'pass' | ((p: IpcEventMap[E], g: GuestEventContext) => IpcEventMap[E] | undefined)

/** A trash confirm as a write guest gets it: the file's name, not the host's path (D-33). */
export function guestTrashAsk(p: IpcEventMap['trash.ask'], g: GuestEventContext): IpcEventMap['trash.ask'] | undefined {
  if (!askVisible('trash', { pluginId: p.pluginId }, g.access, g)) return undefined
  return { ...p, path: basename(p.path) }
}

/** A `ccc download` offer as a write guest gets it: from a tab it sees, the name only (no host path, no link target). */
export function guestDownloadOffer(p: IpcEventMap['downloads.offer'], g: GuestEventContext): IpcEventMap['downloads.offer'] | undefined {
  const origin = g.downloadOrigin(p.requestId)
  if (!askVisible('download', origin === undefined ? {} : { originTab: origin }, g.access, g)) return undefined
  const out = { ...p, path: basename(p.path) }
  delete out.real
  return out
}

/**
 * A perView overlay's per-copy events (docs/design-overlay-views.md §5): to a guest only for its own copy, by main's
 * record of which view the copy is for (`ownCopy`), never the payload's word alone; a payload with no `copy` (a
 * holder's message) never. `visible`: the overlay must also still be visible to the guest now (a message, a reload);
 * a hide is not gated on it, since the hide a growth sends comes exactly when the guest stopped seeing it.
 */
function ownCopyEvent<P extends { overlayId: string; copy?: string }>(visible: boolean): (p: P, g: GuestEventContext) => P | undefined {
  return (p, g) => {
    if (typeof p.copy !== 'string' || typeof p.overlayId !== 'string') return undefined
    if (g.ownCopy?.(p.overlayId, p.copy) !== true) return undefined
    if (visible && !g.overlayVisible(p.overlayId)) return undefined
    return p
  }
}

/** `project.updated`: id, name and colour only (D-33). */
const projectUpdated = (p: IpcEventMap['project.updated']): IpcEventMap['project.updated'] => guestProject(p)

export const GUEST_EVENT: { readonly [E in EventChannel]: GuestEventRule<E> } = Object.freeze({
  // Terminals: a guest's view gets its own numbered frames from the mirror (view-terminals.ts), never these.
  'tabs.data': 'drop',
  'tabs.screenAsk': 'drop',
  'tabs.typed': guestTyped,
  'tabs.exit': guestByTab,
  'tabs.removed': guestTabRemoved,
  'tabs.moved': guestTabsMoved,
  'tabs.select': guestByTab,
  'tabs.exitFocus': guestExitFocus,
  // Docked tabs are hidden from guests (design-terminal-panel.md §13.2): a dock reaches a guest as its narrowing
  // reconnect, never as this event.
  'tabs.docked': 'drop',
  'tabs.added': guestTab,
  'groups.changed': guestGroups,
  // The owner's machine, settings and access: never a guest's.
  'updates.changed': 'drop',
  'webAccess.changed': 'drop',
  'theme.changed': 'pass',
  'prefs.changed': 'pass',
  // The host window's full screen (design §16.3: dropped with window.reopen, projects.*, remote.*).
  'window.state': 'drop',
  // Notifications are the host's (no notice has a source on the wire, design §16.3: none to guests in v1).
  'notify.chime': 'drop',
  'notices.show': 'drop',
  'notices.gone': 'drop',
  'sessions.snapshot': guestSessions,
  // Plugin close asks and their count are the owner's (design §16.3).
  'sessions.closeAsk': 'drop',
  'sessions.closeSettled': 'drop',
  // `ccc plugin link` installs code as the owner: never a guest's (D-4).
  'links.ask': 'drop',
  'links.settled': 'drop',
  'trash.ask': guestTrashAsk,
  'trash.settled': 'pass',
  // Sent to one view (the one that asked): a guest's own.
  'downloads.start': 'pass',
  'downloads.failed': 'pass',
  'downloads.offer': guestDownloadOffer,
  'downloads.settled': 'pass',
  // Rooms are the owner's (design §5): no core room UI or marks for guests.
  'rooms.changed': 'drop',
  'rooms.removeAsk': 'drop',
  'rooms.removeSettled': 'drop',
  'app.linkNotice': guestLinkNotice,
  'oauth.signInEnded': 'drop',
  'settingsPage.held': 'drop',
  'project.updated': projectUpdated,
  'project.goto': 'drop',
  'projects.changed': 'drop',
  'remote.changed': 'drop',
  'layout.updated': guestLayout,
  'overlays.updated': (p, g) => guestOverlays(p, g),
  'overlays.data': guestByOverlay,
  // A guest never holds an html overlay (design §16.3): a holder's page messages never reach it; a perView
  // overlay's copy messages only for its own live copy of an overlay it still sees. Notes and Ask pushes ride this
  // channel too (`envelope: true`, OverlayManager.postEnvelope; shared/design.md §3, §5), so they need no row of their
  // own: a guest gets them for its own copy only, exactly as the opener's posts.
  'overlays.message': ownCopyEvent<IpcEventMap['overlays.message']>(true),
  // Its own copy only (docs/design-overlay-views.md §5): a hide even once the overlay is no longer visible to it.
  'overlays.hide': ownCopyEvent<IpcEventMap['overlays.hide']>(false),
  'overlays.reload': ownCopyEvent<IpcEventMap['overlays.reload']>(true),
  'commands.updated': guestCommands,
  'panels.reload': guestPanelsReload,
  'webviews.navigated': guestByPanel,
  'webviews.cursor': guestByPanel,
  'webviews.selection': guestByPanel,
  'webviews.select': guestByPanel,
  'commands.trigger': 'drop',
  'guests.changed': 'drop',
  'presence.changed': guestPresence,
  // D-9's asks are the owner's.
  'tabs.guestCloseAsk': 'drop',
  'tabs.guestCloseSettled': 'drop',
  // The asking guest's outcome (D-9): main sends it to that guest's own views only (guest-close-asks.ts toGuest);
  // re-picked so nothing else rides along.
  'tabs.guestCloseDone': (p) => ({ tabId: p.tabId, closed: p.closed === true })
})

/**
 * One event as a guest connection gets it: the payload to send, or undefined to send nothing. A channel the
 * table does not have is dropped (`Object.hasOwn`: no prototype key can stand in for a rule). A filter that
 * throws drops the event (logged by the caller): a guest missing one event reconnects at worst; a guest
 * getting an unfiltered one is the leak this file exists to prevent.
 */
export function guestEvent(channel: string, payload: unknown, g: GuestEventContext): unknown {
  if (!Object.hasOwn(GUEST_EVENT, channel)) return undefined
  const rule = GUEST_EVENT[channel as EventChannel] as GuestEventRule<EventChannel>
  if (rule === 'drop') return undefined
  if (rule === 'pass') return payload
  return (rule as (p: unknown, g: GuestEventContext) => unknown)(payload, g)
}

/**
 * The `ready` snapshot as a guest's view gets it (design §5 "ready snapshot"): the same filters as the
 * events; plugin close, link, room and sign-in asks and the core notices never; trash and download asks by
 * `askVisible`; `guest` set for the banner.
 */
export function guestSnapshot(s: WebSnapshot, g: GuestEventContext): WebSnapshot {
  const trashAsks: NonNullable<WebSnapshot['trashAsks']> = []
  for (const a of s.trashAsks ?? []) {
    const out = guestTrashAsk(a, g)
    if (out) trashAsks.push(out)
  }
  const downloadOffers: NonNullable<WebSnapshot['downloadOffers']> = []
  for (const o of s.downloadOffers ?? []) {
    const out = guestDownloadOffer(o, g)
    if (out) downloadOffers.push(out)
  }
  const out: WebSnapshot = {
    tabs: guestTabs(s.tabs, g),
    layout: guestLayout(s.layout, g),
    overlays: guestOverlays(s.overlays, g),
    closeAsks: [],
    // The owner's approvals: a guest's own ask is answered by the owner, never shown back to any guest.
    guestCloseAsks: [],
    linkAsks: [],
    trashAsks,
    downloadOffers,
    roomRemoveAsks: [],
    notices: [],
    signIns: [],
    guest: { id: g.access.id, name: g.access.name, role: g.access.role, ownerName: g.ownerName() }
  }
  if (s.server !== undefined) out.server = s.server
  return out
}
