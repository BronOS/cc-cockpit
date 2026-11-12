// The web access gateway (design-web.md §2, §4): a Node `http` server plus `ws` upgrades, on the
// bind the settings name, started and stopped with them. Off by default, and off costs nothing:
// nothing listens, and `ws` is loaded (dynamic import) only when the gateway first starts, so an
// app that never turns web access on never loads it (test/unit/web-gateway.test.ts checks both).
//
// What this skeleton does (plan Task 4): the always-on checks of §4.1 on every request and
// upgrade, whatever comes later behind them:
//  - Host allow-list on every request and the upgrade (DNS rebinding), checks.ts.
//  - Origin equal to the cockpit's own page on the upgrade and on every state-changing request
//    (anything but GET/HEAD; sign-in posts come with plan Task 5). On loopback this, not
//    SameSite, is what keeps another localhost page out (checks.ts says why).
//  - The web shell's CSP and `Cache-Control: no-store` on every answer.
//  - Any IP address may be bound; the §4.3 risks (plain http or no sign-in on a network address)
//    only once confirmed on the settings page (settings.ts listenPlanOf). With TLS settings the
//    listener is https (the certificate and key are read when it starts, so a renewed certificate
//    takes effect on the next start: off and on, or a restart), and the Origin rule, the frame
//    origins and the cookie's Secure follow its scheme.
// Behind those, sign-in (auth.ts, plan Tasks 5 and 27): the web shell (`/` and `/assets/…`,
// shell-files.ts, plan Task 8) and the sign-in routes (link, password, desktop confirm) are open,
// everything else (the upgrade first, the project list) needs a device (`WebAuth.authorize`: the
// device cookie, or None mode).
// An upgrade that passes goes to the socket handler main installs (the wire protocol,
// connection.ts); with none installed it is refused, so the gateway never hands out a socket
// nobody speaks the protocol on.
// Sockets are tracked by device: a revoke closes that device's sockets at once, and leaving None
// mode closes the anonymous ones. Connects and disconnects go to the access log.
// Plugin files and inline overlays (`/p/…`, `/o/…`, plugin-pages.ts, plan Task 20) are answered
// after the Host check and before the cookie check: a sandboxed plugin page's requests are
// cross-site and carry no cookie, so its path token is the credential. They get their own headers
// (never the shell's CSP or X-Frame-Options: the shell frames them). Their tokens die with the
// device (revoke, expiry), with None mode for the anonymous device, and when the gateway stops.
import { open, readFile, type FileHandle } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { pipeline } from 'node:stream/promises'
// Types only: erased at build time, so this file does not load `ws` (see loadWs below).
import type { WebSocket, WebSocketServer } from 'ws'
import {
  CLOSE,
  CONFIRM_ASK_PATH,
  CONFIRM_POLL_PATH,
  FOLDERS_PATH,
  PROJECTS_PATH,
  SESSION_PATH,
  SIGN_IN_LINK_PATH,
  SIGN_IN_PASSWORD_PATH,
  type WebConfirmTicket,
  type WebFoldersReply,
  type WebFoldersRequest,
  type WebOpenProjectRequest,
  type WebProjectEntry,
  type WebProjectsReply,
  type WebRecentProject,
  type WebServerHost,
  type WebSessionReply
} from '../../shared/web-protocol'
import { projectColorOf } from '../../shared/project-color'
import type { WebAccessMode, WebAccessSettings } from '../../shared/types'
import type { AccessLog } from './access-log'
import { deviceCookie, type SignInResult, type WebAuth } from './auth'
import { allowedHosts, checkHost, checkOrigin, webShellCsp, type OriginRule } from './checks'
import type { WebDevice } from './devices'
import { parseFoldersBody } from './list-folders'
import { parseOpenProjectBody, type OpenProjectOutcome } from './open-project'
import { pageNotFound, PluginPages, type PageAnswer } from './plugin-pages'
import { MAX_FRAME_BYTES, WS_PATH } from './protocol'
import { listenPlanOf, type ListenPlan } from './settings'
import { realShellFile, shellFileOf } from './shell-files'

export type WsModule = typeof import('ws')

/** A view closed with a notice has this long to answer the close handshake before it is dropped. */
export const CLOSE_GRACE_MS = 1_000

/**
 * Every socket is pinged this often; one that has not answered the previous ping by the next is
 * dropped. A phone that sleeps or moves from Wi-Fi to cellular leaves a half-open socket that still
 * reads as OPEN: without this its view stayed bound (counted against MAX_VIEWS_PER_DEVICE_WINDOW,
 * so the same phone's next page got the final `tooManyViews`), kept its device from expiring, kept
 * its size claim and holds, and piled up event frames until the kernel gave up on an idle link,
 * which it never does. So a dead peer goes within two intervals.
 */
const HEARTBEAT_MS = 30_000

// Listener bounds (listen below). Generous for a phone on a slow link, small next to an fd limit.
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
const IDLE_SOCKET_MS = 60_000
const MAX_CONNECTIONS = 256

// Largest frame a view may send (design-web.md §3, protocol.ts): `ws` closes the socket (1009) on
// a bigger one before it is buffered whole.
export { MAX_FRAME_BYTES }

/** Where the browser opens its one WebSocket per view (shared with the bridge, web-protocol.ts). */
export { WS_PATH }
/** The page posts the access link's token, the password, or a desktop-confirm ask and its polls here (auth.ts). */
export { CONFIRM_ASK_PATH, CONFIRM_POLL_PATH, SIGN_IN_LINK_PATH, SIGN_IN_PASSWORD_PATH }
/** What the page asks first: the mode, and whether this browser is signed in. */
export { SESSION_PATH }
/** The open project windows, for the web project picker (and server mode's open); needs a device. */
export { PROJECTS_PATH }
/** Server mode's folder browser (list-folders.ts); needs a device, a POST with the Origin check. */
export { FOLDERS_PATH }
/** A sign-in body is a token (or a password, or a ticket) and a device name; anything bigger is not one. */
export const MAX_SIGN_IN_BODY = 4096

export interface GatewayDeps {
  log(message: string): void
  /** Sign-in and devices (auth.ts). */
  auth: WebAuth
  accessLog: AccessLog
  /** Loads `ws`; tests count the calls. Default: a dynamic import, the only one in main. */
  loadWs?: () => Promise<WsModule>
  /** os.networkInterfaces / os.hostname, read only for a network bind. */
  interfaces?: () => ReturnType<typeof networkInterfaces>
  hostname?: () => string
  /**
   * The renderer build's output folder (out/renderer), holding the web shell (web/index.html) and
   * the chunks it shares with the desktop (assets/); shell-files.ts says what is served from it.
   * Undefined, or not built (a dev run before `npm run build`): `/` answers 503 saying so.
   */
  shellDir?: string
  /** The projects that have a window open now (main's window table), for the web picker. */
  openProjects?: () => WebProjectEntry[]
  /**
   * Server mode only (design-web.md §9.8): main passes it when its own `server` flag is on, never
   * otherwise. Present, the picker's GET adds `server`, the recent projects and the host, the POST
   * opens a folder, reopens a recent one, or relinks or forgets a missing one, and FOLDERS_PATH lists
   * a folder's subfolders; absent, both POSTs are 404 as any unknown route.
   */
  serverProjects?: ServerProjects
  /** Plugin files and inline overlays (plugin-pages.ts). Absent: `/p/` and `/o/` are 404. */
  pages?: PluginPages
  /** The ping interval (HEARTBEAT_MS); tests shorten it. */
  heartbeatMs?: number
}

/** What a browser may do with projects when there is no desktop (open-project.ts does the open). */
export interface ServerProjects {
  /** The recent projects with no window open, newest first, `missing` when the folder is gone. */
  recent(): WebRecentProject[]
  /**
   * A checked body (parseOpenProjectBody): the project id, the error text, or `unauthorized`.
   * `authorized` re-checks the request's device; the open must call it synchronously right before it
   * changes anything, after its last await (open-project.ts), and open nothing when it is false.
   */
  open(request: WebOpenProjectRequest, authorized: () => boolean): OpenProjectOutcome | Promise<OpenProjectOutcome>
  /** Which server this is, for the picker's welcome (host name, OS user, home folder). */
  host(): WebServerHost
  /**
   * A checked body (parseFoldersBody): one folder's subfolders, or the text why it cannot be listed
   * (list-folders.ts). Read-only, so no `authorized` at the end: the gateway's checks before it are
   * the ones that count, and a listing finishing after a revoke shows nothing it had not shown.
   */
  folders(request: WebFoldersRequest): Promise<WebFoldersReply>
}

export type GatewayStatus =
  | { state: 'off' }
  /** Enabled, but the settings may not listen (a §4.3 risk not confirmed); nothing listens. */
  | { state: 'refused'; reason: string }
  /** Enabled and allowed, but listening failed (port in use, `ws` missing, a certificate unreadable); nothing listens. */
  | { state: 'failed'; reason: string }
  | { state: 'listening'; bind: string; port: number }

/** A socket that passed Host, Origin and sign-in; the handler (connection.ts) owns it from here. */
export type SocketHandler = (ws: WebSocket, req: IncomingMessage, device: WebDevice) => void

type OkPlan = Extract<ListenPlan, { ok: true }>

/** `/` when there is no web shell to serve (a dev run before `npm run build`). */
const NOT_BUILT_TEXT = 'cc-cockpit web access is on, but the web shell is not built (npm run build).'

/** Content-hashed assets: a new build writes new names, so a browser may keep these for good. */
const IMMUTABLE = 'max-age=31536000, immutable'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What a sign-in route answers: a status, a JSON body, and the device cookie's value when one was made. */
interface SignInAnswer {
  status: number
  body: unknown
  cookie?: string
}

/**
 * A project as the picker's wire has it: the plain fields, and the colour checked once more (the
 * registry repaired it already; this is the last stop before a page that drops it into a style, as
 * router.ts `summary` for the desktop picker).
 */
function entryOf(p: { id: string; name: string; path: string; color?: unknown }): WebProjectEntry {
  const out: WebProjectEntry = { id: p.id, name: p.name, path: p.path }
  const color = projectColorOf(p.color)
  if (color !== undefined) out.color = color
  return out
}

/** The body as text, or undefined once it passes `max` bytes (the rest is not read). */
function readBody(req: IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > max) {
        done = true
        req.pause()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'))
      done = true
    })
    req.on('error', () => {
      if (!done) resolve(undefined)
      done = true
    })
  })
}

/** Whether two plans name the same TLS files (both none counts as the same). */
function sameTls(a: OkPlan, b: OkPlan): boolean {
  return a.tls?.certPath === b.tls?.certPath && a.tls?.keyPath === b.tls?.keyPath
}

/** A certificate or key file's PEM text; the error names the file, as the settings page shows it. */
async function readPem(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`cannot read the ${what} ${path}: ${(err as NodeJS.ErrnoException).code ?? errorText(err)}`, { cause: err })
  }
}

function refuseUpgrade(socket: Duplex, status: string): void {
  // The socket may already be gone (the client hung up); writing to it then must not throw.
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export class WebGateway {
  private server: Server | HttpsServer | undefined
  private wss: WebSocketServer | undefined
  private plan: OkPlan | undefined
  private hosts: ReadonlySet<string> = new Set()
  private current: GatewayStatus = { state: 'off' }
  private handler: SocketHandler | undefined
  /** apply/stop run one at a time: a toggle while a start is still listening must not race it. */
  private queue: Promise<unknown> = Promise.resolve()
  private ws: WsModule | undefined
  /** Every handed-out socket and the device it belongs to. */
  private readonly sockets = new Map<WebSocket, WebDevice>()
  /** Sockets that answered the last ping (or opened since); the rest are dropped on the next beat. */
  private readonly alive = new Set<WebSocket>()
  private heartbeat: ReturnType<typeof setInterval> | undefined
  /** Told after a socket is handed out or closes (the desktop's connected-devices indicator). */
  private readonly connectionListeners = new Set<() => void>()

  constructor(private readonly deps: GatewayDeps) {
    deps.auth.devices.onRevoked((ids) => {
      const gone = new Set(ids)
      // Its plugin paths die at once too (design-web.md §4.1): not only with its sockets' views.
      for (const id of ids) deps.pages?.tokens.dropDevice(id)
      for (const [ws, device] of this.sockets) if (gone.has(device.id)) ws.terminate()
    })
  }

  /** The ids of the devices with an open socket, each with its socket count (None's anonymous caller is `none`). */
  connections(): Map<string, number> {
    const out = new Map<string, number>()
    for (const device of this.sockets.values()) out.set(device.id, (out.get(device.id) ?? 0) + 1)
    return out
  }

  /** Closes every socket of a device without revoking it (the page reconnects); how many were closed. */
  disconnectDevice(id: string): number {
    let closed = 0
    for (const [ws, device] of this.sockets) {
      if (device.id !== id) continue
      ws.terminate()
      closed++
    }
    return closed
  }

  /** Calls `listener` whenever the set of open sockets changes; returns the unsubscribe. */
  onConnectionsChanged(listener: () => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  private connectionsChanged(): void {
    for (const listener of this.connectionListeners) {
      try {
        listener()
      } catch (err) {
        // The indicator failing must not take a socket down with it.
        this.deps.log(`web access: connection listener failed: ${errorText(err)}`)
      }
    }
  }

  /** What the gateway is doing now (for the log, the settings page and tests). */
  status(): GatewayStatus {
    return this.current
  }

  /** The bound address while listening. */
  address(): AddressInfo | undefined {
    const addr = this.server?.address()
    return addr !== null && typeof addr === 'object' ? addr : undefined
  }

  /** Installs who takes checked sockets (`WebConnections.accept`). Undefined: every upgrade is refused. */
  setSocketHandler(handler: SocketHandler | undefined): void {
    this.handler = handler
  }

  /**
   * Starts, stops or re-checks the gateway for these settings. Same bind and port while listening:
   * only the host list and origin change, open sockets stay. Never throws: a refusal or failure is
   * the returned status (and logged), and nothing listens then.
   */
  apply(settings: WebAccessSettings): Promise<GatewayStatus> {
    const run = this.queue.then(() => this.applyNow(settings))
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Stops listening and closes every socket. */
  stop(): Promise<void> {
    this.deps.auth.dropPending()
    const run = this.queue.then(() => this.close())
    this.queue = run.catch(() => undefined)
    return run.then(() => {
      this.current = { state: 'off' }
    })
  }

  private async applyNow(settings: WebAccessSettings): Promise<GatewayStatus> {
    const plan = listenPlanOf(settings)
    // Turning off while also leaving None: every socket gets the turned-off notice below, the None
    // ones too, rather than a plain terminate (1006) the page would retry against a closed server.
    this.setMode(settings.mode, plan.ok)
    if (!plan.ok) {
      // A browser waiting for a desktop confirm can no longer collect it.
      this.deps.auth.dropPending()
      // Turned off (or to a setting refused): the views are told so, and stop retrying (bridge.ts).
      await this.close(CLOSE.turnedOff)
      this.current = settings.enabled ? { state: 'refused', reason: plan.reason } : { state: 'off' }
      if (this.current.state === 'refused') this.deps.log(`web access: not listening: ${plan.reason}`)
      return this.current
    }
    // Same address and the same TLS files: keep the listener (open sockets stay). Turning TLS on or
    // off, or naming other files, needs a new listener of the other kind (or a new certificate).
    if (this.server && this.plan && this.plan.bind === plan.bind && this.plan.port === plan.port && sameTls(this.plan, plan)) {
      const before = this.plan
      this.use(plan)
      // Sockets were accepted under the old Host list and origin rule and are not tagged with them;
      // when the rules change, drop them all so a removed name or origin cannot stay connected.
      // The page reconnects, and is checked again.
      if (before && (before.externalOrigin !== plan.externalOrigin || before.hosts.join('\n') !== plan.hosts.join('\n'))) {
        for (const client of this.wss?.clients ?? []) client.terminate()
      }
      return this.current
    }
    await this.close()
    try {
      this.ws ??= await (this.deps.loadWs ?? (() => import('ws')))()
      await this.listen(plan, this.ws)
    } catch (err) {
      await this.close()
      this.current = { state: 'failed', reason: errorText(err) }
      this.deps.log(`web access: cannot listen on ${plan.bind}:${plan.port}: ${errorText(err)}`)
      return this.current
    }
    this.current = { state: 'listening', bind: plan.bind, port: plan.port }
    this.deps.log(`web access: listening on ${this.scheme()}://${plan.bind.includes(':') ? `[${plan.bind}]` : plan.bind}:${plan.port}`)
    return this.current
  }

  /** `purge`: drop the anonymous sockets when leaving None (false when every socket is closing anyway). */
  private setMode(mode: WebAccessMode, purge: boolean): void {
    const before = this.deps.auth.mode
    this.deps.auth.setMode(mode)
    // Leaving None: whoever came in without signing in is out now, and must sign in to come back.
    if (purge && before === 'none' && mode !== 'none') {
      for (const [ws, device] of this.sockets) if (device.mode === 'none') ws.terminate()
    }
    // The anonymous device's plugin paths go with it, so a later None starts from fresh tokens.
    if (before === 'none' && mode !== 'none') this.deps.pages?.tokens.dropDevice('none')
  }

  private use(plan: OkPlan): void {
    this.plan = plan
    this.hosts = allowedHosts({
      bind: plan.bind,
      port: plan.port,
      hosts: plan.hosts,
      ...(plan.externalOrigin !== undefined ? { externalOrigin: plan.externalOrigin } : {}),
      interfaces: (this.deps.interfaces ?? networkInterfaces)(),
      hostname: (this.deps.hostname ?? hostname)()
    })
  }

  /** The scheme the gateway serves now: https while listening with TLS. */
  private scheme(): 'http' | 'https' {
    return this.plan?.tls !== undefined ? 'https' : 'http'
  }

  private async listen(plan: OkPlan, ws: WsModule): Promise<void> {
    // Read before anything is set up, so an unreadable file fails the start with its name and
    // nothing half made is left. A malformed PEM throws from createServer (createSecureContext),
    // which fails the start the same way.
    const tls = plan.tls ? { cert: await readPem(plan.tls.certPath, 'certificate'), key: await readPem(plan.tls.keyPath, 'key') } : undefined
    this.use(plan)
    this.wss = new ws.WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    const handle = (req: IncomingMessage, res: ServerResponse): void => this.request(req, res)
    const server = tls ? createHttpsServer(tls, handle) : createServer(handle)
    // Bounds for what anyone past the Host check can hold before signing in (the shell, its assets
    // and plugin files stream from open file handles): a request must arrive in time, a stalled
    // download is dropped, and the listener takes a bounded number of sockets (upgraded views
    // included; `ws` clears the idle timeout on a socket it takes over).
    server.headersTimeout = HEADERS_TIMEOUT_MS
    server.requestTimeout = REQUEST_TIMEOUT_MS
    server.timeout = IDLE_SOCKET_MS
    server.maxConnections = MAX_CONNECTIONS
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head))
    // A client error (a malformed request line) is answered by Node; never let it reach the app.
    server.on('clientError', (_err, socket: Duplex) => refuseUpgrade(socket, '400 Bad Request'))
    this.server = server
    this.heartbeat = setInterval(() => this.beat(), this.deps.heartbeatMs ?? HEARTBEAT_MS)
    this.heartbeat.unref()
    return await new Promise((resolve, reject) => {
      server.once('error', reject)
      // `localhost` resolves through the resolver (often ::1 only, or something else on an odd host);
      // bind the literal loopback address so the listener is what the log and allow-list say.
      server.listen(plan.port, plan.bind === 'localhost' ? '127.0.0.1' : plan.bind, () => {
        server.off('error', reject)
        server.on('error', (err) => this.deps.log(`web access: server error: ${errorText(err)}`))
        resolve()
      })
    })
  }

  /**
   * Stops listening. Open sockets are dropped, or, with `notice`, closed with that code so the page
   * can say why (web access turned off). The close handshake is waited for before the server goes
   * (closing the server's connections would cut the close frame off: the page would see 1006 and
   * retry), at most CLOSE_GRACE_MS; a peer that does not answer by then is dropped, so no socket (and
   * no view) outlives the gateway.
   */
  private async close(notice?: number): Promise<void> {
    const server = this.server
    const wss = this.wss
    clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.server = undefined
    this.wss = undefined
    this.plan = undefined
    this.hosts = new Set()
    // Every plugin path dies with the listener; views coming back get fresh ones in `ready`.
    this.deps.pages?.tokens.clear()
    if (wss) {
      const clients = [...wss.clients]
      if (notice === undefined || clients.length === 0) {
        for (const client of clients) client.terminate()
      } else {
        await new Promise<void>((resolve) => {
          let open = clients.length
          const timer = setTimeout(resolve, CLOSE_GRACE_MS)
          timer.unref()
          for (const client of clients) {
            client.once('close', () => {
              if (--open > 0) return
              clearTimeout(timer)
              resolve()
            })
            client.close(notice, 'web access off')
          }
        })
        for (const client of clients) client.terminate()
      }
      wss.close()
    }
    if (!server) return
    await new Promise<void>((resolve) => {
      // Keep-alive connections would hold close() open until they time out.
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  /** One heartbeat (HEARTBEAT_MS): drop a socket that did not answer the last ping, ping the rest. */
  private beat(): void {
    for (const ws of this.sockets.keys()) {
      if (!this.alive.delete(ws)) {
        this.deps.log('web access: socket dropped, no answer to a ping')
        ws.terminate()
        continue
      }
      try {
        ws.ping()
      } catch {
        // Not open any more: its 'close' takes it out.
      }
    }
  }

  /** The origins the shell page may be loaded under, for the CSP's frame-src. */
  private frameOrigins(host: string): string[] {
    const own = `${this.scheme()}://${host}`
    return this.plan?.externalOrigin !== undefined ? [own, this.plan.externalOrigin] : [own]
  }

  private send(
    res: ServerResponse,
    host: string | undefined,
    status: number,
    type: string,
    body: string | Buffer,
    extra: Record<string, string> = {}
  ): void {
    this.writeHead(res, host, status, type, extra)
    res.end(body)
  }

  /** The headers every answer carries (see `send`); a streamed answer writes its body after. */
  private writeHead(res: ServerResponse, host: string | undefined, status: number, type: string, extra: Record<string, string> = {}): void {
    res.writeHead(status, {
      // Only the hashed assets override it (`IMMUTABLE`); the page, its answers and errors never.
      'Cache-Control': 'no-store',
      ...extra,
      'Content-Type': type,
      'Content-Security-Policy': webShellCsp(host === undefined ? [] : this.frameOrigins(host)),
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    })
  }

  private request(req: IncomingMessage, res: ServerResponse): void {
    const host = checkHost(req.headers.host, this.hosts)
    if (!host) return this.send(res, undefined, 403, 'text/plain; charset=utf-8', 'unknown host')
    const method = req.method ?? 'GET'
    const safe = method === 'GET' || method === 'HEAD'
    if (!safe && method !== 'POST') return this.send(res, host, 405, 'text/plain; charset=utf-8', 'method not allowed')
    // Every state-changing request, before its route is even looked up: a foreign page must learn
    // nothing from which of its posts would have existed.
    if (!safe && !checkOrigin(req.headers.origin, host, this.originRule())) {
      this.deps.log(`web access: ${method} refused, origin ${JSON.stringify((req.headers.origin ?? 'none').slice(0, 100))}`)
      return this.send(res, host, 403, 'text/plain; charset=utf-8', 'origin not allowed')
    }
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    // Open without sign-in: the page and its files (it signs in from there, shell-files.ts) and
    // the sign-in routes.
    if (safe && (path === '/' || path.startsWith('/assets/'))) {
      return void this.shellFile(path, method === 'HEAD', res, host).catch((err: unknown) => {
        this.deps.log(`web access: serving ${path.slice(0, 100)} failed: ${errorText(err)}`)
        if (!res.headersSent && !res.destroyed) this.send(res, host, 500, 'text/plain; charset=utf-8', 'server error')
      })
    }
    // Plugin files and inline overlays: their path token is the credential (plugin-pages.ts).
    if (safe && PluginPages.handles(path)) {
      return void this.page(path, method, res, host).catch((err: unknown) => {
        this.deps.log(`web access: serving a plugin page failed: ${errorText(err)}`)
        if (!res.headersSent && !res.destroyed) this.writePage(res, method, pageNotFound())
      })
    }
    if (method === 'GET' && path === SESSION_PATH) return this.session(req, res, host)
    const route = method === 'POST' ? this.signInRoute(path) : undefined
    if (route) {
      // Never an unhandled rejection in main: a failure answers 500 when the request is still there.
      return void this.signIn(req, res, host, route).catch((err: unknown) => {
        this.deps.log(`web access: sign-in failed: ${errorText(err)}`)
        if (!res.headersSent && !res.destroyed) this.json(res, host, 500, { error: 'sign-in failed' })
      })
    }
    // Everything else needs a device: a request without a valid cookie learns nothing more.
    const device = this.deps.auth.authorize(req.headers.cookie)
    if (!device) return this.json(res, host, 401, { error: 'not signed in' })
    if (method === 'GET' && path === PROJECTS_PATH) return this.json(res, host, 200, this.projects())
    const serverProjects = this.deps.serverProjects
    if (method === 'POST' && path === PROJECTS_PATH && serverProjects) {
      return void this.openProject(req, res, host, serverProjects).catch((err: unknown) => {
        this.deps.log(`web access: opening a project failed: ${errorText(err)}`)
        if (!res.headersSent && !res.destroyed) this.json(res, host, 500, { error: 'opening the project failed' })
      })
    }
    if (method === 'POST' && path === FOLDERS_PATH && serverProjects) {
      return void this.listFolders(req, res, host, serverProjects).catch((err: unknown) => {
        this.deps.log(`web access: listing a folder failed: ${errorText(err)}`)
        if (!res.headersSent && !res.destroyed) this.json(res, host, 500, { error: 'listing the folder failed' })
      })
    }
    this.send(res, host, 404, 'text/plain; charset=utf-8', 'not found')
  }

  /**
   * The web shell's page or one of its assets (shell-files.ts); 404 for anything else. Streamed
   * from an open handle, never read whole: these answers need no sign-in, the fonts and the shared
   * chunk are megabytes each, and once a network bind is on any client past the Host check could
   * otherwise make main buffer that much per request. The handle's own stat gives the length, so
   * what is measured is what is sent, even when a rebuild replaces the file meanwhile.
   */
  private async shellFile(path: string, head: boolean, res: ServerResponse, host: string): Promise<void> {
    const dir = this.deps.shellDir
    const file = dir === undefined ? undefined : shellFileOf(dir, path)
    const real = file ? await realShellFile(file) : undefined
    let handle: FileHandle | undefined
    let size: number | undefined
    if (real !== undefined) {
      try {
        handle = await open(real, 'r')
        const stat = await handle.stat()
        // A folder named like an asset opens on some systems: not a file, not found.
        if (stat.isFile()) size = stat.size
      } catch {
        // The file went away in a rebuild: not found.
      }
    }
    if (res.destroyed || !file || handle === undefined || size === undefined) {
      await handle?.close().catch(() => undefined)
      if (res.destroyed) return
      if (path === '/') return this.send(res, host, 503, 'text/plain; charset=utf-8', NOT_BUILT_TEXT)
      return this.send(res, host, 404, 'text/plain; charset=utf-8', 'not found')
    }
    const extra: Record<string, string> = { 'Content-Length': String(size), ...(file.immutable ? { 'Cache-Control': IMMUTABLE } : {}) }
    if (head) {
      await handle.close().catch(() => undefined)
      this.writeHead(res, host, 200, file.type, extra)
      res.end()
      return
    }
    this.writeHead(res, host, 200, file.type, extra)
    try {
      // The read stream closes the handle when it ends or is destroyed; pipeline destroys both
      // sides when either fails, so a browser gone mid-download leaves nothing open.
      await pipeline(handle.createReadStream(), res)
    } catch (err) {
      // The headers are out, so a failure can only cut the answer short. A client that went
      // away is not worth a line; a read error is.
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        this.deps.log(`web access: serving ${path.slice(0, 100)} failed: ${errorText(err)}`)
      }
    }
  }

  /**
   * A plugin file or inline overlay page (plugin-pages.ts): its own headers, never the shell's (the
   * shell frames it, so no X-Frame-Options; its CSP is the plugin's). Never a redirect.
   */
  private async page(path: string, method: string, res: ServerResponse, host: string): Promise<void> {
    const pages = this.deps.pages
    const answer = pages ? await pages.serve(path, method, this.frameOrigins(host)) : pageNotFound()
    if (!res.destroyed) this.writePage(res, method, answer)
  }

  private writePage(res: ServerResponse, method: string, answer: PageAnswer): void {
    res.writeHead(answer.status, { ...answer.headers, 'Content-Length': String(answer.body.length) })
    res.end(method === 'HEAD' ? undefined : answer.body)
  }

  /** The open project windows, plain data only; a failing source is an empty list, never a 500 with its text. */
  private openProjects(): WebProjectEntry[] {
    try {
      return (this.deps.openProjects?.() ?? []).map(entryOf)
    } catch (err) {
      this.deps.log(`web access: listing projects failed: ${errorText(err)}`)
      return []
    }
  }

  /** The picker's list: the open projects, and in server mode the recent ones too (same failure rule). */
  private projects(): WebProjectsReply {
    const projects = this.openProjects()
    const serverProjects = this.deps.serverProjects
    if (!serverProjects) return { projects }
    let recent: WebRecentProject[] = []
    try {
      recent = serverProjects.recent().map((p) => {
        const out: WebRecentProject = { ...entryOf(p), missing: p.missing === true }
        if (typeof p.lastOpenedAt === 'number' && Number.isFinite(p.lastOpenedAt)) out.lastOpenedAt = p.lastOpenedAt
        return out
      })
    } catch (err) {
      this.deps.log(`web access: listing recent projects failed: ${errorText(err)}`)
    }
    const reply: WebProjectsReply = { projects, server: true, recent }
    try {
      const h = serverProjects.host()
      reply.host = { name: h.name, user: h.user, home: h.home }
    } catch (err) {
      // The welcome goes without it; the list is what matters.
      this.deps.log(`web access: reading the host name failed: ${errorText(err)}`)
    }
    return reply
  }

  /**
   * Server mode's folder browser (list-folders.ts). Origin and cookie were checked before the route,
   * as for every POST; the body is read capped, the cookie checked again once it is in (a slow body
   * outliving a revoke learns nothing), and only the checked request reaches main.
   */
  private async listFolders(req: IncomingMessage, res: ServerResponse, host: string, projects: ServerProjects): Promise<void> {
    const read = await this.readJson(req, res, host)
    if (!read) return
    if (!this.deps.auth.authorize(req.headers.cookie)) return this.json(res, host, 401, { error: 'not signed in' })
    const request = parseFoldersBody(read.body)
    if ('error' in request) return this.json(res, host, 400, request)
    if (res.destroyed) return
    const reply = await projects.folders(request)
    this.json(res, host, 200, reply)
  }

  /**
   * Server mode's open from the browser picker (design-web.md §9.8). Origin and cookie were checked
   * before the route (request above); the body is read as a sign-in body is (JSON, capped), checked
   * by parseOpenProjectBody, and only the checked request reaches main. The cookie is checked again
   * once the body is in: a client may take its time sending it, and a device revoked (or a mode
   * change that signs it out) meanwhile must open nothing with a check made before the revoke. And
   * once more inside the open, right before it changes anything (`authorized`): the open awaits a
   * folder check of its own, and a check made before that await is as stale (external review round 3).
   */
  private async openProject(req: IncomingMessage, res: ServerResponse, host: string, projects: ServerProjects): Promise<void> {
    const read = await this.readJson(req, res, host)
    if (!read) return
    const device = this.deps.auth.authorize(req.headers.cookie)
    if (!device) return this.json(res, host, 401, { error: 'not signed in' })
    const request = parseOpenProjectBody(read.body)
    if ('error' in request) return this.json(res, host, 400, request)
    if (res.destroyed) return
    const reply = await projects.open(request, () => this.deps.auth.authorize(req.headers.cookie) !== undefined)
    if ('unauthorized' in reply) return this.json(res, host, 401, { error: 'not signed in' })
    if ('error' in reply) return this.json(res, host, 400, { error: reply.error })
    // Which device did what to which project, for the server's log (no path: the id names it).
    const did = 'relink' in request ? 'relinked and opened' : 'forget' in request ? 'forgot' : 'opened'
    this.deps.log(`web access: device ${device.id} ${did} project ${reply.id}`)
    this.json(res, host, 200, { id: reply.id })
  }

  /**
   * A small JSON body (MAX_SIGN_IN_BODY), or undefined once the answer for a body that is not one
   * (415 not JSON, 413 too large, 400 unparsable) has been sent.
   */
  private async readJson(req: IncomingMessage, res: ServerResponse, host: string): Promise<{ body: unknown } | undefined> {
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      req.resume()
      this.json(res, host, 415, { error: 'expected JSON' })
      return undefined
    }
    const text = await readBody(req, MAX_SIGN_IN_BODY)
    if (text === undefined) {
      this.json(res, host, 413, { error: 'too large' }, { Connection: 'close' })
      return undefined
    }
    try {
      return { body: JSON.parse(text) }
    } catch {
      this.json(res, host, 400, { error: 'expected JSON' })
      return undefined
    }
  }

  private json(res: ServerResponse, host: string, status: number, value: unknown, extra: Record<string, string> = {}): void {
    this.send(res, host, status, 'application/json; charset=utf-8', JSON.stringify(value), extra)
  }

  private session(req: IncomingMessage, res: ServerResponse, host: string): void {
    const device = this.deps.auth.authorize(req.headers.cookie)
    const reply: WebSessionReply = { mode: this.deps.auth.mode ?? 'link', device: device ? { id: device.id, name: device.name } : null }
    this.json(res, host, 200, reply)
  }

  /**
   * The sign-in routes (auth.ts does the checking): the access link, the password, a desktop-confirm
   * ask and its polls. Each is an Origin-checked POST of a small JSON body (request above); each one
   * that makes a device answers with its cookie. `cancelled` says the client hung up: an attempt
   * waiting in the limiter then never runs, so it gets no device (its cookie would be lost) and does
   * not use up a one-time token.
   */
  private signInRoute(path: string): ((body: unknown, cancelled: () => boolean) => Promise<SignInAnswer>) | undefined {
    const auth = this.deps.auth
    const device = (result: SignInResult): SignInAnswer =>
      result.ok ? { status: 200, body: { device: { id: result.device.id, name: result.device.name } }, cookie: result.cookie } : { status: result.status, body: { error: result.error } }
    switch (path) {
      case SIGN_IN_LINK_PATH:
        return async (body, cancelled) => device(await auth.signInWithToken(body, cancelled))
      case SIGN_IN_PASSWORD_PATH:
        return async (body, cancelled) => device(await auth.signInWithPassword(body, cancelled))
      case CONFIRM_ASK_PATH:
        return async (body, cancelled) => {
          const result = await auth.requestConfirm(body, cancelled)
          if (!result.ok) return { status: result.status, body: { error: result.error } }
          const ticket: WebConfirmTicket = { code: result.code, ticket: result.ticket, expiresAt: result.expiresAt }
          return { status: 200, body: ticket }
        }
      case CONFIRM_POLL_PATH:
        return async (body) => {
          const result = auth.pollConfirm(body)
          if (!result.ok) return { status: result.status, body: { error: result.error } }
          return result.cookie === undefined ? { status: 200, body: result.poll } : { status: 200, body: result.poll, cookie: result.cookie }
        }
      default:
        return undefined
    }
  }

  private async signIn(
    req: IncomingMessage,
    res: ServerResponse,
    host: string,
    route: (body: unknown, cancelled: () => boolean) => Promise<SignInAnswer>
  ): Promise<void> {
    // The Origin was checked before the route (request above); the cookie's flags follow it.
    const origin = String(req.headers.origin)
    const read = await this.readJson(req, res, host)
    if (!read) return
    const answer = await route(read.body, () => res.destroyed)
    if (res.destroyed) return
    this.json(res, host, answer.status, answer.body, answer.cookie === undefined ? {} : { 'Set-Cookie': deviceCookie(answer.cookie, origin) })
  }

  private originRule(): OriginRule {
    const scheme = this.scheme()
    return this.plan?.externalOrigin !== undefined ? { scheme, externalOrigin: this.plan.externalOrigin } : { scheme }
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    const host = checkHost(req.headers.host, this.hosts)
    if (!host) return refuseUpgrade(socket, '403 Forbidden')
    if (!checkOrigin(req.headers.origin, host, this.originRule())) {
      this.deps.log(`web access: upgrade refused, origin ${JSON.stringify((req.headers.origin ?? 'none').slice(0, 100))}`)
      return refuseUpgrade(socket, '403 Forbidden')
    }
    if ((req.url ?? '').split('?')[0] !== WS_PATH) return refuseUpgrade(socket, '404 Not Found')
    const device = this.deps.auth.authorize(req.headers.cookie)
    if (!device) return refuseUpgrade(socket, '401 Unauthorized')
    const handler = this.handler
    const wss = this.wss
    if (!handler || !wss) return refuseUpgrade(socket, '401 Unauthorized')
    wss.handleUpgrade(req, socket, head, (ws) => {
      this.sockets.set(ws, device)
      this.alive.add(ws)
      // Any frame proves the peer is there, not only the pong (a busy view answers late).
      ws.on('pong', () => this.alive.add(ws))
      ws.on('message', () => this.alive.add(ws))
      // An open socket keeps its device from expiring (devices.ts); None's anonymous one has no record.
      const tracked = device.mode !== 'none'
      if (tracked) this.deps.auth.devices.socketOpened(device.id)
      this.deps.accessLog.write({ event: 'connect', device: device.id, name: device.name })
      this.connectionsChanged()
      ws.on('close', () => {
        this.sockets.delete(ws)
        this.alive.delete(ws)
        if (tracked) this.deps.auth.devices.socketClosed(device.id)
        this.deps.accessLog.write({ event: 'disconnect', device: device.id, name: device.name })
        this.connectionsChanged()
      })
      // `ws` reports an oversize or malformed frame as an 'error' on the socket (after sending the
      // close code to the client): unheard, it would be an uncaught exception in main.
      ws.on('error', (err) => {
        this.deps.log(`web access: socket closed: ${errorText(err)}`)
        ws.terminate()
      })
      handler(ws, req, device)
    })
  }
}
