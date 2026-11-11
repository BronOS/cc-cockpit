import { describe, expect, it } from 'vitest'
import { runStartOrder, SERVER_SOCKET_FAILED, serverGatewayFailed, type StartOrderDeps } from '../../src/main/server-start'
import type { GatewayStatus } from '../../src/main/web/gateway'

const LISTENING: GatewayStatus = { state: 'listening', bind: '127.0.0.1', port: 7331 }

/** A start whose every effect is recorded in one list, in the order it happened. */
function rig(server: boolean, opts: { socket?: boolean; gateway?: GatewayStatus | Error; deferGateway?: boolean } = {}) {
  const events: string[] = []
  let resolveGateway: ((s: GatewayStatus) => void) | undefined
  const deps: StartOrderDeps = {
    server,
    startSocket: async () => {
      events.push('socket')
      return opts.socket ?? true
    },
    applyWebAccess: () => {
      events.push('gateway')
      const g = opts.gateway ?? LISTENING
      if (opts.deferGateway) {
        return new Promise((r) => {
          resolveGateway = (s) => {
            events.push('gateway done')
            r(s)
          }
        })
      }
      return g instanceof Error ? Promise.reject(g) : Promise.resolve(g)
    },
    printLines: () => events.push('lines'),
    open: () => {
      events.push('open')
    },
    log: (line) => events.push(`log: ${line}`),
    fail: () => events.push('exit 1')
  }
  return { deps, events, resolveGateway: (s: GatewayStatus) => resolveGateway?.(s) }
}

describe('runStartOrder in server mode', () => {
  it('awaits the socket, then the gateway, prints the lines, and only then opens windows', async () => {
    const r = rig(true, { deferGateway: true })
    const done = runStartOrder(r.deps)
    await Promise.resolve()
    await Promise.resolve()
    // The gateway is still starting: no window yet.
    expect(r.events).toEqual(['socket', 'gateway'])
    r.resolveGateway(LISTENING)
    await expect(done).resolves.toBe('started')
    expect(r.events).toEqual(['socket', 'gateway', 'gateway done', 'lines', 'open'])
  })

  it('a socket that cannot start exits 1 before the gateway and before any window', async () => {
    const r = rig(true, { socket: false })
    await expect(runStartOrder(r.deps)).resolves.toBe('failed')
    expect(r.events).toEqual(['socket', `log: ${SERVER_SOCKET_FAILED}`, 'exit 1'])
  })

  it('a gateway that fails to listen (the port is taken) prints its lines, then exits 1 with no window', async () => {
    const r = rig(true, { gateway: { state: 'failed', reason: 'port 7331 is in use' } })
    await expect(runStartOrder(r.deps)).resolves.toBe('failed')
    expect(r.events).toEqual(['socket', 'gateway', 'lines', `log: ${serverGatewayFailed('port 7331 is in use')}`, 'exit 1'])
  })

  it('a gateway apply that throws is a failure too', async () => {
    const r = rig(true, { gateway: new Error('ws missing') })
    await expect(runStartOrder(r.deps)).resolves.toBe('failed')
    expect(r.events).not.toContain('open')
    expect(r.events.slice(-2)).toEqual([`log: ${serverGatewayFailed('ws missing')}`, 'exit 1'])
  })

  it('web access off (a lost write) is a failure: nothing would listen', async () => {
    const r = rig(true, { gateway: { state: 'off' } })
    await expect(runStartOrder(r.deps)).resolves.toBe('failed')
    expect(r.events).not.toContain('open')
    expect(r.events).toContain('exit 1')
  })

  it('a stored setting the gateway refuses is not a failure: the lines say how, and the windows open', async () => {
    const r = rig(true, { gateway: { state: 'refused', reason: 'a network bind needs its confirm' } })
    await expect(runStartOrder(r.deps)).resolves.toBe('started')
    expect(r.events).toEqual(['socket', 'gateway', 'lines', 'open'])
  })

  it('lines that throw are logged and the start goes on', async () => {
    const r = rig(true)
    r.deps.printLines = () => {
      throw new Error('bad origin')
    }
    await expect(runStartOrder(r.deps)).resolves.toBe('started')
    expect(r.events).toEqual(['socket', 'gateway', 'log: server start lines not printed: bad origin', 'open'])
  })
})

describe('runStartOrder on the desktop (unchanged)', () => {
  it('a socket that cannot start only logs (SocketServer does): the windows open', async () => {
    const r = rig(false, { socket: false })
    await expect(runStartOrder(r.deps)).resolves.toBe('started')
    expect(r.events).toContain('open')
    expect(r.events).not.toContain('exit 1')
  })

  it('the gateway is not awaited: the windows open while it is still starting', async () => {
    const r = rig(false, { deferGateway: true })
    await expect(runStartOrder(r.deps)).resolves.toBe('started')
    expect(r.events).toEqual(['socket', 'gateway', 'open'])
    r.resolveGateway({ state: 'failed', reason: 'port in use' })
    await new Promise((res) => setTimeout(res, 0))
    // A failed gateway on the desktop never exits.
    expect(r.events).toEqual(['socket', 'gateway', 'open', 'gateway done', 'lines'])
  })

  it('a gateway apply that throws only logs', async () => {
    const r = rig(false, { gateway: new Error('boom') })
    await expect(runStartOrder(r.deps)).resolves.toBe('started')
    await new Promise((res) => setTimeout(res, 0))
    expect(r.events).toContain('log: web access not applied: boom')
    expect(r.events).not.toContain('exit 1')
  })
})
