// What a plugin host may ask of main for sessions, badges and overlays (plan Task 27; design §5
// Host API: sessions, UI). One HostApi exists per host PROCESS: host-manager.ts builds it when it
// spawns the host and closes over the project and window main spawned that process for. Nothing in
// a request names a project or window, and every id a request does name (a tab, a panel, a plugin)
// is only looked up inside that scope (CLAUDE.md: main is the only authority):
//
//   sessions.list   { pluginId?, scope? }      -> SessionInfo[]  this project's Claude tabs only;
//                                                                `scope: 'all'`: SessionSummary[] of every
//                                                                window, only for a plugin whose manifest
//                                                                declares `access.sessions: 'all-windows'`
//   sessions.focus  { pluginId, tabId }        -> boolean        select a Claude tab of ANY window, raising it
//   sessions.close  { pluginId, tabId }        -> { closed }     a Claude tab of THIS project, through the
//                                                                person's close path (the dialog may ask)
//   sessions.openFile { pluginId, tabId, path } -> null          a file main recorded for a tab of THIS
//                                                                project, routed like the panel's click
//   sessions.rename { pluginId, tabId, name }  -> null           name (1-60 chars, no control/bidi/format chars) or
//                                                                null for Claude's title; a tab of THIS project
//   sessions.send   { pluginId, tabId, text }  -> SendResult     a tab of THIS project, through the gate
//   sessions.open   { pluginId, cwd?, prompt?, focus?, model?, effort? } -> { tabId }  a new Claude tab in this project;
//                                                                `focus: true` selects it in the window
//   badge           { pluginId, panelId, value}-> null           a panel the plugin itself declares
//   panels.show     { pluginId, panelId }      -> null           a panel the plugin itself declares (any kind)
//   panels.header   { pluginId, panelId, header } -> null        the title bar of a panel the plugin itself
//                                                                declares (any kind), checked again here
//                                                                (shared/panel-header.ts); null clears it
//   slots.available { pluginId, type }                    -> boolean  whether a provider would draw a slot of
//                                                                `type` here now (ctx.slots.available)
//   panels.slots    { pluginId, panelId, placements } -> null    slot placements in the column of a panel the
//                                                                plugin itself declares, each type one that
//                                                                panel's manifest `slots` lists and not an
//                                                                app slot type, checked again here
//                                                                (shared/slots.ts); null clears them. The
//                                                                layout service resolves the providers.
//   overlay.open    { pluginId, spec, handle? } -> OverlayResult on this project's window; `handle`
//                                                                (ctx.overlay.start) names the overlay
//                                                                in the three calls below
//   overlay.post    { pluginId, handle, message } -> boolean     to that html overlay's page
//   overlay.close   { pluginId, handle }       -> boolean        dismiss it (false: it already ended)
//   overlay.focus   { pluginId, handle }       -> boolean        bring it to the top of the window's stack
//   overlay.setButtons { pluginId, handle, buttons } -> boolean  replace that overlay's opener buttons
//                                                                (checked again, shared/overlay-buttons.ts)
//   overlay.discussPrimary { pluginId, handle, on } -> boolean   Discuss drawn as the primary button or not
//   overlay.discussable { pluginId, handle, on } -> boolean      that overlay's opener has an onDiscuss
//                                                                handler now (on) or no more: Discuss shows
//   secrets.get     { pluginId, key }          -> string | null  the plugin's app-wide secret store
//   secrets.set     { pluginId, key, value }   -> null           (plugin-secrets.ts: limits, the
//   secrets.delete  { pluginId, key }          -> null            reserved `setting:` prefix,
//   secrets.keys    { pluginId }               -> string[]        encryption; ctx.secrets)
//   appStorage.get  { pluginId, key }          -> { value } | null  the plugin's app-wide KV store
//   appStorage.set  { pluginId, key, value }   -> null              (app-storage.ts: one file per
//   appStorage.delete { pluginId, key }        -> null               plugin, the same key rules and
//   appStorage.keys { pluginId }               -> string[]           caps as ctx.storage; every call
//   appStorage.increment { pluginId, key, by? } -> number            applied whole, one at a time,
//                                                                     so increment is atomic across
//                                                                     windows; ctx.appStorage)
//   oauth.authorize { pluginId, spec }         -> OAuthTokens    browser + loopback + PKCE (plugin-oauth.ts)
//   oauth.refresh   { pluginId, spec, refreshToken } -> OAuthTokens
//   webview.navigate { pluginId, panelId, target } -> null      a webview panel the plugin declares, in this
//   webview.back|forward|reload { pluginId, panelId } -> null    window only (webview-manager.ts decides
//   webview.current { pluginId, panelId }      -> { url, title } what a target may be and where a page may go)
//   files.open      { pluginId, path, tabId? } -> { via }        a project file through the project's open-file
//                                                                pick (open-file.ts routeProjectFile: the path
//                                                                checked against THIS project's folder, a tabId
//                                                                kept only when it is this project's; `via` is
//                                                                'plugin' or 'builtin'); no manifest declaration
//   openExternal    { pluginId, url }          -> null           the system browser on an http(s) link
//                                                                (shared/web-url.ts checkWebUrl: no other
//                                                                scheme, no user:pass@, 2048 chars); the
//                                                                normalized href is what is opened
//   files.reveal    { pluginId, path }         -> null           a project file or folder ('' the project
//   files.openWithSystem { pluginId, path }    -> null            folder, reveal only) handed to the system:
//   files.trash     { pluginId, path }         -> { trashed }     main/files/system-files.ts checks the path
//                                                                against THIS project by its real path,
//                                                                refuses runnable files to openWithSystem,
//                                                                and trash asks the person in this window
//                                                                first (false: they said no)
// events main pushes to the host:
//   sessions        { sessions: SessionInfo[] }                  this project's tabs changed (throttled)
//   sessions.all    { sessions: SessionSummary[] }               any window's Claude tab changed (throttled;
//                                                                only to a host running a plugin with the
//                                                                `access` declaration)
//   webview.navigated { pluginId, panelId, url, title }          a view this host drives committed a page
//   overlay.message { pluginId, handle, message }                that overlay's page posted (not a result)
//   panel.action    { pluginId, panelId, actionId }              a click on a header action this host set
//                                                                (panelAction: current, not busy/disabled)
// requests main makes of the host (overlay toolbar, design-next §3.3; `overlayButtons`, channel onButton):
//   overlay.buttons { key, info }              -> button[]       the type buttons of a typed overlay
//                                                                (each with its plugin id: one of this
//                                                                host's, or the button is refused)
//   overlay.buttonClick { source: 'opener', pluginId, handle, buttonId } | { source: 'type', key,
//                         pluginId, buttonId, info } -> { close } | null   a click, 30 s bound
//   overlay.ended   { key } (event)                              that typed overlay went
//   overlay.discuss { pluginId, handle }       -> { text } | null  Discuss asks the opener for context, 5 s
// and one event the host sends (host-manager routes it to contextDisposed):
//   plugin.disposed { pluginId }                                 that plugin's ctx ended: its ctx.oauth calls,
//                                                                its webviews, its overlays, its panel
//                                                                headers and its slot placements go
//
// `pluginId` must be one of the plugins this host process runs. Plugins sharing a host can post in
// each other's name (host-manager.ts says why that is accepted); the boundary is the project.
//
// Trust boundary for secrets, stated plainly (design §6): main knows which HOST asks, not which
// plugin inside it. Every plugin enabled in one project shares that project's host, so any of them
// can name any other and read, replace or delete its secrets, and since a plugin's store is
// app-wide, that includes the sign-ins it uses in every other project. What main enforces is only
// that the id is one of this host's plugins: a plugin that is not enabled in this project is out
// of reach. Accepted because installed plugins are trusted code that can already `ctx.exec`
// anything as the user (reading the keychain-backed file's plaintext is no harder than that).
// One cut main does make: `secrets.get` of a `setting:project:<id>:*` key (a project's secret
// settings field) is refused unless <id> is this host's project; app-wide `setting:app:*`, the global
// values of project fields (`setting:projectDefault:*`) and this project's keys stay readable, as
// ctx.settings hands this host their plaintext anyway.
//
// Overlay handles: the host picks a random `handle` per ctx.overlay.start and main keys it by
// `<pluginId>/<handle>` in THIS HostApi, so a post or close only finds an overlay this host process
// opened, in its own window, under the plugin id that opened it; the overlay id never leaves main.
// A page's messages go to the channel registered here at open, so to this host and that plugin
// only. Posts made before the overlay exists (the open is still checking the file) wait in the
// handle's queue and go out, in order, once the manager created it.
//
// Overlays end with the plugin ctx that opened them (plan 20261102 Task 5, the user's call): a dev
// reload, an unload (invalid manifest or settings) or a failed activate disposes the ctx inside a
// host that keeps running, so `dispose()` (process gone) never comes for them, and a reviewer page
// of the old copy stayed up talking to nobody. contextDisposed() dismisses every overlay that
// plugin has open or is opening (one AbortController per plugin copy, passed to the manager as the
// overlay's `peerGone`; dispose() aborts them all); the old copy's `result` resolves as dismissed and a
// terminal overlay's program is ended as on ✕. A new controller is made for the next copy's first
// open, which the port puts behind the event, so the new copy's overlays are never caught by it.
//
// Flood limits: a plugin is code the user installed, but a bug (a send in a loop, an overlay per
// tick, a secret set in a loop, a sign-in per tick opening browser tabs) must not bury the user's
// sessions or screen. Each plugin gets its own budget per window, so one noisy plugin does not use
// up the others'. The ctx.oauth budget too: per plugin per project, not app-wide (a plugin enabled
// in two projects gets two), which the design accepts.
//
// A ctx.oauth call belongs to the plugin ctx that made it, and ends with it. The host disposes a
// ctx however it ends (deactivate, an unload or in-place reload, a failed or timed-out activate,
// the host stopping) and then sends the `plugin.disposed` event: contextDisposed() aborts that
// plugin's pending authorize (loopback closed, the call rejected) and its refreshes, and frees its
// one sign-in slot at once for the next copy. The host side rejects the call itself and drops any
// answer that comes later (src/host/ctx/index.ts), so tokens never reach a disposed copy. The port
// keeps order: the event arrives before any request of a copy created after the dispose. Any
// plugin of the host can send it for any other, like every request here (the trust boundary
// above); at worst it cancels that plugin's sign-in. revoke()
// (the window closed, a restart) aborts every pending sign-in too: a process that is stopping may
// never get to dispose its contexts, and a sign-in left listening for its 5 minutes would hand a
// code to a host that is gone.
//
// No Electron import: main wires the registry, tab manager, layout and overlay manager in as
// functions (index.ts), unit tests pass the real pure ones with fakes underneath.
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { RpcHandler } from '../../host/rpc'
import type { OAuthTokens, OverlayResult as PluginOverlayResult, SendResult, SessionInfo, SessionSummary } from '../../sdk/types'
import { DISCUSS_ASK_MS } from '../../shared/discuss'
import { errorText } from '../../shared/error-text'
import type { PanelBadge, PanelHeaderInfo } from '../../shared/ipc'
import { isPanelHeaderIcon, parsePanelHeader, type CleanPanelHeader } from '../../shared/panel-header'
import { isAppSlotType, parseSlotPlacements, SLOT_TYPE_PATTERN, type SlotPlacement } from '../../shared/slots'
import {
  MAX_OVERLAY_MESSAGE_LENGTH,
  OverlayOutbox,
  type OverlayChannel,
  type OverlayResult,
  type OverlayTypeButtons,
  type OverlayTypeQuery
} from '../overlays/overlay-manager'
import {
  MAX_OVERLAY_BUTTONS,
  OVERLAY_CLICK_TIMEOUT_MS,
  parseOverlayButtons,
  type CleanOverlayButton,
  type CleanTypeButton
} from '../../shared/overlay-buttons'
import { checkWebUrl, MAX_PLUGIN_URL_LENGTH } from '../../shared/web-url'
import { prepareText } from '../sessions/send-gate'
import type { SessionChange } from '../sessions/session-registry'
import type { SendOrigin, SessionEntry } from '../sessions/status-reducer'
import { checkOAuthSpec, checkRefreshToken, type PluginOAuthApi } from '../oauth/plugin-oauth'
import type { AppStorageApi } from './app-storage'
import { projectSettingKey, SETTING_KEY_PREFIX, type PluginSecretsApi } from '../secrets/plugin-secrets'
import { checkSessionName } from '../../shared/session-name'
import { checkSessionOptions } from '../../shared/session-options'
import { resolveCwd } from '../tabs/tab-manager'
import { WebviewLoadError, type WebviewManager, type WebviewOwner, type WebviewPage } from '../webview/webview-manager'
import { pluginFileUrl } from './plugin-protocol'
import { resolveInside } from './validate'

/** ctx.sessions.send per plugin: at most this many texts per window. The gate's queue cap (50) also holds. */
export const SEND_WINDOW_MS = 60_000
export const MAX_SENDS_PER_WINDOW = 30
/** ctx.sessions.open per plugin: each one starts a `claude` process. */
export const OPEN_WINDOW_MS = 60_000
export const MAX_OPENS_PER_WINDOW = 5
/**
 * ctx.sessions.focus / close / openFile per plugin (design-next §4.1). focus moves the person's
 * window and selection, close may put a dialog in front of them, openFile opens a viewer or wakes
 * the picked plugin (the `files.open` budget): each is one per click in a real plugin.
 */
export const FOCUS_WINDOW_MS = 10_000
export const MAX_FOCUSES_PER_WINDOW = 10
export const CLOSE_WINDOW_MS = 60_000
export const MAX_CLOSES_PER_WINDOW = 10
export const SESSION_FILE_WINDOW_MS = 10_000
export const MAX_SESSION_FILES_PER_WINDOW = 20
/** ctx.sessions.rename per plugin: a label on the person's tab, a few per click at most. */
export const RENAME_WINDOW_MS = 60_000
export const MAX_RENAMES_PER_WINDOW = 30
/** ctx.overlay.open per plugin: started per window, and open at the same time. */
export const OVERLAY_WINDOW_MS = 60_000
export const MAX_OVERLAYS_PER_WINDOW = 10
export const MAX_OPEN_OVERLAYS = 3
/**
 * ctx.secrets.set/delete per plugin: each one rewrites and fsyncs the whole secrets.json on main's
 * thread (several MB once plugins fill their stores), so a set in a loop would stall the UI and
 * every PTY. A sign-in stores a handful of keys; this is far above any real flow.
 */
export const SECRET_WRITE_WINDOW_MS = 60_000
export const MAX_SECRET_WRITES_PER_WINDOW = 60
/** ctx.oauth.authorize per plugin: each one opens a browser tab. One pending at a time besides: a new one replaces it. */
export const AUTHORIZE_WINDOW_MS = 60_000
export const MAX_AUTHORIZES_PER_WINDOW = 5
/**
 * ctx.oauth.refresh per plugin, in flight at once: each is a request from main (15 s timeout at
 * most). A real plugin refreshes one token at a time; a loop must not pile up sockets in main.
 */
export const MAX_REFRESHES_IN_FLIGHT = 4
/**
 * ctx.webview.navigate per plugin: each one loads a page (and may mint a preview token). A browser
 * plugin navigates once per user action; a loop must not hammer the network or the disk.
 */
export const NAVIGATE_WINDOW_MS = 60_000
export const MAX_NAVIGATES_PER_WINDOW = 60
/** ctx.panels.show per plugin: each real change publishes a layout and fights the user's hide. */
export const PANEL_SHOW_WINDOW_MS = 60_000
export const MAX_PANEL_SHOWS_PER_WINDOW = 30
/** panels.slots: a changed `params` is a new frame identity (a remount), so a loop is bounded. */
export const PANEL_SLOTS_WINDOW_MS = 60_000
export const MAX_PANEL_SLOTS_PER_WINDOW = 60
/**
 * ctx.files.open per plugin: each one may open an overlay (the built-in viewer runs a PTY) or wake
 * the picked plugin. A tree opens one file per click; a loop must not stack viewers on the screen.
 */
export const FILE_OPEN_WINDOW_MS = 10_000
export const MAX_FILE_OPENS_PER_WINDOW = 20
/**
 * ctx.openExternal per plugin: each one puts a tab in the person's browser, outside the app, where
 * a loop is the most intrusive flood of all (and the hardest to clean up). A plugin opens a page on
 * a click; three in 10 s leaves room for a double click and a retry, not for a loop.
 */
export const EXTERNAL_OPEN_WINDOW_MS = 10_000
export const MAX_EXTERNAL_OPENS_PER_WINDOW = 3
/**
 * ctx.files.reveal and ctx.files.openWithSystem per plugin, each its own budget: each one brings
 * another app's window (the file manager, a document's app) in front of the person, the same
 * intrusion as openExternal and the same allowance: a double click and a retry, not a loop.
 */
export const SYSTEM_OPEN_WINDOW_MS = 10_000
export const MAX_REVEALS_PER_WINDOW = 3
export const MAX_SYSTEM_OPENS_PER_WINDOW = 3
/**
 * ctx.files.trash per plugin: each one puts a dialog in front of the person (and only one at a time
 * per window, HostApi.trashing). Ten a minute is a person clearing out files one by one; a loop that
 * nags them until a reflexive click is not.
 */
export const TRASH_WINDOW_MS = 60_000
export const MAX_TRASHES_PER_WINDOW = 10
/** The `setting:` keys of project-scoped secret settings fields (any project). */
const PROJECT_SETTING_PREFIX = `${SETTING_KEY_PREFIX}project:`
/** At most this often the host hears that its project's sessions changed. */
export const SESSIONS_EVENT_INTERVAL_MS = 250

/** main's services, as functions: index.ts defines some of them after the host manager. */
export interface HostApiDeps {
  /** This project's Claude tabs (SessionRegistry.listByProject). */
  listSessions(projectId: string): SessionEntry[]
  /** Any tab's entry (SessionRegistry.get); the scope check is HostApi's. */
  session(tabId: string): SessionEntry | undefined
  /**
   * The Claude tab this project's window shows (SessionRegistry.activeTab), for
   * `SessionInfo.active`. Without it no tab is ever marked active.
   */
  activeTab?(projectId: string): string | undefined
  /**
   * The send gate (SessionRegistry.send): types now only when the tab is waiting, else queues.
   * HostApi always passes `plugin`, so the person's takeover of the tab (SessionEntry.typed)
   * refuses the text and drops it from the queue (send-gate.ts takenOver).
   */
  send(tabId: string, text: string, origin: SendOrigin): { id: string; delivered: boolean }
  /**
   * Every window's Claude tabs from this project's view (SessionRegistry.summariesFor), for
   * `scope: 'all'`. Without it that scope is refused.
   */
  summaries?(projectId: string): SessionSummary[]
  /**
   * Raise the window of any Claude tab and have it select the tab (the strip's click, the router's
   * `sessions.focus`); false for an id that is no Claude tab. Without it ctx.sessions.focus is refused.
   */
  focusTab?(tabId: string): boolean
  /**
   * Close a tab of `projectId` in its window `windowId` through the person's close path (the close
   * dialog when it is running and the setting asks): true once it closed, false on Cancel or when the
   * window could not ask. Without it ctx.sessions.close is refused.
   */
  closeTab?(windowId: number, projectId: string, tabId: string): Promise<boolean>
  /**
   * The Sessions panel's file click (open-file.ts routeOpenFile): false when the tab is not the
   * caller's project's or the file is not one main recorded for it. Without it ctx.sessions.openFile is refused.
   */
  openSessionFile?(caller: { windowId: number; projectId: string }, tabId: string, file: string): Promise<boolean>
  /**
   * Name a tab of `projectId` (TabManager.rename, which checks the name again; the registry and the
   * saved record follow). Without it ctx.sessions.rename is refused.
   */
  renameTab?(projectId: string, tabId: string, name: string | null): void
  /** Subscribe to registry changes (SessionRegistry.onChange); returns the unsubscribe. */
  onSessionsChange(listener: (change: SessionChange) => void): () => void
  /**
   * Start a Claude tab in the project and tell its window (TabManager.create after the login env).
   * The tab manager realpaths `cwd` inside the project folder and passes `prompt` as one argv
   * element after `--` (claude-argv.ts); it throws for anything else. `windowId` is the host's
   * window: the tab is refused when that window closed while the login env was awaited. `focus`:
   * select the tab in that window too (ctx.sessions.open's `focus: true`); else it is only added.
   */
  openTab(
    projectId: string,
    options: { cwd?: string; prompt?: string; model?: string; effort?: string },
    windowId: number,
    focus?: boolean
  ): Promise<{ id: string }>
  /** LayoutService.setBadge: false for a panel the project does not have. */
  setBadge(projectId: string, panelKey: string, badge: PanelBadge | null): boolean
  /**
   * LayoutService.setHeader (ctx.panels.header): false for a panel the project does not have.
   * Without it the request is refused.
   */
  setPanelHeader?(projectId: string, panelKey: string, header: PanelHeaderInfo | null): boolean
  /**
   * LayoutService.setSlots (ctx.panels.slots): false for a panel the project does not have.
   * Without it the request is refused.
   */
  setPanelSlots?(projectId: string, panelKey: string, placements: SlotPlacement[] | null): boolean
  /**
   * HostManager.slotProvider is defined (ctx.slots.available): would a placement of `type` draw
   * now in this project. Without it the answer is false.
   */
  slotAvailable?(projectId: string, type: string): boolean
  /**
   * LayoutService.show (ctx.panels.show): unhide, open, expand its zone; false for a panel the
   * project does not have. Without it the request is refused.
   */
  showPanel?(projectId: string, panelKey: string): boolean
  /**
   * OverlayManager.open (after the login env); `peerGone` dismisses it, `channel` talks with its page,
   * `pluginId` is the opener, in whose folder its buttons' `.svg` icons resolve.
   */
  openOverlay(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel,
    pluginId?: string
  ): Promise<OverlayResult>
  /** OverlayManager.post. Without it (and closeOverlay) ctx.overlay.start's post/close are refused. */
  postOverlay?(windowId: number, overlayId: string, text: string): boolean
  /** OverlayManager.close. */
  closeOverlay?(windowId: number, overlayId: string): boolean
  /** OverlayManager.focus. Without it ctx.overlay.start's focus is refused. */
  focusOverlay?(windowId: number, overlayId: string): boolean
  /** OverlayManager.setButtons (handle.setButtons). Without it the request is refused. */
  setOverlayButtons?(windowId: number, overlayId: string, buttons: CleanOverlayButton[]): boolean
  /** OverlayManager.setDiscussHandler (handle.onDiscuss). Without it the request is refused. */
  setOverlayDiscuss?(windowId: number, overlayId: string, on: boolean): boolean
  /** OverlayManager.setDiscussPrimary (handle.setDiscussPrimary). Without it the request is refused. */
  setOverlayDiscussPrimary?(windowId: number, overlayId: string, on: boolean): boolean
  /** OverlayManager.refreshTypeButtons: a plugin's ctx ended, its type buttons leave the window's toolbars. */
  refreshOverlayButtons?(windowId: number): void
  /** ctx.secrets (PluginSecrets). */
  secrets: PluginSecretsApi
  /** ctx.oauth (PluginOAuth). */
  oauth: PluginOAuthApi
  /** ctx.appStorage (AppStorage, one for the whole app). Without it the appStorage requests are refused. */
  appStorage?: AppStorageApi
  /** ctx.webview (WebviewManager). Without it the webview requests are refused. */
  webview?: Pick<WebviewManager, 'navigate' | 'back' | 'forward' | 'reload' | 'current' | 'destroyPlugin'>
  /**
   * ctx.files.open (open-file.ts routeProjectFile with main's open-file route): `caller` is this
   * host's scope, `path` and `tabId` the plugin's, checked there. Without it files.open is refused.
   */
  openFile?(caller: { windowId: number; projectId: string }, path: string, tabId?: string): Promise<'plugin' | 'builtin'>
  /**
   * ctx.openExternal: hand an already checked http(s) URL to the system browser (shell.openExternal,
   * through a lambda so the e2e recorder that replaces it is seen). Without it openExternal is refused.
   */
  openExternal?(url: string): Promise<void>
  /**
   * ctx.files.reveal / openWithSystem / trash (main/files/system-files.ts SystemFiles): `caller` is
   * this host's scope, `path` the plugin's, checked there. `trash` resolves false when the person
   * said no; `signal` closes its dialog when the host goes. Without it the three are refused.
   */
  systemFiles?: {
    reveal(caller: { windowId: number; projectId: string }, path: unknown): Promise<void>
    openWithSystem(caller: { windowId: number; projectId: string }, path: unknown): Promise<void>
    trash(caller: { windowId: number; projectId: string }, path: unknown, pluginId: string, signal?: AbortSignal): Promise<boolean>
  }
  log?: (message: string) => void
  /** Test knob (default SESSIONS_EVENT_INTERVAL_MS). */
  sessionsIntervalMs?: number
}

/** A plugin this host process runs, as main resolved it from the index. */
export interface HostApiPlugin {
  id: string
  /** The plugin's folder (absolute): html overlays are pages inside it, never outside. */
  dir: string
  /** Panel ids its manifest declares: the only ones it may badge. */
  panels: readonly string[]
  /** The ids in `panels` of kind `webview`: the only ones ctx.webview may drive. Absent is none. */
  webviewPanels?: readonly string[]
  /** Panel id -> its manifest `slots`: the only types ctx.panels.slots may place there. Absent is none. */
  panelSlots?: Readonly<Record<string, readonly string[]>>
  /** The manifest declares `access.sessions: 'all-windows'`: ctx.sessions scope `all`. Absent is false. */
  sessionsAll?: boolean
}

/** Who is asking: fixed when main spawned the host process. */
export interface HostScope {
  projectId: string
  windowId: number
  /** The project folder (absolute): the default cwd of a terminal overlay. */
  projectDir: string
  plugins: readonly HostApiPlugin[]
}

/**
 * How long main waits for a window's type buttons: the host asks every provider at once, each
 * bounded to 500 ms (host/overlay-buttons.ts), so this only covers a host that does not answer.
 */
export const TYPE_BUTTONS_ASK_MS = 2_000

/** A host-chosen overlay handle: a UUID in practice; short and plain so it cannot bloat a key. */
const HANDLE_RE = /^[A-Za-z0-9-]{1,64}$/

/** One ctx.overlay.start of this host: its overlay once created, and what waits for that. */
interface OverlayLink {
  /** Set by the manager's onCreated; undefined while the open is still checking the spec. */
  overlayId?: string
  /** Posts made before the overlay existed. */
  pending: OverlayOutbox
  /** close() came before the overlay existed: it is dismissed as soon as it does. */
  closing: boolean
  /** setButtons() came before the overlay existed: applied as soon as it does (the last one). */
  buttons?: CleanOverlayButton[]
  /** onDiscuss() came before the overlay existed: applied as soon as it does (the last state). */
  discuss?: boolean
  /** setDiscussPrimary() came before the overlay existed: applied as soon as it does (the last one). */
  discussPrimary?: boolean
}

/** A fixed-window counter per key (plugin id): `take` is false once the window's budget is spent. */
export class RateWindow {
  private readonly windows = new Map<string, { start: number; count: number }>()

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  take(key: string, now = Date.now()): boolean {
    let win = this.windows.get(key)
    if (!win || now - win.start >= this.windowMs) {
      // Keys are plugin ids this host runs (checked before), so the map stays small.
      win = { start: now, count: 0 }
      this.windows.set(key, win)
    }
    if (win.count >= this.max) return false
    win.count++
    return true
  }

  /**
   * Give back a token whose call was refused before it did anything (an ended tab, a full queue,
   * a spec the overlay manager rejects): a plugin retrying a refused call must not lock itself
   * out. If the window rolled over in between, the token goes back to the new window; at most one
   * extra per refused call, and a refused call started nothing.
   */
  refund(key: string): void {
    const win = this.windows.get(key)
    if (win && win.count > 0) win.count--
  }
}

/**
 * The plugin-facing view of one tab. Field by field, never a spread: the queue (texts other
 * plugins or the user sent), the exit code, the delivering flag and the project id stay in main.
 * `active` (the window shows this tab) is set only when true, so a list has at most one.
 */
export function sessionInfoOf(e: SessionEntry, active = false): SessionInfo {
  const out: { -readonly [K in keyof SessionInfo]: SessionInfo[K] } = {
    tabId: e.tabId,
    status: e.status,
    cwd: e.cwd,
    notes: [...e.notes],
    files: [...e.files],
    // Always present (false until the person types), unlike `active`: a plugin tells an app that
    // detects the takeover from an older one by `typeof typed === 'boolean'` (Autopilot v2).
    typed: e.typed
  }
  if (e.sessionId !== undefined) out.sessionId = e.sessionId
  if (e.tool !== undefined) out.tool = e.tool
  if (e.lastPrompt !== undefined) out.lastPrompt = e.lastPrompt
  if (e.title !== undefined) out.title = e.title
  if (e.name !== undefined) out.name = e.name
  if (e.gist !== undefined) out.gist = e.gist
  if (e.steps !== undefined) out.steps = { ...e.steps }
  // Read-only for plugins: copied out, and nothing in host-api writes a flag (TabManager.setFlag).
  if (e.flag !== undefined) out.flag = e.flag.note === undefined ? { color: e.flag.color } : { color: e.flag.color, note: e.flag.note }
  if (active) out.active = true
  return out
}

/** `err` with the method in front, kept as the cause (the messages it wraps hold no values). */
function withMethod(what: string, err: unknown): Error {
  return new Error(`${what}: ${errorText(err)}`, { cause: err })
}

/**
 * A checked header as the renderer draws it: a core icon by name, a plugin's .svg as its
 * `cc-plugin://` URL (served only from inside the plugin folder, like a panel icon).
 */
export function headerInfoOf(pluginId: string, header: CleanPanelHeader): PanelHeaderInfo {
  const out: PanelHeaderInfo = {}
  if (header.meta !== undefined) out.meta = header.meta
  if (header.actions) {
    out.actions = header.actions.map((a) => ({
      id: a.id,
      title: a.title,
      ...(isPanelHeaderIcon(a.icon) ? { icon: a.icon } : { iconSrc: pluginFileUrl(pluginId, a.icon) }),
      ...(a.busy ? { busy: true } : {}),
      ...(a.disabled ? { disabled: true } : {})
    }))
  }
  return out
}

/** ctx.badge's value as the layout stores it; throws for anything else. */
export function badgeOf(value: unknown): PanelBadge | null {
  if (value === null) return null
  if (value === 'dot') return { kind: 'dot' }
  // Non-negative, like the host side's checkBadge (ui.ts): a host that bypasses ctx must not
  // depend on the layout clamping a negative count.
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return { kind: 'count', count: value }
  throw new Error('badge: value must be a non-negative number, "dot" or null')
}

/**
 * The `cc-plugin://` URL of one of a plugin's own files for an html overlay. `file` comes from
 * plugin code: a path relative to the plugin folder, realpath'd and required to stay inside it (a
 * `..` or a symlink out is refused), a regular file. The overlay loads it like a panel (Task 28):
 * from the plugin's origin with the plugin's CSP, so it can use its own scripts and the panel SDK,
 * and the protocol handler checks containment again when the page is fetched.
 */
export async function pluginPageSrc(pluginId: string, pluginDir: string, file: unknown): Promise<string> {
  if (typeof file !== 'string' || file === '' || file.includes('\0') || isAbsolute(file)) {
    throw new Error('overlay: file must be a path relative to the plugin folder')
  }
  let root: string
  try {
    root = await realpath(pluginDir)
  } catch {
    throw new Error('overlay: cannot read that file')
  }
  const target = await resolveInside(root, file)
  if (!target.ok) {
    if (target.problem === 'missing') throw new Error('overlay: cannot read that file')
    if (target.problem === 'not-file') throw new Error('overlay: not a regular file')
    throw new Error('overlay: file resolves outside the plugin folder')
  }
  return pluginFileUrl(pluginId, relative(root, target.real))
}

export class HostApi {
  private readonly sends = new RateWindow(MAX_SENDS_PER_WINDOW, SEND_WINDOW_MS)
  private readonly opens = new RateWindow(MAX_OPENS_PER_WINDOW, OPEN_WINDOW_MS)
  private readonly overlayStarts = new RateWindow(MAX_OVERLAYS_PER_WINDOW, OVERLAY_WINDOW_MS)
  private readonly secretWrites = new RateWindow(MAX_SECRET_WRITES_PER_WINDOW, SECRET_WRITE_WINDOW_MS)
  private readonly authorizes = new RateWindow(MAX_AUTHORIZES_PER_WINDOW, AUTHORIZE_WINDOW_MS)
  private readonly navigates = new RateWindow(MAX_NAVIGATES_PER_WINDOW, NAVIGATE_WINDOW_MS)
  private readonly panelShows = new RateWindow(MAX_PANEL_SHOWS_PER_WINDOW, PANEL_SHOW_WINDOW_MS)
  private readonly panelSlotCalls = new RateWindow(MAX_PANEL_SLOTS_PER_WINDOW, PANEL_SLOTS_WINDOW_MS)
  private readonly fileOpens = new RateWindow(MAX_FILE_OPENS_PER_WINDOW, FILE_OPEN_WINDOW_MS)
  private readonly externalOpens = new RateWindow(MAX_EXTERNAL_OPENS_PER_WINDOW, EXTERNAL_OPEN_WINDOW_MS)
  private readonly reveals = new RateWindow(MAX_REVEALS_PER_WINDOW, SYSTEM_OPEN_WINDOW_MS)
  private readonly systemOpens = new RateWindow(MAX_SYSTEM_OPENS_PER_WINDOW, SYSTEM_OPEN_WINDOW_MS)
  private readonly trashes = new RateWindow(MAX_TRASHES_PER_WINDOW, TRASH_WINDOW_MS)
  /**
   * A ctx.files.trash dialog of this host is up: a second request is refused, not queued, so no
   * plugin can stack dialogs the person would click away by reflex (the `ccc plugin link` rule).
   */
  private trashing = false
  private readonly focuses = new RateWindow(MAX_FOCUSES_PER_WINDOW, FOCUS_WINDOW_MS)
  private readonly closes = new RateWindow(MAX_CLOSES_PER_WINDOW, CLOSE_WINDOW_MS)
  private readonly sessionFiles = new RateWindow(MAX_SESSION_FILES_PER_WINDOW, SESSION_FILE_WINDOW_MS)
  private readonly renames = new RateWindow(MAX_RENAMES_PER_WINDOW, RENAME_WINDOW_MS)
  /**
   * Plugins whose webviews this host drove, or whose earlier copy declared webview panels (a dev reload
   * may drop them from the scope before that copy's ctx ends): torn down when their ctx ends (contextDisposed) or the process goes.
   */
  private readonly webviewPlugins = new Set<string>()
  /** pluginId -> its pending ctx.oauth.authorize (aborted by contextDisposed() and revoke()). */
  private readonly signIns = new Map<string, AbortController>()
  /** pluginId -> its ctx.oauth.refresh calls in flight (aborted by contextDisposed(); dispose() via `gone`). */
  private readonly refreshes = new Map<string, Set<AbortController>>()
  /** pluginId -> overlays it has open now. */
  private readonly openOverlays = new Map<string, number>()
  /** `<pluginId>/<handle>` -> its overlay (ctx.overlay.start), while the open is pending. */
  private readonly overlayLinks = new Map<string, OverlayLink>()
  /**
   * pluginId -> the `peerGone` of the overlays its running copy opens: aborted when that ctx ends
   * (contextDisposed) or the process goes (dispose), which dismisses them.
   */
  private readonly overlayCopies = new Map<string, AbortController>()
  /** Panel keys this host badged: cleared when it goes, so a dead plugin leaves no stale count. */
  private readonly badged = new Set<string>()
  /**
   * Panel key -> the header this host set there, as checked: what a click is checked against
   * (panelAction), and what is cleared when the plugin's ctx or the host goes, so no button is
   * left up with nobody to hear it.
   */
  private readonly headers = new Map<string, CleanPanelHeader>()
  /**
   * Panel keys this host placed slots on: cleared, like headers, when the plugin's ctx or the host
   * goes. A placement has no listener of its own, but the frames in it are the host panel's (the
   * design: they live and die with it), and a dead plugin's agenda must not stay drawn.
   */
  private readonly slotted = new Set<string>()
  /** Aborted at dispose: the oauth refreshes in flight end (overlays: `overlayCopies`). */
  private readonly gone = new AbortController()
  private readonly unsubscribe: () => void
  private readonly interval: number
  private readonly log: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  /** The pending `sessions.all` event (its own throttle: other windows' changes do not delay this one's). */
  private allTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Set by revoke() (and dispose()): every request refused, no sessions events. */
  private revoked = false

  constructor(
    private readonly deps: HostApiDeps,
    private scope: HostScope,
    /** A one-way event to this host (its RpcEndpoint.emit). */
    private readonly emit: (event: string, params: unknown) => void,
    /**
     * A request to this host (its RpcEndpoint.call): the toolbar's clicks and the type-button asks.
     * Absent: overlay buttons take no clicks and typed overlays get no type buttons.
     */
    private readonly call?: (method: string, params: unknown, options?: { timeoutMs?: number }) => Promise<unknown>
  ) {
    this.interval = deps.sessionsIntervalMs ?? SESSIONS_EVENT_INTERVAL_MS
    this.log = deps.log ?? ((m) => console.warn(m))
    this.unsubscribe = deps.onSessionsChange((change) => this.sessionsChanged(change))
  }

  /** The RPC methods, to merge into the host's endpoint handlers. */
  get handlers(): Record<string, RpcHandler> {
    return {
      'sessions.list': (params) => this.list(params),
      'sessions.send': (params) => this.send(params),
      'sessions.open': (params) => this.open(params),
      'sessions.focus': (params) => this.focus(params),
      'sessions.close': (params) => this.close(params),
      'sessions.openFile': (params) => this.sessionFile(params),
      'sessions.rename': (params) => this.rename(params),
      badge: (params) => this.badge(params),
      'panels.show': (params) => this.showPanel(params),
      'panels.header': (params) => this.panelHeader(params),
      'panels.slots': (params) => this.panelSlots(params),
      'slots.available': (params) => this.slotAvailable(params),
      'overlay.open': (params) => this.overlay(params),
      'overlay.post': (params) => this.overlayPost(params),
      'overlay.close': (params) => this.overlayClose(params),
      'overlay.focus': (params) => this.overlayFocus(params),
      'overlay.setButtons': (params) => this.overlaySetButtons(params),
      'overlay.discussable': (params) => this.overlayDiscussable(params),
      'overlay.discussPrimary': (params) => this.overlayDiscussPrimary(params),
      'secrets.get': (params) => this.secretsGet(params),
      'secrets.set': (params) => this.secretsSet(params),
      'secrets.delete': (params) => this.secretsDelete(params),
      'secrets.keys': (params) => this.secretsKeys(params),
      'appStorage.get': (params) => this.appStorageCall(params, 'appStorage.get', (store, id, p) => store.get(id, p.key)),
      'appStorage.set': (params) =>
        this.appStorageCall(params, 'appStorage.set', (store, id, p) => {
          store.set(id, p.key, p.value)
          return null
        }),
      'appStorage.delete': (params) =>
        this.appStorageCall(params, 'appStorage.delete', (store, id, p) => {
          store.delete(id, p.key)
          return null
        }),
      'appStorage.keys': (params) => this.appStorageCall(params, 'appStorage.keys', (store, id) => store.keys(id)),
      'appStorage.increment': (params) =>
        this.appStorageCall(params, 'appStorage.increment', (store, id, p) => store.increment(id, p.key, p.by)),
      'oauth.authorize': (params) => this.oauthAuthorize(params),
      'oauth.refresh': (params) => this.oauthRefresh(params),
      'webview.navigate': (params) => this.webviewNavigate(params),
      'webview.back': (params) => this.webviewStep(params, 'back'),
      'webview.forward': (params) => this.webviewStep(params, 'forward'),
      'webview.reload': (params) => this.webviewStep(params, 'reload'),
      'webview.current': (params) => this.webviewCurrent(params),
      'files.open': (params) => this.filesOpen(params),
      openExternal: (params) => this.openExternal(params),
      'files.reveal': (params) => this.filesReveal(params),
      'files.openWithSystem': (params) => this.filesOpenWithSystem(params),
      'files.trash': (params) => this.filesTrash(params)
    }
  }

  /**
   * A plugin of this host was reloaded in place (a linked dev folder changed, Task 29): its folder
   * and panel list may be new, and what it had set up under the old copy goes: its badges are
   * cleared. Only a plugin this host already runs; the scope never grows. The old copy's sign-ins
   * end when the host disposes its ctx (contextDisposed).
   */
  updatePlugin(next: HostApiPlugin): void {
    const prev = this.scope.plugins.find((p) => p.id === next.id)
    if (this.disposed || !prev) return
    // This runs before the host swaps the copies, so the old copy's `plugin.disposed` is checked
    // against the new declarations: a reload that removes the last webview panel would leave the
    // old panel's placement in main, and restoring the panel later would show its first view at
    // those stale bounds while the panel is closed. Remember that it declared some.
    if ((prev.webviewPanels ?? []).length > 0) this.webviewPlugins.add(next.id)
    this.scope = { ...this.scope, plugins: this.scope.plugins.map((p) => (p.id === next.id ? next : p)) }
    for (const key of [...this.badged]) {
      if (!key.startsWith(`${next.id}/`)) continue
      this.badged.delete(key)
      try {
        this.deps.setBadge(this.scope.projectId, key, null)
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: clearing badge ${key} failed: ${errorText(err)}`)
      }
    }
    this.clearHeaders((key) => key.startsWith(`${next.id}/`))
    this.clearSlots((key) => key.startsWith(`${next.id}/`))
  }

  /**
   * The host's `plugin.disposed` event: the plugin's ctx ended, for whatever reason. Its pending
   * sign-in goes (left listening, the loopback would take a consent the user finishes later and
   * exchange the code for a copy that is gone) and so do its refreshes. The entries go now, not in
   * the calls' finally: the next copy's first authorize, right behind this event, must not find
   * the slot taken. Works while revoked (aborting is always safe); an id without calls is a no-op.
   */
  contextDisposed(params: unknown): void {
    const pluginId = (params as { pluginId?: unknown } | null)?.pluginId
    if (typeof pluginId !== 'string') return
    const signIn = this.signIns.get(pluginId)
    this.signIns.delete(pluginId)
    signIn?.abort()
    const refreshes = this.refreshes.get(pluginId)
    this.refreshes.delete(pluginId)
    for (const controller of refreshes ?? []) controller.abort()
    // Its views go with it (the host sends this for a ctx that drove one): a reloaded copy starts
    // from an empty panel, and the old copy's preview tokens stop serving.
    this.destroyWebviews(pluginId)
    // And its overlays (the host sends this for a ctx with one open or opening): the new copy
    // starts clean. An open still checking its file finds the signal aborted and is dismissed as
    // soon as it is created (OverlayManager.start).
    const overlays = this.overlayCopies.get(pluginId)
    this.overlayCopies.delete(pluginId)
    overlays?.abort()
    // Its type buttons on other plugins' overlays: their runs went with the ctx, so the window's
    // toolbars are asked again (a reloaded copy's providers answer the next ask).
    if (!this.revoked) this.deps.refreshOverlayButtons?.(this.scope.windowId)
    // And its panel headers (the host sends this for a ctx that set one): their actions had
    // onAction listeners in that ctx only. Unlike a badge, which is a count the next copy will
    // set again, a stale button would take clicks for nobody. Not once revoked: dispose() clears
    // them then, sparing what a newer host of the project may have set on the same keys.
    if (!this.revoked) this.clearHeaders((key) => key.startsWith(`${pluginId}/`))
    // Its slot placements too: the new copy places its own (design-next §2, "cleared when the host
    // plugin's ctx ends"). Not once revoked, for the same reason.
    if (!this.revoked) this.clearSlots((key) => key.startsWith(`${pluginId}/`))
  }

  /** Whether this host set a badge on `panelKey` that is still showing. */
  hasBadged(panelKey: string): boolean {
    return this.badged.has(panelKey)
  }

  /** Whether this host set a header on `panelKey` that is still showing. */
  hasHeader(panelKey: string): boolean {
    return this.headers.has(panelKey)
  }

  /** Whether this host placed slots on `panelKey` that are still placed. */
  hasSlots(panelKey: string): boolean {
    return this.slotted.has(panelKey)
  }

  /**
   * A click on a header action (the renderer's `panels.action`; the router took the project from
   * the sender, host-manager found this project's host). Delivered to the plugin as `panel.action`
   * only when `panelKey` is a header this host set and `actionId` is one of its actions now, not
   * busy and not disabled: the renderer ignores those clicks too, but main does not trust it, and
   * a click can race the header that just made the action busy. False when dropped.
   */
  panelAction(panelKey: string, actionId: string): boolean {
    if (this.revoked) return false
    const action = this.headers.get(panelKey)?.actions?.find((a) => a.id === actionId)
    if (!action || action.busy || action.disabled) return false
    const slash = panelKey.indexOf('/')
    // Plugin ids hold no slash, so the first one splits the key (the key is ours: set in panelHeader).
    this.emit('panel.action', { pluginId: panelKey.slice(0, slash), panelId: panelKey.slice(slash + 1), actionId })
    return true
  }

  /**
   * The host is being stopped (its window closed, or a restart): from now on every request is
   * refused and no more sessions events go out, while the process may still run its plugins'
   * deactivate() for up to the grace (host-manager DEACTIVATE_GRACE_MS). The requests check only
   * `scope.projectId`, and the project can open a new window meanwhile: a dying host left
   * answered would list, type into and open tabs of THAT window. Overlays and badges stay until
   * dispose(), which runs once the process is gone (a reopened window's host waits for that, so
   * there is nothing newer to protect yet). Idempotent; dispose() still runs in full after it.
   */
  revoke(): void {
    if (this.revoked) return
    this.revoked = true
    this.unsubscribe()
    // Each pending sign-in closes its loopback and rejects (its finally drops the entry).
    for (const controller of this.signIns.values()) controller.abort()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.allTimer !== undefined) clearTimeout(this.allTimer)
    this.allTimer = undefined
  }

  /**
   * The host process is gone (exit, stop, app quit). Stop the sessions events, dismiss the
   * overlays it opened, clear its badges, headers and slot placements, except the ones `keep`
   * (badges), `keepHeader` and `keepSlots` name: a newer host of the same project (its window
   * reopened while this one was deactivating) owns those now. Idempotent.
   */
  dispose(
    keep?: (panelKey: string) => boolean,
    keepHeader?: (panelKey: string) => boolean,
    keepSlots?: (panelKey: string) => boolean
  ): void {
    if (this.disposed) return
    this.revoke()
    this.disposed = true
    this.gone.abort()
    // Every overlay this host opened is dismissed: its opener is gone.
    for (const copy of this.overlayCopies.values()) copy.abort()
    this.overlayCopies.clear()
    // The process is gone, so no `plugin.disposed` will come for its plugins: their views go now.
    // Plugins that declare webview panels too, navigated or not: a panel reports its placement from
    // mount, and main keeps it for the view created later.
    const ids = new Set(this.webviewPlugins)
    for (const p of this.scope.plugins) if ((p.webviewPanels ?? []).length > 0) ids.add(p.id)
    for (const id of ids) this.destroyWebviews(id)
    for (const key of this.badged) {
      if (keep?.(key)) continue
      try {
        this.deps.setBadge(this.scope.projectId, key, null)
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: clearing badge ${key} failed: ${errorText(err)}`)
      }
    }
    this.badged.clear()
    this.clearHeaders((key) => !keepHeader?.(key))
    this.clearSlots((key) => !keepSlots?.(key))
  }

  /** Clear the slot placements this host set on the keys `which` picks (each one also leaves `slotted`). */
  private clearSlots(which: (panelKey: string) => boolean): void {
    for (const key of [...this.slotted]) {
      if (!which(key)) continue
      this.slotted.delete(key)
      try {
        this.deps.setPanelSlots?.(this.scope.projectId, key, null)
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: clearing slots ${key} failed: ${errorText(err)}`)
      }
    }
  }

  /** Clear the headers this host set on the keys `which` picks (each one also leaves `headers`). */
  private clearHeaders(which: (panelKey: string) => boolean): void {
    for (const key of [...this.headers.keys()]) {
      if (!which(key)) continue
      this.headers.delete(key)
      try {
        this.deps.setPanelHeader?.(this.scope.projectId, key, null)
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: clearing header ${key} failed: ${errorText(err)}`)
      }
    }
  }

  // -------------------------------------------------------------------------------------------

  private list(params: unknown): SessionInfo[] | SessionSummary[] {
    this.alive()
    const { pluginId, scope } = (params ?? {}) as Record<string, unknown>
    // Absent or 'window' is the call as it always was (an older host sends no params at all).
    if (scope === undefined || scope === 'window') return this.sessionInfos()
    if (scope !== 'all') throw new Error('sessions.list: scope must be "window" or "all"')
    const plugin = this.plugin(pluginId, 'sessions.list')
    if (plugin.sessionsAll !== true) {
      throw new Error(`sessions.list: scope "all" needs "access": { "sessions": "all-windows" } in ${plugin.id}'s plugin.json`)
    }
    return this.summaries()
  }

  /** Every window's Claude tabs, summaries only (SessionRegistry.summariesFor builds them field by field). */
  private summaries(): SessionSummary[] {
    if (!this.deps.summaries) throw new Error('sessions.list: scope "all" is not available')
    return this.deps.summaries(this.scope.projectId)
  }

  /**
   * ctx.sessions.focus: any window's Claude tab, by design (the top bar strip's click, cockpit.sessions):
   * it only moves the person's focus, reveals nothing and types nothing. main resolves the tab's
   * window from its own registry (focusTab), never from anything in the request.
   */
  private focus(params: unknown): boolean {
    this.alive()
    const { pluginId, tabId } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.focus')
    if (typeof tabId !== 'string') throw new Error('sessions.focus: tabId must be a string')
    if (!this.deps.focusTab) throw new Error('sessions.focus: focusing tabs is not available')
    if (!this.focuses.take(plugin.id)) {
      throw new Error(`sessions.focus: more than ${MAX_FOCUSES_PER_WINDOW} focuses in ${FOCUS_WINDOW_MS / 1000} s`)
    }
    // An id that is no Claude tab moved nothing: it costs nothing either.
    if (this.deps.session(tabId) === undefined || !this.deps.focusTab(tabId)) {
      this.focuses.refund(plugin.id)
      return false
    }
    return true
  }

  /**
   * ctx.sessions.close: only this project's Claude tabs (another project's id reads like an unknown
   * one), and only the way the person closes one: a running tab may ask first in its window, so the
   * answer can be `closed: false` (Cancel). No bypass of the dialog: a plugin is not the person.
   */
  private async close(params: unknown): Promise<{ closed: boolean }> {
    this.alive()
    const { pluginId, tabId } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.close')
    this.ownTab(tabId, 'sessions.close')
    if (!this.deps.closeTab) throw new Error('sessions.close: closing tabs is not available')
    if (!this.closes.take(plugin.id)) {
      throw new Error(`sessions.close: more than ${MAX_CLOSES_PER_WINDOW} closes in ${CLOSE_WINDOW_MS / 1000} s`)
    }
    let closed: boolean
    try {
      closed = await this.deps.closeTab(this.scope.windowId, this.scope.projectId, tabId)
    } catch (err) {
      throw withMethod('sessions.close', err)
    }
    return { closed }
  }

  /**
   * ctx.sessions.openFile: the old Sessions panel's click. Only a tab of this project and only a
   * file main recorded for it (routeOpenFile checks both against its own registry and the window);
   * a refusal spends nothing, so a plugin with a stale list does not lock itself out.
   */
  private async sessionFile(params: unknown): Promise<null> {
    this.alive()
    const { pluginId, tabId, path } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.openFile')
    this.ownTab(tabId, 'sessions.openFile')
    if (typeof path !== 'string' || path === '') throw new Error('sessions.openFile: path must be a non-empty string')
    if (!this.deps.openSessionFile) throw new Error('sessions.openFile: opening files is not available')
    if (!this.sessionFiles.take(plugin.id)) {
      throw new Error(
        `sessions.openFile: more than ${MAX_SESSION_FILES_PER_WINDOW} files in ${SESSION_FILE_WINDOW_MS / 1000} s`
      )
    }
    let opened: boolean
    try {
      opened = await this.deps.openSessionFile({ windowId: this.scope.windowId, projectId: this.scope.projectId }, tabId, path)
    } catch (err) {
      this.sessionFiles.refund(plugin.id)
      throw withMethod('sessions.openFile', err)
    }
    if (!opened) {
      this.sessionFiles.refund(plugin.id)
      throw new Error('sessions.openFile: not a file of that tab')
    }
    return null
  }

  /**
   * ctx.sessions.rename: a tab of this project only (another project's id reads like an unknown one).
   * The rule for the name is shared/session-name.ts; a refusal spends nothing, so a plugin that
   * validates late does not lock itself out.
   */
  private rename(params: unknown): null {
    this.alive()
    const { pluginId, tabId, name } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.rename')
    this.ownTab(tabId, 'sessions.rename')
    const checked = checkSessionName(name)
    if (!checked.ok) throw new Error(`sessions.rename: ${checked.reason}`)
    if (!this.deps.renameTab) throw new Error('sessions.rename: renaming tabs is not available')
    if (!this.renames.take(plugin.id)) {
      throw new Error(`sessions.rename: more than ${MAX_RENAMES_PER_WINDOW} renames in ${RENAME_WINDOW_MS / 1000} s`)
    }
    try {
      this.deps.renameTab(this.scope.projectId, tabId, checked.value)
    } catch (err) {
      this.renames.refund(plugin.id)
      throw withMethod('sessions.rename', err)
    }
    return null
  }

  /**
   * The tab id of a Claude tab of this project, or the one refusal every sessions method gives: another
   * project's id (a guessed or leaked one) reads exactly like a tab that does not exist.
   */
  private ownTab(tabId: unknown, what: string): asserts tabId is string {
    if (typeof tabId !== 'string' || this.deps.session(tabId)?.projectId !== this.scope.projectId) {
      throw new Error(`${what}: unknown tab`)
    }
  }

  /** This project's tabs as plugins see them, the shown one marked (ctx.sessions.list and the event). */
  private sessionInfos(): SessionInfo[] {
    const active = this.deps.activeTab?.(this.scope.projectId)
    return this.deps.listSessions(this.scope.projectId).map((e) => sessionInfoOf(e, e.tabId === active))
  }

  private send(params: unknown): SendResult {
    this.alive()
    const { pluginId, tabId, text } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.send')
    // Another project's tab (a guessed or leaked id) reads exactly like a tab that does not exist.
    this.ownTab(tabId, 'sessions.send')
    // Validated before the budget is spent: a refused text (a "/" command) costs nothing.
    const clean = prepareText(text)
    if (!this.sends.take(plugin.id)) {
      throw new Error(`sessions.send: more than ${MAX_SENDS_PER_WINDOW} texts in ${SEND_WINDOW_MS / 1000} s`)
    }
    // The gate is the only way in: typed now only while the tab waits for input, else queued.
    // It throws before queueing anything (an ended session, a full queue, a tab the person took
    // over: "the person is typing in this tab"): no text, no cost. Every text from here is a
    // plugin's, whatever the plugin says it is: the origin is main's to state, never the host's.
    let result: { id: string; delivered: boolean }
    try {
      result = this.deps.send(tabId, clean, 'plugin')
    } catch (err) {
      this.sends.refund(plugin.id)
      throw err
    }
    return result.delivered ? { delivered: true } : { queued: true, itemId: result.id }
  }

  private async open(params: unknown): Promise<{ tabId: string }> {
    this.alive()
    const { pluginId, cwd, prompt, focus, model, effort } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.open')
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error('sessions.open: cwd must be a string')
    if (focus !== undefined && typeof focus !== 'boolean') throw new Error('sessions.open: focus must be a boolean')
    // Closed lists (shared/session-options.ts), checked before the budget is spent; the values end up
    // as `--model` / `--effort` argv elements, so nothing outside the lists gets that far.
    const checked = checkSessionOptions({ model, effort })
    if (!checked.ok) throw new Error(`sessions.open: ${checked.reason}`)
    // Checked here too, before the budget is spent, so a bad cwd costs nothing; the tab manager
    // checks it again (same rule) when it spawns.
    try {
      resolveCwd(this.scope.projectDir, cwd || undefined)
    } catch (err) {
      throw new Error(`sessions.open: ${errorText(err)}`, { cause: err })
    }
    // The prompt is an argv element, never typed, so no paste framing is at stake; it gets the
    // gate's rules anyway: control bytes out, a size cap, and no leading "/", "!", "#" or "&" (Claude
    // would act on it as a slash command, bash-mode line, memory or background prompt, like typed
    // input). Empty means none.
    let text: string | undefined
    if (prompt !== undefined && prompt !== '') {
      try {
        text = prepareText(prompt)
      } catch (err) {
        throw new Error(`sessions.open: prompt: ${errorText(err)}`, { cause: err })
      }
    }
    if (!this.opens.take(plugin.id)) {
      throw new Error(`sessions.open: more than ${MAX_OPENS_PER_WINDOW} tabs in ${OPEN_WINDOW_MS / 1000} s`)
    }
    const tab = await this.deps.openTab(
      this.scope.projectId,
      {
        ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
        ...(text !== undefined ? { prompt: text } : {}),
        ...(checked.model ? { model: checked.model } : {}),
        ...(checked.effort ? { effort: checked.effort } : {})
      },
      this.scope.windowId,
      // Only the host's own window, the one the tab opens in, is ever told to select it: a plugin
      // can move the selection there (as its Discuss click means to), never in another project.
      focus === true
    )
    return { tabId: tab.id }
  }

  private badge(params: unknown): null {
    this.alive()
    const { pluginId, panelId, value } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'badge')
    // Only the plugin's own declared panels: a panel id of another plugin, or a core panel, is
    // not in this list whatever the request says.
    if (typeof panelId !== 'string' || !plugin.panels.includes(panelId)) {
      throw new Error(`badge: ${plugin.id} declares no panel "${String(panelId)}"`)
    }
    const badge = badgeOf(value)
    const key = `${plugin.id}/${panelId}`
    if (!this.deps.setBadge(this.scope.projectId, key, badge)) throw new Error(`badge: no panel ${key} in this window`)
    if (badge) this.badged.add(key)
    else this.badged.delete(key)
    return null
  }

  /**
   * ctx.panels.header: the title bar of one of the plugin's own declared panels (either kind), in
   * this host's project. The host checked the header already (ui.ts); it is checked again here
   * with the same rule (shared/panel-header.ts), because a host is not trusted to have used ctx.
   * No budget: an unchanged header publishes nothing (LayoutService.setHeader), and a changed one
   * is one small layout push, like a badge.
   */
  private panelHeader(params: unknown): null {
    this.alive()
    const { pluginId, panelId, header } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'panels.header')
    // Only the plugin's own declared panels, as for badge: never another plugin's or a core panel.
    if (typeof panelId !== 'string' || !plugin.panels.includes(panelId)) {
      throw new Error(`panels.header: ${plugin.id} declares no panel "${String(panelId)}"`)
    }
    if (!this.deps.setPanelHeader) throw new Error('panels.header: panel headers are not available')
    let clean: CleanPanelHeader | null
    try {
      clean = parsePanelHeader(header)
    } catch (err) {
      // The message already names panels.header and the limit; an Error like every refusal here.
      throw new Error(errorText(err), { cause: err })
    }
    const key = `${plugin.id}/${panelId}`
    const info = clean ? headerInfoOf(plugin.id, clean) : null
    if (!this.deps.setPanelHeader(this.scope.projectId, key, info)) throw new Error(`panels.header: no panel ${key} in this window`)
    if (clean) this.headers.set(key, clean)
    else this.headers.delete(key)
    return null
  }

  /**
   * ctx.panels.slots: placements in the column of one of the plugin's own declared panels, in this
   * host's project (design-next §2 "Main enforces"). The host checked them already (ui.ts); checked
   * again here with the same rule (shared/slots.ts parseSlotPlacements: the cap of 4, the height
   * clamp, `params` plain JSON of at most 4 KiB), and each type against the panel's manifest
   * `slots`, which never lists an app slot type (validate.ts) but is refused here by name all the
   * same: the top bar is the app's. Who draws each placement is the layout service's question,
   * asked at every view, so a pick made later needs no new call. The
   * same placements again publish nothing. A changed `params` is a new frame identity, though
   * (the provider's frame remounts), so the call has a per-plugin budget like panels.show.
   */
  private panelSlots(params: unknown): null {
    this.alive()
    const { pluginId, panelId, placements } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'panels.slots')
    // Only the plugin's own declared panels, as for headers: never another plugin's or a core panel.
    if (typeof panelId !== 'string' || !plugin.panels.includes(panelId)) {
      throw new Error(`panels.slots: ${plugin.id} declares no panel "${String(panelId)}"`)
    }
    if (!this.deps.setPanelSlots) throw new Error('panels.slots: slots are not available')
    const clean = parseSlotPlacements(placements)
    if (!this.panelSlotCalls.take(plugin.id)) {
      throw new Error(`panels.slots: more than ${MAX_PANEL_SLOTS_PER_WINDOW} calls in ${PANEL_SLOTS_WINDOW_MS / 1000} s`)
    }
    const declared = Object.hasOwn(plugin.panelSlots ?? {}, panelId) ? (plugin.panelSlots?.[panelId] ?? []) : []
    for (const p of clean ?? []) {
      if (isAppSlotType(p.type)) throw new Error(`panels.slots: "${p.type}" is placed by the app, not by a panel`)
      if (!declared.includes(p.type)) throw new Error(`panels.slots: panel ${panelId} of ${plugin.id} does not list slot "${p.type}" in its manifest`)
    }
    const key = `${plugin.id}/${panelId}`
    if (!this.deps.setPanelSlots(this.scope.projectId, key, clean)) throw new Error(`panels.slots: no panel ${key} in this window`)
    if (clean && clean.length > 0) this.slotted.add(key)
    else this.slotted.delete(key)
    return null
  }

  /** ctx.slots.available: whether a provider would draw a slot of `type` here now (the pick, and it runs). */
  private slotAvailable(params: unknown): boolean {
    this.alive()
    const { pluginId, type } = (params ?? {}) as Record<string, unknown>
    this.plugin(pluginId, 'slots.available')
    if (typeof type !== 'string' || !SLOT_TYPE_PATTERN.test(type)) throw new Error('slots.available: type is not a slot type')
    return this.deps.slotAvailable?.(this.scope.projectId, type) ?? false
  }

  /**
   * ctx.panels.show: one of the plugin's own declared panels, html or webview, in this host's
   * project (the layout is the project's; its window draws it). Budgeted like the other publishing calls
   * (a loop would fight the user's hide); showing a panel already shown changes nothing and
   * publishes nothing (LayoutService.show).
   */
  private showPanel(params: unknown): null {
    this.alive()
    const { pluginId, panelId } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'panels.show')
    if (typeof panelId !== 'string' || !plugin.panels.includes(panelId)) {
      throw new Error(`panels.show: ${plugin.id} declares no panel "${String(panelId)}"`)
    }
    if (!this.deps.showPanel) throw new Error('panels.show: panels are not available')
    if (!this.panelShows.take(plugin.id)) {
      throw new Error(`panels.show: more than ${MAX_PANEL_SHOWS_PER_WINDOW} calls in ${PANEL_SHOW_WINDOW_MS / 1000} s`)
    }
    const key = `${plugin.id}/${panelId}`
    if (!this.deps.showPanel(this.scope.projectId, key)) throw new Error(`panels.show: no panel ${key} in this window`)
    return null
  }

  /**
   * ctx.files.open: a file of THIS project, opened the way a Sessions panel click opens one (the
   * project's pick, else the built-in viewer). Any plugin of the host may call it; nothing in the
   * manifest is needed, since it shows the person a file of their own project and nothing more.
   * The shapes are checked before the budget is spent; a path refusal (open-file.ts) is not
   * refunded: each one costs fs lookups in main, and a loop of bad paths must stay bounded too.
   */
  private async filesOpen(params: unknown): Promise<{ via: 'plugin' | 'builtin' }> {
    this.alive()
    const { pluginId, path, tabId } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'files.open')
    if (typeof path !== 'string' || path === '') throw new Error('files.open: path must be a non-empty string')
    if (tabId !== undefined && typeof tabId !== 'string') throw new Error('files.open: tabId must be a string')
    if (!this.deps.openFile) throw new Error('files.open: opening files is not available')
    if (!this.fileOpens.take(plugin.id)) {
      throw new Error(`files.open: more than ${MAX_FILE_OPENS_PER_WINDOW} files in ${FILE_OPEN_WINDOW_MS / 1000} s`)
    }
    let via: 'plugin' | 'builtin'
    try {
      via = await this.deps.openFile({ windowId: this.scope.windowId, projectId: this.scope.projectId }, path, tabId)
    } catch (err) {
      throw withMethod('files.open', err)
    }
    return { via }
  }

  /**
   * ctx.openExternal: the system browser on a link of the plugin's. The host checked the shape;
   * main checks it all again (main is the authority, and a host is plain Node that can send
   * anything): http(s) only, no userinfo, MAX_PLUGIN_URL_LENGTH (checkWebUrl). Hosts get no
   * DISPLAY/DBUS env (host-manager.ts hostEnv), so `xdg-open` cannot do this from the host, and the
   * env stays narrow on purpose. A refused URL spends no budget (the check is cheap and opens
   * nothing); one handed to the OS does even when the OS then fails, since a tab may have opened.
   */
  private async openExternal(params: unknown): Promise<null> {
    this.alive()
    const { pluginId, url } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'openExternal')
    const href = checkWebUrl(url, { method: 'openExternal', maxLength: MAX_PLUGIN_URL_LENGTH, noUserinfo: true })
    if (!this.deps.openExternal) throw new Error('openExternal: opening links is not available')
    if (!this.externalOpens.take(plugin.id)) {
      throw new Error(
        `openExternal: more than ${MAX_EXTERNAL_OPENS_PER_WINDOW} links in ${EXTERNAL_OPEN_WINDOW_MS / 1000} s; try again in a moment`
      )
    }
    try {
      await this.deps.openExternal(href)
    } catch (err) {
      throw withMethod('openExternal', err)
    }
    return null
  }

  /**
   * The checked shape of a files.reveal / openWithSystem / trash request: the plugin (one of this
   * host's) and its path as given (system-files.ts checks the path itself), and main's handler.
   * The project is never read from the request: the host's own scope is the caller.
   */
  private systemFilesRequest(params: unknown, method: string): { pluginId: string; path: unknown; api: NonNullable<HostApiDeps['systemFiles']> } {
    this.alive()
    const { pluginId, path } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, method)
    if (typeof path !== 'string') throw new Error(`${method}: path must be a string`)
    const api = this.deps.systemFiles
    if (!api) throw new Error(`${method}: handing files to the system is not available`)
    return { pluginId: plugin.id, path, api }
  }

  private get caller(): { windowId: number; projectId: string } {
    return { windowId: this.scope.windowId, projectId: this.scope.projectId }
  }

  /**
   * ctx.files.reveal: a project file or folder shown in the file manager. As for files.open, the
   * budget is spent before the path is resolved: a refused path costs fs lookups in main too.
   */
  private async filesReveal(params: unknown): Promise<null> {
    const { pluginId, path, api } = this.systemFilesRequest(params, 'files.reveal')
    if (!this.reveals.take(pluginId)) {
      throw new Error(`files.reveal: more than ${MAX_REVEALS_PER_WINDOW} in ${SYSTEM_OPEN_WINDOW_MS / 1000} s; try again in a moment`)
    }
    try {
      await api.reveal(this.caller, path)
    } catch (err) {
      throw withMethod('files.reveal', err)
    }
    return null
  }

  /** ctx.files.openWithSystem: a project file with its default app; runnable files are refused there. */
  private async filesOpenWithSystem(params: unknown): Promise<null> {
    const { pluginId, path, api } = this.systemFilesRequest(params, 'files.openWithSystem')
    if (!this.systemOpens.take(pluginId)) {
      throw new Error(
        `files.openWithSystem: more than ${MAX_SYSTEM_OPENS_PER_WINDOW} in ${SYSTEM_OPEN_WINDOW_MS / 1000} s; try again in a moment`
      )
    }
    try {
      await api.openWithSystem(this.caller, path)
    } catch (err) {
      throw withMethod('files.openWithSystem', err)
    }
    return null
  }

  /**
   * ctx.files.trash: the person confirms in this window, then the entry goes to the Trash. One
   * dialog at a time per host; the dialog closes when the host goes (`gone`). `{ trashed: false }`
   * is the person's no, which the host turns into its own rejection.
   */
  private async filesTrash(params: unknown): Promise<{ trashed: boolean }> {
    const { pluginId, path, api } = this.systemFilesRequest(params, 'files.trash')
    if (this.trashing) throw new Error('files.trash: a Move to Trash confirmation is already open in this window')
    if (!this.trashes.take(pluginId)) {
      throw new Error(`files.trash: more than ${MAX_TRASHES_PER_WINDOW} in ${TRASH_WINDOW_MS / 1000} s; try again in a moment`)
    }
    this.trashing = true
    try {
      return { trashed: await api.trash(this.caller, path, pluginId, this.gone.signal) }
    } catch (err) {
      throw withMethod('files.trash', err)
    } finally {
      this.trashing = false
    }
  }

  private async overlay(params: unknown): Promise<PluginOverlayResult> {
    this.alive()
    const { pluginId, spec, handle } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'overlay.open')
    if (handle !== undefined && (typeof handle !== 'string' || !HANDLE_RE.test(handle))) {
      throw new Error('overlay: handle must be 1 to 64 letters, digits or dashes')
    }
    const linkKey = handle === undefined ? undefined : `${plugin.id}/${handle}`
    if (linkKey !== undefined && this.overlayLinks.has(linkKey)) throw new Error('overlay: that handle is already in use')
    const open = this.openOverlays.get(plugin.id) ?? 0
    if (open >= MAX_OPEN_OVERLAYS) throw new Error(`overlay: ${plugin.id} already has ${MAX_OPEN_OVERLAYS} overlays open`)
    // Taken before the first await, like the slot: this request came from the copy that is running
    // now, and a `plugin.disposed` for it arriving during the file check must still dismiss it.
    let copy = this.overlayCopies.get(plugin.id)
    if (!copy) {
      copy = new AbortController()
      this.overlayCopies.set(plugin.id, copy)
    }
    const peerGone = copy.signal
    // The slot is taken before the first await, so calls racing through the file read below
    // cannot get past the cap together.
    this.openOverlays.set(plugin.id, open + 1)
    // Registered before the first await too: the host sends its first posts right behind this
    // request, and they must find the handle (and wait in it) while the file is being checked.
    let channel: OverlayChannel | undefined
    if (linkKey !== undefined) {
      const link: OverlayLink = { pending: new OverlayOutbox(), closing: false }
      this.overlayLinks.set(linkKey, link)
      const pid = plugin.id
      channel = {
        onCreated: (overlayId) => {
          link.overlayId = overlayId
          for (const text of link.pending.drain()) {
            try {
              this.deps.postOverlay?.(this.scope.windowId, overlayId, text)
            } catch (err) {
              this.log(`plugin ${pid}: a queued overlay post failed: ${errorText(err)}`)
            }
          }
          if (link.buttons) {
            try {
              this.deps.setOverlayButtons?.(this.scope.windowId, overlayId, link.buttons)
            } catch (err) {
              this.log(`plugin ${pid}: queued overlay buttons failed: ${errorText(err)}`)
            }
            link.buttons = undefined
          }
          if (link.discuss !== undefined) {
            this.deps.setOverlayDiscuss?.(this.scope.windowId, overlayId, link.discuss)
            link.discuss = undefined
          }
          if (link.discussPrimary !== undefined) {
            this.deps.setOverlayDiscussPrimary?.(this.scope.windowId, overlayId, link.discussPrimary)
            link.discussPrimary = undefined
          }
          if (link.closing) this.deps.closeOverlay?.(this.scope.windowId, overlayId)
        },
        // A click on one of its own buttons: to this host, this plugin and this handle only.
        onButton: (buttonId) => this.hostCall('overlay.buttonClick', { source: 'opener', pluginId: pid, handle, buttonId }),
        // Discuss with Claude's context: to this host, this plugin and this handle only (the
        // manager bounds it to 5 s too and checks the answer's shape).
        onDiscuss: () => this.hostCall('overlay.discuss', { pluginId: pid, handle }, DISCUSS_ASK_MS),
        // A dying host (revoked) gets nothing more; the overlay is dismissed when it is gone.
        onMessage: (message) => {
          if (!this.revoked) this.emit('overlay.message', { pluginId: pid, handle, message })
        }
      }
    }
    try {
      // Built (and the html file checked) before the budget is spent, so a bad spec costs nothing.
      const managerSpec = await this.managerSpec(plugin, spec)
      this.alive()
      // The copy that asked was disposed during the file check (a reload): nothing to show it, and
      // no program started only to be ended.
      if (peerGone.aborted) return { kind: 'dismissed' }
      if (!this.overlayStarts.take(plugin.id)) {
        throw new Error(`overlay: more than ${MAX_OVERLAYS_PER_WINDOW} overlays in ${OVERLAY_WINDOW_MS / 1000} s`)
      }
      let result: OverlayResult
      try {
        result = await this.deps.openOverlay(
          this.scope.windowId,
          managerSpec,
          `plugin ${plugin.id}`,
          peerGone,
          channel,
          plugin.id
        )
      } catch (err) {
        // The manager rejects only before it creates anything (a bad argv or url, a program that
        // cannot start, a closed window); a shown overlay always resolves. Nothing was shown.
        this.overlayStarts.refund(plugin.id)
        throw err
      }
      // The manager already copied an html value through JSON (bounded, plain data).
      return result as PluginOverlayResult
    } finally {
      const left = (this.openOverlays.get(plugin.id) ?? 1) - 1
      if (left > 0) this.openOverlays.set(plugin.id, left)
      else this.openOverlays.delete(plugin.id)
      // The overlay ended (or never opened): its handle names nothing from here on.
      if (linkKey !== undefined) this.overlayLinks.delete(linkKey)
    }
  }

  /**
   * The overlay a handle names: only one this host opened under that same plugin id (the key holds
   * both), and only while it is open. The window is this host's (the manager checks it again).
   */
  private overlayLink(params: unknown, what: string): { link: OverlayLink | undefined; rest: Record<string, unknown> } {
    this.alive()
    const rest = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(rest.pluginId, what)
    if (typeof rest.handle !== 'string' || !HANDLE_RE.test(rest.handle)) throw new Error(`${what}: bad handle`)
    return { link: this.overlayLinks.get(`${plugin.id}/${rest.handle}`), rest }
  }

  /**
   * ctx.overlay.start's post: to the html page of that overlay (queued until it exists and its page
   * has loaded). False, not an error, for an overlay that ended or that this plugin did not open:
   * a post racing the end is normal and the host makes it a no-op.
   */
  private overlayPost(params: unknown): boolean {
    const { link, rest } = this.overlayLink(params, 'overlay.post')
    let text: string | undefined
    try {
      text = JSON.stringify(rest.message)
    } catch {
      text = undefined
    }
    if (text === undefined) throw new Error('overlay.post: the message is not JSON')
    if (text.length > MAX_OVERLAY_MESSAGE_LENGTH) {
      throw new Error(`overlay.post: message of ${text.length} chars exceeds ${MAX_OVERLAY_MESSAGE_LENGTH}`)
    }
    if (!link) return false
    if (!this.deps.postOverlay) throw new Error('overlay.post: overlay messages are not available')
    if (link.overlayId === undefined) {
      link.pending.push(text)
      return true
    }
    return this.deps.postOverlay(this.scope.windowId, link.overlayId, text)
  }

  /** ctx.overlay.start's close: dismiss it (its result resolves as dismissed). */
  private overlayClose(params: unknown): boolean {
    const { link } = this.overlayLink(params, 'overlay.close')
    if (!link) return false
    if (!this.deps.closeOverlay) throw new Error('overlay.close: not available')
    if (link.overlayId === undefined) {
      link.closing = true
      return true
    }
    return this.deps.closeOverlay(this.scope.windowId, link.overlayId)
  }

  /**
   * ctx.overlay.start's focus: bring it to the top of the window's stack. One still being created
   * goes on top anyway, so that is true with nothing to do; false for one that ended.
   */
  private overlayFocus(params: unknown): boolean {
    const { link } = this.overlayLink(params, 'overlay.focus')
    if (!link) return false
    if (!this.deps.focusOverlay) throw new Error('overlay.focus: not available')
    if (link.overlayId === undefined) return true
    return this.deps.focusOverlay(this.scope.windowId, link.overlayId)
  }

  /**
   * handle.setButtons: the opener's buttons of that overlay, checked again (the host checked them
   * at the call). Held until the overlay exists, like a post. False for an overlay that ended or
   * that this plugin did not open.
   */
  private overlaySetButtons(params: unknown): boolean {
    const { link, rest } = this.overlayLink(params, 'overlay.setButtons')
    const buttons = parseOverlayButtons(rest.buttons)
    if (!link) return false
    if (!this.deps.setOverlayButtons) throw new Error('overlay.setButtons: not available')
    if (link.overlayId === undefined) {
      link.buttons = buttons
      return true
    }
    return this.deps.setOverlayButtons(this.scope.windowId, link.overlayId, buttons)
  }

  /**
   * handle.onDiscuss: the opener of that overlay has a handler now (`on: true`) or disposed its last
   * one. Held until the overlay exists, like setButtons. False for an overlay that ended or that this
   * plugin did not open.
   */
  private overlayDiscussable(params: unknown): boolean {
    const { link, rest } = this.overlayLink(params, 'overlay.discussable')
    if (typeof rest.on !== 'boolean') throw new Error('overlay.discussable: on must be a boolean')
    if (!link) return false
    if (!this.deps.setOverlayDiscuss) throw new Error('overlay.discussable: not available')
    if (link.overlayId === undefined) {
      link.discuss = rest.on
      return true
    }
    return this.deps.setOverlayDiscuss(this.scope.windowId, link.overlayId, rest.on)
  }

  /**
   * handle.setDiscussPrimary: draw that overlay's Discuss as the primary button (`on`) or plain.
   * Held until the overlay exists, like setButtons. False for an overlay that ended or that this
   * plugin did not open.
   */
  private overlayDiscussPrimary(params: unknown): boolean {
    const { link, rest } = this.overlayLink(params, 'overlay.discussPrimary')
    if (typeof rest.on !== 'boolean') throw new Error('overlay.discussPrimary: on must be a boolean')
    if (!link) return false
    if (!this.deps.setOverlayDiscussPrimary) throw new Error('overlay.discussPrimary: not available')
    if (link.overlayId === undefined) {
      link.discussPrimary = rest.on
      return true
    }
    return this.deps.setOverlayDiscussPrimary(this.scope.windowId, link.overlayId, rest.on)
  }

  /** A request to the host; refused once it is stopping, or when main wired no `call`. */
  private hostCall(method: string, params: unknown, timeoutMs = OVERLAY_CLICK_TIMEOUT_MS): Promise<unknown> {
    if (this.revoked || !this.call) return Promise.reject(new Error(`${method}: the plugin host is not available`))
    return this.call(method, params, { timeoutMs })
  }

  /**
   * The type buttons of this host's window (OverlayManager's typeButtons, design-next §3.3). The
   * host attributes each button to the plugin whose ctx registered it; main still refuses a
   * plugin id that is not one of this host's plugins, and checks each plugin's list with the
   * opener's rule (at most 4, plain labels, unique ids). A bad group is dropped and logged, the
   * rest shows.
   */
  get overlayButtons(): OverlayTypeButtons {
    return {
      list: async (key, query) => {
        // The host bounds each provider to 500 ms and asks them together; this bounds the whole.
        const raw = await this.hostCall('overlay.buttons', { key, info: query }, TYPE_BUTTONS_ASK_MS)
        return this.typeButtonsOf(raw, query)
      },
      click: async (key, pluginId, buttonId, query) => {
        const plugin = this.plugin(pluginId, 'overlay.buttonClick')
        const answer = await this.hostCall('overlay.buttonClick', { source: 'type', key, pluginId: plugin.id, buttonId, info: query })
        return { close: (answer as { close?: unknown } | null)?.close === true }
      },
      ended: (key) => {
        if (!this.revoked) this.emit('overlay.ended', { key })
      }
    }
  }

  private typeButtonsOf(raw: unknown, query: OverlayTypeQuery): CleanTypeButton[] {
    if (!Array.isArray(raw)) throw new Error('overlay.buttons: the host did not answer a list')
    const groups = new Map<string, unknown[]>()
    for (const item of raw.slice(0, MAX_OVERLAY_BUTTONS * this.scope.plugins.length) as unknown[]) {
      const pluginId = (item as { pluginId?: unknown } | null)?.pluginId
      if (typeof pluginId !== 'string' || !this.scope.plugins.some((p) => p.id === pluginId)) {
        this.log(`plugin host ${this.scope.projectId}: an overlay type button of an unknown plugin is refused`)
        continue
      }
      const group = groups.get(pluginId) ?? []
      group.push(item)
      groups.set(pluginId, group)
    }
    const out: CleanTypeButton[] = []
    for (const [pluginId, group] of groups) {
      try {
        for (const button of parseOverlayButtons(group, `overlay.buttons(${query.type.name})`)) out.push({ ...button, pluginId })
      } catch (err) {
        this.log(`plugin ${pluginId}: its buttons for ${query.type.name} are refused: ${errorText(err)}`)
      }
    }
    return out
  }

  /**
   * The overlay manager's spec for a plugin's (SDK) spec. Only the known fields are copied; the
   * manager validates the rest (argv shape, an existing cwd, http/https only, title length).
   *   terminal  argv only, never a shell; cwd relative to the project folder and realpath'd inside
   *             it like a tab's (resolveCwd: `..`, an absolute path or a symlink out is refused),
   *             default the folder. The program could still `cd` anywhere, but the SDK promises
   *             the project folder and a plugin's path should not silently leave it.
   *   url       as given (the manager refuses anything but http and https)
   *   html      one of the plugin's own files, shown from its cc-plugin:// URL (pluginPageSrc)
   */
  private async managerSpec(plugin: HostApiPlugin, spec: unknown): Promise<unknown> {
    if (typeof spec !== 'object' || spec === null) throw new Error('overlay: spec must be an object')
    const s = spec as Record<string, unknown>
    const title = {
      ...(s.title === undefined ? {} : { title: s.title }),
      ...(s.size === undefined ? {} : { size: s.size }),
      // The extras (type, buttons, ready, discuss) go to the manager as sent: parseOverlaySpec
      // checks them and keeps only the known keys.
      ...(s.type === undefined ? {} : { type: s.type }),
      ...(s.buttons === undefined ? {} : { buttons: s.buttons }),
      ...(s.ready === undefined ? {} : { ready: s.ready }),
      ...(s.discuss === undefined ? {} : { discuss: s.discuss })
    }
    switch (s.kind) {
      case 'terminal': {
        if (s.cwd !== undefined && typeof s.cwd !== 'string') throw new Error('overlay: cwd must be a string')
        let cwd: string
        try {
          cwd = resolveCwd(this.scope.projectDir, s.cwd || undefined)
        } catch (err) {
          throw new Error(`overlay: ${errorText(err)}`, { cause: err })
        }
        return { kind: 'terminal', argv: s.argv, cwd, ...title }
      }
      case 'url':
        return { kind: 'url', url: s.url, ...title }
      case 'html':
        return { kind: 'html', src: await pluginPageSrc(plugin.id, plugin.dir, s.file), ...title }
      default:
        throw new Error('overlay: kind must be terminal, url or html')
    }
  }

  // Secrets: the store is app-wide per plugin, not per window, so these check `disposed` (the
  // process is gone) rather than `revoked`. revoke() keeps a dying host off a reopened window's
  // tabs and overlays; a plugin's deactivate() saving a refreshed token touches nothing of that
  // window, and refusing it would lose the token. The plugin check is the same as everywhere.

  /** The store, the checked plugin id and the rest of the params, for a `secrets.*` request. */
  private secretsFor(params: unknown, method: string): { secrets: PluginSecretsApi; id: string; rest: Record<string, unknown> } {
    const { pluginId, ...rest } = (params ?? {}) as Record<string, unknown>
    const secrets = this.secrets()
    return { secrets, id: this.plugin(pluginId, method).id, rest }
  }

  private async secretsGet(params: unknown): Promise<string | null> {
    const {
      secrets,
      id,
      rest: { key }
    } = this.secretsFor(params, 'secrets.get')
    // A project's secret settings reach only that project's host (ctx.settings hands this host its
    // own project's plaintext anyway). Not echoed, like every key plugin-secrets.ts refuses.
    if (typeof key === 'string' && key.startsWith(PROJECT_SETTING_PREFIX) && !key.startsWith(projectSettingKey(this.scope.projectId, ''))) {
      throw new Error("secrets.get: another project's secret settings are not readable here")
    }
    return secrets.get(id, key)
  }

  private async secretsSet(params: unknown): Promise<null> {
    const {
      secrets,
      id,
      rest: { key, value }
    } = this.secretsFor(params, 'secrets.set')
    this.takeSecretWrite(id, 'secrets.set')
    await secrets.set(id, key, value)
    return null
  }

  private async secretsDelete(params: unknown): Promise<null> {
    const {
      secrets,
      id,
      rest: { key }
    } = this.secretsFor(params, 'secrets.delete')
    this.takeSecretWrite(id, 'secrets.delete')
    await secrets.delete(id, key)
    return null
  }

  /**
   * One token per set or delete, never refunded (unlike sends): the checks run inside
   * plugin-secrets.ts, so a refusal that cost nothing cannot be told from a write that failed
   * after the full stringify and fsync, and refunding both would let a loop hammer a failing disk.
   * A plugin only reaches the budget in a loop, which is what this is for.
   */
  private takeSecretWrite(pluginId: string, what: string): void {
    if (!this.secretWrites.take(pluginId)) {
      throw new Error(`${what}: more than ${MAX_SECRET_WRITES_PER_WINDOW} writes in ${SECRET_WRITE_WINDOW_MS / 1000} s`)
    }
  }

  private async secretsKeys(params: unknown): Promise<string[]> {
    const { secrets, id } = this.secretsFor(params, 'secrets.keys')
    return secrets.keys(id)
  }

  // App storage: app-wide like secrets, so it too checks `disposed`, not `revoked` (a deactivate()
  // saving a counter touches nothing of the window). The store's methods are synchronous and the
  // handler awaits nothing before calling one: main's single thread applies each call whole, so
  // calls from the hosts of several windows never interleave inside a read-modify-write.

  private appStorageCall<T>(
    params: unknown,
    method: string,
    body: (store: AppStorageApi, pluginId: string, rest: Record<string, unknown>) => T
  ): T {
    if (this.disposed) throw new Error('the plugin host is gone')
    const { pluginId, ...rest } = (params ?? {}) as Record<string, unknown>
    const id = this.plugin(pluginId, method).id
    if (!this.deps.appStorage) throw new Error(`${method}: app storage is not available`)
    return body(this.deps.appStorage, id, rest)
  }

  // OAuth. authorize is a window thing (a browser tab the user is looking at for this window), so
  // it checks `revoked` like sessions and overlays; refresh touches no window and, like secrets,
  // works until the process is gone: a deactivate() refreshing a token to store it is not refused.

  private async oauthAuthorize(params: unknown): Promise<OAuthTokens> {
    this.alive()
    const { pluginId, spec } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'oauth.authorize')
    // Everything that can be refused is refused before the budget is spent and a browser opens.
    const checked = this.checked('oauth.authorize', () => checkOAuthSpec(spec))
    // Synchronous up to the authorize call below: the entry is set before the host's next message
    // (a `plugin.disposed` for this copy) can be handled.
    if (!this.authorizes.take(plugin.id)) {
      throw new Error(`oauth.authorize: more than ${MAX_AUTHORIZES_PER_WINDOW} sign-ins in ${AUTHORIZE_WINDOW_MS / 1000} s`)
    }
    // A new sign-in replaces a pending one of the same plugin (its call rejects as cancelled). A
    // provider's error page ("Access blocked", a closed tab) never redirects to the loopback, so
    // refusing here left the user stuck for the 5-minute timeout with no way to try again. Still one
    // at a time (one loopback, one browser tab), and the budget above bounds how often it can happen.
    this.signIns.get(plugin.id)?.abort()
    const controller = new AbortController()
    this.signIns.set(plugin.id, controller)
    try {
      return await this.deps.oauth.authorize(checked, controller.signal)
    } catch (err) {
      throw withMethod('oauth.authorize', err)
    } finally {
      // Only our own entry: contextDisposed() may have dropped it and a new copy set its own.
      if (this.signIns.get(plugin.id) === controller) this.signIns.delete(plugin.id)
    }
  }

  private async oauthRefresh(params: unknown): Promise<OAuthTokens> {
    if (this.disposed) throw new Error('the plugin host is gone')
    const { pluginId, spec, refreshToken } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'oauth.refresh')
    const checked = this.checked('oauth.refresh', () => checkOAuthSpec(spec))
    const token = this.checked('oauth.refresh', () => checkRefreshToken(refreshToken))
    let running = this.refreshes.get(plugin.id)
    if (running && running.size >= MAX_REFRESHES_IN_FLIGHT) {
      throw new Error(`oauth.refresh: ${plugin.id} already has ${MAX_REFRESHES_IN_FLIGHT} refreshes in flight`)
    }
    if (!running) {
      running = new Set()
      this.refreshes.set(plugin.id, running)
    }
    const controller = new AbortController()
    running.add(controller)
    try {
      // Dropped when the asking ctx is disposed or the process is gone: nobody is left to receive it.
      return await this.deps.oauth.refresh(checked, token, AbortSignal.any([controller.signal, this.gone.signal]))
    } catch (err) {
      throw withMethod('oauth.refresh', err)
    } finally {
      running.delete(controller)
      // Only our own set: contextDisposed() may have dropped it and a new copy started its own.
      if (running.size === 0 && this.refreshes.get(plugin.id) === running) this.refreshes.delete(plugin.id)
    }
  }

  // Webviews: a window thing (the view sits in this host's window), so `revoked` refuses them like
  // overlays. The panel must be one of the plugin's own declared webview panels; the target and the
  // page's later navigation are the manager's to judge.

  private async webviewNavigate(params: unknown): Promise<null> {
    this.alive()
    const { owner, plugin } = this.webviewOwner(params, 'webview.navigate')
    if (!this.navigates.take(plugin.id)) {
      throw new Error(`webview.navigate: more than ${MAX_NAVIGATES_PER_WINDOW} navigations in ${NAVIGATE_WINDOW_MS / 1000} s`)
    }
    const { target } = (params ?? {}) as Record<string, unknown>
    this.webviewPlugins.add(plugin.id)
    try {
      await this.webview('webview.navigate').navigate(owner, target, (page) => this.navigated(owner, page))
    } catch (err) {
      // A refused target loaded nothing: a plugin retrying a bad path must not lock itself out. A
      // page that failed to load did load (an empty page, the network asked): it keeps its charge,
      // so a loop on a dead dev server stays within the rate.
      if (!(err instanceof WebviewLoadError)) this.navigates.refund(plugin.id)
      throw err
    }
    // A host stopping while the file system was read: its views are torn down by dispose, but one
    // created after revoke would wait for it; take it down now.
    if (this.revoked) {
      this.destroyWebviews(plugin.id)
      throw new Error('the plugin host is stopping')
    }
    return null
  }

  private webviewStep(params: unknown, step: 'back' | 'forward' | 'reload'): null {
    this.alive()
    const { owner } = this.webviewOwner(params, `webview.${step}`)
    this.webview(`webview.${step}`)[step](owner)
    return null
  }

  private webviewCurrent(params: unknown): WebviewPage {
    this.alive()
    const { owner } = this.webviewOwner(params, 'webview.current')
    return this.webview('webview.current').current(owner)
  }

  /** The view a webview request names: this host's window, a declared webview panel of the plugin. */
  private webviewOwner(params: unknown, what: string): { owner: WebviewOwner; plugin: HostApiPlugin } {
    const { pluginId, panelId } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, what)
    if (typeof panelId !== 'string' || !(plugin.webviewPanels ?? []).includes(panelId)) {
      throw new Error(`${what}: ${plugin.id} declares no webview panel "${String(panelId)}"`)
    }
    return { owner: { windowId: this.scope.windowId, projectId: this.scope.projectId, pluginId: plugin.id, panelId }, plugin }
  }

  private webview(what: string): NonNullable<HostApiDeps['webview']> {
    if (!this.deps.webview) throw new Error(`${what}: web views are not available`)
    return this.deps.webview
  }

  /** A view of this host committed a page: tell the host (ctx.webview.onNavigate), unless it is stopping. */
  private navigated(owner: WebviewOwner, page: WebviewPage): void {
    if (this.revoked) return
    try {
      this.emit('webview.navigated', {
        pluginId: owner.pluginId,
        panelId: owner.panelId,
        url: page.url,
        title: page.title,
        ...(page.error !== undefined ? { error: page.error } : {})
      })
    } catch (err) {
      this.log(`plugin host ${this.scope.projectId}: webview event failed: ${errorText(err)}`)
    }
  }

  private destroyWebviews(pluginId: string): void {
    // Not only the plugins that navigated: an opened, never-navigated panel has a placement in main.
    const declares = this.scope.plugins.some((p) => p.id === pluginId && (p.webviewPanels ?? []).length > 0)
    if (!this.webviewPlugins.delete(pluginId) && !declares) return
    try {
      this.deps.webview?.destroyPlugin(this.scope.windowId, pluginId)
    } catch (err) {
      this.log(`plugin host ${this.scope.projectId}: closing the web views of ${pluginId} failed: ${errorText(err)}`)
    }
  }

  /** `check()`'s value, or its error with the method in front (the messages hold no values). */
  private checked<T>(what: string, check: () => T): T {
    try {
      return check()
    } catch (err) {
      throw withMethod(what, err)
    }
  }

  private secrets(): PluginSecretsApi {
    if (this.disposed) throw new Error('the plugin host is gone')
    return this.deps.secrets
  }

  /** The plugin a request names, only if this host process runs it. */
  private plugin(pluginId: unknown, what: string): HostApiPlugin {
    const plugin = typeof pluginId === 'string' ? this.scope.plugins.find((p) => p.id === pluginId) : undefined
    if (!plugin) throw new Error(`${what}: unknown plugin`)
    return plugin
  }

  private alive(): void {
    if (this.revoked) throw new Error('the plugin host is stopping')
  }

  /**
   * A tab changed. Only this project's tabs concern the host; their whole list goes out at most
   * once per interval (a burst of hooks is one event), built at send time so it is the latest.
   */
  private sessionsChanged(change: SessionChange): void {
    if (this.revoked) return
    this.allSessionsChanged()
    if (this.timer !== undefined) return
    const projectId = (change.entry ?? change.prev)?.projectId
    if (projectId !== this.scope.projectId) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.revoked) return
      try {
        this.emit('sessions', { sessions: this.sessionInfos() })
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: sessions event failed: ${errorText(err)}`)
      }
    }, this.interval)
    // A pending event must not keep main alive at quit.
    this.timer.unref?.()
  }

  /**
   * Any window's tab changed: a host running a plugin with the `access` declaration hears the
   * summaries of all of them, at most once per interval. Other hosts get nothing, so another
   * window's activity is not even a timing signal to them.
   */
  private allSessionsChanged(): void {
    if (this.allTimer !== undefined || !this.deps.summaries) return
    if (!this.scope.plugins.some((p) => p.sessionsAll === true)) return
    this.allTimer = setTimeout(() => {
      this.allTimer = undefined
      if (this.revoked) return
      try {
        this.emit('sessions.all', { sessions: this.summaries() })
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: sessions.all event failed: ${errorText(err)}`)
      }
    }, this.interval)
    this.allTimer.unref?.()
  }
}
