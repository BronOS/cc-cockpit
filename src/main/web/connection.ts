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
// No `ws` import: the gateway hands in its socket as `WsLike`, tests pass a fake.

import { errorText } from '../../shared/error-text'
import type { EventChannel, LayoutView, OverlayInfo, TabInfo } from '../../shared/ipc'
import { remoteViewId, type ViewId } from '../../shared/views'
import type { WebProjectEntry } from '../../shared/web-protocol'
import type { ProjectContext, WebCaller } from '../ipc/router'
import { webCaller } from '../ipc/router'
import type { ViewSink } from '../views/view-registry'
import type { WebDevice } from './devices'
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
  type ServerFrame,
  type WebSnapshot
} from './protocol'

/** The parts of a `ws` WebSocket a connection uses. */
export interface WsLike {
  readonly readyState: number
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
}

/** The window's state for `ready` (`WebConnectionDeps.snapshot`); throws when the project is gone. */
export function windowSnapshot(sources: SnapshotSources, { windowId, projectId }: ProjectContext): WebSnapshot {
  const layout = sources.layouts.view(projectId)
  if (!layout) throw new Error('project record is gone')
  return { tabs: sources.tabs.list(projectId), layout, overlays: sources.overlays.infos(windowId) }
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

  constructor(private readonly deps: WebConnectionDeps) {}

  accept(ws: WsLike, device: WebDevice): WebConnection {
    const viewId = remoteViewId(this.nextView++)
    const conn = new WebConnection(ws, device, viewId, this.deps, () => this.open.delete(viewId))
    this.open.set(viewId, conn)
    return conn
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
}

export class WebConnection {
  private caller: WebCaller | undefined
  private closed = false
  private pending = 0
  private removeView: (() => void) | undefined
  private terminals: ViewTerminals | undefined
  /**
   * Tabs whose terminal frames failed and have not been resynced since: a second failure before the
   * resync's snapshot goes out closes the view. A snapshot sent whole clears the tab (`synced`), so
   * an unrelated failure hours later resyncs again.
   */
  private readonly failedTabs = new Set<string>()
  private readonly helloTimer: ReturnType<typeof setTimeout>

  constructor(
    private readonly ws: WsLike,
    private readonly device: WebDevice,
    readonly viewId: ViewId,
    private readonly deps: WebConnectionDeps,
    private readonly onGone: () => void
  ) {
    this.helloTimer = setTimeout(() => this.close(CLOSE.noHello, 'no hello'), deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)
    ws.on('message', (data, isBinary) => this.message(data, isBinary))
    ws.on('close', () => this.gone())
  }

  /** The window and project this view is bound to, once `hello` bound it. */
  binding(): ProjectContext | undefined {
    return this.caller ? { windowId: this.caller.context.windowId, projectId: this.caller.context.projectId } : undefined
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
    this.invoke(this.caller, frame.id, frame.ch, frame.p)
  }

  private hello(version: number, projectId: string): void {
    clearTimeout(this.helloTimer)
    if (version !== PROTOCOL_VERSION) return this.close(CLOSE.version, 'protocol version')
    const windowId = this.deps.windowIdOf(projectId)
    // Not logged with the id itself: it is whatever the page sent.
    if (windowId === undefined) return this.close(CLOSE.noProject, 'project not open')
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
    try {
      this.removeView = this.deps.addView(windowId, this.viewId, {
        send: (channel, payload) => this.event(channel, payload),
        isClosed: () => this.closed,
        windowClosed: () => this.close(CLOSE.windowClosed, 'window closed')
      })
    } catch (err) {
      this.deps.log(`web access: view ${this.viewId} bind failed: ${errorText(err)}`)
      return this.close(CLOSE.failed, 'bind failed')
    }
    this.caller = caller
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
    this.send({ t: 'ready', v: PROTOCOL_VERSION, view: this.viewId, snapshot })
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
    this.ws.send(text)
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
    this.removeView?.()
    this.removeView = undefined
    this.onGone()
    if (this.caller) this.deps.log(`web access: view ${this.viewId} left`)
  }
}
