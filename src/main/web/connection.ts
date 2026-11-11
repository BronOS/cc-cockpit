// One remote view per gateway socket (design-web.md §2.1, §3): the handshake that binds the socket
// to one open project window, invokes run through the IPC router's own handlers, and events from
// the ViewRegistry go out as `event` frames.
//
// The binding is made once, at `hello`, from main's own table (`windowIdOf`): the frame names a
// project, main looks up the window that shows it now and mints the view id. From then on the
// connection's WebCaller (router.ts `webCaller`, frozen) is the only identity its invokes carry;
// nothing in a later frame or payload can name another window, project or view, and a second
// `hello` closes the socket. The router re-checks the window on every call, and the registry tells
// the connection when its window closes (`windowClosed`), which closes the socket.
//
// Terminals (Task 12, design-web.md §5.2): a remote view gets its tabs' output as `term.snapshot` /
// `term.data` frames from the headless mirror (view-terminals.ts), joined when the view selects a
// tab (`tabs.selected`, the router's `viewSelect`) and flow-controlled by its own acks (`viewAck`),
// never as `tabs.data` events: those are the desktop's, numbered nowhere, and the pty no longer
// waits for any view's ack.
//
// Plugin pages (Task 20, design-web.md §5.5): `ready` also carries where this view's browser loads
// plugin files and inline overlays (WebPagePaths: a token per (device, plugin), plugin-pages.ts),
// and a `paths` frame replaces them when the installed plugins change (`pathsChanged`). The
// gateway serves a path only while its device has a view bound here (`deviceViews`).
//
// Panel ports (Task 22, design-web.md §5.3): the view's sink takes the page end of each panel,
// slot and settings page channel main makes for it (`postPort`), and port-relay.ts relays it as
// `port.*` frames; the view leaving closes every end it held. A device may hold at most
// MAX_VIEWS_PER_DEVICE_WINDOW views of one window: each view adds a host port per panel and slot,
// so the views are what bound them (a `hello` past the cap is closed `tooManyViews`).
//
// No `ws` import: the gateway hands in its socket as `WsLike`, tests pass a fake.

import { errorText } from '../../shared/error-text'
import type { EventChannel, LayoutView, OverlayInfo, TabInfo } from '../../shared/ipc'
import { remoteViewId, type ViewId } from '../../shared/views'
import { MAX_VIEWS_PER_DEVICE_WINDOW, type WebPagePaths, type WebProjectEntry } from '../../shared/web-protocol'
import type { ProjectContext, WebCaller } from '../ipc/router'
import { webCaller } from '../ipc/router'
import type { ViewSink } from '../views/view-registry'
import type { WebDevice } from './devices'
import { PortRelay } from './port-relay'
import { type TerminalSource, ViewTerminals } from './view-terminals'
import {
  CLOSE,
  encodeFrame,
  eventAllowed,
  frameBytes,
  invokeAllowed,
  MAX_FRAME_BYTES,
  parseClientFrame,
  PROTOCOL_VERSION,
  type PortCloseFrame,
  type PortMsgFrame,
  type PortOpenFrame,
  type ServerFrame,
  type WebSnapshot
} from './protocol'

/** The parts of a `ws` WebSocket a connection uses. */
export interface WsLike {
  readonly readyState: number
  /** Bytes queued and not sent yet (port-relay.ts drops a panel's port past its high water). */
  readonly bufferedAmount: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

/** `WebSocket.OPEN`. */
const OPEN = 1

/** A page must say hello this soon after connecting, or the socket closes. */
export const HELLO_TIMEOUT_MS = 5000

/**
 * Invokes a view may have in flight at once. A page waits on a handful (the shell's start-up asks a
 * dozen); one that sends thousands without waiting gets `busy` answers instead of main holding a
 * promise for each.
 */
export const MAX_PENDING_INVOKES = 256

/**
 * Bytes a view's socket may have queued and unsent before the view is closed (`failed`, so the page
 * reconnects to a fresh snapshot). A view that stops reading while its socket stays open (a phone
 * asleep, before the gateway's heartbeat drops it) would otherwise pile up every window event and
 * result in main's memory. Well above what a working view queues: a tab snapshot of a few MiB plus
 * each followed tab's terminal window (VIEW_HIGH_WATER characters), and the port relay's own limit
 * (RELAY_HIGH_WATER), which closes only a panel's port, comes first.
 */
export const SOCKET_HIGH_WATER = 32 * 1024 * 1024

export interface WebConnectionDeps {
  /** IpcRouter.dispatch: the same handlers an Electron invoke reaches. */
  dispatch(caller: WebCaller, channel: string, payload: unknown): Promise<unknown>
  /** ViewRegistry.addRemote. */
  addView(windowId: number, viewId: ViewId, sink: ViewSink): () => void
  /** The window that shows the project now (WindowManager.windowIdOf); project windows only. */
  windowIdOf(projectId: string): number | undefined
  /**
   * The window's state for `ready`. Synchronous on purpose: it is taken in the same tick the view
   * is registered, so no event falls between the snapshot and the first event frame.
   */
  snapshot(ctx: ProjectContext): WebSnapshot
  /** The headless terminals (TerminalMirror) a view's tabs are joined in. */
  mirror: TerminalSource
  /** Whether `tabId` is one of the project's tabs now (TabManager's own table). */
  hasTab(projectId: string, tabId: string): boolean
  /**
   * Where the device's browser loads plugin files and inline overlays (PluginPages.paths). Absent:
   * none (every plugin frame and image stays empty).
   */
  pagePaths?(deviceId: string): WebPagePaths
  /** The view is gone (TabManager.viewGone): the tabs it sized fall back to a remaining view. */
  viewGone?(viewId: ViewId): void
  log(message: string): void
  helloTimeoutMs?: number
}

/**
 * What a join reads for `ready`. Plain reads only, and typed so: the desktop's re-attach calls
 * (`TabManager.attach`, `OverlayManager.list`) reset the desktop's terminal flow, and `list` also
 * marks every html overlay's page as not ready (an opener's later posts wait in the outbox for a
 * `pageReady` the desktop page, which did not reload, never sends) and brings its loader back. A
 * browser joining or reconnecting must leave the desktop exactly as it was.
 */
export interface SnapshotSources {
  tabs: { list(projectId: string): TabInfo[] }
  layouts: { view(projectId: string): LayoutView | undefined }
  overlays: { infos(windowId: number): OverlayInfo[] }
  /** A plain read of the window's pending plugin close asks (CloseAsks.pendingFor). */
  closeAsks: { pendingFor(windowId: number): Array<{ requestId: string; tabId: string }> }
  /** A plain read of the window's pending `ccc plugin link` confirms (LinkAsks.pendingFor). */
  linkAsks: { pendingFor(windowId: number): WebSnapshot['linkAsks'] }
  /** Main's server-mode flag, passed on as `WebSnapshot.server` (a UI hint). Absent: false. */
  server?: boolean
}

/** The window's state for `ready` (`WebConnectionDeps.snapshot`); throws when the project is gone. */
export function windowSnapshot(sources: SnapshotSources, { windowId, projectId }: ProjectContext): WebSnapshot {
  const layout = sources.layouts.view(projectId)
  if (!layout) throw new Error('project record is gone')
  return {
    tabs: sources.tabs.list(projectId),
    layout,
    overlays: sources.overlays.infos(windowId),
    closeAsks: sources.closeAsks.pendingFor(windowId),
    linkAsks: sources.linkAsks.pendingFor(windowId),
    server: sources.server === true
  }
}

/**
 * The web picker's list (gateway PROJECTS_PATH): the projects that have a window open now, from
 * main's window table, never the registry's recents: a remote view can only bind to an open window
 * (the hello above looks it up the same way) and cannot open one on the host. A window whose
 * record is gone mid-close is left out. Plain fields only.
 */
export function openProjectEntries(
  windows: { projectWindows(): Array<{ projectId: string }> },
  record: (projectId: string) => { id: string; name: string; path: string } | undefined
): WebProjectEntry[] {
  return windows.projectWindows().flatMap(({ projectId }) => {
    const r = record(projectId)
    return r ? [{ id: r.id, name: r.name, path: r.path }] : []
  })
}

/** Accepts gateway sockets (`WebGateway.setSocketHandler`) and mints a view id for each. */
export class WebConnections {
  private nextView = 1
  private readonly open = new Map<ViewId, WebConnection>()
  /** Set by `endAll`: from then on a new socket is closed with the same notice at once. */
  private ended: { code: number; reason: string } | undefined

  constructor(private readonly deps: WebConnectionDeps) {}

  accept(ws: WsLike, device: WebDevice): WebConnection {
    const viewId = remoteViewId(this.nextView++)
    const conn = new WebConnection(ws, device, viewId, this.deps, () => this.open.delete(viewId), (deviceId, windowId) =>
      this.boundViews(deviceId, windowId)
    )
    this.open.set(viewId, conn)
    if (this.ended) conn.end(this.ended.code, this.ended.reason)
    return conn
  }

  /**
   * Close every view with a notice the page shows (the app quitting: design-web.md §5.6, `CLOSE.appQuit`),
   * and every socket accepted after this too. Called on `before-quit`, while the windows are still
   * open: each window closing would otherwise close its views with `windowClosed` ("the project window
   * was closed"), and the gateway's stop on `will-quit` drops sockets without a close frame (1006,
   * which the page retries as "host unreachable"). The close frames go out while the windows close.
   */
  endAll(code: number, reason: string): void {
    this.ended = { code, reason }
    for (const conn of [...this.open.values()]) conn.end(code, reason)
  }

  /**
   * The windows and projects a device's bound views show now (plugin-pages.ts serves a device's
   * paths only for these). A view still waiting for `hello`, or gone, shows nothing.
   */
  deviceViews(deviceId: string): ProjectContext[] {
    const out: ProjectContext[] = []
    for (const conn of this.open.values()) {
      const bound = conn.deviceId === deviceId ? conn.binding() : undefined
      if (bound) out.push(bound)
    }
    return out
  }

  /** How many open views `deviceId` has bound to `windowId` (the cap at `hello`). */
  private boundViews(deviceId: string, windowId: number): number {
    let n = 0
    for (const conn of this.open.values()) if (conn.deviceId === deviceId && conn.binding()?.windowId === windowId) n++
    return n
  }

  /** The installed plugins changed: every bound view whose paths differ now gets a `paths` frame. */
  pathsChanged(): void {
    for (const conn of this.open.values()) conn.refreshPaths()
  }

  /** Connections whose socket is still open (bound or still waiting for hello). */
  size(): number {
    return this.open.size
  }

  /**
   * A view's ack of a tab's output (router `viewAck`). The view id is the one main bound to the
   * socket the call came on, never the page's; a view that is gone is ignored.
   */
  ack(viewId: ViewId, tabId: string, count: number): void {
    this.open.get(viewId)?.terminalAck(tabId, count)
  }

  /** A view shows this tab now (router `viewSelect`): join its terminal stream. */
  select(viewId: ViewId, tabId: string): void {
    this.open.get(viewId)?.terminalSelect(tabId)
  }

  /**
   * A tab's process started (TabManager's lifecycle `started`): every view that selected it while
   * it had none joins its stream now (view-terminals.ts `started`).
   */
  tabStarted(tabId: string): void {
    for (const conn of this.open.values()) conn.terminalStarted(tabId)
  }

  /** A tab is gone (TabManager's lifecycle `closed`): views stop waiting for its start. */
  tabClosed(tabId: string): void {
    for (const conn of this.open.values()) conn.terminalClosed(tabId)
  }

  /**
   * The name of the device behind an open view (TabInfo.typedBy), as it was when the view
   * connected; undefined for a view that is gone. The requester's own text, plain (devices.ts).
   */
  deviceName(viewId: ViewId): string | undefined {
    return this.open.get(viewId)?.deviceName
  }
}

export class WebConnection {
  private caller: WebCaller | undefined
  private closed = false
  private pending = 0
  private removeView: (() => void) | undefined
  private terminals: ViewTerminals | undefined
  /** The page ends of this view's panel ports (made at `hello`; every end closes when the view goes). */
  private ports: PortRelay | undefined
  /**
   * Tabs whose terminal frames failed and have not been resynced since: a second failure before the
   * resync's snapshot goes out closes the view. A snapshot sent whole clears the tab (`synced`), so
   * an unrelated failure hours later resyncs again.
   */
  private readonly failedTabs = new Set<string>()
  private readonly helloTimer: ReturnType<typeof setTimeout>
  /** The paths last sent (JSON), so `refreshPaths` sends only a change. */
  private sentPaths: string | undefined

  constructor(
    private readonly ws: WsLike,
    private readonly device: WebDevice,
    readonly viewId: ViewId,
    private readonly deps: WebConnectionDeps,
    private readonly onGone: () => void,
    private readonly boundViews: (deviceId: string, windowId: number) => number = () => 0
  ) {
    this.helloTimer = setTimeout(() => this.close(CLOSE.noHello, 'no hello'), deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    ws.on('message', (data, isBinary) => this.message(data, isBinary))
    ws.on('close', () => this.gone())
  }

  /** The signed-in device's id (plugin-pages.ts tokens are per device). */
  get deviceId(): string {
    return this.device.id
  }

  /** The signed-in device's name (TabInfo.typedBy). */
  get deviceName(): string {
    return this.device.name
  }

  /**
   * The window and project this view is bound to, once `hello` bound it, while its socket is open.
   * A socket the gateway is closing (a revoked device: `terminate` now, the 'close' event later)
   * shows nothing already, so plugin-pages.ts serves its device nothing in that gap.
   */
  binding(): ProjectContext | undefined {
    return this.caller && !this.closed && this.ws.readyState === OPEN ? { windowId: this.caller.context.windowId, projectId: this.caller.context.projectId } : undefined
  }

  private message(data: unknown, isBinary: boolean): void {
    // Not only our own close: a socket the gateway is closing (web access turned off, gateway.ts
    // `close` with a notice) is CLOSING for up to CLOSE_GRACE_MS, and `ws` still emits the frames the
    // peer sent before its close frame. A page (or a hostile one ignoring the handshake) must not
    // reach IPC, terminal input included, after the person turned web access off.
    if (this.closed || this.ws.readyState !== OPEN) return
    if (isBinary) return this.close(CLOSE.badFrame, 'text frames only')
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString('utf8') : String(data)
    const frame = parseClientFrame(text)
    if ('error' in frame) {
      this.deps.log(`web access: view ${this.viewId} closed: ${frame.error}`)
      return this.close(CLOSE.badFrame, frame.error)
    }
    if (frame.t === 'hello') {
      // Exactly once: a second hello would be an attempt to rebind (another project) mid-connection.
      if (this.caller) return this.close(CLOSE.badFrame, 'hello twice')
      return this.hello(frame.v, frame.project)
    }
    if (!this.caller) return this.close(CLOSE.badFrame, 'hello first')
    if (frame.t === 'port.msg') return this.ports?.fromPage(frame.key, frame.nonce, frame.m)
    if (frame.t === 'port.close') return this.ports?.closeFromPage(frame.key, frame.nonce)
    this.invoke(this.caller, frame.id, frame.ch, frame.p)
  }

  private hello(version: number, projectId: string): void {
    clearTimeout(this.helloTimer)
    if (version !== PROTOCOL_VERSION) return this.close(CLOSE.version, 'protocol version')
    const windowId = this.deps.windowIdOf(projectId)
    // Not logged with the id itself: it is whatever the page sent.
    if (windowId === undefined) return this.close(CLOSE.noProject, 'project not open')
    // Counted before this view is bound (it is not one of them yet). A device past the cap is told
    // so, and the page stops instead of retrying (bridge.ts FINAL_CLOSES). Not for None's anonymous
    // caller: every browser is that one "device", so the ninth browser would be refused for the
    // other eight's views, and a cap anyone can step around by being anonymous bounds nothing (the
    // gateway's connection cap does).
    if (this.device.mode !== 'none' && this.boundViews(this.device.id, windowId) >= MAX_VIEWS_PER_DEVICE_WINDOW) {
      this.deps.log(`web access: view ${this.viewId} refused: device ${this.device.id} has ${MAX_VIEWS_PER_DEVICE_WINDOW} views of window ${windowId}`)
      return this.close(CLOSE.tooManyViews, 'too many views')
    }
    const caller = webCaller({ kind: 'project', windowId, projectId }, this.viewId)
    let snapshot: WebSnapshot
    try {
      snapshot = this.deps.snapshot(caller.context)
    } catch (err) {
      this.deps.log(`web access: view ${this.viewId} snapshot failed: ${errorText(err)}`)
      return this.close(CLOSE.failed, 'snapshot failed')
    }
    // Registered in the same tick as the snapshot, and `ready` is the first frame on the socket:
    // every event after the snapshot reaches this view, none of them before `ready`. Guarded like
    // the snapshot: this runs in `ws`'s message listener, so a throw here (addRemote refuses a
    // duplicate view id, which monotonic ids rule out today) must close the socket, not escape
    // into the receiver as an uncaught exception in main.
    const ports = new PortRelay({
      send: (frame) => this.sendPort(frame),
      buffered: () => this.ws.bufferedAmount,
      log: (m) => this.deps.log(m)
    })
    try {
      this.removeView = this.deps.addView(windowId, this.viewId, {
        send: (channel, payload) => this.event(channel, payload),
        // The page end of a panel, slot or settings page port main made for this view (panel-ports.ts).
        postPort: (channel, payload, port) => ports.take(channel, payload, port),
        isClosed: () => this.closed,
        windowClosed: () => this.close(CLOSE.windowClosed, 'window closed')
      })
    } catch (err) {
      this.deps.log(`web access: view ${this.viewId} bind failed: ${errorText(err)}`)
      return this.close(CLOSE.failed, 'bind failed')
    }
    this.caller = caller
    this.ports = ports
    // Joined tab by tab as the view selects them; nothing is sent before `ready` (a select is an invoke).
    this.terminals = new ViewTerminals({
      mirror: this.deps.mirror,
      canFollow: (tabId) => this.deps.hasTab(caller.context.projectId, tabId),
      send: (frame) => this.send(frame),
      failed: (tabId, err) => this.terminalFailed(tabId, err),
      synced: (tabId) => {
        this.failedTabs.delete(tabId)
      }
    })
    this.deps.log(`web access: view ${this.viewId} (device ${this.device.id}) joined window ${windowId}`)
    const paths = this.pagePaths()
    this.sentPaths = JSON.stringify(paths)
    this.send({ t: 'ready', v: PROTOCOL_VERSION, view: this.viewId, snapshot, paths })
  }

  private pagePaths(): WebPagePaths {
    try {
      return this.deps.pagePaths?.(this.device.id) ?? { plugins: {}, overlays: '' }
    } catch (err) {
      // No paths only costs this view its plugin frames; never the connection.
      this.deps.log(`web access: view ${this.viewId}: plugin paths failed: ${errorText(err)}`)
      return { plugins: {}, overlays: '' }
    }
  }

  /** Sends the view its paths again when they changed (WebConnections.pathsChanged). */
  refreshPaths(): void {
    // Not for a socket that is closing: the gateway drops a revoked device's tokens, then terminates
    // its sockets, and the 'close' event that takes the view out comes later. A plugin-set change
    // in that gap would mint the revoked device fresh tokens that nothing drops again (its id is gone).
    if (this.closed || !this.caller || this.ws.readyState !== OPEN) return
    const paths = this.pagePaths()
    const text = JSON.stringify(paths)
    if (text === this.sentPaths) return
    this.sentPaths = text
    this.send({ t: 'paths', paths })
  }

  private invoke(caller: WebCaller, id: number, channel: string, payload: unknown): void {
    // Checked here, before the router, so a refused name never reaches it; the router checks again.
    if (!invokeAllowed(channel)) return this.send({ t: 'result', id, ok: false, err: `${channel.slice(0, 64)}: refused` })
    if (this.pending >= MAX_PENDING_INVOKES) return this.send({ t: 'result', id, ok: false, err: 'busy' })
    this.pending++
    this.deps.dispatch(caller, channel, payload).then(
      (value: unknown) => {
        this.pending--
        this.send({ t: 'result', id, ok: true, v: value })
      },
      (err: unknown) => {
        this.pending--
        // The message only, as an IPC invoke rejects with: never a stack or the error object.
        this.send({ t: 'result', id, ok: false, err: errorText(err) })
      }
    )
  }

  /** The page acked a tab's output (router `viewAck`). */
  terminalAck(tabId: string, count: number): void {
    if (!this.closed) this.terminals?.ack(tabId, count)
  }

  /** The page shows this tab now (router `viewSelect`); a tab not of this window is refused there. */
  terminalSelect(tabId: string): void {
    if (!this.closed) this.terminals?.select(tabId)
  }

  /** The tab's process started (WebConnections.tabStarted). */
  terminalStarted(tabId: string): void {
    if (!this.closed) this.terminals?.started(tabId)
  }

  /** The tab is gone (WebConnections.tabClosed). */
  terminalClosed(tabId: string): void {
    if (!this.closed) this.terminals?.closed(tabId)
  }

  /**
   * A tab's terminal frames could not be sent (view-terminals.ts left the tab): the page may hold a
   * partial snapshot or a gap. Resync by joining the tab again, on a later turn (not inside the
   * mirror's callback); a second failure on the same tab before that resync's snapshot went out
   * closes the view, which reconnects to a fresh `ready`, rather than loop on a send that keeps
   * failing.
   */
  private terminalFailed(tabId: string, err: unknown): void {
    if (this.closed) return
    this.deps.log(`web access: view ${this.viewId}: terminal frames failed: ${errorText(err)}`)
    if (this.failedTabs.has(tabId)) return this.close(CLOSE.failed, 'terminal stream failed')
    this.failedTabs.add(tabId)
    setTimeout(() => {
      if (!this.closed) this.terminals?.select(tabId)
    }, 0)
  }

  private event(channel: EventChannel, payload: unknown): void {
    // The registry sends every event of the window; a `no`-class one (or a name that is not an
    // event channel) never leaves main for a remote view.
    if (!eventAllowed(channel)) return
    // The desktop's terminal output: this view gets its own, numbered, as term.* frames (header).
    if (channel === 'tabs.data') return
    this.send({ t: 'event', ch: channel, p: payload })
  }

  private send(frame: ServerFrame): void {
    if (this.closed || this.ws.readyState !== OPEN) return
    let text: string
    try {
      text = encodeFrame(frame)
    } catch (err) {
      // A value JSON cannot hold (a cycle, a BigInt): an answer becomes an error; anything else
      // would leave the view out of step, so it reconnects to a fresh snapshot.
      if (frame.t === 'result') return this.send({ t: 'result', id: frame.id, ok: false, err: 'result not serializable' })
      this.deps.log(`web access: view ${this.viewId}: ${frame.t} not serializable: ${errorText(err)}`)
      return this.close(CLOSE.failed, 'not serializable')
    }
    if (frameBytes(text) > MAX_FRAME_BYTES) {
      if (frame.t === 'result' && frame.ok) return this.send({ t: 'result', id: frame.id, ok: false, err: 'result too large' })
      // A dropped event would leave the view showing something else than the window; closing makes
      // it reconnect and start again from a snapshot (design-web.md §3: no resume in v1).
      this.deps.log(`web access: view ${this.viewId}: ${frame.t === 'event' ? frame.ch : frame.t} frame over ${MAX_FRAME_BYTES} bytes`)
      return this.close(CLOSE.tooLarge, 'frame too large')
    }
    if (this.ws.bufferedAmount > SOCKET_HIGH_WATER) {
      this.deps.log(`web access: view ${this.viewId}: over ${SOCKET_HIGH_WATER} bytes unsent, closed to resync`)
      return this.close(CLOSE.failed, 'view behind')
    }
    this.ws.send(text)
  }

  /**
   * A port frame: false when it did not go out (closing socket, or over MAX_FRAME_BYTES). Unlike an
   * event, an oversize panel message costs only its port (port-relay.ts closes it), never the view.
   */
  private sendPort(frame: PortOpenFrame | PortMsgFrame | PortCloseFrame): boolean {
    if (this.closed || this.ws.readyState !== OPEN) return false
    const text = encodeFrame(frame)
    if (frameBytes(text) > MAX_FRAME_BYTES) {
      this.deps.log(`web access: view ${this.viewId}: panel ${frame.key} message over ${MAX_FRAME_BYTES} bytes, its port closed`)
      return false
    }
    this.ws.send(text)
    return true
  }

  /** Close the view with `code` (WebConnections.endAll). */
  end(code: number, reason: string): void {
    this.close(code, reason)
  }

  private close(code: number, reason: string): void {
    if (this.closed) return
    this.gone()
    this.ws.close(code, reason)
  }

  /** The socket closed (or main closed it): the view leaves the registry, its answers are dropped. */
  private gone(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.helloTimer)
    this.terminals?.dispose()
    this.terminals = undefined
    // Every page end this view held closes, so each plugin host detaches this view's ports (the
    // socket is gone: nothing is sent). Before viewGone, which ends the view's slot instances.
    this.ports?.closeAll()
    this.ports = undefined
    this.removeView?.()
    this.removeView = undefined
    if (this.caller) {
      try {
        this.deps.viewGone?.(this.viewId)
      } catch (err) {
        this.deps.log(`web access: view ${this.viewId} size fallback failed: ${errorText(err)}`)
      }
    }
    this.onGone()
    if (this.caller) this.deps.log(`web access: view ${this.viewId} left`)
  }
}
