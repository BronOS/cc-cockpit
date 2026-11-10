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
//  - Loopback binds only (settings.ts listenPlanOf) until TLS and the §4.3 confirms (Task 28).
// Behind those, sign-in (auth.ts, plan Task 5): `/` and the sign-in routes are open, everything
// else (the upgrade first) needs a device (`WebAuth.authorize`: the device cookie, or None mode).
// An upgrade that passes goes to the socket handler main installs (the wire protocol,
// connection.ts); with none installed it is refused, so the gateway never hands out a socket
// nobody speaks the protocol on.
// Sockets are tracked by device: a revoke closes that device's sockets at once, and leaving None
// mode closes the anonymous ones. Connects and disconnects go to the access log.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
// Types only: erased at build time, so this file does not load `ws` (see loadWs below).
import type { WebSocket, WebSocketServer } from 'ws'
import type { WebAccessMode, WebAccessSettings } from '../../shared/types'
import type { AccessLog } from './access-log'
import { deviceCookie, type WebAuth } from './auth'
import { allowedHosts, checkHost, checkOrigin, webShellCsp } from './checks'
import type { WebDevice } from './devices'
import { MAX_FRAME_BYTES, WS_PATH } from './protocol'
import { listenPlanOf, type ListenPlan } from './settings'

export type WsModule = typeof import('ws')

// Largest frame a view may send (design-web.md §3, protocol.ts): `ws` closes the socket (1009) on
// a bigger one before it is buffered whole.
export { MAX_FRAME_BYTES }

/** Where the browser opens its one WebSocket per view (shared with the bridge, web-protocol.ts). */
export { WS_PATH }
/** The page posts the access link's token here (auth.ts). */
export const SIGN_IN_LINK_PATH = '/auth/link'
/** What the page asks first: the mode, and whether this browser is signed in. */
export const SESSION_PATH = '/auth/session'
/** A sign-in body is a token and a device name; anything bigger is not one. */
export const MAX_SIGN_IN_BODY = 4096

export interface GatewayDeps {
  log(message: string): void
  /** Sign-in and devices (auth.ts). */
  auth: WebAuth
  accessLog: AccessLog
  /** Loads `ws`; tests count the calls. Default: a dynamic import, the only one in main. */
  loadWs?: () => Promise<WsModule>
  /** os.networkInterfaces / os.hostname, read only for a network bind (Task 28). */
  interfaces?: () => ReturnType<typeof networkInterfaces>
  hostname?: () => string
}

export type GatewayStatus =
  | { state: 'off' }
  /** Enabled, but the settings may not listen (a network bind before Task 28); nothing listens. */
  | { state: 'refused'; reason: string }
  /** Enabled and allowed, but listening failed (port in use, `ws` missing); nothing listens. */
  | { state: 'failed'; reason: string }
  | { state: 'listening'; bind: string; port: number }

/** A socket that passed Host, Origin and sign-in; the handler (connection.ts) owns it from here. */
export type SocketHandler = (ws: WebSocket, req: IncomingMessage, device: WebDevice) => void

type OkPlan = Extract<ListenPlan, { ok: true }>

/** A placeholder until the web build is served (plan Task 8). */
const PLACEHOLDER_HTML =
  '<!doctype html><meta charset="utf-8"><title>cc-cockpit</title><p>cc-cockpit web access is on. The web shell is not served yet.</p>'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

function refuseUpgrade(socket: Duplex, status: string): void {
  // The socket may already be gone (the client hung up); writing to it then must not throw.
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export class WebGateway {
  private server: Server | undefined
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

  constructor(private readonly deps: GatewayDeps) {
    deps.auth.devices.onRevoked((ids) => {
      const gone = new Set(ids)
      for (const [ws, device] of this.sockets) if (gone.has(device.id)) ws.terminate()
    })
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
    const run = this.queue.then(() => this.close())
    this.queue = run.catch(() => undefined)
    return run.then(() => {
      this.current = { state: 'off' }
    })
  }

  private async applyNow(settings: WebAccessSettings): Promise<GatewayStatus> {
    this.setMode(settings.mode)
    const plan = listenPlanOf(settings)
    if (!plan.ok) {
      await this.close()
      this.current = settings.enabled ? { state: 'refused', reason: plan.reason } : { state: 'off' }
      if (this.current.state === 'refused') this.deps.log(`web access: not listening: ${plan.reason}`)
      return this.current
    }
    if (this.server && this.plan && this.plan.bind === plan.bind && this.plan.port === plan.port) {
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
    this.deps.log(`web access: listening on http://${plan.bind.includes(':') ? `[${plan.bind}]` : plan.bind}:${plan.port}`)
    return this.current
  }

  private setMode(mode: WebAccessMode): void {
    const before = this.deps.auth.mode
    this.deps.auth.setMode(mode)
    // Leaving None: whoever came in without signing in is out now, and must sign in to come back.
    if (before === 'none' && mode !== 'none') {
      for (const [ws, device] of this.sockets) if (device.mode === 'none') ws.terminate()
    }
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

  private listen(plan: OkPlan, ws: WsModule): Promise<void> {
    this.use(plan)
    this.wss = new ws.WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    const server = createServer((req, res) => this.request(req, res))
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head))
    // A client error (a malformed request line) is answered by Node; never let it reach the app.
    server.on('clientError', (_err, socket: Duplex) => refuseUpgrade(socket, '400 Bad Request'))
    this.server = server
    return new Promise((resolve, reject) => {
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

  private async close(): Promise<void> {
    const server = this.server
    const wss = this.wss
    this.server = undefined
    this.wss = undefined
    this.plan = undefined
    this.hosts = new Set()
    if (wss) {
      for (const client of wss.clients) client.terminate()
      wss.close()
    }
    if (!server) return
    await new Promise<void>((resolve) => {
      // Keep-alive connections would hold close() open until they time out.
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  /** The origins the shell page may be loaded under, for the CSP's frame-src. */
  private frameOrigins(host: string): string[] {
    const own = `http://${host}`
    return this.plan?.externalOrigin !== undefined ? [own, this.plan.externalOrigin] : [own]
  }

  private send(
    res: ServerResponse,
    host: string | undefined,
    status: number,
    type: string,
    body: string,
    extra: Record<string, string> = {}
  ): void {
    res.writeHead(status, {
      ...extra,
      'Content-Type': type,
      'Content-Security-Policy': webShellCsp(host === undefined ? [] : this.frameOrigins(host)),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    })
    res.end(body)
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
    const path = (req.url ?? '/').split('?')[0]
    // Open without sign-in: the page (it signs in from there) and the sign-in routes.
    if (safe && path === '/') return this.send(res, host, 200, 'text/html; charset=utf-8', method === 'HEAD' ? '' : PLACEHOLDER_HTML)
    if (method === 'GET' && path === SESSION_PATH) return this.session(req, res, host)
    if (method === 'POST' && path === SIGN_IN_LINK_PATH) {
      // Never an unhandled rejection in main: a failure answers 500 when the request is still there.
      return void this.signIn(req, res, host).catch((err: unknown) => {
        this.deps.log(`web access: sign-in failed: ${errorText(err)}`)
        if (!res.headersSent && !res.destroyed) this.json(res, host, 500, { error: 'sign-in failed' })
      })
    }
    // Everything else needs a device: a request without a valid cookie learns nothing more.
    if (!this.deps.auth.authorize(req.headers.cookie)) return this.json(res, host, 401, { error: 'not signed in' })
    this.send(res, host, 404, 'text/plain; charset=utf-8', 'not found')
  }

  private json(res: ServerResponse, host: string, status: number, value: unknown, extra: Record<string, string> = {}): void {
    this.send(res, host, status, 'application/json; charset=utf-8', JSON.stringify(value), extra)
  }

  private session(req: IncomingMessage, res: ServerResponse, host: string): void {
    const device = this.deps.auth.authorize(req.headers.cookie)
    this.json(res, host, 200, { mode: this.deps.auth.mode ?? 'link', device: device ? { id: device.id, name: device.name } : null })
  }

  private async signIn(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    // The Origin was checked before the route (request above); the cookie's flags follow it.
    const origin = String(req.headers.origin)
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      req.resume()
      return this.json(res, host, 415, { error: 'expected JSON' })
    }
    const text = await readBody(req, MAX_SIGN_IN_BODY)
    if (text === undefined) return this.json(res, host, 413, { error: 'too large' }, { Connection: 'close' })
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return this.json(res, host, 400, { error: 'expected JSON' })
    }
    // A client that hung up while its attempt waited in the limiter gets no device (its cookie
    // would be lost) and does not use up a one-time token.
    const result = await this.deps.auth.signInWithToken(body, () => res.destroyed)
    if (res.destroyed) return
    if (!result.ok) return this.json(res, host, result.status, { error: result.error })
    this.json(res, host, 200, { device: { id: result.device.id, name: result.device.name } }, { 'Set-Cookie': deviceCookie(result.cookie, origin) })
  }

  private originRule(): { scheme: 'http'; externalOrigin?: string } {
    return this.plan?.externalOrigin !== undefined ? { scheme: 'http', externalOrigin: this.plan.externalOrigin } : { scheme: 'http' }
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
      // An open socket keeps its device from expiring (devices.ts); None's anonymous one has no record.
      const tracked = device.mode !== 'none'
      if (tracked) this.deps.auth.devices.socketOpened(device.id)
      this.deps.accessLog.write({ event: 'connect', device: device.id, name: device.name })
      ws.on('close', () => {
        this.sockets.delete(ws)
        if (tracked) this.deps.auth.devices.socketClosed(device.id)
        this.deps.accessLog.write({ event: 'disconnect', device: device.id, name: device.name })
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
