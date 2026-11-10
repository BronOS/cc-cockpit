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
import type { ProjectView, TabCommandEntry } from '../../shared/types'
import { checkWebUrl, MAX_EXTERNAL_URL_LENGTH } from '../../shared/web-url'
import type { WebAccessIndicator, WebAccessPatch, WebAccessView, WebLinkReply } from '../../shared/web-access'
import type { WebviewManager, WebviewOwner } from '../webview/webview-manager'
import type { OverlayButtonClick } from '../overlays/overlay-manager'
import type { DiscussTarget } from '../../shared/discuss'
import type { SenderContext } from '../windows/window-manager'
import { desktopViewId, isRemoteViewId, type ViewId, type Who } from '../../shared/views'

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
    log: (message: string) => void = (m) => console.warn(m),
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
   */
  dispatch(caller: WebCaller, channel: string, payload: unknown): Promise<unknown> {
    return Promise.resolve().then(() => {
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
  /** Hand an already validated http(s) URL to the system browser. */
  openExternal(url: string): void | Promise<void>
  /**
   * The clickable notice for a remote view (`app.linkNotice` to that view only, design-web.md §6.1): a
   * browser cannot open a tab without a click, and the host's browser is not the person's screen.
   */
  linkNotice(viewId: ViewId, url: string): void
  /** The theme every window shows now (app-wide, never per project). */
  currentTheme(): Theme
  /** The app settings the shell page applies itself (AppearanceService.prefs), defaults applied. */
  shellPrefs(): ShellPrefs
  /** The project's commands with keys resolved (main's registry + the user's overrides). */
  commands(projectId: string): CommandsView
  /** Run a plugin command the project's host registered (HostManager.runCommand); rejects otherwise. */
  runCommand(projectId: string, id: string): Promise<void>
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

  // `adapted`: decided by the view main bound to the call (`view.remote`), never by the payload.
  router.handleWindow('app.openExternal', async (_ctx, payload, view) => {
    const url = webUrlOf((payload as { url?: unknown } | undefined)?.url)
    if (view.remote) deps.linkNotice(view.viewId, url)
    else await deps.openExternal(url)
  })

  // Read-only and app-wide: any of our windows may ask. Changes arrive as `theme.changed`.
  router.handleWindow('theme.get', () => deps.currentTheme())
  // Same shape: app-wide and read-only; the picker loads the same page and asks too. Changes
  // arrive as `prefs.changed`.
  router.handleWindow('prefs.get', () => deps.shellPrefs())

  // The project comes from the sender; plugin commands are per project.
  router.handleProject('commands.list', (ctx) => deps.commands(ctx.projectId))

  // Plugin commands only: they run in the sender's project's host, which main looks up itself.
  // Core commands run in the renderer and have no business here.
  router.handleProject('commands.run', async (ctx, payload) => {
    const id: unknown = (payload as { id?: unknown } | undefined)?.id
    if (typeof id !== 'string' || id.length > 200 || !id.includes('/')) {
      throw new Error('commands.run: id must name a plugin command')
    }
    await deps.runCommand(ctx.projectId, id)
  })
}

/** What the plugin panel handlers need (panel-ports.ts, host-manager.ts). */
export interface PanelHandlerDeps {
  /** Connect a panel instance of the calling view (PanelPortHub.connect); false when refused. */
  connect(projectId: string, viewId: ViewId, panelKey: unknown, nonce: unknown): boolean
  /** Start the project's plugin host again if it gave up (HostManager.restartStopped). */
  restartHost(projectId: string): Promise<void>
  /** A header action click (HostManager.panelAction); false when the host dropped it. */
  panelAction(projectId: string, panelKey: string, actionId: string): boolean
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
  // keep a junk payload from being carried any further.
  router.handleProject('panels.action', (ctx, payload) => {
    const { panelKey, actionId } = fields('panels.action', payload)
    if (typeof panelKey !== 'string' || panelKey.length > 300 || typeof actionId !== 'string' || actionId.length > 40) {
      throw new Error('panels.action: panelKey and actionId must be short strings')
    }
    return deps.panelAction(ctx.projectId, panelKey, actionId)
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
  appearance(projectId: string): AppearanceView
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
  router.handleProject('settings.appearance', (ctx) => deps.appearance(ctx.projectId))
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
   * `remoteView`: the asking browser view, which gets a clickable notice instead (design-web.md §6.1).
   */
  openRelease(remoteView?: ViewId): void | Promise<void>
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
  router.handleWindow('updates.openRelease', (_ctx, _payload, view) => deps.openRelease(view.remote ? view.viewId : undefined))
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
 * What the web access handlers need (WebAccessService, main/web/access-service.ts). Every channel
 * here is `no`-class: the router refuses a remote caller before a handler runs, so these are the
 * desktop's alone and need no check of their own for that.
 */
export interface WebAccessHandlerDeps {
  view(): WebAccessView
  set(patch: WebAccessPatch): Promise<WebAccessView>
  link(): Promise<WebLinkReply>
  regenerate(): Promise<WebLinkReply>
  addDevice(): WebLinkReply
  /** `id` is whatever the renderer sent: the service checks the type. */
  disconnect(id: unknown): boolean
  revoke(id: unknown): boolean
  revokeAll(): number
  indicator(): WebAccessIndicator
}

export function registerWebAccessHandlers(router: IpcRouter, deps: WebAccessHandlerDeps): void {
  router.handleProject('settings.webAccess', () => deps.view())
  router.handleProject('settings.webAccessSet', (_ctx, payload) => deps.set((payload as { value?: WebAccessPatch } | undefined)?.value as WebAccessPatch))
  router.handleProject('settings.webAccessLink', () => deps.link())
  router.handleProject('settings.webAccessRegenerate', () => deps.regenerate())
  router.handleProject('settings.webAccessAddDevice', () => deps.addDevice())
  router.handleProject('settings.webDeviceDisconnect', (_ctx, payload) => deps.disconnect((payload as { id?: unknown } | undefined)?.id))
  router.handleProject('settings.webDeviceRevoke', (_ctx, payload) => deps.revoke((payload as { id?: unknown } | undefined)?.id))
  router.handleProject('settings.webDevicesRevokeAll', () => deps.revokeAll())
  router.handleProject('webAccess.state', () => deps.indicator())
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
}

/**
 * Tab handlers. Every one acts on `ctx.projectId`, the project main resolved from the sender;
 * the tab id in a payload is only looked up inside that project. The payload is renderer input,
 * so each field is type-checked here rather than trusted to match the declared type.
 */
export function registerTabHandlers(router: IpcRouter, tabs: TabHandlerDeps): void {
  // Attaching resets flow control (TabManager.attach), so call this once per page load only,
  // never to refresh the list after create/exit/reorder: with xterm saturated that would wipe
  // the unacked count and resume a paused PTY. Task 8 should take refreshes from tab events.
  // `adapted`: a remote view gets the plain list. Attaching is the desktop page's: it resets (or
  // resyncs) the DESKTOP's terminals and runs the window's restore, and a browser joining or
  // reconnecting must leave the desktop exactly as it was; its own terminals start at its select.
  router.handleProject('tabs.list', (ctx, _payload, view) =>
    view.remote ? tabs.list(ctx.projectId) : tabs.attach(ctx.projectId, ctx.windowId)
  )

  router.handleProject('tabs.commands', (ctx) => tabs.commands(ctx.projectId))

  router.handleProject('tabs.create', (ctx, payload) => {
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
  })

  router.handleProject('tabs.close', (ctx, payload) => {
    tabs.close(ctx.projectId, tabIdOf('tabs.close', payload))
  })

  router.handleProject('tabs.reorder', (ctx, payload) => {
    const toIndex = fields('tabs.reorder', payload).toIndex
    if (typeof toIndex !== 'number' || !Number.isInteger(toIndex)) {
      throw new Error('tabs.reorder: toIndex must be an integer')
    }
    tabs.reorder(ctx.projectId, tabIdOf('tabs.reorder', payload), toIndex)
  })

  router.handleProject('tabs.rename', (ctx, payload) => {
    const name = fields('tabs.rename', payload).name
    if (name !== null && typeof name !== 'string') throw new Error('tabs.rename: name must be a string or null')
    tabs.rename(ctx.projectId, tabIdOf('tabs.rename', payload), name)
  })

  // The person's flag: only from the shell page's top frame of the tab's own project window
  // (handleProject), the one way a flag is ever written. The patch is checked field by field in
  // main (shared/tab-flag.ts checkFlagPatch, through TabManager.setFlag).
  router.handleProject('tabs.flag', (ctx, payload) => {
    const p = fields('tabs.flag', payload)
    if (!('flag' in p)) throw new Error('tabs.flag: flag must be an object or null')
    return tabs.flag(ctx.projectId, tabIdOf('tabs.flag', payload), p.flag)
  })

  router.handleProject('tabs.toggleFlag', (ctx, payload) => tabs.toggleFlag(ctx.projectId, tabIdOf('tabs.toggleFlag', payload)))

  router.handleProject('tabs.restart', (ctx, payload) =>
    tabs.restart(ctx.projectId, tabIdOf('tabs.restart', payload), ctx.windowId)
  )

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
   * window wins, a decline waits for the others; false for an ask its window was not sent.
   */
  closeAnswer(windowId: number, viewId: ViewId, requestId: string, answer: { closed: boolean; declined: boolean }): boolean
  /**
   * A view's Allow or Deny of a `ccc plugin link` confirm (LinkAsks.answer): the first from any view of
   * the window wins, but a remote view's Allow is refused (only the desktop approves a plugin link).
   */
  linkAnswer(windowId: number, requestId: string, allow: boolean, remote: boolean): boolean
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
  input(windowId: number, overlayId: string, data: string): void
  resize(windowId: number, overlayId: string, cols: number, rows: number): void
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
  /** A toolbar button click (OverlayManager.buttonClick checks it is a button it shows now). */
  button(windowId: number, overlayId: string, click: OverlayButtonClick): boolean
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

  router.handleProject('overlays.input', (ctx, payload) => {
    const data = fields('overlays.input', payload).data
    if (typeof data !== 'string') throw new Error('overlays.input: data must be a string')
    deps.input(ctx.windowId, overlayIdOf('overlays.input', payload), data)
  })

  router.handleProject('overlays.resize', (ctx, payload) => {
    const { cols, rows } = fields('overlays.resize', payload)
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      throw new Error('overlays.resize: cols and rows must be numbers')
    }
    deps.resize(ctx.windowId, overlayIdOf('overlays.resize', payload), cols, rows)
  })

  router.handleProject('overlays.ack', (ctx, payload) => {
    const count = fields('overlays.ack', payload).count
    if (typeof count !== 'number') throw new Error('overlays.ack: count must be a number')
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
  router.handleProject('overlays.button', (ctx, payload) => {
    const { source, pluginId, buttonId } = fields('overlays.button', payload)
    if (typeof buttonId !== 'string') throw new Error('overlays.button: buttonId must be a string')
    const overlayId = overlayIdOf('overlays.button', payload)
    if (source === 'opener') return deps.button(ctx.windowId, overlayId, { source, buttonId })
    if (source === 'type' && typeof pluginId === 'string') return deps.button(ctx.windowId, overlayId, { source, pluginId, buttonId })
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
  router.handleProject('webviews.step', (ctx, payload) => {
    const owner = panelOf('webviews.step', ctx, payload)
    const step = fields('webviews.step', payload).step
    if (step !== 'back' && step !== 'forward' && step !== 'reload') {
      throw new Error('webviews.step: step must be back, forward or reload')
    }
    deps.views[step](owner)
  })
  router.handleProject('webviews.current', (ctx, payload) => deps.views.current(panelOf('webviews.current', ctx, payload)))
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
