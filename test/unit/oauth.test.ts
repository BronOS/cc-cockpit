// The OAuth building blocks kept when accounts left core (src/main/oauth/oauth.ts): PKCE and
// constant-time state checks, the loopback redirect server (one request, right path and state,
// nothing reflected, closed after success, failure, timeout or cancel), https-only URLs, the
// size-capped body reader and token response validation. 127.0.0.1 only: no real provider.
import { request, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  httpsUrl,
  MAX_TOKEN_RESPONSE_BYTES,
  OAuthError,
  parseTokenResponse,
  pkcePair,
  readLimited,
  safeEqual,
  startLoopback
} from '../../src/main/oauth/oauth'

/** A raw HTTP request (fetch cannot send a wrong Host header). */
function raw(port: number, path: string, opts: { method?: string; host?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: { host: opts.host ?? `127.0.0.1:${port}` } },
      (res) => {
        let body = ''
        res.on('data', (c: Buffer) => (body += c.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

const portOf = (redirectUri: string): number => Number(new URL(redirectUri).port)

describe('PKCE and state helpers', () => {
  it('verifier is 43 base64url chars and the challenge is its S256', async () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const { createHash } = await import('node:crypto')
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(pkcePair().verifier).not.toBe(verifier)
  })

  it('safeEqual compares any lengths without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', 'x')).toBe(false)
  })
})

describe('loopback server', () => {
  it('binds 127.0.0.1 and answers only GET /callback with the right state and Host', async () => {
    const lb = await startLoopback({ state: 'the-state' })
    expect(lb.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const port = portOf(lb.redirectUri)
    expect((await raw(port, '/favicon.ico')).status).toBe(404)
    expect((await raw(port, '/callback?state=the-state&code=c', { method: 'POST' })).status).toBe(405)
    expect((await raw(port, '/callback?state=the-state&code=c', { host: 'evil.example' })).status).toBe(400)
    expect((await raw(port, '/callback?state=wrong&code=c')).status).toBe(400)
    expect((await raw(port, '/callback?code=c')).status).toBe(400)
    // A repeated state is ambiguous: refused, not "the first one wins".
    expect((await raw(port, '/callback?state=the-state&state=the-state&code=c')).status).toBe(400)
    // None of those ended the login: the right request still does.
    const ok = await raw(port, '/callback?state=the-state&code=the-code')
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('You can close this tab')
    await expect(lb.code).resolves.toBe('the-code')
    // Exactly one: the server is gone afterwards.
    await expect(raw(port, '/callback?state=the-state&code=again')).rejects.toThrow()
  })

  it('serves a fixed page: nothing from the query is reflected', async () => {
    const lb = await startLoopback({ state: 's' })
    const port = portOf(lb.redirectUri)
    const evil = encodeURIComponent('<script>alert(1)</script>')
    const page = await raw(port, `/callback?state=s&code=${evil}&x=${evil}`)
    expect(page.body).not.toContain('script')
    expect(page.body).not.toContain('alert')
    await lb.code
  })

  it('a provider error with the right state ends the login with that error, without reflecting it', async () => {
    const lb = await startLoopback({ state: 's' })
    const port = portOf(lb.redirectUri)
    const page = await raw(port, '/callback?state=s&error=access_denied&error_description=%3Cb%3Eno%3C%2Fb%3E')
    expect(page.body).toContain('did not complete')
    expect(page.body).not.toContain('access_denied')
    await expect(lb.code).rejects.toThrow('the provider refused the sign-in (access_denied)')
    await expect(raw(port, '/callback?state=s&code=c')).rejects.toThrow()
  })

  it('logs the first wrong-state request only, and the total once at the end', async () => {
    const lines: string[] = []
    const lb = await startLoopback({ state: 's', log: (m) => lines.push(m) })
    const port = portOf(lb.redirectUri)
    for (let i = 0; i < 3; i++) expect((await raw(port, `/callback?state=x${i}&code=c`)).status).toBe(400)
    expect(lines).toEqual(['oauth: ignored a callback request with a missing or wrong state'])
    await raw(port, '/callback?state=s&code=c')
    await lb.code
    await expect.poll(() => lines.length).toBe(2)
    expect(lines[1]).toContain('ignored 3 callback requests')
  })

  it('rejects when the right state comes with no, an empty or an oversized code', async () => {
    for (const query of ['', '&code=', `&code=${'x'.repeat(5000)}`]) {
      const lb = await startLoopback({ state: 's' })
      const port = portOf(lb.redirectUri)
      const failed = expect(lb.code).rejects.toThrow('the provider sent no authorization code')
      expect((await raw(port, `/callback?state=s${query}`)).status).toBe(400)
      await failed
      await expect.poll(() => raw(port, '/callback?state=s&code=c').then(() => 'open', () => 'closed')).toBe('closed')
    }
  })

  it('closes even when the browser drops the connection before the page is flushed', async () => {
    const lb = await startLoopback({ state: 's' })
    const port = portOf(lb.redirectUri)
    // The connection dies instead of the page being written: 'finish' never fires on that
    // response (the server used to wait for it, and stayed bound until the app quit).
    const end = vi.spyOn(ServerResponse.prototype, 'end').mockImplementationOnce(function (this: ServerResponse) {
      this.socket?.destroy()
      return this
    })
    try {
      await raw(port, '/callback?state=s&code=the-code').catch(() => undefined)
    } finally {
      end.mockRestore()
    }
    await expect(lb.code).resolves.toBe('the-code')
    await expect.poll(() => raw(port, '/callback?state=s&code=c').then(() => 'open', () => 'closed')).toBe('closed')
  })

  it('times out and closes', async () => {
    const lb = await startLoopback({ state: 's', timeoutMs: 50 })
    await expect(lb.code).rejects.toThrow('timed out')
    await expect(raw(portOf(lb.redirectUri), '/callback?state=s&code=c')).rejects.toThrow()
  })

  it('cancels on abort and on close()', async () => {
    const ac = new AbortController()
    const lb = await startLoopback({ state: 's', signal: ac.signal })
    ac.abort()
    await expect(lb.code).rejects.toThrow('cancelled')
    const lb2 = await startLoopback({ state: 's' })
    lb2.close()
    await expect(lb2.code).rejects.toThrow('cancelled')
    await expect(raw(portOf(lb2.redirectUri), '/callback?state=s&code=c')).rejects.toThrow()
  })
})

describe('parseTokenResponse', () => {
  it('passes the granted scopes on, split on white space; a bad scope answer is dropped, not an error', () => {
    const base = { access_token: 'a', token_type: 'Bearer', expires_in: 10 }
    expect(parseTokenResponse({ ...base, scope: 'openid  https://x/gmail.modify\temail' }).scope).toEqual([
      'openid',
      'https://x/gmail.modify',
      'email'
    ])
    for (const scope of [42, '', '   ', 'x'.repeat(4097), Array.from({ length: 101 }, (_, i) => `s${i}`).join(' ')]) {
      const r = parseTokenResponse({ ...base, scope })
      expect(r).toEqual({ accessToken: 'a', expiresIn: 10 })
    }
  })

  it('validates shape, token_type and expires_in bounds', () => {
    expect(parseTokenResponse({ access_token: 'a', token_type: 'Bearer', expires_in: 10 })).toEqual({ accessToken: 'a', expiresIn: 10 })
    expect(parseTokenResponse({ access_token: 'a', token_type: 'bearer', expires_in: '3599', refresh_token: 'r' })).toEqual({
      accessToken: 'a',
      expiresIn: 3599,
      refreshToken: 'r'
    })
    expect(parseTokenResponse({ access_token: 'a', token_type: 'bearer' }).expiresIn).toBe(3600)
    expect(() => parseTokenResponse([])).toThrow('invalid response')
    expect(() => parseTokenResponse({ token_type: 'bearer' })).toThrow('no usable access token')
    expect(() => parseTokenResponse({ access_token: '', token_type: 'bearer' })).toThrow('no usable access token')
    expect(() => parseTokenResponse({ access_token: 'a' })).toThrow('not a bearer token')
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'mac' })).toThrow('not a bearer token')
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'bearer', expires_in: 0 })).toThrow('expires_in')
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'bearer', expires_in: 1.5 })).toThrow('expires_in')
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'bearer', expires_in: 400 * 86400 })).toThrow('expires_in')
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'bearer', expires_in: '1h' })).toThrow('expires_in')
    expect(() => parseTokenResponse({ access_token: 'a', token_type: 'bearer', refresh_token: 5 })).toThrow('refresh token')
  })
})

describe('httpsUrl', () => {
  it('accepts https, refuses http, credentials and junk without echoing the URL', () => {
    expect(httpsUrl('https://auth.example.com/token?x=1', 'token URL').host).toBe('auth.example.com')
    expect(() => httpsUrl('http://auth.example.com/token', 'token URL')).toThrow('the token URL must be https')
    expect(() => httpsUrl('not a url', 'token URL')).toThrow('the token URL is not a valid URL')
    let err: unknown
    try {
      httpsUrl('https://user:pw-secret@auth.example.com/', 'auth URL')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OAuthError)
    expect((err as Error).message).toBe('the auth URL must not hold credentials')
  })

  it('refuses plain http, loopback included', () => {
    expect(() => httpsUrl('http://127.0.0.1:8080/token', 'token URL')).toThrow('must be https')
    expect(() => httpsUrl('http://localhost:8080/token', 'token URL')).toThrow('must be https')
  })
})

describe('readLimited', () => {
  it('reads a body up to the limit', async () => {
    await expect(readLimited(new Response('{"a":1}'), 100)).resolves.toBe('{"a":1}')
    await expect(readLimited(new Response(null), 100)).resolves.toBe('')
  })

  it('refuses a declared or streamed body past the limit', async () => {
    const big = 'x'.repeat(MAX_TOKEN_RESPONSE_BYTES + 1)
    const declared = new Response(big, { headers: { 'content-length': String(big.length) } })
    await expect(readLimited(declared, MAX_TOKEN_RESPONSE_BYTES)).rejects.toThrow('oversized response')
    // No content-length: counted while streaming.
    const chunk = new TextEncoder().encode('x'.repeat(60))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      }
    })
    await expect(readLimited(new Response(stream), 100)).rejects.toThrow('oversized response')
  })
})
