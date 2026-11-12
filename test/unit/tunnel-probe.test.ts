// My own tunnel's probe (src/main/remote/tunnel-probe.ts) against local HTTP servers: nothing
// listening, a cc-cockpit gateway's session reply, an old gateway's Host refusal, anything else, a
// redirect (never followed), an oversized body and a server that never answers. The probe must never
// send a cookie.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { PROBE_MAX_BYTES, probeTunnel, tunnelGate, tunnelProbeError, tunnelWaitingText } from '../../src/main/remote/tunnel-probe'
import { tunnelCommand, type RemoteServerRecord } from '../../src/shared/remote-servers'

const servers: (Server | NetServer)[] = []

afterEach(() => {
  for (const s of servers.splice(0)) {
    if ('closeAllConnections' in s) s.closeAllConnections()
    s.close()
  }
})

async function serve(handler: Parameters<typeof createServer>[1], seen?: IncomingHttpHeaders[]): Promise<number> {
  const server = createServer((req, res) => {
    seen?.push(req.headers)
    handler?.(req, res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  servers.push(server)
  return (server.address() as AddressInfo).port
}

/** A port nothing listens on (bound, then closed). */
async function freePort(): Promise<number> {
  const s = createNetServer()
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((done) => s.close(() => done()))
  return port
}

describe('probeTunnel', () => {
  it('nothing listening is "nothing"', async () => {
    expect(await probeTunnel(await freePort())).toBe('nothing')
  })

  it("a cc-cockpit gateway's session reply is \"cockpit\"; the request has no cookie and asks the session path", async () => {
    const seen: IncomingHttpHeaders[] = []
    const urls: string[] = []
    const port = await serve((req, res) => {
      urls.push(req.url ?? '')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ mode: 'link', device: null }))
    }, seen)
    expect(await probeTunnel(port)).toBe('cockpit')
    expect(urls).toEqual(['/auth/session'])
    expect(seen[0]?.cookie).toBeUndefined()
    expect(seen[0]?.host).toBe(`127.0.0.1:${port}`)
  })

  it('an old gateway refusing the Host is "old"', async () => {
    const port = await serve((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('unknown host')
    })
    expect(await probeTunnel(port)).toBe('old')
  })

  it('anything else is "other": another 403, a page, JSON of another shape, a redirect (not followed), a body over the cap', async () => {
    const answers: Array<(res: import('node:http').ServerResponse) => void> = [
      (res) => (res.writeHead(403), res.end('forbidden')),
      (res) => (res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<h1>dev server</h1>')),
      (res) => (res.writeHead(200), res.end(JSON.stringify({ ok: true }))),
      (res) => (res.writeHead(302, { Location: 'http://127.0.0.1:1/auth/session' }), res.end()),
      (res) => (res.writeHead(200), res.end(JSON.stringify({ mode: 'link', device: null, pad: 'x'.repeat(PROBE_MAX_BYTES) })))
    ]
    for (const answer of answers) {
      const port = await serve((_req, res) => answer(res))
      expect(await probeTunnel(port)).toBe('other')
    }
  })

  it('a listener that never answers (a tunnel whose far end hangs) is "nothing" after the timeout', async () => {
    const silent = createNetServer((sock) => sock.on('error', () => {}))
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done))
    servers.push(silent)
    const started = Date.now()
    expect(await probeTunnel((silent.address() as AddressInfo).port, { timeoutMs: 150 })).toBe('nothing')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('a connection reset (the person ssh accepts, the server side refuses the channel) is "nothing"', async () => {
    const resetter = createNetServer((sock) => sock.destroy())
    await new Promise<void>((done) => resetter.listen(0, '127.0.0.1', done))
    servers.push(resetter)
    expect(await probeTunnel((resetter.address() as AddressInfo).port)).toBe('nothing')
  })
})

describe('the gate and its texts', () => {
  const tunnel: RemoteServerRecord = { id: 't', name: 't', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox' }, recent: [] }

  it('the waiting text carries the command; refusals say why', () => {
    expect(tunnelCommand({ localPort: 7331, remotePort: 7330 })).toBe('ssh -N -L 127.0.0.1:7331:127.0.0.1:7330 <host>')
    const via = tunnel.via as Extract<RemoteServerRecord['via'], { kind: 'tunnel' }>
    expect(tunnelWaitingText(via)).toContain('Nothing answers on 127.0.0.1:7331. Start the tunnel:')
    expect(tunnelWaitingText(via)).toContain('ssh -N -L 127.0.0.1:7331:127.0.0.1:7330 devbox')
    expect(tunnelProbeError(via, 'other')).toContain('Something else is listening on 127.0.0.1:7331')
    expect(tunnelProbeError(via, 'old')).toContain('update cc-cockpit on the server')
    expect(tunnelProbeError(via, 'cockpit')).toBeUndefined()
    expect(tunnelProbeError(via, 'nothing')).toBeUndefined()
  })

  it('probes tunnels only: go, wait or error', async () => {
    const probed: number[] = []
    let next: 'cockpit' | 'nothing' | 'other' = 'cockpit'
    const gate = tunnelGate(async (port) => (probed.push(port), next))
    expect(await gate(tunnel)).toEqual({ go: true })
    next = 'nothing'
    expect(await gate(tunnel)).toEqual({ wait: expect.stringContaining('Start the tunnel') })
    next = 'other'
    expect(await gate(tunnel)).toEqual({ error: expect.stringContaining('Something else') })
    expect(await gate({ id: 'd', name: 'd', via: { kind: 'direct', origin: 'https://box' }, recent: [] })).toEqual({ go: true })
    expect(probed).toEqual([7331, 7331, 7331])
  })
})
