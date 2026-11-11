// Web access gateway skeleton (main/web/gateway.ts, plan Task 4): off costs nothing, network binds
// only with TLS or the §4.3 confirm (plan Task 28), and the always-on Host / Origin checks, CSP and
// no-store on every request and upgrade.
//
// The TLS tests make a throwaway self-signed certificate for 127.0.0.1 with `openssl` (as the OAuth
// e2e spec does) and trust it only in their own requests (`ca`). Nothing here binds an address other
// than loopback: a network bind is only ever refused.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { Agent, request } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as wsModule from 'ws'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import { WebGateway, type GatewayDeps, type WsModule } from '../../src/main/web/gateway'
import { webAccessOf } from '../../src/main/web/settings'
import { CLOSE, SIGN_IN_LINK_PATH } from '../../src/shared/web-protocol'
import { FAKE_SHELL_HTML, FAKE_SHELL_JS, writeFakeShellDir } from '../fakes/fake-shell-dir'

/** A port nothing listens on right now (the OS's pick, always above 1024). */
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

function http(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; noHost?: boolean }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const target = { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers ?? {}, setHost: !opts.noHost }
    const req = request(target, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => (body += d.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A raw WebSocket upgrade; resolves with the status the gateway answered (101 = accepted). */
function upgrade(port: number, headers: Record<string, string>, path = '/ws'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers
      }
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', (err) => reject(err))
    req.end()
  })
}

let gateway: WebGateway | undefined
const dirs: string[] = []
afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function make(over: Partial<GatewayDeps> = {}): { gw: WebGateway; loadWs: ReturnType<typeof vi.fn>; logs: string[]; auth: WebAuth } {
  const logs: string[] = []
  const loadWs = vi.fn(async (): Promise<WsModule> => wsModule)
  const dir = mkdtempSync(join(tmpdir(), 'ccc-gw-'))
  dirs.push(dir)
  const accessLog = new AccessLog()
  const devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog })
  const auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog })
  const gw = new WebGateway({ log: (m) => logs.push(m), loadWs, auth, accessLog, shellDir: writeFakeShellDir(join(dir, 'shell')), ...over })
  gateway = gw
  return { gw, loadWs, logs, auth }
}

/**
 * Listening with these settings. `mode: 'none'` unless a test names another: these tests are about
 * Host, Origin and the listener, and None (no sign-in) is where only those stand in the way.
 * Sign-in has its own tests (web-auth.test.ts).
 */
async function listening(over: object = {}, deps: Partial<GatewayDeps> = {}): Promise<{ gw: WebGateway; port: number; logs: string[] }> {
  const port = await freePort()
  const { gw, logs } = make(deps)
  const status = await gw.apply(webAccessOf({ enabled: true, port, mode: 'none', ...over }))
  expect(status).toEqual({ state: 'listening', bind: '127.0.0.1', port })
  return { gw, port, logs }
}

describe('off', () => {
  it('listens on nothing and never loads ws', async () => {
    const port = await freePort()
    const { gw, loadWs } = make()
    expect(await gw.apply(webAccessOf({ enabled: false, port, mode: 'none' }))).toEqual({ state: 'off' })
    expect(await gw.apply(webAccessOf(undefined))).toEqual({ state: 'off' })
    expect(gw.address()).toBeUndefined()
    expect(loadWs).not.toHaveBeenCalled()
    await expect(http(port, { headers: { Host: `127.0.0.1:${port}` } })).rejects.toThrow(/ECONNREFUSED/)
  })

  it('no file in main imports ws at load time; the gateway loads it with a dynamic import only', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (path.endsWith('.ts')) files.push(path)
      }
    }
    walk(join(__dirname, '../../src/main'))
    const offenders = files.filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => /^\s*import\s+(?!type\b)[^;]*from\s+['"]ws['"]/.test(line) || /require\(\s*['"]ws['"]\s*\)/.test(line))
    )
    expect(offenders).toEqual([])
    expect(readFileSync(join(__dirname, '../../src/main/web/gateway.ts'), 'utf8')).toContain("import('ws')")
  })
})

describe('start and stop with the setting', () => {
  it('binds the literal loopback address for localhost and accepts a bracketed ::1 bind as ::1', async () => {
    const port = await freePort()
    const { gw } = make()
    expect(await gw.apply(webAccessOf({ enabled: true, port, bind: 'localhost' }))).toEqual({ state: 'listening', bind: 'localhost', port })
    expect(gw.address()?.address).toBe('127.0.0.1')
    expect(webAccessOf({ bind: '[::1]' }).bind).toBe('::1')
    await gw.stop()
  })

  it('starts on, stops off, loads ws once', async () => {
    const port = await freePort()
    const { gw, loadWs } = make()
    expect(await gw.apply(webAccessOf({ enabled: true, port }))).toEqual({ state: 'listening', bind: '127.0.0.1', port })
    expect(gw.address()?.port).toBe(port)
    expect((await http(port, { headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200)
    expect(await gw.apply(webAccessOf({ enabled: false, port, mode: 'none' }))).toEqual({ state: 'off' })
    expect(gw.address()).toBeUndefined()
    await expect(http(port, { headers: { Host: `127.0.0.1:${port}` } })).rejects.toThrow(/ECONNREFUSED/)
    await gw.apply(webAccessOf({ enabled: true, port }))
    expect(loadWs).toHaveBeenCalledTimes(1)
  })

  it('moves to a new port, and keeps listening when only the hosts change', async () => {
    const { gw, port } = await listening()
    const server = (gw as unknown as { server: unknown }).server
    await gw.apply(webAccessOf({ enabled: true, port, hosts: ['devbox.lan'] }))
    expect((gw as unknown as { server: unknown }).server).toBe(server)
    expect((await http(port, { headers: { Host: `devbox.lan:${port}` } })).status).toBe(200)
    const next = await freePort()
    expect(await gw.apply(webAccessOf({ enabled: true, port: next }))).toEqual({ state: 'listening', bind: '127.0.0.1', port: next })
    await expect(http(port, { headers: { Host: `127.0.0.1:${port}` } })).rejects.toThrow(/ECONNREFUSED/)
  })

  it('a rebind with a view connected and a keep-alive request open completes: the view is dropped (it reconnects), the new listener serves', async () => {
    // The manual-test "stuck on Save to 0.0.0.0" suspect: server.close() only calls back once every
    // connection is gone, so an open WebSocket or keep-alive socket left behind would hang the save.
    // (The cause was the renderer's confirm drawn under the settings screen; this keeps the rebind
    // path honest.) Another port stands in for another address: tests bind loopback only.
    const { gw, port } = await listening()
    const host = `127.0.0.1:${port}`
    gw.setSocketHandler(() => undefined)
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}` })
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    const closed = new Promise<number>((resolve) => client.on('close', (code) => resolve(code)))
    const agent = new Agent({ keepAlive: true })
    try {
      const kept = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: host }, agent }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
        req.end()
      })
      expect(kept).toBe(200)
      const next = await freePort()
      expect(await gw.apply(webAccessOf({ enabled: true, port: next, mode: 'none' }))).toEqual({ state: 'listening', bind: '127.0.0.1', port: next })
      // Dropped, not told "turned off": a 1006 is what the page retries (bridge.ts), and it finds the new listener.
      expect(await closed).toBe(1006)
      await vi.waitFor(() => expect(gw.connections().size).toBe(0))
      expect((await http(next, { headers: { Host: `127.0.0.1:${next}` } })).status).toBe(200)
    } finally {
      agent.destroy()
    }
  })

  it('a toggle while a start is still on its way ends in the last setting', async () => {
    const port = await freePort()
    const { gw } = make()
    const on = gw.apply(webAccessOf({ enabled: true, port }))
    const off = gw.apply(webAccessOf({ enabled: false, port }))
    await on
    expect(await off).toEqual({ state: 'off' })
    expect(gw.address()).toBeUndefined()
  })

  it('a port in use fails without throwing and listens on nothing', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const { port } = blocker.address() as AddressInfo
    try {
      const { gw, logs } = make()
      const status = await gw.apply(webAccessOf({ enabled: true, port }))
      expect(status.state).toBe('failed')
      expect(gw.address()).toBeUndefined()
      expect(logs.join('\n')).toContain('cannot listen')
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('ws failing to load fails the start', async () => {
    const port = await freePort()
    const { gw } = make({ loadWs: () => Promise.reject(new Error('Cannot find module ws')) })
    expect(await gw.apply(webAccessOf({ enabled: true, port }))).toEqual({ state: 'failed', reason: 'Cannot find module ws' })
    expect(gw.address()).toBeUndefined()
  })
})

describe('network binds need TLS or the confirm (plan Task 28)', () => {
  it('refuses a network bind never confirmed (a hand edit): nothing listens, ws is not loaded, the log says why', async () => {
    const port = await freePort()
    const { gw, loadWs, logs } = make()
    for (const bind of ['0.0.0.0', '192.168.1.20', '::']) {
      // mode link: None on a network address would need its own confirm too.
      const status = await gw.apply(webAccessOf({ enabled: true, port, bind, mode: 'link' }))
      expect(status.state, bind).toBe('refused')
      expect(gw.address()).toBeUndefined()
    }
    // None on a network address with TLS but without its confirm: refused as well.
    const none = await gw.apply(webAccessOf({ enabled: true, port, bind: '0.0.0.0', mode: 'none', tls: { certPath: '/c.pem', keyPath: '/k.pem' } }))
    expect(none).toEqual({ state: 'refused', reason: expect.stringMatching(/no sign-in on a network address needs the confirm/) })
    expect(loadWs).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('needs a certificate, or the confirm')
  })

  it('an unconfirmed network bind after a loopback one stops the listener', async () => {
    const { gw, port } = await listening()
    expect((await gw.apply(webAccessOf({ enabled: true, port, bind: '0.0.0.0' }))).state).toBe('refused')
    expect(gw.address()).toBeUndefined()
  })
})

describe('TLS (plan Task 28)', () => {
  let certDir: string
  let tls: { certPath: string; keyPath: string }
  let ca: string
  beforeAll(() => {
    certDir = mkdtempSync(join(tmpdir(), 'ccc-gw-tls-'))
    tls = { certPath: join(certDir, 'cert.pem'), keyPath: join(certDir, 'key.pem') }
    // argv only; -nodes: an unencrypted key (no passphrase prompt); piped so a failure says why.
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tls.keyPath, '-out', tls.certPath, '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
      { stdio: 'pipe' }
    )
    ca = readFileSync(tls.certPath, 'utf8')
  })
  afterAll(() => rmSync(certDir, { recursive: true, force: true }))

  /** An https request that trusts only the test's certificate. */
  function https(port: number, opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Answer> {
    return new Promise((resolve, reject) => {
      // The certificate is checked against the address connected to, not the Host header a test sends.
      const target = { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/', headers: opts.headers ?? {}, ca, checkServerIdentity: (_: string, cert: PeerCertificate) => checkServerIdentity('127.0.0.1', cert) }
      const req = httpsRequest(target, (res) => {
        let body = ''
        res.on('data', (d: Buffer) => (body += d.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end(opts.body)
    })
  }

  it('the TLS server serves https: the page with https frame origins, and no plain http on that port', async () => {
    const port = await freePort()
    const { gw, logs } = make()
    expect(await gw.apply(webAccessOf({ enabled: true, port, mode: 'none', tls }))).toEqual({ state: 'listening', bind: '127.0.0.1', port })
    const host = `127.0.0.1:${port}`
    const res = await https(port, { headers: { Host: host } })
    expect(res.status).toBe(200)
    expect(res.body).toBe(FAKE_SHELL_HTML)
    expect(String(res.headers['content-security-policy'])).toContain(`frame-src https://${host}/p/`)
    expect(logs.join('\n')).toContain(`listening on https://127.0.0.1:${port}`)
    // The Host check still comes first.
    expect((await https(port, { headers: { Host: `evil.example:${port}` } })).status).toBe(403)
    // Plain http to the TLS port gets no page.
    await expect(http(port, { headers: { Host: host } })).rejects.toThrow()
  })

  it('over TLS the Origin is the https page: the http one is refused, the https one reaches the handler', async () => {
    const port = await freePort()
    const { gw } = make()
    await gw.apply(webAccessOf({ enabled: true, port, mode: 'none', tls }))
    const host = `127.0.0.1:${port}`
    const handler = vi.fn((ws: wsModule.WebSocket) => ws.close())
    gw.setSocketHandler(handler)
    const open = (origin: string): Promise<'open' | 'refused'> =>
      new Promise((resolve) => {
        const client = new wsModule.WebSocket(`wss://${host}/ws`, { origin, ca })
        client.on('open', () => {
          client.close()
          resolve('open')
        })
        client.on('unexpected-response', () => resolve('refused'))
        client.on('error', () => resolve('refused'))
      })
    expect(await open(`http://${host}`)).toBe('refused')
    expect(handler).not.toHaveBeenCalled()
    expect(await open(`https://${host}`)).toBe('open')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a sign-in over TLS sets a Secure device cookie', async () => {
    const port = await freePort()
    const { gw, auth } = make()
    await gw.apply(webAccessOf({ enabled: true, port, mode: 'link', tls }))
    const host = `127.0.0.1:${port}`
    const link = await auth.accessLink(`https://${host}`)
    if (!link.ok) throw new Error('no link')
    const token = link.link.split('#t=')[1]
    const res = await https(port, {
      method: 'POST',
      path: SIGN_IN_LINK_PATH,
      headers: { Host: host, Origin: `https://${host}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: 'Phone' })
    })
    expect(res.status).toBe(200)
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('; Secure')
  })

  it('turning TLS on and off at the same address swaps the listener', async () => {
    const { gw, port } = await listening()
    const before = (gw as unknown as { server: unknown }).server
    expect((await gw.apply(webAccessOf({ enabled: true, port, mode: 'none', tls }))).state).toBe('listening')
    expect((gw as unknown as { server: unknown }).server).not.toBe(before)
    expect((await https(port, { headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200)
    await gw.apply(webAccessOf({ enabled: true, port, mode: 'none' }))
    expect((await http(port, { headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200)
  })

  it('a missing or malformed certificate fails the start with the reason, and nothing listens', async () => {
    const port = await freePort()
    const { gw } = make()
    const missing = await gw.apply(webAccessOf({ enabled: true, port, mode: 'none', tls: { ...tls, certPath: join(certDir, 'nope.pem') } }))
    expect(missing).toEqual({ state: 'failed', reason: `cannot read the certificate ${join(certDir, 'nope.pem')}: ENOENT` })
    expect(gw.address()).toBeUndefined()
    const junk = join(certDir, 'junk.pem')
    writeFileSync(junk, 'not a certificate')
    const bad = await gw.apply(webAccessOf({ enabled: true, port, mode: 'none', tls: { certPath: junk, keyPath: tls.keyPath } }))
    expect(bad.state).toBe('failed')
    expect(gw.address()).toBeUndefined()
    await expect(http(port, { headers: { Host: `127.0.0.1:${port}` } })).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('Host check (every request and the upgrade)', () => {
  it('serves the allowed names with the shell CSP and no-store', async () => {
    const { port } = await listening()
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const res = await http(port, { headers: { Host: host } })
      expect(res.status, host).toBe(200)
      expect(res.headers['cache-control']).toBe('no-store')
      const csp = String(res.headers['content-security-policy'])
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain(`frame-src http://${host}/p/`)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    }
  })

  it('refuses DNS rebinding (a foreign name pointing at loopback), another port and no Host', async () => {
    const { port } = await listening()
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `127.0.0.1:${port}.evil.example`]) {
      const res = await http(port, { headers: { Host: host } })
      expect(res.status, host).toBe(403)
      expect(res.headers['cache-control']).toBe('no-store')
    }
    // HTTP/1.1 without a Host is malformed: Node's parser refuses it before the gateway sees it.
    expect((await http(port, { noHost: true })).status).toBe(400)
  })

  it('refuses an upgrade under a foreign Host even with a matching Origin', async () => {
    const { gw, port } = await listening()
    gw.setSocketHandler((ws) => ws.close())
    expect(await upgrade(port, { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).toBe(403)
  })
})

describe('Origin check (upgrade and state-changing requests)', () => {
  it('a POST from another page, with no Origin or with null is refused before any route', async () => {
    const { port, logs } = await listening()
    const host = `127.0.0.1:${port}`
    for (const origin of ['http://localhost:3000', 'http://evil.example', 'null', `http://localhost:${port}`]) {
      expect((await http(port, { method: 'POST', path: '/sign-in', headers: { Host: host, Origin: origin } })).status, origin).toBe(403)
    }
    expect((await http(port, { method: 'POST', path: '/sign-in', headers: { Host: host } })).status).toBe(403)
    // Its own origin passes the check and finds no route.
    expect((await http(port, { method: 'POST', path: '/sign-in', headers: { Host: host, Origin: `http://${host}` } })).status).toBe(404)
    expect(logs.join('\n')).toContain('POST refused')
  })

  it('other methods are refused', async () => {
    const { port } = await listening()
    const host = `127.0.0.1:${port}`
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      expect((await http(port, { method, headers: { Host: host, Origin: `http://${host}` } })).status, method).toBe(405)
    }
  })

  it('an upgrade with a wrong or missing Origin is refused; the right one reaches the handler', async () => {
    const { gw, port } = await listening()
    const host = `127.0.0.1:${port}`
    const handler = vi.fn((ws: wsModule.WebSocket) => ws.close())
    gw.setSocketHandler(handler)
    expect(await upgrade(port, { Host: host, Origin: 'http://localhost:3000' })).toBe(403)
    expect(await upgrade(port, { Host: host, Origin: `http://localhost:${port}` })).toBe(403)
    expect(await upgrade(port, { Host: host })).toBe(403)
    expect(handler).not.toHaveBeenCalled()
    expect(await upgrade(port, { Host: host, Origin: `http://${host}` })).toBe(101)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('an upgrade with no socket handler, or on another path, is refused', async () => {
    const { port } = await listening()
    const host = `127.0.0.1:${port}`
    expect(await upgrade(port, { Host: host, Origin: `http://${host}` })).toBe(401)
    expect(await upgrade(port, { Host: host, Origin: `http://${host}` }, '/other')).toBe(404)
  })

  it('behind a proxy: the https external origin passes while the peer and Host are loopback', async () => {
    const { gw, port } = await listening({ externalOrigin: 'https://box.tail1234.ts.net' })
    gw.setSocketHandler((ws) => ws.close())
    // tailscale serve forwarding with its own Host, or rewriting it to the backend's.
    expect(await upgrade(port, { Host: 'box.tail1234.ts.net', Origin: 'https://box.tail1234.ts.net' })).toBe(101)
    expect(await upgrade(port, { Host: `127.0.0.1:${port}`, Origin: 'https://box.tail1234.ts.net' })).toBe(101)
    // The proxy's name over plain http is another origin.
    expect(await upgrade(port, { Host: 'box.tail1234.ts.net', Origin: 'http://box.tail1234.ts.net' })).toBe(403)
    const res = await http(port, { headers: { Host: 'box.tail1234.ts.net' } })
    expect(res.status).toBe(200)
    expect(String(res.headers['content-security-policy'])).toContain('https://box.tail1234.ts.net/p/')
  })

  it('a frame over 4 MiB closes the socket', async () => {
    const { gw, port } = await listening()
    const host = `127.0.0.1:${port}`
    const serverClosed = new Promise<void>((resolve) => {
      gw.setSocketHandler((ws) => ws.on('close', () => resolve()))
    })
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}` })
    const closed = new Promise<number>((resolve) => client.on('close', (code) => resolve(code)))
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    client.on('error', () => undefined)
    client.send('x'.repeat(4 * 1024 * 1024 + 1))
    // 1009 "message too big", sent by ws before it drops the socket; main logs it, nothing throws.
    expect(await closed).toBe(1009)
    await serverClosed
  })

  it('turning web access off closes open sockets with the turned-off notice (plan Task 13)', async () => {
    const { gw, port } = await listening()
    const host = `127.0.0.1:${port}`
    const serverClosed = new Promise<void>((resolve) => {
      gw.setSocketHandler((ws) => ws.on('close', () => resolve()))
    })
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}` })
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    const closed = new Promise<number>((resolve) => client.on('close', (code) => resolve(code)))
    expect(await gw.apply(webAccessOf({ enabled: false, port, mode: 'none' }))).toEqual({ state: 'off' })
    // The page shows "turned off" and stops retrying (bridge.ts FINAL_CLOSES).
    expect(await closed).toBe(CLOSE.turnedOff)
    await serverClosed
    expect(gw.connections().size).toBe(0)
  })

  it('turning off and leaving None in one save: the anonymous sockets get the notice too, not a plain drop', async () => {
    const { gw, port } = await listening()
    const host = `127.0.0.1:${port}`
    gw.setSocketHandler(() => undefined)
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}` })
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    const closed = new Promise<number>((resolve) => client.on('close', (code) => resolve(code)))
    expect(await gw.apply(webAccessOf({ enabled: false, port, mode: 'link' }))).toEqual({ state: 'off' })
    expect(await closed).toBe(CLOSE.turnedOff)
  })

  it('a socket that stops answering pings is dropped; one that answers stays (a phone that slept)', async () => {
    const { gw, port, logs } = await listening({}, { heartbeatMs: 40 })
    const host = `127.0.0.1:${port}`
    gw.setSocketHandler(() => undefined)
    const open = async (autoPong: boolean): Promise<wsModule.WebSocket> => {
      const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}`, autoPong })
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve())
        client.on('error', reject)
      })
      return client
    }
    const live = await open(true)
    const dead = await open(false)
    // The half-open peer: it neither pongs nor sends, so it goes within two beats.
    const deadClosed = new Promise<number>((resolve) => dead.on('close', (code) => resolve(code)))
    expect(await deadClosed).toBe(1006)
    await vi.waitFor(() => expect(gw.connections().get('none')).toBe(1))
    expect(logs).toContain('web access: socket dropped, no answer to a ping')
    expect(live.readyState).toBe(wsModule.WebSocket.OPEN)
    live.close()
  })

  it('stop closes open sockets', async () => {
    const { gw, port } = await listening()
    const host = `127.0.0.1:${port}`
    gw.setSocketHandler(() => undefined)
    const client = new wsModule.WebSocket(`ws://${host}/ws`, { origin: `http://${host}` })
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve())
      client.on('error', reject)
    })
    const closed = new Promise<void>((resolve) => client.on('close', () => resolve()))
    await gw.stop()
    await closed
    expect(gw.status()).toEqual({ state: 'off' })
  })
})

describe('the web shell (plan Task 8)', () => {
  it('serves the page at / and its assets, with the shell CSP; the page is never cached, hashed assets are', async () => {
    const { port } = await listening()
    const host = `127.0.0.1:${port}`
    const page = await http(port, { headers: { Host: host } })
    expect(page.status).toBe(200)
    expect(page.body).toBe(FAKE_SHELL_HTML)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(page.headers['cache-control']).toBe('no-store')
    expect(String(page.headers['content-security-policy'])).toContain("frame-ancestors 'none'")
    const js = await http(port, { path: '/assets/web-abc123.js', headers: { Host: host } })
    expect(js.status).toBe(200)
    expect(js.body).toBe(FAKE_SHELL_JS)
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(js.headers['cache-control']).toBe('max-age=31536000, immutable')
    expect(js.headers['x-content-type-options']).toBe('nosniff')
    expect(String(js.headers['content-security-policy'])).toContain("default-src 'self'")
    expect((await http(port, { path: '/assets/styles-def456.css', headers: { Host: host } })).headers['content-type']).toBe('text/css; charset=utf-8')
    expect((await http(port, { path: '/assets/Font-Regular-789.woff2', headers: { Host: host } })).headers['content-type']).toBe('font/woff2')
    // A query string does not change which file.
    expect((await http(port, { path: '/?project=abc', headers: { Host: host } })).body).toBe(FAKE_SHELL_HTML)
    const head = await http(port, { method: 'HEAD', path: '/assets/web-abc123.js', headers: { Host: host } })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
  })

  it('streams a large asset whole with its length, HEAD gives the length only, and a client gone mid-download is no error', async () => {
    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), 'ccc-gw-shell-'))
    dirs.push(dir)
    const shell = writeFakeShellDir(join(dir, 'shell'))
    // Bigger than any stream buffer, like the fonts and the shared chunk (1-2 MB each).
    const big = 'x'.repeat(3 * 1024 * 1024)
    writeFileSync(join(shell, 'assets', 'chunk-big.js'), big)
    const { gw, logs } = make({ shellDir: shell })
    await gw.apply(webAccessOf({ enabled: true, port, mode: 'none' }))
    const host = `127.0.0.1:${port}`
    const got = await http(port, { path: '/assets/chunk-big.js', headers: { Host: host } })
    expect(got.status).toBe(200)
    expect(got.headers['content-length']).toBe(String(big.length))
    expect(got.body.length).toBe(big.length)
    expect(got.body === big).toBe(true)
    const head = await http(port, { method: 'HEAD', path: '/assets/chunk-big.js', headers: { Host: host } })
    expect(head.headers['content-length']).toBe(String(big.length))
    expect(head.body).toBe('')
    expect((await http(port, { headers: { Host: host } })).headers['content-length']).toBe(String(Buffer.byteLength(FAKE_SHELL_HTML)))
    // A browser that leaves after the first bytes.
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/assets/chunk-big.js', headers: { Host: host } }, (res) => {
        res.once('data', () => {
          req.destroy()
          resolve()
        })
      })
      req.on('error', (err) => (req.destroyed ? undefined : reject(err)))
      req.end()
    })
    expect((await http(port, { path: '/assets/web-abc123.js', headers: { Host: host } })).body).toBe(FAKE_SHELL_JS)
    expect(logs.filter((l) => l.includes('serving'))).toEqual([])
  })

  it('serves nothing else from the build folder, whatever the path says', async () => {
    const { port } = await listening()
    const host = `127.0.0.1:${port}`
    for (const path of [
      '/index.html',
      '/web/index.html',
      '/assets/',
      '/assets/../index.html',
      '/assets/..%2Findex.html',
      '/assets/%2e%2e%2findex.html',
      '/assets/..%5Cindex.html',
      '/assets/sub/web-abc123.js',
      '/assets/.hidden.js',
      '/assets/missing.js',
      '/assets/page.html',
      '/assets/web-abc123.js.map',
      '/assets/web-abc123.js%00.png',
      '/assets/%E0%A4%A'
    ]) {
      const res = await http(port, { path, headers: { Host: host } })
      expect(res.status, path).toBe(404)
      expect(res.body, path).not.toContain('desktop')
    }
  })

  it('refuses an asset that is a symlink out of the assets folder, and a folder named like one', async () => {
    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), 'ccc-gw-shell-'))
    dirs.push(dir)
    const shell = writeFakeShellDir(join(dir, 'shell'))
    writeFileSync(join(dir, 'secret.js'), 'secret')
    symlinkSync(join(dir, 'secret.js'), join(shell, 'assets', 'link-1.js'))
    symlinkSync(join(shell, 'index.html'), join(shell, 'assets', 'link-2.css'))
    mkdirSync(join(shell, 'assets', 'folder.js'))
    const { gw } = make({ shellDir: shell })
    await gw.apply(webAccessOf({ enabled: true, port, mode: 'none' }))
    const host = `127.0.0.1:${port}`
    for (const path of ['/assets/link-1.js', '/assets/link-2.css', '/assets/folder.js']) {
      const res = await http(port, { path, headers: { Host: host } })
      expect(res.status, path).toBe(404)
      expect(res.body, path).not.toContain('secret')
    }
  })

  it('the shell still passes the Host check first', async () => {
    const { port } = await listening()
    for (const path of ['/', '/assets/web-abc123.js']) {
      const res = await http(port, { path, headers: { Host: `evil.example:${port}` } })
      expect(res.status, path).toBe(403)
      expect(res.body).not.toContain('web shell')
    }
  })

  it('without a build, / says so (503) and assets are 404', async () => {
    for (const shellDir of [undefined, '/nonexistent/cc-cockpit-out/renderer']) {
      const port = await freePort()
      const { gw } = make({ shellDir })
      await gw.apply(webAccessOf({ enabled: true, port, mode: 'none' }))
      const host = `127.0.0.1:${port}`
      const page = await http(port, { headers: { Host: host } })
      expect(page.status).toBe(503)
      expect(page.body).toContain('npm run build')
      expect((await http(port, { path: '/assets/web-abc123.js', headers: { Host: host } })).status).toBe(404)
      await gw.stop()
    }
  })
})

describe('the open projects (the web picker)', () => {
  it('lists the open project windows as id, name and path only', async () => {
    const openProjects = vi.fn(() => [
      { id: 'p1', name: 'one', path: '/work/one' },
      { id: 'p2', name: 'two', path: '/work/two', secret: 'x' } as unknown as { id: string; name: string; path: string }
    ])
    const { port } = await listening({}, { openProjects })
    const res = await http(port, { path: '/api/projects', headers: { Host: `127.0.0.1:${port}` } })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(res.body)).toEqual({
      projects: [
        { id: 'p1', name: 'one', path: '/work/one' },
        { id: 'p2', name: 'two', path: '/work/two' }
      ]
    })
  })

  it('is read afresh on every request, empty when nothing is open, and a failing source is an empty list', async () => {
    let open: Array<{ id: string; name: string; path: string }> = []
    let fail = false
    const { port, logs } = await listening({}, {
      openProjects: () => {
        if (fail) throw new Error('window table gone')
        return open
      }
    })
    const host = `127.0.0.1:${port}`
    expect(JSON.parse((await http(port, { path: '/api/projects', headers: { Host: host } })).body)).toEqual({ projects: [] })
    open = [{ id: 'p1', name: 'one', path: '/work/one' }]
    expect(JSON.parse((await http(port, { path: '/api/projects', headers: { Host: host } })).body).projects).toHaveLength(1)
    fail = true
    const res = await http(port, { path: '/api/projects', headers: { Host: host } })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ projects: [] })
    expect(res.body).not.toContain('window table')
    expect(logs.some((l) => l.includes('window table gone'))).toBe(true)
  })

  it('a POST to it is refused without the page\'s Origin', async () => {
    const { port } = await listening({}, { openProjects: () => [] })
    const res = await http(port, { method: 'POST', path: '/api/projects', headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' } })
    expect(res.status).toBe(403)
  })
})
