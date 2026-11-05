// Electron main process entry.
//
// RULE: Electron-only or Electron-ABI modules (`node-pty`, `safeStorage`, `utilityProcess`,
// `BrowserWindow`, `protocol`, `Notification`) are imported ONLY from thin adapter files (e.g.
// `pty/node-pty-backend.ts`, `plugins/host-process.ts`, `windows/create-window.ts`,
// `notifications/electron-notification.ts`; `safeStorage` is used only through
// `secrets/secret-store.ts`), never from logic modules that unit tests load.
// Unit tests run in plain Node, where `node-pty` (built for the Electron ABI) does not even load;
// logic modules take these capabilities through interfaces and tests pass fakes. Only the
// Playwright e2e run exercises the real adapters.
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  nativeTheme,
  safeStorage,
  session,
  shell,
  type OpenDialogOptions
} from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUILD_VERSION } from '../shared/app-version'
import { errorText } from '../shared/error-text'
import { isPlainObject } from '../shared/guards'
import { PANEL_PORT_CHANNEL, type EventChannel, type OverlayInfo, type TabInfo, type UpdateState } from '../shared/ipc'
import { notificationSoundOf } from '../shared/notify-sound'
import { liveChildren } from './child-registry'
import { ClaudePlugins, ClaudePluginsBuilds, type SkillSource } from './claude-plugins/claude-plugins'
import { CommandRegistry } from './commands/command-registry'
import { loadLoginEnv, type Env } from './env/login-env'
import { buildPtyEnv } from './env/pty-env'
import { CccCommandInstaller } from './hooks/ccc-install'
import { CccOffer } from './hooks/ccc-offer'
import { resolveWrapperTargets, writeCccWrapper } from './hooks/ccc-wrapper'
import { writeHooksFile } from './hooks/hooks-file'
import {
  appPageMatcher,
  IpcRouter,
  registerCoreHandlers,
  registerLayoutHandlers,
  registerOverlayHandlers,
  registerPanelHandlers,
  registerSlotHandlers,
  registerSettingsPageHandlers,
  registerSessionHandlers,
  registerCccCommandHandlers,
  registerProjectSettingsHandlers,
  registerUpdateHandlers,
  registerSettingsHandlers,
  registerServiceHandlers,
  registerTabHandlers,
  registerWebviewHandlers,
  summary
} from './ipc/router'
import { LayoutService, type PanelStatus, type PluginPanelDef, type SlotProviderInfo } from './layout/layout-service'
import { AppMenu, openFolderKey } from './menu'
import { ElectronNoticeBackend } from './notifications/electron-notification'
import { ChimeGate, Notifier, NotifySounds, pluginNoticeSpec, RecordingNoticeBackend } from './notifications/notifier'
import { SystemSounds, systemSoundRoots } from './notifications/system-sounds'
import { ElectronUrlViewFactory } from './overlays/electron-url-view'
import { ElectronWebviewFactory } from './webview/electron-webview'
import { PreviewBudgets, servePreviewRequest } from './webview/preview-protocol'
import { webviewChord, WebviewManager } from './webview/webview-manager'
import {
  chordOfInput,
  OverlayManager,
  type OverlayChannel,
  type OverlayResult,
  type OverlayTypeButtons
} from './overlays/overlay-manager'
import { handleOverlayScheme, handlePluginScheme, registerAppSchemes } from './overlays/overlay-protocol'
import { dataPaths, fallbackSocketDir, pluginAppDataDir, pluginDataDir, resolveDataDir, socketPath } from './paths'
import { createFolderWatcher, DevWatcher } from './plugins/dev-watch'
import { AppStorage } from './plugins/app-storage'
import { HostManager, hostPluginSource, type HostPlugin, type HostPluginSource, type HostSettings } from './plugins/host-manager'
import { ElectronHostProcessFactory } from './plugins/host-process'
import { bundledPluginSpecs, bundledRoot } from './plugins/bundled'
import { electronConfirmLink, QueuedLinkConfirm } from './plugins/link-dialog'
import { enabledPluginIds, pluginOnInRecord } from './plugins/enablement'
import { PluginInstaller, type InstalledPlugin } from './plugins/installer'
import { PanelPortHub } from './plugins/panel-ports'
import { pluginFileUrl, servePluginRequest } from './plugins/plugin-protocol'
import { PluginLogWriter } from './plugins/plugin-log'
import { PluginIndex } from './plugins/plugin-index'
import { ProjectRegistry, realPathOf } from './projects/registry'
import { buildRestorePlan, forgetMissing, planLaunch, relinkMissing, TabRestorer } from './restore'
import { PluginOAuth } from './oauth/plugin-oauth'
import { PluginSecrets } from './secrets/plugin-secrets'
import { choosePasswordStore, execRunner } from './secrets/password-store'
import { safeStorageSecretStore, selectSecretStore } from './secrets/secret-store'
import {
  AppearanceService,
  claudeTabOnOpenOf,
  notificationSoundsOf,
  sessionGistOf,
  tabExitOf
} from './settings/appearance-service'
import { hostSettingsOf as pluginHostSettings } from './settings/plugin-settings'
import { ProjectSettingsService } from './settings/project-settings-service'
import { ServiceChoices } from './plugins/service-choices'
import { SettingsService } from './settings/settings-service'
import { migrateSessionFilesShown, needsSessionFilesMigration } from './settings/sessions-migration'
import { windowBackgroundOf } from './settings/window-background'
import { NodePtyBackend } from './pty/node-pty-backend'
import { hookHandler } from './sessions/hook-handler'
import { execLsFiles, openDiff, openProjectFileDiff, type OpenDiffOptions } from './sessions/open-diff'
import { CloseAsks, closeWillAsk } from './sessions/close-asks'
import { routeOpenFile, routeProjectFile, type OpenFileRouteDeps } from './sessions/open-file'
import { runGist } from './sessions/gist-run'
import { SessionGist } from './sessions/session-gist'
import { prepareText } from './sessions/send-gate'
import { SessionRegistry } from './sessions/session-registry'
import { registerCliHandlers, registerPanelShowHandler, registerPluginCliHandlers, registerPluginConfigHandler, registerPluginDevHandlers } from './socket/handlers'
import { pluginConfigView, setPluginConfig, type PluginConfigDeps } from './settings/plugin-config'
import { SocketServer, type TokenOwner } from './socket/socket-server'
import { createReleaseFetcher, UpdateChecker } from './updates/update-check'
import { ThemeService } from './themes/theme-service'
import { FirstTab } from './tabs/first-tab'
import { commandOverlaySpec, loginShellOf } from './tabs/claude-argv'
import { menuWithKeys, openTabCommand, tabCommandsOf, TabCommandsService } from './tabs/tab-commands'
import { TabManager } from './tabs/tab-manager'
import { isTestRun } from './test-run'
import { DEFAULT_MARKETPLACE_URL } from '../shared/marketplace'
import { selectOpenFile } from '../shared/services'
import { createIndexFetcher, type IndexFetcher } from './marketplace/fetch-index'
import { MarketplaceService, marketplaceUrls } from './marketplace/marketplace-service'
import { revocationNotice } from './marketplace/marketplace-view'
import { rendererLocation } from './windows/create-window'
import { ElectronWindowFactory } from './windows/electron-window-factory'
import { blurSupport } from './windows/window-chrome'
import { lockDownSession, lockDownWebContents, NO_APP_PAGE } from './windows/permissions'
import {
  asSecondInstanceData,
  projectPathFromArgv,
  WindowManager,
  type SecondInstanceData
} from './windows/window-manager'

// Apply the CC_COCKPIT_DATA_DIR override FIRST: before `requestSingleInstanceLock()` and before
// `ready`. The single-instance lock file and Electron's own state (caches, cookies, the Local
// Storage of every renderer) live under userData; set late, they would already have been created
// in the real profile, and an e2e run would collide with the user's running app.
const userData = app.getPath('userData')
const dataDir = resolveDataDir(userData, process.env)
if (dataDir !== userData) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  app.setPath('userData', dataDir)
}

// One instance per data dir. A second launch (`cc-cockpit ~/src/foo` from a terminal, a dock
// re-launch) hands its argv to the running instance through `second-instance` and exits.
// `app.quit()` does not stop this script, hence the `else`: nothing below may run in a loser.
// The loser also sends its own argv and cwd as `additionalData`: the argv Electron delivers to
// `second-instance` may be reordered and extended by Chromium (electron.d.ts), and its order is
// what tells the app path from a project folder under `electron .`.
const launch: SecondInstanceData = { argv: process.argv, cwd: process.cwd() }
if (!app.requestSingleInstanceLock(launch)) {
  app.quit()
} else {
  start()
}

/**
 * In a test run the official default index (always fetched as an authority) is not requested: a spec
 * must not reach the network, and a blackholed one would stall every Refresh for the 15 s timeout.
 */
function testFetcher(inner: IndexFetcher, testRun: boolean): IndexFetcher {
  if (!testRun) return inner
  return (url) => (url === DEFAULT_MARKETPLACE_URL ? Promise.reject(new Error('not fetched in a test run')) : inner(url))
}

function start(): void {
  // Before `ready` (Electron's rule for privileged schemes): html overlay pages (cc-overlay:),
  // plugin panel files (cc-plugin:) and webview panels' local files (cc-preview:), in the one call
  // Electron allows.
  registerAppSchemes()
  // Linux desktops Electron does not recognise (Hyprland, sway ...): safeStorage falls back to
  // `basic_text` and secrets are refused although a Secret Service keyring is running. Chromium reads
  // this switch at `ready`, so it goes before selectSecretStore and app.whenReady
  // (secrets/password-store.ts decides: only on an unrecognised desktop with a confirmed Secret
  // Service owner, never over an explicit --password-store).
  const passwordStore = choosePasswordStore({
    platform: process.platform,
    argv: process.argv,
    env: process.env,
    isPackaged: app.isPackaged,
    run: execRunner
  })
  if (passwordStore !== null) app.commandLine.appendSwitch('password-store', passwordStore)
  // ctx.secrets (plugin-secrets.ts, `<data>/secrets.json`): encrypted through the OS keychain
  // (safeStorage), or the marked fake store in an unpackaged test run only (secret-store.ts).
  // Built before `ready` on purpose: availability is asked at each use, never here. First, because
  // the registry (forget drops secret project settings) and the installer (uninstall drops the
  // plugin's secrets) both clean up in it.
  const secretStore = selectSecretStore(process.env, app.isPackaged, () => safeStorageSecretStore(safeStorage))
  const pluginSecrets = new PluginSecrets({ dataDir, store: secretStore, log: (m) => console.warn(m) })
  // ctx.oauth (plugin-oauth.ts). A lambda, not `shell.openExternal` itself: looked up at each
  // sign-in, so the e2e's recorder that replaces it after launch is what runs (no real browser).
  const pluginOAuth = new PluginOAuth({ openExternal: (url) => shell.openExternal(url), log: (m) => console.warn(m) })
  const registry = new ProjectRegistry({ dataDir, onForget: (id) => pluginSecrets.forgetProject(id) })
  // One-time data migration, before any plugin host reads its settings: the core "changed files
  // shown" setting became cockpit.sessions' own app setting (settings/sessions-migration.ts).
  if (needsSessionFilesMigration(registry.app.data)) registry.app.update(migrateSessionFilesShown)
  const paths = dataPaths(dataDir)
  // Test hooks and recorded notifications exist only in an unpackaged test run, like the fake
  // secret store (secrets/secret-store.ts): a shipped app never takes a test-only path, whatever its
  // environment says (the test-hooks chunk is still in app.asar, but nothing loads it).
  const testRun = isTestRun(process.env, app.isPackaged)
  // hooks.json and bin/ccc are rebuilt at every start (their paths change between dev and a
  // packaged build) and must exist before the first Claude tab can spawn: `claude --settings
  // <hooks.json>` names the wrapper. start() runs before `ready`, so no tab exists yet. A failure
  // here (read-only data dir) is logged and the app runs on: shell tabs do not need either file.
  try {
    // main is bundled to out/main/index.js, the CLI to out/cli/index.js (electron.vite.config.ts);
    // packaged, both sit in resources/app.asar (electron-builder.yml).
    writeCccWrapper(
      paths.cccWrapper,
      resolveWrapperTargets({
        isPackaged: app.isPackaged,
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        mainDir: __dirname,
        dataDir
      })
    )
    writeHooksFile(paths.hooksJson, paths.cccWrapper)
  } catch (err) {
    console.error('cannot write hooks.json / bin/ccc; Claude tabs will not report their status', err)
  }
  // `<data>/claude-plugins/` (the cc-cockpit skill every Claude tab loads with --plugin-dir, plus
  // one child per skill-bearing plugin), rebuilt at every start like hooks.json. build() never
  // throws: a failure is logged and the tabs start without the skill. The first build runs once
  // the installed plugins have loaded (`pluginsLoaded` below), so it already holds their skills;
  // tabs that spawn Claude wait for `claudePlugins.ready` (spawnReady below), so a restored tab
  // does not start before that. `plugins` and `registry` are read at build/spawn time only.
  // The plugin ids on for a project: its `enabledPlugins` plus the default-on bundled ones it has
  // not switched off (enablement.ts). Every "is this plugin on here" question goes through this, so
  // a bundled plugin and an installed one are never treated differently by accident. `plugins` is
  // read at call time only. A bundled plugin switched off in all projects (app.json
  // `disabledBundled`) is left out whatever the project record says.
  const enabledIds = (projectId: string): string[] =>
    enabledPluginIds(registry.get(projectId), plugins.list(), registry.app.data.disabledBundled)
  const skillPlugins = (): SkillSource[] =>
    plugins.list().flatMap((p): SkillSource[] => {
      const skills = p.manifest?.contributes?.skills ?? []
      return p.manifest && p.state.ok && p.dir !== '' && skills.length > 0
        ? [{ id: p.id, version: p.version, dir: p.dir, ...(p.commit !== undefined ? { commit: p.commit } : {}), skills }]
        : []
    })
  const claudePlugins: ClaudePlugins = new ClaudePlugins({
    dir: paths.claudePluginsDir,
    version: app.getVersion(),
    skillPlugins,
    enabledPlugins: enabledIds
  })
  // When the tree is rebuilt: first after the plugins load, then on installer changes and on dev
  // reloads that touch a plugin with skills (ClaudePluginsBuilds says why each is gated). It is
  // given the same listing the build reads, so it knows which set the tree holds.
  const claudePluginsBuilds = new ClaudePluginsBuilds(
    () => claudePlugins.build(),
    () => skillPlugins().map((p) => p.id)
  )
  // Until the login shell has been asked, tabs would start with the GUI app's minimal env.
  // Windows open right away (the capture can take seconds with a heavy rc file), so the spawn
  // path waits for it instead: tabs.create / tabs.restart await `spawnReady` (below). A second
  // instance or macOS `activate` can open a window before the capture finishes.
  let loginEnv: Env = process.env
  const loginEnvReady: Promise<void> = loadLoginEnv(process.env).then((env) => {
    loginEnv = env
  })
  // What a tab spawn waits for: the login env, and the generated Claude plugin tree (a Claude tab
  // reads its --plugin-dir list at spawn and keeps it for the whole session).
  const spawnReady: Promise<void> = Promise.all([loginEnvReady, claudePlugins.ready]).then(() => undefined)
  // App-wide: one theme for every window. The OS appearance only matters until the user picks one.
  const themes = new ThemeService({
    settings: {
      get data() {
        return registry.app.data
      },
      save: () => registry.app.save()
    },
    isDark: () => nativeTheme.shouldUseDarkColors,
    onChange: (theme) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('theme.changed', theme)
      }
    }
  })
  nativeTheme.on('updated', () => themes.refresh())
  // Installed plugins: their themes register now; the user's active plugin theme comes back as
  // soon as load() finishes (until then the OS-matching built-in shows). Install/update/uninstall
  // get their UI in the settings screen. An update or uninstall restarts every plugin host running that plugin
  // before the old folder goes (`hosts` is defined below; nothing installs before a window opens).
  const pluginIndex = new PluginIndex({ filePath: paths.pluginsJson })
  // Bundled plugins (plugins/<name> in dev, resources/plugins packaged): indexed at every start from
  // a fixed allowlist, never copied. CC_COCKPIT_NO_BUNDLED=1 turns them off, only with CC_COCKPIT_TEST=1 unpackaged (isTestRun).
  // The repo root comes from this file (out/main/index.js), not app.getAppPath(): launched as
  // `electron out/main/index.js` (the e2e way) that is out/main and `plugins/` would not be found.
  const bundledDir = bundledRoot(app.isPackaged, join(__dirname, '..', '..'), process.resourcesPath)
  // Marketplace indexes: the cache is read now, synchronously and before plugins.load(), so
  // revocations apply before anything activates; the network refresh runs in the background, and
  // whatever it brings is applied after the plugins have loaded (the installer's queue).
  const marketplace = new MarketplaceService({
    dataDir,
    urls: () => marketplaceUrls(registry.app.data.marketplaces, process.env, app.isPackaged),
    fetcher: testFetcher(createIndexFetcher(), testRun),
    // From the index, not the installer: loadCache below asks before the installer exists.
    authorities: () => pluginIndex.list().flatMap((p) => (p.marketplace !== undefined ? [p.marketplace] : [])),
    log: (m) => console.warn(m),
    onRefreshed: () => void plugins.applyRevocations().catch((err: unknown) => console.error('applying revocations failed', err))
  })
  marketplace.loadCache()
  const plugins = new PluginInstaller({
    dataDir,
    bundled: bundledPluginSpecs(bundledDir, process.env, app.isPackaged),
    index: pluginIndex,
    themes,
    env: async () => {
      await loginEnvReady
      return loginEnv
    },
    reloadHosts: (id) => hosts.reloadPlugin(id),
    beforeLink: (id) => registry.forgetPluginRepo(id),
    secrets: pluginSecrets,
    revocation: (plugin) => marketplace.revocationFor(plugin),
    // A plugin revoked at load is seen before `ready`, when a Notification cannot be shown yet.
    onRevoked: (revoked) =>
      void app.whenReady().then(() => showNotification(revocationNotice(revoked))),
    // The linked folders to watch follow the plugin set (`devWatch` is defined below; the
    // installer calls this only after load() has started, i.e. after start() has run through).
    // The generated Claude plugin tree too: an installed or linked plugin's skills are copied, an
    // uninstalled one's removed, before the install call resolves (a tab opened next has them).
    onChange: () => {
      devWatch.sync()
      claudePluginsBuilds.changed()
    }
  })
  // Plugin hosts wait for this: before it, every plugin looks uninstalled.
  const pluginsLoaded: Promise<void> = plugins.load().catch((err: unknown) => console.error('loading plugins failed', err))
  void pluginsLoaded.then(() => claudePluginsBuilds.start())
  void marketplace.refresh()
  marketplace.startPeriodicRefresh()
  const commands = new CommandRegistry(
    process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
    () => registry.app.data.keyOverrides,
    // The new-tab menu entries as key-table commands, straight from the stores rather than through
    // TabCommandsService.list: that throws for a project with no record, and the table is also
    // asked for '' (AppMenu with the picker or nothing focused), where the app-wide ones still count.
    (projectId) => ({
      app: tabCommandsOf(registry.app.data.tabCommands),
      project: tabCommandsOf(registry.get(projectId)?.tabCommands)
    })
  )
  // Set on before-quit: from then on closing windows is not the user ending their tabs.
  let quitting = false
  const windows = new WindowManager({
    factory: new ElectronWindowFactory(),
    registry,
    platform: process.platform,
    quit: () => app.quit(),
    // The window's plugin host (host-manager.ts); `hosts` is defined below, windows open after ready.
    // Runs after startup only (a window event), by which time sendToWindow below exists.
    onFullScreenChanged: (windowId, fullScreen) => sendToWindow(windowId, 'window.state', { fullScreen }),
    // Read at each project window's creation (transparency is creation-only in Electron), straight
    // from app.json with the defaults applied, like the key overrides above.
    projectWindowLook: () => {
      const { transparent, blur } = windowBackgroundOf(registry.app.data.windowBackground)
      return { transparent, blur }
    },
    onProjectOpened: (projectId, windowId) => {
      hosts.open(projectId, windowId).catch((err: unknown) => console.error('plugin host start failed', err))
      // The first Claude tab (first-tab.ts) is for a window with nothing to bring back. Launch
      // queues the restore plan before opening the window, so hasPending is already accurate. The
      // saved record counts too: a project whose folder was missing at launch keeps its tabs (and
      // their Claude session ids) in the record, and opening it later starts it empty; a tab
      // started on its own would rewrite that record (tabsChanged) and drop them unasked.
      const saved = registry.get(projectId)
      firstTab.arm(
        projectId,
        windowId,
        restorer.hasPending(projectId) || (saved !== undefined && buildRestorePlan(saved).length > 0)
      )
    },
    onProjectClosed: (projectId, windowId, reopening) => {
      // A reopen (window.reopen: Settings › Window's "Reopen window") closes the window to make it
      // again from the current settings. Its tabs come back in the new one as after a restart, so
      // they are saved and queued here, while still live and before tabs.closeProject kills them;
      // WindowManager opens the new window right after this returns, so onProjectOpened below
      // already sees the plan (no first Claude tab), as at launch. The kills that follow never
      // rewrite the record: closeProject drops each tab before terminating it, and an exit of a
      // tab TabManager no longer knows is ignored (no tabsChanged, no close-on-exit).
      if (reopening) restorer.requeue(projectId)
      // Deactivate (5 s cap), then kill. While quitting this is best effort: the app may exit
      // first, so hosts.disposeAll() (will-quit) also kills hosts still deactivating here.
      hosts.close(projectId).catch((err: unknown) => console.error('plugin host stop failed', err))
      // Its secret settings need not stay decrypted while the project is closed (a reopen
      // decrypts them again before the new host starts, hostPlugins).
      pluginSecrets.evictProject(projectId)
      firstTab.disarm(projectId)
      tabs.closeProject(projectId)
      // No window, no selection: a reopened window reports its own once its page loads.
      sessions.setActive(projectId, undefined)
      // The user closed the window: its tabs are over, so is their record. While quitting the
      // same callback runs for every window and the saved tabs are exactly what must stay; on a
      // reopen they were just queued for the new window.
      if (!quitting && !reopening) restorer.clear(projectId)
      commands.closeProject(projectId)
      appMenu.refresh()
      layouts.closeProject(projectId)
      // Every overlay of the window is dismissed (its opener gets that result), its programs
      // killed and its views closed.
      overlays.closeWindow(windowId)
      // Its webview panels' views close too, and their preview tokens stop serving.
      webviews.closeWindow(windowId)
      // A plugin's close waiting on this window's dialog is answered: not closed by it.
      closeAsks.windowClosed(windowId)
    },
    // The folder went missing between the close and the new window (WindowManager logs it): the
    // project is closed after all. Its queued plan goes, as when a launch cannot open a window;
    // the saved record stays, so the tabs come back when the project is opened again (relink
    // drops them, restore.ts says why).
    onReopenFailed: (projectId) => restorer.discard(projectId)
  })
  // File > Open Folder's accelerator follows the focused window's key table (AppMenu says why);
  // refreshed on focus and blur (below), on key overrides (keysChanged), on plugin commands coming
  // and going, and when a project closes. A menu accelerator wins over the renderer, so a stale
  // one would keep a rebound Cmd+O opening the dialog (and the command moved onto it never fire).
  const appMenu = new AppMenu({
    focusedProjectId: (leaving) => {
      const win = BrowserWindow.getFocusedWindow()
      if (!win || win === leaving || win.isDestroyed()) return ''
      const sender = windows.resolveSender(win.webContents.id)
      return sender?.kind === 'project' ? sender.projectId : ''
    },
    view: (projectId) => commands.view(projectId),
    openFolder: () => {
      openFolderDialog(BrowserWindow.getFocusedWindow() ?? undefined).catch((err: unknown) =>
        console.error('open folder failed', err)
      )
    },
    // The focused project window is the caller (a modal parent); none focused (the picker itself,
    // another app): a standalone picker, as at start.
    openProject: () => {
      const win = BrowserWindow.getFocusedWindow()
      const sender = win && !win.isDestroyed() ? windows.resolveSender(win.webContents.id) : undefined
      windows.showPicker(sender?.kind === 'project' ? sender.windowId : undefined)
    }
  })
  // Computed once: the path the server binds and the path exported to tabs (CC_COCKPIT_SOCK)
  // must be the same string, and the CLI recomputes it from the same inputs (paths.ts).
  const uid = process.getuid?.() ?? 'nouid'
  const sock = socketPath(dataDir, process.env, uid, tmpdir())
  /** Send an event to the window that shows a project (none, or one mid-close, is skipped). */
  const sendToProject = (projectId: string, channel: EventChannel, payload: unknown): void => {
    const windowId = windows.windowIdOf(projectId)
    const win = windowId === undefined ? null : BrowserWindow.fromId(windowId)
    // A window mid-close may already be destroyed; its tabs are being killed anyway.
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  /** Send an event to a window by id (a closed or closing one is skipped). */
  const sendToWindow = (windowId: number, channel: EventChannel, payload: unknown): void => {
    const win = BrowserWindow.fromId(windowId)
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  // ctx.sessions.close's asks to a window's tab pane (close-asks.ts): settled by that window's
  // `sessions.closeAnswer`, or false when it closes or the wait runs out.
  const closeAsks = new CloseAsks((windowId, ask) => {
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) return false
    win.webContents.send('sessions.closeAsk', ask)
    return true
  })
  // ctx.sessions.close's body (HostApi checked the tab is the project's); a function so the test
  // hook `pluginCloseTab` runs the very same path.
  const closeTabForPlugin = (windowId: number, projectId: string, tabId: string): Promise<boolean> => {
    const tab = tabs.list(projectId).find((t) => t.id === tabId)
    if (!tab) return Promise.resolve(false)
    if (closeWillAsk(tab, appearance.confirmTabClose())) windows.focusProject(projectId)
    return closeAsks.ask(windowId, tabId)
  }
  /** The command a chord fires in a project window (main's registry, the user's overrides applied). */
  const commandForChord = (windowId: number, chord: string): string | undefined => {
    const projectId = windows.projectWindows().find((w) => w.windowId === windowId)?.projectId
    if (projectId === undefined) return undefined
    return commands.view(projectId).commands.find((c) => c.key === chord)?.id
  }
  // The overlay stack of every project window. Terminal overlays get the login env like tabs do,
  // with the overlay's own window token (minted by the manager; never a session token: an
  // overlay's program is not a Claude tab) and the socket while main listens on it.
  const overlays: OverlayManager = new OverlayManager({
    backend: new NodePtyBackend(),
    views: new ElectronUrlViewFactory(),
    // main's own table, not BrowserWindow.fromId: the picker is a window too, and a closing
    // project window leaves this table before onProjectClosed runs closeWindow.
    isWindowOpen: (windowId) => windows.projectWindows().some((w) => w.windowId === windowId),
    // `socket` is defined below; this runs at spawn time only (as the tabs' sock()).
    env: (token): Record<string, string> =>
      buildPtyEnv(loginEnv, { binDir: paths.binDir, tab: { token, sock: socket.listening ? sock : undefined } }),
    emit: (windowId, channel, payload) => {
      // A webview panel's native view would paint over the overlay (and over a url overlay's own
      // view): the window's views hide while its stack is not empty, before the page draws it.
      if (channel === 'overlays.updated') webviews.setWindowCovered(windowId, (payload as OverlayInfo[]).length > 0)
      sendToWindow(windowId, channel, payload)
    },
    commandForChord,
    // `hosts` is defined below; these run once a typed overlay is open (design-next §3.3).
    typeButtons: (windowId): OverlayTypeButtons | undefined => hosts.overlayButtons(windowId),
    pluginTitle: (pluginId) => plugins.get(pluginId)?.manifest?.name ?? pluginId,
    // Discuss with Claude (design-next §3.5): the window's own project's Claude tabs only, the send
    // gate, and main's own new-tab path (`sessions`, `tabs` are defined below; these run on a click).
    discuss: {
      isClaudeTab: (windowId, tabId) => {
        const projectId = projectOfWindow(windowId)
        const entry = sessions.get(tabId)
        return projectId !== undefined && entry?.projectId === projectId && entry.status !== 'ended'
      },
      send: (tabId, text) => sessions.send(tabId, text),
      openSession: async (windowId, prompt) => {
        const projectId = projectOfWindow(windowId)
        if (projectId === undefined) throw new Error('the window is gone')
        // The ctx.sessions.open prompt rule: control bytes out, capped, no leading / ! # &.
        const tab = await openClaudeTab(projectId, { prompt: prepareText(prompt) }, windowId, false)
        return { tabId: tab.id }
      },
      selectTab: (windowId, tabId) => sendToWindow(windowId, 'tabs.select', { tabId })
    }
  })
  /** The project a project window shows, from main's own table. */
  const projectOfWindow = (windowId: number): string | undefined =>
    windows.projectWindows().find((w) => w.windowId === windowId)?.projectId
  /**
   * After awaiting the login env (seconds at launch), check that the window that asked is still
   * the project's window. Closing it already ran tabs.closeProject, so a tab spawned now would be
   * a terminal process no window shows and nothing closes until quit; a window reopened for the
   * project meanwhile has another id and did not ask for it either.
   */
  const requireWindow = (projectId: string, windowId: number): void => {
    if (windows.windowIdOf(projectId) !== windowId) throw new Error('the project window was closed')
  }
  /**
   * Start a Claude tab main was asked for (a plugin's ctx.sessions.open, Discuss's New session) and
   * tell its window, which did not ask for it. The tab manager realpaths `cwd` inside the project
   * and passes `prompt` as one argv element after `--`. `focus`: select it in the window too.
   */
  const openClaudeTab = async (
    projectId: string,
    options: { cwd?: string; prompt?: string },
    windowId: number,
    focus: boolean
  ): Promise<TabInfo> => {
    await spawnReady
    requireWindow(projectId, windowId)
    const tab = tabs.create(projectId, { kind: 'claude', ...options })
    // The window did not ask for it: tell it, or the tab gets no view and no output acks.
    sendToProject(projectId, 'tabs.added', tab)
    // Sent after `tabs.added` on the same webContents, so the page already has the tab when it
    // selects it.
    if (focus) sendToProject(projectId, 'tabs.select', { tabId: tab.id })
    return tab
  }
  /** Open an overlay once the login env is known (a terminal overlay's PATH depends on it). */
  const openOverlay = async (
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel,
    pluginId?: string
  ): Promise<OverlayResult> => {
    await loginEnvReady
    return overlays.open(windowId, spec, opener, peerGone, channel, pluginId)
  }
  // Webview panels (`"kind": "webview"`, ctx.webview): one native view per panel per window, made
  // and judged in main (webview-manager.ts). Local files go through cc-preview://, answered on each
  // webview partition's own session with that session's tokens only (electron-webview.ts).
  // Chords typed into a view never reach the shell page: main resolves them (webviewChord: the
  // overlay keys first, then an app command sent to the owning window's page only, which runs it
  // through its own modal rules, with the keyboard handed back to it).
  // One budget of bodies held in main per session (preview-protocol.ts): a page piling up unread
  // requests gets 503s, other projects' and plugins' pages are not affected. Per partition
  // (project x webview plugin), forgotten when the partition's last view goes (partitionClosed).
  const previewBudgets = new PreviewBudgets()
  const webviews: WebviewManager = new WebviewManager({
    views: new ElectronWebviewFactory((partition, url, method) =>
      servePreviewRequest(url, method, {
        folderOf: (token) => webviews.previewFolder(partition, token),
        budget: previewBudgets.of(partition),
        log: (m) => console.warn(m)
      })
    ),
    partitionClosed: (partition) => previewBudgets.drop(partition),
    // A lambda, as for ctx.oauth: the e2e's recorder replaces shell.openExternal after launch.
    openExternal: (url) => {
      shell.openExternal(url).catch((err: unknown) => console.warn('open external failed', err))
    },
    chord: (windowId, chord) =>
      webviewChord(
        {
          overlayChord: (w, c) => overlays.handleChord(w, c),
          commandFor: (w, c) => commandForChord(w, c),
          shell: (w) => {
            const win = BrowserWindow.fromId(w)
            if (!win || win.isDestroyed()) return undefined
            return { focus: () => win.webContents.focus(), trigger: (id) => sendToWindow(w, 'commands.trigger', { id }) }
          }
        },
        windowId,
        chord
      ),
    // A hidden view must not keep the keyboard: the shell page takes it back. Only in the focused
    // window (the manager asks isWindowFocused first): on macOS webContents.focus() also brings
    // its window to the front, over the project the user is typing in (checked at runtime).
    focusShell: (windowId) => {
      const win = BrowserWindow.fromId(windowId)
      if (win && !win.isDestroyed()) win.webContents.focus()
    },
    isWindowFocused: (windowId) => {
      const win = BrowserWindow.fromId(windowId)
      return win !== null && !win.isDestroyed() && win.isFocused()
    },
    // The panel's toolbar follows the page (coalesced in the manager like onNavigate).
    pageChanged: (owner, page) =>
      sendToWindow(owner.windowId, 'webviews.navigated', { panelKey: `${owner.pluginId}/${owner.panelId}`, ...page }),
    isWindowOpen: (windowId) => windows.projectWindows().some((w) => w.windowId === windowId),
    homeDir: () => homedir(),
    log: (m) => console.warn(m)
  })
  // Keys typed into a window's own page can come from an html overlay's iframe, which the shell
  // UI's key handler never sees (a sandboxed frame's events stay in the frame). So main resolves
  // the overlay keys of a window that shows an overlay before the page gets them; Esc over a
  // terminal overlay is not taken (pop refuses) and reaches the program. Url views have their
  // own listener (electron-url-view.ts).
  // Every WebContents the app ever makes: Web Bluetooth's chooser is a WebContents event (without
  // a listener Electron picks the first device for the page), and a WebContents in any session but
  // the default one (today the url overlays' partitions, which electron-url-view.ts already locks
  // down) is denied everything, so a session added later cannot fall back to Electron's grant-all.
  // Only after ready (no WebContents exists before), when session.defaultSession is safe to read.
  app.on('web-contents-created', (_event, wc) => {
    lockDownWebContents(wc)
    if (wc.session !== session.defaultSession) lockDownSession(wc.session, NO_APP_PAGE)
  })
  app.on('browser-window-created', (_event, win) => {
    const windowId = win.id
    win.webContents.on('before-input-event', (event, input) => {
      if (overlays.topKind(windowId) === undefined) return
      if (overlays.handleChord(windowId, chordOfInput(input))) event.preventDefault()
    })
    // The shell page (re)loaded: the placeholders its webview panels reported are gone with it.
    win.webContents.on('did-navigate', () => webviews.resetWindow(windowId))
  })

  // Zone layout: the project's stored layout reconciled with the panels that exist (core ones now,
  // plugin ones from Task 25). Changes reach the project's window as `layout.updated`.
  const layouts: LayoutService = new LayoutService({
    getLayout: (projectId) => registry.get(projectId)?.layout,
    setLayout: (projectId, next) => registry.setLayout(projectId, next),
    publish: (projectId, view) => sendToProject(projectId, 'layout.updated', view),
    enabledPlugins: enabledIds,
    // Slots (design-next §2): who draws a type is the project's pick among the plugins its host
    // runs now; a frame that goes is closed in its provider's host; a placement over the frame cap
    // is a line in the host plugin's own log. Functions: `hosts`, `panelPorts` and `pluginLogs`
    // are defined below, and these run only once a window has a layout.
    slotProvider: (projectId, type): SlotProviderInfo | undefined => hosts.slotProvider(projectId, type),
    framesChanged: (projectId, ids) => panelPorts.slotFramesChanged(projectId, ids),
    slotLog: (projectId, pluginId, text) => {
      console.warn(`plugin ${pluginId} (${projectId}) warn: ${text}`)
      pluginLogs.write({ pluginId, projectId, level: 'warn', text })
    }
  })
  /**
   * The project's enabled plugins that loaded and validated. Ids come from main's own project
   * record and the plugin index; the paths a host gets are the installer's, never a plugin's.
   */
  const hostSourceOf = (projectId: string, id: string): HostPluginSource | undefined =>
    hostPluginSource(plugins.get(id), enabledIds(projectId).includes(id))
  const hostPlugins = async (projectId: string): Promise<HostPlugin[]> => {
    // Taken before the wait: a window closed while the plugin index loads has evicted its cache
    // already, and the loadSettings below must not fill it again (no host starts to evict it).
    const evictionMark = pluginSecrets.evictionMark(projectId)
    await pluginsLoaded
    const out: HostPlugin[] = []
    for (const id of enabledIds(projectId)) {
      const plugin = plugins.get(id)
      const source = hostSourceOf(projectId, id)
      if (!plugin?.manifest || !source) continue
      out.push({
        id,
        ...source,
        ...(plugin.manifest.main ? { main: plugin.manifest.main } : {}),
        commands: (plugin.manifest.contributes?.commands ?? []).map((c) => ({
          id: c.id,
          title: c.title,
          ...(c.key !== undefined ? { key: c.key } : {})
        })),
        cli: plugin.manifest.contributes?.cli ?? [],
        ...(plugin.manifest.services !== undefined ? { services: plugin.manifest.services } : {}),
        ...(plugin.manifest.contributes?.openFile !== undefined ? { openFile: { title: plugin.manifest.contributes.openFile.title } } : {}),
        ...(plugin.manifest.contributes?.slots !== undefined ? { slots: plugin.manifest.contributes.slots } : {}),
        ...(plugin.manifest.contributes?.settings?.page !== undefined ? { settingsPage: plugin.manifest.contributes.settings.page } : {}),
        ...(plugin.manifest.access !== undefined ? { access: plugin.manifest.access } : {}),
        // The icon is a plugin file (validate.ts checked it is inside the folder); the strip loads
        // it from cc-plugin:// like the panel page.
        panels: (plugin.manifest.contributes?.panels ?? []).map((p) => ({
          id: p.id,
          title: p.title,
          defaultZone: p.defaultZone ?? 'left',
          ...(p.entry !== undefined ? { entry: p.entry } : {}),
          ...(p.kind !== undefined ? { kind: p.kind } : {}),
          ...(p.icon !== undefined ? { icon: p.icon } : {}),
          ...(p.slots !== undefined ? { slots: p.slots } : {})
        }))
      })
    }
    // Secret settings fields reach the host in plaintext through the synchronous settings read
    // below; decrypting is async, so it happens here, awaited by every launch and dev reload
    // before they build a spec (HostManager reads `plugins` first). Already-cached values cost
    // nothing; one that will not decrypt is logged and left out (plugin-secrets.ts loadSettings).
    await Promise.all(out.map((p) => pluginSecrets.loadSettings(p.id, projectId, evictionMark)))
    return out
  }
  /**
   * A plugin's stored app and project settings against its manifest (also shown in Settings), with
   * its secret fields merged in from the decrypted cache (plugin-settings.ts hostSettingsOf).
   */
  const hostSettingsOf = (projectId: string, pluginId: string): HostSettings => {
    const manifest = plugins.get(pluginId)?.manifest
    if (!manifest) return { ok: false, reason: 'the plugin is not installed' }
    const check = pluginHostSettings(
      manifest,
      { app: registry.app.data.pluginSettings[pluginId], project: registry.get(projectId)?.pluginSettings[pluginId] },
      pluginSecrets,
      projectId
    )
    return check.ok ? { ok: true, project: check.project, app: check.app } : check
  }
  // `ccc notify`, ctx.notify and the revocation notice (notifications/notifier.ts). e2e: recorded
  // instead of put on the developer's screen, and clicked through the test hooks.
  const recordedNotices = testRun ? new RecordingNoticeBackend() : undefined
  const notifier = new Notifier(recordedNotices ?? new ElectronNoticeBackend())
  const showNotification = (text: string, title = 'cc-cockpit'): void => notifier.show({ title, body: text })
  /** Windows a chime was sent to and the sound id it rang, oldest first, in a test run only. */
  const chimesRung: { windowId: number; sound: string }[] = []
  // The OS sound folders the "Sound" setting can pick from (system-sounds.ts): fixed per platform,
  // listed again at every pick and every read of a system sound's bytes.
  const systemSounds = new SystemSounds(systemSoundRoots(process.platform, process.env, homedir()))
  // ctx.notify's `sound`: the window's renderer plays it (renderer/notify/chime.ts), gated by the
  // app setting and to one per window per NOTIFY_CHIME_INTERVAL_MS. The window is the host's (main's
  // record), never one a plugin named.
  const chimeEnabled = (): boolean => notificationSoundsOf(registry.app.data.notificationSounds)
  const chimes = new ChimeGate({
    enabled: chimeEnabled,
    ring: (windowId, sound) => {
      if (testRun) chimesRung.push({ windowId, sound })
      // A checked id (NotifySounds); a system one's bytes the page asks for (`notify.soundData`).
      sendToWindow(windowId, 'notify.chime', { sound })
    }
  })
  // Which sound: the picked one for `sound: true`, a plugin's own id only when the app offers it now.
  const notifySounds = new NotifySounds({
    appSound: () => notificationSoundOf(registry.app.data.notificationSound),
    systemHas: (id) => systemSounds.has(id)
  })
  const pluginLogs = new PluginLogWriter({ dir: paths.logsDir, log: (m) => console.warn(m) })
  // ctx.appStorage (app-storage.ts): one store for the whole app, so the hosts of every window
  // share it and main applies their calls one at a time. Flushed on quit (will-quit).
  const appStorage = new AppStorage({ dataDir, log: (m) => console.warn(m) })
  // One plugin host (utilityProcess) per project window.
  const hosts = new HostManager({
    factory: new ElectronHostProcessFactory(),
    plugins: hostPlugins,
    env: async () => {
      await loginEnvReady
      return loginEnv
    },
    projectPath: (projectId) => registry.get(projectId)?.path,
    projectName: (projectId) => registry.get(projectId)?.name,
    layouts,
    pluginDataDir: (projectId, pluginId) => pluginDataDir(dataDir, projectId, pluginId),
    pluginAppDataDir: (pluginId) => pluginAppDataDir(dataDir, pluginId),
    // The stored values (app.json, the project's record) against the manifest's schemas; a failure
    // disables the plugin for this launch (host-manager.ts).
    settings: (projectId, pluginId) => hostSettingsOf(projectId, pluginId),
    // On hostPlugins' own terms: revoked, replaced or switched off during the wait, no.
    pluginSource: hostSourceOf,
    // The project record's picks, read at each activate (a stale pick counts as none there).
    serviceProviders: (projectId) => registry.serviceProviders(projectId),
    // Every change goes to the project's window too: its key table and palette were read at
    // window open, before any plugin registered a command (`commands.updated`).
    commands: {
      add: (projectId, pluginId, def) => {
        commands.addPluginCommand(projectId, pluginId, def)
        sendToProject(projectId, 'commands.updated', commands.view(projectId))
        appMenu.refresh()
      },
      remove: (projectId, pluginId, id) => {
        commands.removePluginCommand(projectId, pluginId, id)
        sendToProject(projectId, 'commands.updated', commands.view(projectId))
        appMenu.refresh()
      },
      clear: (projectId, pluginId) => {
        commands.unregisterPlugin(projectId, pluginId)
        sendToProject(projectId, 'commands.updated', commands.view(projectId))
        appMenu.refresh()
      }
    },
    // The plugins' panel pages reload and connect to the host that just started (panel-ports.ts).
    onPluginsReady: (projectId, pluginIds) => panelPorts.hostReady(projectId, pluginIds),
    onHostReady: (windowId) => overlays.refreshTypeButtons(windowId),
    // A provider started, reloaded or stopped: the window's slot frames follow (layout-service.ts).
    onSlotsChanged: (projectId) => layouts.refreshSlots(projectId),
    notify: (notice, source, signal) => {
      // Sounds off: not even the folder listing a plugin's system id would cost. The gate reads
      // the setting again at the ring.
      if (notice.sound !== false && chimeEnabled()) {
        void notifySounds.resolve(notice.sound, source.pluginId).then((sound) => chimes.ring(source.windowId, sound))
      }
      const spec = pluginNoticeSpec(notice, `cc-cockpit: ${source.pluginId}`)
      if (!notice.action) notifier.show(spec)
      else return notifier.wait(spec, signal)
    },
    pluginLog: (entry) => pluginLogs.write(entry),
    // ctx.sessions, ctx.badge, ctx.panels.header, ctx.overlay, ctx.secrets, ctx.oauth, ctx.appStorage,
    // ctx.files.open, ctx.openExternal (host-api.ts).
    // Functions, not objects: `sessions` and `tabs` are defined below; these only run once a host exists.
    api: {
      listSessions: (projectId) => sessions.listByProject(projectId),
      session: (tabId) => sessions.get(tabId),
      activeTab: (projectId) => sessions.activeTab(projectId),
      // The send gate, as for every programmatic text (send-gate.ts).
      send: (tabId, text) => sessions.send(tabId, text),
      onSessionsChange: (listener) => sessions.onChange(listener),
      // ctx.sessions scope 'all' (HostApi checks the manifest's `access` declaration first).
      summaries: (projectId) => sessions.summariesFor(projectId),
      // ctx.sessions.focus: any window's Claude tab (the cockpit.sessions strip's click).
      focusTab: (tabId) => focusClaudeTab(tabId),
      // ctx.sessions.close: HostApi checked the tab is this project's. A running tab asks in its
      // window, so that window is raised first when it will (the dialog is the person's, they must
      // see it); an idle tab closes without moving their focus. The renderer decides the rest
      // exactly as for its own × (close-confirm.ts) and answers through CloseAsks.
      closeTab: (windowId, projectId, tabId) => closeTabForPlugin(windowId, projectId, tabId),
      // ctx.sessions.rename: HostApi checked the tab is this project's and the name.
      renameTab: (projectId, tabId, name) => tabs.rename(projectId, tabId, name),
      // ctx.sessions.openFile: a session card's file click (the recorded-file check is routeOpenFile's).
      openSessionFile: (caller, tabId, file) => routeOpenFile(openFileRoute, caller, tabId, file),
      // ctx.sessions.open({ focus: true }): the plugin opened it for a click the person made (a
      // "new session" button), so the window shows it.
      openTab: (projectId, options, windowId, focus) => openClaudeTab(projectId, options, windowId, focus === true),
      setBadge: (projectId, panelKey, badge) => layouts.setBadge(projectId, panelKey, badge),
      setPanelHeader: (projectId, panelKey, header) => layouts.setHeader(projectId, panelKey, header),
      setPanelSlots: (projectId, panelKey, placements) => layouts.setSlots(projectId, panelKey, placements),
      slotAvailable: (projectId, type): boolean => hosts.slotProvider(projectId, type) !== undefined,
      showPanel: (projectId, panelKey) => layouts.show(projectId, panelKey),
      openOverlay,
      postOverlay: (windowId, overlayId, text) => overlays.post(windowId, overlayId, text),
      closeOverlay: (windowId, overlayId) => overlays.close(windowId, overlayId),
      focusOverlay: (windowId, overlayId) => overlays.focus(windowId, overlayId),
      setOverlayButtons: (windowId, overlayId, buttons) => overlays.setButtons(windowId, overlayId, buttons),
      setOverlayDiscuss: (windowId, overlayId, on) => overlays.setDiscussHandler(windowId, overlayId, on),
      refreshOverlayButtons: (windowId) => overlays.refreshTypeButtons(windowId),
      secrets: pluginSecrets,
      oauth: pluginOAuth,
      appStorage,
      webview: webviews,
      // ctx.files.open: the click's route below (defined later; this runs only once a host exists).
      openFile: (caller, path, tabId) => routeProjectFile(openFileRoute, caller, path, tabId),
      // ctx.openExternal: HostApi checked the URL (shared/web-url.ts) and the plugin's budget. A
      // lambda, as for ctx.oauth: the e2e's recorder replaces shell.openExternal after launch.
      openExternal: (url) => shell.openExternal(url)
    }
  })
  // Linked dev plugins: a change in the folder re-validates the manifest and reloads that one plugin
  // inside every open host (dev-watch.ts). Closed on quit (will-quit).
  const devWatch = new DevWatcher({
    linked: () =>
      plugins.list().flatMap((p) => (p.source.kind === 'linked' ? [{ id: p.id, dir: p.source.path }] : [])),
    // A dev reload can change a linked plugin's skills (or make it invalid), and through the
    // CLI-name reconciliation demote or recover another plugin: rebuild the Claude plugin children
    // when any of that touches a plugin with skills (ClaudePluginsBuilds.revalidated). Not through
    // the installer's onChange, which would re-sync this watcher from inside its own callback. An
    // invalid plugin has no manifest in the list, so it drops out of the skill plugins.
    revalidate: (id) => claudePluginsBuilds.revalidated(id, () => plugins.revalidate(id)),
    reload: (id, problem) => hosts.devReload(id, problem),
    watch: createFolderWatcher(),
    log: (m) => console.warn(m)
  })
  // Panel MessagePorts: one channel per panel page, host end to the project's host (tagged from
  // main's records), renderer end to the window that asked. Electron's MessageChannelMain is only
  // touched here; the hub is plain code (panel-ports.ts).
  const panelPorts = new PanelPortHub<Electron.MessagePortMain>({
    createChannel: () => {
      const { port1, port2 } = new MessageChannelMain()
      return { host: port1, renderer: port2 }
    },
    runningPanels: (projectId, pluginId) => hosts.runningPanels(projectId, pluginId),
    toHost: (projectId, pluginId, panelId, port) => hosts.sendPanelPort(projectId, pluginId, panelId, port),
    toRenderer: (windowId, payload, port) => {
      const win = BrowserWindow.fromId(windowId)
      if (!win || win.isDestroyed()) throw new Error('the window is gone')
      win.webContents.postMessage(PANEL_PORT_CHANNEL, payload, [port])
    },
    reload: (projectId, pluginIds) => sendToProject(projectId, 'panels.reload', { pluginIds }),
    close: (port) => port.close(),
    // Slot frames: looked up in the layout's own records, the port to the provider's host only.
    slotFrame: (projectId, frameId) => layouts.slotFrame(projectId, frameId),
    slotToHost: (projectId, open, port) => hosts.sendSlotPort(projectId, open, port),
    slotClosed: (projectId, pluginId, frameId) => hosts.closeSlot(projectId, pluginId, frameId),
    // Settings pages (design-next §5.4): the plugin's backend in the sender window's host only.
    settingsPageScopes: (projectId, pluginId) => hosts.runningSettingsPage(projectId, pluginId),
    settingsPageToHost: (projectId, open, port) => hosts.sendSettingsPagePort(projectId, open, port),
    settingsPageClosed: (projectId, pluginId, id) => hosts.closeSettingsPage(projectId, pluginId, id)
  })
  /**
   * The folder `cc-plugin://<pluginId>/` serves from: an installed, valid plugin enabled in at
   * least one open project window. The protocol handler is not told which window asks (see
   * plugin-protocol.ts), so this is as narrow as it can be made.
   */
  const servedPluginDir = (pluginId: string): string | undefined => {
    const enabled = windows
      .projectWindows()
      .some(({ projectId }) => enabledIds(projectId).includes(pluginId))
    const plugin = enabled ? plugins.get(pluginId) : undefined
    return plugin?.manifest && plugin.state.ok && plugin.dir !== '' ? plugin.dir : undefined
  }
  // Claude tab status. Fed by the tab lifecycle below and by the `hook` socket command; its
  // snapshot goes out throttled, and each project window gets ITS OWN view: the strip fields of
  // every tab plus the full entries of its own project's tabs (never another project's prompts,
  // notes, files or queue). A picker window shows no strip and gets nothing.
  const sessions = new SessionRegistry({
    projectName: (projectId) => registry.get(projectId)?.name,
    projectColor: (projectId) => registry.get(projectId)?.color,
    broadcast: (snapshotFor) => {
      for (const { projectId } of windows.projectWindows()) {
        sendToProject(projectId, 'sessions.snapshot', snapshotFor(projectId))
      }
    },
    // The send gate's only way into a terminal (send-gate.ts decides when). Through TabManager
    // with the entry's own project, so the write cannot land in another project's tab; `tabs` is
    // defined below and is only reached once a tab exists.
    write: ({ tabId, projectId }, data) => tabs.input(projectId, tabId, data)
  })
  // The session gist (app setting, off by default): Haiku summarises a tab's last prompts after a
  // turn. The run gets the env a tab gets with no tab variables (no token, no socket), so `claude`
  // resolves on the same PATH as a tab's and nothing it starts can act as a tab (gist-run.ts).
  const sessionGist = new SessionGist({
    enabled: () => sessionGistOf(registry.app.data.sessionGist),
    sessions,
    run: async (prompts, signal) => {
      await loginEnvReady
      return runGist(prompts, signal, {
        env: buildPtyEnv(loginEnv, { binDir: paths.binDir }),
        track: (child) => liveChildren.track(child)
      })
    }
  })
  const tabs = new TabManager({
    backend: new NodePtyBackend(),
    projectPath: (projectId) => registry.get(projectId)?.path,
    loginEnv: () => loginEnv,
    hooksPath: paths.hooksJson,
    pluginDirsFor: (projectId) => claudePlugins.pluginDirsFor(projectId),
    binDir: paths.binDir,
    // Only a path main is listening on reaches a tab (of any kind). When start() refused (a live
    // foreign owner, an unsafe fallback dir), the path may belong to someone else, and the tab's
    // hooks would hand them its token and every prompt. `socket` is defined below; this runs at
    // spawn time only.
    sock: (): string | undefined => (socket.listening ? sock : undefined),
    lifecycle: {
      started: (tab) => sessions.tabStarted(tab),
      // The signal too: a signal death can arrive as code 0 (tabExited maps it to 128 + n).
      exited: (tabId, code, signal) => sessions.tabExited(tabId, code, signal),
      closed: (tabId) => sessions.tabClosed(tabId),
      renamed: (tabId, name) => void sessions.setName(tabId, name),
      output: (tabId, chunk) => sessions.tabOutput(tabId, chunk)
    },
    // Every create / close / reorder / restart / new session id: save the project's tabs.
    onTabsChanged: (projectId) => restorer.tabsChanged(projectId),
    // Read at each exit, so a settings change applies to open tabs. Never while quitting: a tab
    // that ends because the app is going (or just as it goes) must stay in the saved record and
    // come back next launch. restorer.freeze() already keeps the record; this keeps the intent
    // explicit and the tab out of a pointless close.
    // e2e only: the fake shell exits within the real threshold, so the harness shortens it.
    ...(process.env.CC_COCKPIT_TEST === '1' && process.env.CC_COCKPIT_SHELL_MIN_LIFE_MS !== undefined
      ? { shellMinLifeMs: Number(process.env.CC_COCKPIT_SHELL_MIN_LIFE_MS) || 0 }
      : {}),
    closeOnCleanExit: () => !quitting && tabExitOf(registry.app.data.tabExit) === 'close-clean',
    emit: sendToProject
  })
  // Saved tabs follow the live ones (restore.ts); the saves go through the record's debounced
  // writer and registry.flushAll() on quit writes the last ones.
  const restorer = new TabRestorer({
    listTabs: (projectId) => tabs.list(projectId),
    saveTabs: (projectId, records) =>
      registry.update(projectId, (r) => {
        r.tabs = records
      }),
    projectPath: (projectId) => registry.get(projectId)?.path
  })
  // A project window that opens with nothing to restore gets one Claude tab when its renderer
  // first attaches (first-tab.ts; the attach handler below). The setting is read then.
  const firstTab = new FirstTab({
    enabled: () => claudeTabOnOpenOf(registry.app.data.claudeTabOnOpen),
    tabCount: (projectId) => tabs.list(projectId).length,
    windowIdOf: (projectId) => windows.windowIdOf(projectId),
    open: (projectId) => {
      tabs.create(projectId, { kind: 'claude' })
    }
  })

  // Notice-only update check (updates/update-check.ts). A test run never reaches the real network:
  // its fetcher answers only what the `fakeRelease` test hook set, and fails otherwise.
  // Started as `electron out/main/index.js` (e2e), app.getVersion() is Electron's own version and every
  // `ccc` would warn. A checkout has no upgrade to warn about, so it reports what it was built from.
  const appVersion = app.isPackaged ? app.getVersion() : BUILD_VERSION
  let fakeReleaseTag: string | undefined
  // Reads `updateChecker` (declared below): only ever called after it exists (a window event or an IPC call).
  const updateState = (): UpdateState => {
    const release = updateChecker.available()
    return {
      current: appVersion,
      enabled: registry.app.data.updateCheck !== false,
      available: release ? { version: release.version } : null
    }
  }
  // Every window shows the bar, so every window hears (the picker ignores it).
  const broadcastUpdateState = (): void => {
    const state = updateState()
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('updates.changed', state)
    }
  }
  const updateChecker: UpdateChecker = new UpdateChecker({
    current: appVersion,
    fetchRelease: testRun
      ? () =>
          fakeReleaseTag === undefined
            ? Promise.reject(new Error('no network in a test run'))
            : Promise.resolve(JSON.stringify({ tag_name: fakeReleaseTag }))
      : createReleaseFetcher(),
    enabled: () => registry.app.data.updateCheck !== false,
    dismissed: () => registry.app.data.updateDismissed,
    setDismissed: (version) => {
      registry.app.update((a) => {
        a.updateDismissed = version
      })
    },
    onChange: broadcastUpdateState,
    log: (message) => console.warn(message)
  })
  // The CLI socket. Identity comes from main's own tables: a token through the tab manager (a
  // Claude tab's is a session token, a shell or command tab's a window token) and then the
  // overlay manager (a terminal overlay's window token, mapped to the project its window shows),
  // `--project <path>` through the registry (a lookup only, never a new record). Handlers arrive
  // with the commands that use them (hook: Task 14, below; the user commands: Task 21, below).
  const socket = new SocketServer({
    path: sock,
    fallbackDir: fallbackSocketDir(tmpdir(), uid),
    appVersion,
    resolveToken: (token): TokenOwner | undefined => {
      // Both tables are walked whatever the first finds, so the time taken does not say which
      // kind of thing (if any) holds a token close to the guess.
      const tab = tabs.resolveToken(token)
      const overlay = overlays.resolveToken(token)
      if (tab) return tab
      if (!overlay) return undefined
      // main's own window table: an overlay of a window that is closing has no project any more.
      const projectId = windows.projectWindows().find((w) => w.windowId === overlay.windowId)?.projectId
      return projectId === undefined ? undefined : { kind: 'window', projectId }
    },
    resolveProject: (path) => {
      const project = registry.findByPath(path)
      return { path: project?.path ?? realPathOf(path), projectId: project?.id }
    }
  })

  // Hooks come from a Claude tab only (the server and the handler refuse a window token and a
  // --project caller, so a shell tab's `ccc hook` never creates a status entry). Synchronous: see
  // hook-handler.ts.
  // The session id a SessionStart reported (checked by the reducer) is what restart and restore
  // resume, once a prompt makes it resumable (TabManager.sessionStarted / sessionPrompted).
  socket.handle(
    'hook',
    hookHandler({
      applyHook: (tabId, event, payload) => {
        if (!sessions.applyHook(tabId, event, payload)) return false
        const sessionId = sessions.get(tabId)?.sessionId
        if (event === 'SessionStart' && sessionId !== undefined) {
          // `source` tells an interactive `/resume` (a stored conversation, stays resumable) from
          // `/clear` (an empty one); a non-string counts as neither.
          const source = typeof payload === 'object' && payload !== null ? (payload as { source?: unknown }).source : undefined
          tabs.sessionStarted(tabId, sessionId, typeof source === 'string' ? source : undefined)
        }
        if (event === 'UserPromptSubmit') tabs.sessionPrompted(tabId)
        return true
      }
    })
  )

  // open, session note/steps, overlay, sessions, notify (socket/handlers.ts). The server resolved
  // who is asking; these only look things up inside that scope. `openOverlay` waits for the login
  // env like the other overlay openers.
  registerCliHandlers(socket, {
    openPath: (path) => {
      windows.openPath(path)
    },
    notify: (text) => showNotification(text),
    sessions,
    project: (projectId) => {
      const project = registry.get(projectId)
      return project && { name: project.name, path: project.path }
    },
    windowIdOf: (projectId) => windows.windowIdOf(projectId),
    openOverlay
  })

  // `ccc <plugin command> …` (plan B Task 5). The owner comes from the installer's index: only a
  // valid plugin counts, and the clash rules (installer.ts) leave at most one valid owner per name.
  // Enabled means in the project's own record; the host manager checks the plugin runs there.
  const validPlugins = (): InstalledPlugin[] => plugins.list().filter((p) => p.state.ok && p.manifest !== undefined && p.dir !== '')
  registerPluginCliHandlers(socket, {
    cliContributions: () => validPlugins().flatMap((p) => (p.manifest?.contributes?.cli ?? []).map((cli) => ({ pluginId: p.id, cli }))),
    enabledIn: (projectId, pluginId) => enabledIds(projectId).includes(pluginId),
    windowIdOf: (projectId) => windows.windowIdOf(projectId),
    runCli: (projectId, pluginId, call, peerGone) => hosts.runCli(projectId, pluginId, call, peerGone)
  })

  // `ccc plugin link|unlink|list` (plan B Task 6). Linking asks a person in the caller's window
  // (see plugins/link-request.ts for why, plugins/link-dialog.ts for the dialog); in a test run
  // the dialog is replaced by QueuedLinkConfirm, driven by the `answerLink` and `linkDialogs` hooks.
  const testLinkConfirm = testRun ? new QueuedLinkConfirm() : undefined
  registerPluginDevHandlers(socket, {
    windowIdOf: (projectId) => windows.windowIdOf(projectId),
    inspectLink: (path) => plugins.inspectLink(path),
    confirmLink:
      testLinkConfirm?.confirm ??
      electronConfirmLink({
        windowOf: (windowId) => BrowserWindow.fromId(windowId) ?? undefined,
        showMessageBox: (parent, options) => dialog.showMessageBox(parent, options)
      }),
    linkAndEnable: async (projectId, info) => {
      // keepLinked: linked by now (Settings, another window, while the dialog was open) is fine,
      // the person allowed exactly that folder; unlinked meanwhile links it again.
      await plugins.link(info.dir, info.id, { keepLinked: true })
      await projectSettings.setEnabled(projectId, info.id, true)
    },
    unlink: async (id) => {
      const plugin = plugins.get(id)
      if (!plugin) throw new Error(`${id} is not installed`)
      if (plugin.source.kind !== 'linked') throw new Error(`${id} is not a linked plugin; manage it in Settings > Plugins`)
      await plugins.uninstall(id)
    },
    list: (projectId) => {
      const enabled = new Set(enabledIds(projectId))
      return plugins.list().map((p) => ({
        id: p.id,
        ...(p.manifest !== undefined ? { name: p.manifest.name } : {}),
        version: p.version,
        source: p.source.kind,
        enabled: enabled.has(p.id),
        state: p.state.ok ? 'ok' : p.state.reason
      }))
    }
  })

  // `ccc panel show` (friction round 1, Task 7): LayoutService.show, what ctx.panels.show calls.
  registerPanelShowHandler(socket, {
    pluginKnown: (pluginId) => validPlugins().some((p) => p.id === pluginId),
    enabledIn: (projectId, pluginId) => enabledIds(projectId).includes(pluginId),
    windowIdOf: (projectId) => windows.windowIdOf(projectId),
    showPanel: (projectId, panelKey) => layouts.show(projectId, panelKey)
  })

  // `ccc plugin config` (friction round 1, Task 6): the Settings pages' own views and saves (both
  // services are built below; a socket request is only handled once start() has run to its end).
  const pluginConfigDeps: PluginConfigDeps = {
    appSettings: (pluginId) => settings.pluginAppSettings(pluginId),
    projectSettings: (projectId, pluginId) => projectSettings.pluginProjectSettings(projectId, pluginId),
    saveApp: (pluginId, values) => settings.savePluginSettings(pluginId, values),
    saveProject: (projectId, pluginId, values) => projectSettings.saveSettings(projectId, pluginId, values)
  }
  registerPluginConfigHandler(socket, {
    view: (projectId, pluginId) => pluginConfigView(pluginConfigDeps, projectId, pluginId),
    set: (projectId, pluginId, edits, scope) => setPluginConfig(pluginConfigDeps, projectId, pluginId, edits, scope)
  })

  /** Open a folder named on a command line; false when the argv names none (or it failed). */
  const openFromArgv = (argv: readonly string[], cwd: string): boolean => {
    const path = projectPathFromArgv(argv, cwd, process.defaultApp === true)
    if (!path) return false
    try {
      windows.openPath(path)
      return true
    } catch (err) {
      console.error(`cannot open ${path}`, err)
      return false
    }
  }

  /** Native folder dialog (a sheet on the asking window when there is one), then open it. */
  const openFolderDialog = async (parent: BrowserWindow | undefined): Promise<boolean> => {
    const options: OpenDialogOptions = {
      title: 'Open Folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return false
    try {
      windows.openPath(path)
      return true
    } catch (err) {
      dialog.showErrorBox('Cannot open folder', errorText(err))
      return false
    }
  }

  const isAppPage = appPageMatcher(rendererLocation())
  const router = new IpcRouter(
    ipcMain,
    (senderId) => windows.resolveSender(senderId),
    isAppPage
  )

  registerCoreHandlers(router, {
    getProject: (id) => registry.get(id),
    recentProjects: () => registry.recent(),
    openFolderDialog: (windowId) => openFolderDialog(BrowserWindow.fromId(windowId) ?? undefined),
    openRecent: (id) => {
      windows.openRecent(id)
    },
    showPicker: (callerWindowId) => windows.showPicker(callerWindowId),
    isFullScreen: (windowId) => windows.isFullScreen(windowId),
    isTransparent: (windowId) => windows.isTransparent(windowId),
    reopenWindow: (projectId) => windows.reopen(projectId),
    pickerModal: () => windows.pickerModal,
    dismissPicker: () => windows.dismissPicker(),
    // Real path: project paths are stored resolved, so a symlinked home (or macOS /var ->
    // /private/var in a test HOME) would otherwise never prefix them and no row would show `~`.
    homeDir: () => {
      try {
        return realpathSync(homedir())
      } catch {
        return homedir()
      }
    },
    // '' is the table AppMenu resolves while the picker is focused, so the hint is that accelerator.
    pickerOpenFolderKey: () => openFolderKey(commands.view('')),
    // Picker buttons for a project whose folder is gone (restore.ts checks it really is).
    relink: async (windowId, id) => {
      const options: OpenDialogOptions = {
        title: 'Choose the new folder',
        properties: ['openDirectory']
      }
      const parent = BrowserWindow.fromId(windowId) ?? undefined
      const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      const path = result.filePaths[0]
      if (result.canceled || !path) return false
      try {
        windows.openPath(relinkMissing(registry, id, path).path)
        return true
      } catch (err) {
        dialog.showErrorBox('Cannot relink', errorText(err))
        return false
      }
    },
    forget: (id) => forgetMissing(registry, id),
    // The router already checked the scheme (webUrlOf); main is the only place a link leaves the app.
    openExternal: (url) => shell.openExternal(url),
    currentTheme: () => themes.current(),
    // `appearance` is built below; start() runs to its end before any IPC message is handled.
    shellPrefs: () => appearance.prefs(),
    commands: (projectId) => commands.view(projectId),
    runCommand: (projectId, id) => hosts.runCommand(projectId, id)
  })

  // Settings overlay (design §6; settings-service.ts): projects and plugins. The data is
  // app-wide, so any project window may use it; the handlers resolve the sender's window first.
  /** Native folder dialog as a sheet on the asking window; the choice, or undefined if cancelled. */
  const pickFolder = async (windowId: number, title: string): Promise<string | undefined> => {
    const options: OpenDialogOptions = { title, properties: ['openDirectory'] }
    const parent = BrowserWindow.fromId(windowId) ?? undefined
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    return result.canceled || !path ? undefined : path
  }
  const settings = new SettingsService({
    projects: registry,
    hasWindow: (projectId) => windows.windowIdOf(projectId) !== undefined,
    openProjectPath: (path) => {
      windows.openPath(path)
    },
    pickFolder,
    plugins,
    marketplace,
    setMarketplaceUrls: (urls) => {
      registry.app.update((a) => {
        a.marketplaces = urls
      })
    },
    pluginRepos: {
      get: (pluginId) => {
        const all: unknown = registry.app.data.pluginRepos
        const v = isPlainObject(all) && Object.hasOwn(all, pluginId) ? all[pluginId] : undefined
        return typeof v === 'string' ? v : undefined
      },
      set: (pluginId, repo) => registry.rememberPluginRepo(pluginId, repo)
    },
    disableEverywhere: (pluginId) => registry.disablePluginEverywhere(pluginId),
    enabledInAProject: (pluginId) => registry.pluginMayBeEnabled(pluginId),
    appPluginSettings: {
      get: (pluginId) => {
        const all: unknown = registry.app.data.pluginSettings
        return isPlainObject(all) && Object.hasOwn(all, pluginId) ? all[pluginId] : undefined
      },
      set: (pluginId, value) => {
        registry.app.update((a) => {
          // app.json is user-writable: a damaged top level is replaced rather than written into.
          if (!isPlainObject(a.pluginSettings)) {
            a.pluginSettings = {}
          }
          a.pluginSettings[pluginId] = value
        })
      }
    },
    bundledOff: {
      get: () => registry.app.data.disabledBundled,
      set: (ids) => {
        registry.app.update((a) => {
          if (ids.length > 0) a.disabledBundled = ids
          else delete a.disabledBundled
        })
      }
    },
    // Only the projects whose own switch has it on see a change (enabledIds already reads the new
    // list); their hosts restart as on a This project toggle. Every open window's settings page
    // reads the views again on its next load.
    bundledOffChanged: async (pluginId) => {
      const plugin = plugins.get(pluginId)
      if (!plugin) return
      for (const { projectId } of windows.projectWindows()) {
        if (!pluginOnInRecord(registry.get(projectId), plugin)) continue
        await hosts.enabledChanged(projectId).catch((err: unknown) => console.error(`restarting the plugin host of ${projectId} failed`, err))
      }
    },
    // Running plugins get the new values (ctx.onSettingsChange); one disabled for invalid
    // settings starts when they are valid now (HostManager.settingsChanged).
    pluginSettingsChanged: async () => {
      for (const { projectId } of windows.projectWindows()) {
        await hosts.settingsChanged(projectId).catch((err: unknown) => console.error('plugin settings push failed', err))
      }
    },
    secrets: pluginSecrets
  })
  // Plugin services on the Plugins page: status over the set the project's host runs, and the pick.
  const serviceChoices = new ServiceChoices({
    plugins: (projectId) => hosts.servicePlugins(projectId),
    choices: (projectId) => registry.serviceProviders(projectId),
    setChoice: (projectId, service, pluginId) => registry.setServiceProvider(projectId, service, pluginId),
    restart: (projectId) => hosts.restart(projectId),
    slotsChanged: (projectId) => layouts.refreshSlots(projectId)
  })
  registerSettingsHandlers(router, settings)
  registerServiceHandlers(router, serviceChoices)

  // "This project" and "Appearance and keys": per-project plugin set, project settings
  // and panel zones, then the app-wide theme and key overrides. The router hands each handler the
  // asking window's project; nothing else names one.
  const projectSettings = new ProjectSettingsService({
    projects: registry,
    plugins,
    disabledBundled: () => registry.app.data.disabledBundled,
    checkSettings: (projectId, pluginId) => {
      const checked = hostSettingsOf(projectId, pluginId)
      return checked.ok ? { ok: true } : checked
    },
    // The window's host restarts with the new set; its panels follow (host-manager declarePanels).
    enabledChanged: (projectId) => hosts.enabledChanged(projectId),
    settingsChanged: (projectId, pluginId) => hosts.settingsChanged(projectId, pluginId),
    layouts,
    secrets: pluginSecrets,
    // A project's colour shows in core in two places, each reached its own way: its own window's
    // title bar and top line (`project.updated`, the summary window.info would now give), and an
    // open picker's rows (it reads the list again). Other windows' strip dots are a plugin's
    // (ctx.sessions scope all), which reads the colour again with the next session change.
    colorChanged: (projectId) => {
      const project = registry.get(projectId)
      if (project) sendToProject(projectId, 'project.updated', summary(project))
      const picker = windows.pickerWindowId
      if (picker !== undefined) sendToWindow(picker, 'projects.changed', undefined)
    }
  })
  const appearance = new AppearanceService({
    themes,
    commands,
    platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
    overrides: {
      get: () => registry.app.data.keyOverrides,
      set: (next) => {
        registry.app.update((a) => {
          a.keyOverrides = next
        })
      }
    },
    tabExit: {
      get: () => registry.app.data.tabExit,
      set: (next) => {
        registry.app.update((a) => {
          a.tabExit = next
        })
      }
    },
    claudeTabOnOpen: {
      get: () => registry.app.data.claudeTabOnOpen,
      set: (next) => {
        registry.app.update((a) => {
          a.claudeTabOnOpen = next
        })
      }
    },
    sessionGist: {
      get: () => registry.app.data.sessionGist,
      set: (next) => {
        registry.app.update((a) => {
          a.sessionGist = next
        })
      }
    },
    sessionGistChanged: () => sessionGist.settingChanged(),
    notificationSounds: {
      get: () => registry.app.data.notificationSounds,
      set: (next) => {
        registry.app.update((a) => {
          a.notificationSounds = next
        })
      }
    },
    notificationSound: {
      get: () => registry.app.data.notificationSound,
      set: (next) => {
        registry.app.update((a) => {
          a.notificationSound = next
        })
      },
      systemHas: (id) => systemSounds.has(id)
    },
    confirmTabClose: {
      get: () => registry.app.data.confirmTabClose,
      set: (next) => {
        registry.app.update((a) => {
          a.confirmTabClose = next
        })
      }
    },
    zoneAutoHide: {
      get: () => registry.app.data.zoneAutoHide,
      set: (next) => {
        registry.app.update((a) => {
          a.zoneAutoHide = next
        })
      }
    },
    minTerminalWidth: {
      get: () => registry.app.data.minTerminalWidth,
      set: (next) => {
        registry.app.update((a) => {
          a.minTerminalWidth = next
        })
      }
    },
    tabCloseSide: {
      get: () => registry.app.data.tabCloseSide,
      set: (next) => {
        registry.app.update((a) => {
          a.tabCloseSide = next
        })
      }
    },
    terminalFont: {
      get: () => registry.app.data.terminalFont,
      set: (next) => {
        registry.app.update((a) => {
          if (next === undefined) delete a.terminalFont
          else a.terminalFont = next
        })
      }
    },
    // Like the theme: every window (the picker too; it ignores what it does not draw) gets the new
    // prefs, so the change shows in every open tab strip without a reload.
    prefsChanged: () => {
      const prefs = appearance.prefs()
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('prefs.changed', prefs)
      }
    },
    tabCommands: { get: () => registry.app.data.tabCommands },
    windowBackground: {
      get: () => registry.app.data.windowBackground,
      set: (next) => {
        registry.app.update((a) => {
          a.windowBackground = next
        })
      }
    },
    blurSupport: blurSupport(process.platform),
    blurChanged: (on) => windows.setBlur(on),
    // Every window's key table and palette were read from main earlier: send the new one.
    keysChanged: () => {
      appMenu.refresh()
      for (const { projectId } of windows.projectWindows()) {
        sendToProject(projectId, 'commands.updated', commands.view(projectId))
      }
    }
  })
  // The user's new-tab menu entries, app-wide and per project (tabs/tab-commands.ts). Read from the
  // stores at each use: the [+] menu asks when it opens, `tabs.create` looks an entry up by id, so
  // an edit applies to the next menu without telling any window.
  const tabCommands = new TabCommandsService({
    app: {
      get: () => registry.app.data.tabCommands,
      set: (next) => {
        registry.app.update((a) => {
          a.tabCommands = next
        })
      }
    },
    project: {
      get: (projectId) => {
        const record = registry.get(projectId)
        if (!record) throw new Error('the project record is gone')
        return record.tabCommands
      },
      set: (projectId, next) => {
        registry.update(projectId, (r) => {
          r.tabCommands = next
        })
      }
    }
  })
  // The login env is read when asked: its PATH says whether ~/.local/bin is on the user's terminal
  // PATH. Both handlers wait for the capture first; before it ends (or if it fails) loginEnv is the
  // GUI app's minimal env and the page would show a false "not on your shell's PATH".
  const cccCommand = new CccCommandInstaller({
    home: homedir(),
    wrapperPath: paths.cccWrapper,
    loginPath: () => loginEnv.PATH,
    offerAtStart: () => registry.app.data.cccOffer !== false
  })
  const cccOffer = new CccOffer({
    testRun,
    forcedByTest: process.env.CC_COCKPIT_CCC_OFFER === '1',
    enabled: () => registry.app.data.cccOffer !== false,
    state: () => cccCommand.state()
  })
  registerCccCommandHandlers(router, {
    status: async () => {
      await loginEnvReady
      return cccCommand.view()
    },
    install: async () => {
      await loginEnvReady
      return cccCommand.install()
    },
    setOffer: (value) => {
      registry.app.update((a) => {
        // Stored only as false: an absent key is the default (on), so the file stays as it was.
        if (value) delete a.cccOffer
        else a.cccOffer = false
      })
    },
    offer: async () => {
      if (!cccOffer.claim()) return null
      await loginEnvReady
      return cccCommand.view()
    }
  })
  registerUpdateHandlers(router, {
    state: updateState,
    setEnabled: (value) => {
      registry.app.update((a) => {
        a.updateCheck = value
      })
      // Always one onChange, so the toggles in the other windows follow.
      updateChecker.settingChanged()
    },
    dismiss: (version) => updateChecker.dismiss(version),
    openRelease: () => {
      const a = updateChecker.available()
      if (a) return shell.openExternal(a.url)
    }
  })
  registerProjectSettingsHandlers(router, {
    projectView: (projectId) => projectSettings.view(projectId),
    setPluginEnabled: (projectId, pluginId, enabled) => projectSettings.setEnabled(projectId, pluginId, enabled),
    saveProjectPluginSettings: (projectId, pluginId, values, secrets) =>
      projectSettings.saveSettings(projectId, pluginId, values, secrets),
    movePanel: (projectId, panelKey, zone) => projectSettings.movePanel(projectId, panelKey, zone),
    setProjectColor: (projectId, value) => projectSettings.setColor(projectId, value),
    appearance: (projectId) => appearance.view(projectId),
    setTheme: (id) => appearance.setTheme(id),
    setKey: (projectId, commandId, chord) => appearance.setKey(projectId, commandId, chord),
    setTabExit: (value) => appearance.setTabExit(value),
    setClaudeTabOnOpen: (value) => appearance.setClaudeTabOnOpen(value),
    setSessionGist: (value) => appearance.setSessionGist(value),
    setNotificationSounds: (value) => appearance.setNotificationSounds(value),
    notificationSoundOptions: () => systemSounds.groups(),
    setNotificationSound: (value) => appearance.setNotificationSound(value),
    notificationSoundData: (id) => systemSounds.read(id),
    setZoneAutoHide: (value) => appearance.setZoneAutoHide(value),
    setMinTerminalWidth: (value) => appearance.setMinTerminalWidth(value),
    confirmTabClose: () => appearance.confirmTabClose(),
    setConfirmTabClose: (value) => appearance.setConfirmTabClose(value),
    setTabCloseSide: (value) => appearance.setTabCloseSide(value),
    setTerminalFont: (value) => appearance.setTerminalFont(value),
    setWindowBackground: (value) => appearance.setWindowBackground(value),
    setTabCommands: (projectId, level, entries) => {
      const stored = tabCommands.set(projectId, level, entries)
      // Each entry is a command of the key table (CommandRegistry tabCommandDefs), and the table
      // every window holds was sent before this edit: send it again to the windows that see this
      // level (app-wide: every project window; a project's: its own), so an added entry is
      // bindable and runnable there, a renamed one shows its new title, and a removed one's chord
      // stops firing (its handler goes with it). Its override stays in app.json, unknown and
      // ignored (resolveKeys); not pruned here, since an id from a hand-edited file may be shared
      // by another project's entry. The menu accelerator follows too: an entry may hold Cmd+O.
      if (level === 'app') {
        for (const w of windows.projectWindows()) sendToProject(w.projectId, 'commands.updated', commands.view(w.projectId))
      } else {
        sendToProject(projectId, 'commands.updated', commands.view(projectId))
      }
      appMenu.refresh()
      return stored
    }
  })

  registerPanelHandlers(router, {
    connect: (projectId, windowId, panelKey, nonce) => panelPorts.connect(projectId, windowId, panelKey, nonce),
    restartHost: (projectId) => hosts.restartStopped(projectId),
    panelAction: (projectId, panelKey, actionId) => hosts.panelAction(projectId, panelKey, actionId)
  })
  // A plugin's html settings page (design-next §5.4): shown only when the plugin is enabled in the
  // window's project (there is no backend for it otherwise; the page says so). The URL is the
  // manifest's entry in main's own plugin record, served by cc-plugin:// like a panel's page.
  registerSettingsPageHandlers(router, {
    info: (projectId, pluginId, scope) => {
      const plugin = plugins.get(pluginId)
      const page = plugin?.state.ok ? plugin.manifest?.contributes?.settings?.page : undefined
      if (!page || !page.scopes.includes(scope)) return null
      if (!enabledIds(projectId).includes(pluginId)) return { enabled: false }
      return { enabled: true, src: pluginFileUrl(pluginId, page.entry) }
    },
    connect: (projectId, windowId, pluginId, scope, nonce) => panelPorts.connectSettingsPage(projectId, windowId, pluginId, scope, nonce),
    disconnect: (projectId, pluginId) => panelPorts.disconnectSettingsPage(projectId, pluginId)
  })
  registerSlotHandlers(router, {
    connect: (projectId, windowId, frameId, nonce) => panelPorts.connectSlot(projectId, windowId, frameId, nonce),
    disconnect: (projectId, frameId) => panelPorts.disconnectSlot(projectId, frameId),
    setHeight: (projectId, frameId, height) => layouts.setSlotHeight(projectId, frameId, height)
  })

  // Webview panels' toolbar and placeholder: the panel key is looked up in main's own layout (a
  // webview panel a plugin of the sender's project declares), the view is the sender window's.
  registerWebviewHandlers(router, {
    panel: (projectId, panelKey) => layouts.webviewPanel(projectId, panelKey),
    views: webviews
  })

  registerTabHandlers(router, {
    // The first attach of a restored window starts its saved tabs (restore.ts says why only
    // now); the renderer subscribed to tabs.data before asking, so no early output is lost. Then,
    // once the restore has resolved, a window that opened with nothing to restore gets its first
    // Claude tab (first-tab.ts); the list returned below includes it.
    attach: async (projectId, windowId) => {
      await restorer.restore(projectId, spawnReady, (tab) => {
        tabs.restoreTab(projectId, tab)
      })
      await firstTab.settle(projectId, windowId, spawnReady)
      return tabs.attach(projectId)
    },
    close: (projectId, tabId) => tabs.close(projectId, tabId),
    reorder: (projectId, tabId, toIndex) => tabs.reorder(projectId, tabId, toIndex),
    rename: (projectId, tabId, name) => tabs.rename(projectId, tabId, name),
    // Renderer keystrokes only (the send gate writes through `tabs.input` directly): a key that
    // answers a permission dialog also clears the tab's needs-permission (status-reducer.ts).
    input: (projectId, tabId, data) => {
      tabs.input(projectId, tabId, data)
      sessions.userInput(projectId, tabId, data)
    },
    resize: (projectId, tabId, cols, rows) => tabs.resize(projectId, tabId, cols, rows),
    ack: (projectId, tabId, count) => tabs.ack(projectId, tabId, count),
    // The tab pane's selection, for SessionInfo.active. Only a tab of the sender's project counts:
    // anything else (a tab closed while the message travelled, a foreign id) leaves it as it was.
    select: (projectId, tabId) => {
      if (tabs.list(projectId).some((t) => t.id === tabId)) sessions.setActive(projectId, tabId)
    },
    // With each entry's chord from the project's resolved key table, shown next to its label.
    commands: (projectId) => {
      const keys = new Map(commands.view(projectId).commands.map((c) => [c.id, c.key]))
      return menuWithKeys(tabCommands.menu(projectId), (id) => keys.get(id))
    },
    create: async (projectId, options, windowId) => {
      await spawnReady
      requireWindow(projectId, windowId)
      if (options.kind === 'command') {
        // By id, from main's own settings, looked up after the wait: an entry deleted meanwhile
        // is refused rather than run from a stale menu. The entry also says tab or overlay.
        return openTabCommand(tabCommands.resolve(projectId, options.level, options.entryId), {
          tab: (entry) => tabs.createCommand(projectId, entry),
          // A terminal overlay in the asking window: the command tab's argv, cwd and env (the
          // overlays' env() is buildPtyEnv with a window token, which is what a command tab
          // gets too). Nothing waits for its result and nothing about it is saved or restored; it
          // closes when the program exits or on Cmd+Shift+W / ✕ (OverlayManager logs which).
          // `start` throws a spawn failure here, so the click reports it like a tab's.
          overlay: (entry) => {
            const dir = registry.get(projectId)?.path
            if (!dir) throw new Error('unknown project')
            void overlays.start(windowId, commandOverlaySpec(loginShellOf(loginEnv), entry, dir), 'new-tab menu')
          }
        })
      }
      return tabs.create(projectId, options)
    },
    restart: async (projectId, tabId, windowId) => {
      await spawnReady
      requireWindow(projectId, windowId)
      return tabs.restart(projectId, tabId)
    }
  })

  registerLayoutHandlers(router, {
    view: (projectId) => layouts.view(projectId),
    set: (projectId, next) => layouts.set(projectId, next)
  })

  registerOverlayHandlers(router, {
    list: (windowId) => overlays.list(windowId),
    close: (windowId, overlayId) => overlays.close(windowId, overlayId),
    input: (windowId, overlayId, data) => overlays.input(windowId, overlayId, data),
    resize: (windowId, overlayId, cols, rows) => overlays.resize(windowId, overlayId, cols, rows),
    ack: (windowId, overlayId, count) => overlays.ack(windowId, overlayId, count),
    setBounds: (windowId, overlayId, bounds) => overlays.setBounds(windowId, overlayId, bounds),
    result: (windowId, overlayId, value) => overlays.result(windowId, overlayId, value),
    message: (windowId, overlayId, text) => overlays.pageMessage(windowId, overlayId, text),
    ready: (windowId, overlayId) => overlays.pageReady(windowId, overlayId),
    loaded: (windowId, overlayId) => overlays.pageLoaded(windowId, overlayId),
    button: (windowId, overlayId, click) => overlays.buttonClick(windowId, overlayId, click),
    discuss: (windowId, overlayId, target, note) => overlays.discuss(windowId, overlayId, target, note)
  })

  // One object for every file click, so `shown` (the diffs open now) outlives a single call.
  const diffOptions: OpenDiffOptions = {
    tab: (id) => sessions.get(id),
    // The probe decides what the overlay runs, so it runs with the overlay's env: the login env
    // (read at call time; it is replaced once loaded), not main's own minimal Finder PATH.
    lsFiles: async (argv, cwd) => {
      await loginEnvReady
      return execLsFiles(argv, cwd, buildPtyEnv(loginEnv, { binDir: paths.binDir }))
    },
    open: openOverlay,
    shown: new Set()
  }
  // A file click, or a plugin's ctx.files.open, goes to the plugin the project uses to open files, if
  // any (contributes.openFile), else to the diff above. The candidates are the set the project's host runs (the Plugins page
  // shows the same set), the pick the project record's; HostManager.openFile bounds the wait.
  const openFileRoute: OpenFileRouteDeps = {
    tab: (id) => sessions.get(id),
    projectPath: (projectId) => registry.get(projectId)?.path,
    windowOf: (projectId) => windows.windowIdOf(projectId),
    handler: async (projectId) => selectOpenFile(await hosts.servicePlugins(projectId), registry.serviceProviders(projectId)),
    deliver: (projectId, pluginId, req) => hosts.openFile(projectId, pluginId, req),
    builtin: (caller, tabId, file) => openDiff(diffOptions, caller, tabId, file),
    // ctx.files.open's fallback: the same viewer and the same `shown`, over the project folder.
    builtinFile: (caller, projectDir, path) => openProjectFileDiff(diffOptions, caller, projectDir, path),
    delivering: new Set()
  }
  // ctx.sessions.focus may name a tab of any project; main finds its window
  // from its own registry entry and only moves focus there, then tells that window's renderer to
  // select it. False for an id that is no Claude tab (any more).
  const focusClaudeTab = (tabId: string): boolean => {
    const entry = sessions.get(tabId)
    if (!entry || !windows.focusProject(entry.projectId)) return false
    sendToProject(entry.projectId, 'tabs.select', { tabId })
    return true
  }
  registerSessionHandlers(router, {
    snapshotFor: (projectId) => sessions.snapshotFor(projectId),
    // Scoped to the sender's project inside the registry (cancelQueuedFor).
    cancelQueued: (projectId, tabId, itemId) => sessions.cancelQueuedFor(projectId, tabId, itemId),
    closeAnswer: (windowId, requestId, closed) => closeAsks.answer(windowId, requestId, closed)
  })

  // e2e only (the harness sets CC_COCKPIT_TEST=1, never a packaged app): a dynamic import, so no other run loads it.
  if (testRun) {
    // Overlays opened through the hook, by handle: a test starts one, drives the UI, then reads
    // the result (or the error) its opener got.
    const overlayResults = new Map<number, { result?: OverlayResult; error?: string }>()
    let nextOverlayHandle = 1
    // The project record of a folder (any spelling of its path), or undefined.
    const projectAt = (path: string) => {
      const real = realpathSync(path)
      return registry.list().find((p) => p.path === real)
    }
    import('./test-hooks')
      .then(({ installTestHooks }) =>
        installTestHooks({
          setTheme: (id: string | null) => themes.setActive(id ?? undefined),
          // What the update check's fake fetcher answers (a tag such as 'v99.0.0'), then one check.
          fakeRelease: async (tag: string) => {
            fakeReleaseTag = tag
            await updateChecker.check()
          },
          // A second project window, for "every open window" assertions.
          openProject: (path: string) => {
            windows.openPath(path)
          },
          // How a project folder's open window was made (window-background e2e): main's record and
          // the BrowserWindow's own background colour (#00000000 when created transparent, which
          // Electron reads back as #000000).
          // undefined when the folder has no open window.
          windowLook: (path: string) => {
            const project = projectAt(path)
            const windowId = project ? windows.windowIdOf(project.id) : undefined
            const win = windowId === undefined ? null : BrowserWindow.fromId(windowId)
            if (windowId === undefined || !win) return undefined
            return { transparent: windows.isTransparent(windowId), backgroundColor: win.getBackgroundColor() }
          },
          // The texts `ccc notify` was asked to show (test runs show no real notification).
          notifications: () => recordedNotices?.records().map((n) => n.body) ?? [],
          // The same with every field main gave the OS (title, silent, action label, still open).
          notificationDetails: () => recordedNotices?.records() ?? [],
          // Click or dismiss the index-th notification shown (what the person would do); false when
          // there is none or it already ended.
          clickNotification: (index: number) => recordedNotices?.click(index) ?? false,
          dismissNotification: (index: number) => recordedNotices?.dismiss(index) ?? false,
          // The windows `notify.chime` went to (ctx.notify sound, after the setting and the throttle).
          chimes: () => chimesRung.map((c) => c.windowId),
          // The sound ids those chimes rang, in the same order.
          chimeSounds: () => chimesRung.map((c) => c.sound),
          // Where the CLI socket is and whether main is listening on it.
          socket: () => ({ path: sock, listening: socket.listening }),
          // The tabs main holds for a project folder, as the renderer would see them.
          // Read-only: a lookup, not registry.openPath (that bumps recents and creates records).
          tabs: (path: string) => {
            const project = projectAt(path)
            return project ? tabs.list(project.id) : []
          },
          // The session registry's full entries for a project folder (status, tool, prompt,
          // files, queue), as plain data. Read-only.
          sessions: (path: string) => {
            const project = projectAt(path)
            return project ? sessions.listByProject(project.id) : []
          },
          // The zones e2e: a project folder's layout view, plugin panels declared the way Task 25
          // will, and a panel's badge/error. Unknown folders answer undefined / false.
          layout: (path: string) => {
            const project = projectAt(path)
            return project ? layouts.view(project.id) : undefined
          },
          pluginPanels: (path: string, pluginId: string, panels: PluginPanelDef[]) => {
            const project = projectAt(path)
            if (project) layouts.setPluginPanels(project.id, pluginId, panels)
          },
          panelStatus: (path: string, panelKey: string, status: PanelStatus | null) => {
            const project = projectAt(path)
            return project ? layouts.setStatus(project.id, panelKey, status ?? undefined) : false
          },
          // A plugin's ctx.sessions.close of a tab (the path HostApi's closeTab runs): resolves to
          // `closed` once the window answered. False for an unknown folder.
          pluginCloseTab: (path: string, tabId: string) => {
            const project = projectAt(path)
            const windowId = project ? windows.windowIdOf(project.id) : undefined
            if (!project || windowId === undefined) return Promise.resolve(false)
            return closeTabForPlugin(windowId, project.id, tabId)
          },
          // The main-internal send / cancel (no IPC reaches them yet), for a tab id the test read
          // from `sessions` or `tabs`.
          send: (tabId: string, text: string) => sessions.send(tabId, text),
          cancelQueued: (tabId: string, itemId: string) => sessions.cancelQueued(tabId, itemId),
          // Open an overlay in a project folder's window the way the CLI / a plugin will; returns
          // a handle for overlayResult, or undefined when the folder has no open window.
          openOverlay: (path: string, spec: unknown) => {
            const project = projectAt(path)
            const windowId = project ? windows.windowIdOf(project.id) : undefined
            if (windowId === undefined) return undefined
            const handle = nextOverlayHandle++
            const entry: { result?: OverlayResult; error?: string } = {}
            overlayResults.set(handle, entry)
            openOverlay(windowId, spec, 'test').then(
              (result) => {
                entry.result = result
              },
              (err: unknown) => {
                entry.error = errorText(err)
              }
            )
            return handle
          },
          // What that opener got so far: {} while the overlay is open.
          overlayResult: (handle: number) => overlayResults.get(handle),
          // Plugins: link a fixture folder, enable it for a project folder (restarting that
          // window's host), and read the host's per-plugin state.
          linkPlugin: async (folder: string) => {
            await plugins.link(folder)
          },
          enablePlugin: async (path: string, pluginId: string) => {
            const project = projectAt(path)
            if (!project) throw new Error(`no project for ${path}`)
            registry.update(project.id, (r) => {
              if (!r.enabledPlugins.includes(pluginId)) r.enabledPlugins.push(pluginId)
            })
            await hosts.restart(project.id)
          },
          // `ccc plugin link` asks a person; a test answers by queueing the answers here (one per
          // dialog, in order; an empty queue denies) and reads what the dialogs would have said.
          answerLink: (...answers: boolean[]) => {
            testLinkConfirm?.answer(...answers)
          },
          linkDialogs: () => testLinkConfirm?.dialogs() ?? [],
          hostStatus: (path: string) => {
            const project = projectAt(path)
            return project ? hosts.status(project.id) : undefined
          },
          // A plugin's project settings saved as the This project form would (secret fields
          // through `secrets`, encrypted), so the running plugin hears of them: the ctx.oauth e2e
          // hands its fixture the fake provider's dynamic URLs this way.
          savePluginProjectSettings: (path: string, pluginId: string, values: unknown, secrets?: unknown) => {
            const project = projectAt(path)
            if (!project) throw new Error(`no project for ${path}`)
            return projectSettings.saveSettings(project.id, pluginId, values, secrets)
          },
          // The plugin commands registered in a project's command table, and running one.
          pluginCommands: (path: string) => {
            const project = projectAt(path)
            return project ? commands.view(project.id).commands.filter((c) => c.source === 'plugin') : []
          },
          runPluginCommand: async (path: string, commandId: string) => {
            const project = projectAt(path)
            if (!project) throw new Error(`no project for ${path}`)
            await hosts.runCommand(project.id, commandId)
          },
          // The overlay stack of a project folder's window, as its renderer sees it.
          overlays: (path: string) => {
            const project = projectAt(path)
            const windowId = project ? windows.windowIdOf(project.id) : undefined
            return windowId === undefined ? [] : overlays.infos(windowId)
          },
          // OverlayHandle.focus() for an overlay id read from `overlays`: brings it to the top of
          // its window's stack. False when the folder has no window or the overlay is not open.
          focusOverlay: (path: string, overlayId: string) => {
            const project = projectAt(path)
            const windowId = project ? windows.windowIdOf(project.id) : undefined
            return windowId === undefined ? false : overlays.focus(windowId, overlayId)
          }
        })
      )
      .catch((err: unknown) => console.error('test hooks failed', err))
  }

  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    // Prefer the loser's own process.argv (original order). Fall back to Electron's argv when
    // the data is missing or malformed (another build of the app holding the same lock).
    const data = asSecondInstanceData(additionalData)
    const opened = data
      ? openFromArgv(data.argv, data.cwd)
      : openFromArgv(argv, workingDirectory)
    // A bare re-launch (no folder) must still surface the app rather than do nothing. Through
    // the manager: its handle un-minimises a window, BrowserWindow.focus() alone does not.
    if (!opened) windows.focusAny()
  })

  // The window manager decides when to quit (closing the picker with no project open, off
  // macOS). Without a listener Electron quits by itself once the last project window closes,
  // racing the manager that replaces that window with the picker.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    quitting = true
    // Before the windows close and kill the tabs: nothing from here on may overwrite the saved tabs.
    restorer.freeze()
    windows.beginQuit()
  })
  app.on('will-quit', () => {
    updateChecker.stop()
    // Main's own helper processes (the login-env shell, an install's clone, the diff probe):
    // their timeouts are timers that die with main. Synchronous SIGKILLs, never throws, and first
    // so a throw further down cannot skip it (child-registry.ts).
    liveChildren.killAll()
    // stop() unlinks synchronously; the close itself may not finish before the process exits.
    // Overlays first: their dismissed replies need the connections stop() destroys, else a waiting
    // `ccc overlay` would get a closed socket instead of `{"kind":"dismissed"}`.
    overlays.disposeAll()
    devWatch.dispose()
    hosts.disposeAll()
    void socket.stop()
    sessionGist.dispose()
    sessions.dispose()
    tabs.disposeAll()
    registry.flushAll()
    pluginIndex.flush()
    pluginSecrets.flush()
    // After hosts.disposeAll(): no host is left to write after this.
    appStorage.flush()
  })
  app.on('activate', () => windows.activate())
  // The menu's accelerator is the focused project's (AppMenu). A blur passes the window that is
  // leaving, so blur-then-focus and focus-then-blur both end on the right table, and a last
  // window closing (or the app going to the background) falls back to the core one.
  app.on('browser-window-focus', (_event, win) => {
    appMenu.refresh()
    // A view hidden while the window was in the background hands the keyboard back now.
    webviews.windowFocused(win.id)
  })
  app.on('browser-window-blur', (_event, win) => appMenu.refresh(win))

  app
    .whenReady()
    .then(async () => {
      // Before the first window, so the first Claude tab already has a live socket to report
      // to. Milliseconds (the stale probe is capped at 500 ms); false only logs: the app runs
      // without a socket, and its tabs get no CC_COCKPIT_SOCK (see the TabManager `sock` above).
      await socket.start()
      updateChecker.start()
      // A packaged app takes its icon from the bundle (electron-builder.yml › mac.icon); `npm run
      // dev` runs the stock Electron.app, whose dock shows Electron's icon unless told otherwise.
      // build/ sits two levels above out/main. A missing file only leaves the default icon.
      if (!app.isPackaged && process.platform === 'darwin') {
        try {
          app.dock?.setIcon(join(__dirname, '..', '..', 'build', 'icon.png'))
        } catch (err) {
          console.error('dev dock icon not set:', errorText(err))
        }
      }
      // Deny every browser permission and device by default: the shell page's own top frame gets
      // only what it uses (the installed-font list of Settings › Terminal), nothing it embeds gets
      // anything (windows/permissions.ts has the inventory and why). Both the request and the
      // check handler: Chromium asks the check handler for a permission's state first (a "no"
      // there ends queryLocalFonts() before any request; navigator.permissions.query reads it).
      // Here because the default session exists only once the app is ready; before the first
      // window, so no page asks first.
      lockDownSession(session.defaultSession, isAppPage)
      handleOverlayScheme((url) => overlays.pageHtml(url))
      handlePluginScheme((url, method) =>
        servePluginRequest(url, method, {
          pluginDir: servedPluginDir,
          // out/sdk/panel.js, built next to out/main/index.js (electron.vite.config.ts).
          sdkFile: join(__dirname, '../sdk/panel.js'),
          log: (m) => console.warn(m)
        })
      )
      appMenu.refresh()
      // Reopen the windows that were open at last quit; their saved tabs start when each
      // window's renderer attaches. A project whose folder is gone gets no window: the picker
      // offers relink or forget. Then a folder named on the command line (an already restored
      // one is just focused).
      const launch = planLaunch(
        registry.openIds().flatMap((id) => {
          const project = registry.get(id)
          return project ? [project] : []
        })
      )
      // A missing project can only be relinked or forgotten from the picker's recent list. One
      // that fell out of that list (it holds 20) could never be removed and would open the
      // picker on every launch, so it is dropped from the open list; its record stays.
      const recentIds = new Set(registry.recent().map((p) => p.id))
      for (const project of launch.missing) {
        if (!recentIds.has(project.id)) registry.markClosed(project.id)
      }
      launch.missing = launch.missing.filter((p) => recentIds.has(p.id))
      // Restore is launch-only: a project whose folder was missing now keeps its saved tabs
      // until it is relinked or forgotten; opening it later in the session starts it empty.
      for (const { project, tabs: saved } of launch.open) {
        restorer.queue(project.id, saved)
        try {
          windows.openPath(project.path)
        } catch (err) {
          restorer.discard(project.id)
          console.error(`cannot reopen ${project.path}`, err)
        }
      }
      openFromArgv(process.argv, process.cwd())
      // Last, so a window opened above does not close it (opening a project closes the picker).
      if (launch.missing.length > 0 || windows.projectWindowCount === 0) windows.showPicker()
    })
    .catch((err: unknown) => {
      console.error('startup failed', err)
      app.quit()
    })
}
