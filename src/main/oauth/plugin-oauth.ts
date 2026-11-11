// `ctx.oauth` in main (design §6 "Plugin sign-ins and secrets"): the authorization code + PKCE
// sign-in a plugin asks for, and refreshing its access token. Built on the loopback, PKCE and
// token-response pieces of oauth.ts; host-api.ts in front of it checks which plugin asks, keeps
// one `authorize` per plugin at a time (a new one replaces the pending one) and 5 a minute, and aborts a pending one when the host stops.
//
// The plugin owns everything here: the client (id, secret), the URLs and, afterwards, the tokens
// (it stores them with ctx.secrets). Main keeps nothing between calls. What main adds is what a
// plugin host cannot do or should not get wrong:
//   - the system browser (Electron's shell, main only) and the loopback server on 127.0.0.1;
//   - the spec checked before any browser opens (`checkOAuthSpec`): both URLs https, always, with
//     no 127.0.0.1 exception (the e2e fake provider serves TLS with a test CA instead), no
//     user:password in them, bounded client id, secret and scopes;
//   - the token exchange: POST form-encoded, `redirect: 'error'` (a redirect would re-send the
//     code, refresh token and client secret to wherever it points), a timeout, a capped body, a
//     validated bearer token.
//
// Where the client secret may go: the secret and the URLs come from the same plugin, so the secret
// travels only in the POST body to the checked https token URL (no redirect followed), never into
// the auth URL the browser opens (browser history, the provider's access logs), and an auth URL
// that already names a `client_secret` parameter is refused rather than opened.
//
// Error messages carry at most the provider's `error` code (`invalid_grant`): never a token, a
// code, a client secret, a URL (it may hold a secret in its query) or a response body.
//
// Server mode (design-web.md §9.9): the loopback is on the server, so the provider's redirect fails
// in the person's browser. Each pending sign-in gets an id main mints, sent with the auth URL's link
// notice (the openExternal adapter puts it in `app.linkNotice` in server mode only); the notice has a
// box where the person pastes the address the tab ended on, and `paste` settles the sign-in with it
// in-process (`Loopback.paste`, the callback handler's own checks). The sign-in is looked up by that id
// among the caller's window's only (the window the router bound the view to, never the pasted host or
// port), so two plugins of one window waiting at once are told apart by it. MAX_PASTE_ATTEMPTS pastes
// the checks refuse end the sign-in (an unknown id, a non-string and an over-long text are refused
// unread and not counted: they never reach the checks, and none can settle a sign-in). Every refusal
// is the same `false` (the router answers OAUTH_PASTE_REFUSED), and nothing logged names the address.
// When a sign-in ends, however it ends, `onEnded` tells the window's browsers (`oauth.signInEnded`), so
// a notice whose sign-in is over says so instead of refusing every further paste alike.
//
// No `electron` import (main passes the openExternal adapter in): unit tests load this file in Node.
import { isPlainObject } from '../../shared/guards'
import { NO_BROWSER_TEXT, type OpenTarget } from '../external/open-external'
import type { OAuthTokens } from '../../sdk/types'
import {
  ERROR_CODE,
  FETCH_TIMEOUT_MS,
  httpsUrl,
  LOGIN_TIMEOUT_MS,
  MAX_TOKEN_LENGTH,
  MAX_TOKEN_RESPONSE_BYTES,
  OAuthError,
  parseTokenResponse,
  pkcePair,
  randomToken,
  readLimited,
  startLoopback,
  type Loopback,
  type TokenResponse
} from './oauth'
import { warnLog } from '../warn-log'
import { isSignInId, MAX_OAUTH_PASTE_LENGTH } from '../../shared/oauth-paste'

export const MAX_CLIENT_ID_LENGTH = 500
const MAX_CLIENT_SECRET_LENGTH = 4096
export const MAX_SCOPES = 50
/** A URL past this is not a provider endpoint (and would make the browser's address bar a payload). */
export const MAX_URL_LENGTH = 2048
/** RFC 6749 §3.3 scope-token: printable ASCII but space, `"` and `\` (scopes are space-joined). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,256}$/

/** A spec main has checked: fresh URL objects, only the known fields. */
export interface CheckedOAuthSpec {
  authUrl: URL
  tokenUrl: URL
  clientId: string
  clientSecret?: string
  scopes: string[]
}

/** `raw` as a bounded https URL; the message names `what`, never the URL. */
function endpoint(raw: unknown, what: string): URL {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) {
    throw new OAuthError(`the ${what} must be a string of at most ${MAX_URL_LENGTH} characters`)
  }
  return httpsUrl(raw, what)
}

/**
 * The plugin's spec (from the host, so untrusted in shape), checked field by field. Throws an
 * OAuthError that never echoes a value.
 */
export function checkOAuthSpec(spec: unknown): CheckedOAuthSpec {
  if (!isPlainObject(spec)) throw new OAuthError('the spec must be an object')
  const authUrl = endpoint(spec.authUrl, 'authorization URL')
  const tokenUrl = endpoint(spec.tokenUrl, 'token URL')
  // The browser shows and keeps this URL: a secret in it would leak (see the header).
  if (authUrl.searchParams.has('client_secret')) throw new OAuthError('the authorization URL must not hold a client_secret')
  const { clientId, clientSecret, scopes } = spec
  if (typeof clientId !== 'string' || clientId === '' || clientId.length > MAX_CLIENT_ID_LENGTH) {
    throw new OAuthError(`clientId must be a string of 1 to ${MAX_CLIENT_ID_LENGTH} characters`)
  }
  if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length > MAX_CLIENT_SECRET_LENGTH)) {
    throw new OAuthError(`clientSecret must be a string of at most ${MAX_CLIENT_SECRET_LENGTH} characters`)
  }
  if (!Array.isArray(scopes) || scopes.length > MAX_SCOPES) throw new OAuthError(`scopes must be an array of at most ${MAX_SCOPES}`)
  for (const s of scopes) {
    if (typeof s !== 'string' || !SCOPE_TOKEN.test(s)) {
      throw new OAuthError('each scope must be 1 to 256 printable ASCII characters with no space, quote or backslash')
    }
  }
  return {
    authUrl,
    tokenUrl,
    clientId,
    // An unset secret settings field reaches the plugin as undefined, a cleared text field as "".
    ...(typeof clientSecret === 'string' && clientSecret !== '' ? { clientSecret } : {}),
    scopes: [...(scopes as string[])]
  }
}

/** A refresh token from a plugin, checked like one from a provider (parseTokenResponse). */
export function checkRefreshToken(token: unknown): string {
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) {
    throw new OAuthError(`the refresh token must be a string of 1 to ${MAX_TOKEN_LENGTH} characters`)
  }
  return token
}

export interface PluginOAuthOptions {
  /**
   * Opens the auth URL for the window that asked (main: the openExternal adapter,
   * external/open-external.ts: the system browser on the desktop, a link notice in that window's
   * browsers in server mode, carrying `signIn` for the paste box).
   */
  openExternal(url: string, target: OpenTarget, extra: { signIn: string }): Promise<void>
  /**
   * The sign-in `signIn` (the id openExternal got) is over, any way it ended, for the same `target`:
   * `finished` when the redirect brought a code. Main sends `oauth.signInEnded` to the window's browsers
   * in server mode (index.ts). Called once per sign-in; a throw is ignored.
   */
  onEnded?(signIn: string, target: OpenTarget, finished: boolean): void
  fetch?: typeof fetch
  now?: () => number
  /** Test knobs (defaults LOGIN_TIMEOUT_MS, FETCH_TIMEOUT_MS). */
  loginTimeoutMs?: number
  fetchTimeoutMs?: number
  log?: (message: string) => void
}

/** What host-api.ts needs (a fake in its unit tests). */
export interface PluginOAuthApi {
  /** `target`: the calling host's window and origin view (main's, never the plugin's), where the auth URL goes. */
  authorize(spec: CheckedOAuthSpec, signal: AbortSignal, target: OpenTarget): Promise<OAuthTokens>
  refresh(spec: CheckedOAuthSpec, refreshToken: string, signal?: AbortSignal): Promise<OAuthTokens>
}

/** Refused pastes for one sign-in before it is ended (a typo or two, a wrong tab; never a guessing run). */
export const MAX_PASTE_ATTEMPTS = 5

/** A sign-in waiting for its redirect, as `paste` finds it. */
interface PendingSignIn {
  /** The window it is for; undefined for one tied to no window, which no paste can name. */
  windowId: number | undefined
  loopback: Loopback
  refused: number
  /** The auth URL, set as its notice goes out (before that the sign-in has no notice to replay). */
  url?: string
}

export class PluginOAuth implements PluginOAuthApi {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly log: (message: string) => void
  /** Sign-in id -> its pending sign-in, from the loopback's start to its end (any way it ends). */
  private readonly pending = new Map<string, PendingSignIn>()

  constructor(private readonly options: PluginOAuthOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.log = options.log ?? warnLog
  }

  /**
   * One sign-in: loopback up, browser opened on the auth URL, the code awaited (5 minutes at most),
   * exchanged. `signal` aborts it at any point: the loopback closes (a browser finishing late finds
   * nobody listening), a token request in flight is dropped, and the promise rejects.
   */
  async authorize(spec: CheckedOAuthSpec, signal: AbortSignal, target: OpenTarget): Promise<OAuthTokens> {
    const cancelled = (): OAuthError => new OAuthError('sign-in was cancelled')
    if (signal.aborted) throw cancelled()
    const { verifier, challenge } = pkcePair()
    const state = randomToken(32)
    const loopback = await startLoopback({ state, timeoutMs: this.options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS, signal, log: this.log })
    // Minted for every sign-in (the desktop's loopback never needs it, and main's router refuses a
    // paste there); random, so an id seen by one window says nothing about another's.
    const signIn = randomToken(16)
    this.pending.set(signIn, { windowId: target === 'app' ? undefined : target.windowId, loopback, refused: 0 })
    let code: string
    let finished = false
    try {
      // A copy: the checked spec's URL is not ours to change. set(), not append(): a parameter of
      // the same name in the plugin's URL is replaced, so the code cannot be redirected elsewhere.
      const authUrl = new URL(spec.authUrl)
      const params = authUrl.searchParams
      params.set('response_type', 'code')
      params.set('client_id', spec.clientId)
      params.set('redirect_uri', loopback.redirectUri)
      // No scopes: whatever the plugin's URL says (or the provider's default) stands.
      if (spec.scopes.length > 0) params.set('scope', spec.scopes.join(' '))
      params.set('state', state)
      params.set('code_challenge', challenge)
      params.set('code_challenge_method', 'S256')
      // Aborted while the loopback started listening: no browser.
      if (signal.aborted) throw cancelled()
      // Through a promise: a synchronous throw or a non-promise return of openExternal (a wrapper,
      // a test double) gets the same fixed message as a rejection, never its own text. The one
      // exception is server mode's own fixed refusal (no browser view attached): there is no system
      // browser on a server, so the general message would blame the wrong thing.
      const url = authUrl.toString()
      const entry = this.pending.get(signIn)
      if (entry) entry.url = url
      const opened = Promise.resolve()
        .then(() => this.options.openExternal(url, target, { signIn }))
        .catch((err: unknown) => {
          if (err instanceof Error && err.message === NO_BROWSER_TEXT) throw new OAuthError(NO_BROWSER_TEXT)
          throw new OAuthError('could not open the system browser for the sign-in')
        })
      // Raced with the code, never awaited alone: an openExternal that never settles would leave
      // the call deaf to the 5-minute timeout and to an abort (both reject loopback.code), and
      // host-api.ts would keep the plugin's sign-in slot taken until the next one replaced it. A
      // browser that comes back before openExternal settles finishes the sign-in as usual.
      code = await Promise.race([opened.then(() => loopback.code), loopback.code])
      finished = true
    } finally {
      this.pending.delete(signIn)
      loopback.close()
      try {
        this.options.onEnded?.(signIn, target, finished)
      } catch {
        // A notice left up is answered by the same refusal; the sign-in's own outcome stands.
      }
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: loopback.redirectUri,
      client_id: spec.clientId,
      code_verifier: verifier
    })
    if (spec.clientSecret !== undefined) body.set('client_secret', spec.clientSecret)
    try {
      return await this.exchange(spec.tokenUrl, body, signal)
    } catch (err) {
      // Aborted during the exchange: one message for every way a sign-in is cancelled.
      if (signal.aborted) throw cancelled()
      throw err
    }
  }

  /**
   * The window's sign-ins still waiting whose notice went out (`ready`'s `signIns`, server mode): a
   * view joining, or a shell remounted by a reconnect, gets its paste box back while main would still
   * settle the sign-in. Only a window's own (`windowId`, main's binding of the view): one tied to no
   * window cannot be pasted into from any view (`paste`). Oldest first.
   */
  pendingFor(windowId: number): Array<{ url: string; signIn: string }> {
    const out: Array<{ url: string; signIn: string }> = []
    for (const [signIn, entry] of this.pending) {
      if (entry.windowId === windowId && entry.url !== undefined) out.push({ url: entry.url, signIn })
    }
    return out
  }

  /**
   * The person pasted the address a sign-in's redirect ended on (server mode, see the header). True
   * when it settled the sign-in `signIn` of `windowId` (main's binding of the caller, never the
   * payload): a code, which `authorize` then exchanges, or the provider's refusal. False for every
   * other case alike: not a string, too long, not an address, an unknown id, another window's, a
   * sign-in already over, or an address the checks refuse. Only the last counts (the rest never reach
   * the checks), and the MAX_PASTE_ATTEMPTS-th one ends the sign-in.
   */
  paste(windowId: number, signIn: unknown, text: unknown): boolean {
    if (!isSignInId(signIn) || typeof text !== 'string' || text.length > MAX_OAUTH_PASTE_LENGTH) return false
    const entry = this.pending.get(signIn)
    if (entry === undefined || entry.windowId !== windowId) return false
    let url: URL | undefined
    try {
      url = new URL(text.trim())
    } catch {
      url = undefined
    }
    if (url !== undefined && entry.loopback.paste(url) === 'settled') {
      this.pending.delete(signIn)
      return true
    }
    entry.refused++
    // Counted, never the address: it may carry a code meant for this sign-in, typed in the wrong box.
    this.log(`oauth: refused a pasted sign-in address (${entry.refused} of ${MAX_PASTE_ATTEMPTS})`)
    if (entry.refused >= MAX_PASTE_ATTEMPTS) {
      this.pending.delete(signIn)
      entry.loopback.close(new OAuthError(`sign-in ended after ${MAX_PASTE_ATTEMPTS} pasted addresses that did not finish it`))
    }
    return false
  }

  /** A fresh access token for `refreshToken`. No scope is sent: the grant keeps its own. */
  async refresh(spec: CheckedOAuthSpec, refreshToken: string, signal?: AbortSignal): Promise<OAuthTokens> {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: spec.clientId })
    if (spec.clientSecret !== undefined) body.set('client_secret', spec.clientSecret)
    return this.exchange(spec.tokenUrl, body, signal)
  }

  /** POST, then the plugin's view of the answer. */
  private async exchange(url: URL, body: URLSearchParams, signal?: AbortSignal): Promise<OAuthTokens> {
    // expires_in counts from when the provider issued the token, somewhere between sending the
    // request and its answer: count from the send, never later.
    const sentAt = this.now()
    const tokens = await this.post(url, body, signal)
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: sentAt + tokens.expiresIn * 1000,
      ...(tokens.scope ? { scope: tokens.scope } : {})
    }
  }

  /** POST to the token endpoint; the validated tokens or an OAuthError (with the provider's code). */
  private async post(url: URL, body: URLSearchParams, signal?: AbortSignal): Promise<TokenResponse> {
    const timeout = AbortSignal.timeout(this.options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        redirect: 'error',
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout
      })
    } catch {
      if (signal?.aborted) throw new OAuthError('the token request was cancelled')
      throw new OAuthError(timeout.aborted ? 'the token endpoint did not answer in time' : 'the token endpoint could not be reached')
    }
    // The timeout covers the body too: a stall or a dropped connection while reading is reported
    // as such, not as a body that is not JSON.
    let text: string
    try {
      text = await readLimited(res, MAX_TOKEN_RESPONSE_BYTES)
    } catch (err) {
      if (err instanceof OAuthError) throw err
      if (signal?.aborted) throw new OAuthError('the token request was cancelled')
      throw new OAuthError(timeout.aborted ? 'the token endpoint did not answer in time' : 'the token endpoint response could not be read')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    // Some providers (GitHub) answer errors with 200 and an `error` field.
    const errorCode = isPlainObject(parsed) && typeof parsed.error === 'string' && ERROR_CODE.test(parsed.error) ? parsed.error : undefined
    if (!res.ok || (isPlainObject(parsed) && parsed.error !== undefined)) {
      const detail = errorCode !== undefined ? ` (${errorCode})` : ''
      throw new OAuthError(`the token endpoint refused the request: HTTP ${res.status}${detail}`, errorCode)
    }
    if (parsed === undefined) throw new OAuthError('the token endpoint sent a response that is not JSON')
    return parseTokenResponse(parsed)
  }
}
