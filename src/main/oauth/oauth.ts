// OAuth building blocks (design §6 "Plugin sign-ins and secrets"): the authorization code + PKCE
// flow through the system browser and a loopback redirect (RFC 8252), and token response checks.
// The plugin-facing `ctx.oauth` helper (plugin-oauth.ts) is built on these. The token exchange
// itself is in plugin-oauth.ts and follows these rules: POST form-encoded, `redirect: 'error'` (a
// redirect would re-send the code, refresh token and client secret to wherever it points), a
// timeout (FETCH_TIMEOUT_MS), a capped body (readLimited, MAX_TOKEN_RESPONSE_BYTES) and a
// validated response (parseTokenResponse). Error messages carry at most the provider's `error`
// code: never a token, a code, a secret or a response body.
//
// The loopback (`startLoopback`):
//   1. An HTTP server on 127.0.0.1, port 0 (the OS picks a free one). Never `localhost` (it may
//      resolve to ::1 or, via /etc/hosts, elsewhere) and never 0.0.0.0 (the LAN could reach it).
//      redirect_uri = http://127.0.0.1:<that port>/callback.
//   2. PKCE S256 (`pkcePair`; verifier: 32 random bytes, base64url = 43 chars) and a random
//      `state` are the caller's; the caller builds the auth URL and opens the browser.
//   3. The server answers exactly one request: GET /callback with the right `state` (compared in
//      constant time, `safeEqual`). Other paths, methods, hosts and wrong states get an error
//      status and are otherwise ignored, so a stray local request (any web page can make the
//      browser send one to 127.0.0.1) can neither finish nor abort the user's login. That one
//      request ends it: success, a provider error (`error=access_denied`), or a missing code. It
//      closes after that, after 5 minutes, or on cancel (`close()` or the abort signal). The page
//      it serves is fixed text: nothing from the query is reflected (no XSS in a page served
//      from 127.0.0.1).
//   4. In server mode (design-web.md §9.9) the person's browser is not on this machine, so the
//      redirect fails there and the person pastes the address it ended on: `Loopback.paste` runs
//      the same checks (`checkCallback`, shared with the HTTP handler) on that address and settles
//      the login in-process. No request is made, so a pasted address cannot point anything anywhere.
//
// No `electron` import: unit tests load this file in plain Node.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isPlainObject } from '../../shared/guards'

const CALLBACK_PATH = '/callback'
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
export const FETCH_TIMEOUT_MS = 15 * 1000
/** expires_in, when a provider leaves it out (RFC 6749 only recommends it). */
const DEFAULT_EXPIRES_IN_S = 3600
/** The longest expires_in accepted (seconds): a year. Beyond that the response is suspect. */
const MAX_EXPIRES_IN_S = 365 * 24 * 3600
/** Token endpoint responses are a few KiB; anything past this is refused unread. */
export const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024
/** The longest access or refresh token accepted (a JWT with many claims is a few KiB). */
export const MAX_TOKEN_LENGTH = 16 * 1024
const MAX_CODE_LENGTH = 4096
/** A provider's `error` code: short and plain, so it can go into a message. */
export const ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/

/** A failure of the OAuth flow. The message never holds a token, a code or a secret. */
export class OAuthError extends Error {
  override name = 'OAuthError'
  constructor(
    message: string,
    /** The provider's `error` code, when it gave a plain one (`invalid_grant`). */
    readonly code?: string
  ) {
    super(message)
  }
}

/** A validated token endpoint answer (parseTokenResponse). */
export interface TokenResponse {
  accessToken: string
  expiresIn: number
  refreshToken?: string
  /** The granted scopes, when the provider said (RFC 6749 §5.1: it must when they differ from the asked ones). */
  scope?: string[]
}

/** Bounds of the `scope` answer: it only informs the plugin, so a bad one is dropped, not an error. */
const MAX_SCOPE_LENGTH = 4096
const MAX_SCOPES = 100

/** base64url of `bytes` random bytes (a PKCE verifier, an OAuth `state`). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** PKCE (RFC 7636) S256: the verifier stays here, the challenge goes to the browser. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32)
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/**
 * Constant-time string equality. Both sides are hashed first, so the comparison takes the same
 * time whatever the lengths (timingSafeEqual itself throws on unequal lengths).
 */
export function safeEqual(a: string, b: string): boolean {
  const h = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest()
  return timingSafeEqual(h(a), h(b))
}

/** `raw` as an https URL, or an OAuthError naming `what` (never the URL: it may hold a secret). */
export function httpsUrl(raw: string, what: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OAuthError(`the ${what} is not a valid URL`)
  }
  if (url.username !== '' || url.password !== '') throw new OAuthError(`the ${what} must not hold credentials`)
  if (url.protocol === 'https:') return url
  throw new OAuthError(`the ${what} must be https`)
}

// ---------------------------------------------------------------------------------------------
// Loopback redirect server

export interface Loopback {
  /** `http://127.0.0.1:<port>/callback`, exactly what goes into the auth URL and the exchange. */
  redirectUri: string
  /** The authorization code, or an OAuthError (provider error, timeout, cancel). */
  code: Promise<string>
  /**
   * Settle the login with an address the person pasted (step 4): `checkCallback` on it, as the HTTP
   * handler does on a request. 'settled' when it ended the login (a code, or the provider's error),
   * 'refused' when it did not (a wrong origin, path or state; the login keeps waiting) or the login
   * is over. Never logs or returns the address.
   */
  paste(url: URL): 'settled' | 'refused'
  /** Stop waiting (the code promise rejects with `error`, "cancelled" by default, if still pending). */
  close(error?: OAuthError): void
}

export interface LoopbackOptions {
  state: string
  timeoutMs?: number
  signal?: AbortSignal
  log?: (message: string) => void
}

const PAGE_DONE =
  '<!doctype html><meta charset="utf-8"><title>cc-cockpit</title>' +
  '<p>Sign-in received. You can close this tab and return to cc-cockpit.</p>'
const PAGE_FAILED =
  '<!doctype html><meta charset="utf-8"><title>cc-cockpit</title>' +
  '<p>Sign-in did not complete. You can close this tab and try again in cc-cockpit.</p>'

/** A fixed response: no part of the request is echoed (see the header, step 3). */
function respond(res: ServerResponse, status: number, body: string, html = false): void {
  res.writeHead(status, {
    'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    Connection: 'close'
  })
  res.end(body)
}

/** The one value of `name` in `params`, or undefined when absent or repeated. */
function single(params: URLSearchParams, name: string): string | undefined {
  const all = params.getAll(name)
  return all.length === 1 ? all[0] : undefined
}

/**
 * What an address that came back to the loopback means for the login: the one set of checks for a
 * request to the HTTP server and for a pasted address (step 4).
 *   - `ignored`: not this login's answer (another origin, another path, a missing or wrong state); the
 *     login keeps waiting. `status` is the HTTP answer for a request.
 *   - `code`: the provider's code (one, non-empty, at most MAX_CODE_LENGTH).
 *   - `failed`: the provider's answer, ending the login: its `error` (named only when it matches
 *     ERROR_CODE) or no usable code.
 * `origin` is the loopback's own (`http://127.0.0.1:<port>`): checked here too, so a request line in
 * absolute form naming another host is not taken either. The state is compared in constant time.
 */
export type CallbackCheck =
  | { kind: 'ignored'; status: number; reason: 'origin' | 'path' | 'state' }
  | { kind: 'code'; code: string }
  | { kind: 'failed'; error: OAuthError; status: number }

export function checkCallback(url: URL, expected: { origin: string; state: string }): CallbackCheck {
  if (url.origin !== expected.origin) return { kind: 'ignored', status: 400, reason: 'origin' }
  if (url.pathname !== CALLBACK_PATH) return { kind: 'ignored', status: 404, reason: 'path' }
  const state = single(url.searchParams, 'state')
  if (state === undefined || !safeEqual(state, expected.state)) return { kind: 'ignored', status: 400, reason: 'state' }
  // From here the address is the provider's answer to this login: it ends the login.
  const error = url.searchParams.get('error')
  if (error !== null) {
    const known = ERROR_CODE.test(error) ? error : undefined
    const reason = known !== undefined ? ` (${known})` : ''
    return { kind: 'failed', status: 200, error: new OAuthError(`the provider refused the sign-in${reason}`, known) }
  }
  const value = single(url.searchParams, 'code')
  if (value === undefined || value === '' || value.length > MAX_CODE_LENGTH) {
    return { kind: 'failed', status: 400, error: new OAuthError('the provider sent no authorization code') }
  }
  return { kind: 'code', code: value }
}

/** Starts the loopback server; resolves once it listens (its port is then known). */
export async function startLoopback(options: LoopbackOptions): Promise<Loopback> {
  const log = options.log ?? (() => {})
  let settled = false
  let resolveCode!: (code: string) => void
  let rejectCode!: (err: Error) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // Rejections are observed by whoever awaits `code`; this keeps one nobody awaited (the login
  // failed earlier, e.g. openExternal) from surfacing as an unhandled rejection.
  code.catch(() => {})

  const server = createServer()
  let port = 0
  const origin = (): string => `http://127.0.0.1:${port}`
  let timer: ReturnType<typeof setTimeout> | undefined = undefined
  // Any web page can make the browser hit /callback?state=x in a loop for the whole login
  // window: the first one is logged, the rest only counted (one total line at shutdown).
  let wrongStates = 0

  const shutdown = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (wrongStates > 1) log(`oauth: ignored ${wrongStates} callback requests with a missing or wrong state in this sign-in`)
    options.signal?.removeEventListener('abort', onAbort)
    server.close()
    // A keep-alive browser connection would keep close() waiting (and the port bound).
    server.closeAllConnections()
  }
  const settle = (outcome: { code: string } | { error: OAuthError }, res?: ServerResponse): void => {
    if (settled) return
    settled = true
    if ('code' in outcome) resolveCode(outcome.code)
    else rejectCode(outcome.error)
    // Let the page reach the browser before the connection is cut. 'close', not 'finish': a
    // browser that drops the connection before the page is flushed never gets 'finish', and
    // with `settled` already set nothing else would shut down: the port stayed bound until quit.
    // 'close' also follows 'finish' on a normal answer.
    if (res && !res.closed) res.once('close', shutdown)
    else shutdown()
  }
  const onAbort = (): void => settle({ error: new OAuthError('sign-in was cancelled') })

  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (settled) return respond(res, 410, 'This sign-in is over.')
    // DNS rebinding: a page on evil.example rebound to 127.0.0.1 sends its own Host.
    if (req.headers.host !== `127.0.0.1:${port}`) return respond(res, 400, 'Bad request.')
    if (req.method !== 'GET') return respond(res, 405, 'Method not allowed.')
    let url: URL
    try {
      url = new URL(req.url ?? '/', origin())
    } catch {
      return respond(res, 400, 'Bad request.')
    }
    const check = checkCallback(url, { origin: origin(), state: options.state })
    if (check.kind === 'ignored') {
      if (check.reason === 'state' && ++wrongStates === 1) log('oauth: ignored a callback request with a missing or wrong state')
      return respond(res, check.status, check.status === 404 ? 'Not found.' : 'Bad request.')
    }
    if (check.kind === 'failed') {
      respond(res, check.status, PAGE_FAILED, true)
      return settle({ error: check.error }, res)
    }
    respond(res, 200, PAGE_DONE, true)
    settle({ code: check.code }, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  port = (server.address() as AddressInfo).port

  timer = setTimeout(
    () => settle({ error: new OAuthError('sign-in timed out (no answer from the browser within 5 minutes)') }),
    options.timeoutMs ?? LOGIN_TIMEOUT_MS
  )
  timer.unref?.()
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  return {
    redirectUri: `${origin()}${CALLBACK_PATH}`,
    code,
    paste: (url) => {
      if (settled) return 'refused'
      const check = checkCallback(url, { origin: origin(), state: options.state })
      if (check.kind === 'ignored') return 'refused'
      settle(check.kind === 'code' ? { code: check.code } : { error: check.error })
      return 'settled'
    },
    close: (error) => settle({ error: error ?? new OAuthError('sign-in was cancelled') })
  }
}

// ---------------------------------------------------------------------------------------------
// Token endpoint responses

/** Reads at most `limit` bytes of a response body; more is an error (the rest is not read). */
export async function readLimited(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    throw new OAuthError('the token endpoint sent an oversized response')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new OAuthError('the token endpoint sent an oversized response')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A validated successful token response (RFC 6749 §5.1). */
export function parseTokenResponse(body: unknown): TokenResponse {
  if (!isPlainObject(body)) throw new OAuthError('the token endpoint sent an invalid response')
  const { access_token: accessToken, token_type: tokenType, expires_in: rawExpires, refresh_token: refreshToken, scope: rawScope } = body
  if (typeof accessToken !== 'string' || accessToken === '' || accessToken.length > MAX_TOKEN_LENGTH) {
    throw new OAuthError('the token endpoint sent no usable access token')
  }
  // Only bearer tokens can be handed to a plugin as "the token" (a MAC/DPoP token needs more).
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    throw new OAuthError('the token endpoint sent a token that is not a bearer token')
  }
  let expiresIn = DEFAULT_EXPIRES_IN_S
  if (rawExpires !== undefined) {
    // Some providers (older Azure AD) send it as a string of digits.
    const n = typeof rawExpires === 'string' && /^\d{1,10}$/.test(rawExpires) ? Number(rawExpires) : rawExpires
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_EXPIRES_IN_S) {
      throw new OAuthError('the token endpoint sent an invalid expires_in')
    }
    expiresIn = n
  }
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken === '' || refreshToken.length > MAX_TOKEN_LENGTH)) {
    throw new OAuthError('the token endpoint sent an invalid refresh token')
  }
  const scope = parseScope(rawScope)
  return { accessToken, expiresIn, ...(refreshToken !== undefined ? { refreshToken } : {}), ...(scope ? { scope } : {}) }
}

/**
 * The granted scopes of a token response: space-separated (RFC 6749 §3.3). A plugin needs them to
 * tell whether the person granted a scope it added later (the Gmail plugin's move from readonly to
 * modify, 2026-11-03: Google lets the person untick a scope on the consent page). Absent, not a
 * string, too long or too many: undefined, and the plugin finds out from the API's 403 as before.
 */
function parseScope(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_SCOPE_LENGTH) return undefined
  const scopes = raw.split(/[ \t\n]+/).filter((s) => s !== '')
  if (scopes.length === 0 || scopes.length > MAX_SCOPES) return undefined
  return scopes
}
