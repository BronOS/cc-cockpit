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
//
// Refused (false, both ends closed, nothing sent): a panel key that is not `<pluginId>/<panelId>`
// of a plugin RUNNING in this project's host now, with that panel in its manifest. A panel of a
// plugin without host code, one still starting, disabled or given up on, gets no port; its page
// still renders (and queues what it posts, see src/sdk/panel.ts).
//
// Capped: at most MAX_CONNECTS_PER_PANEL connects per CONNECT_WINDOW_MS for one panel of one
// window (refused like the cases above). A page may `location.reload()` itself in a loop (its
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
// No Electron import: the channel factory (MessageChannelMain) and the two senders are injected
// by index.ts; unit tests pass fakes.

import { errorText } from '../../shared/error-text'
import { SLOT_FRAME_ID_PATTERN, slotPortKey, type SlotHost } from '../../shared/slots'
import type { JsonValue } from '../../sdk/types'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, type SettingsPageScope } from '../../shared/manifest'
import { isSettingsPageScope, settingsPagePortKey } from '../../shared/settings-page'
import type { SlotFrameRecord } from '../layout/layout-service'

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
  /** Hand the host its end, tagged (HostManager.sendPanelPort); false when there is no host. */
  toHost(projectId: string, pluginId: string, panelId: string, port: P): boolean
  /** Post the renderer end to the window (ViewRegistry.postPort on PANEL_PORT_CHANNEL). */
  toRenderer(windowId: number, payload: { panelKey: string; nonce: number }, port: P): void
  /** Tell the project's window to reload these plugins' panels (`panels.reload`). */
  reload(projectId: string, pluginIds: string[]): void
  close(port: P): void
  /** A slot frame the project draws now (LayoutService.slotFrame): main's own record. Absent: no slots. */
  slotFrame?(projectId: string, frameId: string): SlotFrameRecord | undefined
  /** Hand the provider's host its end with what onOpen gets (HostManager.sendSlotPort); false when it does not run. */
  slotToHost?(
    projectId: string,
    open: { pluginId: string; id: string; type: string; host: SlotHost; params?: JsonValue },
    port: P
  ): boolean
  /** The frame is gone: tell the provider's host (HostManager.closeSlot). */
  slotClosed?(projectId: string, pluginId: string, frameId: string): void
  /** The scopes of the plugin's settings page when it runs in the project's host now (HostManager.runningSettingsPage). */
  settingsPageScopes?(projectId: string, pluginId: string): readonly SettingsPageScope[] | undefined
  /** Hand the plugin's host its end of a settings page (HostManager.sendSettingsPagePort); false when it does not run. */
  settingsPageToHost?(projectId: string, open: { pluginId: string; id: string; scope: SettingsPageScope }, port: P): boolean
  /** The page is gone: tell the plugin's host (HostManager.closeSettingsPage). */
  settingsPageClosed?(projectId: string, pluginId: string, id: string): void
  log?: (message: string) => void
  /** Clock for the connect cap (tests); Date.now by default. */
  now?: () => number
}

/** Longest panel key looked at (a plugin id is at most 100, a contribution id 64). */
const MAX_PANEL_KEY_LENGTH = 200

/**
 * Connects one panel of one window may make per CONNECT_WINDOW_MS. A well-behaved page connects
 * once per load: at window open, on a host restart (`panels.reload`) and when the user moves or
 * reopens it, far fewer than this in ten seconds.
 */
export const MAX_CONNECTS_PER_PANEL = 10
export const CONNECT_WINDOW_MS = 10_000

export class PanelPortHub<P> {
  private readonly log: (message: string) => void
  private readonly now: () => number
  /** Recent connect times per `<projectId>\n<windowId>\n<pluginId>/<panelId>` (main's own ids). */
  private readonly recent = new Map<string, { times: number[]; logged: boolean }>()
  /** `<projectId>\n<frameId>` -> the provider of a slot frame whose port went out and is not closed yet. */
  private readonly openSlots = new Map<string, { projectId: string; pluginId: string; frameId: string }>()
  /** `<projectId>\n<pluginId>` -> the id of the plugin's settings page whose port went out and is not closed yet. */
  private readonly openPages = new Map<string, { projectId: string; pluginId: string; id: string }>()
  private nextPageId = 1

  constructor(private readonly deps: PanelPortDeps<P>) {
    this.log = deps.log ?? ((m) => console.warn(m))
    this.now = deps.now ?? Date.now
  }

  /**
   * Connect one panel instance of the asking window. `projectId` and `windowId` are what main
   * resolved from the sender; `panelKey` and `nonce` are renderer input and only looked up.
   */
  connect(projectId: string, windowId: number, panelKey: unknown, nonce: unknown): boolean {
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
    if (!this.withinCap(projectId, windowId, pluginId, panelId)) return false

    const channel = this.deps.createChannel()
    let sent = false
    try {
      sent = this.deps.toHost(projectId, pluginId, panelId, channel.host)
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
      this.deps.toRenderer(windowId, { panelKey: `${pluginId}/${panelId}`, nonce }, channel.renderer)
    } catch (err) {
      // The window is closing; the host's end hears nothing and goes when the host does.
      this.log(`panel ${pluginId}/${panelId}: posting the window its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      return false
    }
    return true
  }

  /**
   * Connect one slot frame of the asking window (see the top of the file). `projectId` and
   * `windowId` are what main resolved from the sender; `frameId` and `nonce` are renderer input and
   * only looked up. False when refused: no such frame now, the provider not running, over the cap.
   */
  connectSlot(projectId: string, windowId: number, frameId: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return false
    if (typeof frameId !== 'string' || !SLOT_FRAME_ID_PATTERN.test(frameId)) return false
    const frame = this.deps.slotFrame?.(projectId, frameId)
    if (!frame || !this.deps.slotToHost) return false
    // From here on the ids are main's own strings (the record's), not the renderer's.
    const id = frame.info.id
    const pluginId = frame.info.pluginId
    if (!this.withinCap(projectId, windowId, pluginId, slotPortKey(id))) return false
    // Its page loaded again: the provider's instance for the old load goes first.
    this.disconnectSlot(projectId, id)

    const channel = this.deps.createChannel()
    let sent = false
    try {
      sent = this.deps.slotToHost(
        projectId,
        { pluginId, id, type: frame.info.type, host: frame.host, ...(frame.params !== undefined ? { params: frame.params } : {}) },
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
    this.openSlots.set(`${projectId}\n${id}`, { projectId, pluginId, frameId: id })
    try {
      this.deps.toRenderer(windowId, { panelKey: slotPortKey(id), nonce }, channel.renderer)
    } catch (err) {
      this.log(`slot ${frame.info.type} of ${pluginId}: posting the window its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      this.disconnectSlot(projectId, id)
      return false
    }
    return true
  }

  /**
   * Connect the plugin's settings page in the asking window (see the top of the file). `projectId`
   * and `windowId` are what main resolved from the sender; `pluginId`, `scope` and `nonce` are
   * renderer input and only looked up. False when refused.
   */
  connectSettingsPage(projectId: string, windowId: number, pluginId: unknown, scope: unknown, nonce: unknown): boolean {
    if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce)) return false
    if (typeof pluginId !== 'string' || pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(pluginId)) return false
    if (!isSettingsPageScope(scope) || !this.deps.settingsPageToHost) return false
    const scopes = this.deps.settingsPageScopes?.(projectId, pluginId)
    if (scopes === undefined || !scopes.includes(scope)) return false
    if (!this.withinCap(projectId, windowId, pluginId, settingsPagePortKey(pluginId))) return false
    // One page per plugin at a time: the older one (another load, or the other scope) ends first.
    this.disconnectSettingsPage(projectId, pluginId)

    const id = `p${this.nextPageId++}`
    const channel = this.deps.createChannel()
    let sent = false
    try {
      sent = this.deps.settingsPageToHost(projectId, { pluginId, id, scope }, channel.host)
    } catch (err) {
      this.log(`settings page of ${pluginId}: handing the host its port failed: ${errorText(err)}`)
    }
    if (!sent) {
      this.closeQuietly(channel.host)
      this.closeQuietly(channel.renderer)
      return false
    }
    const key = `${projectId}\n${pluginId}`
    this.openPages.set(key, { projectId, pluginId, id })
    try {
      this.deps.toRenderer(windowId, { panelKey: settingsPagePortKey(pluginId), nonce }, channel.renderer)
    } catch (err) {
      this.log(`settings page of ${pluginId}: posting the window its port failed: ${errorText(err)}`)
      this.closeQuietly(channel.renderer)
      this.disconnectSettingsPage(projectId, pluginId)
      return false
    }
    return true
  }

  /** The shell unmounted the plugin's settings page in the project's window: its backend hears the close (once). */
  disconnectSettingsPage(projectId: string, pluginId: unknown): void {
    if (typeof pluginId !== 'string') return
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

  /** The shell unmounted a slot frame of the project: its provider hears the close (once). */
  disconnectSlot(projectId: string, frameId: unknown): void {
    if (typeof frameId !== 'string') return
    const key = `${projectId}\n${frameId}`
    const open = this.openSlots.get(key)
    if (!open) return
    this.openSlots.delete(key)
    this.tellClosed(open)
  }

  /** The project's slot frames are now `ids` (LayoutService framesChanged): every other open one closes. */
  slotFramesChanged(projectId: string, ids: ReadonlySet<string>): void {
    for (const [key, open] of [...this.openSlots]) {
      if (open.projectId !== projectId || ids.has(open.frameId)) continue
      this.openSlots.delete(key)
      this.tellClosed(open)
    }
  }

  private tellClosed(open: { projectId: string; pluginId: string; frameId: string }): void {
    try {
      this.deps.slotClosed?.(open.projectId, open.pluginId, open.frameId)
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
   * Count this connect against the panel's cap; false when it is over. Keyed by main's resolved
   * ids only, so a renderer cannot grow the map with made-up keys (one entry per declared panel
   * of a running plugin per window; an entry whose times all aged out is dropped on the next look).
   */
  private withinCap(projectId: string, windowId: number, pluginId: string, panelId: string): boolean {
    const now = this.now()
    for (const [k, v] of this.recent) {
      if (v.times.every((t) => now - t >= CONNECT_WINDOW_MS)) this.recent.delete(k)
    }
    const key = `${projectId}\n${windowId}\n${pluginId}/${panelId}`
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
