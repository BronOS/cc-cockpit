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
import { projectColorOf, type ProjectColor } from '../../shared/project-color'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, type SettingsPageScope } from '../../shared/manifest'
import { isSettingsPageScope } from '../../shared/settings-page'
import type { Theme } from '../../shared/theme'
import type { PluginServicesView } from '../../shared/services'
import type { ProjectView, TabCommandEntry } from '../../shared/types'
import { checkWebUrl, MAX_EXTERNAL_URL_LENGTH } from '../../shared/web-url'
import type { WebviewManager, WebviewOwner } from '../webview/webview-manager'
import type { OverlayButtonClick } from '../overlays/overlay-manager'
import type { DiscussTarget } from '../../shared/discuss'
import type { SenderContext } from '../windows/window-manager'

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

type Req<C extends InvokeChannel> = IpcInvokeMap[C]['req']
type Res<C extends InvokeChannel> = IpcInvokeMap[C]['res']
type Result<C extends InvokeChannel> = Res<C> | Promise<Res<C>>

export class IpcRouter {
  private readonly ipc: IpcMainLike
  private readonly resolveSender: (senderId: number) => SenderContext | undefined
  private readonly isAppPage: (url: string) => boolean
  private readonly log: (message: string) => void

  /** `isAppPage` is normally `appPageMatcher(<where the shell UI is loaded from>)`. */
  constructor(
    ipc: IpcMainLike,
    resolveSender: (senderId: number) => SenderContext | undefined,
    isAppPage: (url: string) => boolean,
    log: (message: string) => void = (m) => console.warn(m)
  ) {
    this.ipc = ipc
    this.resolveSender = resolveSender
    this.isAppPage = isAppPage
    this.log = log
  }

  /** A handler any window main opened may call (the picker included). */
  handleWindow<C extends InvokeChannel>(
    channel: C,
    handler: (ctx: SenderContext, payload: Req<C>) => Result<C>
  ): void {
    this.ipc.handle(channel, (event, ...args) => {
      const ctx = this.authenticate(channel, event)
      // Only the first argument is the payload; extra arguments are dropped, not passed along.
      return handler(ctx, args[0] as Req<C>)
    })
  }

  /** A handler that acts on the sender's project; a picker (no project) is refused. */
  handleProject<C extends InvokeChannel>(
    channel: C,
    handler: (ctx: ProjectContext, payload: Req<C>) => Result<C>
  ): void {
    this.ipc.handle(channel, (event, ...args) => {
      const ctx = this.authenticate(channel, event)
      if (ctx.kind !== 'project') {
        this.log(`ipc ${channel}: refused, sender window ${ctx.windowId} has no project`)
        throw new Error(`${channel}: not a project window`)
      }
      return handler({ windowId: ctx.windowId, projectId: ctx.projectId }, args[0] as Req<C>)
    })
  }

  private authenticate(channel: string, event: IpcEventLike): SenderContext {
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
    return ctx
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

  router.handleWindow('app.openExternal', async (_ctx, payload) => {
    await deps.openExternal(webUrlOf((payload as { url?: unknown } | undefined)?.url))
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
  /** Connect a panel instance of the sender's window (PanelPortHub.connect); false when refused. */
  connect(projectId: string, windowId: number, panelKey: unknown, nonce: unknown): boolean
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
  router.handleProject('panels.connect', (ctx, payload) => {
    const { panelKey, nonce } = fields('panels.connect', payload)
    return deps.connect(ctx.projectId, ctx.windowId, panelKey, nonce)
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
  /** Connect a slot frame of the sender's window (PanelPortHub.connectSlot); false when refused. */
  connect(projectId: string, windowId: number, frameId: unknown, nonce: unknown): boolean
  /** The shell unmounted the frame (PanelPortHub.disconnectSlot). */
  disconnect(projectId: string, frameId: string): void
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
  router.handleProject('slots.connect', (ctx, payload) => {
    const frameId = frameIdOf('slots.connect', payload)
    return deps.connect(ctx.projectId, ctx.windowId, frameId, fields('slots.connect', payload).nonce)
  })
  router.handleProject('slots.disconnect', (ctx, payload) => {
    deps.disconnect(ctx.projectId, frameIdOf('slots.disconnect', payload))
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
  /** Connect the page of the sender's window (PanelPortHub.connectSettingsPage); false when refused. */
  connect(projectId: string, windowId: number, pluginId: string, scope: SettingsPageScope, nonce: unknown): boolean
  /** The shell unmounted the page (PanelPortHub.disconnectSettingsPage). */
  disconnect(projectId: string, pluginId: string): void
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
  router.handleProject('settingsPage.connect', (ctx, payload) =>
    deps.connect(
      ctx.projectId,
      ctx.windowId,
      pluginIdOf('settingsPage.connect', payload),
      scopeOf('settingsPage.connect', payload),
      fields('settingsPage.connect', payload).nonce
    )
  )
  router.handleProject('settingsPage.disconnect', (ctx, payload) => {
    deps.disconnect(ctx.projectId, pluginIdOf('settingsPage.disconnect', payload))
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
  refreshMarketplace(): Promise<MarketplaceView>
  setMarketplaceUrls(urls: unknown): Promise<MarketplaceView>
  /** `secrets`: the form's secret edits (SecretEdits), checked by the service like `values`. */
  savePluginSettings(id: unknown, values: unknown, secrets: unknown): Promise<PluginSettingsSaveResult>
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
  router.handleProject('settings.marketplaceRefresh', () => deps.refreshMarketplace())
  router.handleProject('settings.marketplaceSetUrls', (_ctx, payload) =>
    deps.setMarketplaceUrls(fields('settings.marketplaceSetUrls', payload).urls)
  )
  router.handleProject('settings.pluginSettingsSave', (_ctx, payload) => {
    const p = fields('settings.pluginSettingsSave', payload)
    return deps.savePluginSettings(p.id, p.values, p.secrets)
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
  /** Opens the release page of the available version, which main built; nothing from a renderer. */
  openRelease(): void | Promise<void>
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
  router.handleWindow('updates.openRelease', () => deps.openRelease())
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
  restart(projectId: string, tabId: string, windowId: number): TabInfo | Promise<TabInfo>
  input(projectId: string, tabId: string, data: string): void
  resize(projectId: string, tabId: string, cols: number, rows: number): void
  ack(projectId: string, tabId: string, count: number): void
  /** The window shows this tab now (SessionRegistry.setActive after a check that it is the project's). */
  select(projectId: string, tabId: string): void
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
  router.handleProject('tabs.list', (ctx) => tabs.attach(ctx.projectId, ctx.windowId))

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

  router.handleProject('tabs.restart', (ctx, payload) =>
    tabs.restart(ctx.projectId, tabIdOf('tabs.restart', payload), ctx.windowId)
  )

  router.handleProject('tabs.input', (ctx, payload) => {
    const data = fields('tabs.input', payload).data
    if (typeof data !== 'string') throw new Error('tabs.input: data must be a string')
    tabs.input(ctx.projectId, tabIdOf('tabs.input', payload), data)
  })

  router.handleProject('tabs.resize', (ctx, payload) => {
    const { cols, rows } = fields('tabs.resize', payload)
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      throw new Error('tabs.resize: cols and rows must be numbers')
    }
    tabs.resize(ctx.projectId, tabIdOf('tabs.resize', payload), cols, rows)
  })

  router.handleProject('tabs.ack', (ctx, payload) => {
    const count = fields('tabs.ack', payload).count
    if (typeof count !== 'number') throw new Error('tabs.ack: count must be a number')
    tabs.ack(ctx.projectId, tabIdOf('tabs.ack', payload), count)
  })

  // Only the id travels; whether it is one of the sender's project's tabs is main's check (select).
  router.handleProject('tabs.selected', (ctx, payload) => {
    tabs.select(ctx.projectId, tabIdOf('tabs.selected', payload))
  })
}

/** What the Claude status handlers need from main (the session registry and the windows). */
export interface SessionHandlerDeps {
  /** The sender's project's view (see SessionRegistry.snapshotFor). */
  snapshotFor(projectId: string): SessionsSnapshot
  /** Scoped to `projectId`: false for a tab of another project, an unknown tab or a gone item. */
  cancelQueued(projectId: string, tabId: string, itemId: string): boolean
  /** A window's answer to a plugin's close ask (CloseAsks.answer); false for an ask it was not sent. */
  closeAnswer(windowId: number, requestId: string, closed: boolean): boolean
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

  // The window is the sender's (ctx), never a value in the payload: only the window an ask went to
  // can settle it.
  router.handleProject('sessions.closeAnswer', (ctx, payload) => {
    const { requestId, closed } = fields('sessions.closeAnswer', payload)
    if (typeof requestId !== 'string') throw new Error('sessions.closeAnswer: requestId must be a string')
    if (typeof closed !== 'boolean') throw new Error('sessions.closeAnswer: closed must be a boolean')
    return deps.closeAnswer(ctx.windowId, requestId, closed)
  })
}

/** What the layout handlers need from main (the layout service). */
export interface LayoutHandlerDeps {
  /** undefined for a project that has no record (cannot happen for an open window). */
  view(projectId: string): LayoutView | undefined
  set(projectId: string, layout: unknown): LayoutView | undefined
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

  router.handleProject('layout.set', (ctx, payload) => {
    const layout = fields('layout.set', payload).layout
    if (typeof layout !== 'object' || layout === null) {
      throw new Error('layout.set: layout must be an object')
    }
    if (layoutTooLarge(layout as Record<string, unknown>)) {
      throw new Error('layout.set: layout is too large')
    }
    const view = deps.set(ctx.projectId, layout)
    if (!view) throw new Error('layout.set: project record is gone')
    return view
  })
}

/** What the overlay handlers need from main (the overlay manager), all scoped to a window. */
export interface OverlayHandlerDeps {
  list(windowId: number): OverlayInfo[]
  close(windowId: number, overlayId: string): boolean
  input(windowId: number, overlayId: string, data: string): void
  resize(windowId: number, overlayId: string, cols: number, rows: number): void
  ack(windowId: number, overlayId: string, count: number): void
  setBounds(
    windowId: number,
    overlayId: string,
    bounds: { x: number; y: number; width: number; height: number }
  ): void
  result(windowId: number, overlayId: string, value: unknown): boolean
  /** A plugin overlay page's message (OverlayManager.pageMessage checks text and size). */
  message(windowId: number, overlayId: string, text: string): boolean
  /** The page's port is up (OverlayManager.pageReady). */
  ready(windowId: number, overlayId: string): void
  /** The page called `ccPanel.ready()` (OverlayManager.pageLoaded): its loader goes. */
  loaded(windowId: number, overlayId: string): void
  /** A toolbar button click (OverlayManager.buttonClick checks it is a button it shows now). */
  button(windowId: number, overlayId: string, click: OverlayButtonClick): boolean
  /** Discuss with Claude's Send (OverlayManager.discuss checks the overlay, note and target again). */
  discuss(windowId: number, overlayId: string, target: DiscussTarget, note: string): Promise<DiscussAnswer>
}

/**
 * Overlay handlers. Overlays live in project windows only, and each one acts on the window main
 * resolved from the sender: an overlay id is looked up in that window's stack, so a page cannot
 * close, type into or answer another window's overlay. Numbers and strings are type-checked here;
 * the manager bounds them further (bounds, result size).
 */
export function registerOverlayHandlers(router: IpcRouter, deps: OverlayHandlerDeps): void {
  router.handleProject('overlays.list', (ctx) => deps.list(ctx.windowId))

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

  router.handleProject('overlays.result', (ctx, payload) =>
    deps.result(
      ctx.windowId,
      overlayIdOf('overlays.result', payload),
      fields('overlays.result', payload).value
    )
  )

  // Only to the opener of an overlay of the SENDER's window (the manager looks the id up there).
  router.handleProject('overlays.message', (ctx, payload) => {
    const message = fields('overlays.message', payload).message
    if (typeof message !== 'string') throw new Error('overlays.message: message must be a string')
    return deps.message(ctx.windowId, overlayIdOf('overlays.message', payload), message)
  })

  router.handleProject('overlays.ready', (ctx, payload) => {
    deps.ready(ctx.windowId, overlayIdOf('overlays.ready', payload))
  })

  router.handleProject('overlays.loaded', (ctx, payload) => {
    deps.loaded(ctx.windowId, overlayIdOf('overlays.loaded', payload))
  })

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
    const { target, note } = fields('overlays.discuss', payload)
    if (typeof note !== 'string') throw new Error('overlays.discuss: note must be a string')
    const overlayId = overlayIdOf('overlays.discuss', payload)
    const t = (target ?? {}) as Record<string, unknown>
    if (t.kind === 'new') return deps.discuss(ctx.windowId, overlayId, { kind: 'new' }, note)
    if (t.kind === 'tab' && typeof t.tabId === 'string') return deps.discuss(ctx.windowId, overlayId, { kind: 'tab', tabId: t.tabId }, note)
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
