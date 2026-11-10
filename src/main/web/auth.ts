// Who may use web access (design-web.md §4.1, §4.2): the device cookie every auth mode ends in, the
// access link, None on loopback, and the slowing of failed sign-ins. The gateway (gateway.ts) asks
// `authorize` on every upgrade and every route behind sign-in, and posts sign-ins here; devices.ts
// keeps the devices and the token's record.
//
// Modes in this file (plan Task 5); password and desktop confirm come with Task 27:
//  - Access link (`link`, the default): a 256-bit token, the link `<origin>/#t=<token>`. The
//    fragment never reaches the server, a proxy log or a Referer; the page reads it and posts it
//    once (Origin-checked, gateway.ts) for a device cookie. The token is kept twice: its SHA-256 for
//    the sign-in check (constant time, no keychain round trip per attempt) and the secret store's
//    ciphertext, so the desktop can show it again (Show button, Task 9). With no working keychain
//    there is no access token at all (never a plaintext fallback, secret-store.ts); the one-time
//    link below still works, as it lives in memory only.
//    Regenerate kills the token and every device that signed in with it (`revokeSignedInWith`).
//    "Add a device": a one-time token, valid 10 minutes, in memory, used once; a new one replaces
//    the last. Safer to show on screen than the access link.
//  - None: no sign-in; whoever passes the Host and Origin checks is in, as the anonymous device
//    `NONE_DEVICE`. Loopback only for now (listenPlanOf refuses every network bind until Task 28
//    adds the §4.3 confirm). A device cookie from before still names its device.
//
// Failed attempts are slowed, never locked out (a lockout lets anyone who can reach the address
// keep the person out) and never keyed by peer address (behind `tailscale serve` every peer is
// 127.0.0.1): `AttemptLimiter`, one bucket for every caller. The known limit of one global bucket:
// a sustained flood keeps its queue full, and while it lasts a new sign-in is answered "busy"
// (429) too, as nothing tells the person's attempt from the flood's. Accepted: devices already
// signed in are untouched (a cookie check never goes through the limiter), the flood ends when the
// sender stops, and holding requests open without a cap would be worse. Guessing is not the risk
// here (256-bit tokens); the per-check bound is for the password mode (Task 27).
//
// The device cookie: `HttpOnly; SameSite=Strict; Path=/`, `Secure` when the page's origin is https.
// On loopback, cookies ignore ports, so SameSite does not keep other localhost pages out: the
// Origin check does (checks.ts). The cookie is never rotated (devices.ts says why); its Max-Age is
// the browser's cap, and the server's 30-day sliding expiry decides.
import type { WebAccessMode } from '../../shared/types'
import type { SecretStore } from '../secrets/secret-store'
import type { AccessLog } from './access-log'
import { DeviceStore, hashSecret, matchesHash, randomSecret, type DeviceSignIn, type WebDevice } from './devices'

export const DEVICE_COOKIE = 'ccc_device'
/** Chrome's cap on a cookie's lifetime; the device's own 30-day sliding expiry is what counts. */
export const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60
export const ADD_DEVICE_TTL_MS = 10 * 60 * 1000
/** Far above a 43-character token; anything longer is not one. */
const MAX_TOKEN_LENGTH = 256

/** The anonymous caller of None mode: no record, nothing to revoke. */
export const NONE_DEVICE: Readonly<WebDevice> = Object.freeze({ id: 'none', name: 'No sign-in', createdAt: 0, lastSeenAt: 0, mode: 'none' })

/**
 * Every value of cookie `name` in a `Cookie` header, in order (at most 4). More than one: another
 * localhost page can set a same-named cookie with a narrower path, which the browser sends first;
 * trying each keeps that from signing the person out.
 */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (typeof header !== 'string') return []
  const out: string[] = []
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue
    out.push(part.slice(eq + 1).trim())
    if (out.length === 4) break
  }
  return out
}

/** The `Set-Cookie` value for a device cookie, flags by the origin the page is under. */
export function deviceCookie(value: string, origin: string): string {
  // Secure on https only: a browser drops a Secure cookie set over plain http, and plain http on a
  // network address exists only behind the §4.3 confirm (Task 28). Loopback http: no Secure (§4.1).
  const secure = origin.toLowerCase().startsWith('https:')
  return `${DEVICE_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
}

/** The origin links point at: the external origin (a proxy), else the gateway's own address. */
export function linkOrigin(settings: { bind: string; port: number; externalOrigin?: string }): string {
  if (settings.externalOrigin !== undefined) return settings.externalOrigin
  const host = settings.bind.includes(':') ? `[${settings.bind}]` : settings.bind
  return `http://${host}:${settings.port}`
}

export interface AttemptLimiterOptions {
  /** Attempts answered at once while the bucket has tokens. */
  capacity?: number
  /** One token back per this many ms. */
  refillMs?: number
  /** Once the bucket is empty, attempts run one at a time this far apart. */
  delayMs?: number
  /** Attempts waiting beyond this are answered "busy" at once instead of holding a request open. */
  maxWaiting?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Slows sign-in attempts globally (design-web.md §4.1): a token bucket, and a fixed delay once it is
 * empty. Every attempt takes a token; a successful one gives it back, so only failures drain it.
 * With the bucket empty, attempts queue and run one per `delayMs`, so a burst of guesses, however
 * parallel, gets at most one check a second. Nothing is ever locked: the person's own attempt
 * waits behind the queue at worst. The queue is capped (`busy`) so a flood cannot hold requests
 * without end. Not keyed by peer: behind a proxy every peer is 127.0.0.1.
 */
export class AttemptLimiter {
  private readonly capacity: number
  private readonly refillMs: number
  private readonly delayMs: number
  private readonly maxWaiting: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private tokens: number
  private refilledAt: number
  private waiting = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(options: AttemptLimiterOptions = {}) {
    this.capacity = options.capacity ?? 10
    this.refillMs = options.refillMs ?? 6000
    this.delayMs = options.delayMs ?? 1000
    this.maxWaiting = options.maxWaiting ?? 64
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.tokens = this.capacity
    this.refilledAt = this.now()
  }

  /**
   * Runs `attempt` now or after its turn; `busy` when too many already wait, `cancelled` when
   * `cancelled()` says the caller is gone by then (its attempt never runs, so it neither takes a
   * token nor spends a one-time token).
   */
  async run<T extends { ok: boolean }>(attempt: () => T, cancelled?: () => boolean): Promise<T | 'busy' | 'cancelled'> {
    this.refill()
    if (cancelled?.()) return 'cancelled'
    // Nobody queued and a token free: at once. Queued attempts go first, in order.
    if (this.waiting === 0 && this.tokens >= 1) {
      this.tokens -= 1
      const result = attempt()
      if (result.ok) this.tokens = Math.min(this.capacity, this.tokens + 1)
      return result
    }
    if (this.waiting >= this.maxWaiting) return 'busy'
    this.waiting++
    const turn = this.chain.then(() => this.sleep(this.delayMs))
    this.chain = turn
    try {
      await turn
    } finally {
      this.waiting--
    }
    // The wait can be long (a queue of guesses ahead of it): the client may have hung up.
    if (cancelled?.()) return 'cancelled'
    return attempt()
  }

  private refill(): void {
    const now = this.now()
    const back = Math.floor((now - this.refilledAt) / this.refillMs)
    if (back <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + back)
    this.refilledAt = this.tokens === this.capacity ? now : this.refilledAt + back * this.refillMs
  }
}

export type SignInResult =
  | { ok: true; device: WebDevice; cookie: string }
  | { ok: false; status: 400 | 401 | 409 | 429 | 499 | 503; error: string }

export type LinkResult = { ok: true; link: string } | { ok: false; reason: string }

export interface WebAuthOptions {
  devices: DeviceStore
  secrets: SecretStore
  accessLog: AccessLog
  limiter?: AttemptLimiter
  now?: () => number
  log?: (message: string) => void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class WebAuth {
  readonly devices: DeviceStore
  private readonly secrets: SecretStore
  private readonly accessLog: AccessLog
  private readonly limiter: AttemptLimiter
  private readonly now: () => number
  private readonly log: (message: string) => void
  private currentMode: WebAccessMode | undefined
  private once: { hash: string; expiresAt: number } | undefined
  /** Token creation and regeneration one at a time: two Show clicks must not make two tokens. */
  private tokenQueue: Promise<unknown> = Promise.resolve()

  constructor(options: WebAuthOptions) {
    this.devices = options.devices
    this.secrets = options.secrets
    this.accessLog = options.accessLog
    this.limiter = options.limiter ?? new AttemptLimiter()
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((m) => console.warn(m))
  }

  get mode(): WebAccessMode | undefined {
    return this.currentMode
  }

  /** The gateway passes the settings' mode on every apply; a change is logged (not the first). */
  setMode(mode: WebAccessMode): void {
    if (this.currentMode !== undefined && this.currentMode !== mode) {
      this.accessLog.write({ event: 'mode', detail: `${this.currentMode} -> ${mode}` })
    }
    this.currentMode = mode
  }

  /** The device a request's `Cookie` header signs in, the anonymous one in None mode, or undefined. */
  authorize(cookieHeader: string | undefined): WebDevice | undefined {
    for (const value of cookieValues(cookieHeader, DEVICE_COOKIE)) {
      const device = this.devices.check(value)
      if (device) return device
    }
    return this.currentMode === 'none' ? { ...NONE_DEVICE } : undefined
  }

  /** The access link, making the token on first use. Never throws. */
  accessLink(origin: string): Promise<LinkResult> {
    return this.serial(async () => {
      const record = this.devices.accessToken()
      if (record) {
        try {
          return { ok: true, link: this.link(origin, await this.secrets.decrypt(record.stored)) }
        } catch (err) {
          return { ok: false, reason: `cannot read the access token: ${errorText(err)}` }
        }
      }
      return this.create(origin)
    })
  }

  /**
   * A new access token: the old one stops working and every device that signed in with it is
   * revoked, at once and even when the new one cannot be stored (taking access back must not
   * depend on the keychain). Never throws.
   */
  regenerate(origin: string): Promise<LinkResult> {
    return this.serial(async () => {
      this.devices.setAccessToken(undefined)
      // Taking access back covers a pending "add a device" link too: it may be on a screen
      // someone else saw. Devices that already signed in with one stay (they never had the token).
      this.once = undefined
      this.accessLog.write({ event: 'regenerate' })
      this.devices.revokeSignedInWith('link', 'access link regenerated')
      return this.create(origin)
    })
  }

  /** A one-time "add a device" link, valid 10 minutes; it replaces the previous one. */
  addDeviceLink(origin: string): { link: string; expiresAt: number } {
    const token = randomSecret()
    const expiresAt = this.now() + ADD_DEVICE_TTL_MS
    this.once = { hash: hashSecret(token), expiresAt }
    return { link: this.link(origin, token), expiresAt }
  }

  /**
   * A sign-in with the access token or the one-time token (`{ token, name? }`, the page's post).
   * The gateway has checked Host and Origin already. `cancelled` says the request is gone (the
   * client hung up while the attempt waited): it then never runs (499).
   */
  async signInWithToken(body: unknown, cancelled?: () => boolean): Promise<SignInResult> {
    if (this.currentMode !== 'link') return { ok: false, status: 409, error: 'sign-in with a link is off' }
    const fields = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined
    const token = fields?.['token']
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return { ok: false, status: 400, error: 'no token' }
    }
    const name = fields?.['name']
    const result = await this.limiter.run(() => this.checkToken(token, name), cancelled)
    if (result === 'busy') return { ok: false, status: 429, error: 'too many attempts, try again shortly' }
    if (result === 'cancelled') return { ok: false, status: 499, error: 'the request is gone' }
    return result
  }

  /** Runs synchronously after the limiter's turn: the check and the one-time token's use cannot interleave. */
  private checkToken(token: string, name: unknown): SignInResult {
    // The mode may have changed while the attempt waited its turn.
    if (this.currentMode !== 'link') return { ok: false, status: 409, error: 'sign-in with a link is off' }
    const record = this.devices.accessToken()
    const once = this.once
    // Both compares always run, so the time taken does not say which token (if any) exists.
    const isAccess = matchesHash(token, record?.hash ?? '')
    const isOnce = matchesHash(token, once?.hash ?? '') && once !== undefined && this.now() < once.expiresAt
    let mode: DeviceSignIn
    if (isOnce) mode = 'add'
    else if (isAccess && record) mode = 'link'
    else {
      this.accessLog.write({ event: 'sign-in-failed', detail: 'link' })
      return { ok: false, status: 401, error: 'this link does not work any more' }
    }
    const added = this.devices.add(name, mode)
    // Store full: the one-time token stays usable, for after the person revoked some devices.
    if (!added) return { ok: false, status: 503, error: 'too many devices; revoke some on the desktop' }
    // Used up only now that it let a device in; synchronous since the check, so no other attempt
    // can have used it in between.
    if (isOnce) this.once = undefined
    return { ok: true, device: added.device, cookie: added.cookie }
  }

  private async create(origin: string): Promise<LinkResult> {
    const token = randomSecret()
    let stored: string
    try {
      stored = await this.secrets.encrypt(token)
    } catch (err) {
      this.log(`web access: no access link: ${errorText(err)}`)
      return { ok: false, reason: errorText(err) }
    }
    this.devices.setAccessToken({ hash: hashSecret(token), stored, createdAt: this.now() })
    return { ok: true, link: this.link(origin, token) }
  }

  private link(origin: string, token: string): string {
    return `${origin}/#t=${token}`
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tokenQueue.then(run)
    this.tokenQueue = next.catch(() => undefined)
    return next
  }
}
