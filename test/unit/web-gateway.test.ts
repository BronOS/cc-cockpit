// Web access gateway skeleton (main/web/gateway.ts, plan Task 4): off costs nothing, loopback only,
// and the always-on Host / Origin checks, CSP and no-store on every request and upgrade.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as wsModule from 'ws'
import { WebGateway, type GatewayDeps, type WsModule } from '../../src/main/web/gateway'
import { webAccessOf } from '../../src/main/web/settings'

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
afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

function make(over: Partial<GatewayDeps> = {}): { gw: WebGateway; loadWs: ReturnType<typeof vi.fn>; logs: string[] } {
  const logs: string[] = []
  const loadWs = vi.fn(async (): Promise<WsModule> => wsModule)
  const gw = new WebGateway({ log: (m) => logs.push(m), loadWs, ...over })
  gateway = gw
  return { gw, loadWs, logs }
}

async function listening(over: object = {}, deps: Partial<GatewayDeps> = {}): Promise<{ gw: WebGateway; port: number; logs: string[] }> {
  const port = await freePort()
  const { gw, logs } = make(deps)
  const status = await gw.apply(webAccessOf({ enabled: true, port, ...over }))
  expect(status).toEqual({ state: 'listening', bind: '127.0.0.1', port })
  return { gw, port, logs }
}

describe('off', () => {
  it('listens on nothing and never loads ws', async () => {
    const port = await freePort()
    const { gw, loadWs } = make()
    expect(await gw.apply(webAccessOf({ enabled: false, port }))).toEqual({ state: 'off' })
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
  it('starts on, stops off, loads ws once', async () => {
    const port = await freePort()
    const { gw, loadWs } = make()
    expect(await gw.apply(webAccessOf({ enabled: true, port }))).toEqual({ state: 'listening', bind: '127.0.0.1', port })
    expect(gw.address()?.port).toBe(port)
    expect((await http(port, { headers: { Host: `127.0.0.1:${port}` } })).status).toBe(200)
    expect(await gw.apply(webAccessOf({ enabled: false, port }))).toEqual({ state: 'off' })
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

describe('loopback only', () => {
  it('refuses a network bind: nothing listens, ws is not loaded, the log says why', async () => {
    const port = await freePort()
    const { gw, loadWs, logs } = make()
    for (const bind of ['0.0.0.0', '192.168.1.20', '::']) {
      const status = await gw.apply(webAccessOf({ enabled: true, port, bind }))
      expect(status.state, bind).toBe('refused')
      expect(gw.address()).toBeUndefined()
    }
    expect(loadWs).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('loopback only')
  })

  it('a network bind after a loopback one stops the listener', async () => {
    const { gw, port } = await listening()
    expect((await gw.apply(webAccessOf({ enabled: true, port, bind: '0.0.0.0' }))).state).toBe('refused')
    expect(gw.address()).toBeUndefined()
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
    // Its own origin passes the check (and finds no route yet: sign-in comes with Task 5).
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
