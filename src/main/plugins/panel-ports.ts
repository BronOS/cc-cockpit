// Panel MessagePorts (plan: Technical Details › Plugin host RPC; design §2 "panels are sandboxed
// iframes connected to their plugin's backend by a MessagePort that main hands out").
//
//   connect   a panel's iframe loaded (`panels.connect` from the window, project from the sender):
//             main makes one channel for this panel instance, hands one end to the plugin's host
//             tagged with plugin and panel id taken from main's OWN records, and posts the other end
//             to the asking window with the renderer's nonce. The renderer moves it into the iframe.
//             Messages then flow page <-> host directly; main never sees them.
//   reload    a reloaded iframe connects again and gets a NEW channel; the host's end of the old
//             one is closed by the host when the new one is attached (host/ctx/ui.ts PanelPorts).
//   restart   a host (re)started: the old ends died with the old process, so the window is told to
//             reload those plugins' pages (`panels.reload`), and each connects to the new host.
//             Reload rather than a swapped port: a page asks for what it shows when it connects,
//             and against a fresh host it must ask again.
//             Page tabs are the exception: the same `panels.reload` makes their frames connect
//             again WITHOUT a reload (a page tab holds unsaved text), and the page re-sends what it
//             holds over the new line (design-editor.md §1 "Host restart").
//
// Refused (false, both ends closed, nothing sent): a panel key that is not `<pluginId>/<panelId>`
// of a plugin RUNNING in this project's host now, with that panel in its manifest. A panel of a
// plugin without host code, one still starting, disabled or given up on, gets no port; its page
// still renders (and queues what it posts, see src/sdk/panel.ts).
//
// Capped: at most MAX_CONNECTS_PER_PANEL connects per CONNECT_WINDOW_MS for one panel of one
// view (refused like the cases above). A page may `location.reload()` itself in a loop (its
// sandbox allows it) and the shell asks again on every load; each connect costs MAIN a channel, a
// port transfer to the host and the page's files re-read, not only the plugin's own host.
//
// Slot frames (design-next §2) get a port the same way, to the PROVIDER's host (the plugin drawing
// the frame), never the host panel's:
//
//   connectSlot     a slot frame loaded (`slots.connect` with main's frame id): the frame is looked
//                   up in the layout service's records for the asking window's project (who
//                   provides it, what it sits in, the placement's params), the host's end goes to
//                   the provider with all of that (`slotOpen`, HostManager.sendSlotPort), the
//                   window's end comes back on the panels' channel under `@slot/<id>`. The host
//                   panel gets no handle on it, and the provider sees nothing of the panel but
//                   `params`. A frame that connects again (its page reloaded) is closed first.
//   disconnectSlot  the shell unmounted the frame (`slots.disconnect`: the host panel was hidden or
//                   collapsed): the provider hears `slot.close`.
//   slotFramesChanged  the layout's set of frames changed: every open frame that is no longer in it
//                   (placement removed, provider changed, reloaded or stopped) is closed the same way.
// Each frame is closed once; a close for a frame the provider's host never opened is harmless.
//
// Page tabs (design-editor.md §1 "Frame lifetime") get a port the same way, to the tab's OWN
// plugin (main's TabManager record says whose it is, never the renderer):
//
//   connectPageTab     a page tab's frame wants a line (`pageTabs.connect` with main's tab id): on
//                      its first load, and again with NO reload after a host restart (`panels.reload`),
//                      a web reconnect or a relay resync. The host's end goes to the plugin with the
//                      tab's type and params (`pageTabOpen`, HostManager.sendPageTabPort), the view's
//                      end comes back under `@tab/<id>`. A frame that connects again in the same view
//                      is closed first, so the plugin hears the close of the old line, then the new.
//   disconnectPageTab  the shell unmounted the frame (the tab closed, or the frame left the view's
//                      live set): the plugin hears `pageTab.close` for that view.
// Keyed by view like slots: two views showing one page tab are two instances.
//
// A plugin's html settings page (design-next §5.4) gets a port the same way, to THAT plugin's
// backend in the sender window's host (the project resolved from the sender, never a renderer id):
//
//   connectSettingsPage     the page loaded (`settingsPage.connect { pluginId, scope }`): refused
//                           unless the plugin runs in this host now and its manifest page has that
//                           scope. One page per plugin at a time: an open one of the plugin is closed
//                           first (its backend hears onClose), then a new main-minted id goes with the
//                           port (`settingsPageOpen`, HostManager.sendSettingsPagePort); the window's
//                           end comes back under `@settings/<pluginId>`.
//   disconnectSettingsPage  the shell unmounted it (`settingsPage.disconnect`): onClose.
//
// Views (design-web.md §5.3): a project window can have several live views at once, its desktop
// page and remote browser views (shared/views.ts). Every connect comes from one view (main's own
// id from the router's CallView, never the page's word) and its page end goes back to THAT view:
//
//   panels      the host keeps one port per (panel, view); a remote view's tag carries its id, a
//               desktop's has none (unchanged shape). A reload in one view replaces only its port.
//   slots       each view's frame of an id is its own instance: open, reconnect, unmount and the
//               connect cap are keyed by view, so two views showing one frame never close each
//               other's. A layout change that drops a frame closes it in every view.
//   settings    one page per plugin at a time, held by the view that connected last (design-web.md
//               §5.4): an unmount from any other view does not close it. "Take over" in another
//               view is a plain connect from there. Every change of holder is told to the project's
//               views (`settingsPageHeld` -> `settingsPage.held`), so a view whose page was taken
//               shows "Open on <device> — Take over" instead, and `settingsPageHolder` answers a
//               view that opens the page while another holds it.
//   viewGone    a view left (a browser, or the desktop window closed): its slot instances and the
//               page it held end.
//
// Guests (design-guests §6, D-17): a remote view is the owner's or a guest's (`whoOf`, ViewRegistry's frozen
// `who`, and for a guest `guestAccess`, its role read live on every connect). Fails closed: `whoOf` is a
// required dep (a hub built without it does not compile), a view it does not know is refused, and a guest's
// view is refused while `guestAccess` is unwired or says the guest is gone. An owner's view connects as before. A guest's view connects only to a plugin its project
// shows guests (`guestPort`, the owner's setting, hidden by default) and only in the guest's own project;
// its host tag then carries the guest's role (`access`: the plugin's `from.access` and the instances'
// `access`, never the page's word), and a read guest of a plugin that is not guest-aware gets a one-way
// line: the page end is flagged `oneWay` and the web relay drops what that page sends. A settings page is
// never a guest's. The router checked the channel, the tab's scope and the plugin before this (design
// §16.3); this is the last check, on main's own ids.
//
// No Electron import: the channel factory (MessageChannelMain) and the two senders are injected
// by index.ts; unit tests pass fakes.

import { errorText } from '../../shared/error-text'
import { SLOT_FRAME_ID_PATTERN, slotPortKey, type SlotHost } from '../../shared/slots'
import { PAGE_TAB_ID_PATTERN, pageTabPortKey } from '../../shared/page-tabs'
import type { JsonValue, ViewAccess } from '../../sdk/types'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, type SettingsPageScope } from '../../shared/manifest'
import { isSettingsPageScope, settingsPagePortKey } from '../../shared/settings-page'
import type { GuestAccess } from '../../shared/guests'
import type { PanelPortPayload } from '../../shared/ipc'
import { isRemoteViewId, type GuestRole, type ViewId, type Who } from '../../shared/views'
import type { SlotFrameRecord } from '../layout/layout-service'
import { warnLog } from '../warn-log'

/** Two entangled ends; P is Electron's MessagePortMain in the app, a fake in tests. */
export interface PanelChannel<P> {
  host: P
  renderer: P
}

export interface PanelPortDeps<P> {
  createChannel(): PanelChannel<P>
  /**
   * The panel ids `pluginId` declares if it runs in `projectId`'s host now, else undefined
   * (HostManager.runningPanels). The returned strings are main's own records.
   */
  runningPanels(projectId: string, pluginId: string): readonly string[] | undefined
  /**
   * Hand the host its end, tagged (HostManager.sendPanelPort); false when there is no host. `view`
   * is set for a remote view's page only (the host keeps one port per view; absent = desktop).
   */
  toHost(projectId: string, pluginId: string, panelId: string, port: P, tag: PortViewTag): boolean
  /**
   * Post the page end to the view that asked (ViewRegistry.postPort on PANEL_PORT_CHANNEL). Throws
   * when the view is gone or cannot take a port; both ends are then closed.
   */
  toRenderer(viewId: ViewId, payload: PanelPortPayload, port: P): void
  /** Tell the project's window to reload these plugins' panels (`panels.reload`). */
  reload(projectId: string, pluginIds: string[]): void
  close(port: P): void
  /** A slot frame the project draws now (LayoutService.slotFrame): main's own record. Absent: no slots. */
  slotFrame?(projectId: string, frameId: string): SlotFrameRecord | undefined
  /** Hand the provider's host its end with what onOpen gets (HostManager.sendSlotPort); false when it does not run. */
  slotToHost?(
    projectId: string,
    open: { pluginId: string; id: string; type: string; host: SlotHost; params?: JsonValue; view?: ViewId; access: ViewAccess },
    port: P
  ): boolean
  /** The frame is gone in a view (`view` set for a remote one): tell the provider's host (HostManager.closeSlot). */
  slotClosed?(projectId: string, pluginId: string, frameId: string, view?: ViewId): void
  /** A page tab of the project now (TabManager.list): main's own record of whose it is and what it shows. Absent: no page tabs. */
  pageTab?(projectId: string, tabId: string): PageTabRecord | undefined
  /** Hand the tab's plugin its end with what its onOpen gets (HostManager.sendPageTabPort); false when it does not run. */
  pageTabToHost?(
    projectId: string,
    open: { pluginId: string; id: string; type: string; params?: JsonValue; view?: ViewId; access: ViewAccess },
    port: P
  ): boolean
  /** The frame is gone in a view (`view` set for a remote one): tell the plugin's host (HostManager.closePageTab). */
  pageTabClosed?(projectId: string, pluginId: string, tabId: string, view?: ViewId): void
  /** The scopes of the plugin's settings page when it runs in the project's host now (HostManager.runningSettingsPage). */
  settingsPageScopes?(projectId: string, pluginId: string): readonly SettingsPageScope[] | undefined
  /** Hand the plugin's host its end of a settings page (HostManager.sendSettingsPagePort); false when it does not run. */
  settingsPageToHost?(projectId: string, open: { pluginId: string; id: string; scope: SettingsPageScope; view?: ViewId }, port: P): boolean
  /** The page is gone: tell the plugin's host (HostManager.closeSettingsPage). */
  settingsPageClosed?(projectId: string, pluginId: string, id: string): void
  /**
   * The view holding the plugin's settings page changed (null: none holds it, the page closed):
   * tell the project's views (`settingsPage.held`). Called once per change, after it.
   */
  settingsPageHeld?(projectId: string, pluginId: string, viewId: ViewId | null): void
  /**
   * Who a live view is (ViewRegistry.whoOf): `'owner'`, `{ guest }`, or undefined for a view that is gone or never
   * was. Required, so a hub wired without it fails to compile instead of reading every view as the owner's.
   */
  whoOf(viewId: ViewId): Who | undefined
  /**
   * A guest view's access now (GuestService.whoAccess, read on every connect: a kick or a role switch holds at
   * once). Asked only for a view `whoOf` calls a guest's. Absent (guests not wired): a guest's view is refused.
   */
  guestAccess?(viewId: ViewId): GuestAccess
  /** The port a guest of `role` gets to the plugin's pages in the project (PluginGuestAccessService.port, D-17). */
  guestPort?(projectId: string, pluginId: string, role: GuestRole): 'none' | 'oneWay' | 'full'
  log?: (message: string) => void
  /** Clock for the connect cap (tests); Date.now by default. */
  now?: () => number
}

/** What the hub needs of a page tab: main's ids, the manifest type and the params its plugin's onOpen gets. */
export interface PageTabRecord {
  id: string
  pluginId: string
  type: string
  params?: JsonValue
}

/** A page tab instance whose port went out to one view. */
interface OpenPageTab {
  projectId: string
  pluginId: string
  tabId: string
  viewId: ViewId
}

/** A slot frame instance whose port went out to one view. */
interface OpenSlot {
  projectId: string
  pluginId: string
  frameId: string
  viewId: ViewId
}

/**
 * What a host's tag carries for a view: a remote view's id and, always, the view's access (design-guests §6,
 * the plugin's `from.access` and the instances' `access`).
 */
export interface PortViewTag {
  /** A remote view's id; absent for the desktop window's page. */
  view?: ViewId
  /** Always set (`owner` for the desktop page): the host refuses a tag without one, so a missed path fails closed. */
  access: ViewAccess
}

/** The tag's fields as they go into a host message (spread into it). */
export function portViewFields(tag: PortViewTag): { view?: ViewId; access: ViewAccess } {
  return { ...(tag.view !== undefined ? { view: tag.view } : {}), access: tag.access }
}

/**
 * How a view may hold a line to a plugin's page (design-guests §6, D-17): `tag` for the host, `oneWay` for
 * the page end (main/web/port-relay.ts drops what the page sends). Undefined: refused.
 */
interface ViewLine {
  tag: PortViewTag
  oneWay?: true
}

/** A remote view's id for a host message; nothing for the desktop page. */
function remoteOnly(viewId: ViewId): { view?: ViewId } {
  return isRemoteViewId(viewId) ? { view: viewId } : {}
}

/** The page end's flag for a one-way line (PanelPortPayload.oneWay); nothing otherwise. */
function oneWayOf(line: ViewLine): { oneWay?: true } {
  return line.oneWay === true ? { oneWay: true } : {}
}

function slotKey(projectId: string, viewId: ViewId, frameId: string): string {
  return `${projectId}\n${viewId}\n${frameId}`
}

/** Longest panel key looked at (a plugin id is at most 100, a contribution id 64). */
const MAX_PANEL_KEY_LENGTH = 200

/**
 * Connects one panel of one view may make per CONNECT_WINDOW_MS. A well-behaved page connects
 * once per load: at window open, on a host restart (`panels.reload`) and when the user moves or
 * reopens it, far fewer than this in ten seconds.
 */
export const MAX_CONNECTS_PER_PANEL = 10
export const CONNECT_WINDOW_MS = 10_000

export class PanelPortHub<P> {
  private readonly log: (message: string) => void
  private readonly now: () => number
  /** Recent connect times per `<projectId>\n<viewId>\n<pluginId>/<panelId>` (main's own ids). */
  private readonly recent = new Map<string, { times: number[]; logged: boolean }>()
  /** `<projectId>\n<viewId>\n<frameId>` -> the provider of a slot frame whose port went out to that view and is not closed yet. */
  private readonly openSlots = new Map<string, OpenSlot>()
  /** `<projectId>\n<viewId>\n<tabId>` -> a page tab whose port went out to that view and is not closed yet. */
  private readonly openPageTabs = new Map<string, OpenPageTab>()
  /**
   * `<projectId>\n<pluginId>` -> the plugin's settings page whose port went out and is not closed
   * yet, and the view holding it (one page per plugin, whichever view connected last).
   */
  private readonly openPages = new Map<string, { projectId: string; pluginId: string; id: string; viewId: ViewId }>()
  private nextPageId = 1

  constructor(private readonly deps: PanelPortDeps<P>) {
    this.log = deps.log ?? warnLog
    this.now = deps.now ?? Date.now
  }

  /**
   * Connect one panel instance of the asking view. `projectId` and `viewId` are what main resolved
   * from the caller; `panelKey` and `nonce` are renderer input and only looked up.
   */
  connect(projectId: string, viewId: ViewId, panelKey: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return false
    if (typeof panelKey !== 'string' || panelKey.length > MAX_PANEL_KEY_LENGTH) return false
    // Plugin ids hold dots but no slash, contribution ids neither: the last slash splits them.
    const slash = panelKey.lastIndexOf('/')
    if (slash <= 0) return false
    const panels = this.deps.runningPanels(projectId, panelKey.slice(0, slash))
    // The ids below are main's own strings from here on, not the renderer's.
    const panelId = panels?.find((p) => p === panelKey.slice(slash + 1))
    if (panels === undefined || panelId === undefined) return false
    const pluginId = panelKey.slice(0, slash)
    const line = this.viewLine(projectId, viewId, pluginId)
    if (line === undefined) return false
    // Per view: a phone's reload loop does not use up the desktop page's budget.
    if (!this.withinCap(projectId, viewId, pluginId, panelId)) return false

    const channel = this.deps.createChannel()
    let sent = false
    try {
      sent = this.deps.toHost(projectId, pluginId, panelId, channel.host, line.tag)
    } catch (err) {
      this.log(`panel ${pluginId}/${panelId}: handing the host its port failed: ${errorText(err)}`)
    }
    if (!sent) {
      // The host went between the check and the send: neither end may be left half-connected.
      this.closeQuietly(channel.host)
      this.closeQuietly(channel.renderer)
      return false
    }
    try {
      this.deps.toRenderer(viewId, { panelKey: `${pluginId}/${panelId}`, nonce, ...oneWayOf(line) }, channel.renderer)
    } catch (err) {
      // The view is closing (or cannot take a port): closing the page end tells the host's end,
      // which detaches only this view's port.
      this.log(`panel ${pluginId}/${panelId}: posting the view its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      return false
    }
    return true
  }

  /**
   * Connect one slot frame of the asking view (see the top of the file). `projectId` and `viewId`
   * are what main resolved from the caller; `frameId` and `nonce` are renderer input and only
   * looked up. False when refused: no such frame now, the provider not running, over the cap.
   */
  connectSlot(projectId: string, viewId: ViewId, frameId: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return false
    if (typeof frameId !== 'string' || !SLOT_FRAME_ID_PATTERN.test(frameId)) return false
    const frame = this.deps.slotFrame?.(projectId, frameId)
    if (!frame || !this.deps.slotToHost) return false
    // From here on the ids are main's own strings (the record's), not the renderer's.
    const id = frame.info.id
    const pluginId = frame.info.pluginId
    // The provider's visibility decides (the frame shows the provider's page, not the host panel's plugin).
    const line = this.viewLine(projectId, viewId, pluginId)
    if (line === undefined) return false
    if (!this.withinCap(projectId, viewId, pluginId, slotPortKey(id))) return false
    // Its page loaded again in this view: the provider's instance for the old load goes first.
    // The same frame in another view is another instance and stays.
    this.disconnectSlot(projectId, viewId, id)

    const channel = this.deps.createChannel()
    let sent = false
    try {
      sent = this.deps.slotToHost(
        projectId,
        {
          pluginId,
          id,
          type: frame.info.type,
          host: frame.host,
          ...(frame.params !== undefined ? { params: frame.params } : {}),
          ...portViewFields(line.tag)
        },
        channel.host
      )
    } catch (err) {
      this.log(`slot ${frame.info.type} of ${pluginId}: handing the host its port failed: ${errorText(err)}`)
    }
    if (!sent) {
      this.closeQuietly(channel.host)
      this.closeQuietly(channel.renderer)
      return false
    }
    this.openSlots.set(slotKey(projectId, viewId, id), { projectId, pluginId, frameId: id, viewId })
    try {
      this.deps.toRenderer(viewId, { panelKey: slotPortKey(id), nonce, ...oneWayOf(line) }, channel.renderer)
    } catch (err) {
      this.log(`slot ${frame.info.type} of ${pluginId}: posting the view its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      this.disconnectSlot(projectId, viewId, id)
      return false
    }
    return true
  }

  /**
   * Connect one page tab's frame in the asking view (see the top of the file). `projectId` and
   * `viewId` are what main resolved from the caller; `tabId` and `nonce` are renderer input and only
   * looked up. False when refused: no such page tab now, its plugin not running, over the cap.
   */
  connectPageTab(projectId: string, viewId: ViewId, tabId: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return false
    if (typeof tabId !== 'string' || !PAGE_TAB_ID_PATTERN.test(tabId)) return false
    const tab = this.deps.pageTab?.(projectId, tabId)
    if (!tab || !this.deps.pageTabToHost) return false
    // From here on the ids are main's own strings (the record's), not the renderer's.
    const id = tab.id
    const pluginId = tab.pluginId
    // Whether the guest may see the tab at all is the router's (scope, design §16.3); here, its plugin.
    const line = this.viewLine(projectId, viewId, pluginId)
    if (line === undefined) return false
    // A reconnect loop (a page tab has no reload, but its relay can resync) is bounded like a reload loop.
    if (!this.withinCap(projectId, viewId, pluginId, pageTabPortKey(id))) return false
    // A new line for this view's frame: the plugin's instance of the old line goes first. The same
    // tab in another view is another instance and stays.
    this.disconnectPageTab(projectId, viewId, id)

    const channel = this.deps.createChannel()
    let sent = false
    try {
      sent = this.deps.pageTabToHost(
        projectId,
        { pluginId, id, type: tab.type, ...(tab.params !== undefined ? { params: tab.params } : {}), ...portViewFields(line.tag) },
        channel.host
      )
    } catch (err) {
      this.log(`page tab ${tab.type} of ${pluginId}: handing the host its port failed: ${errorText(err)}`)
    }
    if (!sent) {
      this.closeQuietly(channel.host)
      this.closeQuietly(channel.renderer)
      return false
    }
    this.openPageTabs.set(slotKey(projectId, viewId, id), { projectId, pluginId, tabId: id, viewId })
    try {
      this.deps.toRenderer(viewId, { panelKey: pageTabPortKey(id), nonce, ...oneWayOf(line) }, channel.renderer)
    } catch (err) {
      this.log(`page tab ${tab.type} of ${pluginId}: posting the view its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      this.disconnectPageTab(projectId, viewId, id)
      return false
    }
    return true
  }

  /** The shell of `viewId` unmounted a page tab's frame: its plugin hears that view's close (once). */
  disconnectPageTab(projectId: string, viewId: ViewId, tabId: unknown): void {
    if (typeof tabId !== 'string') return
    const key = slotKey(projectId, viewId, tabId)
    const open = this.openPageTabs.get(key)
    if (!open) return
    this.openPageTabs.delete(key)
    this.tellPageTabClosed(open)
  }

  /**
   * `pageTab.close` is the plugin host's only word that a line ended: main never closes the host's
   * end itself (it went to the host process), and an entry outlives a host restart, so the first
   * reconnect after one tells the new host about an id it never opened. The host (ctx.tabs.onOpen,
   * Task 4) must close its own port of that view on `pageTab.close` and ignore an unknown id, or a
   * replaced desktop line stays open, and so does the web relay's end of it.
   */
  private tellPageTabClosed(open: OpenPageTab): void {
    try {
      const { view } = remoteOnly(open.viewId)
      this.deps.pageTabClosed?.(open.projectId, open.pluginId, open.tabId, view)
    } catch (err) {
      this.log(`page tab ${open.tabId} of ${open.pluginId}: telling the host it closed failed: ${errorText(err)}`)
    }
  }

  /**
   * Connect the plugin's settings page in the asking view (see the top of the file). `projectId`
   * and `viewId` are what main resolved from the caller; `pluginId`, `scope` and `nonce` are
   * renderer input and only looked up. False when refused.
   */
  connectSettingsPage(projectId: string, viewId: ViewId, pluginId: unknown, scope: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return false
    if (typeof pluginId !== 'string' || pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(pluginId)) return false
    if (!isSettingsPageScope(scope) || !this.deps.settingsPageToHost) return false
    // A plugin's settings page is the owner's, never a guest's (design §5: "settings pages never").
    if (!this.ownerView(viewId)) return false
    const scopes = this.deps.settingsPageScopes?.(projectId, pluginId)
    if (scopes === undefined || !scopes.includes(scope)) return false
    if (!this.withinCap(projectId, viewId, pluginId, settingsPagePortKey(pluginId))) return false
    // One page per plugin at a time: the older one (another load, the other scope, or the page in
    // another view: a take over) ends first, and this view holds it now. The views hear only the
    // outcome below, not the gap between the two.
    const before = this.settingsPageHolder(projectId, pluginId)
    this.endPage(projectId, pluginId)

    const id = `p${this.nextPageId++}`
    const channel = this.deps.createChannel()
    let sent = false
    try {
      // A remote view's page names it, so its listeners act in that view (origin-view.ts), as a panel's.
      sent = this.deps.settingsPageToHost(projectId, { pluginId, id, scope, ...remoteOnly(viewId) }, channel.host)
    } catch (err) {
      this.log(`settings page of ${pluginId}: handing the host its port failed: ${errorText(err)}`)
    }
    if (!sent) {
      this.closeQuietly(channel.host)
      this.closeQuietly(channel.renderer)
      if (before !== undefined) this.held(projectId, pluginId)
      return false
    }
    const key = `${projectId}\n${pluginId}`
    this.openPages.set(key, { projectId, pluginId, id, viewId })
    try {
      this.deps.toRenderer(viewId, { panelKey: settingsPagePortKey(pluginId), nonce }, channel.renderer)
    } catch (err) {
      this.log(`settings page of ${pluginId}: posting the view its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      this.endPage(projectId, pluginId)
      this.held(projectId, pluginId)
      return false
    }
    if (before !== viewId) this.held(projectId, pluginId)
    return true
  }

  /** The view holding the plugin's settings page in the project now, if one does (settingsPage.info). */
  settingsPageHolder(projectId: string, pluginId: string): ViewId | undefined {
    return this.openPages.get(`${projectId}\n${pluginId}`)?.viewId
  }

  /** Tell the project's views who holds the plugin's settings page now (see the top of the file). */
  private held(projectId: string, pluginId: string): void {
    try {
      this.deps.settingsPageHeld?.(projectId, pluginId, this.settingsPageHolder(projectId, pluginId) ?? null)
    } catch (err) {
      this.log(`settings page of ${pluginId}: telling the views who holds it failed: ${errorText(err)}`)
    }
  }

  /**
   * The shell of `viewId` unmounted the plugin's settings page: its backend hears the close (once).
   * Only when that view holds the page: a view whose page was taken by another one unmounting its
   * stale copy must not end the page the other view shows now.
   */
  disconnectSettingsPage(projectId: string, viewId: ViewId, pluginId: unknown): void {
    if (typeof pluginId !== 'string') return
    if (this.openPages.get(`${projectId}\n${pluginId}`)?.viewId !== viewId) return
    this.endPage(projectId, pluginId)
    this.held(projectId, pluginId)
  }

  /** End the plugin's open settings page, whichever view holds it: its backend hears the close (once). */
  private endPage(projectId: string, pluginId: string): void {
    const key = `${projectId}\n${pluginId}`
    const open = this.openPages.get(key)
    if (!open) return
    this.openPages.delete(key)
    try {
      this.deps.settingsPageClosed?.(open.projectId, open.pluginId, open.id)
    } catch (err) {
      this.log(`settings page of ${open.pluginId}: telling the host it closed failed: ${errorText(err)}`)
    }
  }

  /** The shell of `viewId` unmounted a slot frame of the project: its provider hears that view's close (once). */
  disconnectSlot(projectId: string, viewId: ViewId, frameId: unknown): void {
    if (typeof frameId !== 'string') return
    const key = slotKey(projectId, viewId, frameId)
    const open = this.openSlots.get(key)
    if (!open) return
    this.openSlots.delete(key)
    this.tellClosed(open)
  }

  /**
   * A view is gone (a browser left, or its window closed): its slot and page tab instances end and
   * the settings page it held ends, so the providers do not keep serving a page nobody shows. Its panel ports
   * are not tracked here: a desktop page's ends die with its window and the host hears it on each
   * port; a remote view's page ends are held by its connection's relay (main/web/port-relay.ts),
   * which closes them all when the view leaves, so each host detaches that view's ports. The
   * per-view keying here removes the per-panel global bound the connect cap used to give: the
   * connection caps live views per window and device instead (MAX_VIEWS_PER_DEVICE_WINDOW).
   */
  viewGone(viewId: ViewId): void {
    for (const [key, open] of [...this.openSlots]) {
      if (open.viewId !== viewId) continue
      this.openSlots.delete(key)
      this.tellClosed(open)
    }
    for (const [key, open] of [...this.openPageTabs]) {
      if (open.viewId !== viewId) continue
      this.openPageTabs.delete(key)
      this.tellPageTabClosed(open)
    }
    for (const open of [...this.openPages.values()]) {
      if (open.viewId !== viewId) continue
      this.endPage(open.projectId, open.pluginId)
      this.held(open.projectId, open.pluginId)
    }
  }

  /** The project's slot frames are now `ids` (LayoutService framesChanged): every other open one closes, in every view. */
  slotFramesChanged(projectId: string, ids: ReadonlySet<string>): void {
    for (const [key, open] of [...this.openSlots]) {
      if (open.projectId !== projectId || ids.has(open.frameId)) continue
      this.openSlots.delete(key)
      this.tellClosed(open)
    }
  }

  private tellClosed(open: OpenSlot): void {
    try {
      const { view } = remoteOnly(open.viewId)
      this.deps.slotClosed?.(open.projectId, open.pluginId, open.frameId, view)
    } catch (err) {
      this.log(`slot frame ${open.frameId} of ${open.pluginId}: telling the host it closed failed: ${errorText(err)}`)
    }
  }

  /** A host (re)started and these plugins run in it: their panels reload and connect again. */
  hostReady(projectId: string, pluginIds: readonly string[]): void {
    if (pluginIds.length === 0) return
    this.deps.reload(projectId, [...pluginIds])
  }

  /**
   * How `viewId` may hold a line to `pluginId`'s pages in the project (see the top of the file, "Guests").
   * Read on every connect, never cached: a kick, a role switch or a hidden plugin holds for the next one.
   */
  private viewLine(projectId: string, viewId: ViewId, pluginId: string): ViewLine | undefined {
    const { view } = remoteOnly(viewId)
    if (view === undefined) return { tag: { access: 'owner' } }
    const who = this.deps.whoOf(viewId)
    if (who === undefined) return undefined
    if (who === 'owner') return { tag: { view, access: 'owner' } }
    // A guest's view: its role only from the guest store; nothing without one, or for a guest it no longer has.
    const access = this.deps.guestAccess?.(viewId)
    if (access === undefined || access.kind !== 'guest' || access.projectId !== projectId) return undefined
    const port = this.deps.guestPort?.(projectId, pluginId, access.role) ?? 'none'
    if (port === 'none') return undefined
    return { tag: { view, access: access.role }, ...(port === 'oneWay' ? { oneWay: true as const } : {}) }
  }

  /** Whether `viewId` is an owner's (the desktop page, or a remote view main knows as the owner's). */
  private ownerView(viewId: ViewId): boolean {
    if (!isRemoteViewId(viewId)) return true
    return this.deps.whoOf(viewId) === 'owner'
  }

  /**
   * Count this connect against the panel's cap; false when it is over. Keyed by main's resolved
   * ids only, so a renderer cannot grow the map with made-up keys (one entry per declared panel
   * of a running plugin per view; an entry whose times all aged out is dropped on the next look).
   */
  private withinCap(projectId: string, viewId: ViewId, pluginId: string, panelId: string): boolean {
    const now = this.now()
    for (const [k, v] of this.recent) {
      if (v.times.every((t) => now - t >= CONNECT_WINDOW_MS)) this.recent.delete(k)
    }
    const key = `${projectId}\n${viewId}\n${pluginId}/${panelId}`
    const entry = this.recent.get(key) ?? { times: [], logged: false }
    entry.times = entry.times.filter((t) => now - t < CONNECT_WINDOW_MS)
    this.recent.set(key, entry)
    if (entry.times.length >= MAX_CONNECTS_PER_PANEL) {
      // Once per burst: a reload loop must not turn into a log line per load.
      if (!entry.logged) this.log(`panel ${pluginId}/${panelId}: more than ${MAX_CONNECTS_PER_PANEL} connects in ${CONNECT_WINDOW_MS / 1000} s, refusing`)
      entry.logged = true
      return false
    }
    entry.times.push(now)
    entry.logged = false
    return true
  }

  private closeQuietly(port: P): void {
    try {
      this.deps.close(port)
    } catch {
      // Already closed or transferred.
    }
  }
}
