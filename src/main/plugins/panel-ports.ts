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
// No Electron import: the channel factory (MessageChannelMain) and the two senders are injected
// by index.ts; unit tests pass fakes.

import { errorText } from '../../shared/error-text'

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
  /** Post the renderer end to the window (webContents.postMessage on PANEL_PORT_CHANNEL). */
  toRenderer(windowId: number, payload: { panelKey: string; nonce: number }, port: P): void
  /** Tell the project's window to reload these plugins' panels (`panels.reload`). */
  reload(projectId: string, pluginIds: string[]): void
  close(port: P): void
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
