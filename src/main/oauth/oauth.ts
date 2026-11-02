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
}

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
  /** Stop waiting (the code promise rejects with "cancelled" if still pending). */
  close(): void
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
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    } catch {
      return respond(res, 400, 'Bad request.')
    }
    if (url.pathname !== CALLBACK_PATH) return respond(res, 404, 'Not found.')
    const state = single(url.searchParams, 'state')
    if (state === undefined || !safeEqual(state, options.state)) {
      if (++wrongStates === 1) log('oauth: ignored a callback request with a missing or wrong state')
      return respond(res, 400, 'Bad request.')
    }
    // From here the request is the provider's answer to this login: it ends the login.
    const error = url.searchParams.get('error')
    if (error !== null) {
      const reason = ERROR_CODE.test(error) ? ` (${error})` : ''
      respond(res, 200, PAGE_FAILED, true)
      return settle({ error: new OAuthError(`the provider refused the sign-in${reason}`, ERROR_CODE.test(error) ? error : undefined) }, res)
    }
    const value = single(url.searchParams, 'code')
    if (value === undefined || value === '' || value.length > MAX_CODE_LENGTH) {
      respond(res, 400, PAGE_FAILED, true)
      return settle({ error: new OAuthError('the provider sent no authorization code') }, res)
    }
    respond(res, 200, PAGE_DONE, true)
    settle({ code: value }, res)
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
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    code,
    close: () => settle({ error: new OAuthError('sign-in was cancelled') })
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
  const { access_token: accessToken, token_type: tokenType, expires_in: rawExpires, refresh_token: refreshToken } = body
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
  return { accessToken, expiresIn, ...(refreshToken !== undefined ? { refreshToken } : {}) }
}
