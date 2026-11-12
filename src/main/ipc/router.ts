// The one place IPC handlers are registered. Every handler gets a context main resolved itself
// from `event.sender` (which window, which project) and the payload; nothing a renderer sends can
// change which project a handler acts on. A sender main did not open is refused before any
// handler runs.
//
// No runtime `electron` import: `ipcMain` comes in through `IpcMainLike` so vitest can drive the
// router with fake events.
import { fileURLToPath } from 'node:url'
import type {
  AppearanceView,
  CccCommandView,
  CommandsView,
  DiscussAnswer,
  InvokeChannel,
  IpcInvokeMap,
  LayoutView,
  MarketplaceUpdateAllResult,
  MarketplaceView,
  NotificationSoundData,
  NotificationSoundGroup,
  OverlayInfo,
  PluginSettingsSaveResult,
  PluginView,
  ProjectSettingsView,
  ProjectSummary,
  SessionsSnapshot,
  SettingsPageInfo,
  SettingsProject,
  ShellPrefs,
  TabCommandMenu,
  TabCreateRequest,
  TabInfo,
  UpdateState,
  WindowInfo
} from '../../shared/ipc'
import { remoteAllowed } from '../../shared/ipc'
import { projectColorOf, type ProjectColor } from '../../shared/project-color'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, type SettingsPageScope } from '../../shared/manifest'
import { isSettingsPageScope } from '../../shared/settings-page'
import type { Theme } from '../../shared/theme'
import type { PluginServicesView } from '../../shared/services'
import type { TabFlag } from '../../shared/tab-flag'
import type { ScreenAnswer } from '../../shared/terminal-screen'
import type { ProjectView, TabCommandEntry } from '../../shared/types'
import { checkWebUrl, MAX_EXTERNAL_URL_LENGTH } from '../../shared/web-url'
import type {
  WebAccessIndicator,
  WebAccessPatch,
  WebAccessSetReply,
  WebAccessView,
  WebActionReply,
  WebLinkReply,
  WebSecretsStatus
} from '../../shared/web-access'
import { remoteIndicator, REMOTE_SECRETS_UNAVAILABLE_TEXT } from '../../shared/web-access'
import type { AccessActor } from '../web/access-log'
import type { WebviewManager, WebviewOwner } from '../webview/webview-manager'
import type { WebviewViewers } from '../webview/webview-viewers'
import type { WebviewInput } from '../webview/webview-input'
import type { OverlayButtonClick } from '../overlays/overlay-manager'
import type { DiscussTarget } from '../../shared/discuss'
import type { SenderContext } from '../windows/window-manager'
import { desktopViewId, isRemoteViewId, type ViewId, type Who } from '../../shared/views'
import type { OpenTarget } from '../external/open-external'
import { warnLog } from '../warn-log'
import { OAUTH_PASTE_REFUSED, type OAuthPasteAnswer } from '../../shared/oauth-paste'
import { isPlainObject } from '../../shared/guards'

/** The parts of an Electron `IpcMainInvokeEvent` the router reads. */
export interface IpcEventLike {
  sender: { id: number }
  /**
   * The frame that sent the message; null once it navigated or was destroyed. Only the top frame
   * of our page may talk to main: plugin panels are subframes (sandboxed iframes without the
   * preload), and a message from one would mean the isolation already broke.
   */
  senderFrame: { parent: unknown; url: string } | null
}

/**
 * Where the shell UI is loaded from: the Vite dev server under `npm run dev`, else the built
 * index.html. `loadRenderer` loads it and `appPageMatcher` pins IPC senders to it, so the two
 * cannot drift apart.
 */
export type RendererLocation = { kind: 'url'; url: string } | { kind: 'file'; path: string }

/**
 * A predicate for "this frame URL is our own shell page". The router checks it on every message
 * (Electron security checklist: validate the sender of all IPC messages) so the authority check
 * does not rest on the navigation guard in create-window.ts alone: a top frame that somehow ended
 * up on another document is refused here too.
 * - dev server: same origin (any path, query or hash: Vite serves the page and HMR from it).
 * - built file: a file: URL whose decoded path is exactly index.html (query and hash ignored;
 *   Chromium percent-encodes the frame URL, so paths are compared decoded, not as strings).
 */
export function appPageMatcher(location: RendererLocation): (url: string) => boolean {
  if (location.kind === 'url') {
    const origin = new URL(location.url).origin
    return (url) => parseUrl(url)?.origin === origin
  }
  return (url) => {
    const parsed = parseUrl(url)
    if (parsed?.protocol !== 'file:') return false
    try {
      return fileURLToPath(parsed) === location.path
    } catch {
      // A file URL with a host or an encoded `/` has no local path, so it is not our page.
      return false
    }
  }
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void
}

/** Context for a handler that acts on the sender's project. */
export interface ProjectContext {
  windowId: number
  projectId: string
}

/** A SenderContext for a project window (never the picker). */
export type ProjectSenderContext = Extract<SenderContext, { kind: 'project' }>

/**
 * A call from the desktop window's own page, through Electron IPC. Authenticated as today: the top
 * frame, on the app page, of a webContents main opened (`resolveSender`).
 */
export interface ElectronCaller {
  readonly kind: 'electron'
  readonly event: IpcEventLike
}

/**
 * A call from a remote (browser) view over the gateway (design-web.md §2.1). The gateway builds it
 * once, at handshake, from the project window it bound the connection to (§4) and the view id it
 * minted: nothing in a frame or a payload can name another window, project or view. Only a project
 * window: the gateway never binds a remote view to the picker.
 */
export interface WebCaller {
  readonly kind: 'web'
  readonly context: ProjectSenderContext
  readonly viewId: ViewId
  readonly who: Who
}

export type Caller = ElectronCaller | WebCaller

/**
 * Build a WebCaller. Main's gateway is the only caller; the check here is a second line against a
 * gateway bug (a desktop id or a picker context on a remote connection), not input validation.
 * Frozen so a handler cannot rebind the connection it was handed.
 */
export function webCaller(context: ProjectSenderContext, viewId: ViewId, who: Who = 'owner'): WebCaller {
  if (context.kind !== 'project') throw new Error('webCaller: a remote view binds to a project window only')
  if (!isRemoteViewId(viewId)) throw new Error('webCaller: not a remote view id')
  return Object.freeze({
    kind: 'web',
    context: Object.freeze({ kind: 'project', windowId: context.windowId, projectId: context.projectId }),
    viewId,
    who
  })
}

/**
 * Which view a call came from, the third argument of every handler. Handlers that keep per-view state
 * (selection, overlay answers, terminal size) key it by `viewId`; the rest ignore it. `remote` is
 * true for a browser view, for the few `adapted` channels (design §6.1) that answer it differently.
 */
export interface CallView {
  viewId: ViewId
  who: Who
  remote: boolean
}

type Req<C extends InvokeChannel> = IpcInvokeMap[C]['req']
type Res<C extends InvokeChannel> = IpcInvokeMap[C]['res']
type Result<C extends InvokeChannel> = Res<C> | Promise<Res<C>>

/** A registered handler, as the router stores it for both transports. */
type Route = (caller: Caller, payload: unknown) => unknown

export class IpcRouter {
  private readonly ipc: IpcMainLike
  private readonly resolveSender: (senderId: number) => SenderContext | undefined
  private readonly isAppPage: (url: string) => boolean
  private readonly log: (message: string) => void
  private readonly isOpenProjectWindow: (windowId: number, projectId: string) => boolean
  /**
   * Every handler, by channel, so a web frame reaches the very function an Electron invoke does
   * (`dispatch`). A Map, not an object: a channel name from a frame is untrusted, and `__proto__`
   * or `toString` must not resolve to anything.
   */
  private readonly routes = new Map<string, Route>()

  /**
   * `isAppPage` is normally `appPageMatcher(<where the shell UI is loaded from>)`.
   * `isOpenProjectWindow` says whether that window is open now and still holds that project; a web
   * call is checked against it every time, as an Electron call re-resolves its sender. The default
   * answers no, so a router nobody told about windows refuses every web call (fail closed).
   */
  constructor(
    ipc: IpcMainLike,
    resolveSender: (senderId: number) => SenderContext | undefined,
    isAppPage: (url: string) => boolean,
    log: (message: string) => void = warnLog,
    isOpenProjectWindow: (windowId: number, projectId: string) => boolean = () => false
  ) {
    this.ipc = ipc
    this.resolveSender = resolveSender
    this.isAppPage = isAppPage
    this.log = log
    this.isOpenProjectWindow = isOpenProjectWindow
  }

  /** A handler any window main opened may call (the picker included). */
  handleWindow<C extends InvokeChannel>(
    channel: C,
    handler: (ctx: SenderContext, payload: Req<C>, view: CallView) => Result<C>
  ): void {
    this.register(channel, (caller, payload) => {
      const { ctx, view } = this.authenticate(channel, caller)
      return handler(ctx, payload as Req<C>, view)
    })
  }

  /** A handler that acts on the sender's project; a picker (no project) is refused. */
  handleProject<C extends InvokeChannel>(
    channel: C,
    handler: (ctx: ProjectContext, payload: Req<C>, view: CallView) => Result<C>
  ): void {
    this.register(channel, (caller, payload) => {
      const { ctx, view } = this.authenticate(channel, caller)
      if (ctx.kind !== 'project') {
        this.log(`ipc ${channel}: refused, sender window ${ctx.windowId} has no project`)
        throw new Error(`${channel}: not a project window`)
      }
      return handler({ windowId: ctx.windowId, projectId: ctx.projectId }, payload as Req<C>, view)
    })
  }

  /**
   * Run a remote view's invoke through the same handler an Electron invoke reaches. Always async,
   * like `ipcRenderer.invoke`: a throwing handler rejects. The channel is untrusted text from the
   * frame: an unknown name or a `no`-class channel is refused before any handler runs (authenticate).
   *
   * `live` is the connection's own "socket still open" (connection.ts), asked again here, in the
   * same microtask as the handler: the frame was checked when it arrived, but the handler runs a
   * microtask later, and `ws` emits every frame of one read before any of them runs, so an earlier
   * frame of that read (a Revoke all, or main's own revoke between them) may already have revoked
   * the device and terminated its socket. Nothing is awaited between this check and the handler.
   */
  dispatch(caller: WebCaller, channel: string, payload: unknown, live: () => boolean = () => true): Promise<unknown> {
    return Promise.resolve().then(() => {
      if (!live()) throw new Error('refused, the view is closed')
      if (!remoteAllowed(channel)) {
        // The name is not logged: it is whatever the remote frame sent.
        this.log(`ipc: refused a channel remote views may not call (view ${caller.viewId})`)
        throw new Error('refused')
      }
      const route = this.routes.get(channel)
      if (!route) {
        this.log(`ipc ${channel}: no handler (view ${caller.viewId})`)
        throw new Error(`${channel}: no handler`)
      }
      return route(caller, payload)
    })
  }

  private register(channel: InvokeChannel, route: Route): void {
    if (this.routes.has(channel)) throw new Error(`second handler for ${channel}`)
    this.routes.set(channel, route)
    // Only the first argument is the payload; extra arguments are dropped, not passed along.
    this.ipc.handle(channel, (event, ...args) => route({ kind: 'electron', event }, args[0]))
  }

  private authenticate(channel: string, caller: Caller): { ctx: SenderContext; view: CallView } {
    if (caller.kind === 'web') {
      // Checked here as well as in `dispatch`: the router, not each entry point, is the one place a
      // `no`-class channel (host access, native dialogs, the host's own window) is kept from a
      // remote view.
      if (!remoteAllowed(channel)) {
        this.log(`ipc ${channel}: refused for remote view ${caller.viewId}`)
        throw new Error(`${channel}: refused`)
      }
      // The context was bound at handshake and the gateway closes the socket when its window
      // closes, but a frame can still arrive in between (the close and the socket drop race), and
      // the router is the one place for the authority check: a window that is gone, or now holds
      // another project, is refused here, so `tabs.open` can never spawn for a project no window
      // holds any more.
      const { windowId, projectId } = caller.context
      if (!this.isOpenProjectWindow(windowId, projectId)) {
        this.log(`ipc ${channel}: refused, window ${windowId} of remote view ${caller.viewId} is closed`)
        throw new Error(`${channel}: refused`)
      }
      return {
        ctx: caller.context,
        view: { viewId: caller.viewId, who: caller.who, remote: true }
      }
    }
    const { event } = caller
    if (!event.senderFrame || event.senderFrame.parent !== null) {
      this.log(`ipc ${channel}: refused, not sent by the top frame of webContents ${event.sender.id}`)
      throw new Error(`${channel}: refused`)
    }
    if (!this.isAppPage(event.senderFrame.url)) {
      // Not logged with the URL itself: it may carry whatever the foreign page put in it.
      this.log(`ipc ${channel}: refused, webContents ${event.sender.id} is not on the app page`)
      throw new Error(`${channel}: refused`)
    }
    const ctx = this.resolveSender(event.sender.id)
    if (!ctx) {
      this.log(`ipc ${channel}: refused, unknown sender webContents ${event.sender.id}`)
      throw new Error(`${channel}: refused`)
    }
    return { ctx, view: { viewId: desktopViewId(ctx.windowId), who: 'owner', remote: false } }
  }
}

/** What the core handlers need from the rest of main. */
export interface CoreHandlerDeps {
  /** Project record by id (the sender's own project only; see `window.info`). */
  getProject(id: string): ProjectView | undefined
  recentProjects(): ProjectView[]
  /** Show the native folder dialog (parented to the asking window) and open the choice. */
  openFolderDialog(windowId: number): Promise<boolean>
  openRecent(id: string): void
  /**
   * Show the project picker, or focus it when it is open (WindowManager.showPicker).
   * `callerWindowId` is the asking project window (resolved by the router from the sender): the
   * picker opens as its modal child.
   */
  showPicker(callerWindowId: number): void
  /** Whether a project window is in full screen (window.info for a window restored that way). */
  isFullScreen?(windowId: number): boolean
  /** Whether main created this project window transparent (WindowManager.isTransparent). */
  isTransparent?(windowId: number): boolean
  /**
   * Close this project's window and open it again from the current settings, its tabs restored
   * as after a restart (WindowManager.reopen; main's onProjectClosed queues them).
   */
  reopenWindow?(projectId: string): void
  /** The picker is a modal child of a project window right now. */
  pickerModal?(): boolean
  /** Close the modal picker (its Cancel / Esc). */
  dismissPicker?(): void
  /** Folder dialog, relink the missing project `id` to the choice and open it; false if cancelled. */
  relink(windowId: number, id: string): Promise<boolean>
  /** Forget the missing recent project `id`. */
  forget(id: string): void
  /** The user's home folder as a real path (the picker writes it as `~`). */
  homeDir(): string
  /** The chord the menu's Open Folder accelerator uses in the picker (menu.ts `openFolderKey`). */
  pickerOpenFolderKey(): string | undefined
  /**
   * Hand an already validated http(s) URL to the openExternal adapter (external/open-external.ts) for
   * the calling view: the system browser on the desktop, a clickable notice in a browser view
   * (design-web.md §6.1), never the host's browser in server mode.
   */
  openExternal(url: string, target: OpenTarget): void | Promise<void>
  /**
   * The theme `viewId` shows now (ThemeService.forView): the pick for every view, else by the view's
   * own screen. Never per project.
   */
  currentTheme(viewId: ViewId): Theme
  /**
   * A browser view's reported `prefers-color-scheme` (ThemeService.setViewScheme). Called only for a
   * remote view; absent: ignored.
   */
  setViewScheme?(viewId: ViewId, dark: boolean): void
  /** The app settings the shell page applies itself (AppearanceService.prefs), defaults applied. */
  shellPrefs(): ShellPrefs
  /** The project's commands with keys resolved (main's registry + the user's overrides). */
  commands(projectId: string): CommandsView
  /** Run a plugin command the project's host registered (HostManager.runCommand); rejects otherwise. */
  /** `view`: the remote view that ran it (main's id from the caller), absent for the desktop. */
  runCommand(projectId: string, id: string, view?: ViewId): Promise<void>
  /**
   * Main runs as a server (server-mode.ts, design-web.md §9): the one flag `projects.close` reads.
   * Absent or false: the desktop, where no view may close a window through the router.
   */
  server?: boolean
  /**
   * Close this project window for every device, as "Close for everyone" does
   * (WindowManager.closeForEveryone): its tabs end and its views get `windowClosed`. `viewId`: the
   * browser view that asked, for the log line.
   */
  closeProjectWindow?(windowId: number, viewId: ViewId): void
}

/**
 * Parse a link a renderer wants opened outside the app (shared/web-url.ts checkWebUrl, the same
 * check as ctx.openExternal's): http and https only, the normalized `href` returned.
 */
export function webUrlOf(value: unknown): string {
  return checkWebUrl(value, { method: 'app.openExternal', maxLength: MAX_EXTERNAL_URL_LENGTH })
}

/** Register the handlers of this task. Later tasks add theirs here too, through the same router. */
export function registerCoreHandlers(router: IpcRouter, deps: CoreHandlerDeps): void {
  router.handleWindow('window.info', (ctx): WindowInfo => {
    if (ctx.kind === 'picker') {
      const key = deps.pickerOpenFolderKey()
      return {
        kind: 'picker',
        home: deps.homeDir(),
        ...(deps.pickerModal?.() ? { modal: true } : {}),
        ...(key ? { openFolderKey: key } : {})
      }
    }
    const project = deps.getProject(ctx.projectId)
    if (!project) throw new Error('window.info: project record is gone')
    return {
      kind: 'project',
      project: summary(project),
      ...(deps.isFullScreen?.(ctx.windowId) ? { fullScreen: true } : {}),
      // From main's own table, never the current setting: the window is what it was made as.
      ...(deps.isTransparent?.(ctx.windowId) ? { transparent: true } : {})
    }
  })

  router.handleWindow('projects.recent', () => deps.recentProjects().map(summary))

  router.handleWindow('projects.openFolder', (ctx) => deps.openFolderDialog(ctx.windowId))

  router.handleWindow('projects.openRecent', (_ctx, payload) => {
    const id: unknown = (payload as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') throw new Error('projects.openRecent: id must be a string')
    deps.openRecent(id)
  })

  // The top strip's "+". Nothing in the payload: the picker is app-wide and there is one; the
  // window it opens over is the sender's, resolved here and not named by the page.
  router.handleProject('projects.showPicker', (ctx) => {
    deps.showPicker(ctx.windowId)
  })

  // Settings › Window's "Reopen window" (a creation-only setting changed). The window is the
  // sender's, resolved here; nothing in the payload is read, so a page can only ever reopen
  // itself, and the picker (no project) is refused by handleProject.
  router.handleProject('window.reopen', (ctx) => {
    if (!deps.reopenWindow) throw new Error('window.reopen: not available')
    deps.reopenWindow(ctx.projectId)
  })

  // Picker only; main decides whether this picker may be dismissed (a modal one).
  router.handleWindow('projects.closePicker', (ctx) => {
    if (ctx.kind !== 'picker') throw new Error('projects.closePicker: only the picker may close itself')
    deps.dismissPicker?.()
  })

  // `adapted` (design-web.md §9.8): a server's browser view closes its own project window for every
  // device (the in-page confirm is the person's answer; nothing asks again). The window is the one
  // main bound the caller to (ctx), and the payload is never read, so a view naming another project
  // still closes only its own. Allowed only when main runs as a server and the caller is a remote
  // view: on the desktop a browser must not close the host's window (only its own screen, the
  // desktop's close dialog, decides that), and the desktop page has its window's close button.
  router.handleProject('projects.close', (ctx, _payload, view) => {
    if (deps.server !== true || !view.remote || !deps.closeProjectWindow) {
      throw new Error('projects.close: only a browser view of a server may close a project')
    }
    deps.closeProjectWindow(ctx.windowId, view.viewId)
  })

  // Picker only: a project window has no business relinking or forgetting projects.
  router.handleWindow('projects.relink', (ctx, payload) => {
    if (ctx.kind !== 'picker') throw new Error('projects.relink: only the picker may relink')
    const id: unknown = (payload as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') throw new Error('projects.relink: id must be a string')
    return deps.relink(ctx.windowId, id)
  })

  router.handleWindow('projects.forget', (ctx, payload) => {
    if (ctx.kind !== 'picker') throw new Error('projects.forget: only the picker may forget')
    const id: unknown = (payload as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string') throw new Error('projects.forget: id must be a string')
    deps.forget(id)
  })

  // `adapted`: decided by the view main bound to the call, never by the payload. The adapter turns a
  // browser view's call into a notice in that view (external/open-external.ts).
  router.handleWindow('app.openExternal', async (ctx, payload, view) => {
    const url = webUrlOf((payload as { url?: unknown } | undefined)?.url)
    await deps.openExternal(url, { windowId: ctx.windowId, viewId: view.viewId })
  })

  // Read-only: any of our windows may ask. `adapted`: answered for the view main bound to the call
  // (a browser's own appearance with no pick, design-web.md §5.7), never by the payload. Changes
  // arrive as `theme.changed`, per view.
  router.handleWindow('theme.get', (_ctx, _payload, view) => deps.currentTheme(view.viewId))
  // `adapted`: a browser view's own appearance. Taken only from a remote view (`view.remote`, main's
  // binding): the desktop page follows nativeTheme, and a desktop call is ignored rather than
  // refused (the shared shell code may report from either). It can only pick between the two
  // built-ins for this one view.
  router.handleWindow('theme.scheme', (_ctx, payload, view) => {
    const dark = fields('theme.scheme', payload).dark
    if (typeof dark !== 'boolean') throw new Error('theme.scheme: dark must be a boolean')
    if (!view.remote) return
    deps.setViewScheme?.(view.viewId, dark)
  })
  // Same shape: app-wide and read-only; the picker loads the same page and asks too. Changes
  // arrive as `prefs.changed`.
  router.handleWindow('prefs.get', () => deps.shellPrefs())

  // The project comes from the sender; plugin commands are per project.
  router.handleProject('commands.list', (ctx) => deps.commands(ctx.projectId))

  // Plugin commands only: they run in the sender's project's host, which main looks up itself.
  // Core commands run in the renderer and have no business here. A remote view's run carries that
  // view (the caller main bound, never the payload), so what the command opens or focuses shows
  // on that screen (design-web.md §5.3, origin-view.ts).
  router.handleProject('commands.run', async (ctx, payload, view) => {
    const id: unknown = (payload as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string' || id.length > 200 || !id.includes('/')) {
      throw new Error('commands.run: id must name a plugin command')
    }
    await deps.runCommand(ctx.projectId, id, remoteViewOf(view))
  })
}

/** What the plugin panel handlers need (panel-ports.ts, host-manager.ts). */
export interface PanelHandlerDeps {
  /** Connect a panel instance of the calling view (PanelPortHub.connect); false when refused. */
  connect(projectId: string, viewId: ViewId, panelKey: unknown, nonce: unknown): boolean
  /** Start the project's plugin host again if it gave up (HostManager.restartStopped). */
  restartHost(projectId: string): Promise<void>
  /**
   * A header action click (HostManager.panelAction); false when the host dropped it. `view`: the
   * remote view it came from (main's id from the caller), absent for the desktop.
   */
  panelAction(projectId: string, panelKey: string, actionId: string, view?: ViewId): boolean
}

/**
 * Plugin panel handlers. The project and window are the sender's; the panel key and nonce are
 * passed on as renderer input, and PanelPortHub only looks them up inside that project.
 */
export function registerPanelHandlers(router: IpcRouter, deps: PanelHandlerDeps): void {
  // The port goes back to the view that asked (main's id from the caller, design-web.md §5.3).
  router.handleProject('panels.connect', (ctx, payload, view) => {
    const { panelKey, nonce } = fields('panels.connect', payload)
    return deps.connect(ctx.projectId, view.viewId, panelKey, nonce)
  })
  router.handleProject('plugins.restart', (ctx) => deps.restartHost(ctx.projectId))
  // The project is the sender's; the key and id are only looked up in that project's host
  // (HostApi.panelAction), which delivers nothing but an action its plugin set there. The caps
  // keep a junk payload from being carried any further. The view is the caller's, as for commands.run.
  router.handleProject('panels.action', (ctx, payload, view) => {
    const { panelKey, actionId } = fields('panels.action', payload)
    if (typeof panelKey !== 'string' || panelKey.length > 300 || typeof actionId !== 'string' || actionId.length > 40) {
      throw new Error('panels.action: panelKey and actionId must be short strings')
    }
    return deps.panelAction(ctx.projectId, panelKey, actionId, remoteViewOf(view))
  })
}

/** What the slot frame handlers need (panel-ports.ts, layout-service.ts). */
export interface SlotHandlerDeps {
  /** Connect a slot frame of the calling view (PanelPortHub.connectSlot); false when refused. */
  connect(projectId: string, viewId: ViewId, frameId: unknown, nonce: unknown): boolean
  /** The calling view's shell unmounted the frame (PanelPortHub.disconnectSlot): only that view's instance. */
  disconnect(projectId: string, viewId: ViewId, frameId: string): void
  /** The frame's page asked for a height (LayoutService.setSlotHeight); false when refused. */
  setHeight(projectId: string, frameId: string, height: number): boolean
}

/**
 * Slot frames (design-next §2): the shell asks for a frame's port, says when it unmounted one,
 * and passes on a page's `ccPanel.slot.setHeight`. The project and window are the sender's; the
 * frame id is renderer input, capped here and only looked up in that project's frames by main.
 */
export function registerSlotHandlers(router: IpcRouter, deps: SlotHandlerDeps): void {
  const frameIdOf = (channel: string, payload: unknown): string => {
    const { frameId } = fields(channel, payload)
    if (typeof frameId !== 'string' || frameId.length > 40) throw new Error(`${channel}: frameId must be a short string`)
    return frameId
  }
  // Keyed by the calling view: each view's frame of an id is its own instance (design-web.md §5.3).
  router.handleProject('slots.connect', (ctx, payload, view) => {
    const frameId = frameIdOf('slots.connect', payload)
    return deps.connect(ctx.projectId, view.viewId, frameId, fields('slots.connect', payload).nonce)
  })
  router.handleProject('slots.disconnect', (ctx, payload, view) => {
    deps.disconnect(ctx.projectId, view.viewId, frameIdOf('slots.disconnect', payload))
    return null
  })
  router.handleProject('slots.height', (ctx, payload) => {
    const frameId = frameIdOf('slots.height', payload)
    const { height } = fields('slots.height', payload)
    if (typeof height !== 'number' || !Number.isFinite(height)) throw new Error('slots.height: height must be a number')
    return deps.setHeight(ctx.projectId, frameId, height)
  })
}

/** What the plugin settings page handlers need (index.ts, panel-ports.ts). */
export interface SettingsPageHandlerDeps {
  /** The page's URL for the sender's project, or that the plugin does not run there; null when it has no such page. */
  info(projectId: string, pluginId: string, scope: SettingsPageScope): SettingsPageInfo | null
  /** Connect the page in the calling view (PanelPortHub.connectSettingsPage); false when refused. */
  connect(projectId: string, viewId: ViewId, pluginId: string, scope: SettingsPageScope, nonce: unknown): boolean
  /** The calling view's shell unmounted the page (PanelPortHub.disconnectSettingsPage): ends it only when that view holds it. */
  disconnect(projectId: string, viewId: ViewId, pluginId: string): void
}

/**
 * A plugin's html settings page (design-next §5.4): its URL, its port and its unmount. The project
 * and window are the sender's; the plugin id and scope are renderer input, checked for shape here
 * and only looked up by main.
 */
export function registerSettingsPageHandlers(router: IpcRouter, deps: SettingsPageHandlerDeps): void {
  const pluginIdOf = (channel: string, payload: unknown): string => {
    const { pluginId } = fields(channel, payload)
    if (typeof pluginId !== 'string' || pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(pluginId)) {
      throw new Error(`${channel}: pluginId must be a plugin id`)
    }
    return pluginId
  }
  const scopeOf = (channel: string, payload: unknown): SettingsPageScope => {
    const { scope } = fields(channel, payload)
    if (!isSettingsPageScope(scope)) throw new Error(`${channel}: scope must be "app" or "project"`)
    return scope
  }
  router.handleProject('settingsPage.info', (ctx, payload) =>
    deps.info(ctx.projectId, pluginIdOf('settingsPage.info', payload), scopeOf('settingsPage.info', payload))
  )
  router.handleProject('settingsPage.connect', (ctx, payload, view) =>
    deps.connect(
      ctx.projectId,
      view.viewId,
      pluginIdOf('settingsPage.connect', payload),
      scopeOf('settingsPage.connect', payload),
      fields('settingsPage.connect', payload).nonce
    )
  )
  router.handleProject('settingsPage.disconnect', (ctx, payload, view) => {
    deps.disconnect(ctx.projectId, view.viewId, pluginIdOf('settingsPage.disconnect', payload))
    return null
  })
}

/**
 * What the settings handlers need (SettingsService implements it). Every method takes renderer
 * input as `unknown` and checks it itself; the router only passes fields on, with the sender's
 * window id where a native dialog opens.
 */
export interface SettingsHandlerDeps {
  projects(): SettingsProject[]
  openProject(id: unknown): void
  relinkProject(windowId: number, id: string): Promise<boolean>
  removeProject(id: unknown): void
  plugins(): PluginView[]
  installPlugin(url: unknown, tag: unknown): Promise<PluginView>
  linkPlugin(windowId: number): Promise<boolean>
  updatePlugin(id: unknown, tag: unknown): Promise<PluginView>
  uninstallPlugin(id: unknown): Promise<void>
  /** "Off in all projects" of a bundled plugin; the service refuses any other id. */
  setBundledOff(id: unknown, off: unknown): Promise<void>
  marketplace(): MarketplaceView
  installMarketplace(indexUrl: unknown, id: unknown, expect: unknown): Promise<PluginView>
  updateMarketplace(indexUrl: unknown, id: unknown, expect: unknown): Promise<PluginView>
  /** "Update all": the service checks the list (shape, cap, duplicates) and every item as a single update. */
  updateAllMarketplace(items: unknown): Promise<MarketplaceUpdateAllResult>
  refreshMarketplace(): Promise<MarketplaceView>
  /** A listing's preview bytes, or null; the service finds the entry in main's own index state. */
  marketplacePreview(indexUrl: unknown, id: unknown): Promise<Uint8Array | null>
  setMarketplaceUrls(urls: unknown): Promise<MarketplaceView>
  /** `secrets`: the form's secret edits (SecretEdits), checked by the service like `values`. */
  savePluginSettings(id: unknown, values: unknown, secrets: unknown): Promise<PluginSettingsSaveResult>
  /** The global values of a plugin's project fields (SettingsService.saveProjectDefaults), checked like the app ones. */
  saveProjectDefaults(id: unknown, values: unknown, secrets: unknown): Promise<PluginSettingsSaveResult>
}

/**
 * Settings overlay handlers. The overlay lives in a project window, so these are
 * project handlers (a picker has no settings screen); the data they act on is app-wide. Nothing
 * a payload names is trusted: ids are looked up in main's own tables inside the service.
 */
export function registerSettingsHandlers(router: IpcRouter, deps: SettingsHandlerDeps): void {
  const idOf = (channel: string, payload: unknown): unknown => fields(channel, payload).id
  // The confirmation's repo and commit must travel with an install: a call without them would skip the check.
  const expectOf = (v: unknown): { repo: unknown; commit: unknown } => {
    if (typeof v !== 'object' || v === null) throw new Error('bad payload: the shown repository and commit are missing')
    const { repo, commit } = v as Record<string, unknown>
    return { repo, commit }
  }

  router.handleProject('settings.projects', () => deps.projects())
  router.handleProject('settings.projectOpen', (_ctx, payload) => {
    deps.openProject(idOf('settings.projectOpen', payload))
  })
  router.handleProject('settings.projectRelink', (ctx, payload) => {
    const id = idOf('settings.projectRelink', payload)
    if (typeof id !== 'string') throw new Error('settings.projectRelink: id must be a string')
    return deps.relinkProject(ctx.windowId, id)
  })
  router.handleProject('settings.projectRemove', (_ctx, payload) => {
    deps.removeProject(idOf('settings.projectRemove', payload))
  })

  router.handleProject('settings.plugins', () => deps.plugins())
  router.handleProject('settings.pluginInstall', (_ctx, payload) => {
    const p = fields('settings.pluginInstall', payload)
    return deps.installPlugin(p.url, p.tag)
  })
  router.handleProject('settings.pluginLink', (ctx) => deps.linkPlugin(ctx.windowId))
  router.handleProject('settings.pluginUpdate', (_ctx, payload) => {
    const p = fields('settings.pluginUpdate', payload)
    return deps.updatePlugin(p.id, p.tag)
  })
  router.handleProject('settings.pluginUninstall', (_ctx, payload) =>
    deps.uninstallPlugin(idOf('settings.pluginUninstall', payload))
  )
  router.handleProject('settings.pluginBundledOff', (_ctx, payload) => {
    const p = fields('settings.pluginBundledOff', payload)
    return deps.setBundledOff(p.id, p.off)
  })
  router.handleProject('settings.marketplace', () => deps.marketplace())
  router.handleProject('settings.marketplaceInstall', (_ctx, payload) => {
    const p = fields('settings.marketplaceInstall', payload)
    return deps.installMarketplace(p.indexUrl, p.id, expectOf(p.expect))
  })
  router.handleProject('settings.marketplaceUpdate', (_ctx, payload) => {
    const p = fields('settings.marketplaceUpdate', payload)
    return deps.updateMarketplace(p.indexUrl, p.id, expectOf(p.expect))
  })
  router.handleProject('settings.marketplaceUpdateAll', (_ctx, payload) =>
    deps.updateAllMarketplace(fields('settings.marketplaceUpdateAll', payload).items)
  )
  router.handleProject('settings.marketplaceRefresh', () => deps.refreshMarketplace())
  router.handleProject('settings.marketplacePreview', (_ctx, payload) => {
    const p = fields('settings.marketplacePreview', payload)
    return deps.marketplacePreview(p.indexUrl, p.id)
  })
  router.handleProject('settings.marketplaceSetUrls', (_ctx, payload) =>
    deps.setMarketplaceUrls(fields('settings.marketplaceSetUrls', payload).urls)
  )
  router.handleProject('settings.pluginSettingsSave', (_ctx, payload) => {
    const p = fields('settings.pluginSettingsSave', payload)
    return deps.savePluginSettings(p.id, p.values, p.secrets)
  })
  router.handleProject('settings.pluginProjectDefaultsSave', (_ctx, payload) => {
    const p = fields('settings.pluginProjectDefaultsSave', payload)
    return deps.saveProjectDefaults(p.id, p.values, p.secrets)
  })
}

/** Plugin services on the Plugins page (ServiceChoices, main/plugins/service-choices.ts). */
export interface ServiceHandlerDeps {
  /** Service status (and the open-file pick) of the sender's project. */
  status(projectId: string): Promise<PluginServicesView>
  /** The names arrive unchecked (the service checks them); the project is the sender's. */
  setProvider(projectId: string, service: unknown, pluginId: unknown): Promise<void>
}

/**
 * The Plugins page's service channels. Project handlers like the rest of Settings: the project is
 * the asking window's (ctx.projectId), never one from the payload, so a window reads and picks
 * providers only for itself.
 */
export function registerServiceHandlers(router: IpcRouter, deps: ServiceHandlerDeps): void {
  router.handleProject('settings.pluginServices', (ctx) => deps.status(ctx.projectId))
  router.handleProject('settings.pluginServiceProvider', (ctx, payload) => {
    const p = fields('settings.pluginServiceProvider', payload)
    return deps.setProvider(ctx.projectId, p.service, p.pluginId)
  })
}

/**
 * What the "This Project", "General" and "Appearance" handlers need (ProjectSettingsService and
 * AppearanceService, joined in main's index.ts). A per-project method gets the sender's project id
 * from the router, never from the payload; the payload's fields arrive as `unknown` and the
 * service checks them.
 */
export interface ProjectSettingsHandlerDeps {
  projectView(projectId: string): ProjectSettingsView
  setPluginEnabled(projectId: string, pluginId: unknown, enabled: unknown): Promise<void>
  saveProjectPluginSettings(projectId: string, pluginId: unknown, values: unknown, secrets: unknown): Promise<PluginSettingsSaveResult>
  movePanel(projectId: string, panelKey: unknown, zone: unknown): void
  /** Set or clear the project's colour (ProjectSettingsService.setColor checks the value). */
  setProjectColor(projectId: string, value: unknown): ProjectColor | null
  /** `viewId`: the calling view, whose theme "Showing ..." names (it differs per screen with no pick). */
  appearance(projectId: string, viewId: ViewId): AppearanceView
  setTheme(id: unknown): void
  setKey(projectId: string, commandId: unknown, chord: unknown): void
  setTabExit(value: unknown): void
  setClaudeTabOnOpen(value: unknown): void
  setSessionGist(value: unknown): void
  setStatusLineUsage(value: unknown): void
  setDiscussPrompt(value: unknown): void
  /** This window's own project (ProjectSettingsService.setDiscussPrompt checks the value). */
  setProjectDiscussPrompt(projectId: string, value: unknown): void
  setNotificationSounds(value: unknown): void
  /** The "Sound" dropdown: built-ins, then the OS sound folders as listed now (SystemSounds.groups). */
  notificationSoundOptions(): Promise<NotificationSoundGroup[]>
  /** AppearanceService.setNotificationSound checks the id (a system one against a fresh listing). */
  setNotificationSound(value: unknown): Promise<void>
  /** A system sound's bytes for an id main finds in a fresh listing (SystemSounds.read); null otherwise. */
  notificationSoundData(id: unknown): Promise<NotificationSoundData | null>
  setZoneAutoHide(value: unknown): void
  setMinTerminalWidth(value: unknown): void
  /** AppSettings.confirmTabClose with the default applied. */
  confirmTabClose(): boolean
  setConfirmTabClose(value: unknown): void
  setTabCloseSide(value: unknown): void
  setTerminalFont(value: unknown): void
  setWindowBackground(value: unknown): void
  /** Replace one level's new-tab menu entries (TabCommandsService.set checks everything). */
  setTabCommands(projectId: string, level: unknown, entries: unknown): TabCommandEntry[]
}

export function registerProjectSettingsHandlers(router: IpcRouter, deps: ProjectSettingsHandlerDeps): void {
  router.handleProject('settings.project', (ctx) => deps.projectView(ctx.projectId))
  router.handleProject('settings.projectPluginEnable', (ctx, payload) => {
    const p = fields('settings.projectPluginEnable', payload)
    return deps.setPluginEnabled(ctx.projectId, p.pluginId, p.enabled)
  })
  router.handleProject('settings.projectPluginSettingsSave', (ctx, payload) => {
    const p = fields('settings.projectPluginSettingsSave', payload)
    return deps.saveProjectPluginSettings(ctx.projectId, p.pluginId, p.values, p.secrets)
  })
  router.handleProject('settings.projectPanelMove', (ctx, payload) => {
    const p = fields('settings.projectPanelMove', payload)
    deps.movePanel(ctx.projectId, p.panelKey, p.zone)
  })
  // The sender's own project, whatever the payload says: a window colours only itself. (The
  // picker, which lists every project, has no way to set one: handleProject refuses it.)
  router.handleProject('settings.projectColorSet', (ctx, payload) =>
    deps.setProjectColor(ctx.projectId, fields('settings.projectColorSet', payload).value)
  )
  router.handleProject('settings.appearance', (ctx, _payload, view) => deps.appearance(ctx.projectId, view.viewId))
  router.handleProject('settings.themeSet', (_ctx, payload) => {
    deps.setTheme(fields('settings.themeSet', payload).id)
  })
  router.handleProject('settings.keySet', (ctx, payload) => {
    const p = fields('settings.keySet', payload)
    deps.setKey(ctx.projectId, p.commandId, p.chord)
  })
  router.handleProject('settings.tabExitSet', (_ctx, payload) => {
    deps.setTabExit(fields('settings.tabExitSet', payload).value)
  })
  router.handleProject('settings.claudeTabOnOpenSet', (_ctx, payload) => {
    deps.setClaudeTabOnOpen(fields('settings.claudeTabOnOpenSet', payload).value)
  })
  router.handleProject('settings.sessionGistSet', (_ctx, payload) => {
    deps.setSessionGist(fields('settings.sessionGistSet', payload).value)
  })
  router.handleProject('settings.statusLineUsageSet', (_ctx, payload) => {
    deps.setStatusLineUsage(fields('settings.statusLineUsageSet', payload).value)
  })
  router.handleProject('settings.discussPromptSet', (_ctx, payload) => {
    deps.setDiscussPrompt(fields('settings.discussPromptSet', payload).value)
  })
  // The sender's own project, whatever the payload says (like the colour).
  router.handleProject('settings.projectDiscussPromptSet', (ctx, payload) => {
    deps.setProjectDiscussPrompt(ctx.projectId, fields('settings.projectDiscussPromptSet', payload).value)
  })
  router.handleProject('settings.notificationSoundsSet', (_ctx, payload) => {
    deps.setNotificationSounds(fields('settings.notificationSoundsSet', payload).value)
  })
  router.handleProject('settings.notificationSoundOptions', () => deps.notificationSoundOptions())
  router.handleProject('settings.notificationSoundSet', (_ctx, payload) =>
    deps.setNotificationSound(fields('settings.notificationSoundSet', payload).value)
  )
  // The page plays a picked system sound (a chime, the Play button) with these bytes. The id is
  // only a claim: main finds it in a fresh listing of its own folders or answers null.
  router.handleProject('notify.soundData', (_ctx, payload) => deps.notificationSoundData(fields('notify.soundData', payload).id))
  router.handleProject('settings.zoneAutoHideSet', (_ctx, payload) => {
    deps.setZoneAutoHide(fields('settings.zoneAutoHideSet', payload).value)
  })
  router.handleProject('settings.minTerminalWidthSet', (_ctx, payload) => {
    deps.setMinTerminalWidth(fields('settings.minTerminalWidthSet', payload).value)
  })
  router.handleProject('settings.confirmTabClose', () => deps.confirmTabClose())
  router.handleProject('settings.confirmTabCloseSet', (_ctx, payload) => {
    deps.setConfirmTabClose(fields('settings.confirmTabCloseSet', payload).value)
  })
  router.handleProject('settings.tabCloseSideSet', (_ctx, payload) => {
    deps.setTabCloseSide(fields('settings.tabCloseSideSet', payload).value)
  })
  router.handleProject('settings.terminalFontSet', (_ctx, payload) => {
    deps.setTerminalFont(fields('settings.terminalFontSet', payload).value)
  })
  router.handleProject('settings.windowBackgroundSet', (_ctx, payload) => {
    deps.setWindowBackground(fields('settings.windowBackgroundSet', payload).value)
  })
  // The project level is the sender's project, as everywhere; the payload names only the level.
  router.handleProject('settings.tabCommandsSet', (ctx, payload) => {
    const p = fields('settings.tabCommandsSet', payload)
    return deps.setTabCommands(ctx.projectId, p.level, p.entries)
  })
}

/** The update notice and its Settings toggle (UpdateChecker, main/updates/update-check.ts). */
export interface UpdateHandlerDeps {
  state(): UpdateState
  setEnabled(value: boolean): void
  /** `version` is a string the renderer sent, not yet compared with the offer. */
  dismiss(version: string): void
  /**
   * Opens the release page of the available version, which main built; nothing from a renderer.
   * `target`: the asking window and view, as the router bound them, for the openExternal adapter (a
   * browser view gets a clickable notice instead, design-web.md §6.1).
   */
  openRelease(target: OpenTarget): void | Promise<void>
}

export function registerUpdateHandlers(router: IpcRouter, deps: UpdateHandlerDeps): void {
  router.handleWindow('updates.state', () => deps.state())
  router.handleProject('updates.setEnabled', (_ctx, payload) => {
    const value = (payload as { value?: unknown } | undefined)?.value
    if (typeof value !== 'boolean') throw new Error('updates.setEnabled: value must be a boolean')
    deps.setEnabled(value)
  })
  // A wrong type is ignored, not an error, as any other version that is not on offer is.
  router.handleWindow('updates.dismiss', (_ctx, payload) => {
    const version = (payload as { version?: unknown } | undefined)?.version
    if (typeof version === 'string') deps.dismiss(version)
  })
  // No payload is read: the URL is main's own.
  router.handleWindow('updates.openRelease', (ctx, _payload, view) => deps.openRelease({ windowId: ctx.windowId, viewId: view.viewId }))
}

/** A server's in-page notices (notifier.ts PageNoticeBackend, design-web.md §9.9). */
export interface NoticeHandlerDeps {
  /** Main's server flag: in-page notices exist only then; on the desktop notices are the OS's. */
  server: boolean
  /** The action of a notice main shows in `windowId` (or app-wide); false for any other id. */
  click(windowId: number, requestId: string): boolean
  /** The ✕ of such a notice; false for any other id. */
  dismiss(windowId: number, requestId: string): boolean
}

/**
 * `adapted`: a click or ✕ from a browser view of a server, for a notice of the window main bound the
 * view to (ctx), never one the payload names, so an id of another window's notice settles nothing.
 * Refused outright on the desktop (a remote view there sees no notice, and the OS's are clicked on the
 * host) and from the hidden page, which never shows one: a click there is nobody's.
 */
export function registerNoticeHandlers(router: IpcRouter, deps: NoticeHandlerDeps): void {
  for (const channel of ['notices.click', 'notices.dismiss'] as const) {
    router.handleProject(channel, (ctx, payload, view) => {
      if (!deps.server || !view.remote) throw new Error(`${channel}: only a browser view of a server shows in-page notices`)
      const { requestId } = fields(channel, payload)
      if (typeof requestId !== 'string') throw new Error(`${channel}: requestId must be a string`)
      return channel === 'notices.click' ? deps.click(ctx.windowId, requestId) : deps.dismiss(ctx.windowId, requestId)
    })
  }
}

/** A plugin's OAuth sign-in settled by a pasted address (oauth/plugin-oauth.ts, design-web.md §9.9). */
export interface OAuthPasteHandlerDeps {
  /** Main's server flag: the paste box exists only then; on the desktop the loopback gets the redirect. */
  server: boolean
  /** PluginOAuth.paste: true when it settled the sign-in `signIn` of `windowId`; the payload's fields unchecked. */
  paste(windowId: number, signIn: unknown, url: unknown): boolean
}

/**
 * `adapted`: a paste from a browser view of a server, for a sign-in of the window main bound the view
 * to (ctx), never one the payload names. Everything else gets the same answer as a wrong address
 * (OAUTH_PASTE_REFUSED, never the address): a remote view on the desktop (where `ctx.oauth` from a
 * browser is refused anyway, and the redirect reaches the loopback), the desktop page in either mode
 * (it shows no box), a malformed payload. Answered, not thrown, so no error line carries the payload.
 */
export function registerOAuthPasteHandlers(router: IpcRouter, deps: OAuthPasteHandlerDeps): void {
  const refused: OAuthPasteAnswer = { ok: false, error: OAUTH_PASTE_REFUSED }
  router.handleProject('oauth.paste', (ctx, payload, view): OAuthPasteAnswer => {
    if (!deps.server || !view.remote) return refused
    const { signIn, url } = isPlainObject(payload) ? payload : {}
    return deps.paste(ctx.windowId, signIn, url) ? { ok: true } : refused
  })
}

/** The "Install ccc command" row of General (CccCommandInstaller, main/hooks/ccc-install.ts). */
export interface CccCommandHandlerDeps {
  status(): CccCommandView | Promise<CccCommandView>
  install(): CccCommandView | Promise<CccCommandView>
  setOffer(value: boolean): void
  /** The start-up question (CccOffer.claim): a view when this window should ask, else null. */
  offer(): CccCommandView | null | Promise<CccCommandView | null>
}

export function registerCccCommandHandlers(router: IpcRouter, deps: CccCommandHandlerDeps): void {
  router.handleProject('settings.cccStatus', () => deps.status())
  router.handleProject('settings.cccInstall', () => deps.install())
  router.handleProject('settings.cccOfferSet', (_ctx, payload) => {
    const value = (payload as { value?: unknown } | undefined)?.value
    if (typeof value !== 'boolean') throw new Error('settings.cccOfferSet: value must be a boolean')
    deps.setOffer(value)
  })
  router.handleProject('ccc.offer', () => deps.offer())
}

/**
 * What the web access handlers need (WebAccessService, main/web/access-service.ts). What adds or
 * widens access (the settings, the link, add-device, the password, the confirm answer) is `no`-class:
 * the router refuses a remote caller before a handler runs. The read side and Revoke/Disconnect are
 * `adapted` (design-web.md §9.4, §9.6): open to a remote view only when main runs as a server
 * (WebAccessHandlerOptions.server, main's flag, never the payload), refused to one on the desktop.
 */
export interface WebAccessHandlerDeps {
  view(): WebAccessView
  set(patch: WebAccessPatch): Promise<WebAccessSetReply>
  link(): Promise<WebLinkReply>
  regenerate(): Promise<WebLinkReply>
  addDevice(): WebLinkReply
  /** `id` is whatever the renderer sent: the service checks the type. `by`: the acting browser (the log). */
  disconnect(id: unknown, by?: AccessActor): boolean
  /** `how.by`: the acting browser, for the log; absent for the desktop page, as before. */
  revoke(id: unknown, how?: { by?: AccessActor }): boolean
  revokeAll(how?: { by?: AccessActor }): number
  /** `password` is whatever the renderer sent: the service checks it. */
  setPassword(password: unknown): Promise<WebActionReply>
  indicator(): WebAccessIndicator
  /** `{ id, allow, code }` as the renderer sent it: the service checks every field. */
  answerConfirm(payload: unknown): WebActionReply
}

export interface WebAccessHandlerOptions {
  /** Main's server-mode flag for the run: the only thing that opens the `adapted` channels to a browser. */
  server?: boolean
  /**
   * The signed-in device behind a remote view (WebConnections.actorOf), named in `web-access.log`
   * for a browser's Revoke and Disconnect; undefined for a view that is gone.
   */
  actorOf?(viewId: ViewId): AccessActor | undefined
  /** Server mode: the run's secret store for the browser's card (what `ccc web status` shows). */
  secrets?(): Promise<WebSecretsStatus>
}

export function registerWebAccessHandlers(router: IpcRouter, deps: WebAccessHandlerDeps, options: WebAccessHandlerOptions = {}): void {
  // An `adapted` channel from a remote view: allowed only in server mode, where every signed-in device
  // is the owner (§9.6). On the desktop web access is the desktop's alone, as before: a browser
  // would read the device list or revoke the desktop's other devices.
  const gate = (channel: InvokeChannel, view: CallView): void => {
    if (view.remote && options.server !== true) throw new Error(`${channel}: refused for a browser view outside server mode`)
  }
  // The device that acts, from the view main bound the call to: a view that is already gone (its
  // socket closed while the call was on its way) acts for nobody, so the call is refused rather
  // than logged without a name.
  const actor = (channel: InvokeChannel, view: CallView): AccessActor | undefined => {
    if (!view.remote) return undefined
    const by = options.actorOf?.(view.viewId)
    if (by === undefined) throw new Error(`${channel}: refused, the browser view is gone`)
    return by
  }
  router.handleProject('settings.webAccess', async (_ctx, _payload, view) => {
    gate('settings.webAccess', view)
    const out = { ...deps.view() }
    if (options.secrets) out.secrets = await options.secrets()
    if (view.remote) {
      // The card draws neither TLS path nor the store's failure text (which names the key file's
      // absolute path): a browser gets only that a cert is set and a path-free reason, so the
      // server user's home path does not reach a lost phone. The desktop keeps the full view.
      out.form = { ...out.form, certPath: out.form.certPath === '' ? '' : 'set', keyPath: out.form.keyPath === '' ? '' : 'set' }
      if (out.secrets && out.secrets.unavailable !== null) out.secrets = { ...out.secrets, unavailable: REMOTE_SECRETS_UNAVAILABLE_TEXT }
    }
    return out
  })
  router.handleProject('settings.webAccessSet', (_ctx, payload) => deps.set((payload as { value?: WebAccessPatch } | undefined)?.value as WebAccessPatch))
  router.handleProject('settings.webAccessLink', () => deps.link())
  router.handleProject('settings.webAccessRegenerate', () => deps.regenerate())
  router.handleProject('settings.webAccessAddDevice', () => deps.addDevice())
  router.handleProject('settings.webDeviceDisconnect', (_ctx, payload, view) => {
    gate('settings.webDeviceDisconnect', view)
    const by = actor('settings.webDeviceDisconnect', view)
    const id = isPlainObject(payload) ? payload.id : undefined
    return by ? deps.disconnect(id, by) : deps.disconnect(id)
  })
  router.handleProject('settings.webDeviceRevoke', (_ctx, payload, view) => {
    gate('settings.webDeviceRevoke', view)
    const by = actor('settings.webDeviceRevoke', view)
    const id = isPlainObject(payload) ? payload.id : undefined
    return by ? deps.revoke(id, { by }) : deps.revoke(id)
  })
  router.handleProject('settings.webDevicesRevokeAll', (_ctx, _payload, view) => {
    gate('settings.webDevicesRevokeAll', view)
    const by = actor('settings.webDevicesRevokeAll', view)
    return by ? deps.revokeAll({ by }) : deps.revokeAll()
  })
  router.handleProject('settings.webAccessSetPassword', (_ctx, payload) => deps.setPassword((payload as { password?: unknown } | undefined)?.password))
  router.handleProject('webAccess.state', (_ctx, _payload, view) => {
    gate('webAccess.state', view)
    return view.remote ? remoteIndicator(deps.indicator()) : deps.indicator()
  })
  router.handleProject('webAccess.confirmAnswer', (_ctx, payload) => deps.answerConfirm(payload))
}

/** What a renderer may see of a project (the title bar, the picker rows). Exported for main's pushes. */
export function summary(view: ProjectView): ProjectSummary {
  const out: ProjectSummary = { id: view.id, name: view.name, path: view.path, missing: view.missing }
  // The registry already repaired a damaged stored value; checked again because this is the last
  // stop before a renderer, which drops the value into a style.
  const color = projectColorOf(view.color)
  if (color !== undefined) out.color = color
  return out
}

/** What the tab handlers need from the tab manager (all project-scoped by the caller). */
export interface TabHandlerDeps {
  /**
   * Async: a project's saved tabs, or its first Claude tab, are started on the first attach
   * (restore.ts, tabs/first-tab.ts). `windowId` is the asking window: a late attach from a window
   * already closed must not spend the arm of the window opened after it.
   */
  attach(projectId: string, windowId: number): TabInfo[] | Promise<TabInfo[]>
  /** The plain list (TabManager.list): what a remote view gets for `tabs.list`, with no re-attach. */
  list(projectId: string): TabInfo[]
  /**
   * `windowId` is the asking window (main's, from the sender): create and restart wait for the
   * login env first and must refuse when that window closed meanwhile. null: a command entry
   * that opens as an overlay, which went on `windowId`'s overlay stack instead of the tab strip.
   */
  create(projectId: string, options: TabCreateRequest, windowId: number): TabInfo | null | Promise<TabInfo | null>
  /** The user entries of the project's [+] menu (TabCommandsService.menu). */
  commands(projectId: string): TabCommandMenu
  close(projectId: string, tabId: string): void
  reorder(projectId: string, tabId: string, toIndex: number): void
  rename(projectId: string, tabId: string, name: string | null): void
  /** The person's flag (TabManager.setFlag checks the patch); answers the flag as stored. */
  flag(projectId: string, tabId: string, patch: unknown): TabFlag | null
  toggleFlag(projectId: string, tabId: string): TabFlag | null
  restart(projectId: string, tabId: string, windowId: number): TabInfo | Promise<TabInfo>
  /** `viewId`: the view that typed (a typing take of the terminal's size, terminal-sizes.ts). */
  input(projectId: string, tabId: string, data: string, viewId: ViewId): void
  /** The view's own size for the tab; the pty takes it only while that view sizes the tab. */
  resize(projectId: string, tabId: string, cols: number, rows: number, viewId: ViewId): void
  /** "Fit to this screen": the view takes the tab's size now. */
  fit(projectId: string, tabId: string, viewId: ViewId): boolean
  /** The view was hidden or shown: hidden views never size a tab. */
  visible(viewId: ViewId, visible: boolean): void
  ack(projectId: string, tabId: string, count: number): void
  /**
   * The desktop page's screen of a tab (TabManager.screen, `tabs.screen`), its shape checked here.
   * Absent (unit tests of other handlers): the answer is dropped.
   */
  screen?(projectId: string, tabId: string, answer: ScreenAnswer): void
  /**
   * The view `viewId` shows this tab now (design-web.md §5.1): its own selection, and the project's
   * active tab as the view that acted last (tabs/view-selections.ts, after a check that the tab is
   * the project's).
   */
  select(projectId: string, tabId: string, viewId: ViewId): void
  /**
   * A remote view's terminal flow (web/view-terminals.ts, design-web.md §5.2): its ack counts for
   * that view alone, and its selection joins the tab's terminal stream for it. Keyed by the view id
   * main bound to the socket; the tab is checked against the view's own window there.
   */
  viewAck(viewId: ViewId, tabId: string, count: number): void
  viewSelect(viewId: ViewId, tabId: string): void
  /**
   * Tell the window's views other than `viewId` (ViewRegistry.toOthers): a tab one view created,
   * restarted, flagged (`tabs.added`, merged by id and generation), closed (`tabs.removed`) or moved
   * (`tabs.moved`, at the index main applied). The
   * acting view has it from its reply; without this the desktop and a browser keep different tab
   * strips. Absent (unit tests of other handlers): nobody else is told.
   */
  others?(windowId: number, viewId: ViewId, event: TabListEvent): void
}

/** What `TabHandlerDeps.others` carries: the tab-list events every page understands. */
export type TabListEvent =
  | { channel: 'tabs.added'; payload: TabInfo }
  | { channel: 'tabs.removed'; payload: { tabId: string; gen: number } }
  | { channel: 'tabs.moved'; payload: { tabId: string; toIndex: number } }

/**
 * Tab handlers. Every one acts on `ctx.projectId`, the project main resolved from the sender;
 * the tab id in a payload is only looked up inside that project. The payload is renderer input,
 * so each field is type-checked here rather than trusted to match the declared type.
 */
export function registerTabHandlers(router: IpcRouter, tabs: TabHandlerDeps): void {
  // The tab as main has it now, told to the window's other views (a change one view made).
  const announce = (ctx: ProjectContext, view: { viewId: ViewId }, tabId: string): void => {
    const tab = tabs.list(ctx.projectId).find((t) => t.id === tabId)
    if (tab) tabs.others?.(ctx.windowId, view.viewId, { channel: 'tabs.added', payload: tab })
  }
  // Attaching resets flow control (TabManager.attach), so call this once per page load only,
  // never to refresh the list after create/exit/reorder: with xterm saturated that would wipe
  // the unacked count and resume a paused PTY. Task 8 should take refreshes from tab events.
  // `adapted`: a remote view gets the plain list. Attaching is the desktop page's: it resets (or
  // resyncs) the DESKTOP's terminals and runs the window's restore, and a browser joining or
  // reconnecting must leave the desktop exactly as it was; its own terminals start at its select.
  // The desktop's first attach restores the window's saved tabs or opens its first Claude tab, and
  // it alone gets them in this reply: a browser that joined while that was under way took a list
  // without them (its own `tabs.list` never waits for the desktop's restore, which may not run until
  // the desktop page loads). So each tab the attach brought is announced to the other views, merged
  // by id and generation there; with no browser attached that tells nobody, as before.
  router.handleProject('tabs.list', async (ctx, _payload, view) => {
    if (view.remote) return tabs.list(ctx.projectId)
    const before = new Set(tabs.list(ctx.projectId).map((t) => t.id))
    const list = await tabs.attach(ctx.projectId, ctx.windowId)
    for (const tab of list) {
      if (!before.has(tab.id)) tabs.others?.(ctx.windowId, view.viewId, { channel: 'tabs.added', payload: tab })
    }
    return list
  })

  router.handleProject('tabs.commands', (ctx) => tabs.commands(ctx.projectId))

  router.handleProject('tabs.create', async (ctx, payload, view) => {
    const tab = await createTab(ctx, payload)
    if (tab) tabs.others?.(ctx.windowId, view.viewId, { channel: 'tabs.added', payload: tab })
    return tab
  })
  const createTab = (ctx: ProjectContext, payload: unknown): TabInfo | null | Promise<TabInfo | null> => {
    const p = fields('tabs.create', payload)
    const kind = p.kind
    if (kind === 'command') {
      // A menu entry, by level and id only. Only these two fields are read: a `command` or
      // `label` riding along in the payload is never looked at, so a renderer cannot have main run
      // text of its own; main looks the command up in its settings (TabCommandsService.resolve).
      const { level, entryId } = p
      if (level !== 'app' && level !== 'project') throw new Error("tabs.create: level must be 'app' or 'project'")
      if (typeof entryId !== 'string') throw new Error('tabs.create: entryId must be a string')
      return tabs.create(ctx.projectId, { kind, level, entryId }, ctx.windowId)
    }
    if (kind !== 'claude' && kind !== 'shell') throw new Error('tabs.create: unknown kind')
    const cwd = p.cwd
    if (cwd !== undefined && typeof cwd !== 'string') {
      throw new Error('tabs.create: cwd must be a string')
    }
    // No prompt from the renderer: programmatic prompts come through sessions.open (Task 20).
    return tabs.create(ctx.projectId, cwd === undefined ? { kind } : { kind, cwd }, ctx.windowId)
  }

  router.handleProject('tabs.close', (ctx, payload, view) => {
    const tabId = tabIdOf('tabs.close', payload)
    // Its generation before it goes: the other views drop only the process they hold or an older one.
    const gen = tabs.list(ctx.projectId).find((t) => t.id === tabId)?.gen
    tabs.close(ctx.projectId, tabId)
    if (gen !== undefined) tabs.others?.(ctx.windowId, view.viewId, { channel: 'tabs.removed', payload: { tabId, gen } })
  })

  router.handleProject('tabs.reorder', (ctx, payload, view) => {
    const toIndex = fields('tabs.reorder', payload).toIndex
    if (typeof toIndex !== 'number' || !Number.isInteger(toIndex)) {
      throw new Error('tabs.reorder: toIndex must be an integer')
    }
    const tabId = tabIdOf('tabs.reorder', payload)
    tabs.reorder(ctx.projectId, tabId, toIndex)
    // The index main applied (TabManager.reorder clamps to the ends), never the requested one: a
    // view asking for 99 must not leave the others to clamp against a strip of their own length.
    const applied = tabs.list(ctx.projectId).findIndex((t) => t.id === tabId)
    if (applied >= 0) tabs.others?.(ctx.windowId, view.viewId, { channel: 'tabs.moved', payload: { tabId, toIndex: applied } })
  })

  // The windows draw the name from the sessions snapshot, which reaches every view; the tab as
  // stored is announced too, so each view's tab list holds it like any other change one view made.
  router.handleProject('tabs.rename', (ctx, payload, view) => {
    const name = fields('tabs.rename', payload).name
    if (name !== null && typeof name !== 'string') throw new Error('tabs.rename: name must be a string or null')
    const tabId = tabIdOf('tabs.rename', payload)
    tabs.rename(ctx.projectId, tabId, name)
    announce(ctx, view, tabId)
  })

  // The person's flag: only from the shell page's top frame of the tab's own project window
  // (handleProject), the one way a flag is ever written. The patch is checked field by field in
  // main (shared/tab-flag.ts checkFlagPatch, through TabManager.setFlag).
  router.handleProject('tabs.flag', (ctx, payload, view) => {
    const p = fields('tabs.flag', payload)
    if (!('flag' in p)) throw new Error('tabs.flag: flag must be an object or null')
    const tabId = tabIdOf('tabs.flag', payload)
    const flag = tabs.flag(ctx.projectId, tabId, p.flag)
    announce(ctx, view, tabId)
    return flag
  })

  router.handleProject('tabs.toggleFlag', (ctx, payload, view) => {
    const tabId = tabIdOf('tabs.toggleFlag', payload)
    const flag = tabs.toggleFlag(ctx.projectId, tabId)
    announce(ctx, view, tabId)
    return flag
  })

  router.handleProject('tabs.restart', async (ctx, payload, view) => {
    const tab = await tabs.restart(ctx.projectId, tabIdOf('tabs.restart', payload), ctx.windowId)
    tabs.others?.(ctx.windowId, view.viewId, { channel: 'tabs.added', payload: tab })
    return tab
  })

  router.handleProject('tabs.input', (ctx, payload, view) => {
    const data = fields('tabs.input', payload).data
    if (typeof data !== 'string') throw new Error('tabs.input: data must be a string')
    tabs.input(ctx.projectId, tabIdOf('tabs.input', payload), data, view.viewId)
  })

  // Sizes are kept per view, keyed by the id main bound to the caller (never one from the payload).
  router.handleProject('tabs.resize', (ctx, payload, view) => {
    const { cols, rows } = fields('tabs.resize', payload)
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      throw new Error('tabs.resize: cols and rows must be numbers')
    }
    tabs.resize(ctx.projectId, tabIdOf('tabs.resize', payload), cols, rows, view.viewId)
  })

  router.handleProject('tabs.fit', (ctx, payload, view) => tabs.fit(ctx.projectId, tabIdOf('tabs.fit', payload), view.viewId))

  router.handleProject('tabs.visibility', (_ctx, payload, view) => {
    const visible = fields('tabs.visibility', payload).visible
    if (typeof visible !== 'boolean') throw new Error('tabs.visibility: visible must be a boolean')
    tabs.visible(view.viewId, visible)
  })

  // `adapted`: a remote view's ack is its own flow (it never reaches the pty, which main consumes
  // while web access is on); the desktop's goes to TabManager as before.
  router.handleProject('tabs.ack', (ctx, payload, view) => {
    const count = fields('tabs.ack', payload).count
    if (typeof count !== 'number') throw new Error('tabs.ack: count must be a number')
    const tabId = tabIdOf('tabs.ack', payload)
    if (view.remote) tabs.viewAck(view.viewId, tabId, count)
    else tabs.ack(ctx.projectId, tabId, count)
  })

  // `no`: the desktop page's answer to main's `tabs.screenAsk` (terminals/mirror.ts "Seeding"). The
  // router already refuses a remote view; checked again, since a browser's screen would be shown
  // to the other views. Only the shape is checked here: the tab against the sender's project in
  // TabManager, the ask id, the size and MAX_SCREEN_CHARS in the mirror.
  router.handleProject('tabs.screen', (ctx, payload, view) => {
    if (view.remote) throw new Error('tabs.screen: refused')
    const p = fields('tabs.screen', payload)
    const tabId = tabIdOf('tabs.screen', payload)
    if (typeof p.id !== 'number' || !Number.isSafeInteger(p.id)) throw new Error('tabs.screen: id must be an integer')
    const answer: ScreenAnswer = { id: p.id }
    if (p.busy === true) answer.busy = true
    if (p.screen !== undefined) {
      const screen = p.screen
      if (typeof screen !== 'object' || screen === null) throw new Error('tabs.screen: bad screen')
      const { cols, rows, data } = screen as Record<string, unknown>
      if (typeof cols !== 'number' || typeof rows !== 'number' || typeof data !== 'string') {
        throw new Error('tabs.screen: bad screen')
      }
      answer.screen = { cols, rows, data }
    }
    tabs.screen?.(ctx.projectId, tabId, answer)
  })

  // Only the id travels; whether it is one of the sender's project's tabs is main's check (select).
  // `adapted`: a remote view's selection also joins that tab's terminal stream for the view (a
  // snapshot, then live output); the desktop parses every tab's output all along.
  router.handleProject('tabs.selected', (ctx, payload, view) => {
    const tabId = tabIdOf('tabs.selected', payload)
    tabs.select(ctx.projectId, tabId, view.viewId)
    if (view.remote) tabs.viewSelect(view.viewId, tabId)
  })
}

/** What the Claude status handlers need from main (the session registry and the windows). */
export interface SessionHandlerDeps {
  /** The sender's project's view (see SessionRegistry.snapshotFor). */
  snapshotFor(projectId: string): SessionsSnapshot
  /** Scoped to `projectId`: false for a tab of another project, an unknown tab or a gone item. */
  cancelQueued(projectId: string, tabId: string, itemId: string): boolean
  /**
   * A view's answer to a plugin's close ask (CloseAsks.answer): the first from any view of the
   * window wins, a decline waits for the others; false for an ask its window was not sent. A winning
   * Close closes the tab in main and answers whether it did.
   */
  closeAnswer(windowId: number, viewId: ViewId, requestId: string, answer: { closed: boolean; declined: boolean }): boolean
  /**
   * A view's Allow or Deny of a `ccc plugin link` confirm (LinkAsks.answer): the first from any view of
   * the window wins, but a remote view's Allow is refused (only the desktop approves a plugin link).
   */
  linkAnswer(windowId: number, requestId: string, allow: boolean, remote: boolean): boolean
  /**
   * A view's Move or Cancel of a ctx.files.trash confirm (TrashAsks.answer): the first from any view
   * of the window wins; false for an ask of another window, an unknown or a settled one.
   */
  trashAnswer(windowId: number, requestId: string, move: boolean): boolean
}

/**
 * Claude status handlers, each on the sender's own project. Focusing another window's tab and a
 * session's file click went with the core Sessions panel and strip (design-next §4): the plugin that
 * draws them now asks through ctx.sessions.focus / openFile (host-api.ts), with its limits.
 */
export function registerSessionHandlers(router: IpcRouter, deps: SessionHandlerDeps): void {
  router.handleProject('sessions.list', (ctx) => deps.snapshotFor(ctx.projectId))

  router.handleProject('sessions.cancelQueued', (ctx, payload) => {
    const itemId = fields('sessions.cancelQueued', payload).itemId
    if (typeof itemId !== 'string') throw new Error('sessions.cancelQueued: itemId must be a string')
    return deps.cancelQueued(ctx.projectId, tabIdOf('sessions.cancelQueued', payload), itemId)
  })

  // `adapted`: the window and whether the caller is a remote view are the sender's (ctx, view.remote),
  // never values in the payload. LinkAsks.answer ignores another window's id and refuses a remote
  // Allow: a browser may Deny a plugin link, only the desktop may approve one (design-web.md §6.1).
  router.handleProject('links.answer', (ctx, payload, view) => {
    const { requestId, allow } = fields('links.answer', payload)
    if (typeof requestId !== 'string') throw new Error('links.answer: requestId must be a string')
    if (typeof allow !== 'boolean') throw new Error('links.answer: allow must be a boolean')
    return deps.linkAnswer(ctx.windowId, requestId, allow, view.remote)
  })

  // `yes`: any view of the window may answer a Move to Trash confirm, either way (trash-asks.ts says
  // why). The window is the sender's (ctx), never one in the payload, so an answer only reaches an ask
  // main sent to this window.
  router.handleProject('trash.answer', (ctx, payload) => {
    const { requestId, move } = fields('trash.answer', payload)
    if (typeof requestId !== 'string') throw new Error('trash.answer: requestId must be a string')
    if (typeof move !== 'boolean') throw new Error('trash.answer: move must be a boolean')
    return deps.trashAnswer(ctx.windowId, requestId, move)
  })

  // The window and the view are the sender's (ctx, view), never values in the payload: only a view
  // of the window an ask went to can settle it (shared ask: any of its views, first answer wins).
  router.handleProject('sessions.closeAnswer', (ctx, payload, view) => {
    const { requestId, closed, declined } = fields('sessions.closeAnswer', payload)
    if (typeof requestId !== 'string') throw new Error('sessions.closeAnswer: requestId must be a string')
    if (typeof closed !== 'boolean') throw new Error('sessions.closeAnswer: closed must be a boolean')
    if (declined !== undefined && typeof declined !== 'boolean') throw new Error('sessions.closeAnswer: declined must be a boolean')
    return deps.closeAnswer(ctx.windowId, view.viewId, requestId, { closed, declined: declined === true })
  })
}

/** What the layout handlers need from main (the layout service). */
export interface LayoutHandlerDeps {
  /** undefined for a project that has no record (cannot happen for an open window). */
  view(projectId: string): LayoutView | undefined
  /** `keepGeometry`: a remote view's edit, whose sizes and collapsed zones stay its own (LayoutService.set). */
  set(projectId: string, layout: unknown, opts?: { keepGeometry?: boolean }): LayoutView | undefined
}

/**
 * Zone layout handlers. Both act on the sender's own project. The layout in `layout.set` is
 * renderer input: here it is only checked to be an object, and the service normalizes and
 * reconciles it against the panels that exist before anything is stored.
 */
export function registerLayoutHandlers(router: IpcRouter, deps: LayoutHandlerDeps): void {
  router.handleProject('layout.get', (ctx) => {
    const view = deps.view(ctx.projectId)
    if (!view) throw new Error('layout.get: project record is gone')
    return view
  })

  // `adapted` for a remote view: sizes and collapsed zones are per view (design-web.md §5.1), so
  // main takes only the shared part of its layout and the desktop's geometry stays as it was.
  router.handleProject('layout.set', (ctx, payload, callView) => {
    const layout = fields('layout.set', payload).layout
    if (typeof layout !== 'object' || layout === null) {
      throw new Error('layout.set: layout must be an object')
    }
    if (layoutTooLarge(layout as Record<string, unknown>)) {
      throw new Error('layout.set: layout is too large')
    }
    const view = callView.remote ? deps.set(ctx.projectId, layout, { keepGeometry: true }) : deps.set(ctx.projectId, layout)
    if (!view) throw new Error('layout.set: project record is gone')
    return view
  })
}

/** What the overlay handlers need from main (the overlay manager), all scoped to a window. */
export interface OverlayHandlerDeps {
  /** The calling view's re-attach (OverlayManager.list): only the html pages it holds reload. */
  list(windowId: number, viewId: ViewId): OverlayInfo[]
  close(windowId: number, overlayId: string): boolean
  /** Input and sizes are the caller's view's (OverlayManager: per-view sizes, the typing view sizes). */
  input(windowId: number, overlayId: string, data: string, viewId: ViewId): void
  resize(windowId: number, overlayId: string, cols: number, rows: number, viewId: ViewId): void
  ack(windowId: number, overlayId: string, count: number): void
  setBounds(
    windowId: number,
    overlayId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): void
  /**
   * The page, the reports and the answer below come from the view holding an html overlay's page
   * only (design-web.md §5.4); the manager drops them from any other view of the window.
   */
  result(windowId: number, overlayId: string, value: unknown, viewId: ViewId): boolean
  /** A plugin overlay page's message (OverlayManager.pageMessage checks text and size). */
  message(windowId: number, overlayId: string, text: string, viewId: ViewId): boolean
  /** The page's port is up (OverlayManager.pageReady). */
  ready(windowId: number, overlayId: string, viewId: ViewId): void
  /** The page called `ccPanel.ready()` (OverlayManager.pageLoaded): its loader goes. */
  loaded(windowId: number, overlayId: string, viewId: ViewId): void
  /** "Take over": the html overlay's page moves to the calling view (OverlayManager.take). */
  take(windowId: number, viewId: ViewId, overlayId: string): boolean
  /**
   * A toolbar button click (OverlayManager.buttonClick checks it is a button it shows now), from
   * `viewId` (the caller main bound): the plugin's handlers run in it when it is a remote view.
   */
  button(windowId: number, overlayId: string, click: OverlayButtonClick, viewId: ViewId): boolean
  /** Discuss with Claude's Send (OverlayManager.discuss checks the overlay and target again). */
  discuss(windowId: number, overlayId: string, target: DiscussTarget): Promise<DiscussAnswer>
}

/**
 * Overlay handlers. Overlays live in project windows only, and each one acts on the window main
 * resolved from the sender: an overlay id is looked up in that window's stack, so a page cannot
 * close, type into or answer another window's overlay. Numbers and strings are type-checked here;
 * the manager bounds them further (bounds, result size).
 */
export function registerOverlayHandlers(router: IpcRouter, deps: OverlayHandlerDeps): void {
  router.handleProject('overlays.list', (ctx, _payload, view) => deps.list(ctx.windowId, view.viewId))

  router.handleProject('overlays.close', (ctx, payload) =>
    deps.close(ctx.windowId, overlayIdOf('overlays.close', payload))
  )

  router.handleProject('overlays.input', (ctx, payload, view) => {
    const data = fields('overlays.input', payload).data
    if (typeof data !== 'string') throw new Error('overlays.input: data must be a string')
    deps.input(ctx.windowId, overlayIdOf('overlays.input', payload), data, view.viewId)
  })

  router.handleProject('overlays.resize', (ctx, payload, view) => {
    const { cols, rows } = fields('overlays.resize', payload)
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      throw new Error('overlays.resize: cols and rows must be numbers')
    }
    deps.resize(ctx.windowId, overlayIdOf('overlays.resize', payload), cols, rows, view.viewId)
  })

  // The desktop page's acks are a terminal overlay's flow control (PtyService pauses the PTY on a
  // saturated desktop xterm). A remote view's are dropped: the fastest view would otherwise hide
  // the desktop's backlog, and a browser that falls behind is bounded by its socket instead
  // (connection.ts SOCKET_HIGH_WATER closes it to resync).
  router.handleProject('overlays.ack', (ctx, payload, view) => {
    const count = fields('overlays.ack', payload).count
    if (typeof count !== 'number') throw new Error('overlays.ack: count must be a number')
    if (view.remote) return
    deps.ack(ctx.windowId, overlayIdOf('overlays.ack', payload), count)
  })

  router.handleProject('overlays.bounds', (ctx, payload) => {
    const { x, y, width, height } = fields('overlays.bounds', payload)
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      throw new Error('overlays.bounds: x, y, width and height must be numbers')
    }
    deps.setBounds(ctx.windowId, overlayIdOf('overlays.bounds', payload), { x, y, width, height })
  })

  router.handleProject('overlays.result', (ctx, payload, view) =>
    deps.result(
      ctx.windowId,
      overlayIdOf('overlays.result', payload),
      fields('overlays.result', payload).value,
      view.viewId
    )
  )

  // Only to the opener of an overlay of the SENDER's window (the manager looks the id up there).
  router.handleProject('overlays.message', (ctx, payload, view) => {
    const message = fields('overlays.message', payload).message
    if (typeof message !== 'string') throw new Error('overlays.message: message must be a string')
    return deps.message(ctx.windowId, overlayIdOf('overlays.message', payload), message, view.viewId)
  })

  router.handleProject('overlays.ready', (ctx, payload, view) => {
    deps.ready(ctx.windowId, overlayIdOf('overlays.ready', payload), view.viewId)
  })

  router.handleProject('overlays.loaded', (ctx, payload, view) => {
    deps.loaded(ctx.windowId, overlayIdOf('overlays.loaded', payload), view.viewId)
  })

  // The calling view's own id from the router, never a view named in the payload.
  router.handleProject('overlays.take', (ctx, payload, view) =>
    deps.take(ctx.windowId, view.viewId, overlayIdOf('overlays.take', payload))
  )

  // Only a button of an overlay of the SENDER's window; the manager checks it is one it shows.
  router.handleProject('overlays.button', (ctx, payload, view) => {
    const { source, pluginId, buttonId } = fields('overlays.button', payload)
    if (typeof buttonId !== 'string') throw new Error('overlays.button: buttonId must be a string')
    const overlayId = overlayIdOf('overlays.button', payload)
    if (source === 'opener') return deps.button(ctx.windowId, overlayId, { source, buttonId }, view.viewId)
    if (source === 'type' && typeof pluginId === 'string') return deps.button(ctx.windowId, overlayId, { source, pluginId, buttonId }, view.viewId)
    throw new Error('overlays.button: source must be opener, or type with a pluginId')
  })

  // Discuss on an overlay of the SENDER's window; a tab target is checked there to be a Claude tab
  // of that window (twice: now and just before the send).
  router.handleProject('overlays.discuss', (ctx, payload) => {
    const { target } = fields('overlays.discuss', payload)
    const overlayId = overlayIdOf('overlays.discuss', payload)
    const t = (target ?? {}) as Record<string, unknown>
    if (t.kind === 'new') return deps.discuss(ctx.windowId, overlayId, { kind: 'new' })
    if (t.kind === 'tab' && typeof t.tabId === 'string') return deps.discuss(ctx.windowId, overlayId, { kind: 'tab', tabId: t.tabId })
    throw new Error('overlays.discuss: target must be { kind: "tab", tabId } or { kind: "new" }')
  })
}

/** A webview panel of a project, as main's layout knows it (LayoutService.webviewPanel). */
export interface WebviewPanelRef {
  pluginId: string
  panelId: string
}

/**
 * What the webview panel handlers need: main's own lookup of a panel key, and the view manager
 * (webview-manager.ts), which keys every view and report by main's window id.
 */
export interface WebviewHandlerDeps {
  /** The panel `panelKey` names when it is a webview panel of `projectId` now, else undefined. */
  panel(projectId: string, panelKey: unknown): WebviewPanelRef | undefined
  views: Pick<WebviewManager, 'setPlacement' | 'back' | 'forward' | 'reload' | 'current'>
  /**
   * Main's server flag: the only thing that opens `webviews.place`, `webviews.fit`, `webviews.step`
   * and `webviews.current` to a remote view (the desktop page and the hidden page never send the first two).
   */
  server?: boolean
  /** Server mode's viewers and size owner (webview-viewers.ts); absent: the two channels refuse. */
  viewers?: Pick<WebviewViewers, 'report' | 'claimOwner' | 'leave'>
  /** Server mode's input gate (webview-input.ts); absent: `webviews.input` and `webviews.insertText` refuse. */
  input?: Pick<WebviewInput, 'accept' | 'acceptText'>
}

/**
 * Webview panel handlers (plan B Task 8). The window and project are the sender's: a report or a
 * toolbar click only ever reaches the view of that panel in THAT window, so another window
 * reporting the same panel key moves its own view (if it has one), never this one. A key that is
 * not a webview panel of the sender's project is refused before it reaches the manager, so a page
 * cannot fill main's placement table with made-up panels.
 */
export function registerWebviewHandlers(router: IpcRouter, deps: WebviewHandlerDeps): void {
  const panelOf = (channel: string, ctx: ProjectContext, payload: unknown): WebviewOwner => {
    const ref = deps.panel(ctx.projectId, fields(channel, payload).panelKey)
    if (!ref) throw new Error(`${channel}: not a webview panel of this project`)
    return { windowId: ctx.windowId, projectId: ctx.projectId, pluginId: ref.pluginId, panelId: ref.panelId }
  }
  router.handleProject('webviews.placement', (ctx, payload) => {
    const owner = panelOf('webviews.placement', ctx, payload)
    const { x, y, width, height, visible } = fields('webviews.placement', payload)
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
      throw new Error('webviews.placement: x, y, width and height must be numbers')
    }
    if (typeof visible !== 'boolean') throw new Error('webviews.placement: visible must be a boolean')
    // The manager cleans the numbers (NaN, negatives, huge) before anything reaches Electron.
    deps.views.setPlacement(owner.windowId, owner.pluginId, owner.panelId, { bounds: { x, y, width, height }, visible })
  })
  // `adapted` (design-web-browser.md §3.5): the toolbar. The desktop page acts as before; a remote
  // view only when main runs as a server (its panel is a streamed page there, the desktop's
  // placeholder otherwise), decided by main's flag and the view main bound. The panel is resolved
  // through the caller's own window, so a browser of one window never steps another window's view.
  const toolbarAllowed = (channel: string, view: CallView): void => {
    if (view.remote && deps.server !== true) throw new Error(`${channel}: only a browser view of a server has a webview toolbar`)
  }
  router.handleProject('webviews.step', (ctx, payload, view) => {
    toolbarAllowed('webviews.step', view)
    const owner = panelOf('webviews.step', ctx, payload)
    const step = fields('webviews.step', payload).step
    if (step !== 'back' && step !== 'forward' && step !== 'reload') {
      throw new Error('webviews.step: step must be back, forward or reload')
    }
    deps.views[step](owner)
  })
  router.handleProject('webviews.current', (ctx, payload, view) => {
    toolbarAllowed('webviews.current', view)
    return deps.views.current(panelOf('webviews.current', ctx, payload))
  })

  // `adapted` (design-web-browser.md §3.2): a server's browser view reports where it shows a
  // webview panel, and asks "Fit to this screen". Main's flag and the view main bound decide,
  // never the payload: the desktop page (and in server mode the hidden page, which has the panels
  // open in the shared layout but is on no screen) is refused, as is a browser outside server mode
  // (its panel is the desktop's placeholder). The panel is the caller's window's, by main's layout.
  const viewersFor = (channel: string, view: CallView): Pick<WebviewViewers, 'report' | 'claimOwner' | 'leave'> => {
    if (deps.server !== true || !view.remote || !deps.viewers) {
      throw new Error(`${channel}: only a browser view of a server shows a streamed webview`)
    }
    return deps.viewers
  }
  router.handleProject('webviews.place', (ctx, payload, view) => {
    const viewers = viewersFor('webviews.place', view)
    const { panelKey, width, height, visible, hidden } = fields('webviews.place', payload)
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('webviews.place: width and height must be finite numbers')
    }
    if (typeof visible !== 'boolean' || typeof hidden !== 'boolean') throw new Error('webviews.place: visible and hidden must be booleans')
    const ref = deps.panel(ctx.projectId, panelKey)
    if (!ref) {
      // The key names no webview panel of this project (now): its plugin may have just been turned
      // off, and the view's unmount report must still take the view off the panel, or it would stay
      // a viewer of a panel it no longer shows. `leave` only touches this view's own entry in this
      // window, so a made-up key reaches nothing; the report is still refused.
      if (typeof panelKey === 'string') viewers.leave(ctx.windowId, view.viewId, panelKey)
      throw new Error('webviews.place: not a webview panel of this project')
    }
    // The viewers clamp the sizes ([64, 4096] CSS px) and decide viewer and owner.
    viewers.report({ windowId: ctx.windowId, pluginId: ref.pluginId, panelId: ref.panelId }, view.viewId, { width, height, visible, hidden })
  })
  router.handleProject('webviews.fit', (ctx, payload, view) => {
    const viewers = viewersFor('webviews.fit', view)
    const owner = panelOf('webviews.fit', ctx, payload)
    // Ignored from a view that is not a viewer of the panel now (webview-viewers.ts).
    viewers.claimOwner({ windowId: owner.windowId, pluginId: owner.pluginId, panelId: owner.panelId }, view.viewId)
  })
  // `adapted` (design-web-browser.md §4.1): pointer, wheel and keys into the streamed page, trusted
  // input once sent. The same gate as place/fit (main's flag, the view main bound), the panel by the
  // caller's own window's layout; the input gate checks the view is a viewer of it now, every
  // field, the page bounds and the rate (webview-input.ts).
  const inputFor = (channel: string, view: CallView): Pick<WebviewInput, 'accept' | 'acceptText'> => {
    if (deps.server !== true || !view.remote || !deps.input) {
      throw new Error(`${channel}: only a browser view of a server shows a streamed webview`)
    }
    return deps.input
  }
  router.handleProject('webviews.input', (ctx, payload, view) => {
    const input = inputFor('webviews.input', view)
    const owner = panelOf('webviews.input', ctx, payload)
    input.accept({ windowId: owner.windowId, pluginId: owner.pluginId, panelId: owner.panelId }, view.viewId, fields('webviews.input', payload).events)
  })
  // `adapted` (§4.2): committed text and pasted text, by the same gate; the input gate checks the
  // viewer, the size (64 KB) and takes it from the same rate bucket (webview-input.ts acceptText).
  router.handleProject('webviews.insertText', (ctx, payload, view) => {
    const input = inputFor('webviews.insertText', view)
    const owner = panelOf('webviews.insertText', ctx, payload)
    input.acceptText({ windowId: owner.windowId, pluginId: owner.pluginId, panelId: owner.panelId }, view.viewId, fields('webviews.insertText', payload).text)
  })
}

/** The caller's view when it is a remote one (main bound it), else undefined: the desktop acts as before. */
function remoteViewOf(view: CallView): ViewId | undefined {
  return view.remote ? view.viewId : undefined
}

function overlayIdOf(channel: string, payload: unknown): string {
  const overlayId = fields(channel, payload).overlayId
  if (typeof overlayId !== 'string') throw new Error(`${channel}: overlayId must be a string`)
  return overlayId
}

/**
 * Most entries one list of a `layout.set` layout may hold. A real layout has one entry per panel
 * that exists (and at most MAX_REMEMBERED + hidden remembered ones), far below this. The bound
 * exists because normalizing does `includes` per remembered entry and capping is quadratic in the
 * entry count: a page sending ~1e5 entries would block main's thread and freeze every window.
 */
const MAX_LAYOUT_ENTRIES = 1000

/**
 * Count the lists before anything walks them; `Object.keys` and `.length` are linear at worst.
 * The object checks here deliberately let arrays through (not isPlainObject): this is only a size
 * bound, so it counts whatever shape arrived; the layout normalizer rejects a wrong shape later.
 */
function layoutTooLarge(layout: Record<string, unknown>): boolean {
  const tooMany = (list: unknown): boolean =>
    Array.isArray(list)
      ? list.length > MAX_LAYOUT_ENTRIES
      : typeof list === 'object' && list !== null && Object.keys(list).length > MAX_LAYOUT_ENTRIES
  if (tooMany(layout.hidden) || tooMany(layout.remembered) || tooMany(layout.zones)) return true
  const zones = layout.zones
  if (typeof zones !== 'object' || zones === null) return false
  return Object.values(zones).some(
    (zone) => typeof zone === 'object' && zone !== null && tooMany((zone as Record<string, unknown>).panels)
  )
}

function fields(channel: string, payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null) throw new Error(`${channel}: bad payload`)
  return payload as Record<string, unknown>
}

function tabIdOf(channel: string, payload: unknown): string {
  const tabId = fields(channel, payload).tabId
  if (typeof tabId !== 'string') throw new Error(`${channel}: tabId must be a string`)
  return tabId
}
