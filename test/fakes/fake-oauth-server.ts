// A fake OAuth 2.0 provider for ctx.oauth (test/unit/plugin-oauth.test.ts over plain http,
// test/e2e/plugin-oauth.spec.ts over https). Real HTTP on 127.0.0.1 (port 0), nothing leaves the machine:
//   - `authorize(authUrl)` plays the provider's consent page: it reads the URL the app handed to
//     `openExternal`, remembers the PKCE challenge and redirect_uri, mints a code and returns the
//     redirect the browser would follow. `browse(authUrl)` also follows it, like the browser.
//   - POST /token checks what a real provider checks (code, S256(code_verifier) = challenge,
//     redirect_uri, client id and secret, refresh token) and answers with scriptable tokens.
//   - `tls`: serve over https instead. The e2e needs it: `ctx.oauth` URLs must be https with no
//     loopback exception; the e2e trusts a throwaway certificate via NODE_EXTRA_CA_CERTS.
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

export interface FakeOAuthOptions {
  clientId?: string
  /** When set, /token requires it as `client_secret`. */
  clientSecret?: string
  /** Serve over https with this PEM key and certificate (its SAN must name IP 127.0.0.1). */
  tls?: { key: string; cert: string }
}

interface IssuedCode {
  challenge: string
  method: string
  redirectUri: string
  clientId: string
}

export class FakeOAuthServer {
  readonly clientId: string
  readonly clientSecret: string | undefined
  /** Every /token request body, in order. */
  readonly tokenRequests: Record<string, string>[] = []
  /** The last auth URL `authorize` saw, parsed. */
  lastAuthorize: URL | undefined
  /** Refresh tokens that work (rotation removes the old one). */
  readonly validRefreshTokens = new Set<string>()
  /** Rotate the refresh token on every refresh. */
  rotate = false
  /** Answer the next /token requests with `invalid_grant`. */
  invalidGrant = false
  /** Leave the refresh token out of the code exchange. */
  omitRefreshToken = false
  /** Delay every /token answer (single-flight and timeout tests). */
  delayMs = 0
  expiresIn: number | string | undefined = 3600
  tokenType = 'Bearer'
  /** The `scope` the /token answer carries (the granted scopes); undefined: none sent. */
  scope: string | undefined = undefined
  /** Replace the /token answer altogether (status, body, extra headers such as Location). */
  override: { status: number; body: string; headers?: Record<string, string> } | undefined

  private readonly tls: { key: string; cert: string } | undefined
  private server: Server | HttpsServer | undefined
  private port = 0
  private counter = 0
  private readonly codes = new Map<string, IssuedCode>()

  constructor(options: FakeOAuthOptions = {}) {
    this.clientId = options.clientId ?? 'fake-client'
    this.clientSecret = options.clientSecret
    this.tls = options.tls
  }

  get authUrl(): string {
    // The auth page is never fetched (authorize() stands in for it); https like a real one.
    return 'https://auth.fake.test/authorize?access_type=offline&prompt=consent'
  }

  get tokenUrl(): string {
    return `${this.tls ? 'https' : 'http'}://127.0.0.1:${this.port}/token`
  }

  get refreshCalls(): number {
    return this.tokenRequests.filter((r) => r.grant_type === 'refresh_token').length
  }

  async start(): Promise<this> {
    const handler = (req: IncomingMessage, res: ServerResponse): void => void this.handle(req, res)
    this.server = this.tls ? createHttpsServer(this.tls, handler) : createServer(handler)
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as AddressInfo).port
    return this
  }

  async stop(): Promise<void> {
    if (!this.server) return
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  /** The redirect the provider would send the browser to after consent. */
  authorize(authUrl: string, override: { state?: string; error?: string } = {}): string {
    const url = new URL(authUrl)
    this.lastAuthorize = url
    const p = url.searchParams
    const redirect = new URL(p.get('redirect_uri') ?? '')
    if (override.error !== undefined) {
      redirect.searchParams.set('error', override.error)
    } else {
      const code = `code-${++this.counter}`
      this.codes.set(code, {
        challenge: p.get('code_challenge') ?? '',
        method: p.get('code_challenge_method') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        clientId: p.get('client_id') ?? ''
      })
      redirect.searchParams.set('code', code)
    }
    redirect.searchParams.set('state', override.state ?? p.get('state') ?? '')
    return redirect.toString()
  }

  /** authorize() and follow the redirect like a browser; resolves with the loopback's answer. */
  async browse(authUrl: string, override: { state?: string; error?: string } = {}): Promise<{ status: number; body: string }> {
    const res = await fetch(this.authorize(authUrl, override))
    return { status: res.status, body: await res.text() }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
    if (req.method !== 'POST' || req.url !== '/token') return this.send(res, 404, { error: 'not_found' })
    this.tokenRequests.push(body)
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.override) {
      res.writeHead(this.override.status, { 'Content-Type': 'application/json', ...this.override.headers })
      res.end(this.override.body)
      return
    }
    if (this.invalidGrant) return this.send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    if (body.client_id !== this.clientId) return this.send(res, 401, { error: 'invalid_client' })
    if (this.clientSecret !== undefined && body.client_secret !== this.clientSecret) return this.send(res, 401, { error: 'invalid_client' })
    if (body.grant_type === 'authorization_code') {
      const issued = this.codes.get(body.code ?? '')
      this.codes.delete(body.code ?? '')
      const s256 = createHash('sha256').update(body.code_verifier ?? '').digest('base64url')
      if (!issued || issued.method !== 'S256' || issued.challenge !== s256 || issued.redirectUri !== body.redirect_uri || issued.clientId !== body.client_id) {
        return this.send(res, 400, { error: 'invalid_grant' })
      }
      const refresh = `refresh-${++this.counter}`
      this.validRefreshTokens.add(refresh)
      return this.send(res, 200, this.tokens(this.omitRefreshToken ? undefined : refresh))
    }
    if (body.grant_type === 'refresh_token') {
      const old = body.refresh_token ?? ''
      if (!this.validRefreshTokens.has(old)) return this.send(res, 400, { error: 'invalid_grant' })
      let next: string | undefined
      if (this.rotate) {
        this.validRefreshTokens.delete(old)
        next = `refresh-${++this.counter}`
        this.validRefreshTokens.add(next)
      }
      return this.send(res, 200, this.tokens(next))
    }
    return this.send(res, 400, { error: 'unsupported_grant_type' })
  }

  private tokens(refreshToken: string | undefined): Record<string, unknown> {
    return {
      access_token: `access-${++this.counter}`,
      token_type: this.tokenType,
      ...(this.expiresIn !== undefined ? { expires_in: this.expiresIn } : {}),
      ...(refreshToken !== undefined ? { refresh_token: refreshToken } : {}),
      ...(this.scope !== undefined ? { scope: this.scope } : {})
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}
