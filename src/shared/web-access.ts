// What the desktop's Settings › General › Web access page and the top bar's indicator see of web
// access (design-web.md §4). Types plus the few constants both sides need; main builds every value
// (main/web/access-service.ts). A remote view reaches the read side only in server mode (the card,
// the indicator and Revoke/Disconnect are `adapted`, design-web.md §9.4, §9.6), and never what adds
// or widens access (the link, add-device, the password, the settings: `no`-class in both modes).
import type { WebAccessMode, WebAccessRisk } from './types'

/** The settings as the page edits them. */
export interface WebAccessForm {
  enabled: boolean
  /** The address to listen on (an IP address or `localhost`). */
  bind: string
  port: number
  /** An origin (`https://box.tailnet.ts.net`), or '' for none. */
  externalOrigin: string
  /** Extra Host names, as stored (`host:port`). */
  hosts: string[]
  mode: WebAccessMode
  /** The TLS certificate and key files, or '' for none (plain http). */
  certPath: string
  keyPath: string
}

/**
 * What a change may carry; only the fields present change. `externalOrigin: null` and `tls: null`
 * clear them. `confirm` lists the §4.3 risks the person has just confirmed for this change: main
 * refuses a change that brings in a risk not confirmed (`WebConfirmNeeded`) and saves nothing.
 */
export interface WebAccessPatch {
  enabled?: boolean
  bind?: string
  port?: number
  externalOrigin?: string | null
  hosts?: string[]
  mode?: WebAccessMode
  tls?: { certPath: string; keyPath: string } | null
  confirm?: WebAccessRisk[]
}

/** The answer to a change that needs the person's confirm first: nothing was saved. */
export interface WebConfirmNeeded {
  needsConfirm: WebAccessRisk[]
}

/** What `settings.webAccessSet` answers: the page after the change, or the confirms it needs. */
export type WebAccessSetReply = WebAccessView | WebConfirmNeeded

/** What a §4.3 confirm says (design-web.md has the draft), and the badge's short form. */
export interface WebRiskText {
  title: string
  paragraphs: string[]
  accept: string
  /** One line for the warning badge and the settings page while the choice is on. */
  badge: string
}

/**
 * The one text of each risk, for the confirm (renderer), the badge (main's indicator) and the
 * settings page. Plain words, saying what someone else could do, not the protocol (§4.3).
 */
export const WEB_RISK_TEXT: Record<WebAccessRisk, WebRiskText> = {
  'none-network': {
    title: 'Anyone who can reach this address controls this computer.',
    paragraphs: [
      'With no sign-in, any device on this network (or the internet, if the port is reachable from it) can open cc-cockpit, ' +
        'read and type in your terminals, run Claude with your account, and read and change your files and plugin accounts ' +
        '(mail, Jira, chat), as if sitting at your desk.',
      'Use this only on a network you fully trust. If a proxy signs people in, keep cc-cockpit on 127.0.0.1 behind it: ' +
        'listening on the network lets people go around the proxy.'
    ],
    accept: 'I understand, turn off sign-in',
    badge: 'Sign-in is off on a network address: anyone who can reach it controls this computer.'
  },
  'plain-http': {
    title: 'Everything you send travels unencrypted.',
    paragraphs: [
      'Over plain http, the access link or password and everything you type and see (terminals, Claude, plugin pages) ' +
        'cross the network as readable text. Anyone on the same network, such as shared Wi-Fi or a router on the way, ' +
        'can read them, and with the link or password sign in and control this computer as you.',
      'Use this only on a network you fully trust. Safer: https, with a certificate below or a proxy in front that ' +
        'serves it (Tailscale Serve), or an SSH tunnel to 127.0.0.1.'
    ],
    accept: 'I understand, use plain http',
    badge: 'Plain http on a network: the access link, passwords and everything you type can be read by others on it.'
  }
}

/**
 * §9.12: on a shared server every local user reaches 127.0.0.1, so None hands the account to all of
 * them (and, on a network bind given its confirm, to the network too). Server mode's start line,
 * `ccc web mode none` and the browser's card all say it.
 */
export const SERVER_NONE_WARNING =
  'no sign-in: anyone who can reach this address, every user of this machine included, controls cc-cockpit as you'

/** The order confirms are asked in when one change brings both: the worse one first. */
export const WEB_RISK_ORDER: readonly WebAccessRisk[] = ['none-network', 'plain-http']

export type WebGatewayView =
  | { state: 'off' }
  /** Enabled, but not allowed to listen (a risk not confirmed, a bind that is not an address). */
  | { state: 'refused'; reason: string }
  /** Enabled and allowed, but listening failed (port in use). */
  | { state: 'failed'; reason: string }
  | { state: 'listening'; bind: string; port: number; /** The origin links point at. */ origin: string }

/** A signed-in device as the list shows it. */
export interface WebDeviceView {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  /** How it signed in: `link`, `add` (a one-time link), `password`, `confirm`, or `none` (no sign-in). */
  mode: string
  /** A socket of it is open now. */
  connected: boolean
}

export interface WebAccessView {
  form: WebAccessForm
  /** The saved bind is not loopback: other devices reach it directly, not only through a proxy. */
  network: boolean
  gateway: WebGatewayView
  devices: WebDeviceView[]
  /** Plain-words risks of the current choices (§4.3); empty when none. */
  risks: string[]
  /** A password is set (the password mode can be picked only then). */
  passwordSet: boolean
  /**
   * The access link's token and the password as stored (design-web.md §9.5): `other-mode` and
   * `replaced` are there but cannot be read by this run's store, so the link cannot be shown until
   * regenerated and the password must be set again. Never the values themselves.
   */
  credentials: { accessLink: WebCredentialState; password: WebCredentialState }
  /** Server mode only (the browser's card): the secret store of the run, as `ccc web status` has it. */
  secrets?: WebSecretsStatus
}

/**
 * A browser waiting for a desktop confirm (§4.2), as the desktop shows it. Never the code: the
 * person types the one the browser shows. `name` is the requester's own text, shown as such.
 */
export interface WebConfirmAsk {
  id: string
  name: string
  expiresAt: number
}

/** The answer to a desktop action that can be refused (set the password, answer a confirm). */
export type WebActionReply = { ok: true } | { ok: false; reason: string }

/** The top bar's view: how many devices are connected, and a warning while a §4.3 choice is on. */
export interface WebAccessIndicator {
  connected: number
  /** Present while a risky choice is on and the gateway is listening. */
  warning?: string
  /** Present while a browser waits for a desktop confirm: every desktop window shows the request. */
  confirm?: WebConfirmAsk
}

/**
 * The indicator as a browser view gets it: never a desktop-confirm request (`confirm` names the
 * browser asking to get in, and only the desktop may answer it, `webAccess.confirmAnswer` is `no`).
 * Server mode refuses that mode anyway (§9.2); dropped here so no path depends on it. The router's
 * `webAccess.state` and the `webAccess.changed` event's adapter (main/web/connection.ts) both use it.
 */
export function remoteIndicator(indicator: WebAccessIndicator): WebAccessIndicator {
  const out: WebAccessIndicator = { connected: indicator.connected }
  if (indicator.warning !== undefined) out.warning = indicator.warning
  return out
}

/** An access link (or a one-time one, which expires), or why there is none. */
export type WebLinkReply = { ok: true; link: string; expiresAt?: number } | { ok: false; reason: string }

/** A stored credential (the access link's token, the password) as `ccc web status` reports it (main/web/auth.ts). */
export type WebCredentialState = 'unset' | 'set' | 'other-mode' | 'replaced'

/** The secret store of this run, as `ccc web status` reports it (design-web.md §9.5). */
export interface WebSecretsStatus {
  /** `os` the keychain (desktop), `keyfile` server mode's `<data>/secret.key`, `fake` a test run's. */
  store: 'os' | 'keyfile' | 'fake'
  /** Why the store cannot store or read anything now, or null. */
  unavailable: string | null
  /** Stored values made by the other mode's store: neither readable here nor lost. */
  otherMode: number
  /** Key file values made under a key file that was replaced since: lost, enter them again. */
  replaced: number
}

/**
 * `ccc web status [--json]` (design-web.md §9.4), answered in both modes. Never a link, a token, a
 * hash or a stored value: what the person reads to know who is in and why nothing listens.
 */
export interface WebCliStatus {
  /** Main's `server` flag for the run. */
  server: boolean
  enabled: boolean
  mode: WebAccessMode
  bind: string
  port: number
  /** The external origin set in the settings, or null. */
  externalOrigin: string | null
  /** Listening (with the origin links point at), or why not. */
  gateway: WebGatewayView
  secrets: WebSecretsStatus
  accessLink: WebCredentialState
  password: WebCredentialState
  devices: WebDeviceView[]
  /** The core notices of this run (a new device, a revoked plugin, a newer release); server mode only, else empty. */
  notices: WebCliNotice[]
}

/** A core notice as `ccc web status` lists it (main/notifications/core-notices.ts): one plain line, no link or plugin text. */
export interface WebCliNotice {
  kind: 'new-device' | 'revoked' | 'update'
  text: string
  /** Epoch ms. */
  at: number
  /** A new-device notice: the device's id, which names its `sign-in` entry in `web-access.log`. */
  device?: string
}

/** `ccc web revoke`: how many devices were signed out. */
export interface WebCliRevokeResult {
  revoked: number
}
