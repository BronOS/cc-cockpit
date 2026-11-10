// Who may use web access (design-web.md §4.1, §4.2): the device cookie every auth mode ends in, the
// four auth modes, and the slowing of failed sign-ins. The gateway (gateway.ts) asks `authorize` on
// every upgrade and every route behind sign-in, and posts sign-ins here; devices.ts keeps the
// devices and the credentials' records.
//
// Modes:
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
//  - Password (plan Task 27): set on the desktop, kept as an scrypt hash (password.ts) that only the
//    secret store's ciphertext of is on disk; decrypted once and held in memory, so an attempt costs
//    a hash, not a keychain round trip. The hash runs off the main thread, a few at a time, and
//    every attempt goes through the limiter below. Changing the password signs out every device
//    that signed in with the old one (as regenerating the link does). No keychain: no password.
//  - Desktop confirm (plan Task 27): the browser asks (`requestConfirm`) and gets a short code and a
//    256-bit ticket; the desktop shows a non-modal request with no default button, naming the
//    browser by its own text, and the person types the code the browser shows (`answerConfirm`).
//    The desktop never sees the code: typing it is what ties the request on screen to the browser
//    in the person's hand, so an attacker's request made at the same moment cannot be allowed by
//    mistake. The browser polls with its ticket (`pollConfirm`) and collects the device cookie once
//    allowed; only the ticket's holder can. One request at a time (a second is refused while one
//    waits), each ask goes through the limiter and never gives its token back, it lapses after
//    CONFIRM_TTL_MS, and CONFIRM_MAX_WRONG wrong codes deny it. The known limit: someone who can
//    reach the address can keep the one slot taken (an ask every CONFIRM_TTL_MS, slowed by the
//    limiter); the person sees each one on the desktop and can deny it, and nothing gets in.
//    Polls are not limited: the ticket is 256 random bits, compared in constant time.
//  - None: no sign-in; whoever passes the Host and Origin checks is in, as the anonymous device
//    `NONE_DEVICE`. Loopback only for now (listenPlanOf refuses every network bind until Task 28
//    adds the §4.3 confirm). A device cookie from before still names its device.
//
// Failed attempts are slowed, never locked out (a lockout lets anyone who can reach the address
// keep the person out) and never keyed by peer address (behind `tailscale serve` every peer is
// 127.0.0.1): `AttemptLimiter`, one bucket for every caller and every mode. The known limit of one
// global bucket: a sustained flood keeps its queue full, and while it lasts a new sign-in is
// answered "busy" (429) too, as nothing tells the person's attempt from the flood's. Accepted:
// devices already signed in are untouched (a cookie check never goes through the limiter), the
// flood ends when the sender stops, and holding requests open without a cap would be worse.
// Guessing a 256-bit token is not the risk; the per-check bound is for the password.
//
// The device cookie: `HttpOnly; SameSite=Strict; Path=/`, `Secure` when the page's origin is https.
// On loopback, cookies ignore ports, so SameSite does not keep other localhost pages out: the
// Origin check does (checks.ts). The cookie is never rotated (devices.ts says why); its Max-Age is
// the browser's cap, and the server's 30-day sliding expiry decides.
import { randomBytes, randomInt } from 'node:crypto'
import type { WebAccessMode } from '../../shared/types'
import type { WebActionReply, WebConfirmAsk } from '../../shared/web-access'
import type { WebConfirmPoll } from '../../shared/web-protocol'
import type { SecretStore } from '../secrets/secret-store'
import type { AccessLog } from './access-log'
import { DeviceStore, deviceName as deviceNameOf, hashSecret, matchesHash, randomSecret, type DeviceSignIn, type WebDevice } from './devices'
import { MAX_PASSWORD_LENGTH, PasswordHasher, passwordProblem } from './password'

export const DEVICE_COOKIE = 'ccc_device'
/** Chrome's cap on a cookie's lifetime; the device's own 30-day sliding expiry is what counts. */
export const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60
export const ADD_DEVICE_TTL_MS = 10 * 60 * 1000
/** Far above a 43-character token; anything longer is not one. */
const MAX_TOKEN_LENGTH = 256
/** A desktop-confirm request waits this long for the person, then lapses. */
export const CONFIRM_TTL_MS = 2 * 60 * 1000
/** Once allowed, the browser has this long to collect its cookie (it polls every couple of seconds). */
export const CONFIRM_COLLECT_MS = 60 * 1000
/** Wrong codes typed on the desktop before the request is denied (a request that is not the person's). */
export const CONFIRM_MAX_WRONG = 3
/** Digits of the code the browser shows; the person types it, nobody guesses it. */
export const CONFIRM_CODE_DIGITS = 6

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
   * token nor spends a one-time token). `attempt` may be async (a password's hash): it is started
   * synchronously, and its token comes back when it settles with `ok`. `refund: false` keeps the
   * token even then: a desktop-confirm ask is never a "failure", but asks must be slowed all the same.
   */
  async run<T extends { ok: boolean }>(
    attempt: () => T | Promise<T>,
    cancelled?: () => boolean,
    options: { refund?: boolean } = {}
  ): Promise<T | 'busy' | 'cancelled'> {
    this.refill()
    if (cancelled?.()) return 'cancelled'
    const refund = options.refund !== false
    // Nobody queued and a token free: at once. Queued attempts go first, in order.
    if (this.waiting === 0 && this.tokens >= 1) {
      this.tokens -= 1
      const result = await attempt()
      if (result.ok && refund) this.tokens = Math.min(this.capacity, this.tokens + 1)
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

/** A desktop-confirm ask: the code the browser shows and the ticket it polls with. */
export type ConfirmAskResult =
  | { ok: true; code: string; ticket: string; expiresAt: number }
  | { ok: false; status: 400 | 409 | 429 | 499; error: string }

/** A poll: where the ask stands, and on `allowed` the new device's cookie value. */
export type ConfirmPollResult = { ok: true; poll: WebConfirmPoll; cookie?: string } | { ok: false; status: 400 | 503; error: string }

interface PendingAsk {
  id: string
  /** The requester's own text (devices.ts deviceName), shown as such. */
  name: string
  /** Kept for the poller only: the desktop is never told it. */
  code: string
  codeHash: string
  ticketHash: string
  expiresAt: number
  state: 'pending' | 'allowed' | 'denied'
  wrong: number
}

export interface WebAuthOptions {
  devices: DeviceStore
  secrets: SecretStore
  accessLog: AccessLog
  limiter?: AttemptLimiter
  /** scrypt for the password (password.ts); tests pass a cheap or counting one. */
  hasher?: PasswordHasher
  /** A desktop notification (main: the notifier adapter): a browser asks for a desktop confirm. */
  notify?: (text: string) => void
  now?: () => number
  log?: (message: string) => void
}

/** The code as typed on the desktop: spaces and dashes the person may add are not part of it. */
function typedCode(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 64) return ''
  let out = ''
  for (const ch of raw) if (ch !== ' ' && ch !== '-' && ch !== '\u00a0') out += ch
  return out
}

function fieldsOf(body: unknown): Record<string, unknown> | undefined {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined
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
  /** Token creation and regeneration (and setting the password) one at a time: two Show clicks must not make two tokens. */
  private tokenQueue: Promise<unknown> = Promise.resolve()
  private readonly hasher: PasswordHasher
  private readonly notify: (text: string) => void
  /** The password's hash as decrypted from `stored`; dropped when the record changes. */
  private passwordCache: { stored: string; encoded: string } | undefined
  /** Bumped by every set: an attempt that started under an older password never signs in. */
  private passwordGeneration = 0
  private ask: PendingAsk | undefined
  private askTimer: ReturnType<typeof setTimeout> | undefined
  private readonly changeListeners = new Set<() => void>()

  constructor(options: WebAuthOptions) {
    this.devices = options.devices
    this.secrets = options.secrets
    this.accessLog = options.accessLog
    this.limiter = options.limiter ?? new AttemptLimiter()
    this.hasher = options.hasher ?? new PasswordHasher()
    this.notify = options.notify ?? (() => undefined)
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((m) => console.warn(m))
  }

  /** Called when the desktop-confirm request comes, is answered, collected or lapses (the desktop redraws it). */
  onChanged(listener: () => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.changeListeners) {
      try {
        listener()
      } catch {
        // A listener's failure must not undo the change it hears about.
      }
    }
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
    // A request asked under desktop confirm means nothing in another mode.
    if (mode !== 'confirm') this.dropAsk()
  }

  /** Drops a waiting desktop-confirm request (web access turned off: no browser can collect it). */
  dropPending(): void {
    this.dropAsk()
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
    const fields = fieldsOf(body)
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

  // --- password -----------------------------------------------------------------------------------

  /** Whether a password is set (the record is there; whether the keychain can read it is the next question). */
  hasPassword(): boolean {
    return this.devices.password() !== undefined
  }

  /**
   * Sets or changes the password (the desktop). Hashed off the main thread, stored only as the
   * secret store's ciphertext; a change signs out every device that signed in with the old one.
   * Never throws: a refusal is the reply's reason.
   */
  setPassword(password: unknown): Promise<WebActionReply> {
    return this.serial(async () => {
      const problem = passwordProblem(password)
      if (problem !== undefined || typeof password !== 'string') return { ok: false, reason: problem ?? 'the password must be text' }
      let encoded: string
      let stored: string
      try {
        encoded = await this.hasher.hash(password)
        stored = await this.secrets.encrypt(encoded)
      } catch (err) {
        this.log(`web access: cannot store the password: ${errorText(err)}`)
        return { ok: false, reason: `cannot store the password: ${errorText(err)}` }
      }
      const had = this.devices.password() !== undefined
      this.devices.setPassword({ stored, createdAt: this.now() })
      this.passwordCache = { stored, encoded }
      this.passwordGeneration++
      this.accessLog.write({ event: 'password', detail: had ? 'changed' : 'set' })
      if (had) this.devices.revokeSignedInWith('password', 'password changed')
      return { ok: true }
    })
  }

  /** A sign-in with the password (`{ password, name? }`, the page's post). Like `signInWithToken`. */
  async signInWithPassword(body: unknown, cancelled?: () => boolean): Promise<SignInResult> {
    if (this.currentMode !== 'password') return { ok: false, status: 409, error: 'sign-in with a password is off' }
    const fields = fieldsOf(body)
    const password = fields?.['password']
    // Raw length, before normalising: a cap on what reaches scrypt (NFC can only grow it a little).
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH * 4) {
      return { ok: false, status: 400, error: 'no password' }
    }
    const result = await this.limiter.run(() => this.checkPassword(password, fields?.['name'], cancelled), cancelled)
    if (result === 'busy') return { ok: false, status: 429, error: 'too many attempts, try again shortly' }
    if (result === 'cancelled') return { ok: false, status: 499, error: 'the request is gone' }
    return result
  }

  private async checkPassword(password: string, name: unknown, cancelled?: () => boolean): Promise<SignInResult> {
    const generation = this.passwordGeneration
    const encoded = await this.passwordHash()
    // Always one full hash, a password set or not (password.ts verify).
    const matches = await this.hasher.verify(password, encoded)
    // The hash took a while: the mode or the password may have changed, the client may be gone.
    if (this.currentMode !== 'password') return { ok: false, status: 409, error: 'sign-in with a password is off' }
    if (!matches || generation !== this.passwordGeneration) {
      this.accessLog.write({ event: 'sign-in-failed', detail: 'password' })
      return { ok: false, status: 401, error: encoded === undefined ? 'no password is set on the desktop' : 'wrong password' }
    }
    if (cancelled?.()) return { ok: false, status: 499, error: 'the request is gone' }
    const added = this.devices.add(name, 'password')
    if (!added) return { ok: false, status: 503, error: 'too many devices; revoke some on the desktop' }
    return { ok: true, device: added.device, cookie: added.cookie }
  }

  /** The stored hash, decrypted once per record; undefined with none set or an unreadable one (logged). */
  private async passwordHash(): Promise<string | undefined> {
    const record = this.devices.password()
    if (!record) return undefined
    if (this.passwordCache?.stored === record.stored) return this.passwordCache.encoded
    try {
      const encoded = await this.secrets.decrypt(record.stored)
      this.passwordCache = { stored: record.stored, encoded }
      return encoded
    } catch (err) {
      this.log(`web access: cannot read the password: ${errorText(err)}`)
      return undefined
    }
  }

  // --- desktop confirm ----------------------------------------------------------------------------

  /** The waiting request as the desktop shows it (never its code), or undefined. */
  confirmAsk(): WebConfirmAsk | undefined {
    this.lapse()
    const ask = this.ask
    return ask?.state === 'pending' ? { id: ask.id, name: ask.name, expiresAt: ask.expiresAt } : undefined
  }

  /** A browser asks for a desktop confirm (`{ name? }`, the page's post): its code and ticket. */
  async requestConfirm(body: unknown, cancelled?: () => boolean): Promise<ConfirmAskResult> {
    if (this.currentMode !== 'confirm') return { ok: false, status: 409, error: 'sign-in with a desktop confirm is off' }
    const name = fieldsOf(body)?.['name']
    // Through the bucket like every sign-in, and never refunded: a stream of asks drains it.
    const result = await this.limiter.run(() => this.createAsk(name), cancelled, { refund: false })
    if (result === 'busy') return { ok: false, status: 429, error: 'too many attempts, try again shortly' }
    if (result === 'cancelled') return { ok: false, status: 499, error: 'the request is gone' }
    return result
  }

  private createAsk(name: unknown): ConfirmAskResult {
    if (this.currentMode !== 'confirm') return { ok: false, status: 409, error: 'sign-in with a desktop confirm is off' }
    this.lapse()
    // A denied one blocks nothing: its browser learns `gone` when it polls next.
    if (this.ask && this.ask.state !== 'denied') {
      return { ok: false, status: 409, error: 'another browser is waiting for an answer on the desktop; try again in a few minutes' }
    }
    const code = String(randomInt(0, 10 ** CONFIRM_CODE_DIGITS)).padStart(CONFIRM_CODE_DIGITS, '0')
    const ticket = randomSecret()
    const ask: PendingAsk = {
      id: randomBytes(9).toString('base64url'),
      name: deviceNameOf(name),
      code,
      codeHash: hashSecret(code),
      ticketHash: hashSecret(ticket),
      expiresAt: this.now() + CONFIRM_TTL_MS,
      state: 'pending',
      wrong: 0
    }
    this.ask = ask
    this.armLapse()
    this.accessLog.write({ event: 'confirm', name: ask.name, detail: 'asked' })
    // Generic on purpose: the name is the requester's text, the desktop's card shows it as such.
    this.notify('A browser asks to sign in to web access. Answer it in the cc-cockpit window.')
    this.changed()
    return { ok: true, code, ticket, expiresAt: ask.expiresAt }
  }

  /** The browser's poll with its ticket (`{ ticket }`): pending, denied, gone, or allowed with a cookie. */
  pollConfirm(body: unknown): ConfirmPollResult {
    const ticket = fieldsOf(body)?.['ticket']
    if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > MAX_TOKEN_LENGTH) return { ok: false, status: 400, error: 'no ticket' }
    this.lapse()
    const ask = this.ask
    // Compared whatever there is, so the time taken says nothing.
    const mine = matchesHash(ticket, ask?.ticketHash ?? '') && ask !== undefined
    if (!mine || !ask) return { ok: true, poll: { state: 'gone' } }
    if (ask.state === 'pending') return { ok: true, poll: { state: 'pending', code: ask.code, expiresAt: ask.expiresAt } }
    if (ask.state === 'denied') {
      this.dropAsk()
      return { ok: true, poll: { state: 'denied' } }
    }
    const added = this.devices.add(ask.name, 'confirm')
    // Store full: the allowed request stays, so a revoke on the desktop lets the next poll in.
    if (!added) return { ok: false, status: 503, error: 'too many devices; revoke some on the desktop' }
    this.dropAsk()
    return { ok: true, poll: { state: 'allowed', device: { id: added.device.id, name: added.device.name } }, cookie: added.cookie }
  }

  /**
   * The desktop's answer: deny, or allow with the code the browser shows. A wrong code leaves the
   * request waiting (a typo) until CONFIRM_MAX_WRONG, then denies it. Never throws.
   */
  answerConfirm(id: unknown, allow: unknown, code: unknown): WebActionReply {
    this.lapse()
    const ask = this.ask
    if (!ask || typeof id !== 'string' || ask.id !== id || ask.state !== 'pending') return { ok: false, reason: 'This request is no longer waiting.' }
    if (allow !== true) {
      this.deny(ask, 'denied on the desktop')
      return { ok: true }
    }
    if (!matchesHash(typedCode(code), ask.codeHash)) {
      ask.wrong++
      if (ask.wrong >= CONFIRM_MAX_WRONG) {
        this.deny(ask, 'wrong code')
        return { ok: false, reason: `That was not the code ${CONFIRM_MAX_WRONG} times, so the request was denied. If it was yours, ask again from the browser.` }
      }
      return { ok: false, reason: 'That is not the code the browser shows.' }
    }
    ask.state = 'allowed'
    ask.expiresAt = this.now() + CONFIRM_COLLECT_MS
    this.armLapse()
    this.accessLog.write({ event: 'confirm', name: ask.name, detail: 'allowed' })
    this.changed()
    return { ok: true }
  }

  private deny(ask: PendingAsk, why: string): void {
    ask.state = 'denied'
    // The browser learns it at its next poll; until then (or the lapse) the request stays as denied.
    ask.expiresAt = this.now() + CONFIRM_COLLECT_MS
    this.armLapse()
    this.accessLog.write({ event: 'confirm', name: ask.name, detail: why })
    this.changed()
  }

  /** Drops the request once its time is up (checked on every use; the timer only tells the desktop sooner). */
  private lapse(): void {
    const ask = this.ask
    if (!ask || this.now() < ask.expiresAt) return
    if (ask.state === 'pending') this.accessLog.write({ event: 'confirm', name: ask.name, detail: 'not answered in time' })
    this.dropAsk()
  }

  private armLapse(): void {
    if (this.askTimer !== undefined) clearTimeout(this.askTimer)
    const ask = this.ask
    if (!ask) return
    this.askTimer = setTimeout(() => {
      this.askTimer = undefined
      this.lapse()
    }, Math.max(0, ask.expiresAt - this.now()) + 50)
    this.askTimer.unref?.()
  }

  private dropAsk(): void {
    if (this.askTimer !== undefined) clearTimeout(this.askTimer)
    this.askTimer = undefined
    if (!this.ask) return
    this.ask = undefined
    this.changed()
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
