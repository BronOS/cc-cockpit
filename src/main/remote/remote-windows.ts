// The remote desktop windows (design-remote-desktop.md §4, §5.2): which window shows which server's
// project, their titles and recent projects, the rules a server's page is held to, and the re-pair
// loop. No Electron import: the windows and the partition come through `RemoteWindowFactory`
// (electron-remote-window.ts in the app, fakes in test/unit/remote-windows.test.ts), so every
// decision here is unit-tested.
//
// A remote window is a browser tab on the server's web client, never a project window: nothing
// here reaches IPC, ViewRegistry, plugin hosts or local files. What it holds the page to:
//  - Requests (`allowRemoteRequest`): the page's origin may be `http://127.0.0.1:<L>` (the SSH
//    tunnel), and cookies ignore ports, so a request to another loopback port would carry the
//    device cookie to whatever local process listens there. Every loopback host but the server's own
//    origin is cancelled; with a Direct server on a real address, every loopback host is.
//  - Top-level navigation and redirects stay on the server's origin (`allowRemoteNavigation`);
//    a page-opened window is never one of ours: an http(s) link goes to the person's browser under
//    the webview panels' open budget (open-budget.ts), anything else is dropped.
//
// Back to the picker: a project page navigating to the server's own picker (the tab strip's "+",
// Close project) is cancelled and the desktop picker shows; the window closes when the server no
// longer has the project open, and stays otherwise (`backToPicker`).
//
// Windows per (server, project): the project comes from the page's own routing (`?project=<id>`,
// renderer/web/main.tsx), read on every main-frame navigation. Opening a project that has a window
// focuses it; the server's web picker navigating a second window to it focuses the first and sends
// the second back to the picker. A project page navigating to another project's page (a session
// chip of that project, design-web.md §9: the server sends the clicking view there) is cancelled and
// opens that project's own window, or focuses the one that shows it (`isProjectSwitch`). The title is `<server> — <project>` with the name from the
// server's PROJECTS_PATH, fetched through the window's own partition (its device cookie applies);
// the page's own title is the static `cc-cockpit` and is never read.
//
// Re-pair (SSH only, link mode only). A revoked or expired cookie gives no 401: SESSION_PATH answers
// 200 with `device: null` and the page draws its sign-in screen. So a finished load or a page's own
// completed SESSION_PATH request is only a trigger; main asks SESSION_PATH itself. With no device,
// one add-device token is minted over SSH and the asking window loads `#t=<token>` (its project
// kept in `?project=`): the page signs in as any browser does, remote-cookie.ts keeps the new cookie,
// and the server's other windows reload once it lands. The server holds one add-device token at a
// time (auth.ts addDeviceLink), so two windows minting at once would void each other's: pairing is
// serialised per server, one promise its windows share. Bounded: after MAX_PAIR_ATTEMPTS pairings
// with no device seen in between, the window shows the error instead of minting again (a server that
// refuses the cookie each time must not get a new device on every reload). Opening a window from the
// picker is the person's own retry and starts the count again. Direct never re-pairs: the page's own
// sign-in screen shows, and the person pastes a new link.
//
// My own tunnel (design §6): every load main makes of such a server's page (open, a sign-in with a
// pasted link, a move, a reload after a sign-in) passes the options' `gate` first (tunnel-probe.ts:
// main asks the session path itself, with no cookie). Nothing answering shows main's waiting page
// with the command that starts the tunnel and tries again every TUNNEL_RETRY_MS while the window is
// open; anything but a cc-cockpit answer shows the error and loads nothing, so the device cookie is
// never sent to it. The page's own reconnects are not covered (they are the page's, not main's).
//
// A project the server closed (design §4 "Recent projects"): the picker's recent rows name projects
// the server may have closed since, and the web client only shows "not open on the host" for one.
// So before main loads a project page it asks PROJECTS_PATH through the partition (the device
// cookie applies) and, when the project is not among the open ones, POSTs `{ reopen }` there as the
// server's own web picker does (`Origin` set to the server's origin: the gateway checks it on every
// POST), then loads the id the server answered. Only once the session is valid: signed out (a 401)
// or the server not answering loads the page as before, and the page's sign-in or a re-pair follows;
// a sign-in that lands (loadToken) asks again. A gated load asks only after the gate let it (probe,
// then reopen, then load). The server refusing (`{ error }`: the folder is gone, an id it forgot) is
// main's error page with the server's text.

import { errorText } from '../../shared/error-text'
import { recentEntryOf, type RemoteServerRecord } from '../../shared/remote-servers'
import { PROJECTS_PATH, SESSION_PATH, type WebOpenProjectRequest } from '../../shared/web-protocol'
import { overlayUrlOf } from '../overlays/overlay-manager'
import { MAX_OPENS_PER_VIEW, OPEN_WINDOW_MS, OpenBudget } from '../webview/open-budget'
import { warnLog } from '../warn-log'
import { RemoteCookie, type RemoteCookieJar, type RemoteCookieStore } from './remote-cookie'
import { TUNNEL_RETRY_MS, type LoadGate } from './tunnel-probe'

/** Pairings in a row with no device seen in between before the window shows the error. */
export const MAX_PAIR_ATTEMPTS = 2
/** How long a pairing waits for the page's sign-in to land the cookie. */
export const PAIR_WAIT_MS = 20_000
/** The longest project id read from a page URL (shared/remote-servers.ts caps the record the same). */
const MAX_PROJECT_ID = 200
/** Longer than any tab id the server mints. */
const MAX_TAB_ID = 200
/** The longest window title part taken from the server. */
const MAX_TITLE_NAME = 200
/** The longest error text taken from the server for main's error page. */
const MAX_SERVER_ERROR = 500

// ---------------------------------------------------------------------------------------------
// The rules (pure, unit-tested on their own)

/** `n` as a whole number from 0 to 255, or undefined (an IPv4 part as URL normalises it). */
function octet(part: string): number | undefined {
  if (part === '' || part.length > 3) return undefined
  for (const ch of part) if (ch < '0' || ch > '9') return undefined
  const n = Number(part)
  return n <= 255 ? n : undefined
}

/**
 * Whether `hostname` (as `URL` gives it: lower case, IPv4 normalised, IPv6 bracketed and compressed)
 * reaches this machine: `localhost` and `*.localhost` (Chromium resolves both to loopback),
 * 127.0.0.0/8, 0.0.0.0/8 (which reaches local listeners on Linux and macOS), `::1`, `::`, and the
 * IPv4-mapped (`::ffff:`) and IPv4-compatible (`::`) forms of 127/8 and 0/8.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = host.slice(1, -1)
    if (v6 === '::1' || v6 === '::') return true
    // `URL` writes an embedded IPv4 address as two hex groups (`::ffff:7f00:1` for 127.0.0.1).
    const rest = v6.startsWith('::ffff:') ? v6.slice('::ffff:'.length) : v6.startsWith('::') ? v6.slice(2) : undefined
    if (rest === undefined) return false
    const groups = rest.split(':')
    if (groups.length !== 2) return false
    const high = groups[0] as string
    if (high === '' || high.length > 4) return false
    for (const ch of high) if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false
    const first = Number.parseInt(high, 16) >> 8
    return first === 127 || first === 0
  }
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map(octet)
  if (nums.some((n) => n === undefined)) return false
  return nums[0] === 127 || nums[0] === 0
}

function parsed(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

/**
 * Whether the server's page may send a request to `url`. Only loopback hosts are refused, every one
 * but the server's own origin (its `ws:` socket included); with no origin (the tunnel is down) or a
 * Direct origin on a real address, every loopback host is. Schemes with no host (data:, blob:) pass:
 * they reach no listener.
 */
export function allowRemoteRequest(url: string, origin: string | undefined): boolean {
  const target = parsed(url)
  if (target === undefined) return false
  const scheme = target.protocol
  if (scheme !== 'http:' && scheme !== 'https:' && scheme !== 'ws:' && scheme !== 'wss:') return true
  if (!isLoopbackHost(target.hostname)) return true
  const own = origin === undefined ? undefined : parsed(origin)
  if (own === undefined || !isLoopbackHost(own.hostname)) return false
  if (target.host !== own.host) return false
  return own.protocol === 'https:' ? scheme === 'https:' || scheme === 'wss:' : scheme === 'http:' || scheme === 'ws:'
}

/** Whether `url` is on `origin` exactly (scheme, host and port). */
export function onOrigin(url: string, origin: string | undefined): boolean {
  if (origin === undefined) return false
  const target = parsed(url)
  const own = parsed(origin)
  return target !== undefined && own !== undefined && target.origin === own.origin && target.origin !== 'null'
}

/** A main-frame navigation or redirect of the server's page: its own origin only. */
export function allowRemoteNavigation(url: string, origin: string | undefined): boolean {
  return onOrigin(url, origin)
}

/** The project a page URL on the server's origin shows (`?project=<id>`), or undefined for the picker. */
export function projectOfUrl(url: string): string | undefined {
  const target = parsed(url)
  const project = target?.searchParams.get('project') ?? ''
  return project === '' || project.length > MAX_PROJECT_ID ? undefined : project
}

/**
 * Whether a main-frame navigation from `from` to `to` is a project page going back to the server's
 * own picker: both on `origin`, `from` showing a project, `to` with no project at `/` or at `from`'s
 * own path (the web client's tab strip "+" assigns `/`; its Close project replaces the URL with
 * `location.pathname`, and its 'gone' page links `/`). Navigations within the picker, from it to a
 * project and between projects are not.
 */
export function isPickerNavigation(from: string, to: string, origin: string | undefined): boolean {
  if (!onOrigin(from, origin) || !onOrigin(to, origin) || projectOfUrl(from) === undefined) return false
  const target = parsed(to)
  const source = parsed(from)
  if (target === undefined || source === undefined || (target.searchParams.get('project') ?? '') !== '') return false
  return target.pathname === '/' || target.pathname === source.pathname
}

/**
 * The tab a project page URL asks its page to select (`&tab=<id>`, the web client's projectHref for a
 * session chip of another project), or undefined.
 */
export function tabOfUrl(url: string): string | undefined {
  const tab = parsed(url)?.searchParams.get('tab') ?? ''
  return tab === '' || tab.length > MAX_TAB_ID ? undefined : tab
}

/**
 * Whether a main-frame navigation from `from` to `to` is a project page going to ANOTHER project's
 * page (the server sends a browser view there for a session chip of that project, `project.goto`):
 * both on `origin`, both showing a project, and not the same one. From the server's picker it is not
 * (that is the picker opening a project, tracked by `navigated`).
 */
export function isProjectSwitch(from: string, to: string, origin: string | undefined): boolean {
  if (!onOrigin(from, origin) || !onOrigin(to, origin)) return false
  const source = projectOfUrl(from)
  const target = projectOfUrl(to)
  return source !== undefined && target !== undefined && source !== target
}

/**
 * The page for a server's project (or its picker), with an access token in the fragment when signing
 * in, and the tab its page selects once loaded (`tabId`, a project page only).
 */
export function remotePageUrl(origin: string, projectId?: string, token?: string, tabId?: string): string {
  const tab = projectId === undefined || tabId === undefined ? '' : `&tab=${encodeURIComponent(tabId)}`
  const query = projectId === undefined ? '' : `?project=${encodeURIComponent(projectId)}${tab}`
  const fragment = token === undefined ? '' : `#t=${encodeURIComponent(token)}`
  return `${origin}/${query}${fragment}`
}

/** Text from the server shown by main (a title, an error): control characters out, capped at `max`. */
function serverText(text: string, max: number): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029) continue
    out += ch
    if (out.length >= max) break
  }
  return out.trim()
}

/** Window title text from the server. */
function titlePart(text: string): string {
  return serverText(text, MAX_TITLE_NAME)
}

/** `<server> — <project>`, or the server's name alone on its picker. */
export function remoteTitle(serverName: string, projectName?: string): string {
  const project = projectName === undefined ? '' : titlePart(projectName)
  return project === '' ? serverName : `${serverName} — ${project}`
}

// ---------------------------------------------------------------------------------------------
// The adapter's side

/** What a remote window's page does, as the adapter reports it, and what it asks main to decide. */
export interface RemoteWindowHooks {
  /** A main-frame navigation or redirect the page started: may it go ahead? */
  allowNavigation(url: string): boolean
  /** The page asked for a window (`window.open`, target=_blank); it is always denied as a window. */
  openWindow(url: string): void
  /** The main frame committed `url` (a load or an in-page change). */
  navigated(url: string): void
  /** The main frame finished loading (a re-pair trigger). */
  loaded(): void
  /** The window closed. */
  closed(): void
}

/** One remote window as the logic drives it. */
export interface RemoteWindowView {
  /** The BrowserWindow's id. */
  readonly id: number
  /** Its page's WebContents id (the partition's request events name it). */
  readonly webContentsId: number
  /** Start loading `url`; a failed load is the page's (an empty page at the URL), never a throw. */
  load(url: string): void
  reload(): void
  focus(): void
  setTitle(title: string): void
  /** The page's current URL ('' when there is none). */
  url(): string
  /** Show `text` as the window's page, as plain text (never HTML: it may carry the server's words). */
  showError(text: string): void
  close(): void
}

/** What a server's partition reports, and what it asks main to decide. */
export interface RemoteSessionHooks {
  /** A request the page (or anything in the partition) is about to send: may it go out? */
  allowRequest(url: string): boolean
  /** A GET to SESSION_PATH from the page of WebContents `webContentsId` completed (a re-pair trigger). */
  sessionRequestCompleted(webContentsId: number): void
}

/** One server's partition. */
export interface RemoteSessionView {
  readonly jar: RemoteCookieJar
  /** GET `url` with the partition's cookies and parse the JSON body; rejects on a network error or a non-2xx answer. */
  fetchJson(url: string): Promise<unknown>
  /**
   * POST `body` as JSON to `url` with the partition's cookies and `Origin: <origin>` (the gateway
   * refuses a POST whose Origin is not the server's own). Any status answers, with the JSON body
   * (undefined when it is not JSON); rejects only on a network error.
   */
  postJson(url: string, body: unknown, origin: string): Promise<{ status: number; body: unknown }>
}

export interface RemoteWindowFactory {
  /** Prepare server `serverId`'s partition and hook it up; called once per server, before its first window. */
  session(serverId: string, hooks: RemoteSessionHooks): RemoteSessionView
  /** A new window on server `serverId`'s partition, shown, with nothing loaded yet. */
  create(serverId: string, title: string, hooks: RemoteWindowHooks): RemoteWindowView
}

/** The slice of RemoteServerStore the windows use. */
export interface RemoteWindowsStore extends RemoteCookieStore {
  get(id: string): RemoteServerRecord | undefined
  recordRecent(id: string, projectId: string, name: string, at: number): void
}

export interface RemoteWindowsTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface RemoteWindowsOptions {
  factory: RemoteWindowFactory
  store: RemoteWindowsStore
  /** An http(s) link a page asked to open: the person's own browser (main's `createOpenExternal`). */
  openExternal(url: string): Promise<void> | void
  /** A one-time add-device token for an SSH server (`addDeviceToken` over the server's built-in SSH link). */
  mintToken(server: RemoteServerRecord): Promise<string>
  /** The last window of a server closed (its tunnel can be released). */
  onAllClosed?(serverId: string): void
  /**
   * Asked before every load main makes of a My own tunnel server's page (tunnel-probe.ts
   * `tunnelGate`). Absent: every load goes ahead (tests of the other kinds).
   */
  gate?(server: RemoteServerRecord): Promise<LoadGate>
  /** A window opened or closed (WindowManager's counts). */
  onChanged?(): void
  /**
   * A project page went back to the server's picker: the desktop picker shows instead (WindowManager
   * `showPicker`; it focuses one already open). Absent: the navigation is only cancelled (tests).
   */
  showPicker?(): void
  now?(): number
  timers?: RemoteWindowsTimers
  log?(message: string): void
}

/** How a window is opened: the server's current origin, and the project and sign-in token, if any. */
export interface RemoteOpenRequest {
  /** `scheme://host[:port]`: the tunnel's `http://127.0.0.1:<L>` or a Direct server's origin. */
  origin: string
  /** Absent: the server's own web picker. */
  projectId?: string
  /** A one-time access token (a fresh pairing): the page signs in with `#t=`. */
  token?: string
  /**
   * The tab the project page selects once loaded (a session chip of another project, see
   * `isProjectSwitch`). A new window only: a window that shows the project already is only focused.
   */
  tabId?: string
}

interface ServerState {
  origin: string
  readonly session: RemoteSessionView
  readonly cookie: RemoteCookie
  /** The saved cookie is in the jar (or there is none): every first load waits for it. */
  restored: Promise<void>
  pairing: Promise<void> | undefined
  /** Pairings since a check last saw a device (MAX_PAIR_ATTEMPTS). */
  attempts: number
  /** Re-pairs waiting for the page's sign-in to land the cookie. */
  signedIn: Array<() => void>
}

interface WindowRecord {
  readonly serverId: string
  readonly view: RemoteWindowView
  /** The project the window shows; undefined on the server's picker. */
  project: string | undefined
  /** The project the title was last resolved for (a name lookup per project change, not per pushState). */
  titled: string | undefined | null
  readonly budget: OpenBudget
  closed: boolean
  /** Bumped by every main-made load: a gate answer for an older one is dropped. */
  loads: number
  /** A gated load waiting for the tunnel: its retry timer, and the text the window shows. */
  retry: unknown
  waiting: string | undefined
}

export type SessionReply = { mode: string; device: { id: string } | null }

/**
 * Whether a main-made project page load asks the server first (see the header). `open`: a window
 * opened on a project (from the picker, or reloaded after another window's sign-in): asks, then
 * loads in any case. `signedIn`: a sign-in just landed with the page already on the project: loads
 * only when the server reopened it, or when the window is not on the server's page.
 */
type ReopenMode = 'open' | 'signedIn'

/** What the server said about a project before its page loads. */
type ProjectCheck = { open: true } | { reopened: string } | { error: string } | { unknown: true }

/** The SESSION_PATH answer, checked; undefined when it is not one (the gateway's own shape, web-protocol.ts). */
export function sessionReplyOf(body: unknown): SessionReply | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { mode, device } = body as Record<string, unknown>
  if (typeof mode !== 'string') return undefined
  if (device === null) return { mode, device: null }
  if (typeof device !== 'object' || typeof (device as Record<string, unknown>)['id'] !== 'string') return undefined
  return { mode, device: { id: (device as { id: string }).id } }
}

/** A project's name in the PROJECTS_PATH answer (open projects first, then server mode's recent ones). */
function projectNameOf(body: unknown, projectId: string): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  for (const key of ['projects', 'recent']) {
    const list = (body as Record<string, unknown>)[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue
      const { id, name } = entry as Record<string, unknown>
      if (id === projectId && typeof name === 'string') return name
    }
  }
  return undefined
}

/** The ids of the projects open on the server (PROJECTS_PATH `projects`), or undefined for another shape. */
function openProjectIdsOf(body: unknown): Set<string> | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const list = (body as Record<string, unknown>)['projects']
  if (!Array.isArray(list)) return undefined
  const ids = new Set<string>()
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue
    const { id } = entry as Record<string, unknown>
    if (typeof id === 'string') ids.add(id)
  }
  return ids
}

const realTimers: RemoteWindowsTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export class RemoteWindows {
  private readonly options: RemoteWindowsOptions
  private readonly log: (message: string) => void
  private readonly timers: RemoteWindowsTimers
  private readonly servers = new Map<string, ServerState>()
  /** By window id, in opening order. */
  private readonly windows = new Map<number, WindowRecord>()
  private readonly byWebContents = new Map<number, WindowRecord>()

  constructor(options: RemoteWindowsOptions) {
    this.options = options
    this.log = options.log ?? warnLog
    this.timers = options.timers ?? realTimers
  }

  /**
   * Open server `serverId`'s project (or its picker) at `request.origin`, or focus the window that
   * shows it already. A token signs in: an existing window of that project loads it too. Resolves
   * once the window exists and its first load started (after the saved cookie is in the jar).
   * Throws for an unknown server.
   */
  async open(serverId: string, request: RemoteOpenRequest): Promise<void> {
    if (this.options.store.get(serverId) === undefined) throw new Error('unknown server')
    const state = this.serverState(serverId, request.origin)
    if (state.origin !== request.origin) await this.setOrigin(serverId, request.origin)
    // The person's own retry (picker, Connect): the re-pair count starts again.
    state.attempts = 0
    await state.restored
    const projectId = request.projectId === '' ? undefined : request.projectId
    const existing = this.find(serverId, projectId)
    if (existing !== undefined) {
      if (request.token !== undefined) this.signInWith(existing, state, request.token)
      existing.view.focus()
      return
    }
    const server = this.options.store.get(serverId)
    if (server === undefined) throw new Error('unknown server')
    // The hooks run only after create returned (the page has not loaded anything before that).
    const made: { rec?: WindowRecord } = {}
    const view = this.options.factory.create(serverId, remoteTitle(server.name), {
      allowNavigation: (url) =>
        made.rec === undefined ? allowRemoteNavigation(url, this.servers.get(serverId)?.origin) : this.allowNavigation(made.rec, url),
      openWindow: (url) => {
        if (made.rec !== undefined) this.openWindow(made.rec, url)
      },
      navigated: (url) => {
        if (made.rec !== undefined) this.navigated(made.rec, url)
      },
      loaded: () => {
        if (made.rec !== undefined) this.trigger(made.rec)
      },
      closed: () => {
        if (made.rec !== undefined) this.closed(made.rec)
      }
    })
    const rec: WindowRecord = { serverId, view, project: projectId, titled: null, budget: new OpenBudget(), closed: false, loads: 0, retry: undefined, waiting: undefined }
    made.rec = rec
    this.windows.set(view.id, rec)
    this.byWebContents.set(view.webContentsId, rec)
    this.options.onChanged?.()
    this.updateTitle(rec)
    if (request.token !== undefined) this.signInWith(rec, state, request.token)
    else this.load(rec, remotePageUrl(state.origin, projectId, undefined, request.tabId), projectId === undefined ? undefined : 'open')
  }

  /**
   * Server `serverId` is now at `origin` (the tunnel came back on another local port): its windows
   * load their page there. The cookie is set again first (ports do not scope cookies, but a Direct
   * server's host may differ). No windows, or the same origin: nothing to do.
   */
  async setOrigin(serverId: string, origin: string): Promise<void> {
    const state = this.servers.get(serverId)
    if (state === undefined || state.origin === origin) return
    state.origin = origin
    state.restored = state.cookie.restore()
    await state.restored
    for (const rec of this.windowsOf(serverId)) this.load(rec, remotePageUrl(origin, rec.project))
  }

  /** Open remote windows, all servers (WindowManager's lifecycle rules). */
  count(): number {
    return this.windows.size
  }

  /** Open windows of one server. */
  countOf(serverId: string): number {
    return this.windowsOf(serverId).length
  }

  /** Focus the most recently opened remote window; false when there is none. */
  focusAny(): boolean {
    const last = [...this.windows.values()].pop()
    if (last === undefined) return false
    last.view.focus()
    return true
  }

  /** The server was renamed: its windows' titles follow. */
  refreshTitles(serverId: string): void {
    for (const rec of this.windowsOf(serverId)) {
      rec.titled = null
      this.updateTitle(rec)
    }
  }

  /** Close every window of a server. */
  closeServer(serverId: string): void {
    for (const rec of this.windowsOf(serverId)) rec.view.close()
  }

  /**
   * Forget: the server's windows closed and its state dropped. Its partition's listeners stay (a
   * session cannot drop them) but find no server any more: every loopback request is refused and a
   * cookie change is ignored. The caller empties the partition (`clearSession` of the adapter).
   */
  forget(serverId: string): void {
    this.closeServer(serverId)
    this.servers.delete(serverId)
  }

  /** Close every remote window (quit). */
  closeAll(): void {
    for (const rec of [...this.windows.values()]) rec.view.close()
  }

  /** Settles once the server's pairing in progress, if any, is over (tests). */
  async settled(serverId: string): Promise<void> {
    await this.servers.get(serverId)?.pairing
  }

  // -------------------------------------------------------------------------------------------

  private serverState(serverId: string, origin: string): ServerState {
    const existing = this.servers.get(serverId)
    if (existing !== undefined) return existing
    const session = this.options.factory.session(serverId, {
      allowRequest: (url) => allowRemoteRequest(url, this.servers.get(serverId)?.origin),
      sessionRequestCompleted: (webContentsId) => {
        const rec = this.byWebContents.get(webContentsId)
        if (rec !== undefined && rec.serverId === serverId) this.trigger(rec)
      }
    })
    const cookie = new RemoteCookie({
      serverId,
      jar: session.jar,
      store: this.options.store,
      origin: () => this.servers.get(serverId)?.origin,
      onSignedIn: () => this.signedIn(serverId),
      log: this.log
    })
    const state: ServerState = { origin, session, cookie, restored: Promise.resolve(), pairing: undefined, attempts: 0, signedIn: [] }
    // Before anything reads the origin back through `this.servers` (restore does).
    this.servers.set(serverId, state)
    state.restored = cookie.restore()
    return state
  }

  private windowsOf(serverId: string): WindowRecord[] {
    return [...this.windows.values()].filter((r) => r.serverId === serverId)
  }

  private find(serverId: string, projectId: string | undefined): WindowRecord | undefined {
    return this.windowsOf(serverId).find((r) => r.project === projectId)
  }

  /**
   * A main-frame navigation the page started. The origin pin first; then a project page going back
   * to the server's picker is cancelled and the desktop picker shows instead (design §4 "Back to the
   * picker"): in this app the person's project list is the desktop's, with local projects and the
   * other servers, not the server's web one. Done here, on the navigation, so any server version's
   * web client gets it. Main's own loads (the picker after a duplicate project, a sign-in) never
   * come through here (`loadURL` fires no will-navigate).
   */
  private allowNavigation(rec: WindowRecord, url: string): boolean {
    const origin = this.servers.get(rec.serverId)?.origin
    if (!allowRemoteNavigation(url, origin)) return false
    const from = rec.view.url()
    const project = projectOfUrl(from)
    if (rec.closed || project === undefined) return true
    if (isProjectSwitch(from, url, origin)) {
      this.switchProject(rec, url)
      return false
    }
    if (!isPickerNavigation(from, url, origin)) return true
    this.backToPicker(rec, project)
    return false
  }

  /**
   * A project page going to another project's page (a session chip of that project: the server
   * sends the clicking view there, `project.goto`): cancelled, and that project gets its own window
   * on the same server, as the desktop picker would open it (a window that shows it already is
   * focused). This window keeps its project: one window per (server, project), and the person
   * clicked a chip, not "close this one".
   */
  private switchProject(rec: WindowRecord, url: string): void {
    const state = this.servers.get(rec.serverId)
    const projectId = projectOfUrl(url)
    if (state === undefined || projectId === undefined) return
    const tabId = tabOfUrl(url)
    void this.open(rec.serverId, { origin: state.origin, projectId, ...(tabId === undefined ? {} : { tabId }) }).catch((err: unknown) =>
      this.log(`remote ${rec.serverId}: opening the other project's window failed: ${errorText(err)}`)
    )
  }

  /**
   * The desktop picker shows; then the window stays or goes by whether the server still has its
   * project open. Still open (the tab strip's "+"): the window is kept as it is. Not open (Close
   * project, or a project page that found its window gone): the window closes. The server not
   * answering, or an answer that is not a project list: the window is kept (never closed on a
   * guess; the person can close it).
   */
  private backToPicker(rec: WindowRecord, project: string): void {
    this.options.showPicker?.()
    const state = this.servers.get(rec.serverId)
    if (state === undefined) return
    void state.session.fetchJson(`${state.origin}${PROJECTS_PATH}`).then(
      (body) => {
        if (rec.closed) return
        const open = openProjectIdsOf(body)
        if (open === undefined) {
          this.log(`remote ${rec.serverId}: the project list was not one; the window stays`)
          return
        }
        if (!open.has(project)) rec.view.close()
      },
      (err: unknown) => this.log(`remote ${rec.serverId}: the project list did not answer; the window stays: ${errorText(err)}`)
    )
  }

  private openWindow(rec: WindowRecord, url: string): void {
    let href: string
    try {
      href = overlayUrlOf(url)
    } catch {
      return
    }
    if (!rec.budget.take(this.options.now?.() ?? Date.now())) {
      this.log(`remote ${rec.serverId}: dropped a window.open past ${MAX_OPENS_PER_VIEW} in ${OPEN_WINDOW_MS / 1000} s`)
      return
    }
    void Promise.resolve()
      .then(() => this.options.openExternal(href))
      .catch((err: unknown) => this.log(`remote ${rec.serverId}: open external failed: ${errorText(err)}`))
  }

  private navigated(rec: WindowRecord, url: string): void {
    const state = this.servers.get(rec.serverId)
    // The error page (data:), an empty page: the window still stands for what it showed.
    if (rec.closed || state === undefined || !onOrigin(url, state.origin)) return
    const project = projectOfUrl(url)
    if (project !== undefined) {
      const other = this.windowsOf(rec.serverId).find((r) => r !== rec && r.project === project)
      if (other !== undefined) {
        // The server's picker opened a project another window shows: that window, and this one back.
        other.view.focus()
        rec.project = undefined
        this.updateTitle(rec)
        this.load(rec, remotePageUrl(state.origin))
        return
      }
    }
    rec.project = project
    this.updateTitle(rec)
  }

  /** The title for the window's project: the server's name at once, the project's name once the server said it. */
  private updateTitle(rec: WindowRecord): void {
    if (rec.titled === rec.project) return
    const server = this.options.store.get(rec.serverId)
    const state = this.servers.get(rec.serverId)
    if (server === undefined || state === undefined) return
    const project = rec.project
    rec.titled = project
    rec.view.setTitle(remoteTitle(server.name))
    if (project === undefined) return
    void state.session.fetchJson(`${state.origin}${PROJECTS_PATH}`).then(
      (body) => {
        if (rec.closed || rec.project !== project) return
        const name = projectNameOf(body, project)
        const entry = name === undefined ? undefined : recentEntryOf(project, name, this.options.now?.() ?? Date.now())
        if (entry === undefined) return
        const current = this.options.store.get(rec.serverId)
        if (current === undefined) return
        rec.view.setTitle(remoteTitle(current.name, entry.name))
        this.options.store.recordRecent(rec.serverId, project, entry.name, entry.at)
      },
      (err: unknown) => {
        // Signed out (a 401 until the re-pair lands) or the server away: the title stays the server's.
        // The next navigation asks again.
        if (rec.project === project) rec.titled = null
        this.log(`remote ${rec.serverId}: the project list did not answer: ${errorText(err)}`)
      }
    )
  }

  private closed(rec: WindowRecord): void {
    if (rec.closed) return
    rec.closed = true
    this.stopWaiting(rec)
    this.windows.delete(rec.view.id)
    this.byWebContents.delete(rec.view.webContentsId)
    this.options.onChanged?.()
    if (this.countOf(rec.serverId) === 0) this.options.onAllClosed?.(rec.serverId)
  }

  /** A re-pair trigger: a finished load, or the page's own completed SESSION_PATH request. */
  private trigger(rec: WindowRecord): void {
    if (rec.closed) return
    const server = this.options.store.get(rec.serverId)
    // Direct never re-pairs: the page's own sign-in screen is the way back.
    if (server === undefined || server.via.kind !== 'ssh') return
    const state = this.servers.get(rec.serverId)
    // Not the server's page (the error page, an empty page): nothing to check.
    if (state === undefined || !onOrigin(rec.view.url(), state.origin)) return
    // One pairing per server at a time; it reloads this window too once the cookie lands.
    if (state.pairing !== undefined) return
    this.hold(rec, state, () => this.pair(rec, state))
  }

  /**
   * A window was handed a token (Connect, or the picker with a fresh pairing): it signs in with it,
   * and until the cookie lands (or PAIR_WAIT_MS) the server's triggers wait. Without that hold the
   * page's own first SESSION_PATH request, made before it posts the token, would read `device:
   * null` and mint a second token, voiding the page's (the server keeps one at a time). Then, for
   * SSH, the usual check: a token that did not work re-pairs, bounded as any re-pair. A pairing
   * already running keeps the say; the token is only loaded.
   */
  private signInWith(rec: WindowRecord, state: ServerState, token: string): void {
    if (state.pairing !== undefined) {
      this.load(rec, remotePageUrl(state.origin, rec.project, token))
      return
    }
    this.hold(rec, state, async () => {
      await this.loadToken(rec, state, token)
      if (this.options.store.get(rec.serverId)?.via.kind === 'ssh') await this.pair(rec, state)
    })
  }

  /** Run `work` as the server's one pairing; triggers wait while it runs. */
  private hold(rec: WindowRecord, state: ServerState, work: () => Promise<void>): void {
    const run: Promise<void> = work()
      .catch((err: unknown) => this.log(`remote ${rec.serverId}: signing in again failed: ${errorText(err)}`))
      .finally(() => {
        if (state.pairing === run) state.pairing = undefined
      })
    state.pairing = run
  }

  /**
   * Load the page with `token` in `rec` and wait for the sign-in to land the cookie; the server's
   * other windows (still on their sign-in screen) reload once it has. True when it landed.
   */
  private async loadToken(rec: WindowRecord, state: ServerState, token: string): Promise<boolean> {
    const landed = this.waitSignedIn(state)
    this.load(rec, remotePageUrl(state.origin, rec.project, token))
    const ok = await landed
    if (ok) {
      for (const other of this.windowsOf(rec.serverId)) if (other !== rec) this.reload(other, state)
      // The page signed in on its project: one the server closed shows "not open" until reopened.
      if (rec.project !== undefined) this.load(rec, remotePageUrl(state.origin, rec.project), 'signedIn')
    }
    return ok
  }

  /** Whether main's loads of this server pass the gate first (My own tunnel). */
  private gated(serverId: string): RemoteServerRecord | undefined {
    const server = this.options.store.get(serverId)
    return this.options.gate !== undefined && server?.via.kind === 'tunnel' ? server : undefined
  }

  /**
   * A load main makes: at once, or for a gated server once the gate lets it; with `reopen`, after
   * the project check (`loadChecked`). A newer load replaces one still waiting; a closed window
   * loads nothing.
   */
  private load(rec: WindowRecord, url: string, reopen?: ReopenMode): void {
    if (rec.closed) return
    rec.loads++
    this.clearRetry(rec)
    const server = this.gated(rec.serverId)
    if (server === undefined) {
      this.loadChecked(rec, url, rec.loads, reopen)
      return
    }
    const attempt = rec.loads
    const gate = this.options.gate as (server: RemoteServerRecord) => Promise<LoadGate>
    void gate(server)
      .catch((err: unknown): LoadGate => ({ error: `checking the tunnel failed: ${errorText(err)}` }))
      .then((result) => {
        if (rec.closed || rec.loads !== attempt) return
        if ('go' in result) {
          this.loadChecked(rec, url, attempt, reopen)
        } else if ('error' in result) {
          rec.waiting = undefined
          rec.view.showError(result.error)
        } else {
          // The page is shown once; the retries only probe until something answers.
          if (rec.waiting !== result.wait) rec.view.showError(result.wait)
          rec.waiting = result.wait
          rec.retry = this.timers.setTimeout(() => {
            rec.retry = undefined
            if (!rec.closed && rec.loads === attempt) this.load(rec, url, reopen)
          }, TUNNEL_RETRY_MS)
        }
      })
  }

  /**
   * The gate let load `attempt` go (or there is none): the page loads, after the project check when
   * `reopen` asks for one and `url` shows a project. An answer for an older load is dropped.
   */
  private loadChecked(rec: WindowRecord, url: string, attempt: number, reopen: ReopenMode | undefined): void {
    const state = this.servers.get(rec.serverId)
    const project = reopen === undefined ? undefined : projectOfUrl(url)
    if (state === undefined || project === undefined) {
      rec.waiting = undefined
      rec.view.load(url)
      return
    }
    const origin = state.origin
    void this.checkProject(rec, state.session, origin, project).then((check) => {
      if (rec.closed || rec.loads !== attempt) return
      if ('error' in check) {
        const server = this.options.store.get(rec.serverId)
        rec.waiting = undefined
        rec.view.showError(`${server?.name ?? 'The server'} could not reopen this project: ${check.error}`)
      } else if ('reopened' in check) {
        rec.waiting = undefined
        rec.view.load(remotePageUrl(origin, check.reopened))
      } else if (reopen === 'open' || !onOrigin(rec.view.url(), origin)) {
        // Open already, or the server could not tell: the page as before (it shows its own state).
        rec.waiting = undefined
        rec.view.load(url)
      }
    })
  }

  /**
   * Is `project` open on the server, and if not, reopen it (the server's web picker's own POST,
   * picker-model.ts `openProject`). Never throws: a server that cannot tell (signed out, away, an
   * old gateway with no such POST) is `unknown`.
   */
  private async checkProject(rec: WindowRecord, session: RemoteSessionView, origin: string, project: string): Promise<ProjectCheck> {
    const url = `${origin}${PROJECTS_PATH}`
    let open: Set<string> | undefined
    try {
      open = openProjectIdsOf(await session.fetchJson(url))
    } catch (err) {
      // Signed out (401): the page's sign-in, then a re-pair, and the check runs again once it lands.
      this.log(`remote ${rec.serverId}: the project list did not answer; loading the project page as is: ${errorText(err)}`)
      return { unknown: true }
    }
    if (open === undefined) return { unknown: true }
    if (open.has(project)) return { open: true }
    if (rec.closed) return { unknown: true }
    const request: WebOpenProjectRequest = { reopen: project }
    let answer: { status: number; body: unknown }
    try {
      answer = await session.postJson(url, request, origin)
    } catch (err) {
      this.log(`remote ${rec.serverId}: reopening the project did not answer: ${errorText(err)}`)
      return { unknown: true }
    }
    const body = answer.body !== null && typeof answer.body === 'object' ? (answer.body as Record<string, unknown>) : {}
    const { id, error } = body
    if (answer.status === 200 && typeof id === 'string' && id !== '' && id.length <= MAX_PROJECT_ID) return { reopened: id }
    // 401: signed out since the list answered; the page's sign-in shows, as for a list that did not.
    if (answer.status !== 401 && typeof error === 'string') {
      const text = serverText(error, MAX_SERVER_ERROR)
      if (text !== '') return { error: text }
    }
    this.log(`remote ${rec.serverId}: reopening the project answered ${answer.status}; loading the project page as is`)
    return { unknown: true }
  }

  /**
   * Another window's sign-in landed: this one shows its page again (through the gate when it has one;
   * a project page after the project check, since it may have shown "not open" while signed out).
   */
  private reload(rec: WindowRecord, state: ServerState): void {
    if (rec.project !== undefined) this.load(rec, remotePageUrl(state.origin, rec.project), 'open')
    else if (this.gated(rec.serverId) !== undefined) this.load(rec, remotePageUrl(state.origin))
    else rec.view.reload()
  }

  private clearRetry(rec: WindowRecord): void {
    if (rec.retry === undefined) return
    this.timers.clearTimeout(rec.retry)
    rec.retry = undefined
  }

  private stopWaiting(rec: WindowRecord): void {
    this.clearRetry(rec)
    rec.waiting = undefined
  }

  private async pair(rec: WindowRecord, state: ServerState): Promise<void> {
    for (;;) {
      let reply: SessionReply | undefined
      try {
        reply = sessionReplyOf(await state.session.fetchJson(`${state.origin}${SESSION_PATH}`))
      } catch {
        // The server away or not answering: the page shows its own state; the next load asks again.
        return
      }
      if (reply === undefined) return
      if (reply.device !== null) {
        state.attempts = 0
        return
      }
      // Password: the server's own page asks the person once. Confirm, None: nothing a token fixes.
      if (reply.mode !== 'link') return
      const server = this.options.store.get(rec.serverId)
      if (rec.closed || server === undefined || server.via.kind !== 'ssh') return
      if (state.attempts >= MAX_PAIR_ATTEMPTS) {
        rec.view.showError(
          `${server.name} did not take this app's sign-in (tried ${MAX_PAIR_ATTEMPTS} times). Close this window and connect again from the project picker; if it keeps failing, check the devices in the server's web access settings.`
        )
        return
      }
      state.attempts++
      let token: string
      try {
        token = await this.options.mintToken(server)
      } catch (err) {
        if (!rec.closed) rec.view.showError(`Signing in to ${server.name} again failed: ${errorText(err)}`)
        return
      }
      if (rec.closed) return
      await this.loadToken(rec, state, token)
      // Then check again: a device now (done), or none (the next attempt, or the error).
    }
  }

  /** Resolves true when a sign-in lands the cookie, false after PAIR_WAIT_MS. */
  private waitSignedIn(state: ServerState): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        this.timers.clearTimeout(timer)
        state.signedIn = state.signedIn.filter((f) => f !== onSignedIn)
        resolve(ok)
      }
      const onSignedIn = (): void => finish(true)
      const timer = this.timers.setTimeout(() => finish(false), PAIR_WAIT_MS)
      state.signedIn.push(onSignedIn)
    })
  }

  private signedIn(serverId: string): void {
    const state = this.servers.get(serverId)
    if (state === undefined) return
    for (const resolve of [...state.signedIn]) resolve()
  }
}
