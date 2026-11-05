// The renderer <-> main IPC contract: channel names and payload shapes. Types plus a few
// constants (the two channel lists, the panel port names) and only type imports, so the preload,
// the renderer and main all import it.
//
// Nothing in a request names the caller's project or window. main resolves both from
// `event.sender` (src/main/ipc/router.ts); a project id that does travel in a payload (a recent
// project the picker wants to open) is only looked up inside the scope main resolved itself.

import type { KeyConflict } from './keys'
import type { LayoutState, ZoneId } from './layout'
import type { ProjectColor } from './project-color'
import type { TerminalFont } from './terminal-font'
import type { Theme } from './theme'
import type { BlurSupport, SeeThroughArea, WindowBackground } from './window-background'
import type { TabCloseSide, TabCommandEntry, TabCommandLevel, TabExitBehavior, TabKind } from './types'
import type { PluginServicesView } from './services'
import type { PanelHeaderIconName } from './panel-header'
import type { SlotPosition } from './slots'
import type { DiscussTarget } from './discuss'
import type { SettingsPageScope } from './manifest'

/** Where a Claude tab stands (see main/sessions/status-reducer.ts for how hook events move it). */
export type TabStatus = 'starting' | 'idle' | 'working' | 'needs-permission' | 'waiting' | 'ended'

/** A text waiting for the send gate (main/sessions/send-gate.ts). */
export interface QueuedItem {
  id: string
  text: string
}

/**
 * What a window may see of a tab of ITS OWN project. main builds it
 * (session-registry.ts `snapshotFor`); a window never receives this for another project's tab.
 */
export interface SessionDetail {
  tabId: string
  status: TabStatus
  tool?: string
  lastPrompt?: string
  /** The topic Claude set as its terminal title; the tab's name when present (else "Claude N"). */
  title?: string
  /** The name the person gave the tab (Rename); it wins over `title`. */
  name?: string
  /**
   * A one-line summary of the session (the app setting `sessionGist`, written by Claude Haiku
   * after a turn); shown under the name in place of the last prompt. Absent while the setting is off.
   */
  gist?: string
  notes: string[]
  steps?: { done: number; total: number }
  files: string[]
  queue: QueuedItem[]
}

/**
 * The per-window snapshot (plan: Technical Details > Tab status and session registry): `own` has
 * the full entries of the receiving window's own project's tabs and nothing else. Other windows'
 * tabs reach no window: the top bar's strip of them is a plugin's (`sessions-strip` slot, through
 * ctx.sessions.list({ scope: 'all' }), design-next §4).
 */
export interface SessionsSnapshot {
  own: SessionDetail[]
}

/** A project as the renderer sees it: enough for a title bar and the picker list. */
export interface ProjectSummary {
  id: string
  name: string
  path: string
  /** The folder no longer exists (relink or forget it; the picker cannot open it). */
  missing: boolean
  /** The project's colour (Settings › This project); absent = none. */
  color?: ProjectColor
}

/** What the asking window is; the renderer renders the picker or the project shell from this. */
export type WindowInfo =
  | PickerInfo
  | {
      kind: 'project'
      project: ProjectSummary
      /** In full screen when the page loaded (a restored full-screen window); later: 'window.state'. */
      fullScreen?: boolean
      /**
       * Main made this window transparent (AppSettings.windowBackground.transparent when it was
       * created). Fixed for the window's life: Electron cannot change it on an open window, so the
       * page draws its see-through backgrounds from this, never from the current setting.
       */
      transparent?: boolean
    }

/** The picker's window info: what it needs to draw rows and its Open Folder button. */
export interface PickerInfo {
  kind: 'picker'
  /** The user's home folder (real path, as project paths are), shown as `~` in the rows. */
  home: string
  /** Opened over a project window (a sheet): it offers Cancel and Esc; a standalone one does not. */
  modal?: boolean
  /**
   * The chord File › Open Folder fires on while the picker is focused (canonical, `meta+o`), for
   * the button's hint; absent when it is unbound. The menu accelerator handles the key itself.
   */
  openFolderKey?: string
}

/** A tab as the renderer sees it. The per-tab token and the PTY are main's business. */
export interface TabInfo {
  id: string
  kind: TabKind
  /** Absolute; the project folder or a path inside it. */
  cwd: string
  /**
   * Which process of the tab this describes: 1 for the first, +1 per Restart (same tab id); 0 for
   * a restored command tab that has not run yet (`notStarted`). The
   * renderer orders what it hears by it: replies and events can cross (a restarted process that
   * dies at once sends `tabs.exit` before the `tabs.restart` reply lands; a `tabs.list` reply was
   * taken before a `tabs.added` that arrives first), and an older snapshot must not undo a newer
   * exit (see renderer/state/tabs-store.ts).
   */
  gen: number
  /**
   * Claude session id, once one SessionStart reported has a conversation to resume (a prompt was
   * submitted, or the tab itself was resumed); what restore saves and Restart resumes.
   */
  sessionId?: string
  /**
   * Set once the process ended; the tab then shows "exited (code N): Restart · Close". A clean
   * exit closes the tab instead under the default `tabExit` setting (`tabs.removed`). Also set
   * (code 0) on a `notStarted` tab, so it is restartable and shows the banner like an exited one.
   */
  exit?: { code: number; signal: number | null }
  /**
   * A command tab brought back by restore: it never runs on its own (a deploy re-run at launch
   * would be a nasty surprise), so it waits, stopped, with "not started: Restart · Close".
   */
  notStarted?: true
  /** A command tab's title (its menu entry's label, copied when the tab was opened). */
  label?: string
  /** A command tab's command line (copied when opened; Restart runs this copy). */
  command?: string
  /**
   * A Claude tab's name given by the person (Rename, ctx.sessions.rename); main keeps it for restore.
   * The renderer shows it from `SessionDetail.name`, which changes with the registry's broadcast.
   */
  name?: string
}

/** One user entry of the new-tab menu as the menu shows it: no command text, main runs it by id. */
export interface TabCommandMenuItem {
  id: string
  label: string
  /** The canonical chord that opens it (its `tab.newCommand.*` command), shown in the menu; absent when unbound. */
  key?: string
  /** It opens a terminal overlay rather than a tab: the menu marks it. Only a hint, main decides. */
  open?: 'overlay'
}

/** The user entries of the [+] menu, under Claude and Shell: app-wide, then this project's. */
export interface TabCommandMenu {
  app: TabCommandMenuItem[]
  project: TabCommandMenuItem[]
}

/**
 * `tabs.create`: a Claude or shell tab, or the new-tab menu entry `entryId` of `level`. A command
 * entry is named by id only: main looks its command line up in its own settings, and with it
 * whether it opens a tab or a terminal overlay.
 */
export type TabCreateRequest =
  | { kind: 'claude' | 'shell'; cwd?: string }
  | { kind: 'command'; level: TabCommandLevel; entryId: string }

/** A command as the palette and the key handler see it. */
export interface CommandInfo {
  /**
   * Core commands are `area.name`; a plugin's are `<pluginId>/<id>`; a new-tab menu entry's are
   * `tab.newCommand.<level>.<entryId>` (shared/tab-commands.ts).
   */
  id: string
  title: string
  /** Canonical chord (see shared/keys.ts) that fires this command; absent when unbound. */
  key?: string
  source: CommandSource
}

/** Where a command comes from: the app, a plugin, or one of the user's new-tab menu entries. */
export type CommandSource = 'core' | 'plugin' | 'tabCommand'

/** The sender's project commands with keys resolved (defaults + overrides) by main. */
export interface CommandsView {
  commands: CommandInfo[]
  /** Chords several commands claim; the settings screen warns about them. */
  conflicts: KeyConflict[]
}

/** A badge on a panel's icon: a number, or a bare "needs you" dot. */
export type PanelBadge = { kind: 'count'; count: number } | { kind: 'dot' }

/**
 * One header action as the renderer draws it (ctx.panels.header, checked in main by
 * shared/panel-header.ts). Exactly one of `icon` (a core icon name) and `iconSrc` (main's
 * `cc-plugin://<pluginId>/<path>` of the plugin's .svg) is set.
 */
export interface PanelHeaderActionInfo {
  id: string
  title: string
  icon?: PanelHeaderIconName
  iconSrc?: string
  busy?: boolean
  disabled?: boolean
}

/** What a plugin put in its panel's title bar; absent is the bare title. */
export interface PanelHeaderInfo {
  meta?: string
  actions?: PanelHeaderActionInfo[]
}

/**
 * A panel that exists for the sender's project right now, as its icon strip needs it. Where it
 * sits (zone, open, size) is in the LayoutState, not here.
 */
export interface PanelInfo {
  /** `<pluginId>/<panelId>` (core has no panels of its own since the Sessions panel became a plugin's). */
  panelKey: string
  title: string
  /** A short glyph for the strip; the first letter of the title when absent. */
  icon?: string
  /**
   * A plugin panel's icon image: `cc-plugin://<pluginId>/<icon>` (main builds it from the
   * manifest). Shown instead of the glyph; the glyph comes back if the image fails to load.
   */
  iconSrc?: string
  badge?: PanelBadge
  /** The plugin's error for this panel; the strip shows a warning mark with this as tooltip. */
  error?: string
  /** A plugin panel's title bar content (ctx.panels.header); cleared when its plugin stops. */
  header?: PanelHeaderInfo
  /**
   * A plugin panel's page: `cc-plugin://<pluginId>/<entry>` (main builds it from the manifest).
   * Absent for a panel declared without a page (a webview panel); PluginPanel loads it in a sandboxed iframe.
   */
  src?: string
  /**
   * `webview`: the panel is a native web view main lays over it (`"kind": "webview"`, plan B
   * Task 8); the renderer draws its toolbar and the placeholder whose place it reports with
   * `webviews.placement`. Absent: an html panel (or a core one).
   */
  kind?: 'webview'
  /**
   * The slot frames drawn in this panel's column (ctx.panels.slots, design-next §2), in the order
   * placed: main resolved each placement's provider, clamped its height and left out what is not
   * drawn (no provider, the project's pick is "None", over the window's frame cap). Absent: none.
   */
  slots?: SlotFrameInfo[]
}

/**
 * One slot frame as the shell draws it: a sandboxed iframe of the PROVIDER's page, with its own
 * port to the provider's backend (`slots.connect` with `id`). The host panel's `params` are not
 * here: they go to the provider only (`slot.open`).
 */
export interface SlotFrameInfo {
  /** Main's opaque id for this frame (SLOT_FRAME_ID_PATTERN). A new id is a new frame: remount. */
  id: string
  type: string
  /** The plugin whose page this is. */
  pluginId: string
  /** `cc-plugin://<pluginId>/<entry>`. */
  src: string
  /** In a panel's column: above or below the panel's frame; `top-bar`: the app's top bar. */
  position: SlotPosition | 'top-bar'
  /**
   * Px: the placement's height clamped to the provider's min/max (in the top bar, which has a fixed
   * height, the provider's minHeight). The page sizes itself within [minHeight, height].
   */
  height: number
  minHeight: number
  /** What the page asked for with `ccPanel.slot.setHeight` (`slots.height`), already clamped. Absent: `height`. */
  pageHeight?: number
}

/** What a webview panel's view shows (`webviews.current`, `webviews.navigated`). Empty: no view yet. */
export interface WebviewPageInfo {
  url: string
  title: string
  /** Why the page failed to load (`ERR_…` and code); absent for a page that loaded. */
  error?: string
}

/**
 * `PanelInfo.error` of every panel of a plugin whose host crashed too often and was given up on
 * (host-manager.ts): the panel then offers Restart (`plugins.restart`) instead of its page.
 */
export const PLUGIN_STOPPED_TEXT = 'plugin stopped: Restart'

/**
 * A panel's MessagePort travels main -> renderer on this channel through `webContents.postMessage`
 * (a port cannot ride `cockpit.on`: the bridge carries no MessagePort). The preload takes it off
 * the event and re-posts it into the page with `window.postMessage({ type: PANEL_PORT_MESSAGE,
 * panelKey, nonce }, '*', [port])`; the page accepts only a message whose `source` is its own
 * window (a panel iframe posting to its parent has its own window as source).
 */
export const PANEL_PORT_CHANNEL = 'panels.port'
export const PANEL_PORT_MESSAGE = 'cc-cockpit.panel-port'

/** What main sends with a panel's port: the panel and the `nonce` the renderer's connect named. */
export interface PanelPortPayload {
  panelKey: string
  nonce: number
}

// ---------------------------------------------------------------------------------------------
// Settings overlay. App-wide data (projects, plugins) shown from any project window; main
// re-validates every change.
// ---------------------------------------------------------------------------------------------

/** A project in the settings list: the picker's summary plus whether a window shows it now. */
export interface SettingsProject extends ProjectSummary {
  /** A window shows it right now (main's table): it cannot be relinked or removed meanwhile. */
  open: boolean
}

/** Where an installed plugin came from. */
export type PluginSourceView =
  | { kind: 'git'; url: string; tag: string }
  | { kind: 'linked'; path: string }
  | { kind: 'bundled' }

/**
 * Per secret field of a settings schema (`"format": "secret"` on a top-level property): whether a
 * value is stored. The value itself never reaches a renderer, in this or any other payload.
 */
export type SecretFieldsView = Record<string, { set: boolean }>

/** A plugin's app-wide settings as the form needs them. */
export interface PluginAppSettingsView {
  /** The manifest's JSON Schema (draft-07, no regex patterns: main refused those). */
  schema: Record<string, unknown>
  /**
   * Stored values with the schema's defaults applied (the stored ones as they are if invalid).
   * Never a secret field: see `secretFields`.
   */
  values: Record<string, unknown>
  /** Why the stored values do not validate; the plugin is disabled until they do. */
  problem?: string
  /** Present when the schema has secret fields. */
  secretFields?: SecretFieldsView
  /**
   * A project's view only (design-next §5.2): the top-level fields this project overrides, in
   * declaration order; every other field uses the global value. `values` and `secretFields` are then
   * the effective ones (override, else global, else default).
   */
  overrides?: string[]
  /**
   * A project's view only: the global values of the plugin's project fields (defaults applied), what
   * a field shows on "Use global" before the save. Never a secret field: see `globalSecretFields`.
   */
  globalValues?: Record<string, unknown>
  /** A project's view only, when the schema has secret fields: whether each has a global value. */
  globalSecretFields?: SecretFieldsView
}

/**
 * A settings save's secret edits, by field name: a new value (sent once, encrypted by main) or
 * null to clear it. Fields left out stay as they are.
 */
export type SecretEdits = Record<string, string | null>

export interface PluginView {
  id: string
  name: string
  version: string
  source: PluginSourceView
  /** `ok: false` = disabled, with the reason the manifest or settings check gave. */
  state: { ok: true } | { ok: false; reason: string; revoked?: { reason: string; source: string } }
  appSettings?: PluginAppSettingsView
  /**
   * The global values of the plugin's project fields (design-next §5.2), edited on its global page
   * under the app fields: what every project that does not override a field gets.
   */
  projectDefaults?: PluginAppSettingsView
  /** The plugin has an html settings page for the app scope (`contributes.settings.page`, design-next §5.4). */
  settingsPage?: true
  /** Bundled plugins only: switched off in every project (`AppSettings.disabledBundled`). Absent for any other source. */
  offInAllProjects?: boolean
  /**
   * The manifest declares `"access": { "sessions": "all-windows" }`: it sees the status, tool, title and
   * project of every window's Claude tabs (design-next §4.1). Shown on the plugin's row. Absent: no.
   */
  seesAllSessions?: true
}

/** The repository and commit a confirmation displayed; main compares them with its own pin before it installs. */
export interface MarketplaceExpectation {
  repo: string
  commit: string
}

/** What the Marketplace page shows for one listing (plan: plugin marketplace, Task 5). */
export type MarketplaceStatus = 'available' | 'installed' | 'built-in' | 'linked' | 'update' | 'revoked' | 'repo-changed'

/**
 * One listing of one index. Everything but `indexUrl` and `id` is the index's own untrusted text,
 * shown as plain text. `action` is what the button may do; the install and update calls take only
 * `indexUrl` and `id` back, so repo, tag and commit never come from the renderer.
 */
export interface MarketplaceEntryView {
  indexUrl: string
  id: string
  name: string
  description: string
  author: string
  repo: string
  /** The tag and commit an install would clone and pin; shown in the confirmation. */
  tag: string
  commit: string
  version: string
  status: MarketplaceStatus
  /** The version installed now, when the id is installed. */
  installedVersion?: string
  action: 'install' | 'update' | null
  /** Why there is no button, or what to know before pressing it (main's wording). */
  note?: string
  /** Why this commit, or the installed one, is revoked. */
  revokedReason?: string
  /**
   * Not installed, but this id was last installed from another repository: installing runs that
   * repository's code, so the confirmation warns and main switches the id off in every project.
   */
  repoChangedFrom?: string
}

export interface MarketplaceIndexView {
  url: string
  /** Epoch ms of the last good fetch, 0 when there is none. */
  fetchedAt: number
  error: string | null
  skippedEntries: number
  skippedRevocations: number
  /** Entries left out of `entries` because they need a plugin API this app does not have. */
  incompatible: number
}

/** A revocation from an index that has no say over an installed plugin: shown, never enforced. */
export interface MarketplaceWarningView {
  pluginId: string
  pluginName: string
  reason: string
  source: string
}

export interface MarketplaceView {
  indexes: MarketplaceIndexView[]
  entries: MarketplaceEntryView[]
  warnings: MarketplaceWarningView[]
}

/** The result of saving a plugin's app-wide settings form. */
export type PluginSettingsSaveResult =
  | { ok: true; values: Record<string, unknown>; secretFields?: SecretFieldsView }
  | { ok: false; errors: string[] }

/** A plugin as the "This Project" page lists it. */
export interface ProjectPluginView {
  id: string
  name: string
  version: string
  /** The project has it enabled (its host runs it, its panels show). */
  enabled: boolean
  /**
   * A bundled plugin switched off in all projects (Settings > Plugins): `enabled` is false and the
   * project's switch cannot turn it on until that is undone. Absent otherwise (never `false` here;
   * the same type as PluginView's, so one check reads both).
   */
  offInAllProjects?: boolean
  /** `ok: false` = the plugin itself is disabled (invalid manifest); it cannot be enabled. */
  state: { ok: true } | { ok: false; reason: string }
  /** Enabled, but the stored settings do not validate: why the plugin does not run here. */
  problem?: string
  /** The plugin's project-level settings form (same shape as the app-wide one). */
  projectSettings?: PluginAppSettingsView
  /** The plugin has an html settings page for the project scope (`contributes.settings.page`). */
  settingsPage?: true
}

/** `settingsPage.info`: the page's URL when the plugin runs in this project, else only that it does not. */
export type SettingsPageInfo = { enabled: true; src: string } | { enabled: false }

/** A panel that exists for the project and where it sits ('hidden': under the strip's "..."). */
export interface ProjectPanelView {
  panelKey: string
  title: string
  zone: ZoneId | 'hidden'
}

/** Everything the "This Project" page shows (main/settings/project-settings-service.ts). */
export interface ProjectSettingsView {
  name: string
  plugins: ProjectPluginView[]
  panels: ProjectPanelView[]
  /** This project's entries of the new-tab menu (ProjectRecord.tabCommands, bad ones dropped). */
  tabCommands: TabCommandEntry[]
  /** The project's colour; absent = none. */
  color?: ProjectColor
}

/** A theme the picker offers. */
export interface ThemeChoice {
  id: string
  name: string
  kind: 'light' | 'dark'
}

/** One command with its keys, for the keybinding list. */
export interface KeyBindingRow {
  id: string
  title: string
  source: CommandSource
  /** The default chord, canonical; absent when the command has none. */
  defaultKey?: string
  /** The chord now claimed (canonical), even when it is in a conflict; absent = unbound. */
  key?: string
  /** The user set it (a chord, or "unbound"), as opposed to the default. */
  overridden: boolean
  /** Titles of the other commands that claim the same chord (empty: no conflict). */
  conflictsWith: string[]
  /** The chord does not fire this command: another claimant outranks it, or nobody wins. */
  inactive: boolean
}

/**
 * The app settings the shell page applies itself, as it renders, rather than asking main at each
 * use: read once at page load (`prefs.get`) and pushed to every window on a change
 * (`prefs.changed`), like the theme. Defaults applied by main (a damaged app.json value never
 * reaches a window).
 */
export interface ShellPrefs {
  tabCloseSide: TabCloseSide
  /** Hide the side zones while the terminal would be narrower than `minTerminalWidth` (AppSettings.zoneAutoHide). */
  zoneAutoHide: boolean
  /** The terminal's minimum width in px for the zone auto-hide (AppSettings.minTerminalWidth). */
  minTerminalWidth: number
  /** What every terminal draws with (tabs and terminal overlays). */
  terminalFont: TerminalFont
  /**
   * How much of their background colour a transparent window's surfaces keep, in percent
   * (AppSettings.windowBackground.opacity). Only a window main made transparent applies it.
   */
  backgroundOpacity: number
  /** Which surfaces of a transparent window carry the glass (AppSettings.windowBackground.area). */
  seeThroughArea: SeeThroughArea
}

/**
 * What the update notice and the Settings toggle show (main/updates/update-check.ts). `available`
 * carries a version main validated (`x.y.z`) and nothing else: the release link is never sent, the
 * renderer asks main to open it (`updates.openRelease`).
 */
export interface UpdateState {
  /** The running app's version. */
  current: string
  /** AppSettings.updateCheck with the default applied. */
  enabled: boolean
  /** A newer, not dismissed release; null = nothing to show. */
  available: { version: string } | null
}

/** One pick of the notification "Sound" dropdown: an id (shared/notify-sound.ts) and what the person reads. */
export interface NotificationSoundChoice {
  id: string
  name: string
}

/** A group of the dropdown: "Built-in", then one per OS sound folder that has any sounds. */
export interface NotificationSoundGroup {
  label: string
  sounds: NotificationSoundChoice[]
}

/** A system sound's bytes as main read them for a validated id (`notify.soundData`). */
export interface NotificationSoundData {
  data: Uint8Array
  /** The media type from the file's extension (audio/ogg, audio/wav, audio/aiff...). */
  type: string
}

/** Everything the "General" and "Appearance" pages show (main/settings/appearance-service.ts). */
export interface AppearanceView {
  themes: ThemeChoice[]
  /** The user's pick; null = follow the OS. */
  selected: string | null
  /** The theme showing now. */
  current: string
  keys: KeyBindingRow[]
  /** What a tab does when its process exits (AppSettings.tabExit, default applied). */
  tabExit: TabExitBehavior
  /** Open a Claude tab when a project opens empty (AppSettings.claudeTabOnOpen, default applied). */
  claudeTabOnOpen: boolean
  /** Haiku writes a one-line gist of each Claude session (AppSettings.sessionGist, default off). */
  sessionGist: boolean
  /** A plugin's notification with `sound` rings a chime (AppSettings.notificationSounds, default on). */
  notificationSounds: boolean
  /**
   * The sound it rings (AppSettings.notificationSound, a well-spelled id or `builtin:chime`). A
   * system id may name a file that went away; the page shows it as missing (it is not among
   * `settings.notificationSoundOptions`).
   */
  notificationSound: string
  /** Auto-hide the side zones when the terminal gets narrow (AppSettings.zoneAutoHide, default on). */
  zoneAutoHide: boolean
  /** The terminal's minimum width for it (AppSettings.minTerminalWidth, default applied). */
  minTerminalWidth: number
  /** Ask before closing a tab that is still running (AppSettings.confirmTabClose, default applied). */
  confirmTabClose: boolean
  /** Which end of each tab the close button sits at (AppSettings.tabCloseSide, default applied). */
  tabCloseSide: TabCloseSide
  /** The terminals' font (AppSettings.terminalFont, each damaged field at its default). */
  terminalFont: TerminalFont
  /** The see-through background (AppSettings.windowBackground, each damaged field at its default). */
  windowBackground: WindowBackground
  /** What "Blur behind" does on this platform ('none': the switch is shown disabled, with why). */
  blurSupport: BlurSupport
  /** The app-wide entries of the new-tab menu (AppSettings.tabCommands, bad ones dropped). */
  tabCommands: TabCommandEntry[]
}

/** State of the `~/.local/bin/ccc` link (main/hooks/ccc-install.ts). */
export type CccCommandState =
  /** Nothing at the link path: "Install" is offered. */
  | 'missing'
  /** Our link is there. */
  | 'installed'
  /** Something else is at the link path: left alone. */
  | 'foreign'

/** What the "Install ccc command" row of General shows. */
export interface CccCommandView {
  state: CccCommandState
  /** `~/.local/bin/ccc`, absolute. */
  linkPath: string
  /** The wrapper the link points at (or would point at). */
  target: string
  /** The directory that holds the link. */
  binDir: string
  /** Whether `binDir` is on the login shell's PATH. */
  onPath: boolean
  /** AppSettings.cccOffer with the default applied: whether start-up offers the install. */
  offerAtStart: boolean
}

/** The zone layout of the sender's project together with the panels it may place. */
export interface LayoutView {
  layout: LayoutState
  panels: PanelInfo[]
  /**
   * Set on the view a panel show publishes (ctx.panels.show, `ccc panel show`): the panel asked
   * for. The layout says it is open in an expanded zone, but the window may have auto-hidden that
   * zone (renderer/zones/auto-hide.ts), which the stored layout does not know; this is what brings
   * it back. A show that changes nothing in the layout still publishes, for this.
   */
  reveal?: string
  /** Slot frames the app places itself (the top bar's `sessions-strip`). Absent: none. */
  appSlots?: SlotFrameInfo[]
}

export type OverlayKind = 'terminal' | 'url' | 'html'

/**
 * An overlay of the sender's window as the renderer draws it (main/overlays/overlay-manager.ts
 * owns the stack). A terminal overlay's output arrives as `overlays.data`; a url overlay's page
 * is a native view main lays over the body the renderer reports; an html overlay's page is
 * served by main at `src` (`cc-overlay://<id>/` for inline html, `cc-plugin://<id>/<file>` for a
 * plugin's own page) and shown in a sandboxed iframe.
 */
export type OverlaySize = 'default' | 'large' | 'full'
export const OVERLAY_SIZES: readonly OverlaySize[] = ['default', 'large', 'full']

export type OverlayInfoBody =
  | { id: string; kind: 'terminal'; title: string }
  | { id: string; kind: 'url'; title: string; url: string }
  | { id: string; kind: 'html'; title: string; src: string }
/**
 * A toolbar button as the renderer draws it (design-next §3.2): main's clean copy of the spec's
 * (shared/overlay-buttons.ts), with a plugin `.svg` icon turned into its `cc-plugin://` URL, as for a
 * panel header action. Every string is drawn as React text.
 */
export interface OverlayButtonInfo {
  id: string
  label: string
  icon?: PanelHeaderIconName
  iconSrc?: string
  primary?: true
  disabled?: true
  busy?: true
}

/** A button another plugin registered for the overlay's type (`ctx.overlay.buttons`). */
export interface OverlayTypeButtonInfo extends OverlayButtonInfo {
  pluginId: string
  /** That plugin's title: the toolbar orders the plugins' groups by it. */
  pluginTitle: string
}

/** What Discuss's Send answered: where the text went, or why nothing was sent. */
export type DiscussAnswer = { ok: true; tabId: string; queued: boolean } | { ok: false; error: string }

export type OverlayInfo = OverlayInfoBody & {
  size: OverlaySize
  /** The opener's own buttons (spec `buttons`); absent: none. */
  buttons?: OverlayButtonInfo[]
  /** Buttons other plugins registered for the overlay's type; absent: none. */
  typeButtons?: OverlayTypeButtonInfo[]
  /**
   * Present when the toolbar shows Discuss with Claude (design-next §3.5): the overlay has a `type`
   * or its opener an `onDiscuss` handler, and its spec did not say `discuss: false`. `tabId` is the
   * opener's preselected Claude tab (`discuss.tabId`), which the popover uses only when it is one of
   * this window's Claude tabs.
   */
  discuss?: { tabId?: string }
  /**
   * Present while the body is not ready yet (design-next §3.4), so the renderer draws a loader over
   * it: html until the page's port is up (`ready: 'load'`, the default) or until it calls
   * `ccPanel.ready()` (`ready: 'manual'`); url until the view's first load ends (loaded or failed);
   * terminal until the program's first output.
   */
  loading?: true
}

/** Request/response pairs for `cockpit.invoke(channel, payload)`. */
export interface IpcInvokeMap {
  /** Which window is asking. Always answered from the sender, never from a payload. */
  'window.info': { req: void; res: WindowInfo }
  /**
   * Close the sender's project window and open it again (project windows only), so a
   * creation-only setting (the transparent background) takes effect. Its tabs come back as after
   * a restart: Claude tabs resume, shell tabs start fresh, command tabs come back not started,
   * overlays are not restored. The reply may never arrive: the asking page is the one that goes.
   */
  'window.reopen': { req: void; res: void }
  /** Recently opened projects, newest first. */
  'projects.recent': { req: void; res: ProjectSummary[] }
  /** Native folder dialog, then open (or focus) that folder's window. False when cancelled. */
  'projects.openFolder': { req: void; res: boolean }
  /** Open a project from the recent list. Ids not in that list are refused. */
  'projects.openRecent': { req: { id: string }; res: void }
  /**
   * The top strip's "+": show the project picker (recent projects + Open Folder), or focus it when
   * it is already open; there is only ever one. Project windows only (the picker is the picker).
   */
  'projects.showPicker': { req: void; res: void }
  /** The modal picker's Cancel / Esc: close it and give the project window its focus back. */
  'projects.closePicker': { req: void; res: void }
  /**
   * Picker: point a project whose folder is gone at another folder (native dialog, then open it
   * with no tabs). False when the dialog was cancelled. Ids that are not recent, missing projects
   * are refused.
   */
  'projects.relink': { req: { id: string }; res: boolean }
  /** Picker: forget a recent project whose folder is gone (its record and saved tabs). */
  'projects.forget': { req: { id: string }; res: void }
  /**
   * Open a web link (a terminal URL the user clicked) in the system browser. main accepts http
   * and https only; the renderer never calls `window.open` (the window open handler denies it).
   */
  'app.openExternal': { req: { url: string }; res: void }
  /** The update notice's state (see UpdateState). Changes arrive as `updates.changed`. */
  'updates.state': { req: void; res: UpdateState }
  /** The Settings toggle "Check for new versions". Off clears the notice and stops asking. */
  'updates.setEnabled': { req: { value: boolean }; res: void }
  /** Dismiss the notice for the version it shows; a newer release shows again. Ignored unless `version` is what main offers now. */
  'updates.dismiss': { req: { version: string }; res: void }
  /** Open the release page main built for the available version. Takes no URL: main opens its own. */
  'updates.openRelease': { req: void; res: void }
  /** The active theme (app-wide). The renderer applies it on :root and to every terminal. */
  'theme.get': { req: void; res: Theme }
  /** The app settings the shell page applies itself (ShellPrefs). Changes arrive as `prefs.changed`. */
  'prefs.get': { req: void; res: ShellPrefs }

  // Claude status.
  /** The current per-window snapshot, for a page that just loaded; later ones arrive as events. */
  'sessions.list': { req: void; res: SessionsSnapshot }
  /**
   * Cancel a queued text of one of the sender's own project's tabs. A tab or item that is not
   * there (or belongs to another project) answers false, like one already delivered.
   */
  'sessions.cancelQueued': { req: { tabId: string; itemId: string }; res: boolean }
  /**
   * The answer to a `sessions.closeAsk` (a plugin's ctx.sessions.close): whether the tab closed.
   * Settles only an ask main sent to the sender's own window; false for any other id.
   */
  'sessions.closeAnswer': { req: { requestId: string; closed: boolean }; res: boolean }

  // Zones.
  /** The sender's project layout, reconciled with the panels that exist. Plain query. */
  'layout.get': { req: void; res: LayoutView }
  /**
   * Replace the sender's project layout (the renderer applies the pure operations of
   * shared/layout.ts and sends the result). main re-validates and reconciles it, so a panel that
   * does not exist cannot be placed, and answers with what it stored.
   */
  'layout.set': { req: { layout: LayoutState }; res: LayoutView }

  /** Commands of the sender's project with resolved keys. Plain query: safe to call again. */
  'commands.list': { req: void; res: CommandsView }
  /**
   * Run a plugin command (`<pluginId>/<id>`) in the sender's project's plugin host. Core commands
   * run in the renderer and never come here; an id the host did not register is refused.
   */
  'commands.run': { req: { id: string }; res: void }

  // Plugin panels. The project is the sender's; ids are looked up inside it.
  /**
   * A plugin panel's iframe loaded: main makes a MessageChannel, hands one end to the plugin's host
   * (tagged with plugin and panel id from main's own records) and posts the other to this window on
   * PANEL_PORT_CHANNEL with the same `nonce`. False (no port follows) when the panel is not one of
   * a plugin running in this window's host now; `panels.reload` says when to try again.
   */
  'panels.connect': { req: { panelKey: string; nonce: number }; res: boolean }
  /** The Restart of "plugin stopped: Restart": start the sender's project's plugin host again. */
  'plugins.restart': { req: void; res: void }
  /**
   * A click on a plugin panel's header action. main delivers it to the plugin's onAction only when
   * the panel is one of the sender's project and its current header has that action, not busy or
   * disabled; false when it was dropped (the header changed under the click, the host is gone).
   */
  'panels.action': { req: { panelKey: string; actionId: string }; res: boolean }
  // Slot frames (design-next §2). The project is the sender's; frame ids are main's, looked up in it.
  /**
   * A slot frame's iframe loaded: main makes a MessageChannel, hands one end to the PROVIDER's host
   * with what its onOpen gets, and posts the other to this window on PANEL_PORT_CHANNEL under
   * `@slot/<frameId>` (slotPortKey) with the same `nonce`. False (no port follows) when the frame is
   * not one this window draws now or its provider is not running.
   */
  'slots.connect': { req: { frameId: string; nonce: number }; res: boolean }
  /** The shell unmounted a slot frame (host panel hidden or collapsed): the provider hears onClose. */
  'slots.disconnect': { req: { frameId: string }; res: null }
  /**
   * A slot page's `ccPanel.slot.setHeight`: main keeps it within [minHeight, the frame's height] and
   * publishes it as `SlotFrameInfo.pageHeight`. False for a frame not drawn now or one in the top bar.
   */
  'slots.height': { req: { frameId: string; height: number }; res: boolean }
  /**
   * A plugin's html settings page (design-next §5.4) for this window's project: null when the plugin
   * declares no page for `scope`; `enabled: false` when it does not run in this project (the page
   * shows "Enable … in this project"); else the page's `cc-plugin://` URL.
   */
  'settingsPage.info': { req: { pluginId: string; scope: SettingsPageScope }; res: SettingsPageInfo | null }
  /**
   * A settings page's iframe loaded: main hands one end of a new channel to that plugin's backend in
   * THIS window's host (`ctx.settingsPage.onOpen`, tagged with main's own ids) and posts the other to
   * this window on PANEL_PORT_CHANNEL under `@settings/<pluginId>` (settingsPagePortKey) with the same
   * `nonce`. One page per plugin at a time: an older one of the plugin is closed first. False (no
   * port follows) when the plugin is not running here now; `panels.reload` says when to try again.
   */
  'settingsPage.connect': { req: { pluginId: string; scope: SettingsPageScope; nonce: number }; res: boolean }
  /** The shell unmounted the plugin's settings page: its backend hears onClose. */
  'settingsPage.disconnect': { req: { pluginId: string }; res: null }

  // Settings overlay. Any project window may call these; the data is app-wide.
  /** Every known project, most recently opened first. */
  'settings.projects': { req: void; res: SettingsProject[] }
  /** Open (or focus) the window of a known project whose folder exists. */
  'settings.projectOpen': { req: { id: string }; res: void }
  /**
   * Native folder dialog, then point a project whose folder is gone at the choice (its saved tabs
   * are dropped, like the picker's relink). Refused for a project with a window. False when the
   * dialog was cancelled.
   */
  'settings.projectRelink': { req: { id: string }; res: boolean }
  /** Forget a project (record, settings, saved tabs). Refused for a project with a window. */
  'settings.projectRemove': { req: { id: string }; res: void }
  'settings.plugins': { req: void; res: PluginView[] }
  /** Clone `tag` of a git URL (https, ssh or file) and install it. Rejects with the reason. */
  'settings.pluginInstall': { req: { url: string; tag: string }; res: PluginView }
  /** Native folder dialog, then link the choice as a dev plugin. False when cancelled. */
  'settings.pluginLink': { req: void; res: boolean }
  'settings.pluginUpdate': { req: { id: string; tag: string }; res: PluginView }
  'settings.pluginUninstall': { req: { id: string }; res: void }
  /**
   * Switch a bundled plugin off in all projects (`off: true`) or back to each project's own switch.
   * Refused for any other source. The hosts of open projects it changes restart.
   */
  'settings.pluginBundledOff': { req: { id: string; off: boolean }; res: void }
  /**
   * Plugin services in the asking window's project: per plugin what it provides and uses and the
   * problems, per service the providers and the one calls reach (over the plugins its host runs).
   */
  'settings.pluginServices': { req: void; res: PluginServicesView }
  /**
   * Pick which plugin answers a service several plugins provide in this project, or clear the pick
   * with null. Main checks both names against the project's set; a change restarts its host.
   */
  'settings.pluginServiceProvider': { req: { service: string; pluginId: string | null }; res: void }
  /** The marketplace listings of every configured index, with status. A plain query. */
  'settings.marketplace': { req: void; res: MarketplaceView }
  /**
   * Install a listing. Main looks `indexUrl` + `id` up in its own validated state; the pin comes from
   * there. `expect` is what the confirmation showed: main refuses when its current pin differs.
   */
  'settings.marketplaceInstall': { req: { indexUrl: string; id: string; expect: MarketplaceExpectation }; res: PluginView }
  /** Update the installed plugin to a listing (a downgrade only off a revoked commit). Same lookup. */
  'settings.marketplaceUpdate': { req: { indexUrl: string; id: string; expect: MarketplaceExpectation }; res: PluginView }
  /** Fetch every configured index now, then answer with the new view. */
  'settings.marketplaceRefresh': { req: void; res: MarketplaceView }
  /** Replace the configured index URLs (https: or file: only, checked in main), fetch, answer with the view. */
  'settings.marketplaceSetUrls': { req: { urls: string[] }; res: MarketplaceView }
  /** Save a plugin's app-wide settings; main validates against the manifest's schema. */
  'settings.pluginSettingsSave': {
    req: { id: string; values: Record<string, unknown>; secrets?: SecretEdits }
    res: PluginSettingsSaveResult
  }
  /**
   * Save the global values of a plugin's project fields; main validates them alone and merged with
   * every open project's overrides, and refuses naming a project they would make invalid.
   */
  'settings.pluginProjectDefaultsSave': {
    req: { id: string; values: Record<string, unknown>; secrets?: SecretEdits }
    res: PluginSettingsSaveResult
  }

  // Settings overlay, "This Project", "General" and "Appearance". They act on the
  // sender's own project (ids in a payload are looked up inside it) and the app-wide theme/keys.
  'settings.project': { req: void; res: ProjectSettingsView }
  /** Enable or disable an installed plugin for this project; its host restarts with the new set. */
  'settings.projectPluginEnable': { req: { pluginId: string; enabled: boolean }; res: void }
  /** Save a plugin's project-level settings; main validates against the manifest's schema. */
  'settings.projectPluginSettingsSave': {
    req: { pluginId: string; values: Record<string, unknown>; secrets?: SecretEdits }
    res: PluginSettingsSaveResult
  }
  /** Move a panel of this project to a zone (a hidden one comes back). */
  'settings.projectPanelMove': { req: { panelKey: string; zone: ZoneId }; res: void }
  /**
   * Set (or with null clear) this project's colour: a palette name or `#rrggbb`, checked strictly
   * by main (shared/project-color.ts checkProjectColor). Answers the stored value (a hex in lower
   * case). Every window hears of it: this one by `project.updated`, the others through their
   * strip's `sessions.snapshot`, an open picker by `projects.changed`.
   */
  'settings.projectColorSet': { req: { value: ProjectColor | null }; res: ProjectColor | null }
  'settings.appearance': { req: void; res: AppearanceView }
  /** Pick a theme (null: follow the OS). Every window and panel follows. */
  'settings.themeSet': { req: { id: string | null }; res: void }
  /**
   * Override a command's key. `chord`: null goes back to the default, '' unbinds, text is
   * normalised by main (refused when it is not a chord). A conflict is allowed and reported in
   * the next `settings.appearance`.
   */
  'settings.keySet': { req: { commandId: string; chord: string | null }; res: void }
  /** Close a tab on a clean exit, or keep every exited tab (AppSettings.tabExit). Applies to live tabs. */
  'settings.tabExitSet': { req: { value: TabExitBehavior }; res: void }
  /** Open a Claude tab when a project window opens with no tabs (AppSettings.claudeTabOnOpen). */
  'settings.claudeTabOnOpenSet': { req: { value: boolean }; res: void }
  /** Turn the session gist on or off (AppSettings.sessionGist). Off cancels runs and removes every gist. */
  'settings.sessionGistSet': { req: { value: boolean }; res: void }
  /** Let plugin notifications with `sound` chime, or never (AppSettings.notificationSounds). Read at each chime. */
  'settings.notificationSoundsSet': { req: { value: boolean }; res: void }
  /**
   * The notification sounds to pick from: the built-in tones, then the OS sound folders' files as
   * main lists them now (main/notifications/system-sounds.ts). Names only, never a path.
   */
  'settings.notificationSoundOptions': { req: void; res: NotificationSoundGroup[] }
  /** Pick the notification sound (AppSettings.notificationSound): a built-in, or a system id in main's fresh listing. */
  'settings.notificationSoundSet': { req: { value: string }; res: void }
  /**
   * A system sound's bytes, for the window to play. Main parses the id and lists the folders again,
   * so only a file in that listing is read (never a path the page names); null for a built-in id,
   * a file that is gone, or one that changed since it was listed. The page then plays the Chime.
   */
  'notify.soundData': { req: { id: string }; res: NotificationSoundData | null }
  /** Hide the side zones when the terminal gets narrow, or never (AppSettings.zoneAutoHide). Every window follows. */
  'settings.zoneAutoHideSet': { req: { value: boolean }; res: void }
  /** The terminal's minimum width for the zone auto-hide (AppSettings.minTerminalWidth). Every window follows. */
  'settings.minTerminalWidthSet': { req: { value: number }; res: void }
  /**
   * Whether closing a running tab asks first (AppSettings.confirmTabClose, default applied). Read
   * by the tab bar at each close, like `tabs.commands` at each menu open, so a change made in any
   * window applies to the next close everywhere without an event.
   */
  'settings.confirmTabClose': { req: void; res: boolean }
  /** Ask before closing a running tab, or not (the dialog's "Don't ask again" sends false). */
  'settings.confirmTabCloseSet': { req: { value: boolean }; res: void }
  /** Put each tab's close button before its label or after it (AppSettings.tabCloseSide). Every window follows. */
  'settings.tabCloseSideSet': { req: { value: TabCloseSide }; res: void }
  /**
   * Change some fields of the terminal font (each checked by main; one bad field refuses the
   * change), or null to go back to the defaults. Every open terminal in every window follows.
   */
  'settings.terminalFontSet': { req: { value: Partial<TerminalFont> | null }; res: void }
  /**
   * Change some fields of the window background (each checked by main; one bad field refuses the
   * change). `opacity` reaches every transparent window at once (`prefs.changed`), `blur` every
   * window made transparent; `transparent` only project windows created afterwards (the page offers
   * `window.reopen` for its own window).
   */
  'settings.windowBackgroundSet': { req: { value: Partial<WindowBackground> }; res: void }
  /**
   * Replace the app-wide or this project's new-tab menu entries (add, edit, remove, reorder). An
   * entry keeps its `id` when that level has it; a new one (no id) gets one from main. Refused as
   * a whole when an entry is invalid. Open tabs keep their own copy of the command.
   */
  'settings.tabCommandsSet': {
    req: { level: TabCommandLevel; entries: Array<{ id?: string; label: string; command: string }> }
    res: TabCommandEntry[]
  }
  /** The `ccc` command link in ~/.local/bin: what is there and whether it is on the PATH. */
  'settings.cccStatus': { req: void; res: CccCommandView }
  /** Link `~/.local/bin/ccc` to the app's wrapper; refused when something else is there. */
  'settings.cccInstall': { req: void; res: CccCommandView }
  /** Turn the start-up offer to install `ccc` on or off (Settings and the offer's "Don't ask again"). */
  'settings.cccOfferSet': { req: { value: boolean }; res: void }
  /**
   * The start-up question: the link's view when this window should ask whether to install `ccc`,
   * else null. Main decides once per app launch, so only the first window to ask can get an answer.
   */
  'ccc.offer': { req: void; res: CccCommandView | null }

  // Overlays. Every id is looked up in the sender window's own stack only.
  /**
   * The sender window's overlays, bottom first. The re-attach point after a page load: it resets
   * terminal overlays' flow control, like `tabs.list`, so call it once per page load.
   */
  'overlays.list': { req: void; res: OverlayInfo[] }
  /** ✕, Esc or Cmd+Shift+W on that overlay: close it as dismissed. False when it is gone. */
  'overlays.close': { req: { overlayId: string }; res: boolean }
  /** Keys typed into a terminal overlay. */
  'overlays.input': { req: { overlayId: string; data: string }; res: void }
  'overlays.resize': { req: { overlayId: string; cols: number; rows: number }; res: void }
  /** The renderer wrote `count` characters (string length) of a terminal overlay's output. */
  'overlays.ack': { req: { overlayId: string; count: number }; res: void }
  /** Where a url overlay's body is in the window (CSS px); main puts the page's view there. */
  'overlays.bounds': {
    req: { overlayId: string; x: number; y: number; width: number; height: number }
    res: void
  }
  /** An html overlay's page posted its result; it closes with `{ kind: 'value', value }`. */
  'overlays.result': { req: { overlayId: string; value: unknown }; res: boolean }
  /**
   * A plugin's html overlay page posted a message without a `result` key (one JSON text, as its
   * port carried it): main hands it to the opener of that overlay only. False when dropped.
   */
  'overlays.message': { req: { overlayId: string; message: string }; res: boolean }
  /** That page has its port now (every page load): main sends the opener's queued posts. */
  'overlays.ready': { req: { overlayId: string }; res: void }
  /**
   * That page says it has drawn its content (`ccPanel.ready()`, or `{ type: 'ready' }` on an inline
   * page's port): the loader of a `ready: 'manual'` overlay goes.
   */
  'overlays.loaded': { req: { overlayId: string }; res: void }
  /**
   * A click on a toolbar button: the opener's (`source: 'opener'`) or one another plugin added for
   * the overlay's type (`'type'`, with its `pluginId`). False when main dropped it (not a button it
   * shows now, busy, disabled).
   */
  'overlays.button': {
    req: { overlayId: string; source: 'opener' | 'type'; pluginId?: string; buttonId: string }
    res: boolean
  }
  /**
   * Discuss with Claude's Send (design-next §3.5): main asks the opener's `onDiscuss` for context,
   * builds the text, checks the target is a Claude tab of the sender's window again (or opens a new
   * session there, 5 a minute per window), sends it through the send gate, closes the overlay as
   * `discussed` and selects the tab. `{ error }` when nothing was sent (shown in the popover).
   */
  'overlays.discuss': {
    req: { overlayId: string; target: DiscussTarget; note: string }
    res: DiscussAnswer
  }

  // Webview panels (PanelInfo.kind 'webview'). The panel key must name a webview panel of a
  // plugin of the sender's project; the view is the one in the sender's window.
  /**
   * Where the panel's placeholder is (CSS px) and whether its view may show: false while the
   * panel is not on screen or a shell layer (a menu, the palette, a dialog, settings, an overlay,
   * a splitter drag) is up. main also hides it on its own while an overlay is open.
   */
  'webviews.placement': {
    req: { panelKey: string; x: number; y: number; width: number; height: number; visible: boolean }
    res: void
  }
  /** The toolbar's back / forward / reload. A no-op before the plugin first navigated. */
  'webviews.step': { req: { panelKey: string; step: 'back' | 'forward' | 'reload' }; res: void }
  /** The page the view shows now, for a toolbar that just mounted (later: `webviews.navigated`). */
  'webviews.current': { req: { panelKey: string }; res: WebviewPageInfo }

  // Tabs. All are scoped to the sender's project: a tab id that belongs to another project is
  // treated as unknown.
  /**
   * The sender's tabs in order. Also the re-attach point after a renderer reload: output the old
   * page never acknowledged would otherwise keep PTYs paused for good, so main resets flow control.
   */
  'tabs.list': { req: void; res: TabInfo[] }
  /**
   * Start a tab in the project folder or a subfolder (relative paths resolve against the folder),
   * or a new-tab menu entry by level and id (TabCreateRequest). null: the entry opens as an
   * overlay (`open: 'overlay'`), which main put on the window's overlay stack; no tab was made.
   */
  'tabs.create': { req: TabCreateRequest; res: TabInfo | null }
  /** The user entries of the sender's [+] menu (read each time the menu opens). */
  'tabs.commands': { req: void; res: TabCommandMenu }
  'tabs.close': { req: { tabId: string }; res: void }
  /** Move a tab to a position in the project's tab order (clamped to the ends). */
  'tabs.reorder': { req: { tabId: string; toIndex: number }; res: void }
  /** Give a Claude tab a name (1-60 characters, shared/session-name.ts), or `null` for Claude's own title. */
  'tabs.rename': { req: { tabId: string; name: string | null }; res: void }
  /**
   * Relaunch an exited tab (same kind and cwd; `--resume` when a session id is known; a command
   * tab runs its own copy of the command again), or start a restored command tab (`notStarted`).
   */
  'tabs.restart': { req: { tabId: string }; res: TabInfo }
  /** The user typing or pasting: goes straight to the PTY. Programmatic text uses the send gate. */
  'tabs.input': { req: { tabId: string; data: string }; res: void }
  'tabs.resize': { req: { tabId: string; cols: number; rows: number }; res: void }
  /** The renderer wrote `count` characters (string length) of output into xterm. */
  'tabs.ack': { req: { tabId: string; count: number }; res: void }
  /**
   * The tab pane's selection changed (or the page loaded with one): main keeps it per project for
   * `SessionInfo.active`, so plugins know the tab the person is looking at. A tab id that is not
   * the sender's project's is ignored, as a selection racing a close is normal.
   */
  'tabs.selected': { req: { tabId: string }; res: void }
}

/** main -> renderer events for `cockpit.on(channel, cb)`; later tasks add status, theme, ... */
export interface IpcEventMap {
  /** Batched PTY output for one of the window's tabs. Ack it with `tabs.ack`. */
  'tabs.data': { tabId: string; data: string }
  /**
   * The tab's process ended (`signal` is the terminating signal number, else null). `gen` is that
   * process's TabInfo.gen, so an exit is never applied to a later process of the same tab.
   */
  'tabs.exit': { tabId: string; code: number; signal: number | null; gen: number }
  /**
   * main closed the tab on its own: its process `gen` exited cleanly and the `tabExit` setting
   * closes such tabs. Sent instead of `tabs.exit`; the tab is gone in main, as after `tabs.close`.
   */
  'tabs.removed': { tabId: string; gen: number }
  /** The update notice's state changed (a check found a release, a dismissal, the setting). Every window. */
  'updates.changed': UpdateState
  /** The active theme changed (a pick, the OS appearance, a plugin theme added or removed). */
  'theme.changed': Theme
  /** An app setting the shell page applies itself changed (Settings › General or Appearance). */
  'prefs.changed': ShellPrefs
  /**
   * Play the notification sound once (a plugin's ctx.notify with `sound`). Main already applied the
   * "Notification sounds" setting and the one-per-window throttle; `sound` is the picked id
   * (AppSettings.notificationSound, default applied) or a plugin's own id that main found among the
   * app's sounds (notifier.ts NotifySounds). A system id's bytes come from `notify.soundData`.
   */
  'notify.chime': { sound: string }
  /** This window's view of the Claude tabs (see SessionsSnapshot); throttled to 10 per second. */
  'sessions.snapshot': SessionsSnapshot
  /**
   * A plugin asks to close this Claude tab of the window (ctx.sessions.close): run the person's own
   * close (the dialog when it is running and the setting asks), then answer `sessions.closeAnswer`
   * with the same `requestId`, `closed: false` on Cancel or when the close could not be asked.
   */
  'sessions.closeAsk': { requestId: string; tabId: string }
  /**
   * This window's project changed on main's side (its colour was set, from this window's settings
   * or any other way): what `window.info` would now say about it. Project windows only.
   */
  'project.updated': ProjectSummary
  /** Picker only: a listed project changed (its colour); read the recent list again. */
  'projects.changed': void
  /**
   * Select this tab: the user clicked its entry in another window's top strip, or a plugin opened it
   * with `ctx.sessions.open({ focus: true })`.
   */
  'tabs.select': { tabId: string }
  /**
   * main started a tab the page did not ask for (a plugin's ctx.sessions.open): add it to the
   * bar. Not selected: it starts in `starting`, where a key the user meant for the tab they are
   * typing in could answer Claude's trust dialog. Only `ctx.sessions.open({ focus: true })`, a
   * plugin acting on the person's own click, follows it with a `tabs.select`.
   */
  'tabs.added': TabInfo
  /**
   * The window's state changed on main's side. `fullScreen`: macOS hides the traffic lights in
   * full screen, so the top bar collapses the room it keeps for them.
   */
  'window.state': { fullScreen: boolean }
  /** The panels or the layout changed on main's side (a badge, a plugin enabled, ...). */
  'layout.updated': LayoutView
  /** The window's overlay stack changed (bottom first; empty when the last one closed). */
  'overlays.updated': OverlayInfo[]
  /** Batched output of a terminal overlay. Ack it with `overlays.ack`. */
  'overlays.data': { overlayId: string; data: string }
  /** The opener of a plugin's html overlay posted to its page: one JSON text for the page's port. */
  'overlays.message': { overlayId: string; message: string }
  /** The project's commands changed (a plugin registered or dropped one): replace the key table. */
  'commands.updated': CommandsView
  /**
   * These plugins (re)started in this window's host: their panel pages reload, so each connects to
   * the new host and asks for what it shows (the old ports died with the old process).
   */
  'panels.reload': { pluginIds: string[] }
  /** A webview panel's view committed a page or changed its title (coalesced); empty: it closed. */
  'webviews.navigated': { panelKey: string } & WebviewPageInfo
  /**
   * A chord typed into a native view the page cannot see (a webview panel) that main resolved to
   * this command: run it as if the key had been pressed here (same modal rules).
   */
  'commands.trigger': { id: string }
}

export type InvokeChannel = keyof IpcInvokeMap
export type EventChannel = keyof IpcEventMap

/** The whole API the preload exposes as `window.cockpit`. Nothing else crosses the bridge. */
export interface CockpitApi {
  invoke<C extends InvokeChannel>(
    channel: C,
    ...payload: IpcInvokeMap[C]['req'] extends void ? [] : [IpcInvokeMap[C]['req']]
  ): Promise<IpcInvokeMap[C]['res']>
  /** Subscribe to a main -> renderer event; returns the unsubscribe function. */
  on<C extends EventChannel>(channel: C, listener: (payload: IpcEventMap[C]) => void): () => void
}

/**
 * Every invoke channel, as a runtime list for the preload's allow-list. The preload refuses any
 * other channel, so a handler (or a stray `ipcMain.handle`) not declared here is unreachable from
 * a page. `satisfies` rejects a name missing from IpcInvokeMap; the assertion below rejects a
 * channel added to the map but forgotten here (it would otherwise be refused at run time).
 */
export const INVOKE_CHANNELS = [
  'window.info',
  'window.reopen',
  'projects.recent',
  'projects.openFolder',
  'projects.openRecent',
  'projects.showPicker',
  'projects.closePicker',
  'projects.relink',
  'projects.forget',
  'app.openExternal',
  'updates.state',
  'updates.setEnabled',
  'updates.dismiss',
  'updates.openRelease',
  'theme.get',
  'prefs.get',
  'sessions.list',
  'sessions.cancelQueued',
  'sessions.closeAnswer',
  'layout.get',
  'layout.set',
  'commands.list',
  'commands.run',
  'panels.connect',
  'plugins.restart',
  'panels.action',
  'slots.connect',
  'slots.disconnect',
  'slots.height',
  'settingsPage.info',
  'settingsPage.connect',
  'settingsPage.disconnect',
  'settings.projects',
  'settings.projectOpen',
  'settings.projectRelink',
  'settings.projectRemove',
  'settings.plugins',
  'settings.pluginInstall',
  'settings.pluginLink',
  'settings.pluginUpdate',
  'settings.pluginUninstall',
  'settings.pluginBundledOff',
  'settings.pluginServices',
  'settings.pluginServiceProvider',
  'settings.marketplace',
  'settings.marketplaceInstall',
  'settings.marketplaceUpdate',
  'settings.marketplaceRefresh',
  'settings.marketplaceSetUrls',
  'settings.pluginSettingsSave',
  'settings.pluginProjectDefaultsSave',
  'settings.project',
  'settings.projectPluginEnable',
  'settings.projectPluginSettingsSave',
  'settings.projectPanelMove',
  'settings.projectColorSet',
  'settings.appearance',
  'settings.themeSet',
  'settings.keySet',
  'settings.tabExitSet',
  'settings.claudeTabOnOpenSet',
  'settings.sessionGistSet',
  'settings.notificationSoundsSet',
  'settings.notificationSoundOptions',
  'settings.notificationSoundSet',
  'notify.soundData',
  'settings.zoneAutoHideSet',
  'settings.minTerminalWidthSet',
  'settings.confirmTabClose',
  'settings.confirmTabCloseSet',
  'settings.tabCloseSideSet',
  'settings.terminalFontSet',
  'settings.windowBackgroundSet',
  'settings.tabCommandsSet',
  'settings.cccStatus',
  'settings.cccInstall',
  'settings.cccOfferSet',
  'ccc.offer',
  'overlays.list',
  'overlays.close',
  'overlays.input',
  'overlays.resize',
  'overlays.ack',
  'overlays.bounds',
  'overlays.result',
  'overlays.message',
  'overlays.ready',
  'overlays.loaded',
  'overlays.button',
  'overlays.discuss',
  'webviews.placement',
  'webviews.step',
  'webviews.current',
  'tabs.list',
  'tabs.create',
  'tabs.commands',
  'tabs.close',
  'tabs.reorder',
  'tabs.rename',
  'tabs.restart',
  'tabs.input',
  'tabs.resize',
  'tabs.ack',
  'tabs.selected'
] as const satisfies readonly InvokeChannel[]

/** Every main -> renderer event channel, for the preload's allow-list (see INVOKE_CHANNELS). */
export const EVENT_CHANNELS = [
  'tabs.data',
  'tabs.exit',
  'tabs.removed',
  'theme.changed',
  'updates.changed',
  'prefs.changed',
  'notify.chime',
  'sessions.snapshot',
  'sessions.closeAsk',
  'project.updated',
  'projects.changed',
  'tabs.select',
  'tabs.added',
  'window.state',
  'layout.updated',
  'overlays.updated',
  'overlays.data',
  'overlays.message',
  'commands.updated',
  'panels.reload',
  'webviews.navigated',
  'commands.trigger'
] as const satisfies readonly EventChannel[]

/** Compiles only when the two lists name every channel of their map. */
type Exhaustive<T extends never> = T
export type InvokeChannelsComplete = Exhaustive<
  Exclude<InvokeChannel, (typeof INVOKE_CHANNELS)[number]>
>
export type EventChannelsComplete = Exhaustive<
  Exclude<EventChannel, (typeof EVENT_CHANNELS)[number]>
>

