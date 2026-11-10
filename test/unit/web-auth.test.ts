// Web access sign-in (main/web/auth.ts and its routes in gateway.ts, plan Task 5): the access link,
// the one-time "add a device" link, regenerate, None on loopback, the attempt limiter, the device
// cookie's flags, and an access log that never carries a token, a cookie or terminal text.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as wsModule from 'ws'
import { fakeSecretStore, SecretStoreError, type SecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog, FAILED_SIGN_IN_WINDOW_MS } from '../../src/main/web/access-log'
import {
  ADD_DEVICE_TTL_MS,
  AttemptLimiter,
  cookieValues,
  DEVICE_COOKIE,
  deviceCookie,
  linkOrigin,
  NONE_DEVICE,
  WebAuth
} from '../../src/main/web/auth'
import { DeviceStore, MAX_DEVICES } from '../../src/main/web/devices'
import { WebGateway, type SocketHandler, type WsModule } from '../../src/main/web/gateway'
import { webAccessOf } from '../../src/main/web/settings'

const ORIGIN = 'http://127.0.0.1:7330'

let dir: string
let clock: number
let accessLog: AccessLog
let devices: DeviceStore
let gateway: WebGateway | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-auth-'))
  clock = 1_700_000_000_000
  accessLog = new AccessLog({ filePath: join(dir, 'logs', 'web-access.log'), now: () => clock })
  devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog, now: () => clock })
})
afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
  rmSync(dir, { recursive: true, force: true })
})

function auth(over: { secrets?: SecretStore; limiter?: AttemptLimiter } = {}): WebAuth {
  const a = new WebAuth({
    devices,
    secrets: over.secrets ?? fakeSecretStore(),
    accessLog,
    now: () => clock,
    log: () => undefined,
    ...(over.limiter ? { limiter: over.limiter } : {})
  })
  a.setMode('link')
  return a
}

function tokenOf(link: string): string {
  const at = link.indexOf('#t=')
  return link.slice(at + 3)
}

async function linkToken(a: WebAuth): Promise<string> {
  const res = await a.accessLink(ORIGIN)
  if (!res.ok) throw new Error(res.reason)
  return tokenOf(res.link)
}

const unavailable: SecretStore = {
  kind: 'os',
  unavailableReason: async () => 'no keyring',
  encrypt: async () => {
    throw new SecretStoreError('no keyring')
  },
  decrypt: async () => {
    throw new SecretStoreError('no keyring')
  }
}

describe('helpers', () => {
  it('reads every value of the cookie, in order', () => {
    expect(cookieValues(undefined, DEVICE_COOKIE)).toEqual([])
    expect(cookieValues('a=1; ccc_device=x.y; b=2;ccc_device=z.w', DEVICE_COOKIE)).toEqual(['x.y', 'z.w'])
    expect(cookieValues('xccc_device=1; ccc_devicex=2', DEVICE_COOKIE)).toEqual([])
  })

  it('cookie flags per origin: HttpOnly, SameSite=Strict, Secure only on https', () => {
    const loopback = deviceCookie('id.secret', 'http://127.0.0.1:7330')
    expect(loopback).toContain('ccc_device=id.secret')
    expect(loopback).toContain('HttpOnly')
    expect(loopback).toContain('SameSite=Strict')
    expect(loopback).toContain('Path=/')
    expect(loopback).not.toContain('Secure')
    expect(deviceCookie('id.secret', 'https://box.tail1234.ts.net')).toContain('; Secure')
  })

  it('links point at the external origin, else the bind', () => {
    expect(linkOrigin({ bind: '127.0.0.1', port: 7330 })).toBe('http://127.0.0.1:7330')
    expect(linkOrigin({ bind: '::1', port: 7330 })).toBe('http://[::1]:7330')
    expect(linkOrigin({ bind: '127.0.0.1', port: 7330, externalOrigin: 'https://box.ts.net' })).toBe('https://box.ts.net')
  })
})

describe('access link', () => {
  it('makes a 256-bit token once, kept encrypted and hashed, and signs a device in with it', async () => {
    const a = auth()
    const first = await a.accessLink(ORIGIN)
    expect(first).toMatchObject({ ok: true })
    if (!first.ok) return
    expect(first.link.startsWith(`${ORIGIN}/#t=`)).toBe(true)
    const token = tokenOf(first.link)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
    expect(await a.accessLink(ORIGIN)).toEqual(first)
    expect(readFileSync(join(dir, 'web-access.json'), 'utf8')).not.toContain(token)
    const res = await a.signInWithToken({ token, name: 'Phone' })
    expect(res).toMatchObject({ ok: true, device: { name: 'Phone', mode: 'link' } })
    if (!res.ok) return
    expect(a.authorize(`${DEVICE_COOKIE}=${res.cookie}`)?.id).toBe(res.device.id)
  })

  it('refuses a wrong token, a malformed body, and any link sign-in outside link mode', async () => {
    const a = auth()
    const token = await linkToken(a)
    expect(await a.signInWithToken({ token: token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A') })).toMatchObject({ ok: false, status: 401 })
    for (const body of [null, [], 'x', {}, { token: 5 }, { token: '' }, { token: 'x'.repeat(300) }]) {
      expect(await a.signInWithToken(body), JSON.stringify(body)).toMatchObject({ ok: false, status: 400 })
    }
    a.setMode('password')
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: false, status: 409 })
    expect(devices.list()).toEqual([])
    expect(accessLog.recent().some((e) => e.event === 'sign-in-failed')).toBe(true)
  })

  it('regenerate kills the token and every device that used it, and only those', async () => {
    const a = auth()
    const old = await linkToken(a)
    const viaLink = await a.signInWithToken({ token: old, name: 'link device' })
    const viaOnce = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link), name: 'added device' })
    const res = await a.regenerate(ORIGIN)
    expect(res.ok).toBe(true)
    if (!res.ok || !viaLink.ok || !viaOnce.ok) throw new Error('setup')
    expect(tokenOf(res.link)).not.toBe(old)
    expect(await a.signInWithToken({ token: old })).toMatchObject({ ok: false, status: 401 })
    expect(a.authorize(`${DEVICE_COOKIE}=${viaLink.cookie}`)).toBeUndefined()
    expect(a.authorize(`${DEVICE_COOKIE}=${viaOnce.cookie}`)?.name).toBe('added device')
    expect(await a.signInWithToken({ token: tokenOf(res.link) })).toMatchObject({ ok: true })
  })

  it('regenerate also kills a pending one-time link', async () => {
    const a = auth()
    const once = tokenOf(a.addDeviceLink(ORIGIN).link)
    await a.regenerate(ORIGIN)
    expect(await a.signInWithToken({ token: once })).toMatchObject({ ok: false, status: 401 })
    expect(devices.list()).toEqual([])
  })

  it('without a keychain: no access token, regenerate still revokes, the one-time link still works', async () => {
    const good = auth()
    const old = await linkToken(good)
    const viaLink = await good.signInWithToken({ token: old })
    const a = auth({ secrets: unavailable })
    expect(await a.accessLink(ORIGIN)).toMatchObject({ ok: false, reason: expect.stringContaining('cannot read') })
    expect(await a.regenerate(ORIGIN)).toEqual({ ok: false, reason: 'no keyring' })
    if (!viaLink.ok) throw new Error('setup')
    expect(a.authorize(`${DEVICE_COOKIE}=${viaLink.cookie}`)).toBeUndefined()
    expect(await a.signInWithToken({ token: old })).toMatchObject({ ok: false, status: 401 })
    expect(await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link) })).toMatchObject({ ok: true })
  })

  it('two concurrent first calls make one token', async () => {
    const a = auth()
    const [x, y] = await Promise.all([a.accessLink(ORIGIN), a.accessLink(ORIGIN)])
    expect(x).toEqual(y)
  })
})

describe('one-time "add a device" link', () => {
  it('works once', async () => {
    const a = auth()
    const token = tokenOf(a.addDeviceLink(ORIGIN).link)
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: true, device: { mode: 'add' } })
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: false, status: 401 })
  })

  it('expires after 10 minutes, and a new one replaces the last', async () => {
    const a = auth()
    const first = a.addDeviceLink(ORIGIN)
    expect(first.expiresAt).toBe(clock + ADD_DEVICE_TTL_MS)
    const second = tokenOf(a.addDeviceLink(ORIGIN).link)
    expect(await a.signInWithToken({ token: tokenOf(first.link) })).toMatchObject({ ok: false, status: 401 })
    clock += ADD_DEVICE_TTL_MS
    expect(await a.signInWithToken({ token: second })).toMatchObject({ ok: false, status: 401 })
  })

  it('two parallel uses: only one signs in', async () => {
    const a = auth()
    const token = tokenOf(a.addDeviceLink(ORIGIN).link)
    const results = await Promise.all([a.signInWithToken({ token }), a.signInWithToken({ token })])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it('is not used up when the store is full (503), only by a sign-in that added a device', async () => {
    const a = auth()
    for (let i = 0; i < MAX_DEVICES; i++) devices.add(`d${i}`, 'add')
    const token = tokenOf(a.addDeviceLink(ORIGIN).link)
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: false, status: 503 })
    devices.revoke(devices.list()[0]?.id ?? '')
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: true, device: { mode: 'add' } })
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: false, status: 401 })
  })

  it('an attempt whose client is gone never runs: no device, the token stays usable', async () => {
    const a = auth()
    const token = tokenOf(a.addDeviceLink(ORIGIN).link)
    expect(await a.signInWithToken({ token }, () => true)).toMatchObject({ ok: false, status: 499 })
    expect(devices.list()).toEqual([])
    expect(await a.signInWithToken({ token }, () => false)).toMatchObject({ ok: true })
  })
})

describe('authorize', () => {
  it('None: in without a cookie as the anonymous device; a real cookie still names its device', async () => {
    const a = auth()
    expect(a.authorize(undefined)).toBeUndefined()
    const res = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link), name: 'Mac' })
    a.setMode('none')
    expect(a.authorize(undefined)).toEqual(NONE_DEVICE)
    expect(a.authorize(`${DEVICE_COOKIE}=garbage`)).toEqual(NONE_DEVICE)
    if (!res.ok) throw new Error('setup')
    expect(a.authorize(`${DEVICE_COOKIE}=${res.cookie}`)?.name).toBe('Mac')
  })

  it('an expired or revoked device is refused; a planted same-name cookie does not sign the person out', async () => {
    const a = auth()
    const res = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link) })
    if (!res.ok) throw new Error('setup')
    expect(a.authorize(`${DEVICE_COOKIE}=planted.value; ${DEVICE_COOKIE}=${res.cookie}`)?.id).toBe(res.device.id)
    clock += 31 * 24 * 60 * 60 * 1000
    expect(a.authorize(`${DEVICE_COOKIE}=${res.cookie}`)).toBeUndefined()
    const again = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link) })
    if (!again.ok) throw new Error('setup')
    devices.revoke(again.device.id)
    expect(a.authorize(`${DEVICE_COOKIE}=${again.cookie}`)).toBeUndefined()
  })

  it('logs a mode change, not the first mode', () => {
    const a = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog })
    a.setMode('link')
    a.setMode('link')
    a.setMode('none')
    expect(accessLog.recent()).toMatchObject([{ event: 'mode', detail: 'link -> none' }])
  })
})

describe('AttemptLimiter', () => {
  function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[]; advance(ms: number): void } {
    let t = 0
    const slept: number[] = []
    return {
      now: () => t,
      slept,
      advance: (ms) => (t += ms),
      sleep: async (ms) => {
        slept.push(ms)
        t += ms
      }
    }
  }

  it('a burst: the bucket answers at once, then one attempt per fixed delay, never locked out', async () => {
    const time = fakeTime()
    const limiter = new AttemptLimiter({ capacity: 3, refillMs: 10_000, delayMs: 1000, maxWaiting: 100, now: time.now, sleep: time.sleep })
    const order: number[] = []
    const burst = Array.from({ length: 10 }, (_, i) => limiter.run(() => (order.push(i), { ok: false })))
    expect(order).toEqual([0, 1, 2])
    await Promise.all(burst)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(time.slept).toEqual(Array(7).fill(1000))
    // Right after the burst, the person's own attempt still runs (no lockout), after its delay.
    expect(await limiter.run(() => ({ ok: true }))).toEqual({ ok: true })
    expect(time.slept).toHaveLength(8)
  })

  it('successes give their token back; tokens come back with time', async () => {
    const time = fakeTime()
    const limiter = new AttemptLimiter({ capacity: 2, refillMs: 1000, delayMs: 500, now: time.now, sleep: time.sleep })
    for (let i = 0; i < 5; i++) await limiter.run(() => ({ ok: true }))
    expect(time.slept).toEqual([])
    await limiter.run(() => ({ ok: false }))
    await limiter.run(() => ({ ok: false }))
    await limiter.run(() => ({ ok: false }))
    expect(time.slept).toEqual([500])
    time.advance(2000)
    await limiter.run(() => ({ ok: false }))
    await limiter.run(() => ({ ok: false }))
    expect(time.slept).toEqual([500])
  })

  it('answers busy past the queue cap instead of holding requests', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const limiter = new AttemptLimiter({ capacity: 0, delayMs: 1, maxWaiting: 2, sleep: () => gate })
    const a = limiter.run(() => ({ ok: false }))
    const b = limiter.run(() => ({ ok: false }))
    expect(await limiter.run(() => ({ ok: false }))).toBe('busy')
    release()
    expect(await Promise.all([a, b])).toEqual([{ ok: false }, { ok: false }])
  })

  it('a queued attempt whose caller left is dropped after its wait, without running', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const limiter = new AttemptLimiter({ capacity: 0, delayMs: 1, sleep: () => gate })
    let gone = false
    const ran = vi.fn(() => ({ ok: true }))
    const pending = limiter.run(ran, () => gone)
    gone = true
    release()
    expect(await pending).toBe('cancelled')
    expect(ran).not.toHaveBeenCalled()
  })

  it('WebAuth answers 429 when the limiter is busy', async () => {
    const limiter = new AttemptLimiter({ capacity: 0, maxWaiting: 0 })
    expect(await auth({ limiter }).signInWithToken({ token: 'x' })).toMatchObject({ ok: false, status: 429 })
  })
})

// --- over HTTP: the gateway's sign-in routes and the upgrade -------------------------------------

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

function http(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers ?? {} }, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => (body += d.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

function upgrade(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers }
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

async function served(
  settings: object = {},
  limiter?: AttemptLimiter
): Promise<{ a: WebAuth; gw: WebGateway; port: number; host: string; origin: string }> {
  const port = await freePort()
  const a = auth(limiter ? { limiter } : {})
  const gw = new WebGateway({ log: () => undefined, auth: a, accessLog, loadWs: async (): Promise<WsModule> => wsModule })
  gateway = gw
  expect((await gw.apply(webAccessOf({ enabled: true, port, ...settings }))).state).toBe('listening')
  const host = `127.0.0.1:${port}`
  return { a, gw, port, host, origin: `http://${host}` }
}

function signInPost(port: number, host: string, origin: string, body: unknown, type = 'application/json'): Promise<Answer> {
  return http(port, {
    method: 'POST',
    path: '/auth/link',
    headers: { Host: host, Origin: origin, 'Content-Type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}

function cookieFrom(answer: Answer): string {
  const set = answer.headers['set-cookie']
  const first = Array.isArray(set) ? set[0] : set
  if (!first) throw new Error('no cookie')
  return first.split(';')[0] ?? ''
}

describe('gateway: sign-in over HTTP', () => {
  it('posts the token for a device cookie (loopback flags), then the session and the upgrade know the device', async () => {
    const { a, gw, port, host, origin } = await served()
    const token = await linkToken(a)
    const res = await signInPost(port, host, origin, { token, name: 'Phone' })
    expect(res.status).toBe(200)
    const set = String(res.headers['set-cookie'])
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    expect(set).not.toContain('Secure')
    expect(res.headers['cache-control']).toBe('no-store')
    const cookie = cookieFrom(res)
    const session = await http(port, { path: '/auth/session', headers: { Host: host, Cookie: cookie } })
    expect(JSON.parse(session.body)).toMatchObject({ mode: 'link', device: { name: 'Phone' } })
    expect(JSON.parse((await http(port, { path: '/auth/session', headers: { Host: host } })).body)).toEqual({ mode: 'link', device: null })
    const handler = vi.fn<SocketHandler>((ws) => ws.close())
    gw.setSocketHandler(handler)
    expect(await upgrade(port, { Host: host, Origin: origin, Cookie: cookie })).toBe(101)
    expect(handler.mock.calls[0]?.[2]).toMatchObject({ name: 'Phone', mode: 'link' })
  })

  it('behind an https proxy the cookie is Secure', async () => {
    const { a, port } = await served({ externalOrigin: 'https://box.tail1234.ts.net' })
    const res = await signInPost(port, 'box.tail1234.ts.net', 'https://box.tail1234.ts.net', { token: await linkToken(a) })
    expect(res.status).toBe(200)
    expect(String(res.headers['set-cookie'])).toContain('; Secure')
  })

  it('refuses a sign-in from another origin, without JSON, too large, or with a bad token', async () => {
    const { a, port, host, origin } = await served()
    const token = await linkToken(a)
    expect((await signInPost(port, host, 'http://localhost:3000', { token })).status).toBe(403)
    expect((await signInPost(port, host, origin, `token=${token}`, 'application/x-www-form-urlencoded')).status).toBe(415)
    expect((await signInPost(port, host, origin, { token, name: 'x'.repeat(5000) })).status).toBe(413)
    expect((await signInPost(port, host, origin, '{')).status).toBe(400)
    const wrong = await signInPost(port, host, origin, { token: 'nope' })
    expect(wrong.status).toBe(401)
    expect(wrong.headers['set-cookie']).toBeUndefined()
    expect(devices.list()).toEqual([])
  })

  it('a client that hangs up while its attempt waits gets no device and spends no one-time token', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    let waiting: () => void = () => undefined
    const queued = new Promise<void>((resolve) => (waiting = resolve))
    const limiter = new AttemptLimiter({
      capacity: 0,
      delayMs: 1,
      sleep: () => {
        waiting()
        return gate
      }
    })
    const { a, port, host, origin } = await served({}, limiter)
    const token = tokenOf(a.addDeviceLink(ORIGIN).link)
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/link', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' } })
    req.on('error', () => undefined)
    req.end(JSON.stringify({ token }))
    await queued
    req.destroy()
    // Loopback: the server sees the close at once; give it a moment before the turn comes.
    await new Promise((resolve) => setTimeout(resolve, 100))
    release()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(devices.list()).toEqual([])
    expect(accessLog.recent().some((e) => e.event === 'sign-in')).toBe(false)
    expect(await a.signInWithToken({ token })).toMatchObject({ ok: true })
  })

  it('a request or an upgrade without a valid cookie is refused', async () => {
    const { gw, port, host, origin } = await served()
    gw.setSocketHandler((ws) => ws.close())
    expect(await upgrade(port, { Host: host, Origin: origin })).toBe(401)
    expect(await upgrade(port, { Host: host, Origin: origin, Cookie: `${DEVICE_COOKIE}=forged.value` })).toBe(401)
    expect((await http(port, { path: '/anything', headers: { Host: host } })).status).toBe(401)
    // The page itself is open: it is where the browser signs in.
    expect((await http(port, { path: '/', headers: { Host: host } })).status).toBe(200)
  })

  it('None on loopback: the upgrade needs no sign-in, Host and Origin still apply', async () => {
    const { gw, port, host, origin } = await served({ mode: 'none' })
    const handler = vi.fn<SocketHandler>((ws) => ws.close())
    gw.setSocketHandler(handler)
    expect(await upgrade(port, { Host: host, Origin: origin })).toBe(101)
    expect(handler.mock.calls[0]?.[2]).toEqual(NONE_DEVICE)
    expect(await upgrade(port, { Host: host, Origin: 'http://localhost:3000' })).toBe(403)
    expect(await upgrade(port, { Host: `evil.example:${port}`, Origin: origin })).toBe(403)
    expect((await signInPost(port, host, origin, { token: 'x' })).status).toBe(409)
  })
})

async function openSocket(host: string, origin: string, cookie?: string): Promise<{ closed: Promise<void> }> {
  const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin, ...(cookie ? { headers: { Cookie: cookie } } : {}) })
  const closed = new Promise<void>((resolve) => client.on('close', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    client.on('open', () => resolve())
    client.on('error', reject)
  })
  return { closed }
}

describe('gateway: sockets by device', () => {
  it('revoking a device closes its sockets at once, not the others; connect and disconnect are logged', async () => {
    const { a, gw, host, origin } = await served()
    gw.setSocketHandler(() => undefined)
    const one = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link), name: 'one' })
    const two = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link), name: 'two' })
    if (!one.ok || !two.ok) throw new Error('setup')
    const s1 = await openSocket(host, origin, `${DEVICE_COOKIE}=${one.cookie}`)
    const s2 = await openSocket(host, origin, `${DEVICE_COOKIE}=${two.cookie}`)
    let twoClosed = false
    void s2.closed.then(() => (twoClosed = true))
    devices.revoke(one.device.id)
    await s1.closed
    expect(twoClosed).toBe(false)
    await vi.waitFor(() => expect(accessLog.recent().some((e) => e.event === 'disconnect' && e.name === 'one')).toBe(true))
    expect(accessLog.recent().filter((e) => e.event === 'connect').map((e) => e.name)).toEqual(['one', 'two'])
  })

  it('leaving None closes the sockets that came in without signing in', async () => {
    const { gw, port, host, origin } = await served({ mode: 'none' })
    gw.setSocketHandler(() => undefined)
    const anon = await openSocket(host, origin)
    await gw.apply(webAccessOf({ enabled: true, port, mode: 'link' }))
    await anon.closed
    expect(accessLog.recent().some((e) => e.event === 'mode' && e.detail === 'none -> link')).toBe(true)
  })
})

describe('the access log', () => {
  it('never carries a token, a cookie, a hash or terminal text', async () => {
    const { a, gw, port, host, origin } = await served()
    const secretsSeen: string[] = []
    gw.setSocketHandler((ws) => ws.on('message', () => undefined))
    const token = await linkToken(a)
    secretsSeen.push(token)
    const res = await signInPost(port, host, origin, { token, name: 'Laptop' })
    const cookie = cookieFrom(res)
    secretsSeen.push(cookie.split('=')[1] ?? '', (cookie.split('.')[1] ?? '').slice(0, 20))
    await signInPost(port, host, origin, { token: `${token}x` })
    const once = tokenOf(a.addDeviceLink(ORIGIN).link)
    secretsSeen.push(once)
    await a.signInWithToken({ token: once })
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin, headers: { Cookie: cookie } })
    await new Promise<void>((resolve) => client.on('open', () => resolve()))
    client.send('rm -rf / # a terminal line')
    client.close()
    await vi.waitFor(() => expect(accessLog.recent().some((e) => e.event === 'disconnect')).toBe(true))
    const hashes = (JSON.parse(readFileSync(join(dir, 'web-access.json'), 'utf8')) as { devices: Array<{ secretHash: string }> }).devices.map((d) => d.secretHash)
    expect(hashes).toHaveLength(2)
    await a.regenerate(ORIGIN)
    devices.revokeAll()
    a.setMode('none')
    const text = readFileSync(join(dir, 'logs', 'web-access.log'), 'utf8')
    const events = text
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { event: string }).event)
    expect(new Set(events)).toEqual(new Set(['sign-in', 'sign-in-failed', 'connect', 'disconnect', 'regenerate', 'revoke', 'mode']))
    for (const secret of secretsSeen) expect(text).not.toContain(secret)
    for (const hash of hashes) expect(text).not.toContain(hash)
    expect(text).not.toContain('rm -rf')
    expect(text).not.toContain(DEVICE_COOKIE)
  })

  it('collapses a run of failed sign-ins into one line and a count, so a flood keeps the history', () => {
    const path = join(dir, 'logs', 'flood.log')
    const log = new AccessLog({ filePath: path, now: () => clock })
    log.write({ event: 'sign-in', device: 'd1', name: 'Phone', detail: 'link' })
    const start = clock
    for (let i = 0; i < 500; i++) {
      log.write({ event: 'sign-in-failed', detail: 'link' })
      clock += 1000
    }
    const lines = (): Array<Record<string, unknown>> =>
      readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    // Inside one window: the first failure only, the rest are counted.
    expect(lines()).toHaveLength(2)
    // Another entry ends the run: its count is written first, at the last failure's time.
    log.write({ event: 'revoke', device: 'd1', name: 'Phone' })
    expect(lines().slice(1)).toEqual([
      { at: new Date(start).toISOString(), event: 'sign-in-failed', detail: 'link' },
      { at: new Date(clock - 1000).toISOString(), event: 'sign-in-failed', detail: 'link', count: 499 },
      { at: new Date(clock).toISOString(), event: 'revoke', device: 'd1', name: 'Phone' }
    ])
    // A failure past the window starts a new run; flush (quit) writes a pending count.
    log.write({ event: 'sign-in-failed', detail: 'link' })
    clock += FAILED_SIGN_IN_WINDOW_MS - 1
    log.write({ event: 'sign-in-failed', detail: 'link' })
    clock += 1
    log.write({ event: 'sign-in-failed', detail: 'link' })
    log.flush()
    log.flush()
    expect(lines().slice(4).map((l) => l['count'])).toEqual([undefined, 1, undefined])
    expect(log.recent().map((e) => e.count ?? 1).reduce((x, y) => x + y, 0)).toBe(1 + 500 + 1 + 3)
  })
})
