// ctx.oauth in main (src/main/oauth/plugin-oauth.ts, and its requests in host-api.ts): the spec
// checks, a whole sign-in against test/fakes/fake-oauth-server.ts (the test plays the browser:
// openExternal records the URL, the fake mints the code and the redirect is followed to the real
// loopback on 127.0.0.1), the token exchange's refusals, refresh, and HostApi's one-at-a-time,
// 5-a-minute and abort-on-stop rules. Spec URLs are https, as main requires; an injected fetch
// sends them to the fake's plain-http port, so redirects and oversized bodies are real responses.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { PluginLoader } from '../../src/host/loader'
import { MAX_TOKEN_RESPONSE_BYTES, OAuthError } from '../../src/main/oauth/oauth'
import {
  checkOAuthSpec,
  checkRefreshToken,
  MAX_CLIENT_ID_LENGTH,
  MAX_SCOPES,
  PluginOAuth,
  type CheckedOAuthSpec,
  type PluginOAuthApi,
  type PluginOAuthOptions
} from '../../src/main/oauth/plugin-oauth'
import {
  AUTHORIZE_WINDOW_MS,
  HostApi,
  MAX_AUTHORIZES_PER_WINDOW,
  MAX_REFRESHES_IN_FLIGHT,
  type HostApiDeps
} from '../../src/main/plugins/host-api'
import type { OAuthTokens, PluginContext } from '../../src/sdk/types'
import { errorText } from '../../src/shared/error-text'
import { FakeOAuthServer } from '../fakes/fake-oauth-server'
import { hostSpec } from '../fakes/host-spec'
import { unusedSecrets } from '../fakes/unused-host-services'

const CLIENT_ID = 'unit-client'
const CLIENT_SECRET = 'unit-client-secret-91c4'

let server: FakeOAuthServer
/** What openExternal was handed, oldest first. */
let opened: string[]
/** Called with each URL openExternal gets (default: nothing; a test plays the browser itself). */
let onOpen: (url: string) => void

/** The fake's token endpoint as main must see it: https (the injected fetch makes it http). */
const httpsTokenUrl = (): string => server.tokenUrl.replace(/^http:/, 'https:')

/** fetch for the spec's https URL, sent to the fake's plain-http port with the same options. */
const toFake: typeof fetch = (input, init) => fetch(String(input instanceof Request ? input.url : input).replace(/^https:/, 'http:'), init)

function oauthWith(options: Partial<PluginOAuthOptions> = {}): PluginOAuth {
  return new PluginOAuth({
    openExternal: async (url) => {
      opened.push(url)
      onOpen(url)
    },
    fetch: toFake,
    log: () => {},
    ...options
  })
}

function spec(over: Record<string, unknown> = {}): CheckedOAuthSpec {
  return checkOAuthSpec({
    authUrl: server.authUrl,
    tokenUrl: httpsTokenUrl(),
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: ['read', 'mail.send'],
    ...over
  })
}

/** The error `p` rejects with (fails the test if it resolves). */
async function failure(p: Promise<unknown>): Promise<OAuthError> {
  const outcome = await p.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!(outcome instanceof OAuthError)) throw new Error('expected an OAuthError rejection')
  return outcome
}

/** Play the browser for the next authorize: consent (or `override`), then follow the redirect. */
function browseOnOpen(override: { state?: string; error?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    onOpen = (url) => void server.browse(url, override).then(resolve, reject)
  })
}

beforeEach(async () => {
  server = await new FakeOAuthServer({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }).start()
  opened = []
  onOpen = () => {}
})

afterEach(async () => {
  await server.stop()
})

describe('checkOAuthSpec', () => {
  const base = { authUrl: 'https://auth.example/authorize', tokenUrl: 'https://auth.example/token', clientId: 'c', scopes: ['a'] }

  it('keeps the known fields, copies the scopes and drops an empty client secret', () => {
    const scopes = ['openid', 'https://www.googleapis.com/auth/gmail.readonly']
    const checked = checkOAuthSpec({ ...base, scopes, clientSecret: '', extra: 'ignored' })
    expect(checked.authUrl.toString()).toBe('https://auth.example/authorize')
    expect(checked.tokenUrl.toString()).toBe('https://auth.example/token')
    expect(checked).not.toHaveProperty('clientSecret')
    expect(checked).not.toHaveProperty('extra')
    expect(checked.scopes).toEqual(scopes)
    expect(checked.scopes).not.toBe(scopes)
    expect(checkOAuthSpec({ ...base, clientSecret: 's' }).clientSecret).toBe('s')
    expect(checkOAuthSpec({ ...base, scopes: [] }).scopes).toEqual([])
  })

  it('refuses non-https URLs (127.0.0.1 too), credentials and over-long URLs, without echoing them', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ authUrl: 'http://auth.example/authorize' }, 'authorization URL must be https'],
      [{ tokenUrl: 'http://127.0.0.1:9999/token' }, 'token URL must be https'],
      [{ tokenUrl: 'https://user:hunter2@auth.example/token' }, 'must not hold credentials'],
      [{ tokenUrl: 'not a url hunter2' }, 'not a valid URL'],
      [{ authUrl: 42 }, 'must be a string'],
      [{ authUrl: `https://auth.example/${'x'.repeat(2100)}` }, 'at most 2048'],
      [{ authUrl: 'https://auth.example/authorize?client_secret=hunter2' }, 'must not hold a client_secret']
    ]
    for (const [over, message] of cases) {
      let caught: unknown
      try {
        checkOAuthSpec({ ...base, ...over })
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(OAuthError)
      expect((caught as Error).message).toContain(message)
      expect((caught as Error).message).not.toContain('hunter2')
    }
  })

  it('refuses a bad client id, client secret or scope list', () => {
    const bad: Record<string, unknown>[] = [
      { clientId: '' },
      { clientId: 'x'.repeat(MAX_CLIENT_ID_LENGTH + 1) },
      { clientId: 7 },
      { clientSecret: 7 },
      { clientSecret: 'x'.repeat(4097) },
      { scopes: 'read' },
      { scopes: Array.from({ length: MAX_SCOPES + 1 }, (_, i) => `s${i}`) },
      { scopes: ['two words'] },
      { scopes: [''] },
      { scopes: ['quo"te'] },
      { scopes: ['x'.repeat(257)] },
      { scopes: [3] }
    ]
    for (const over of bad) expect(() => checkOAuthSpec({ ...base, ...over }), JSON.stringify(over).slice(0, 80)).toThrow(OAuthError)
    expect(() => checkOAuthSpec(null)).toThrow('the spec must be an object')
    expect(() => checkOAuthSpec(['x'])).toThrow('the spec must be an object')
  })

  it('checkRefreshToken takes a bounded non-empty string', () => {
    expect(checkRefreshToken('r-1')).toBe('r-1')
    for (const bad of ['', 'x'.repeat(16 * 1024 + 1), undefined, 5]) expect(() => checkRefreshToken(bad)).toThrow(OAuthError)
  })
})

describe('PluginOAuth.authorize', () => {
  it('signs in: browser on the plugin auth URL with PKCE and a loopback redirect, code exchanged with the client secret', async () => {
    const now = vi.fn(() => 1_000_000)
    const landing = browseOnOpen()
    const tokens = await oauthWith({ now }).authorize(spec(), new AbortController().signal)
    expect((await landing).status).toBe(200)
    expect(tokens).toEqual({ accessToken: expect.stringMatching(/^access-/), refreshToken: expect.stringMatching(/^refresh-/), expiresAt: 1_000_000 + 3600 * 1000 })
    expect(server.validRefreshTokens.has(tokens.refreshToken!)).toBe(true)

    expect(opened).toHaveLength(1)
    const url = new URL(opened[0]!)
    expect(url.origin + url.pathname).toBe('https://auth.fake.test/authorize')
    // The plugin's own query is kept; main's parameters are set.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('scope')).toBe('read mail.send')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // The secret goes only to the token endpoint, never into the browser.
    expect(opened[0]).not.toContain(CLIENT_SECRET)

    // The fake checked the verifier against the challenge, the redirect_uri, the id and the secret.
    expect(server.tokenRequests).toHaveLength(1)
    expect(server.tokenRequests[0]).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
    expect(server.tokenRequests[0]!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)

    // The loopback is closed after the one answer.
    await expect(fetch(url.searchParams.get('redirect_uri')!)).rejects.toThrow()
  })

  it('replaces auth URL parameters of the same name, leaves scope alone with no scopes, and sends no secret without one', async () => {
    const noSecret = await new FakeOAuthServer({ clientId: CLIENT_ID }).start()
    try {
      onOpen = (u) => void noSecret.browse(u)
      const s = checkOAuthSpec({
        authUrl: 'https://auth.fake.test/authorize?client_id=evil&redirect_uri=https://evil.example/&scope=keep',
        tokenUrl: noSecret.tokenUrl.replace(/^http:/, 'https:'),
        clientId: CLIENT_ID,
        scopes: []
      })
      const tokens = await oauthWith().authorize(s, new AbortController().signal)
      expect(tokens.accessToken).toMatch(/^access-/)
      const url = new URL(opened[0]!)
      expect(url.searchParams.getAll('client_id')).toEqual([CLIENT_ID])
      expect(url.searchParams.getAll('redirect_uri')).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:/)])
      expect(url.searchParams.get('scope')).toBe('keep')
      expect(noSecret.tokenRequests[0]).not.toHaveProperty('client_secret')
    } finally {
      await noSecret.stop()
    }
  })

  it('returns a null refresh token when the provider sends none', async () => {
    server.omitRefreshToken = true
    void browseOnOpen()
    const tokens = await oauthWith().authorize(spec(), new AbortController().signal)
    expect(tokens.refreshToken).toBeNull()
  })

  it('rejects when the user cancels at the provider (error=access_denied)', async () => {
    void browseOnOpen({ error: 'access_denied' })
    await expect(oauthWith().authorize(spec(), new AbortController().signal)).rejects.toThrow('the provider refused the sign-in (access_denied)')
    expect(server.tokenRequests).toEqual([])
  })

  it('times out when the browser never comes back, and closes the loopback', async () => {
    await expect(oauthWith({ loginTimeoutMs: 50 }).authorize(spec(), new AbortController().signal)).rejects.toThrow('timed out')
    await expect(server.browse(opened[0]!)).rejects.toThrow()
    expect(server.tokenRequests).toEqual([])
  })

  it('ignores a redirect with the wrong state: the sign-in keeps waiting, then the right one finishes it', async () => {
    const pending = oauthWith().authorize(spec(), new AbortController().signal)
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    const wrong = await server.browse(opened[0]!, { state: 'not-the-state' })
    expect(wrong.status).toBe(400)
    expect(server.tokenRequests).toEqual([])
    expect((await server.browse(opened[0]!)).status).toBe(200)
    await expect(pending).resolves.toMatchObject({ accessToken: expect.stringMatching(/^access-/) })
  })

  it('aborted before the browser opens: no browser, no listener left', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(oauthWith().authorize(spec(), controller.signal)).rejects.toThrow('sign-in was cancelled')
    expect(opened).toEqual([])
  })

  it('aborted while waiting for the browser: rejects and the loopback is gone', async () => {
    const controller = new AbortController()
    const pending = oauthWith().authorize(spec(), controller.signal)
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toThrow('sign-in was cancelled')
    await expect(server.browse(opened[0]!)).rejects.toThrow()
    expect(server.tokenRequests).toEqual([])
  })

  it('aborted during the code exchange: the token request is dropped', async () => {
    server.delayMs = 2000
    const controller = new AbortController()
    void browseOnOpen()
    const pending = oauthWith().authorize(spec(), controller.signal)
    await vi.waitFor(() => expect(server.tokenRequests).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toThrow('sign-in was cancelled')
  })

  it('a browser that cannot be opened fails the sign-in and closes the loopback', async () => {
    let redirect = ''
    const oauth = oauthWith({
      openExternal: async (url) => {
        redirect = new URL(url).searchParams.get('redirect_uri')!
        throw new Error('no browser')
      }
    })
    await expect(oauth.authorize(spec(), new AbortController().signal)).rejects.toThrow('could not open the system browser')
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('a browser call that throws synchronously gets the same fixed message, not its own', async () => {
    let redirect = ''
    const oauth = oauthWith({
      openExternal: (url) => {
        redirect = new URL(url).searchParams.get('redirect_uri')!
        throw new Error('raw sync failure')
      }
    })
    const pending = oauth.authorize(spec(), new AbortController().signal)
    await expect(pending).rejects.toThrow('could not open the system browser')
    await expect(pending).rejects.not.toThrow('raw sync failure')
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('a browser call that never settles still times out and still aborts, closing the loopback', async () => {
    let redirect = ''
    const openExternal = (url: string): Promise<void> => {
      redirect = new URL(url).searchParams.get('redirect_uri')!
      return new Promise<void>(() => {})
    }
    await expect(oauthWith({ openExternal, loginTimeoutMs: 50 }).authorize(spec(), new AbortController().signal)).rejects.toThrow('timed out')
    await expect(fetch(redirect)).rejects.toThrow()
    const controller = new AbortController()
    const pending = oauthWith({ openExternal }).authorize(spec(), controller.signal)
    await vi.waitFor(() => expect(redirect).not.toBe(''))
    const second = redirect
    controller.abort()
    await expect(pending).rejects.toThrow('sign-in was cancelled')
    await expect(fetch(second)).rejects.toThrow()
  })

  it('a browser that comes back before the browser call settles finishes the sign-in', async () => {
    const oauth = oauthWith({
      openExternal: (url) => {
        void server.browse(url)
        return new Promise<void>(() => {})
      }
    })
    await expect(oauth.authorize(spec(), new AbortController().signal)).resolves.toMatchObject({ accessToken: expect.stringMatching(/^access-/) })
  })

  it('refuses an oversized token response without echoing it (the streamed case: oauth.test.ts readLimited)', async () => {
    const big = JSON.stringify({ access_token: 'x'.repeat(MAX_TOKEN_RESPONSE_BYTES), token_type: 'Bearer' })
    server.override = { status: 200, body: big }
    void browseOnOpen()
    const err = await failure(oauthWith().authorize(spec(), new AbortController().signal))
    expect(err.message).toBe('the token endpoint sent an oversized response')
  })

  it('refuses to follow a redirect from the token endpoint (the code and secret are not re-sent)', async () => {
    server.override = { status: 307, body: '{}', headers: { Location: server.tokenUrl } }
    void browseOnOpen()
    await expect(oauthWith().authorize(spec(), new AbortController().signal)).rejects.toThrow('the token endpoint could not be reached')
    // One request only: a followed redirect would have reached the fake's /token a second time.
    expect(server.tokenRequests).toHaveLength(1)
  })

  it('names the provider error code but never the response body, code or secret', async () => {
    server.invalidGrant = true
    void browseOnOpen()
    const err = await failure(oauthWith().authorize(spec(), new AbortController().signal))
    expect(err.message).toBe('the token endpoint refused the request: HTTP 400 (invalid_grant)')
    expect(err.code).toBe('invalid_grant')
    expect(err.message).not.toContain('expired or revoked')
    expect(err.message).not.toContain(CLIENT_SECRET)
  })

  it('refuses a token that is not bearer, and a token endpoint that does not answer in time', async () => {
    server.tokenType = 'mac'
    void browseOnOpen()
    await expect(oauthWith().authorize(spec(), new AbortController().signal)).rejects.toThrow('not a bearer token')
    server.tokenType = 'Bearer'
    server.delayMs = 500
    void browseOnOpen()
    await expect(oauthWith({ fetchTimeoutMs: 50 }).authorize(spec(), new AbortController().signal)).rejects.toThrow('did not answer in time')
  })
})

describe('PluginOAuth.refresh', () => {
  async function signedIn(): Promise<OAuthTokens> {
    void browseOnOpen()
    return oauthWith().authorize(spec(), new AbortController().signal)
  }

  it('gets a fresh access token; null refresh token when the provider does not rotate', async () => {
    const first = await signedIn()
    const now = vi.fn(() => 5_000)
    const next = await oauthWith({ now }).refresh(spec(), first.refreshToken!)
    expect(next.accessToken).not.toBe(first.accessToken)
    expect(next).toMatchObject({ refreshToken: null, expiresAt: 5_000 + 3600 * 1000 })
    expect(server.tokenRequests.at(-1)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: first.refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
    expect(opened).toHaveLength(1)
  })

  it('returns the rotated refresh token', async () => {
    const first = await signedIn()
    server.rotate = true
    const next = await oauthWith().refresh(spec(), first.refreshToken!)
    expect(next.refreshToken).toMatch(/^refresh-/)
    expect(next.refreshToken).not.toBe(first.refreshToken)
    expect(server.validRefreshTokens.has(first.refreshToken!)).toBe(false)
  })

  it('fails with invalid_grant for a revoked token, and on an error answered with 200 (GitHub)', async () => {
    const err = await failure(oauthWith().refresh(spec(), 'refresh-unknown'))
    expect(err.code).toBe('invalid_grant')
    expect(err.message).not.toContain('refresh-unknown')
    server.override = { status: 200, body: JSON.stringify({ error: 'bad_verification_code' }) }
    await expect(oauthWith().refresh(spec(), 'r')).rejects.toThrow('HTTP 200 (bad_verification_code)')
    server.override = { status: 200, body: 'not json' }
    await expect(oauthWith().refresh(spec(), 'r')).rejects.toThrow('not JSON')
  })

  it('a body that stalls or breaks off is reported as such, not as a body that is not JSON', async () => {
    // Headers arrive at once; the body stalls until the request's signal (the fetch timeout) fires.
    const stalled: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"access_'))
            init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason), { once: true })
          }
        }),
        { status: 200 }
      )
    await expect(oauthWith({ fetch: stalled, fetchTimeoutMs: 50 }).refresh(spec(), 'r')).rejects.toThrow('the token endpoint did not answer in time')
    const broken: typeof fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"access_'))
            c.error(new Error('socket hang up'))
          }
        }),
        { status: 200 }
      )
    await expect(oauthWith({ fetch: broken }).refresh(spec(), 'r')).rejects.toThrow('the token endpoint response could not be read')
  })

  it('an aborted refresh is dropped', async () => {
    server.delayMs = 2000
    const controller = new AbortController()
    const pending = oauthWith().refresh(spec(), 'r', controller.signal)
    await vi.waitFor(() => expect(server.tokenRequests).toHaveLength(1))
    controller.abort()
    await expect(pending).rejects.toThrow('the token request was cancelled')
  })
})

// ---------------------------------------------------------------------------------------------
// HostApi: who may ask, how often, and what stops a pending sign-in.

const PLUGIN = 'a.one'
const OTHER = 'a.two'
const RAW_SPEC = { authUrl: 'https://auth.example/authorize', tokenUrl: 'https://auth.example/token', clientId: 'c', scopes: ['read'] }

/** A fake PluginOAuth: each authorize waits until the test settles it or its signal aborts. */
class FakeOAuth implements PluginOAuthApi {
  readonly authorizes: { spec: CheckedOAuthSpec; signal: AbortSignal; resolve(t: OAuthTokens): void }[] = []
  readonly refreshes: { token: string; signal: AbortSignal | undefined; resolve(t: OAuthTokens): void }[] = []

  authorize(spec: CheckedOAuthSpec, signal: AbortSignal): Promise<OAuthTokens> {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new OAuthError('sign-in was cancelled')), { once: true })
      this.authorizes.push({ spec, signal, resolve })
    })
  }

  refresh(_spec: CheckedOAuthSpec, token: string, signal?: AbortSignal): Promise<OAuthTokens> {
    return new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new OAuthError('the token request was cancelled')), { once: true })
      this.refreshes.push({ token, signal, resolve })
    })
  }
}

const TOKENS: OAuthTokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 }

describe('HostApi oauth requests', () => {
  let fake: FakeOAuth
  let api: HostApi

  function makeApi(oauth: PluginOAuthApi = fake): HostApi {
    const deps: HostApiDeps = {
      listSessions: () => [],
      session: () => undefined,
      send: () => ({ id: 'x', delivered: true }),
      onSessionsChange: () => () => {},
      openTab: async () => ({ id: 't' }),
      setBadge: () => true,
      openOverlay: async () => ({ kind: 'dismissed' }),
      secrets: unusedSecrets,
      oauth,
      log: () => {}
    }
    return new HostApi(
      deps,
      { projectId: 'p', windowId: 1, projectDir: '/tmp', plugins: [{ id: PLUGIN, dir: '/tmp/a', panels: [] }, { id: OTHER, dir: '/tmp/b', panels: [] }] },
      () => {}
    )
  }

  const authorize = (params: unknown): Promise<unknown> => Promise.resolve(api.handlers['oauth.authorize']!(params))
  const refresh = (params: unknown): Promise<unknown> => Promise.resolve(api.handlers['oauth.refresh']!(params))

  beforeEach(() => {
    fake = new FakeOAuth()
    api = makeApi()
  })

  afterEach(() => {
    api.dispose()
    vi.useRealTimers()
  })

  it('passes a checked spec through and returns the tokens', async () => {
    const pending = authorize({ pluginId: PLUGIN, spec: { ...RAW_SPEC, junk: 1 } })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(1))
    expect(fake.authorizes[0]!.spec.tokenUrl).toBeInstanceOf(URL)
    expect(fake.authorizes[0]!.spec).not.toHaveProperty('junk')
    fake.authorizes[0]!.resolve(TOKENS)
    await expect(pending).resolves.toEqual(TOKENS)
  })

  it('refuses a plugin this host does not run and a bad spec, before anything starts', async () => {
    await expect(authorize({ pluginId: 'b.elsewhere', spec: RAW_SPEC })).rejects.toThrow('oauth.authorize: unknown plugin')
    await expect(authorize({ pluginId: PLUGIN, spec: { ...RAW_SPEC, tokenUrl: 'http://127.0.0.1/token' } })).rejects.toThrow(
      'oauth.authorize: the token URL must be https'
    )
    await expect(refresh({ pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: '' })).rejects.toThrow('oauth.refresh: the refresh token')
    expect(fake.authorizes).toEqual([])
  })

  it('one sign-in per plugin at a time; another plugin of the host is not blocked', async () => {
    const first = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(1))
    await expect(authorize({ pluginId: PLUGIN, spec: RAW_SPEC })).rejects.toThrow('already in progress')
    const other = authorize({ pluginId: OTHER, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(2))
    fake.authorizes[0]!.resolve(TOKENS)
    fake.authorizes[1]!.resolve(TOKENS)
    await Promise.all([first, other])
    // Finished: the next one may start.
    const again = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(3))
    fake.authorizes[2]!.resolve(TOKENS)
    await again
  })

  it(`at most ${MAX_AUTHORIZES_PER_WINDOW} sign-ins a minute per plugin; refused specs and concurrent calls cost nothing`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    await expect(authorize({ pluginId: PLUGIN, spec: { ...RAW_SPEC, clientId: '' } })).rejects.toThrow('clientId')
    for (let i = 0; i < MAX_AUTHORIZES_PER_WINDOW; i++) {
      const pending = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
      await vi.waitFor(() => expect(fake.authorizes).toHaveLength(i + 1))
      await expect(authorize({ pluginId: PLUGIN, spec: RAW_SPEC })).rejects.toThrow('already in progress')
      fake.authorizes[i]!.resolve(TOKENS)
      await pending
    }
    await expect(authorize({ pluginId: PLUGIN, spec: RAW_SPEC })).rejects.toThrow(`more than ${MAX_AUTHORIZES_PER_WINDOW} sign-ins`)
    // The other plugin has its own budget.
    const other = authorize({ pluginId: OTHER, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(MAX_AUTHORIZES_PER_WINDOW + 1))
    fake.authorizes.at(-1)!.resolve(TOKENS)
    await other
    vi.setSystemTime(AUTHORIZE_WINDOW_MS)
    const later = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(MAX_AUTHORIZES_PER_WINDOW + 2))
    fake.authorizes.at(-1)!.resolve(TOKENS)
    await later
  })

  it('a stopping host (window closed, restart) aborts its pending sign-ins and refuses new ones', async () => {
    const one = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
    const two = authorize({ pluginId: OTHER, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(2))
    api.revoke()
    expect(fake.authorizes.every((a) => a.signal.aborted)).toBe(true)
    await expect(one).rejects.toThrow('oauth.authorize: sign-in was cancelled')
    await expect(two).rejects.toThrow('cancelled')
    await expect(authorize({ pluginId: PLUGIN, spec: RAW_SPEC })).rejects.toThrow('the plugin host is stopping')
  })

  it('a disposed ctx (the host’s plugin.disposed) aborts only its plugin’s sign-in and refreshes, and frees the slot at once', async () => {
    const one = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
    const oneRefresh = refresh({ pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: 'r' })
    const two = authorize({ pluginId: OTHER, spec: RAW_SPEC })
    const twoRefresh = refresh({ pluginId: OTHER, spec: RAW_SPEC, refreshToken: 'r' })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(2))
    await vi.waitFor(() => expect(fake.refreshes).toHaveLength(2))
    api.contextDisposed({ pluginId: PLUGIN })
    // The next copy's first sign-in, right behind the event, is not "already in progress".
    const next = authorize({ pluginId: PLUGIN, spec: RAW_SPEC })
    await expect(one).rejects.toThrow('oauth.authorize: sign-in was cancelled')
    await expect(oneRefresh).rejects.toThrow('oauth.refresh: the token request was cancelled')
    expect(fake.authorizes[1]!.signal.aborted).toBe(false)
    expect(fake.refreshes[1]!.signal!.aborted).toBe(false)
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(3))
    // The old call's finally does not drop the new copy's entry.
    await expect(authorize({ pluginId: PLUGIN, spec: RAW_SPEC })).rejects.toThrow('already in progress')
    for (const a of fake.authorizes.slice(1)) a.resolve(TOKENS)
    fake.refreshes[1]!.resolve(TOKENS)
    await expect(Promise.all([two, twoRefresh, next])).resolves.toEqual([TOKENS, TOKENS, TOKENS])
    // Nothing pending, an unknown id, junk: no-ops.
    api.contextDisposed({ pluginId: PLUGIN })
    api.contextDisposed({ pluginId: 'b.elsewhere' })
    api.contextDisposed(null)
  })

  it('refresh works while the host is stopping, is dropped when it is gone, and is capped in flight', async () => {
    api.revoke()
    const pending = Array.from({ length: MAX_REFRESHES_IN_FLIGHT }, () => refresh({ pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: 'r' }))
    await vi.waitFor(() => expect(fake.refreshes).toHaveLength(MAX_REFRESHES_IN_FLIGHT))
    await expect(refresh({ pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: 'r' })).rejects.toThrow('refreshes in flight')
    fake.refreshes[0]!.resolve(TOKENS)
    await expect(pending[0]).resolves.toEqual(TOKENS)
    // A slot came free.
    const more = refresh({ pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: 'r' })
    await vi.waitFor(() => expect(fake.refreshes).toHaveLength(MAX_REFRESHES_IN_FLIGHT + 1))
    api.dispose()
    for (const p of [...pending.slice(1), more]) await expect(p).rejects.toThrow('oauth.refresh: the token request was cancelled')
    await expect(refresh({ pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: 'r' })).rejects.toThrow('the plugin host is gone')
  })
})

describe('ctx.oauth (host side)', () => {
  it('asks main with the plugin’s own id (authorize with no timeout), and stops after deactivate', async () => {
    const calls: { method: string; params: unknown; options: unknown }[] = []
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params, options) => {
        calls.push({ method, params, options })
        return TOKENS
      }
    })
    const ctx = contexts.create(hostSpec({ id: PLUGIN, dir: '/tmp/a', main: 'host.js' }))
    expect(await ctx.oauth.authorize(RAW_SPEC)).toEqual(TOKENS)
    expect(await ctx.oauth.refresh(RAW_SPEC, 'r')).toEqual(TOKENS)
    expect(calls).toEqual([
      { method: 'oauth.authorize', params: { pluginId: PLUGIN, spec: RAW_SPEC }, options: { timeoutMs: Infinity } },
      { method: 'oauth.refresh', params: { pluginId: PLUGIN, spec: RAW_SPEC, refreshToken: 'r' }, options: undefined }
    ])
    expect(Object.isFrozen(ctx.oauth)).toBe(true)
    contexts.dispose(PLUGIN)
    await expect(ctx.oauth.authorize(RAW_SPEC)).rejects.toThrow(/deactivated/)
    expect(calls).toHaveLength(2)
  })

  it('a disposed ctx rejects its pending calls at once, tells main, and drops tokens main sends later', async () => {
    const answers: ((tokens: OAuthTokens) => void)[] = []
    const emitted: unknown[] = []
    const contexts = new HostContexts({
      log: () => {},
      call: () => new Promise((resolve) => answers.push(resolve)),
      emit: (event, params) => void emitted.push({ event, params })
    })
    const spec = hostSpec({ id: PLUGIN, dir: '/tmp/a', main: 'host.js' })
    const ctx = contexts.create(spec)
    const signIn = ctx.oauth.authorize(RAW_SPEC)
    const refreshing = ctx.oauth.refresh(RAW_SPEC, 'r')
    contexts.dispose(PLUGIN)
    expect(emitted).toEqual([{ event: 'plugin.disposed', params: { pluginId: PLUGIN } }])
    // Main's answers arrive after the dispose: the disposed copy gets no tokens.
    for (const answer of answers) answer(TOKENS)
    await expect(signIn).rejects.toThrow(/deactivated/)
    await expect(refreshing).rejects.toThrow(/deactivated/)
    // Nothing in flight: no event. A second dispose is a no-op.
    contexts.create(hostSpec({ id: OTHER, dir: '/tmp/b', main: 'host.js' }))
    contexts.dispose(OTHER)
    contexts.dispose(PLUGIN)
    expect(emitted).toHaveLength(1)
    // A reload in place: create() disposes the old copy first, so its call ends before the new copy runs.
    const old = contexts.create(spec)
    const oldSignIn = old.oauth.authorize(RAW_SPEC)
    const fresh = contexts.create(spec)
    expect(emitted).toHaveLength(2)
    await expect(oldSignIn).rejects.toThrow(/deactivated/)
    const freshSignIn = fresh.oauth.authorize(RAW_SPEC)
    answers.at(-1)!(TOKENS)
    await expect(freshSignIn).resolves.toEqual(TOKENS)
  })

  it('a sign-in started by an activate that fails or times out is aborted in main and never hands its ctx tokens', async () => {
    const fake = new FakeOAuth()
    const api = new HostApi(
      {
        listSessions: () => [],
        session: () => undefined,
        send: () => ({ id: 'x', delivered: true }),
        onSessionsChange: () => () => {},
        openTab: async () => ({ id: 't' }),
        setBadge: () => true,
        openOverlay: async () => ({ kind: 'dismissed' }),
        secrets: unusedSecrets,
        oauth: fake,
        log: () => {}
      },
      { projectId: 'p', windowId: 1, projectDir: '/tmp', plugins: [{ id: PLUGIN, dir: '/tmp/a', panels: [] }, { id: OTHER, dir: '/tmp/b', panels: [] }] },
      () => {}
    )
    // The host side wired straight to main's HostApi, in the order a port keeps.
    const contexts = new HostContexts({
      log: () => {},
      call: (method, params) => Promise.resolve(api.handlers[method]!(params)),
      emit: (event, params) => {
        if (event === 'plugin.disposed') api.contextDisposed(params)
      }
    })
    const outcomes = new Map<string, unknown>()
    const signIn = (ctx: PluginContext): void => {
      ctx.oauth.authorize(RAW_SPEC).then(
        (tokens) => void outcomes.set(ctx.pluginId, tokens),
        (err: unknown) => void outcomes.set(ctx.pluginId, errorText(err))
      )
    }
    const loader = new PluginLoader({
      makeContext: (s) => contexts.create(s),
      release: (s) => contexts.dispose(s.id),
      activateTimeoutMs: 50,
      log: () => {},
      requireModule: (path) =>
        path.endsWith('fails.js')
          ? {
              activate: (ctx: PluginContext) => {
                signIn(ctx)
                throw new Error('boom')
              }
            }
          : {
              activate: (ctx: PluginContext) => {
                signIn(ctx)
                return new Promise(() => {})
              }
            }
    })
    const states = await loader.activateAll([
      hostSpec({ id: PLUGIN, dir: '/tmp/a', main: 'fails.js' }),
      hostSpec({ id: OTHER, dir: '/tmp/b', main: 'hangs.js' })
    ])
    expect(states.map((s) => s.state)).toEqual(['errored', 'errored'])
    expect(fake.authorizes).toHaveLength(2)
    // Main closed both loopbacks; a browser finishing late changes nothing.
    expect(fake.authorizes.every((a) => a.signal.aborted)).toBe(true)
    for (const a of fake.authorizes) a.resolve(TOKENS)
    await vi.waitFor(() => expect(outcomes.size).toBe(2))
    expect([...outcomes.values()]).toEqual(['the plugin is deactivated', 'the plugin is deactivated'])
    // The slots are free for the next copies.
    const again = api.handlers['oauth.authorize']!({ pluginId: PLUGIN, spec: RAW_SPEC })
    await vi.waitFor(() => expect(fake.authorizes).toHaveLength(3))
    fake.authorizes[2]!.resolve(TOKENS)
    await expect(again).resolves.toEqual(TOKENS)
    api.dispose()
  })
})
