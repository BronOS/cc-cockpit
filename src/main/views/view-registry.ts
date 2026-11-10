// Every event main sends to a page goes through here (design-web.md §2.2). A window can have
// several live views at once: its own desktop page (a webContents) and, with web access on, remote
// browser views (one per gateway connection, a sink the gateway provides). An event for a project
// or a window reaches all of them; nothing else in main may call `webContents.send`,
// `webContents.postMessage` or `BrowserWindow.getAllWindows()` (a grep test,
// `test/unit/no-direct-webcontents-send.test.ts`, keeps it so), or a new event would quietly skip
// remote views.
//
// No Electron import: a desktop view's sink is built by the window adapter
// (`electron-window-factory.ts`) and handed in by WindowManager; unit tests pass fakes.
//
// Delivery is best effort per view, as `webContents.send` always was: a sink that is closed is
// skipped, and one that throws (a page torn down between the check and the send) is logged and the
// other views still get the event. A port post is different: it transfers a port to exactly one
// view, and the caller (PanelPortHub) must know it failed to close the other end, so it throws.

import { errorText } from '../../shared/error-text'
import type { EventChannel } from '../../shared/ipc'
import { desktopViewId, type ViewId } from '../../shared/views'

/** One view's way out: a desktop window's webContents, or a remote view's socket. */
export interface ViewSink<P = unknown> {
  /** Deliver an event (`webContents.send`, or an `event` frame on the socket). */
  send(channel: EventChannel, payload: unknown): void
  /**
   * Transfer a MessagePort with a message (`webContents.postMessage`; a remote view's connection
   * keeps it and relays it, main/web/port-relay.ts). Absent: the view cannot take a port, and a post
   * throws. Throwing itself (a socket that cannot carry it) is a refusal too.
   */
  postPort?(channel: string, payload: unknown, port: P): void
  /** Gone for good (the webContents destroyed, the socket closed): skipped from then on. */
  isClosed(): boolean
  /**
   * The view's window closed and the view was dropped (`removeWindow`). A remote view closes its
   * socket here, so a browser does not sit on a window that is gone (it reconnects to the picker).
   * Absent for a desktop view: its page goes with its window.
   */
  windowClosed?(): void
}

export interface ViewRegistryOptions {
  /** The window that shows a project now (WindowManager.windowIdOf); undefined when none does. */
  windowIdOf(projectId: string): number | undefined
  log?: (message: string) => void
}

interface ViewEntry<P> {
  readonly windowId: number
  readonly sink: ViewSink<P>
}

export class ViewRegistry<P = unknown> {
  /** viewId -> its window and sink. Insertion order: the desktop view first, as it is added first. */
  private readonly views = new Map<ViewId, ViewEntry<P>>()

  constructor(private readonly options: ViewRegistryOptions) {}

  /**
   * The desktop view of a window (a project window or the picker): added when the window is
   * created, before its page can ask for anything. A second add for the same window replaces the
   * first (a window id is never reused while its window lives).
   */
  addDesktop(windowId: number, sink: ViewSink<P>): ViewId {
    const id = desktopViewId(windowId)
    this.views.set(id, { windowId, sink })
    return id
  }

  /**
   * A remote view of a window, under the id the gateway minted (`remoteViewId`). The returned
   * function removes it (the socket closed); a later view with another id is not touched by it.
   */
  addRemote(windowId: number, viewId: ViewId, sink: ViewSink<P>): () => void {
    if (this.views.has(viewId)) throw new Error(`view ${viewId} is already registered`)
    const entry = { windowId, sink }
    this.views.set(viewId, entry)
    return () => {
      if (this.views.get(viewId) === entry) this.views.delete(viewId)
    }
  }

  /**
   * A window closed: every view of it goes, the remote ones too, and each is told (`windowClosed`:
   * a remote view closes its socket). Removed first and told after, so an event a closing view's
   * teardown sends cannot reach a view of the window that is gone; one that throws is logged and
   * the others are still told.
   */
  removeWindow(windowId: number): void {
    const gone: Array<[ViewId, ViewSink<P>]> = []
    for (const [id, entry] of this.views) {
      if (entry.windowId === windowId) {
        this.views.delete(id)
        gone.push([id, entry.sink])
      }
    }
    for (const [id, sink] of gone) {
      try {
        sink.windowClosed?.()
      } catch (err) {
        this.logLine(`view ${id}: window close failed: ${errorText(err)}`)
      }
    }
  }

  /** The ids of a window's live views, the desktop view first. */
  viewsOf(windowId: number): ViewId[] {
    const out: ViewId[] = []
    for (const [id, entry] of this.views) {
      if (entry.windowId === windowId && !entry.sink.isClosed()) out.push(id)
    }
    return out
  }

  /** The window a view belongs to, or undefined for an unknown or closed view. */
  windowOf(viewId: ViewId): number | undefined {
    const entry = this.views.get(viewId)
    return entry && !entry.sink.isClosed() ? entry.windowId : undefined
  }

  /** Every view of the window that shows `projectId` (none when no window does, or one mid-close). */
  toProject(projectId: string, channel: EventChannel, payload: unknown): void {
    const windowId = this.options.windowIdOf(projectId)
    if (windowId !== undefined) this.toWindow(windowId, channel, payload)
  }

  /**
   * Every view of one window. Returns whether at least one view took it, for a caller that waits
   * for an answer (a close ask): none means nobody will ever answer.
   */
  toWindow(windowId: number, channel: EventChannel, payload: unknown): boolean {
    let sent = false
    for (const [id, entry] of this.views) {
      if (entry.windowId === windowId && this.deliver(id, entry, channel, payload)) sent = true
    }
    return sent
  }

  /** One view only (per-view state: a selection, an answer). False when it is unknown or closed. */
  toView(viewId: ViewId, channel: EventChannel, payload: unknown): boolean {
    const entry = this.views.get(viewId)
    return entry !== undefined && this.deliver(viewId, entry, channel, payload)
  }

  /** Every view of every window, the picker included (app-wide state: theme, prefs, updates). */
  toAll(channel: EventChannel, payload: unknown): void {
    for (const [id, entry] of this.views) this.deliver(id, entry, channel, payload)
  }

  /**
   * Transfer `port` to one view. Throws when the view is unknown, closed or cannot take ports, so
   * the caller closes both ends instead of leaving a host end with nobody on the other side.
   */
  postPort(viewId: ViewId, channel: string, payload: unknown, port: P): void {
    const entry = this.views.get(viewId)
    if (!entry || entry.sink.isClosed()) throw new Error('the view is gone')
    if (!entry.sink.postPort) throw new Error('the view cannot take a port')
    entry.sink.postPort(channel, payload, port)
  }

  private deliver(id: ViewId, entry: ViewEntry<P>, channel: EventChannel, payload: unknown): boolean {
    if (entry.sink.isClosed()) return false
    try {
      entry.sink.send(channel, payload)
      return true
    } catch (err) {
      // One broken view must not keep the event from the others (a loop over webContents.send
      // used to stop at the first throw).
      this.logLine(`event ${channel} to view ${id} failed: ${errorText(err)}`)
      return false
    }
  }

  private logLine(message: string): void {
    const log = this.options.log ?? ((m: string) => console.warn(m))
    log(message)
  }
}
