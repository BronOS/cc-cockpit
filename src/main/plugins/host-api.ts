// What a plugin host may ask of main for sessions, badges and overlays (plan Task 27; design §5
// Host API: sessions, UI). One HostApi exists per host PROCESS: host-manager.ts builds it when it
// spawns the host and closes over the project and window main spawned that process for. Nothing in
// a request names a project or window, and every id a request does name (a tab, a panel, a plugin)
// is only looked up inside that scope (CLAUDE.md: main is the only authority):
//
//   sessions.list   {}                         -> SessionInfo[]  this project's Claude tabs only
//   sessions.send   { pluginId, tabId, text }  -> SendResult     a tab of THIS project, through the gate
//   sessions.open   { pluginId, cwd?, prompt? }-> { tabId }      a new Claude tab in this project
//   badge           { pluginId, panelId, value}-> null           a panel the plugin itself declares
//   panels.show     { pluginId, panelId }      -> null           a panel the plugin itself declares (any kind)
//   overlay.open    { pluginId, spec, handle? } -> OverlayResult on this project's window; `handle`
//                                                                (ctx.overlay.start) names the overlay
//                                                                in the two calls below
//   overlay.post    { pluginId, handle, message } -> boolean     to that html overlay's page
//   overlay.close   { pluginId, handle }       -> boolean        dismiss it (false: it already ended)
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
// events main pushes to the host:
//   sessions        { sessions: SessionInfo[] }                  this project's tabs changed (throttled)
//   webview.navigated { pluginId, panelId, url, title }          a view this host drives committed a page
//   overlay.message { pluginId, handle, message }                that overlay's page posted (not a result)
// and one event the host sends (host-manager routes it to contextDisposed):
//   plugin.disposed { pluginId }                                 that plugin's ctx ended: its ctx.oauth calls
//                                                                and its webviews go
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
// settings field) is refused unless <id> is this host's project; app-wide `setting:app:*` and
// this project's keys stay readable, as ctx.settings hands this host their plaintext anyway.
//
// Overlay handles: the host picks a random `handle` per ctx.overlay.start and main keys it by
// `<pluginId>/<handle>` in THIS HostApi, so a post or close only finds an overlay this host process
// opened, in its own window, under the plugin id that opened it; the overlay id never leaves main.
// A page's messages go to the channel registered here at open, so to this host and that plugin
// only. Posts made before the overlay exists (the open is still checking the file) wait in the
// handle's queue and go out, in order, once the manager created it.
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
import type { OAuthTokens, OverlayResult as PluginOverlayResult, SendResult, SessionInfo } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import type { PanelBadge } from '../../shared/ipc'
import {
  MAX_OVERLAY_MESSAGE_LENGTH,
  OverlayOutbox,
  type OverlayChannel,
  type OverlayResult
} from '../overlays/overlay-manager'
import { prepareText } from '../sessions/send-gate'
import type { SessionChange } from '../sessions/session-registry'
import type { SessionEntry } from '../sessions/status-reducer'
import { checkOAuthSpec, checkRefreshToken, type PluginOAuthApi } from '../oauth/plugin-oauth'
import type { AppStorageApi } from './app-storage'
import { projectSettingKey, SETTING_KEY_PREFIX, type PluginSecretsApi } from '../secrets/plugin-secrets'
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
/** ctx.oauth.authorize per plugin: each one opens a browser tab. One pending at a time besides. */
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
  /** The send gate (SessionRegistry.send): types now only when the tab is waiting, else queues. */
  send(tabId: string, text: string): { id: string; delivered: boolean }
  /** Subscribe to registry changes (SessionRegistry.onChange); returns the unsubscribe. */
  onSessionsChange(listener: (change: SessionChange) => void): () => void
  /**
   * Start a Claude tab in the project and tell its window (TabManager.create after the login env).
   * The tab manager realpaths `cwd` inside the project folder and passes `prompt` as one argv
   * element after `--` (claude-argv.ts); it throws for anything else. `windowId` is the host's
   * window: the tab is refused when that window closed while the login env was awaited.
   */
  openTab(projectId: string, options: { cwd?: string; prompt?: string }, windowId: number): Promise<{ id: string }>
  /** LayoutService.setBadge: false for a panel the project does not have. */
  setBadge(projectId: string, panelKey: string, badge: PanelBadge | null): boolean
  /**
   * LayoutService.show (ctx.panels.show): unhide, open, expand its zone; false for a panel the
   * project does not have. Without it the request is refused.
   */
  showPanel?(projectId: string, panelKey: string): boolean
  /** OverlayManager.open (after the login env); `peerGone` dismisses it, `channel` talks with its page. */
  openOverlay(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal,
    channel?: OverlayChannel
  ): Promise<OverlayResult>
  /** OverlayManager.post. Without it (and closeOverlay) ctx.overlay.start's post/close are refused. */
  postOverlay?(windowId: number, overlayId: string, text: string): boolean
  /** OverlayManager.close. */
  closeOverlay?(windowId: number, overlayId: string): boolean
  /** ctx.secrets (PluginSecrets). */
  secrets: PluginSecretsApi
  /** ctx.oauth (PluginOAuth). */
  oauth: PluginOAuthApi
  /** ctx.appStorage (AppStorage, one for the whole app). Without it the appStorage requests are refused. */
  appStorage?: AppStorageApi
  /** ctx.webview (WebviewManager). Without it the webview requests are refused. */
  webview?: Pick<WebviewManager, 'navigate' | 'back' | 'forward' | 'reload' | 'current' | 'destroyPlugin'>
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
}

/** Who is asking: fixed when main spawned the host process. */
export interface HostScope {
  projectId: string
  windowId: number
  /** The project folder (absolute): the default cwd of a terminal overlay. */
  projectDir: string
  plugins: readonly HostApiPlugin[]
}

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
 */
export function sessionInfoOf(e: SessionEntry): SessionInfo {
  const out: { -readonly [K in keyof SessionInfo]: SessionInfo[K] } = {
    tabId: e.tabId,
    status: e.status,
    cwd: e.cwd,
    notes: [...e.notes],
    files: [...e.files]
  }
  if (e.sessionId !== undefined) out.sessionId = e.sessionId
  if (e.tool !== undefined) out.tool = e.tool
  if (e.lastPrompt !== undefined) out.lastPrompt = e.lastPrompt
  if (e.steps !== undefined) out.steps = { ...e.steps }
  return out
}

/** `err` with the method in front, kept as the cause (the messages it wraps hold no values). */
function withMethod(what: string, err: unknown): Error {
  return new Error(`${what}: ${errorText(err)}`, { cause: err })
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
  /** Panel keys this host badged: cleared when it goes, so a dead plugin leaves no stale count. */
  private readonly badged = new Set<string>()
  /** Aborted at dispose: every overlay this host opened is dismissed (its opener is gone). */
  private readonly gone = new AbortController()
  private readonly unsubscribe: () => void
  private readonly interval: number
  private readonly log: (message: string) => void
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  /** Set by revoke() (and dispose()): every request refused, no sessions events. */
  private revoked = false

  constructor(
    private readonly deps: HostApiDeps,
    private scope: HostScope,
    /** A one-way event to this host (its RpcEndpoint.emit). */
    private readonly emit: (event: string, params: unknown) => void
  ) {
    this.interval = deps.sessionsIntervalMs ?? SESSIONS_EVENT_INTERVAL_MS
    this.log = deps.log ?? ((m) => console.warn(m))
    this.unsubscribe = deps.onSessionsChange((change) => this.sessionsChanged(change))
  }

  /** The RPC methods, to merge into the host's endpoint handlers. */
  get handlers(): Record<string, RpcHandler> {
    return {
      'sessions.list': () => this.list(),
      'sessions.send': (params) => this.send(params),
      'sessions.open': (params) => this.open(params),
      badge: (params) => this.badge(params),
      'panels.show': (params) => this.showPanel(params),
      'overlay.open': (params) => this.overlay(params),
      'overlay.post': (params) => this.overlayPost(params),
      'overlay.close': (params) => this.overlayClose(params),
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
      'webview.current': (params) => this.webviewCurrent(params)
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
  }

  /** Whether this host set a badge on `panelKey` that is still showing. */
  hasBadged(panelKey: string): boolean {
    return this.badged.has(panelKey)
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
  }

  /**
   * The host process is gone (exit, stop, app quit). Stop the sessions events, dismiss the
   * overlays it opened, clear its badges, except the ones `keep` names: a newer host of the same
   * project (its window reopened while this one was deactivating) owns those now. Idempotent.
   */
  dispose(keep?: (panelKey: string) => boolean): void {
    if (this.disposed) return
    this.revoke()
    this.disposed = true
    this.gone.abort()
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
  }

  // -------------------------------------------------------------------------------------------

  private list(): SessionInfo[] {
    this.alive()
    return this.deps.listSessions(this.scope.projectId).map(sessionInfoOf)
  }

  private send(params: unknown): SendResult {
    this.alive()
    const { pluginId, tabId, text } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.send')
    // Another project's tab (a guessed or leaked id) reads exactly like a tab that does not exist.
    if (typeof tabId !== 'string' || this.deps.session(tabId)?.projectId !== this.scope.projectId) {
      throw new Error('sessions.send: unknown tab')
    }
    // Validated before the budget is spent: a refused text (a "/" command) costs nothing.
    const clean = prepareText(text)
    if (!this.sends.take(plugin.id)) {
      throw new Error(`sessions.send: more than ${MAX_SENDS_PER_WINDOW} texts in ${SEND_WINDOW_MS / 1000} s`)
    }
    // The gate is the only way in: typed now only while the tab waits for input, else queued.
    // It throws before queueing anything (an ended session, a full queue): no text, no cost.
    let result: { id: string; delivered: boolean }
    try {
      result = this.deps.send(tabId, clean)
    } catch (err) {
      this.sends.refund(plugin.id)
      throw err
    }
    return result.delivered ? { delivered: true } : { queued: true, itemId: result.id }
  }

  private async open(params: unknown): Promise<{ tabId: string }> {
    this.alive()
    const { pluginId, cwd, prompt } = (params ?? {}) as Record<string, unknown>
    const plugin = this.plugin(pluginId, 'sessions.open')
    if (cwd !== undefined && typeof cwd !== 'string') throw new Error('sessions.open: cwd must be a string')
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
        ...(text !== undefined ? { prompt: text } : {})
      },
      this.scope.windowId
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
          if (link.closing) this.deps.closeOverlay?.(this.scope.windowId, overlayId)
        },
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
      if (!this.overlayStarts.take(plugin.id)) {
        throw new Error(`overlay: more than ${MAX_OVERLAYS_PER_WINDOW} overlays in ${OVERLAY_WINDOW_MS / 1000} s`)
      }
      let result: OverlayResult
      try {
        result = await this.deps.openOverlay(
          this.scope.windowId,
          managerSpec,
          `plugin ${plugin.id}`,
          this.gone.signal,
          channel
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
      ...(s.size === undefined ? {} : { size: s.size })
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
    if (this.signIns.has(plugin.id)) throw new Error('oauth.authorize: a sign-in of this plugin is already in progress')
    if (!this.authorizes.take(plugin.id)) {
      throw new Error(`oauth.authorize: more than ${MAX_AUTHORIZES_PER_WINDOW} sign-ins in ${AUTHORIZE_WINDOW_MS / 1000} s`)
    }
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
    if (this.revoked || this.timer !== undefined) return
    const projectId = (change.entry ?? change.prev)?.projectId
    if (projectId !== this.scope.projectId) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.revoked) return
      try {
        this.emit('sessions', { sessions: this.deps.listSessions(this.scope.projectId).map(sessionInfoOf) })
      } catch (err) {
        this.log(`plugin host ${this.scope.projectId}: sessions event failed: ${errorText(err)}`)
      }
    }, this.interval)
    // A pending event must not keep main alive at quit.
    this.timer.unref?.()
  }
}
