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
// An upgrade that passes the checks goes to the socket handler main installs (the wire protocol,
// Task 6, behind the device cookie, Task 5); with none installed it is refused, so a skeleton
// gateway never hands anyone a socket.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname, networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
// Types only: erased at build time, so this file does not load `ws` (see loadWs below).
import type { WebSocket, WebSocketServer } from 'ws'
import type { WebAccessSettings } from '../../shared/types'
import { allowedHosts, checkHost, checkOrigin, webShellCsp } from './checks'
import { listenPlanOf, type ListenPlan } from './settings'

export type WsModule = typeof import('ws')

/**
 * Largest frame a view may send (design-web.md §3): a 1 MiB panel message wrapped in a frame must
 * fit. `ws` closes the socket (1009) on a bigger one before it is buffered whole.
 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

/** Where the browser opens its one WebSocket per view. */
export const WS_PATH = '/ws'

export interface GatewayDeps {
  log(message: string): void
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

/** A socket that passed Host and Origin; the handler owns it from here (Task 6). */
export type SocketHandler = (ws: WebSocket, req: IncomingMessage) => void

type OkPlan = Extract<ListenPlan, { ok: true }>

/** A placeholder until the web build is served (plan Task 8). */
const PLACEHOLDER_HTML =
  '<!doctype html><meta charset="utf-8"><title>cc-cockpit</title><p>cc-cockpit web access is on. The web shell is not served yet.</p>'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

  constructor(private readonly deps: GatewayDeps) {}

  /** What the gateway is doing now (for the log, the settings page and tests). */
  status(): GatewayStatus {
    return this.current
  }

  /** The bound address while listening. */
  address(): AddressInfo | undefined {
    const addr = this.server?.address()
    return addr !== null && typeof addr === 'object' ? addr : undefined
  }

  /** Installs who takes checked sockets (the wire protocol, Task 6). Undefined: every upgrade is refused. */
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
    const plan = listenPlanOf(settings)
    if (!plan.ok) {
      await this.close()
      this.current = settings.enabled ? { state: 'refused', reason: plan.reason } : { state: 'off' }
      if (this.current.state === 'refused') this.deps.log(`web access: not listening: ${plan.reason}`)
      return this.current
    }
    if (this.server && this.plan && this.plan.bind === plan.bind && this.plan.port === plan.port) {
      this.use(plan)
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
      server.listen(plan.port, plan.bind, () => {
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

  private send(res: ServerResponse, host: string | undefined, status: number, type: string, body: string): void {
    res.writeHead(status, {
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
    if (safe && path === '/') return this.send(res, host, 200, 'text/html; charset=utf-8', method === 'HEAD' ? '' : PLACEHOLDER_HTML)
    this.send(res, host, 404, 'text/plain; charset=utf-8', 'not found')
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
    const handler = this.handler
    const wss = this.wss
    if (!handler || !wss) return refuseUpgrade(socket, '401 Unauthorized')
    wss.handleUpgrade(req, socket, head, (ws) => {
      // `ws` reports an oversize or malformed frame as an 'error' on the socket (after sending the
      // close code to the client): unheard, it would be an uncaught exception in main.
      ws.on('error', (err) => {
        this.deps.log(`web access: socket closed: ${errorText(err)}`)
        ws.terminate()
      })
      handler(ws, req)
    })
  }
}
