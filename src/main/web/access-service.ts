// The desktop's side of Settings › General › Web access and the top bar's indicator (design-web.md
// §4). It owns no state: the settings are `app.json` › `webAccess` (read and written through the
// two callbacks), the devices and tokens are WebAuth's, the sockets the gateway's. What it adds is
// the rule "a change is validated, stored, then applied to the gateway", and the views the
// renderer reads. A browser view reaches only the read side and Revoke/Disconnect, and only in server
// mode (`adapted`, ipc/router.ts registerWebAccessHandlers, design-web.md §9.4, §9.6); everything
// that adds or widens access is `no`-class, so a browser never widens its own access.
import type { WebAccessSettings } from '../../shared/types'
import type {
  WebAccessIndicator,
  WebActionReply,
  WebAccessPatch,
  WebAccessSetReply,
  WebAccessView,
  WebCliStatus,
  WebDeviceView,
  WebGatewayView,
  WebLinkReply,
  WebSecretsStatus
} from '../../shared/web-access'
import { SERVER_NONE_WARNING, type WebCliNotice } from '../../shared/web-access'
import type { AccessActor, AccessEntry } from './access-log'
import type { WebAuth } from './auth'
import { linkOrigin, NONE_DEVICE } from './auth'
import type { GatewayStatus } from './gateway'
import {
  applyWebAccessPatch,
  isLoopbackBind,
  listenPlanOf,
  serverConfirmCommand,
  serverStartSettings,
  webAccessOf,
  webAccessRisks
} from './settings'

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
  /** Stores the next settings (every field the page edits, and the confirmed risks). */
  write(next: WebAccessSettings): void
  /** Tells the windows (`webAccess.changed`; a browser view gets it only in server mode, web/connection.ts). */
  emit(indicator: WebAccessIndicator): void
  /**
   * The headless terminals (terminals/mirror.ts): running only while the settings mean the gateway
   * listens, so web access off costs no worker and loads no xterm package. `drain` turns them off
   * once the desktops have all their output (mirror.ts header); it never rejects.
   */
  terminals: { start(): void; drain(): Promise<void> }
  /**
   * Main's `server` flag for the run (server-mode.ts): a change may not turn web access off or pick
   * desktop confirm (settings.ts `applyWebAccessPatch`), and start writes and prints what runs.
   */
  server?: boolean
  /**
   * `web-access.log` (access-log.ts), for what the service itself does that no other module logs: a
   * browser's Disconnect of a device (the gateway logs only the sockets closing). Absent: not logged.
   */
  accessLog?: { write(entry: AccessEntry): void }
}

/** How a revoke came about, for `web-access.log`: the reason, and the browser that did it. */
export interface RevokeHow {
  reason?: string
  by?: AccessActor
}

/** The log's reason for a revoke from a browser's card (server mode, design-web.md §9.6). */
export const BROWSER_REVOKE_REASON = 'revoked from a browser'
/** The log's detail for a Disconnect from a browser's card. */
export const BROWSER_DISCONNECT_DETAIL = 'disconnected from a browser'

/** stdout, once, when server mode wrote web access on (design-web.md §9.2). */
export const SERVER_TURNED_ON_LINE = 'server mode: turned web access on in app.json'

/** The same links need the gateway to be listening: a link to a port nobody serves helps no one. */
const NOT_LISTENING = 'Turn web access on first: there is nothing to open the link on.'
const NOT_LINK_MODE = 'Links work only in the access-link mode.'
/** Server mode's wording (`ccc web link`, `ccc web add-device`): web access is always on there, so "turn it on" would mislead. */
const SERVER_NOT_LISTENING = 'web access is not listening, so a link would open nothing; `ccc web status` says why'
const SERVER_NOT_LINK_MODE = 'links work only in the access-link mode: `ccc web mode link` switches to it'

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

  /** The signed-in devices as the card and `ccc web status` list them: no hash, no cookie. */
  private devicesView(): WebDeviceView[] {
    const open = this.deps.gateway.connections()
    return this.deps.auth.devices.list().map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      mode: d.mode,
      connected: open.has(d.id)
    }))
  }

  view(): WebAccessView {
    const settings = this.settings()
    const gateway = this.gatewayView(settings)
    const devices = this.devicesView()
    return {
      form: {
        enabled: settings.enabled,
        bind: settings.bind,
        port: settings.port,
        externalOrigin: settings.externalOrigin ?? '',
        hosts: settings.hosts,
        mode: settings.mode,
        certPath: settings.tls?.certPath ?? '',
        keyPath: settings.tls?.keyPath ?? ''
      },
      network: !isLoopbackBind(settings.bind),
      gateway,
      devices,
      // A risky choice that is refused (nothing listens) is no risk: the badge is for what is live.
      risks: gateway.state === 'listening' ? webAccessRisks(settings) : [],
      passwordSet: this.deps.auth.hasPassword(),
      // States only (synchronous, no decrypt): the card says when one must be made again (§9.5).
      credentials: this.deps.auth.credentialStates()
    }
  }

  /**
   * `ccc web status` (design-web.md §9.4), in both modes: the stored settings, the gateway's state,
   * the secret store (`secrets`, which main reads from the store and the data dir), the states of
   * the access link and the password, the devices, and the core notices of this run (server mode's
   * stdout lines, core-notices.ts). Built only from views that hold no secret: never a link, a token,
   * a hash or a stored value.
   */
  cliStatus(secrets: WebSecretsStatus, notices: WebCliNotice[] = []): WebCliStatus {
    const settings = this.settings()
    const credentials = this.deps.auth.credentialStates()
    return {
      server: this.deps.server === true,
      enabled: settings.enabled,
      mode: settings.mode,
      bind: settings.bind,
      port: settings.port,
      externalOrigin: settings.externalOrigin ?? null,
      gateway: this.gatewayView(settings),
      secrets: { store: secrets.store, unavailable: secrets.unavailable, otherMode: secrets.otherMode, replaced: secrets.replaced },
      accessLink: credentials.accessLink,
      password: credentials.password,
      devices: this.devicesView(),
      notices
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
   * when the change is invalid, and then nothing changed. A change that brings in a §4.3 risk not
   * confirmed answers `needsConfirm` and stores nothing either: the page shows the confirm and sends
   * the change again with `confirm`, and a cancelled confirm leaves everything as it was. A change
   * the gateway cannot act on (the port is taken, a certificate unreadable) is stored all the same
   * and shows as the gateway's `failed` state in the view.
   */
  async set(patch: WebAccessPatch): Promise<WebAccessSetReply> {
    const current = this.settings()
    const result = applyWebAccessPatch(current, patch, { server: this.deps.server === true })
    if (!result.ok) {
      if (result.needsConfirm) return { needsConfirm: result.needsConfirm }
      throw new Error(result.error)
    }
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

  /**
   * Server mode at start, before `apply` (design-web.md §9.2): writes web access on, and the link
   * mode over a stored desktop confirm, to `app.json`. Returns the line to print, only when it wrote
   * something (so a second start prints nothing). The record written is what runs: no overlay.
   */
  serverStart(): string | undefined {
    if (this.deps.server !== true) return undefined
    const next = serverStartSettings(this.settings())
    if (next === undefined) return undefined
    this.deps.write(next)
    return SERVER_TURNED_ON_LINE
  }

  /**
   * Server mode's first lines on stdout, after `apply` (design-web.md §9.2, §9.3). Listening: the
   * address (the external origin when set, else the listen address), then by mode: in link mode a
   * one-time add-device link only when stdout is a terminal (`tty`), else the command that makes
   * one, so no live link reaches the journal or a log shipper; password mode only the address; None
   * the shared-server warning. A refused stored setting: the reason and, for an unconfirmed §4.3
   * risk, the exact `ccc web set` line that applies it (the app runs on so `ccc web` can fix it).
   * The gateway failing: its reason. Always last the wrapper's path, as the ccc offer is skipped in
   * server mode. Never a link off a terminal, outside link mode, or when nothing listens.
   */
  serverStartLines(options: { tty: boolean; wrapperPath: string }): string[] {
    if (this.deps.server !== true) return []
    const settings = this.settings()
    const plan = listenPlanOf(settings)
    const status = this.deps.gateway.status()
    const lines: string[] = []
    if (!plan.ok) {
      lines.push(`server mode: web access is not listening: ${plan.reason}`)
      const command = serverConfirmCommand(settings)
      if (command !== undefined) lines.push(`to listen anyway, run: ${command}`)
    } else if (status.state !== 'listening') {
      lines.push(`server mode: web access is not listening: ${status.state === 'off' ? 'web access is off' : status.reason}`)
    } else {
      const origin = linkOrigin(settings)
      lines.push(`cc-cockpit server mode: web access on ${origin}`)
      if (settings.mode === 'link') {
        if (options.tty) {
          const { link } = this.deps.auth.addDeviceLink(origin, { start: true })
          lines.push(`Add a device (works once, expires in 10 minutes): ${link}`)
        } else {
          lines.push('add a device: ccc web add-device')
        }
      } else if (settings.mode === 'none') {
        lines.push(SERVER_NONE_WARNING)
      }
    }
    lines.push(`ccc for a shell on this server: ${options.wrapperPath}`)
    return lines
  }

  /**
   * Reads the stored settings again and applies them (start-up). The gateway's state after it is what
   * server mode's start order reads (server-start.ts): `failed` (the port is taken) ends the run with
   * status 1, `refused` (an unconfirmed stored risk) does not.
   */
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
    if (on) terminals.start()
    const status = await this.deps.gateway.apply(settings)
    if (!on && !listenPlanOf(this.settings()).ok) void terminals.drain()
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

  /**
   * Closes a device's sockets; it stays signed in. `by`: the browser that asked (server mode's card),
   * logged with the device it disconnected; the desktop's own Disconnect is not logged beyond the
   * sockets closing, as before.
   */
  disconnect(id: unknown, by?: AccessActor): boolean {
    if (typeof id !== 'string') return false
    const name = by ? this.deps.auth.devices.list().find((d) => d.id === id)?.name : undefined
    const closed = this.deps.gateway.disconnectDevice(id) > 0
    if (closed && by) {
      this.deps.accessLog?.write({ event: 'disconnect', device: id, ...(name !== undefined ? { name } : {}), detail: BROWSER_DISCONNECT_DETAIL, by })
    }
    return closed
  }

  /**
   * `how.reason` goes to `web-access.log` (the desktop's default, or `ccc web revoke`'s); a browser's
   * revoke (`how.by`, server mode's card) is logged as BROWSER_REVOKE_REASON with the acting device.
   */
  revoke(id: unknown, how: RevokeHow = {}): boolean {
    if (typeof id !== 'string') return false
    return this.deps.auth.devices.revoke(id, reasonOf(how), how.by)
  }

  revokeAll(how: RevokeHow = {}): number {
    return this.deps.auth.devices.revokeAll(reasonOf(how), how.by)
  }

  /** The origin a link points at, or the reply that says why there is no link. */
  private linkTarget(): string | WebLinkReply {
    const settings = this.settings()
    const server = this.deps.server === true
    if (this.deps.gateway.status().state !== 'listening' || !listenPlanOf(settings).ok) {
      return { ok: false, reason: server ? SERVER_NOT_LISTENING : NOT_LISTENING }
    }
    if (settings.mode !== 'link') return { ok: false, reason: server ? SERVER_NOT_LINK_MODE : NOT_LINK_MODE }
    return linkOrigin(settings)
  }

  private changed(): void {
    this.deps.emit(this.indicator())
  }
}

/** The log reason of a revoke: the one given, a browser's, or (undefined) the device store's default. */
function reasonOf(how: RevokeHow): string | undefined {
  return how.reason ?? (how.by ? BROWSER_REVOKE_REASON : undefined)
}
