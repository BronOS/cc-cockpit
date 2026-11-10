// The desktop's side of Settings › General › Web access and the top bar's indicator (design-web.md
// §4). It owns no state: the settings are `app.json` › `webAccess` (read and written through the
// two callbacks), the devices and tokens are WebAuth's, the sockets the gateway's. What it adds is
// the rule "a change is validated, stored, then applied to the gateway", and the views the
// renderer reads. Every channel that reaches it is `no`-class (shared/ipc.ts), so only a desktop
// window ever calls it: a browser must never widen its own access.
import type { WebAccessSettings } from '../../shared/types'
import type {
  WebAccessIndicator,
  WebActionReply,
  WebAccessPatch,
  WebAccessView,
  WebDeviceView,
  WebGatewayView,
  WebLinkReply
} from '../../shared/web-access'
import type { WebAuth } from './auth'
import { linkOrigin, NONE_DEVICE } from './auth'
import type { GatewayStatus } from './gateway'
import { applyWebAccessPatch, listenPlanOf, webAccessOf, webAccessRisks } from './settings'

/** The part of the gateway this needs (a fake in tests). */
export interface GatewayLike {
  apply(settings: WebAccessSettings): Promise<GatewayStatus>
  status(): GatewayStatus
  connections(): Map<string, number>
  disconnectDevice(id: string): number
  onConnectionsChanged(listener: () => void): () => void
}

export interface WebAccessServiceDeps {
  gateway: GatewayLike
  auth: WebAuth
  /** `app.json` › `webAccess` as stored (untrusted: a user-writable file). */
  read(): unknown
  /** Stores the next settings; only the editable fields are passed (the bind and TLS stay as stored). */
  write(next: WebAccessSettings): void
  /** Tells the desktop windows (`webAccess.changed`). */
  emit(indicator: WebAccessIndicator): void
  /**
   * The headless terminals (terminals/mirror.ts): running only while the settings mean the gateway
   * listens, so web access off costs no worker and loads no xterm package. `drain` turns them off
   * once the desktops have all their output (mirror.ts header); it never rejects.
   */
  terminals?: { start(): void; drain(): Promise<void> }
}

/** The same links need the gateway to be listening: a link to a port nobody serves helps no one. */
const NOT_LISTENING = 'Turn web access on first: there is nothing to open the link on.'
const NOT_LINK_MODE = 'Links work only in the access-link mode.'

export class WebAccessService {
  private readonly unsubscribe: Array<() => void> = []

  constructor(private readonly deps: WebAccessServiceDeps) {
    // Sockets opening and closing, and devices signing in, being revoked or expiring, all move the
    // indicator and the list; one event per cause, the renderer re-reads what it shows.
    this.unsubscribe.push(deps.gateway.onConnectionsChanged(() => this.changed()))
    this.unsubscribe.push(deps.auth.devices.onChanged(() => this.changed()))
    // A browser asking for a desktop confirm, and its answer or lapse: every desktop window's card.
    this.unsubscribe.push(deps.auth.onChanged(() => this.changed()))
  }

  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off()
  }

  settings(): WebAccessSettings {
    return webAccessOf(this.deps.read())
  }

  /** The gateway's state in the renderer's terms; `origin` is where a link points. */
  private gatewayView(settings: WebAccessSettings): WebGatewayView {
    const status = this.deps.gateway.status()
    if (status.state === 'listening') {
      return { state: 'listening', bind: status.bind, port: status.port, origin: linkOrigin(settings) }
    }
    return status
  }

  view(): WebAccessView {
    const settings = this.settings()
    const gateway = this.gatewayView(settings)
    const open = this.deps.gateway.connections()
    const devices: WebDeviceView[] = this.deps.auth.devices.list().map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      mode: d.mode,
      connected: open.has(d.id)
    }))
    return {
      form: {
        enabled: settings.enabled,
        port: settings.port,
        externalOrigin: settings.externalOrigin ?? '',
        hosts: settings.hosts,
        mode: settings.mode
      },
      bind: settings.bind,
      gateway,
      devices,
      // A risky choice that is refused (nothing listens) is no risk: the badge is for what is live.
      risks: gateway.state === 'listening' ? webAccessRisks(settings) : [],
      passwordSet: this.deps.auth.hasPassword()
    }
  }

  indicator(): WebAccessIndicator {
    const settings = this.settings()
    const listening = this.deps.gateway.status().state === 'listening'
    const risks = listening ? webAccessRisks(settings) : []
    // None's browsers all share one anonymous device id, so count that one's sockets: three
    // anonymous browsers must not read as one device (the chip is their only desktop view).
    let connected = 0
    for (const [id, sockets] of this.deps.gateway.connections()) connected += id === NONE_DEVICE.id ? sockets : 1
    const out: WebAccessIndicator = { connected }
    if (risks.length > 0) out.warning = risks.join(' ')
    const confirm = this.deps.auth.confirmAsk()
    if (confirm) out.confirm = confirm
    return out
  }

  /**
   * Validates, stores and applies a change; throws the reason (an Error the settings page shows)
   * when the change is invalid, and then nothing changed. A change the gateway cannot act on (the
   * port is taken) is stored all the same and shows as the gateway's `failed` state in the view.
   */
  async set(patch: WebAccessPatch): Promise<WebAccessView> {
    const current = this.settings()
    const result = applyWebAccessPatch(current, patch)
    if (!result.ok) throw new Error(result.error)
    // With no password, the password mode lets nobody in: the page sets one first (setPassword).
    if (result.value.mode === 'password' && current.mode !== 'password' && !this.deps.auth.hasPassword()) {
      throw new Error('set a password first')
    }
    this.deps.write(result.value)
    // The settings are saved first: a refused or failed start must not lose what the person typed.
    const settings = webAccessOf(this.deps.read())
    await this.applySettings(settings)
    this.changed()
    return this.view()
  }

  /** Reads the stored settings again and applies them (start-up). */
  apply(): Promise<GatewayStatus> {
    return this.applySettings(this.settings())
  }

  /**
   * The terminals follow the settings' plan, not the listener's outcome: a port in use is a
   * passing failure (the next apply retries), a refused setting is not.
   *
   * On: started synchronously and before the gateway, so tabs restored at start-up after this are
   * mirrored from their first item, and running tabs get their baseline before any view can join.
   * Off: after the gateway, which closes the remote views with their notice first (design: the
   * person sees "turned off", not a dropped stream); then the terminals drain, not awaited (it can
   * take up to DRAIN_MS while a desktop catches up), and only if the settings still say off by then:
   * a quick off-then-on must not end the mirror the second change started.
   */
  private async applySettings(settings: WebAccessSettings): Promise<GatewayStatus> {
    const terminals = this.deps.terminals
    const on = listenPlanOf(settings).ok
    if (on) terminals?.start()
    const status = await this.deps.gateway.apply(settings)
    if (!on && terminals && !listenPlanOf(this.settings()).ok) void terminals.drain()
    return status
  }

  async link(): Promise<WebLinkReply> {
    const origin = this.linkTarget()
    if (typeof origin !== 'string') return origin
    return this.deps.auth.accessLink(origin)
  }

  async regenerate(): Promise<WebLinkReply> {
    const origin = this.linkTarget()
    if (typeof origin !== 'string') return origin
    const reply = await this.deps.auth.regenerate(origin)
    // The devices that signed in with the old link are gone from the list.
    this.changed()
    return reply
  }

  addDevice(): WebLinkReply {
    const origin = this.linkTarget()
    if (typeof origin !== 'string') return origin
    const { link, expiresAt } = this.deps.auth.addDeviceLink(origin)
    return { ok: true, link, expiresAt }
  }

  /** Sets or changes the password (WebAuth.setPassword: hashed off the main thread, devices of the old one signed out). */
  async setPassword(password: unknown): Promise<WebActionReply> {
    const reply = await this.deps.auth.setPassword(password)
    if (reply.ok) this.changed()
    return reply
  }

  /** The desktop's answer to a browser waiting for a desktop confirm: deny, or allow with its code. */
  answerConfirm(payload: unknown): WebActionReply {
    const p = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    return this.deps.auth.answerConfirm(p['id'], p['allow'], p['code'])
  }

  disconnect(id: unknown): boolean {
    if (typeof id !== 'string') return false
    return this.deps.gateway.disconnectDevice(id) > 0
  }

  revoke(id: unknown): boolean {
    if (typeof id !== 'string') return false
    return this.deps.auth.devices.revoke(id)
  }

  revokeAll(): number {
    return this.deps.auth.devices.revokeAll()
  }

  /** The origin a link points at, or the reply that says why there is no link. */
  private linkTarget(): string | WebLinkReply {
    const settings = this.settings()
    if (this.deps.gateway.status().state !== 'listening' || !listenPlanOf(settings).ok) return { ok: false, reason: NOT_LISTENING }
    if (settings.mode !== 'link') return { ok: false, reason: NOT_LINK_MODE }
    return linkOrigin(settings)
  }

  private changed(): void {
    this.deps.emit(this.indicator())
  }
}
