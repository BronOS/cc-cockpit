// The renderer <-> main IPC contract: channel names and payload shapes. Types plus a few
// constants (the two channel lists, the panel port names, each channel's remote class with its
// lookup) and only type imports, so the preload, the renderer and main all import it.
//
// Nothing in a request names the caller's project or window. main resolves both from
// `event.sender` (src/main/ipc/router.ts); a project id that does travel in a payload (a recent
// project the picker wants to open) is only looked up inside the scope main resolved itself.

import type { KeyConflict } from './keys'
import type { LayoutState, ZoneId } from './layout'
import type { ProjectColor } from './project-color'
import type { TerminalFont } from './terminal-font'
import type { ScreenAnswer } from './terminal-screen'
import type { Theme } from './theme'
import type { BlurSupport, SeeThroughArea, WindowBackground } from './window-background'
import type { TabCloseSide, TabCommandEntry, TabCommandLevel, TabExitBehavior, TabKind } from './types'
import type { PluginServicesView } from './services'
import type { PanelHeaderIconName } from './panel-header'
import type { SlotPosition } from './slots'
import type { FlagPatch, TabFlag } from './tab-flag'
import type { DiscussTarget } from './discuss'
import type { SettingsPageScope } from './manifest'
import type { MarketplaceCategory } from './marketplace'
import type { PageNotice } from './notify'
import type { OAuthPasteAnswer } from './oauth-paste'
import type { WebAccessIndicator, WebAccessPatch, WebAccessSetReply, WebAccessView, WebActionReply, WebLinkReply } from './web-access'

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
  /**
   * The view the person last typed in, and its device's name (design-web.md §5.2 "Input from any
   * view"): the desktop window's or a browser's (`tabs.typed` keeps it current). A page shows the
   * device when the view is not itself. Absent until the person types; not kept across an app restart.
   */
  typedBy?: { viewId: string; device: string }
  /** A command tab's title (its menu entry's label, or a plugin's title, copied when the tab was opened). */
  label?: string
  /** A command tab's command line (copied when opened; Restart runs this copy). Absent on a plugin's command tab. */
  command?: string
  /**
   * A command tab a plugin opened (ctx.sessions.openCommand): the argv it runs as is, with no shell
   * (Restart runs this copy). Set together with `openedBy`, never with `command`.
   */
  argv?: string[]
  /**
   * The plugin that opened this command tab, and its manifest name (absent: show the bare id). Display
   * only, for the tab's "Opened by" line; never an authority for anything.
   */
  openedBy?: string
  openedByName?: string
  /**
   * A Claude tab's name given by the person (Rename, ctx.sessions.rename); main keeps it for restore.
   * The renderer shows it from `SessionDetail.name`, which changes with the registry's broadcast.
   */
  name?: string
  /**
   * The person's flag on the tab, any kind (shared/tab-flag.ts): set only through `tabs.flag` /
   * `tabs.toggleFlag` from this window, kept for restore. The renderer applies their replies.
   */
  flag?: TabFlag
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
/**
 * Where a panel's gear opens Settings (design-next §5.3): `project` = This Project at the plugin (it has
 * project settings), `app` = the plugin's global page under Plugins.
 */
export type PanelSettingsTarget = 'project' | 'app'

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
  /** The plugin has settings: the header draws a gear that opens them here (design-next §5.3). Absent: no gear. */
  settings?: PanelSettingsTarget
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

/** Electron's modifier names a browser may send with `webviews.input` (main checks against its own list). */
export type WebviewInputModifier = 'shift' | 'control' | 'alt' | 'meta' | 'leftbuttondown' | 'middlebuttondown' | 'rightbuttondown' | 'isautorepeat'

/**
 * One `webviews.input` event as a browser sends it: points in the page's CSS px, DOM key names
 * (shared/webview-keys.ts), wheel deltas in px with the DOM's sign.
 */
export type WebviewInputEventWire =
  | { kind: 'pointer'; type: 'move'; x: number; y: number; modifiers?: WebviewInputModifier[] }
  | { kind: 'pointer'; type: 'down' | 'up'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount: number; modifiers?: WebviewInputModifier[] }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: WebviewInputModifier[] }
  | { kind: 'key'; type: 'down' | 'up'; key: string; modifiers?: WebviewInputModifier[] }

/** One option of a streamed page's `<select>` popup (main/webview/select-hit.ts). */
export interface WebviewSelectOption {
  /** Its index in the select's `options` (what `webviews.selectChoose` answers with). */
  index: number
  /** Its label, trimmed, at most 200 units, no control characters. */
  label: string
  /** Disabled, or in a disabled group: shown, never chosen. */
  disabled: boolean
  /** The label of its `<optgroup>`, when it is in one. */
  group?: string
}

/** A select's rectangle in the page's viewport CSS px. */
export interface WebviewSelectRect {
  x: number
  y: number
  width: number
  height: number
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
export type SecretFieldsView = Record<string, { set: boolean; unreadable?: SecretUnreadable }>

/**
 * Why a stored secret cannot be read here (design-web.md §9.5): made by the other mode's store
 * (the desktop's keychain, server mode's key file) or by a key file that was replaced. Such a field
 * counts as `set` (a value is stored) and the form says "enter it again".
 */
export type SecretUnreadable = 'other-mode' | 'replaced'

/** A stored secret as the settings views tell it, before it is a field's `{ set, unreadable }`. */
export type SecretValueState = 'unset' | 'set' | SecretUnreadable

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
  /** A folder or git plugin has its own `preview.png` at its root, shown through `cc-plugin://<id>/preview.png`. */
  preview?: true
  /**
   * Git installs from a marketplace: the index recorded on the plugin, the only one whose listing may
   * update it. The Plugins page merges that listing into the plugin's card.
   */
  marketplace?: string
}

/** The repository and commit a confirmation displayed; main compares them with its own pin before it installs. */
export interface MarketplaceExpectation {
  repo: string
  commit: string
}

/** One plugin of an "Update all" confirmation (design-next §6.4): the listing and what the prompt showed of it. */
export interface MarketplaceUpdateItem {
  indexUrl: string
  id: string
  expect: MarketplaceExpectation
}

/**
 * What "Update all" did: the plugins updated, in order, and each refused or failed update with its
 * reason. A later failure rolls nothing back.
 */
export interface MarketplaceUpdateAllResult {
  updated: PluginView[]
  failed: { id: string; error: string }[]
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
  /**
   * The index lists a preview image for this commit: `settings.marketplacePreview` may give its
   * bytes. False shows the placeholder with the name's initial without asking.
   */
  preview: boolean
  /** The listing's category (design-next §6.2); an unknown or absent one reads as `other`. */
  category: MarketplaceCategory
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
/**
 * The view holding a page that lives in one view at a time (design-web.md §5.4: an html overlay's
 * page, a plugin settings page) and its device's name, display text only. A page shows "Open on
 * <device> — Take over" when the view is not itself (shell-kind.ts isOwnView).
 */
export interface PageHolder {
  viewId: string
  device: string
}

/**
 * `heldBy`: the page is open in a view now (design-web.md §5.4), the one that connected it last.
 * Another view shows "Open on <device> — Take over" instead of loading it.
 */
export type SettingsPageInfo = { enabled: true; src: string; heldBy?: PageHolder } | { enabled: false }

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
  /** The project's own Discuss prompt; absent = it uses the global one (ProjectRecord.discussPrompt). */
  discussPrompt?: string
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
  /** Claude tabs report usage through the status line (AppSettings.statusLineUsage, default on). */
  statusLineUsage: boolean
  /** The global Discuss prompt (AppSettings.discussPrompt; '' = none). */
  discussPrompt: string
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
  /**
   * With state 'foreign': what sits at `linkPath`, so the page can say what it is and what to do.
   * `target` is a symlink's own target (as written, unresolved); `cockpitDataDir` is set when that
   * target is another cc-cockpit's generated wrapper (another install, or the dev app's data dir).
   */
  existing?: { kind: 'file' | 'directory' | 'link'; target?: string; cockpitDataDir?: string }
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
  /**
   * The order main sent it in (LayoutService.send): every `layout.updated` and the `layout.set`
   * answer (the same view the set published) carry one, higher for a newer view. A view's answer
   * to its own `layout.set` can reach it after an event another view's later edit caused (the
   * answer waits for the call's promise, the event does not); LayoutSync takes the newer of the
   * two by this. Absent on `layout.get` answers.
   */
  seq?: number
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
  discuss?: { tabId?: string; primary?: true }
  /**
   * Present while the body is not ready yet (design-next §3.4), so the renderer draws a loader over
   * it: html until the page's port is up (`ready: 'load'`, the default) or until it calls
   * `ccPanel.ready()` (`ready: 'manual'`); url until the view's first load ends (loaded or failed);
   * terminal until the program's first output.
   */
  loading?: true
  /**
   * An html overlay's page lives in one view (design-web.md §5.4): present when a browser view holds
   * it, absent when the window's desktop view does (the shape without web access). Every other view
   * shows "Open on <device> — Take over" (`overlays.take`) instead of the page.
   */
  heldBy?: PageHolder
  /**
   * Server mode with no browser attached: nobody holds the html page yet (it waits for the first
   * browser to list the stack), so no view draws it. Without it, an absent `heldBy` would read as
   * "the desktop holds it" and the hidden window would run the page's code for nobody.
   */
  waiting?: true
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
   * A server's browser view: close the project window main bound the calling view to, for every
   * device, as the desktop's "Close for everyone" does (design-web.md §9.8). Takes no id: a payload
   * is ignored, so a view can only ever close its own window. Refused for every other caller.
   */
  'projects.close': { req: void; res: void }
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
  /**
   * The theme this view shows (the pick, else by the view's screen: the desktop's OS appearance, a
   * browser view's own `prefers-color-scheme` once reported). The renderer applies it on :root and to
   * every terminal.
   */
  'theme.get': { req: void; res: Theme }
  /**
   * A browser view's `prefers-color-scheme` changed (it is sent at `hello` first). Only chooses which
   * built-in this view gets when nothing is picked; ignored from a desktop view.
   */
  'theme.scheme': { req: { dark: boolean }; res: void }
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
   * Settles only an ask main sent to the sender's own window (any view of it: the first answer
   * wins, design-web.md §5.1); false for any other id. `declined`: this view could not ask (another
   * dialog, a screen or an overlay was over it, or its close failed): it counts only once every
   * view of the window declined, so a covered browser cannot cancel the dialog the desktop shows.
   * `closed: true` that wins makes main close the tab, and the reply is then whether it did (the
   * view drops the tab only on true; false: another view answered first or the tab was gone).
   */
  'sessions.closeAnswer': { req: { requestId: string; closed: boolean; declined?: boolean }; res: boolean }
  /**
   * The answer to a `links.ask` (the in-page confirm of `ccc plugin link`): Allow or Deny. Settles
   * only an ask main sent to the sender's own window; the first answer from any view wins (design-web.md
   * §5.1); false for any other id. A remote view may only Deny: its Allow is refused (false, the ask
   * keeps waiting for the desktop), since a linked plugin runs with full access to the host (§6.1).
   */
  'links.answer': { req: { requestId: string; allow: boolean }; res: boolean }
  /**
   * The answer to a `trash.ask` (the in-page Move to Trash confirm of ctx.files.trash): `move` true
   * moves it. Settles only an ask main sent to the sender's own window; the first answer from any view
   * wins (design-web.md §5.1, §9.6); false for an unknown, settled or another window's id. Any view may
   * answer either way: the Trash is recoverable and the person in the browser may be the one who asked.
   */
  'trash.answer': { req: { requestId: string; move: boolean }; res: boolean }

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
  // Taking a settings page over is a plain `settingsPage.connect` from the view that takes it: one
  // page per plugin, the last view to connect holds it (`settingsPage.held` tells the others).

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
  /**
   * "Update all" (design-next §6.4): the same checked update per item, one at a time, each only while its
   * listing is a plain newer version from the plugin's recorded index (never a revoked plugin's move).
   * Failures are collected, not thrown; a malformed list refuses the whole call before any update.
   */
  'settings.marketplaceUpdateAll': { req: { items: MarketplaceUpdateItem[] }; res: MarketplaceUpdateAllResult }
  /** Fetch every configured index now, then answer with the new view. */
  'settings.marketplaceRefresh': { req: void; res: MarketplaceView }
  /**
   * A listing's preview PNG (design-next §6.1), fetched lazily from the index's own folder, checked
   * against the entry's sha256 and cached by main; null when it has none or it cannot be had. The page
   * shows the bytes from a `blob:` URL.
   */
  'settings.marketplacePreview': { req: { indexUrl: string; id: string }; res: Uint8Array | null }
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
  /** Turn the status line usage report on or off (AppSettings.statusLineUsage); hooks.json is rewritten for new tabs. */
  'settings.statusLineUsageSet': { req: { value: boolean }; res: void }
  /** Set the global Discuss prompt; main refuses a non-string or one over MAX_DISCUSS_PROMPT. '' clears it. */
  'settings.discussPromptSet': { req: { value: string }; res: void }
  /** Set this project's own Discuss prompt ('' = off here), or null to use the global one again. */
  'settings.projectDiscussPromptSet': { req: { value: string | null }; res: void }
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
  /**
   * A click on an in-page notice's action (`notices.show`, server mode only, design-web.md §9.9): the
   * plugin's `ctx.notify` resolves `{ clicked: true }`. Settles only a notice main is showing in the
   * sender's own window (or app-wide); false for an unknown, settled or another window's id. Refused
   * (an error) for the desktop page and for any view on the desktop, where notices are the OS's.
   */
  'notices.click': { req: { requestId: string }; res: boolean }
  /** The ✕ of an in-page notice: as the person dismissing an OS notification (`{ clicked: false }`). Checked as `notices.click`. */
  'notices.dismiss': { req: { requestId: string }; res: boolean }
  /**
   * A plugin's OAuth sign-in in server mode (design-web.md §9.9): the address the provider's redirect
   * ended on, pasted into the sign-in's link notice (`app.linkNotice` with `signIn`). Main looks the
   * sign-in up by `signIn` among the sender's own window's (the window it bound the view to) and
   * settles it in-process with the loopback's own checks, making no request. Every refusal (the
   * desktop, the hidden page, an unknown or another window's id, a wrong address, the attempt limit)
   * is the same OAUTH_PASTE_REFUSED, which never echoes the address.
   */
  'oauth.paste': { req: { signIn: string; url: string }; res: OAuthPasteAnswer }
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
  // Settings › General › Web access (design-web.md §4). What adds or widens access is `no`-class in
  // both modes; the read, the indicator and Revoke/Disconnect are `adapted`: a browser view of a
  // server reads the card and narrows (§9.4, §9.6), one on the desktop is refused as before.
  /** The web access settings, the gateway's state, the devices and the risks of the current choices. */
  'settings.webAccess': { req: void; res: WebAccessView }
  /**
   * Change the fields present in the patch; refused as a whole (an Error with the reason) when one is
   * invalid, and answered `needsConfirm` (nothing saved) when it brings in a §4.3 risk not confirmed.
   */
  'settings.webAccessSet': { req: { value: WebAccessPatch }; res: WebAccessSetReply }
  /** The access link (made on first use); only while the gateway listens in the link mode. */
  'settings.webAccessLink': { req: void; res: WebLinkReply }
  /** A new access link: the old one and every device that signed in with it stop working. */
  'settings.webAccessRegenerate': { req: void; res: WebLinkReply }
  /** A one-time "add a device" link, valid 10 minutes. */
  'settings.webAccessAddDevice': { req: void; res: WebLinkReply }
  /** Close a device's sockets; it stays signed in and the page reconnects. False when there is no such device. */
  'settings.webDeviceDisconnect': { req: { id: string }; res: boolean }
  /** Sign a device out for good and close its sockets. False when there is no such device. */
  'settings.webDeviceRevoke': { req: { id: string }; res: boolean }
  /** Revoke every device; how many were revoked. */
  'settings.webDevicesRevokeAll': { req: void; res: number }
  /** Set or change the password (hashed off the main thread); a change signs out the devices of the old one. */
  'settings.webAccessSetPassword': { req: { password: string }; res: WebActionReply }
  /** The top bar's indicator now; changes arrive as `webAccess.changed`. */
  'webAccess.state': { req: void; res: WebAccessIndicator }
  /**
   * Answer a browser waiting for a desktop confirm (`WebAccessIndicator.confirm`): deny, or allow with
   * the code the person read off that browser. A wrong code is refused with the reason.
   */
  'webAccess.confirmAnswer': { req: { id: string; allow: boolean; code?: string }; res: WebActionReply }
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
   * "Take over" on an html overlay held by another view of the window (design-web.md §5.4): the
   * page moves to the calling view and loads there, as on a reload (the opener's posts wait for its
   * new port). False for an overlay that is gone, of another window, or not an html one.
   */
  'overlays.take': { req: { overlayId: string }; res: boolean }
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
    req: { overlayId: string; target: DiscussTarget }
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
  /**
   * Server mode, a browser view only (design-web-browser.md §3.2): the panel's placeholder size in
   * CSS px (main clamps it to [64, 4096]), whether the panel is mounted and on screen in this view
   * (`visible`; a shell layer over it does not count: the canvas is a page layer, not a native
   * view) and whether the browser tab is in the background (`hidden`, `document.hidden`). Sent on
   * mount, on every resize and visibility change, and `visible: false` on unmount. The view becomes
   * a viewer of the panel (it gets frames) while visible, not hidden and with an area.
   */
  'webviews.place': {
    req: { panelKey: string; width: number; height: number; visible: boolean; hidden: boolean }
    res: void
  }
  /** Server mode, a browser view only: "Fit to this screen", the page takes this viewer's size. */
  'webviews.fit': { req: { panelKey: string }; res: void }
  /**
   * Server mode, a browser view that is a viewer of the panel only (design-web-browser.md §4.1):
   * pointer, wheel and key events over the canvas, in the page's CSS px, at most 64 per call. Main
   * checks every field (main/webview/webview-input.ts), drops what is off the page or over
   * 600 events/s per view, and sends the rest to the page as trusted input; a press, a key or a
   * wheel makes this view the page's size owner.
   */
  'webviews.input': { req: { panelKey: string; events: WebviewInputEventWire[] }; res: void }
  /**
   * Server mode, a viewer of the panel only (design-web-browser.md §4.2): committed text from the
   * browser's hidden textarea (an IME or dead-key composition, non-ASCII, AltGr text, a paste), at
   * most 64 KB of UTF-8 per call; the same gate and rate bucket as `webviews.input`, and it claims
   * the size. Main inserts it as the page's committed text (the page protocol's `Input.insertText`),
   * in order with the view's other input.
   */
  'webviews.insertText': { req: { panelKey: string; text: string }; res: void }
  /**
   * Server mode, a viewer of the panel only (design-web-browser.md §4.4): the answer to the
   * `webviews.select` popup `id` main sent this view, the chosen option's index or null for none
   * (Escape, a click elsewhere). Main takes only the view's current popup id for the panel, once;
   * an index it did not list, or listed as disabled, is refused.
   */
  'webviews.selectChoose': { req: { panelKey: string; id: string; index: number | null }; res: void }

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
   * Flag one of the sender's tabs (any kind), change its colour or note, or clear it with `null`
   * (shared/tab-flag.ts FlagPatch: a missing colour keeps the tab's or takes the last-used one).
   * Answers the flag as stored (note cleaned), null once cleared. The person's only: no plugin path
   * reaches it (the router takes it from the shell page's top frame only).
   */
  'tabs.flag': { req: { tabId: string; flag: FlagPatch | null }; res: TabFlag | null }
  /** The flag command: clear the tab's flag, or flag it with the last-used colour. Answers as `tabs.flag`. */
  'tabs.toggleFlag': { req: { tabId: string }; res: TabFlag | null }
  /**
   * Relaunch an exited tab (same kind and cwd; `--resume` when a session id is known; a command
   * tab runs its own copy of the command again), or start a restored command tab (`notStarted`).
   */
  'tabs.restart': { req: { tabId: string }; res: TabInfo }
  /** The user typing or pasting: goes straight to the PTY. Programmatic text uses the send gate. */
  'tabs.input': { req: { tabId: string; data: string }; res: void }
  /**
   * The view's pane fits `cols` x `rows` for the tab. Main remembers it per view; the pty takes it
   * only while this view sizes the tab (design-web.md §5.2 "Size", main/tabs/terminal-sizes.ts).
   */
  'tabs.resize': { req: { tabId: string; cols: number; rows: number }; res: void }
  /**
   * "Fit to this screen": the pty takes this view's size for the tab now. False when the view has
   * not reported a size for it or is hidden.
   */
  'tabs.fit': { req: { tabId: string }; res: boolean }
  /** The view was hidden or shown (`document.visibilityState`): a hidden view never sizes a tab. */
  'tabs.visibility': { req: { visible: boolean }; res: void }
  /** The renderer wrote `count` characters (string length) of output into xterm. */
  'tabs.ack': { req: { tabId: string; count: number }; res: void }
  /**
   * The desktop page's answer to `tabs.screenAsk` (shared/terminal-screen.ts ScreenAnswer): its
   * screen of the tab, as of the output it was sent before the ask. Untrusted in main: checked
   * against the ask out for that tab of the sender's project, its size and MAX_SCREEN_CHARS.
   */
  'tabs.screen': { req: { tabId: string } & ScreenAnswer; res: void }
  /**
   * The tab pane's selection changed (or the page loaded with one): main keeps it per project for
   * `SessionInfo.active`, so plugins know the tab the person is looking at. A tab id that is not
   * the sender's project's is ignored, as a selection racing a close is normal.
   */
  'tabs.selected': { req: { tabId: string }; res: void }
}

/** main -> renderer events for `cockpit.on(channel, cb)`; later tasks add status, theme, ... */
export interface IpcEventMap {
  /**
   * Batched PTY output for one of the window's tabs. Ack it with `tabs.ack`. `reset`: `data` is the
   * whole screen (a resync after the view fell behind, or a re-attach, while web access is on,
   * design-web.md §5.2): the terminal starts over with it, and it is not acked.
   */
  /**
   * A tab's output. `reset`: `data` is a whole screen (a resync), the terminal starts over with it.
   * `cols`/`rows`: the pty's size at this point of the stream (design-web.md §5.2 "Size"): with
   * `reset`, the snapshot's size; alone (`data` ''), a size item: the pty took another size after the
   * output before it. The terminal draws at that size (scaled or letterboxed when its pane differs).
   * `local` (with a size, desktop only): this view sizes the pty, so it fits its own pane at once as
   * before web access and the size is only the pty catching up; absent, it follows the pty's size.
   */
  'tabs.data': { tabId: string; data: string; reset?: true; cols?: number; rows?: number; local?: true }
  /**
   * Main asks the desktop page for a tab's screen (web access started while the tab runs, or its
   * headless copy was lost with a worker restart: terminals/mirror.ts "Seeding"), as of the output
   * sent before this event, with at most `scrollback` lines. Answered with `tabs.screen` and `id`.
   */
  'tabs.screenAsk': { tabId: string; id: number; scrollback: number }
  /**
   * The person typed in another view of the tab than before (TabInfo.typedBy): sent when the view
   * changes, not per key. `device` is the requester's own text for a browser: plain text only.
   * `viewId` and `device` null: the view that typed last is gone (TabManager.viewGone), nobody is
   * shown as the last typist.
   */
  'tabs.typed': { tabId: string; viewId: string | null; device: string | null }
  /**
   * The tab's process ended (`signal` is the terminating signal number, else null). `gen` is that
   * process's TabInfo.gen, so an exit is never applied to a later process of the same tab.
   */
  'tabs.exit': { tabId: string; code: number; signal: number | null; gen: number }
  /**
   * main closed the tab on its own: its process `gen` exited cleanly and the `tabExit` setting
   * closes such tabs. Sent instead of `tabs.exit`; the tab is gone in main, as after `tabs.close`.
   * Also how the window's other views hear of a `tabs.close` one view made (router.ts).
   */
  'tabs.removed': { tabId: string; gen: number }
  /**
   * Another view of the window moved a tab (`tabs.reorder`): `toIndex` is the place main gave it in
   * the project's order, already clamped. The view that moved it has the change from its reply.
   */
  'tabs.moved': { tabId: string; toIndex: number }
  /** The update notice's state changed (a check found a release, a dismissal, the setting). Every window. */
  'updates.changed': UpdateState
  /** Connected devices or a risky choice changed (desktop windows only; never sent to a remote view). */
  'webAccess.changed': WebAccessIndicator
  /**
   * This view's theme changed (a pick, the OS appearance or the browser's, a plugin theme added or
   * removed). Per view: each view gets its own resolved theme, and only when it moved.
   */
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
  /**
   * An in-page notice (`ctx.notify`, `ccc notify`, server mode only: notifier.ts PageNoticeBackend,
   * design-web.md §9.9), to the browser views of its window (every window for an app-wide one), never
   * the hidden page. Shared like an ask: the first click or ✕ in any view ends it, and `notices.gone`
   * takes it down in the others. Plain text, cut by main to the ctx.notify limits (shared/notify.ts).
   */
  'notices.show': PageNotice
  /** A `notices.show` is over (clicked or dismissed in some view, timed out, pushed out by the cap). */
  'notices.gone': { requestId: string }
  /** This window's view of the Claude tabs (see SessionsSnapshot); throttled to 10 per second. */
  'sessions.snapshot': SessionsSnapshot
  /**
   * A plugin asks to close this Claude tab of the window (ctx.sessions.close): run the person's own
   * close (the dialog when it is running and the setting asks), then answer `sessions.closeAnswer`
   * with the same `requestId`, `closed: false` on Cancel or when the close could not be asked. The
   * view never closes the tab itself: main does, on the winning `closed: true`.
   */
  'sessions.closeAsk': { requestId: string; tabId: string }
  /**
   * A `sessions.closeAsk` of this window is over (answered in some view, or dropped): a view still
   * showing its dialog takes it down without answering. Sent to every view of the window.
   */
  'sessions.closeSettled': { requestId: string }
  /**
   * `ccc plugin link` asks to link a plugin folder (design-web.md §6.1, plan Task 25): shown as an in-page
   * dialog on every view of the window while a browser view is attached, first answer wins (a browser
   * may only Deny; Allow is the desktop's). The strings
   * are display-safe (linkDialogInfo). With no browser view attached the native dialog is used and this is not sent.
   */
  'links.ask': { requestId: string; id: string; name: string; path: string; caller: 'tab' | 'project' }
  /** A `links.ask` is over (answered in some view, or dropped): a view still showing it takes it down. */
  'links.settled': { requestId: string }
  /**
   * ctx.files.trash asks to move a project entry to the Trash (files/trash-asks.ts): shown as an
   * in-page dialog on every view of the window in server mode, or on the desktop while a browser view
   * is attached; first answer wins. `path` (relative to the project) and `pluginId` are display-safe
   * plain text. With no browser view on the desktop the native box is used and this is not sent.
   */
  'trash.ask': { requestId: string; path: string; kind: 'file' | 'folder'; pluginId: string }
  /** A `trash.ask` is over (answered in some view, timed out or dropped): a view still showing it takes it down. */
  'trash.settled': { requestId: string }
  /**
   * A link a remote view's page or plugin asked to open (`app.openExternal`, `ctx.openExternal`, the release page):
   * the host's browser is not the person's screen, so the view shows a clickable notice (design-web.md §6.1).
   * Sent only to the view that asked; `url` is http(s), checked by main. In server mode a link with no
   * asking view goes to every browser view of its window, and a plugin's OAuth sign-in carries `signIn`
   * (§9.9): the notice then has a box for the address the redirect ended on (`oauth.paste`).
   * `replayed`: set by the web bridge only, on a pending sign-in handed to a shell mounted after the
   * notice came (a reconnect's `ready`, `WebSnapshot.signIns`); such a notice is shown, never opened
   * at once (the click that may be active then was not for this link). Main never sends it.
   */
  'app.linkNotice': { url: string; signIn?: string; replayed?: true }
  /**
   * A plugin's sign-in named by an `app.linkNotice`'s `signIn` is over, however it ended (server mode,
   * design-web.md §9.9): sent to every browser view of its window. `finished` when the redirect brought a
   * code (a paste in any view, or the loopback): the notice goes. Otherwise (timed out, the attempt
   * limit, replaced, cancelled, the provider's refusal) the notice says the sign-in is over instead of
   * keeping a box whose every paste is refused.
   */
  'oauth.signInEnded': { signIn: string; finished: boolean }
  /**
   * A plugin's settings page moved (design-web.md §5.4): `viewId` and `device` name the view that
   * holds it now, both null when no view does (the page closed). A view showing the page that is
   * not the holder any more shows "Open on <device> — Take over" in its place.
   */
  'settingsPage.held': { pluginId: string; viewId: string | null; device: string | null }
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
   * Also how the window's other views hear of a tab one view created, restarted or flagged
   * (router.ts): the page merges it by id and generation, so a known tab is updated in place.
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
   * Server mode: a streamed page's cursor changed; to the panel's viewers only. `cursor` is a CSS
   * cursor from main's fixed table (shared/webview-keys.ts), never the page's text.
   */
  'webviews.cursor': { panelKey: string; cursor: string }
  /**
   * Server mode: the streamed page's selection after this view's input changed it (debounced,
   * deduplicated), to that view only, for its `copy` event. Control characters but \n and \t
   * stripped, at most ~256 KB encoded (main/webview/webview-input.ts); '' when nothing is selected.
   */
  'webviews.selection': { panelKey: string; text: string }
  /**
   * Server mode: a press of this view landed on a `<select>` of the streamed page, whose popup the
   * page does not paint (design-web-browser.md §4.4); the press did not reach the page. The browser
   * draws its own dropdown at `rect` (page CSS px) and answers `webviews.selectChoose` with `id`. At
   * most 500 options, labels capped (main/webview/select-hit.ts); to the clicking view only.
   */
  'webviews.select': { panelKey: string; id: string; options: WebviewSelectOption[]; selected: number; rect: WebviewSelectRect }
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
  'projects.close',
  'projects.relink',
  'projects.forget',
  'app.openExternal',
  'updates.state',
  'updates.setEnabled',
  'updates.dismiss',
  'updates.openRelease',
  'theme.get',
  'theme.scheme',
  'prefs.get',
  'sessions.list',
  'sessions.cancelQueued',
  'sessions.closeAnswer',
  'links.answer',
  'trash.answer',
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
  'settings.marketplaceUpdateAll',
  'settings.marketplaceRefresh',
  'settings.marketplacePreview',
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
  'settings.statusLineUsageSet',
  'settings.discussPromptSet',
  'settings.projectDiscussPromptSet',
  'settings.notificationSoundsSet',
  'settings.notificationSoundOptions',
  'settings.notificationSoundSet',
  'notify.soundData',
  'notices.click',
  'notices.dismiss',
  'oauth.paste',
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
  'settings.webAccess',
  'settings.webAccessSet',
  'settings.webAccessLink',
  'settings.webAccessRegenerate',
  'settings.webAccessAddDevice',
  'settings.webDeviceDisconnect',
  'settings.webDeviceRevoke',
  'settings.webDevicesRevokeAll',
  'settings.webAccessSetPassword',
  'webAccess.state',
  'webAccess.confirmAnswer',
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
  'overlays.take',
  'overlays.button',
  'overlays.discuss',
  'webviews.placement',
  'webviews.step',
  'webviews.current',
  'webviews.place',
  'webviews.fit',
  'webviews.input',
  'webviews.insertText',
  'webviews.selectChoose',
  'tabs.list',
  'tabs.create',
  'tabs.commands',
  'tabs.close',
  'tabs.reorder',
  'tabs.rename',
  'tabs.flag',
  'tabs.toggleFlag',
  'tabs.restart',
  'tabs.input',
  'tabs.resize',
  'tabs.fit',
  'tabs.visibility',
  'tabs.ack',
  'tabs.screen',
  'tabs.selected'
] as const satisfies readonly InvokeChannel[]

/** Every main -> renderer event channel, for the preload's allow-list (see INVOKE_CHANNELS). */
export const EVENT_CHANNELS = [
  'tabs.data',
  'tabs.screenAsk',
  'tabs.typed',
  'tabs.exit',
  'tabs.removed',
  'tabs.moved',
  'theme.changed',
  'updates.changed',
  'webAccess.changed',
  'prefs.changed',
  'notify.chime',
  'notices.show',
  'notices.gone',
  'sessions.snapshot',
  'sessions.closeAsk',
  'sessions.closeSettled',
  'links.ask',
  'links.settled',
  'trash.ask',
  'trash.settled',
  'app.linkNotice',
  'oauth.signInEnded',
  'settingsPage.held',
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
  'webviews.cursor',
  'webviews.selection',
  'webviews.select',
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

/**
 * What a remote view (a browser signed in through web access, docs/design-web.md §2.3) may do with
 * a channel:
 * - `yes`: the same as the desktop view. A signed-in device is the person at the keyboard (§4), so
 *   ordinary project work is allowed: tabs, terminals, panels, overlays, plugin settings, marketplace
 *   installs.
 * - `no`: refused for a remote caller before any handler runs (an invoke), never sent to a remote
 *   view (an event). For what needs the host's own screen (native dialogs, window controls, the
 *   picker window, `WebContentsView`s) and for anything that would let a remote view widen its own
 *   access or change what the app trusts.
 * - `adapted`: allowed, but the handler answers a remote caller differently (design §6.1: a link
 *   opens as a notice in the view, not in the host's browser). The handler decides by the caller
 *   main bound, never by the payload.
 */
export type RemoteClass = 'yes' | 'no' | 'adapted'

/**
 * The remote class of every invoke and event channel. Typed over both maps, so a channel added to
 * either without a class, or a class for a name that is no channel, fails to compile; a unit test
 * (ipc-remote-class.test.ts) checks the same against the runtime lists. Classify conservatively: a
 * wrong `no` only sends the person to the desktop, a wrong `yes` exposes the host.
 *
 * One name is both an invoke and an event channel (`overlays.message`, a page's post up and the
 * opener's post down); it has one class, which must fit both directions.
 */
export const REMOTE_CLASS: Readonly<Record<InvokeChannel | EventChannel, RemoteClass>> = Object.freeze({
  // Window and picker. The gateway binds a remote view to one project window (design §4), so it is
  // never the picker window: the picker's own channels are `no` (the web shell lists open windows
  // itself, from the gateway). Reopen and full screen act on the host's window.
  'window.info': 'yes',
  'window.reopen': 'no',
  'window.state': 'no',
  'projects.recent': 'no',
  // Native folder dialog on the host's screen.
  'projects.openFolder': 'no',
  'projects.openRecent': 'no',
  // Opens the native picker window on the host, as a modal child of the desktop window.
  'projects.showPicker': 'no',
  'projects.closePicker': 'no',
  // Server mode's Close project (§9.8): main closes the window it bound the caller to, refused unless
  // main runs as a server and the caller is a remote view (main's flag and `view.remote`, never the
  // payload). On the desktop a browser cannot close the host's window.
  'projects.close': 'adapted',
  // Native folder dialog.
  'projects.relink': 'no',
  'projects.forget': 'no',
  'projects.changed': 'no',
  // The host's browser: a remote view gets a clickable notice instead (§6.1).
  'app.openExternal': 'adapted',

  // Update notice. It is not shown in a remote view (§6.1), so its dismissal is desktop-only; the
  // state and the setting stay readable and settable from Settings › General like any app pref.
  'updates.state': 'yes',
  'updates.changed': 'yes',
  'updates.setEnabled': 'yes',
  'updates.dismiss': 'no',
  // Opens main's release URL in the host's browser: a notice in a remote view, like openExternal.
  'updates.openRelease': 'adapted',

  // The theme with no pick follows each view's own screen (design-web.md §5.7): `theme.get` answers
  // by the view main bound to the call and `theme.changed` is sent per view. `theme.scheme` is a
  // browser's own appearance; main takes it only from a remote view (`view.remote`, never the
  // payload), and it can only choose between the two built-ins for that one view, never the
  // desktop's theme or another view's.
  'theme.get': 'adapted',
  'theme.changed': 'adapted',
  'theme.scheme': 'adapted',
  'prefs.get': 'yes',
  'prefs.changed': 'yes',

  // Claude status and plugin close asks (shared asks, first answer wins: plan Task 23).
  'sessions.list': 'yes',
  'sessions.snapshot': 'yes',
  'sessions.cancelQueued': 'yes',
  'sessions.closeAsk': 'yes',
  'sessions.closeSettled': 'yes',
  'sessions.closeAnswer': 'yes',
  // The in-page link confirm is a shared ask like the close ask; the notice goes to the asking view.
  // A remote view's answer may only Deny (its Allow is refused: approving a plugin link is the desktop's).
  'links.answer': 'adapted',
  'links.ask': 'yes',
  'links.settled': 'yes',
  // The Move to Trash confirm is a shared ask too, and any view of the window may answer it (the
  // router passes the sender's window): a trash started from a browser is answered there.
  'trash.answer': 'yes',
  'trash.ask': 'yes',
  'trash.settled': 'yes',
  'app.linkNotice': 'yes',
  'oauth.signInEnded': 'yes',
  'project.updated': 'yes',

  // Zones, commands, plugin panels, slots and settings pages: project work, per view from Task 17.
  'layout.get': 'yes',
  // Sizes and collapsed zones are per view (design-web.md §5.1): main keeps the desktop's and takes
  // only the shared part (placement, order, open) from a remote view's layout.
  'layout.set': 'adapted',
  'layout.updated': 'yes',
  'commands.list': 'yes',
  'commands.run': 'yes',
  'commands.updated': 'yes',
  // A chord typed into a native webview on the desktop: only the view it was typed in runs it.
  'commands.trigger': 'no',
  'panels.connect': 'yes',
  'panels.action': 'yes',
  'panels.reload': 'yes',
  'plugins.restart': 'yes',
  'slots.connect': 'yes',
  'slots.disconnect': 'yes',
  'slots.height': 'yes',
  'settingsPage.info': 'yes',
  'settingsPage.connect': 'yes',
  'settingsPage.disconnect': 'yes',
  'settingsPage.held': 'yes',

  // Settings › Projects. Opening a known project only makes its window on the host (a remote view
  // then picks it in the gateway's list); relink is a native folder dialog.
  'settings.projects': 'yes',
  'settings.projectOpen': 'yes',
  'settings.projectRelink': 'no',
  'settings.projectRemove': 'yes',

  // Settings › Plugins and the marketplace (design §2.3: plugin settings, browsing and installs are
  // project work). Secret fields are write-only in both saves (SecretFieldsView says only `set`, and why one cannot be read).
  'settings.plugins': 'yes',
  'settings.pluginInstall': 'yes',
  // Native folder dialog.
  'settings.pluginLink': 'no',
  'settings.pluginUpdate': 'yes',
  'settings.pluginUninstall': 'yes',
  'settings.pluginBundledOff': 'yes',
  'settings.pluginServices': 'yes',
  'settings.pluginServiceProvider': 'yes',
  'settings.marketplace': 'yes',
  'settings.marketplaceInstall': 'yes',
  'settings.marketplaceUpdate': 'yes',
  'settings.marketplaceUpdateAll': 'yes',
  'settings.marketplaceRefresh': 'yes',
  'settings.marketplacePreview': 'yes',
  // The index list is the app's trust root for the marketplace (which listings appear as checked
  // installs, and where revocations come from), not project work: changed on the desktop only.
  'settings.marketplaceSetUrls': 'no',
  'settings.pluginSettingsSave': 'yes',
  'settings.pluginProjectDefaultsSave': 'yes',

  // Settings › This Project, General, Appearance: the person's own preferences.
  'settings.project': 'yes',
  'settings.projectPluginEnable': 'yes',
  'settings.projectPluginSettingsSave': 'yes',
  'settings.projectPanelMove': 'yes',
  'settings.projectColorSet': 'yes',
  'settings.appearance': 'yes',
  'settings.themeSet': 'yes',
  'settings.keySet': 'yes',
  'settings.tabExitSet': 'yes',
  'settings.claudeTabOnOpenSet': 'yes',
  'settings.sessionGistSet': 'yes',
  'settings.statusLineUsageSet': 'yes',
  'settings.discussPromptSet': 'yes',
  'settings.projectDiscussPromptSet': 'yes',
  'settings.notificationSoundsSet': 'yes',
  'settings.notificationSoundOptions': 'yes',
  'settings.notificationSoundSet': 'yes',
  // On the desktop notifications and their sound stay on the host (§6.1): a remote view never gets
  // the chime (web/connection.ts remoteEvent drops it). In server mode there is no host screen, so the
  // chime and the in-page notices go to the browser views only (§9.9), and a notice is clicked or
  // dismissed from the browser view main bound, for a notice of its own window. The bytes are for the
  // chime and a sound preview in Settings, answered by the caller main bound (Task 25).
  'notify.chime': 'adapted',
  'notify.soundData': 'adapted',
  'notices.show': 'adapted',
  'notices.gone': 'adapted',
  'notices.click': 'adapted',
  'notices.dismiss': 'adapted',
  // A plugin's OAuth sign-in settled by the failed redirect's address (§9.9): a server's browser views
  // only, decided by main's flag and `view.remote`, for a sign-in of the window main bound the view to.
  'oauth.paste': 'adapted',
  'settings.zoneAutoHideSet': 'yes',
  'settings.minTerminalWidthSet': 'yes',
  'settings.confirmTabClose': 'yes',
  'settings.confirmTabCloseSet': 'yes',
  'settings.tabCloseSideSet': 'yes',
  'settings.terminalFontSet': 'yes',
  // Only the host's windows are transparent or blurred; harmless from anywhere.
  'settings.windowBackgroundSet': 'yes',
  'settings.tabCommandsSet': 'yes',
  // The `ccc` link in ~/.local/bin is machine setup outside the app's data dir, done on the desktop.
  // The start-up offer is answered once per launch (ccc-offer.ts), so a remote view must not take
  // it from the desktop window; its "Don't ask again" goes with it. The status stays readable.
  'settings.cccStatus': 'yes',
  'settings.cccInstall': 'no',
  'settings.cccOfferSet': 'no',
  // Web access. What adds or widens access stays the desktop's (and, in server mode, the server
  // shell's `ccc web`) in both modes: a remote view that could read the access link, mint a one-time
  // one, set the password or change the mode, bind or host list would widen its own access (§4.1).
  'settings.webAccessSet': 'no',
  'settings.webAccessLink': 'no',
  'settings.webAccessRegenerate': 'no',
  'settings.webAccessAddDevice': 'no',
  'settings.webAccessSetPassword': 'no',
  // A browser answering its own sign-in request would let itself in.
  'webAccess.confirmAnswer': 'no',
  // The card's read side and the narrowing calls (design-web.md §9.4, §9.6): open to a remote view
  // only when main runs as a server, where every signed-in device is the owner and a lost phone must
  // be revocable with no SSH at hand; decided by main's flag and `view.remote`, never the payload
  // (router.ts registerWebAccessHandlers). On the desktop a browser is refused, as before. The view
  // holds no link or token; the indicator to a browser never carries a confirm request
  // (`remoteIndicator`), and the event reaches a browser only in server mode (web/connection.ts).
  'settings.webAccess': 'adapted',
  'settings.webDeviceDisconnect': 'adapted',
  'settings.webDeviceRevoke': 'adapted',
  'settings.webDevicesRevokeAll': 'adapted',
  'webAccess.state': 'adapted',
  'webAccess.changed': 'adapted',
  'ccc.offer': 'no',

  // Overlays. URL overlays are a WebContentsView on the host's window (a placeholder remotely, §6.1),
  // so placing one is desktop-only; terminal and html overlays are project work (Tasks 23-24).
  'overlays.list': 'yes',
  'overlays.updated': 'yes',
  'overlays.close': 'yes',
  'overlays.input': 'yes',
  'overlays.resize': 'yes',
  'overlays.ack': 'yes',
  'overlays.data': 'yes',
  'overlays.bounds': 'no',
  'overlays.result': 'yes',
  'overlays.message': 'yes',
  'overlays.ready': 'yes',
  'overlays.loaded': 'yes',
  'overlays.take': 'yes',
  'overlays.button': 'yes',
  'overlays.discuss': 'yes',

  // Webview panels: a WebContentsView in the host's window ("available on the desktop", §6.1).
  'webviews.placement': 'no',
  // The toolbar (design-web-browser.md §3.5): a server's browser views get it for the streamed page;
  // a remote view outside server mode is refused by the handler (step, current) and gets no event
  // (web/connection.ts remoteEvent), so on the desktop it stays the host's alone.
  'webviews.step': 'adapted',
  'webviews.current': 'adapted',
  'webviews.navigated': 'adapted',
  // Server mode's streamed webviews (design-web-browser.md §3.2): a browser view's own placement and
  // "Fit to this screen". Taken only when main runs as a server and the caller is a remote view
  // (main's flag and the view main bound), the panel key resolved through the caller's own window's
  // layout; the desktop page and the hidden page are refused (they place native views, or none).
  'webviews.place': 'adapted',
  'webviews.fit': 'adapted',
  // Input into the streamed page and its cursor (§4.1): taken only in server mode from a remote view
  // that is a viewer of the panel now (the panel through the caller's own window, the view main's);
  // the cursor goes to those viewers only (ViewRegistry.toView) and to no remote view outside server
  // mode (web/connection.ts remoteEvent).
  'webviews.input': 'adapted',
  'webviews.cursor': 'adapted',
  // Text and the selection (§4.2): the same gate as `webviews.input`; the selection goes only to the
  // view whose input changed it (ViewRegistry.toView) and to no remote view outside server mode.
  'webviews.insertText': 'adapted',
  'webviews.selection': 'adapted',
  // `<select>` popups (§4.4): the popup goes only to the view whose press hit the select
  // (ViewRegistry.toView) and to no remote view outside server mode; its answer takes the same gate as
  // `webviews.input` and only the id main gave that view.
  'webviews.select': 'adapted',
  'webviews.selectChoose': 'adapted',

  // Tabs and terminals. Input from a remote view is the person typing (`typed` and the send gate
  // apply unchanged, Task 16); the flag is the person's, and a remote view is the person.
  // A remote view's terminal stream is its own (design-web.md §5.2, web/view-terminals.ts): its
  // `tabs.list` is the plain list (never the desktop's re-attach), its ack counts for that view only,
  // its selection joins the tab's stream, and its output comes as term.* frames (the bridge hands
  // them to the shell as `tabs.data`), so the `tabs.data` event itself is not sent to it.
  'tabs.list': 'adapted',
  'tabs.create': 'yes',
  'tabs.commands': 'yes',
  'tabs.close': 'yes',
  'tabs.reorder': 'yes',
  'tabs.rename': 'yes',
  'tabs.flag': 'yes',
  'tabs.toggleFlag': 'yes',
  'tabs.restart': 'yes',
  'tabs.input': 'yes',
  'tabs.resize': 'yes',
  // Sizes are per view (the router passes the CallView's id); the same rule for every view.
  'tabs.fit': 'yes',
  'tabs.visibility': 'yes',
  'tabs.ack': 'adapted',
  'tabs.selected': 'adapted',
  'tabs.data': 'adapted',
  // The desktop page seeds web access's copy of a tab from its own screen: asked of the desktop view
  // only, and only its answer is taken (a browser's would let it put what it likes on the other views).
  'tabs.screen': 'no',
  'tabs.screenAsk': 'no',
  // Who typed last, for every view of the window (each tells whether that was itself).
  'tabs.typed': 'yes',
  'tabs.exit': 'yes',
  'tabs.removed': 'yes',
  'tabs.moved': 'yes',
  'tabs.select': 'yes',
  'tabs.added': 'yes'
})

/**
 * The remote class of a channel name from anywhere (a socket frame is untrusted text). A name that
 * is not an own key of REMOTE_CLASS is `no`: `hasOwn`, not `in` or a plain lookup, so `toString`,
 * `__proto__` or `constructor` never resolve to something inherited.
 */
export function remoteClassOf(channel: string): RemoteClass {
  return Object.hasOwn(REMOTE_CLASS, channel) ? REMOTE_CLASS[channel as InvokeChannel | EventChannel] : 'no'
}

/** Whether a remote view may call (or be sent) this channel at all: `yes` and `adapted`. Unknown is no. */
export function remoteAllowed(channel: string): boolean {
  return remoteClassOf(channel) !== 'no'
}

