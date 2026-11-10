// What the desktop's Settings › General › Web access page and the top bar's indicator see of web
// access (design-web.md §4). Types plus the few constants both sides need; main builds every value
// (main/web/access-service.ts) and a remote view can reach none of it (every channel that carries
// these is `no`-class, ipc.ts: a browser must never widen its own access).
import type { WebAccessMode } from './types'

/**
 * Which auth modes can be picked now. Password and desktop confirm come with plan Task 27, so main
 * refuses them (a hand-edited app.json that names one still reads as that mode, and the gateway
 * then accepts no sign-in at all: nothing signs in, which fails closed).
 */
export const WEB_MODE_AVAILABLE: Readonly<Record<WebAccessMode, boolean>> = Object.freeze({
  link: true,
  none: true,
  password: false,
  confirm: false
})

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
}

/** The top bar's view: how many devices are connected, and a warning while a §4.3 choice is on. */
export interface WebAccessIndicator {
  connected: number
  /** Present while a risky choice is on and the gateway is listening. */
  warning?: string
}

/** An access link (or a one-time one, which expires), or why there is none. */
export type WebLinkReply = { ok: true; link: string; expiresAt?: number } | { ok: false; reason: string }
