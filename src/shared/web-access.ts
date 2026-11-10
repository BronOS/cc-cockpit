// What the desktop's Settings › General › Web access page and the top bar's indicator see of web
// access (design-web.md §4). Types plus the few constants both sides need; main builds every value
// (main/web/access-service.ts) and a remote view can reach none of it (every channel that carries
// these is `no`-class, ipc.ts: a browser must never widen its own access).
import type { WebAccessMode } from './types'

/** The settings as the page edits them (the bind and TLS are not editable yet, plan Task 28). */
export interface WebAccessForm {
  enabled: boolean
  port: number
  /** An origin (`https://box.tailnet.ts.net`), or '' for none. */
  externalOrigin: string
  /** Extra Host names, as stored (`host:port`). */
  hosts: string[]
  mode: WebAccessMode
}

/** What a change may carry; only the fields present change. `externalOrigin: null` clears it. */
export interface WebAccessPatch {
  enabled?: boolean
  port?: number
  externalOrigin?: string | null
  hosts?: string[]
  mode?: WebAccessMode
}

export type WebGatewayView =
  | { state: 'off' }
  /** Enabled, but not allowed to listen (a network bind before plan Task 28). */
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
  /** The bind the gateway uses (shown, not edited yet). */
  bind: string
  gateway: WebGatewayView
  devices: WebDeviceView[]
  /** Plain-words risks of the current choices (§4.3); empty when none. */
  risks: string[]
  /** A password is set (the password mode can be picked only then). */
  passwordSet: boolean
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

/** An access link (or a one-time one, which expires), or why there is none. */
export type WebLinkReply = { ok: true; link: string; expiresAt?: number } | { ok: false; reason: string }
