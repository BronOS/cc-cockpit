// Settings › General › Web access, main's side (plan Task 9): the strict change validation
// (settings.ts `applyWebAccessPatch`), the risk rule for the warning badge, and the service that stores
// a change, applies it to the gateway and answers the page (access-service.ts).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAccessService, type GatewayLike } from '../../src/main/web/access-service'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import type { GatewayStatus } from '../../src/main/web/gateway'
import { applyWebAccessPatch, DEFAULT_WEB_ACCESS, webAccessOf, webAccessRisks } from '../../src/main/web/settings'
import type { WebAccessSettings } from '../../src/shared/types'
import type { WebAccessIndicator } from '../../src/shared/web-access'

const base: WebAccessSettings = { ...DEFAULT_WEB_ACCESS, hosts: [] }

function patched(patch: unknown, from: WebAccessSettings = base): WebAccessSettings {
  const r = applyWebAccessPatch(from, patch)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

function refused(patch: unknown, from: WebAccessSettings = base): string {
  const r = applyWebAccessPatch(from, patch)
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}

describe('applyWebAccessPatch (settings validation)', () => {
  it('changes only the fields in the patch', () => {
    const next = patched({ enabled: true })
    expect(next).toEqual({ ...base, enabled: true })
    // The bind and TLS paths are not editable here.
    const withBind = { ...base, bind: '127.0.0.2', tls: { certPath: '/c', keyPath: '/k' } }
    expect(patched({ port: 8000 }, withBind)).toMatchObject({ bind: '127.0.0.2', tls: { certPath: '/c', keyPath: '/k' }, port: 8000 })
  })

  it.each([80, 1023, 65536, 1.5, '7330', null, NaN, Infinity])('refuses the port %j', (port) => {
    expect(refused({ port })).toMatch(/port must be a whole number from 1024 to 65535/)
  })

  it('moves host entries that named the old port when the port changes', () => {
    const from = { ...base, hosts: ['box.local:7330', 'other:9000'] }
    expect(patched({ port: 8000 }, from).hosts).toEqual(['box.local:8000', 'other:9000'])
  })

  it('normalises hosts, drops duplicates and refuses a non-host', () => {
    expect(patched({ hosts: ['Box.Local', 'box.local:7330', ' 192.168.1.5 '] }).hosts).toEqual(['box.local:7330', '192.168.1.5:7330'])
    for (const bad of ['http://x', 'a/b', 'user@x', '', 'a b', 5]) expect(refused({ hosts: [bad] })).toMatch(/not a host name/)
    expect(refused({ hosts: 'x' })).toMatch(/must be a list/)
    expect(refused({ hosts: Array.from({ length: 40 }, (_, i) => `h${i}`) })).toMatch(/at most 32/)
  })

  it('takes the external origin as an origin, and clears it on empty or null', () => {
    expect(patched({ externalOrigin: 'https://Box.Tailnet.ts.net/' }).externalOrigin).toBe('https://box.tailnet.ts.net')
    const from = { ...base, externalOrigin: 'https://x.example' }
    expect('externalOrigin' in patched({ externalOrigin: null }, from)).toBe(false)
    expect('externalOrigin' in patched({ externalOrigin: '  ' }, from)).toBe(false)
    for (const bad of ['box', 'ftp://x', 'https://x/path', 'https://u:p@x', 'https://x/?q', 7]) {
      expect(refused({ externalOrigin: bad })).toMatch(/is not an origin/)
    }
  })

  it('refuses a mode that is not built yet, and one that does not exist', () => {
    expect(patched({ mode: 'none' }).mode).toBe('none')
    expect(refused({ mode: 'password' })).toMatch(/not available yet/)
    expect(refused({ mode: 'confirm' })).toMatch(/not available yet/)
    expect(refused({ mode: 'root' })).toMatch(/not a sign-in mode/)
    // Staying on a mode a hand-edited file already holds is not a change to refuse.
    expect(patched({ mode: 'password' }, { ...base, mode: 'password' }).mode).toBe('password')
  })

  it('refuses unknown fields and a non-object, and a wrong type for enabled', () => {
    expect(refused({ bind: '0.0.0.0' })).toMatch(/unknown field "bind"/)
    expect(refused({ tls: {} })).toMatch(/unknown field/)
    expect(refused('x')).toMatch(/must be an object/)
    expect(refused(null)).toMatch(/must be an object/)
    expect(refused([])).toMatch(/must be an object/)
    expect(refused({ enabled: 'yes' })).toMatch(/true or false/)
  })

  it('changes nothing when one field of several is invalid', () => {
    const r = applyWebAccessPatch(base, { enabled: true, port: 22 })
    expect(r.ok).toBe(false)
    expect(base.enabled).toBe(false)
  })
})

describe('webAccessRisks (the badge rule, design §4.3)', () => {
  it('has none for loopback, with or without a proxy', () => {
    expect(webAccessRisks({ ...base, enabled: true })).toEqual([])
    expect(webAccessRisks({ ...base, enabled: true, mode: 'none', externalOrigin: 'https://box.ts.net' })).toEqual([])
  })

  it('warns for no sign-in on a network address', () => {
    const r = webAccessRisks({ ...base, enabled: true, bind: '0.0.0.0', mode: 'none', tls: { certPath: '/c', keyPath: '/k' } })
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/Sign-in is off/)
  })

  it('warns for plain http on a network address, and for a plain-http proxy name', () => {
    expect(webAccessRisks({ ...base, bind: '192.168.1.5' })[0]).toMatch(/Plain http/)
    expect(webAccessRisks({ ...base, externalOrigin: 'http://box.lan' })[0]).toMatch(/Plain http/)
    expect(webAccessRisks({ ...base, externalOrigin: 'http://localhost:9000' })).toEqual([])
  })

  it('warns twice for none over plain http on a network', () => {
    expect(webAccessRisks({ ...base, bind: '10.0.0.4', mode: 'none' })).toHaveLength(2)
  })
})

describe('WebAccessService', () => {
  let dir: string
  let clock: number
  let stored: unknown
  let status: GatewayStatus
  let applied: WebAccessSettings[]
  let open: Map<string, number>
  let disconnected: string[]
  let indicators: WebAccessIndicator[]
  let connectionListener: (() => void) | undefined
  let devices: DeviceStore
  let auth: WebAuth
  let service: WebAccessService

  // Rebuilt per test (a test may swap `apply`).
  let gateway: GatewayLike
  const makeGateway = (): GatewayLike => ({
    async apply(settings) {
      applied.push(settings)
      status = settings.enabled ? { state: 'listening', bind: settings.bind, port: settings.port } : { state: 'off' }
      return status
    },
    status: () => status,
    connections: () => open,
    disconnectDevice(id) {
      disconnected.push(id)
      return open.get(id) ?? 0
    },
    onConnectionsChanged(listener) {
      connectionListener = listener
      return () => {
        connectionListener = undefined
      }
    }
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-web-service-'))
    clock = 1_700_000_000_000
    stored = undefined
    status = { state: 'off' }
    applied = []
    open = new Map()
    disconnected = []
    indicators = []
    gateway = makeGateway()
    const accessLog = new AccessLog({ filePath: join(dir, 'logs', 'web-access.log'), now: () => clock })
    devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog, now: () => clock })
    auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog, now: () => clock, log: () => undefined })
    auth.setMode('link')
    service = new WebAccessService({
      gateway,
      auth,
      read: () => stored,
      write: (next) => {
        // What main's index.ts does: only the editable fields, a cleared origin removed.
        const s: Record<string, unknown> = { ...(stored as object | undefined), enabled: next.enabled, port: next.port, hosts: next.hosts, mode: next.mode }
        if (next.externalOrigin !== undefined) s['externalOrigin'] = next.externalOrigin
        else delete s['externalOrigin']
        stored = s
      },
      emit: (i) => indicators.push(i)
    })
  })
  afterEach(() => {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is off with the defaults and shows no devices', () => {
    const v = service.view()
    expect(v.form).toEqual({ enabled: false, port: 7330, externalOrigin: '', hosts: [], mode: 'link' })
    expect(v.gateway).toEqual({ state: 'off' })
    expect(v.devices).toEqual([])
    expect(v.risks).toEqual([])
  })

  it('runs the headless terminals only while the settings mean the gateway listens: started before it, drained after it', async () => {
    const calls: string[] = []
    let release: (() => void) | undefined
    const withTerminals = new WebAccessService({
      gateway: {
        ...gateway,
        apply: async (settings) => {
          calls.push(`gateway ${settings.enabled}`)
          // A gateway close that takes a while (the views' close handshake), when a test asks.
          if (release) await new Promise<void>((resolve) => (release = resolve))
          return gateway.apply(settings)
        }
      },
      auth,
      read: () => stored,
      write: (next) => {
        stored = { ...(stored as object | undefined), enabled: next.enabled, port: next.port, hosts: next.hosts, mode: next.mode }
      },
      emit: () => undefined,
      terminals: {
        start: () => calls.push('start'),
        drain: async () => {
          calls.push('drain')
        }
      }
    })
    // Start-up with web access off: drained after the gateway (a no-op), so nothing is loaded.
    await withTerminals.apply()
    expect(calls).toEqual(['gateway false', 'drain'])
    calls.length = 0
    // On: started synchronously before the gateway, so tabs restored next are mirrored from item 1.
    const pending = withTerminals.set({ enabled: true })
    expect(calls).toEqual(['start', 'gateway true'])
    await pending
    calls.length = 0
    // Off: the gateway first (it closes the remote views with their notice), then the drain.
    await withTerminals.set({ enabled: false })
    expect(calls).toEqual(['gateway false', 'drain'])
    calls.length = 0
    // A stored setting the gateway refuses (a network bind before Task 28) runs no worker either.
    stored = { enabled: true, bind: '0.0.0.0' }
    await withTerminals.apply()
    expect(calls).toEqual(['gateway true', 'drain'])
    calls.length = 0
    // Off, then on again before the off reached the gateway: the drain is skipped, the mirror stays.
    stored = { enabled: true }
    await withTerminals.apply()
    calls.length = 0
    release = () => undefined
    const off = withTerminals.set({ enabled: false })
    await Promise.resolve()
    const finishOff = release
    release = undefined
    const on = withTerminals.set({ enabled: true })
    finishOff()
    await Promise.all([off, on])
    expect(calls).toEqual(['gateway false', 'start', 'gateway true'])
    withTerminals.dispose()
  })

  it('stores a change, applies it to the gateway and answers with the new view', async () => {
    const v = await service.set({ enabled: true, port: 8123, hosts: ['box.local'] })
    expect(stored).toMatchObject({ enabled: true, port: 8123, hosts: ['box.local:8123'] })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ enabled: true, port: 8123 })
    expect(v.gateway).toEqual({ state: 'listening', bind: '127.0.0.1', port: 8123, origin: 'http://127.0.0.1:8123' })
    expect(webAccessOf(stored).port).toBe(8123)
  })

  it('refuses an invalid change with its reason, stores nothing and does not touch the gateway', async () => {
    await expect(service.set({ port: 80 })).rejects.toThrow(/port must be a whole number/)
    await expect(service.set({ mode: 'password' })).rejects.toThrow(/not available yet/)
    expect(stored).toBeUndefined()
    expect(applied).toEqual([])
  })

  it('keeps a saved change the gateway could not act on, and shows the reason', async () => {
    gateway.apply = async (settings) => {
      applied.push(settings)
      status = { state: 'failed', reason: 'EADDRINUSE' }
      return status
    }
    const v = await service.set({ enabled: true })
    expect(webAccessOf(stored).enabled).toBe(true)
    expect(v.gateway).toEqual({ state: 'failed', reason: 'EADDRINUSE' })
  })

  it('emits the indicator after a change', async () => {
    await service.set({ enabled: true })
    expect(indicators.at(-1)).toEqual({ connected: 0 })
  })

  describe('the access link', () => {
    it('is not in the view, and is only given while listening in the link mode', async () => {
      expect(JSON.stringify(service.view())).not.toMatch(/#t=/)
      expect(await service.link()).toEqual({ ok: false, reason: expect.stringMatching(/Turn web access on/) })
      await service.set({ enabled: true })
      const reply = await service.link()
      expect(reply).toMatchObject({ ok: true })
      expect(reply.ok && reply.link).toMatch(/^http:\/\/127\.0\.0\.1:7330\/#t=[A-Za-z0-9_-]{43}$/)
      // The view still carries no token (Show hides it by default: it is only fetched on a press).
      expect(JSON.stringify(service.view())).not.toMatch(/#t=|[A-Za-z0-9_-]{43}/)
      await service.set({ mode: 'none' })
      expect(await service.link()).toEqual({ ok: false, reason: expect.stringMatching(/access-link mode/) })
      expect(service.addDevice()).toEqual({ ok: false, reason: expect.stringMatching(/access-link mode/) })
    })

    it('points at the external origin behind a proxy, and the same link comes back until regenerated', async () => {
      await service.set({ enabled: true, externalOrigin: 'https://box.tailnet.ts.net' })
      const a = await service.link()
      const b = await service.link()
      expect(a).toEqual(b)
      expect(a.ok && a.link.startsWith('https://box.tailnet.ts.net/#t=')).toBe(true)
      const c = await service.regenerate()
      expect(c.ok && a.ok && c.link !== a.link).toBe(true)
    })

    it('regenerating signs out the devices that used the old link', async () => {
      await service.set({ enabled: true })
      const link = await service.link()
      expect(link.ok).toBe(true)
      const token = link.ok ? link.link.split('#t=')[1] : ''
      const signed = await auth.signInWithToken({ token, name: 'Phone' })
      expect(signed.ok).toBe(true)
      expect(service.view().devices).toHaveLength(1)
      indicators.length = 0
      await service.regenerate()
      expect(service.view().devices).toEqual([])
      expect(indicators.length).toBeGreaterThan(0)
    })

    it('makes a one-time link that expires in 10 minutes', async () => {
      await service.set({ enabled: true })
      const r = service.addDevice()
      expect(r.ok && r.expiresAt).toBe(clock + 10 * 60 * 1000)
      expect(r.ok && r.link).toMatch(/#t=/)
    })
  })

  describe('devices', () => {
    function signIn(name: string): string {
      const added = devices.add(name, 'link')
      if (!added) throw new Error('store full')
      return added.device.id
    }

    it('lists devices with whether a socket of each is open', () => {
      const a = signIn('Phone')
      clock += 1000
      const b = signIn('Laptop')
      open.set(a, 1)
      const list = service.view().devices
      expect(list.map((d) => [d.name, d.connected])).toEqual([['Laptop', false], ['Phone', true]])
      expect(list.find((d) => d.id === b)).toMatchObject({ mode: 'link' })
      // Nothing secret about a device reaches the view.
      expect(JSON.stringify(list)).not.toMatch(/secret|hash/i)
    })

    it('revokes one device from the list; an unknown or non-string id is false', () => {
      const a = signIn('Phone')
      const b = signIn('Laptop')
      expect(service.revoke('nope')).toBe(false)
      expect(service.revoke(42)).toBe(false)
      expect(service.revoke(a)).toBe(true)
      expect(service.view().devices.map((d) => d.id)).toEqual([b])
    })

    it('revokes all and counts them', () => {
      signIn('a')
      signIn('b')
      expect(service.revokeAll()).toBe(2)
      expect(service.view().devices).toEqual([])
      expect(service.revokeAll()).toBe(0)
    })

    it('disconnect closes sockets but keeps the device signed in', () => {
      const a = signIn('Phone')
      open.set(a, 2)
      expect(service.disconnect(a)).toBe(true)
      expect(disconnected).toEqual([a])
      expect(service.view().devices).toHaveLength(1)
      expect(service.disconnect('nobody')).toBe(false)
      expect(service.disconnect(null)).toBe(false)
      expect(disconnected).toEqual([a, 'nobody'])
    })

    it('tells the desktop when a device signs in, is revoked, or a socket opens or closes', () => {
      const a = signIn('Phone')
      expect(indicators).toHaveLength(1)
      open.set(a, 1)
      connectionListener?.()
      expect(indicators.at(-1)).toEqual({ connected: 1 })
      service.revoke(a)
      expect(indicators.length).toBe(3)
    })
  })

  describe('the indicator', () => {
    it('counts connected devices, not sockets', () => {
      open.set('a', 3)
      open.set('b', 1)
      expect(service.indicator()).toEqual({ connected: 2 })
    })

    it('counts every socket of the anonymous None device', () => {
      open.set('none', 3)
      open.set('b', 2)
      expect(service.indicator()).toEqual({ connected: 4 })
    })

    it('warns only while a risky choice is live', async () => {
      // A hand-edited file asks for none on a network address: refused, nothing listens, no badge.
      stored = { enabled: true, bind: '0.0.0.0', mode: 'none' }
      status = { state: 'refused', reason: 'x' }
      expect(service.indicator().warning).toBeUndefined()
      expect(service.view().risks).toEqual([])
      // Were it listening (Task 28 lifts the refusal), the badge shows.
      status = { state: 'listening', bind: '0.0.0.0', port: 7330 }
      expect(service.indicator().warning).toMatch(/Sign-in is off/)
      expect(service.view().risks.length).toBeGreaterThan(0)
    })
  })
})
