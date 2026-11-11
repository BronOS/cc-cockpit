// Web access sign-in (main/web/auth.ts and its routes in gateway.ts, plan Task 5): the access link,
// the one-time "add a device" link, regenerate, None on loopback, the attempt limiter, the device
// cookie's flags, and an access log that never carries a token, a cookie or terminal text.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as wsModule from 'ws'
import { keyFileSecretStore } from '../../src/main/secrets/key-file-store'
import { fakeSecretStore, SecretStoreError, STORED_BY_KEYCHAIN, storedValueState, type SecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog, FAILED_SIGN_IN_WINDOW_MS } from '../../src/main/web/access-log'
import {
  ADD_DEVICE_TTL_MS,
  AttemptLimiter,
  CONFIRM_BUSY_ERROR,
  CONFIRM_MAX_WRONG,
  CONFIRM_TTL_MS,
  cookieValues,
  DEVICE_COOKIE,
  deviceCookie,
  linkOrigin,
  NONE_DEVICE,
  WebAuth
} from '../../src/main/web/auth'
import { DeviceStore, MAX_DEVICES } from '../../src/main/web/devices'
import { nodeScrypt, parsePasswordHash, PasswordHasher, SCRYPT_DEFAULTS, type ScryptFn } from '../../src/main/web/password'
import { WebGateway, type SocketHandler, type WsModule } from '../../src/main/web/gateway'
import { webAccessOf } from '../../src/main/web/settings'
import { writeFakeShellDir } from '../fakes/fake-shell-dir'
import { createElement, type FunctionComponent } from 'react'
import type { WebConfirmAsk } from '../../src/shared/web-access'
import { renderToStaticMarkup } from 'react-dom/server'

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

/** scrypt at N=2^10: the same code path at a fraction of the cost (the real cost has its own test). */
function cheapHasher(over: { scrypt?: ScryptFn; maxConcurrent?: number } = {}): PasswordHasher {
  return new PasswordHasher({ params: { N: 1024, r: 8, p: 1 }, ...over })
}

function auth(
  over: { secrets?: SecretStore; limiter?: AttemptLimiter; hasher?: PasswordHasher; notify?: (text: string) => void; log?: (m: string) => void } = {}
): WebAuth {
  const a = new WebAuth({
    devices,
    secrets: over.secrets ?? fakeSecretStore(),
    accessLog,
    hasher: over.hasher ?? cheapHasher(),
    now: () => clock,
    log: over.log ?? (() => undefined),
    ...(over.limiter ? { limiter: over.limiter } : {}),
    ...(over.notify ? { notify: over.notify } : {})
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

  it('links are https over TLS, and name a LAN address for a wildcard bind (plan Task 28)', () => {
    const tls = { certPath: '/c.pem', keyPath: '/k.pem' }
    const lan = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
      wlan0: [{ address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }]
    })
    expect(linkOrigin({ bind: '192.168.1.20', port: 7330, tls })).toBe('https://192.168.1.20:7330')
    expect(linkOrigin({ bind: '0.0.0.0', port: 7330 }, lan)).toBe('http://192.168.1.20:7330')
    expect(linkOrigin({ bind: '::', port: 7330, tls }, lan)).toBe('https://192.168.1.20:7330')
    expect(linkOrigin({ bind: '0.0.0.0', port: 7330 }, () => ({}))).toBe('http://127.0.0.1:7330')
    expect(linkOrigin({ bind: '0.0.0.0', port: 7330, tls, externalOrigin: 'https://box.lan:7330' }, lan)).toBe('https://box.lan:7330')
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

describe('credentials stored by the other mode (design-web.md §9.5)', () => {
  /** The desktop's keychain stand-in: a reversible encoding whose values look like safeStorage's (base64). */
  const keychain = (): SecretStore => ({
    kind: 'os',
    unavailableReason: async () => null,
    encrypt: async (plain) => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: async (stored) => Buffer.from(stored, 'base64').toString('utf8')
  })
  const keyFile = (name: string): SecretStore =>
    keyFileSecretStore({ path: join(dir, name), storedValues: () => [], log: () => undefined })

  it('reports unset, then set, with the store that made the values', async () => {
    const a = auth({ secrets: keychain() })
    expect(a.credentialStates()).toEqual({ accessLink: 'unset', password: 'unset' })
    await linkToken(a)
    expect(a.credentialStates()).toEqual({ accessLink: 'set', password: 'unset' })
    expect(await a.setPassword('correct horse')).toEqual({ ok: true })
    expect(a.credentialStates()).toEqual({ accessLink: 'set', password: 'set' })
  })

  it('under the other mode: devices stay signed in, the link cannot be shown until regenerated, the password is set again', async () => {
    // The desktop made a link token, a password and a device.
    const desktop = auth({ secrets: keychain() })
    const token = await linkToken(desktop)
    await desktop.setPassword('correct horse')
    const device = await desktop.signInWithToken({ token, name: 'Phone' })
    if (!device.ok) throw new Error('setup')

    // The same data dir run as a server: the key file cannot read either value.
    const server = auth({ secrets: keyFile('a.key') })
    server.setMode('password')
    expect(server.credentialStates()).toEqual({ accessLink: 'other-mode', password: 'other-mode' })
    // The device is still in (a cookie is checked by hash), and so is a sign-in with the token.
    expect(server.authorize(`${DEVICE_COOKIE}=${device.cookie}`)?.name).toBe('Phone')
    server.setMode('link')
    expect(await server.signInWithToken({ token })).toMatchObject({ ok: true })
    // The link cannot be shown: the reason names the other store and the remedy.
    const shown = await server.accessLink(ORIGIN)
    expect(shown).toMatchObject({ ok: false, reason: expect.stringContaining(STORED_BY_KEYCHAIN) })
    if (!shown.ok) expect(shown.reason).toContain('regenerate')
    // The password cannot be checked, and the answer is the one for a wrong password.
    server.setMode('password')
    expect(await server.signInWithPassword({ password: 'correct horse' })).toMatchObject({ ok: false, status: 401, error: 'wrong password' })

    // Setting the password again, and regenerating the link, make both readable here.
    expect(await server.setPassword('correct horse')).toEqual({ ok: true })
    expect(server.credentialStates()).toEqual({ accessLink: 'other-mode', password: 'set' })
    expect(await server.signInWithPassword({ password: 'correct horse' })).toMatchObject({ ok: true })
    const fresh = await server.regenerate(ORIGIN)
    expect(fresh.ok).toBe(true)
    expect(server.credentialStates()).toEqual({ accessLink: 'set', password: 'set' })
    expect(await server.accessLink(ORIGIN)).toEqual(fresh)
  })

  it('a replaced key file reports both as replaced', async () => {
    const before = auth({ secrets: keyFile('old.key') })
    await linkToken(before)
    await before.setPassword('correct horse')
    expect(before.credentialStates()).toEqual({ accessLink: 'set', password: 'set' })
    const after = auth({ secrets: keyFile('new.key') })
    expect(after.credentialStates()).toEqual({ accessLink: 'replaced', password: 'replaced' })
  })

  it('the keychain calls a key file value the other mode\'s, the fake and empty ones nobody\'s', async () => {
    const value = await keyFile('k.key').encrypt('x')
    expect(storedValueState(keychain(), value)).toBe('other-mode')
    expect(storedValueState(keyFile('k.key'), value)).toBe('readable')
    expect(storedValueState(keyFile('k.key'), 'djExQUJD')).toBe('other-mode')
    const fake = await fakeSecretStore().encrypt('x')
    expect(storedValueState(keyFile('k.key'), fake)).toBe('readable')
    expect(storedValueState(fakeSecretStore(), value)).toBe('readable')
    expect(storedValueState(keychain(), '')).toBe('readable')
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

describe("server mode's start link (design-web.md §9.3)", () => {
  it('logs that it was issued and the sign-in that used it, never the link or its token', async () => {
    const a = auth()
    const { link } = a.addDeviceLink(ORIGIN, { start: true })
    const token = tokenOf(link)
    const res = await a.signInWithToken({ token, name: 'Phone' })
    if (!res.ok) throw new Error('setup')
    expect(await a.signInWithToken({ token, name: 'Late' })).toMatchObject({ ok: false, status: 401 })
    const entries = accessLog.recent().filter((e) => e.event === 'start-link')
    expect(entries.map((e) => e.detail)).toEqual(['issued', 'used'])
    expect(entries[1]).toMatchObject({ device: res.device.id, name: 'Phone' })
    const file = readFileSync(join(dir, 'logs', 'web-access.log'), 'utf8')
    expect(file).toContain('"start-link"')
    expect(file).not.toContain(token)
    expect(file).not.toContain('#t=')
  })

  it('a desktop "Add a device" link logs nothing of the kind, and replaces a pending start link', async () => {
    const a = auth()
    const start = tokenOf(a.addDeviceLink(ORIGIN, { start: true }).link)
    const desktop = tokenOf(a.addDeviceLink(ORIGIN).link)
    expect(await a.signInWithToken({ token: start })).toMatchObject({ ok: false, status: 401 })
    expect(await a.signInWithToken({ token: desktop })).toMatchObject({ ok: true })
    expect(accessLog.recent().filter((e) => e.event === 'start-link').map((e) => e.detail)).toEqual(['issued'])
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
  const gw = new WebGateway({ log: () => undefined, auth: a, accessLog, loadWs: async (): Promise<WsModule> => wsModule, shellDir: writeFakeShellDir(join(dir, 'shell')) })
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
    // Watched, not timed: the request's `cancelled` check, and what its turn came to.
    let cancelled: (() => boolean) | undefined
    const outcomes: unknown[] = []
    const run = limiter.run.bind(limiter)
    limiter.run = (async (...args: Parameters<typeof run>) => {
      cancelled = args[1]
      const outcome = await run(...args)
      outcomes.push(outcome)
      return outcome
    }) as typeof limiter.run
    const { a, port, host, origin } = await served({}, limiter)
    const token = tokenOf(a.addDeviceLink(ORIGIN).link)
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/link', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' } })
    req.on('error', () => undefined)
    req.end(JSON.stringify({ token }))
    await queued
    req.destroy()
    // The server has seen the hang-up before the turn comes.
    await vi.waitFor(() => expect(cancelled?.()).toBe(true))
    release()
    await vi.waitFor(() => expect(outcomes).toEqual(['cancelled']))
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
    // The page itself and its files are open: it is where the browser signs in.
    expect((await http(port, { path: '/', headers: { Host: host } })).status).toBe(200)
    expect((await http(port, { path: '/assets/web-abc123.js', headers: { Host: host } })).status).toBe(200)
    // The project list is not.
    expect((await http(port, { path: '/api/projects', headers: { Host: host } })).status).toBe(401)
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

  // The desktop's indicator and Disconnect button (plan Task 9): the gateway counts sockets by device,
  // closes a device's sockets without revoking it, and says when the set changes.
  it('counts open sockets by device, closes one device\'s sockets on disconnect and keeps it signed in', async () => {
    const { a, gw, host, origin } = await served()
    gw.setSocketHandler(() => undefined)
    const changes: number[] = []
    const off = gw.onConnectionsChanged(() => changes.push(gw.connections().size))
    const one = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link), name: 'one' })
    const two = await a.signInWithToken({ token: tokenOf(a.addDeviceLink(ORIGIN).link), name: 'two' })
    if (!one.ok || !two.ok) throw new Error('setup')
    const s1 = await openSocket(host, origin, `${DEVICE_COOKIE}=${one.cookie}`)
    await openSocket(host, origin, `${DEVICE_COOKIE}=${one.cookie}`)
    await openSocket(host, origin, `${DEVICE_COOKIE}=${two.cookie}`)
    expect(gw.connections()).toEqual(new Map([[one.device.id, 2], [two.device.id, 1]]))
    expect(gw.disconnectDevice('nobody')).toBe(0)
    expect(gw.disconnectDevice(one.device.id)).toBe(2)
    await s1.closed
    await vi.waitFor(() => expect(gw.connections()).toEqual(new Map([[two.device.id, 1]])))
    // Still signed in: the cookie opens a socket again.
    expect(devices.list().map((d) => d.name).sort()).toEqual(['one', 'two'])
    await openSocket(host, origin, `${DEVICE_COOKIE}=${one.cookie}`)
    expect(gw.connections().size).toBe(2)
    expect(changes.length).toBeGreaterThanOrEqual(5)
    off()
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

// --- plan Task 27: password and desktop confirm ---------------------------------------------------

/** A scrypt that waits for `release` (one per call, the newest first), counting how many run at once. */
function gatedScrypt(): { scrypt: ScryptFn; calls: number; peak: number; release(): void } {
  const waiting: Array<() => void> = []
  const state = {
    calls: 0,
    peak: 0,
    running: 0,
    release: () => waiting.pop()?.(),
    scrypt: (async (password, salt, keylen, options) => {
      state.calls++
      state.running++
      state.peak = Math.max(state.peak, state.running)
      await new Promise<void>((resolve) => waiting.push(resolve))
      state.running--
      return nodeScrypt(password, salt, keylen, options)
    }) as ScryptFn
  }
  return state
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2))
  expect(check()).toBe(true)
}

describe('PasswordHasher (scrypt)', () => {
  it('hashes with a fresh salt and checks in constant time; a wrong password is false', async () => {
    const h = cheapHasher()
    const a = await h.hash('correct horse')
    const b = await h.hash('correct horse')
    expect(a).not.toBe(b)
    expect(a.startsWith('scrypt$1024$8$1$')).toBe(true)
    expect(await h.verify('correct horse', a)).toBe(true)
    expect(await h.verify('correct horsE', a)).toBe(false)
    // NFC: the same password typed with a combining accent matches.
    expect(await h.verify('café latte!', await h.hash('café latte!'))).toBe(true)
  })

  it('a damaged or missing hash is false after a full hash all the same (no timing tell)', async () => {
    let calls = 0
    const h = cheapHasher({ scrypt: (...args) => (calls++, nodeScrypt(...args)) })
    expect(await h.verify('x', undefined)).toBe(false)
    expect(await h.verify('x', 'scrypt$1024$8$1$AAAA')).toBe(false)
    expect(calls).toBe(2)
    // A hand-edited hash cannot ask for gigabytes.
    expect(parsePasswordHash(`scrypt$${2 ** 22}$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`)).toBeUndefined()
    expect(parsePasswordHash(`scrypt$1000$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`)).toBeUndefined()
    expect(parsePasswordHash(`scrypt$1024$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`)).toBeDefined()
  })

  it('runs off the main thread: the event loop keeps turning while the real-cost hash computes', async () => {
    expect(SCRYPT_DEFAULTS.N).toBeGreaterThanOrEqual(2 ** 15)
    let ticks = 0
    let done = false
    const tick = (): void => {
      if (done) return
      ticks++
      setImmediate(tick)
    }
    setImmediate(tick)
    const hash = await new PasswordHasher().hash('correct horse')
    done = true
    // A synchronous scrypt would block the loop for the whole hash: no tick could run before it ended.
    expect(ticks).toBeGreaterThan(0)
    expect(hash.startsWith(`scrypt$${SCRYPT_DEFAULTS.N}$`)).toBe(true)
  })

  it('computes at most a few at a time; the rest wait their turn', async () => {
    const gate = gatedScrypt()
    const h = cheapHasher({ scrypt: gate.scrypt, maxConcurrent: 2 })
    const all = Promise.all(Array.from({ length: 5 }, () => h.verify('x', undefined)))
    await until(() => gate.calls === 2)
    expect(h.active).toBe(2)
    for (let i = 0; i < 5; i++) {
      await until(() => gate.calls > i)
      gate.release()
    }
    expect(await all).toEqual([false, false, false, false, false])
    expect(gate.peak).toBe(2)
    expect(h.active).toBe(0)
  })
})

describe('password sign-in', () => {
  function passwordAuth(over: Parameters<typeof auth>[0] = {}): WebAuth {
    const a = auth(over)
    a.setMode('password')
    return a
  }

  it('stores only the keychain ciphertext of the scrypt hash, and signs a device in with the password', async () => {
    const a = passwordAuth()
    expect(a.hasPassword()).toBe(false)
    expect(await a.setPassword('correct horse')).toEqual({ ok: true })
    expect(a.hasPassword()).toBe(true)
    devices.flush()
    const file = readFileSync(join(dir, 'web-access.json'), 'utf8')
    expect(file).not.toContain('correct horse')
    expect(file).not.toContain('scrypt$')
    const res = await a.signInWithPassword({ password: 'correct horse', name: 'Phone' })
    expect(res).toMatchObject({ ok: true, device: { name: 'Phone', mode: 'password' } })
    expect(res.ok && a.authorize(`${DEVICE_COOKIE}=${res.cookie}`)?.name).toBe('Phone')
    expect(accessLog.recent().map((e) => [e.event, e.detail])).toContainEqual(['password', 'set'])
  })

  it('a wrong password, no password, a malformed body, or another mode is refused', async () => {
    const a = passwordAuth()
    expect(await a.signInWithPassword({ password: 'anything' })).toMatchObject({ ok: false, status: 401, error: 'wrong password' })
    await a.setPassword('correct horse')
    expect(await a.signInWithPassword({ password: 'wrong horse' })).toMatchObject({ ok: false, status: 401, error: 'wrong password' })
    expect(await a.signInWithPassword({})).toMatchObject({ ok: false, status: 400 })
    expect(await a.signInWithPassword({ password: 'x'.repeat(2000) })).toMatchObject({ ok: false, status: 400 })
    expect(await a.signInWithPassword('nope')).toMatchObject({ ok: false, status: 400 })
    a.setMode('link')
    expect(await a.signInWithPassword({ password: 'correct horse' })).toMatchObject({ ok: false, status: 409 })
    expect(devices.list()).toEqual([])
    expect(accessLog.recent().some((e) => e.event === 'sign-in-failed' && e.detail === 'password')).toBe(true)
  })

  it('answers no password set and an unreadable one as a wrong password; only the desktop log tells them apart', async () => {
    const logged: string[] = []
    const a = passwordAuth({ log: (m) => logged.push(m) })
    expect(await a.signInWithPassword({ password: 'anything' })).toEqual({ ok: false, status: 401, error: 'wrong password' })
    expect(logged.some((m) => m.includes('no password is set'))).toBe(true)
    await a.setPassword('correct horse')
    // A fresh WebAuth (no cached hash) whose keychain cannot decrypt the stored record.
    const store = fakeSecretStore()
    const broken = passwordAuth({
      secrets: { ...store, decrypt: async () => Promise.reject(new SecretStoreError('keychain locked')) },
      log: (m) => logged.push(m)
    })
    expect(await broken.signInWithPassword({ password: 'correct horse' })).toEqual({ ok: false, status: 401, error: 'wrong password' })
    expect(logged.some((m) => m.includes('cannot read the password: keychain locked'))).toBe(true)
  })

  it('refuses a short password, and without a keychain stores none', async () => {
    expect(await passwordAuth().setPassword('short')).toEqual({ ok: false, reason: expect.stringMatching(/at least 8/) })
    const a = passwordAuth({ secrets: unavailable })
    expect(await a.setPassword('correct horse')).toEqual({ ok: false, reason: expect.stringMatching(/cannot store the password: no keyring/) })
    expect(a.hasPassword()).toBe(false)
  })

  it('changing it signs out the devices of the old one (not the others), and the old one stops working', async () => {
    const a = passwordAuth()
    await a.setPassword('correct horse')
    const viaLink = devices.add('Laptop', 'link')
    expect((await a.signInWithPassword({ password: 'correct horse', name: 'Phone' })).ok).toBe(true)
    expect(await a.setPassword('battery staple')).toEqual({ ok: true })
    expect(devices.list().map((d) => d.id)).toEqual([viaLink?.device.id])
    expect(await a.signInWithPassword({ password: 'correct horse' })).toMatchObject({ ok: false, status: 401 })
    expect((await a.signInWithPassword({ password: 'battery staple' })).ok).toBe(true)
  })

  it('an attempt that was hashing while the password changed does not sign in', async () => {
    const gate = gatedScrypt()
    const a = passwordAuth({ hasher: cheapHasher({ scrypt: gate.scrypt, maxConcurrent: 4 }) })
    const set = a.setPassword('correct horse')
    await until(() => gate.calls === 1)
    gate.release()
    await set
    const attempt = a.signInWithPassword({ password: 'correct horse' })
    await until(() => gate.calls === 2)
    const change = a.setPassword('battery staple')
    await until(() => gate.calls === 3)
    gate.release() // the new password's hash (the newest)
    await change
    gate.release() // then the attempt's
    expect(await attempt).toMatchObject({ ok: false, status: 401 })
  })

  it('a burst of guesses is slowed by the shared bucket, never locked out', async () => {
    const slept: number[] = []
    const limiter = new AttemptLimiter({ capacity: 2, refillMs: 60_000, delayMs: 1000, sleep: async (ms) => void slept.push(ms) })
    const a = passwordAuth({ limiter })
    await a.setPassword('correct horse')
    const guesses = await Promise.all(Array.from({ length: 5 }, (_, i) => a.signInWithPassword({ password: `guess ${i}!!` })))
    expect(guesses.every((g) => !g.ok && g.status === 401)).toBe(true)
    expect(slept).toEqual([1000, 1000, 1000])
    // The person's own attempt still gets in, after its turn.
    expect((await a.signInWithPassword({ password: 'correct horse' })).ok).toBe(true)
    expect(slept).toHaveLength(4)
  })
})

describe('desktop confirm', () => {
  function confirmAuth(over: Parameters<typeof auth>[0] = {}): WebAuth {
    const a = auth(over)
    a.setMode('confirm')
    return a
  }

  async function ask(a: WebAuth, name: unknown = 'Phone'): Promise<{ code: string; ticket: string; id: string }> {
    const r = await a.requestConfirm({ name })
    if (!r.ok) throw new Error(r.error)
    const shown = a.confirmAsk()
    if (!shown) throw new Error('no ask shown')
    return { code: r.code, ticket: r.ticket, id: shown.id }
  }

  it('the right code allows it: the browser collects a cookie with its ticket, once', async () => {
    const notified: string[] = []
    const a = confirmAuth({ notify: (t) => notified.push(t) })
    let changes = 0
    a.onChanged(() => changes++)
    const r = await ask(a, 'Pixel <b>9</b>')
    expect(r.code).toHaveLength(6)
    expect(notified).toHaveLength(1)
    // The desktop sees the requester's own name and never the code.
    const shown = a.confirmAsk()
    expect(shown).toMatchObject({ name: 'Pixel <b>9</b>' })
    expect(JSON.stringify(shown)).not.toContain(r.code)
    expect(a.pollConfirm({ ticket: r.ticket })).toMatchObject({ ok: true, poll: { state: 'pending', code: r.code } })
    // Spaces as the browser shows it (`123 456`) are fine.
    expect(a.answerConfirm(r.id, true, `${r.code.slice(0, 3)} ${r.code.slice(3)}`)).toEqual({ ok: true })
    expect(a.confirmAsk()).toBeUndefined()
    // Someone else's ticket learns nothing.
    expect(a.pollConfirm({ ticket: 'x'.repeat(43) })).toEqual({ ok: true, poll: { state: 'gone' } })
    const collected = a.pollConfirm({ ticket: r.ticket })
    expect(collected).toMatchObject({ ok: true, poll: { state: 'allowed', device: { name: 'Pixel <b>9</b>' } } })
    expect(collected.ok && collected.cookie && a.authorize(`${DEVICE_COOKIE}=${collected.cookie}`)?.mode).toBe('confirm')
    expect(a.pollConfirm({ ticket: r.ticket })).toEqual({ ok: true, poll: { state: 'gone' } })
    expect(changes).toBeGreaterThanOrEqual(2)
    // The log has the ask and the answer, never the code or the ticket.
    const log = readFileSync(join(dir, 'logs', 'web-access.log'), 'utf8')
    expect(log).toContain('"event":"confirm"')
    expect(log).not.toContain(r.code)
    expect(log).not.toContain(r.ticket)
  })

  it('a wrong code leaves it waiting; a few wrong codes deny it, and the browser is told', async () => {
    const a = confirmAuth()
    const r = await ask(a)
    const wrong = r.code === '000000' ? '111111' : '000000'
    for (let i = 1; i < CONFIRM_MAX_WRONG; i++) {
      expect(a.answerConfirm(r.id, true, wrong)).toEqual({ ok: false, reason: 'That is not the code the browser shows.' })
      expect(a.confirmAsk()?.id).toBe(r.id)
    }
    expect(a.answerConfirm(r.id, true, undefined)).toEqual({ ok: false, reason: expect.stringMatching(/was denied/) })
    expect(a.confirmAsk()).toBeUndefined()
    // Too late for the right one now.
    expect(a.answerConfirm(r.id, true, r.code)).toEqual({ ok: false, reason: 'This request is no longer waiting.' })
    expect(a.pollConfirm({ ticket: r.ticket })).toEqual({ ok: true, poll: { state: 'denied' } })
    expect(devices.list()).toEqual([])
  })

  it('Deny, and allow without a strict `true`, never let it in', async () => {
    const a = confirmAuth()
    const r = await ask(a)
    expect(a.answerConfirm(r.id, 'yes', r.code)).toEqual({ ok: true })
    expect(a.pollConfirm({ ticket: r.ticket })).toEqual({ ok: true, poll: { state: 'denied' } })
    expect(a.answerConfirm(r.id, false, r.code)).toEqual({ ok: false, reason: 'This request is no longer waiting.' })
  })

  it('one request at a time: a second is refused while one waits, and can ask once it is answered', async () => {
    const a = confirmAuth()
    const first = await ask(a)
    // The text sends the person to the desktop: the waiting request may be someone else's.
    expect(await a.requestConfirm({ name: 'Attacker' })).toEqual({ ok: false, status: 409, error: CONFIRM_BUSY_ERROR })
    expect(CONFIRM_BUSY_ERROR).toContain('not yours, deny it there')
    expect(a.confirmAsk()?.name).toBe('Phone')
    a.answerConfirm(first.id, false, undefined)
    const second = await ask(a, 'Laptop')
    expect(second.id).not.toBe(first.id)
    // The first browser's request is gone (its denial replaced by the next ask).
    expect(a.pollConfirm({ ticket: first.ticket })).toEqual({ ok: true, poll: { state: 'gone' } })
  })

  it('lapses after its time; leaving the mode or turning off drops it', async () => {
    const a = confirmAuth()
    const r = await ask(a)
    clock += CONFIRM_TTL_MS
    expect(a.confirmAsk()).toBeUndefined()
    expect(a.answerConfirm(r.id, true, r.code)).toEqual({ ok: false, reason: 'This request is no longer waiting.' })
    expect(a.pollConfirm({ ticket: r.ticket })).toEqual({ ok: true, poll: { state: 'gone' } })
    const again = await ask(a)
    a.dropPending()
    expect(a.pollConfirm({ ticket: again.ticket })).toEqual({ ok: true, poll: { state: 'gone' } })
    const third = await ask(a)
    a.setMode('link')
    expect(a.confirmAsk()).toBeUndefined()
    expect(a.answerConfirm(third.id, true, third.code)).toMatchObject({ ok: false })
    expect(await a.requestConfirm({ name: 'x' })).toMatchObject({ ok: false, status: 409 })
  })

  it('asks are rate limited by the shared bucket and never give their token back', async () => {
    const slept: number[] = []
    const limiter = new AttemptLimiter({ capacity: 1, refillMs: 60_000, delayMs: 1000, sleep: async (ms) => void slept.push(ms) })
    const a = confirmAuth({ limiter })
    const first = await ask(a)
    expect(slept).toEqual([])
    a.answerConfirm(first.id, false, undefined)
    // Answered, but the ask's token stays spent: the next ask waits its turn.
    await ask(a)
    expect(slept).toEqual([1000])
  })
})

describe('the desktop-confirm card', () => {
  it('has no form, no default button and no autofocus, so no key alone answers it; the name is plain text', async () => {
    // A .tsx module, loaded by a path the node typecheck does not follow (it has no JSX or DOM
    // lib); vitest transforms it like any other.
    const file = '../../src/renderer/status/WebConfirmCard.tsx'
    const { WebConfirmPanel } = (await import(file)) as { WebConfirmPanel: FunctionComponent<{ ask: WebConfirmAsk }> }
    const html = renderToStaticMarkup(createElement(WebConfirmPanel, { ask: { id: 'a', name: 'Phone <img src=x>', expiresAt: Date.now() + 60_000 } }))
    expect(html).not.toContain('<form')
    expect(html.toLowerCase()).not.toContain('autofocus')
    const buttons = html.match(/<button[^>]*>/g) ?? []
    expect(buttons).toHaveLength(2)
    for (const b of buttons) expect(b).toContain('type="button"')
    expect(html).toContain('Phone &lt;img src=x&gt;')
    expect(html).not.toContain('<img')
    // Allow starts disabled: nothing is typed yet.
    expect(html).toMatch(/<button type="button" disabled="">Allow<\/button>/)
  })
})

describe('gateway: password and desktop-confirm routes', () => {
  function post(port: number, host: string, origin: string, path: string, body: unknown, cookie?: string): Promise<Answer> {
    return http(port, {
      method: 'POST',
      path,
      headers: { Host: host, Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body)
    })
  }

  it('the password route gives the device cookie for the right password only', async () => {
    const { a, port, host, origin } = await served({ mode: 'password' })
    await a.setPassword('correct horse')
    expect((await post(port, host, origin, '/auth/password', { password: 'wrong horse' })).status).toBe(401)
    expect((await post(port, host, 'http://evil.example', '/auth/password', { password: 'correct horse' })).status).toBe(403)
    const res = await post(port, host, origin, '/auth/password', { password: 'correct horse', name: 'Phone' })
    expect(res.status).toBe(200)
    const cookie = cookieFrom(res)
    expect(await upgrade(port, { Host: host, Origin: origin, Cookie: cookie })).toBe(401) // no socket handler installed
    const session = await http(port, { path: '/auth/session', headers: { Host: host, Cookie: cookie } })
    expect(JSON.parse(session.body)).toMatchObject({ mode: 'password', device: { name: 'Phone' } })
  })

  it('the confirm routes: ask, poll pending, the desktop allows, the poll carries the cookie', async () => {
    const { a, port, host, origin } = await served({ mode: 'confirm' })
    const asked = await post(port, host, origin, '/auth/confirm', { name: 'Phone' })
    expect(asked.status).toBe(200)
    const { code, ticket } = JSON.parse(asked.body) as { code: string; ticket: string }
    expect(asked.headers['set-cookie']).toBeUndefined()
    expect((await post(port, host, origin, '/auth/confirm', { name: 'Other' })).status).toBe(409)
    const pending = await post(port, host, origin, '/auth/confirm/poll', { ticket })
    expect(JSON.parse(pending.body)).toMatchObject({ state: 'pending', code })
    // A foreign page cannot poll (and so cannot collect) even with the ticket.
    expect((await post(port, host, 'http://evil.example', '/auth/confirm/poll', { ticket })).status).toBe(403)
    expect(a.answerConfirm(a.confirmAsk()?.id, true, code)).toEqual({ ok: true })
    const allowed = await post(port, host, origin, '/auth/confirm/poll', { ticket })
    expect(JSON.parse(allowed.body)).toMatchObject({ state: 'allowed', device: { name: 'Phone' } })
    const cookie = cookieFrom(allowed)
    const session = await http(port, { path: '/auth/session', headers: { Host: host, Cookie: cookie } })
    expect(JSON.parse(session.body)).toMatchObject({ mode: 'confirm', device: { name: 'Phone' } })
  })

  it('turning web access off drops a waiting request', async () => {
    const { a, gw, port, host, origin } = await served({ mode: 'confirm' })
    expect((await post(port, host, origin, '/auth/confirm', {})).status).toBe(200)
    expect(a.confirmAsk()).toBeDefined()
    await gw.apply(webAccessOf({ enabled: false, mode: 'confirm' }))
    expect(a.confirmAsk()).toBeUndefined()
  })
})
