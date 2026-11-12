// Settings › General › Web access, main's side (plan Task 9): the strict change validation
// (settings.ts `applyWebAccessPatch`), the risk rule for the warning badge, and the service that stores
// a change, applies it to the gateway and answers the page (access-service.ts).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog } from '../../src/main/web/access-log'
import { SERVER_TURNED_ON_LINE, WebAccessService, type GatewayLike } from '../../src/main/web/access-service'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import { PasswordHasher } from '../../src/main/web/password'
import type { GatewayStatus } from '../../src/main/web/gateway'
import {
  applyWebAccessPatch,
  DEFAULT_WEB_ACCESS,
  listenPlanOf,
  SERVER_NO_CONFIRM_MODE,
  SERVER_ONLY_WAY_IN,
  serverConfirmCommand,
  serverStartSettings,
  storedWebAccess,
  webAccessOf,
  webAccessRiskIds,
  webAccessRisks
} from '../../src/main/web/settings'
import type { WebAccessSettings } from '../../src/shared/types'
import { SERVER_NONE_WARNING, type WebAccessIndicator, type WebAccessSetReply, type WebAccessView } from '../../src/shared/web-access'

const base: WebAccessSettings = { ...DEFAULT_WEB_ACCESS, hosts: [] }

/** The page a saved change answers with; a `needsConfirm` reply fails the test. */
function pageOf(reply: WebAccessSetReply): WebAccessView {
  if ('needsConfirm' in reply) throw new Error(`asked to confirm ${reply.needsConfirm.join(', ')}`)
  return reply
}

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
    const withBind = { ...base, bind: '127.0.0.2', tls: { certPath: '/c', keyPath: '/k' } }
    expect(patched({ port: 8000 }, withBind)).toMatchObject({ bind: '127.0.0.2', tls: { certPath: '/c', keyPath: '/k' }, port: 8000 })
  })

  it.each([80, 1023, 65536, 1.5, '7330', null, NaN, Infinity])('refuses the port %j', (port) => {
    expect(refused({ port })).toMatch(/port must be a whole number from 1024 to 65535/)
  })

  // Server mode's folder browser start (design-web.md §9.8): absolute and normalized, cleared by
  // null or '', a damaged stored value read as none, kept and dropped by storedWebAccess.
  it('takes the start folder as an absolute path (normalized), clears it on empty or null, refuses a relative one', () => {
    expect(patched({ startFolder: ' /srv//projects/../work/ ' })).toEqual({ ...base, startFolder: '/srv/work' })
    const withStart = { ...base, startFolder: '/srv/work' }
    expect(patched({ startFolder: null }, withStart)).toEqual(base)
    expect(patched({ startFolder: '' }, withStart)).toEqual(base)
    for (const bad of ['srv', '~/src', '/a\0b', 3, true, `/${'a'.repeat(5000)}`]) expect(refused({ startFolder: bad })).toMatch(/start folder must be a full path/)
    // Not part of what listens: no confirm, whatever the bind.
    expect(patched({ startFolder: '/srv' }, { ...base, enabled: true, bind: '0.0.0.0', confirmed: ['plain-http'] })).toMatchObject({ startFolder: '/srv', confirmed: ['plain-http'] })
    expect(webAccessOf({ startFolder: '/srv/./a/' }).startFolder).toBe('/srv/a')
    for (const damaged of ['relative', 5, '', null]) expect(webAccessOf({ startFolder: damaged })).not.toHaveProperty('startFolder')
    expect(storedWebAccess({ startFolder: '/old' }, { ...base, startFolder: '/new' }).startFolder).toBe('/new')
    expect(storedWebAccess({ startFolder: '/old' }, base)).not.toHaveProperty('startFolder')
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

  it('takes every sign-in mode (plan Task 27), and refuses one that does not exist', () => {
    for (const mode of ['link', 'password', 'confirm', 'none'] as const) expect(patched({ mode }).mode).toBe(mode)
    expect(refused({ mode: 'root' })).toMatch(/not a sign-in mode/)
  })

  it('refuses unknown fields and a non-object, and a wrong type for enabled', () => {
    expect(refused({ confirmed: ['plain-http'] })).toMatch(/unknown field "confirmed"/)
    expect(refused({ certPath: '/c' })).toMatch(/unknown field/)
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

describe('network binds, TLS and the §4.3 confirms (plan Task 28)', () => {
  const TLS = { certPath: '/etc/cc/cert.pem', keyPath: '/etc/cc/key.pem' }

  /** The risks a change asks to confirm; fails when it was saved or refused for another reason. */
  function asks(patch: unknown, from: WebAccessSettings = base): string[] {
    const r = applyWebAccessPatch(from, patch)
    if (r.ok || r.needsConfirm === undefined) throw new Error(r.ok ? 'expected a confirm' : r.error)
    return r.needsConfirm
  }

  it('takes an IP address or localhost to listen on, never a name', () => {
    expect(patched({ bind: ' 0.0.0.0 ', confirm: ['plain-http'] }).bind).toBe('0.0.0.0')
    expect(patched({ bind: '[::1]' }).bind).toBe('::1')
    expect(patched({ bind: 'LOCALHOST' }).bind).toBe('localhost')
    expect(patched({ bind: '192.168.1.20' }).bind).toBe('192.168.1.20')
    for (const bad of ['devbox.local', '127.0.0.1.evil.example', '', 'http://0.0.0.0', 7, 'x'.repeat(200)]) {
      expect(refused({ bind: bad }), String(bad)).toMatch(/not an IP address/)
    }
  })

  it('takes certificate and key paths only as full paths, both; null clears them', () => {
    expect(patched({ tls: { certPath: ' /c.pem ', keyPath: '/k.pem' } }).tls).toEqual({ certPath: '/c.pem', keyPath: '/k.pem' })
    expect('tls' in patched({ tls: null }, { ...base, tls: TLS })).toBe(false)
    for (const bad of [{ certPath: 'cert.pem', keyPath: '/k' }, { certPath: '/c' }, { certPath: '/c', keyPath: '' }, { certPath: '/c\0x', keyPath: '/k' }]) {
      expect(refused({ tls: bad }), JSON.stringify(bad)).toMatch(/full path/)
    }
    expect(refused({ tls: '/c' })).toMatch(/certificate file and a key file/)
  })

  it('names the risks of a setting: no sign-in on a network address, plain http on one', () => {
    expect(webAccessRiskIds(base)).toEqual([])
    expect(webAccessRiskIds({ ...base, mode: 'none' })).toEqual([])
    expect(webAccessRiskIds({ ...base, bind: '0.0.0.0' })).toEqual(['plain-http'])
    expect(webAccessRiskIds({ ...base, bind: '0.0.0.0', tls: TLS })).toEqual([])
    expect(webAccessRiskIds({ ...base, bind: '0.0.0.0', tls: TLS, mode: 'none' })).toEqual(['none-network'])
    expect(webAccessRiskIds({ ...base, bind: '10.0.0.4', mode: 'none' })).toEqual(['none-network', 'plain-http'])
    expect(webAccessRiskIds({ ...base, externalOrigin: 'http://box.lan' })).toEqual(['plain-http'])
    expect(webAccessRiskIds({ ...base, externalOrigin: 'https://box.lan' })).toEqual([])
  })

  it('each risky choice made while on needs its confirm; nothing changes until it is given', () => {
    const on = { ...base, enabled: true }
    expect(asks({ bind: '0.0.0.0' }, on)).toEqual(['plain-http'])
    expect(asks({ enabled: true, bind: '192.168.1.20' })).toEqual(['plain-http'])
    expect(asks({ externalOrigin: 'http://box.lan' }, on)).toEqual(['plain-http'])
    const lanTls = patched({ bind: '0.0.0.0', tls: TLS }, on)
    expect(lanTls.confirmed).toBeUndefined()
    expect(asks({ mode: 'none' }, lanTls)).toEqual(['none-network'])
    // Both at once: both are asked, and confirming one of them is not enough.
    expect(asks({ bind: '10.0.0.4', mode: 'none' }, on)).toEqual(['none-network', 'plain-http'])
    expect(asks({ bind: '10.0.0.4', mode: 'none', confirm: ['none-network'] }, on)).toEqual(['plain-http'])
    expect(on.bind).toBe('127.0.0.1')
  })

  it('a confirmed change is saved with its confirm, which carries over to the next change while the risk stays', () => {
    const on = { ...base, enabled: true }
    const lan = patched({ bind: '0.0.0.0', confirm: ['plain-http'] }, on)
    expect(lan).toMatchObject({ bind: '0.0.0.0', confirmed: ['plain-http'] })
    expect(patched({ port: 8000 }, lan).confirmed).toEqual(['plain-http'])
    // Removing the risk drops its confirm, so choosing it again asks again.
    const back = patched({ bind: '127.0.0.1' }, lan)
    expect(back.confirmed).toBeUndefined()
    expect(asks({ bind: '0.0.0.0' }, back)).toEqual(['plain-http'])
    // So does TLS: plain http is no longer the case, and dropping the certificate later asks.
    const tls = patched({ tls: TLS }, lan)
    expect(tls.confirmed).toBeUndefined()
    expect(asks({ tls: null }, tls)).toEqual(['plain-http'])
  })

  it('a confirm of a risk the setting does not have is not stored; a stale one in the file confirms nothing', () => {
    expect(patched({ port: 8000, confirm: ['none-network', 'plain-http'] }).confirmed).toBeUndefined()
    const stale = { ...base, enabled: true, confirmed: ['plain-http' as const] }
    expect(asks({ bind: '0.0.0.0' }, stale)).toEqual(['plain-http'])
    expect(refused({ confirm: ['root'] })).toMatch(/list of risks/)
    expect(refused({ confirm: 'plain-http' })).toMatch(/list of risks/)
  })

  it('turning off never asks and drops every confirm, so turning on asks again for each risk', () => {
    const lan = patched({ bind: '0.0.0.0', confirm: ['plain-http'] }, { ...base, enabled: true })
    const off = patched({ enabled: false, mode: 'none' }, lan)
    expect(off).toMatchObject({ enabled: false, mode: 'none', bind: '0.0.0.0' })
    expect(off.confirmed).toBeUndefined()
    expect(asks({ enabled: true }, off)).toEqual(['none-network', 'plain-http'])
    // Off and straight on again, nothing else changed: still asks (review finding, task 28).
    expect(asks({ enabled: true }, patched({ enabled: false }, lan))).toEqual(['plain-http'])
    const offLan = patched({ bind: '10.0.0.4' })
    expect(offLan.confirmed).toBeUndefined()
    expect(asks({ enabled: true }, offLan)).toEqual(['plain-http'])
    // A confirm left in a file that is off (a hand edit, or a file from before this rule) carries nothing.
    expect(asks({ enabled: true }, { ...offLan, confirmed: ['plain-http'] })).toEqual(['plain-http'])
    // A confirm sent with a change that leaves web access off is not stored either.
    expect(patched({ bind: '0.0.0.0', confirm: ['plain-http'] }).confirmed).toBeUndefined()
  })

  it('a confirm holds only for the exposure it was given for: another bind, origin or TLS asks again', () => {
    const on = { ...base, enabled: true }
    // plain http confirmed for an http: proxy origin on loopback does not cover the gateway itself on 0.0.0.0.
    const proxy = patched({ externalOrigin: 'http://box.lan', confirm: ['plain-http'] }, on)
    expect(proxy.confirmed).toEqual(['plain-http'])
    expect(asks({ bind: '0.0.0.0' }, proxy)).toEqual(['plain-http'])
    // None confirmed on one LAN address does not cover every address; nor plain http.
    const lanNone = patched({ bind: '10.0.0.4', mode: 'none', confirm: ['none-network', 'plain-http'] }, on)
    expect(lanNone.confirmed).toEqual(['none-network', 'plain-http'])
    expect(asks({ bind: '0.0.0.0' }, lanNone)).toEqual(['none-network', 'plain-http'])
    // A proxy's http origin on a TLS bind: dropping TLS (the gateway's own leg goes plain) asks again,
    // and so does another origin.
    const tlsProxy = patched({ bind: '0.0.0.0', tls: TLS, externalOrigin: 'http://box.lan', confirm: ['plain-http'] }, on)
    expect(asks({ tls: null }, tlsProxy)).toEqual(['plain-http'])
    expect(asks({ externalOrigin: 'http://other.lan' }, tlsProxy)).toEqual(['plain-http'])
    // None does not depend on TLS: adding a certificate keeps its confirm (and ends plain http's).
    const lanTlsNone = patched({ tls: TLS }, lanNone)
    expect(lanTlsNone.confirmed).toEqual(['none-network'])
    // What the risks do not depend on (port, hosts, mode between signed-in modes) keeps them.
    expect(patched({ port: 8000, hosts: ['box.lan'] }, lanNone).confirmed).toEqual(['none-network', 'plain-http'])
    expect(patched({ mode: 'password' }, patched({ bind: '0.0.0.0', confirm: ['plain-http'] }, on)).confirmed).toEqual(['plain-http'])
  })

  it('listens on a network address only with TLS or the confirm; a hand-edited risk is refused', () => {
    const plan = (over: object): ReturnType<typeof listenPlanOf> => listenPlanOf(webAccessOf({ enabled: true, ...over }))
    expect(plan({ bind: '0.0.0.0' })).toEqual({ ok: false, reason: expect.stringMatching(/plain http on a network address needs a certificate, or the confirm/) })
    expect(plan({ bind: '0.0.0.0', confirmed: ['plain-http'] })).toMatchObject({ ok: true, bind: '0.0.0.0' })
    expect(plan({ bind: '0.0.0.0', tls: TLS })).toMatchObject({ ok: true, bind: '0.0.0.0', tls: TLS })
    expect(plan({ bind: '0.0.0.0', tls: TLS, mode: 'none' })).toEqual({ ok: false, reason: expect.stringMatching(/no sign-in on a network address needs the confirm/) })
    expect(plan({ bind: '0.0.0.0', tls: TLS, mode: 'none', confirmed: ['none-network'] })).toMatchObject({ ok: true })
    expect(plan({ externalOrigin: 'http://box.lan' }).ok).toBe(false)
    expect(plan({ externalOrigin: 'http://box.lan', confirmed: ['plain-http'] }).ok).toBe(true)
    // A relative certificate path reads as no TLS: plain http, never confirmed, refused.
    expect(plan({ bind: '0.0.0.0', tls: { certPath: 'cert.pem', keyPath: '/k' } }).ok).toBe(false)
    expect(plan({ bind: 'devbox.local', confirmed: ['plain-http'] })).toEqual({ ok: false, reason: expect.stringMatching(/not an IP address/) })
    // Unknown entries in the file are dropped.
    expect(webAccessOf({ confirmed: ['plain-http', 'root', 7] }).confirmed).toEqual(['plain-http'])
  })

  it('stores every edited field and removes the cleared ones from the file', () => {
    const next = { ...base, enabled: true, bind: '0.0.0.0', tls: TLS, confirmed: ['none-network' as const], mode: 'none' as const }
    expect(storedWebAccess({ port: 1, extra: 1 } as Partial<WebAccessSettings>, next)).toEqual({ ...next, extra: 1 })
    const cleared = storedWebAccess(next, { ...base })
    expect('tls' in cleared || 'confirmed' in cleared || 'externalOrigin' in cleared).toBe(false)
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
  let log: AccessLog

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
    log = accessLog
    devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog, now: () => clock })
    // A cheap scrypt (N=2^10): the cost is password.ts's business, its tests use the real one.
    const hasher = new PasswordHasher({ params: { N: 1024, r: 8, p: 1 } })
    auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog, hasher, now: () => clock, log: () => undefined })
    auth.setMode('link')
    service = new WebAccessService({
      gateway,
      auth,
      read: () => stored,
      // What main's index.ts does.
      write: (next) => {
        stored = storedWebAccess(stored as Partial<WebAccessSettings> | undefined, next)
      },
      emit: (i) => indicators.push(i),
      // The terminals' own rule has its test below.
      terminals: { start: () => undefined, drain: async () => undefined },
      accessLog,
      version: '9.8.7'
    })
  })
  afterEach(() => {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is off with the defaults and shows no devices', () => {
    const v = service.view()
    expect(v.form).toEqual({ enabled: false, bind: '127.0.0.1', port: 7330, externalOrigin: '', hosts: [], mode: 'link', certPath: '', keyPath: '' })
    expect(v.network).toBe(false)
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
      },
      version: '9.8.7'
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
    // A stored setting the gateway refuses (a network bind never confirmed) runs no worker either.
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
    const v = pageOf(await service.set({ enabled: true, port: 8123, hosts: ['box.local'] }))
    expect(stored).toMatchObject({ enabled: true, port: 8123, hosts: ['box.local:8123'] })
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ enabled: true, port: 8123 })
    expect(v.gateway).toEqual({ state: 'listening', bind: '127.0.0.1', port: 8123, origin: 'http://127.0.0.1:8123' })
    expect(webAccessOf(stored).port).toBe(8123)
  })

  it('refuses an invalid change with its reason, stores nothing and does not touch the gateway', async () => {
    await expect(service.set({ port: 80 })).rejects.toThrow(/port must be a whole number/)
    // The password mode with no password set would let nobody in: the page sets one first.
    await expect(service.set({ mode: 'password' })).rejects.toThrow(/set a password first/)
    expect(stored).toBeUndefined()
    expect(applied).toEqual([])
  })

  it('keeps a saved change the gateway could not act on, and shows the reason', async () => {
    gateway.apply = async (settings) => {
      applied.push(settings)
      status = { state: 'failed', reason: 'EADDRINUSE' }
      return status
    }
    const v = pageOf(await service.set({ enabled: true }))
    expect(webAccessOf(stored).enabled).toBe(true)
    expect(v.gateway).toEqual({ state: 'failed', reason: 'EADDRINUSE' })
  })

  describe('the §4.3 confirms (plan Task 28)', () => {
    it('a refused or cancelled confirm leaves loopback: nothing is stored and the gateway is not touched', async () => {
      expect(await service.set({ enabled: true, bind: '0.0.0.0' })).toEqual({ needsConfirm: ['plain-http'] })
      expect(stored).toBeUndefined()
      expect(applied).toEqual([])
      expect(service.view().form.bind).toBe('127.0.0.1')
      // Already on, on loopback: the same, and it stays listening there.
      await service.set({ enabled: true })
      applied.length = 0
      expect(await service.set({ bind: '192.168.1.20' })).toEqual({ needsConfirm: ['plain-http'] })
      expect(webAccessOf(stored).bind).toBe('127.0.0.1')
      expect(applied).toEqual([])
    })

    it('plain http on the LAN after the confirm: stored, applied, and the warning badge is on', async () => {
      const v = pageOf(await service.set({ enabled: true, bind: '0.0.0.0', confirm: ['plain-http'] }))
      expect(stored).toMatchObject({ bind: '0.0.0.0', confirmed: ['plain-http'] })
      expect(applied.at(-1)).toMatchObject({ bind: '0.0.0.0', confirmed: ['plain-http'] })
      expect(listenPlanOf(applied.at(-1) as WebAccessSettings).ok).toBe(true)
      expect(v.network).toBe(true)
      expect(v.risks).toEqual([expect.stringMatching(/Plain http on a network/)])
      expect(service.indicator().warning).toMatch(/Plain http on a network/)
    })

    it('None on the LAN after the confirm (with TLS): listens, and the badge says anyone can get in', async () => {
      const tls = { certPath: '/etc/cc/cert.pem', keyPath: '/etc/cc/key.pem' }
      expect(await service.set({ enabled: true, bind: '0.0.0.0', tls, mode: 'none' })).toEqual({ needsConfirm: ['none-network'] })
      expect(stored).toBeUndefined()
      const v = pageOf(await service.set({ enabled: true, bind: '0.0.0.0', tls, mode: 'none', confirm: ['none-network'] }))
      expect(v.form).toMatchObject({ bind: '0.0.0.0', mode: 'none', certPath: tls.certPath, keyPath: tls.keyPath })
      expect(listenPlanOf(applied.at(-1) as WebAccessSettings)).toMatchObject({ ok: true, bind: '0.0.0.0', tls })
      expect(service.indicator().warning).toMatch(/Sign-in is off on a network address/)
      expect(service.indicator().warning).not.toMatch(/Plain http/)
    })

    it('the badge shows only while listening: a refused risk is no live risk', async () => {
      stored = { enabled: true, bind: '0.0.0.0' }
      status = { state: 'refused', reason: 'not confirmed' }
      expect(service.view().risks).toEqual([])
      expect(service.indicator().warning).toBeUndefined()
    })

    it('a link over TLS is https', async () => {
      await service.set({ enabled: true, tls: { certPath: '/c.pem', keyPath: '/k.pem' } })
      const reply = await service.link()
      expect(reply.ok && reply.link).toMatch(/^https:\/\/127\.0\.0\.1:7330\/#t=/)
    })
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

  describe('password and desktop confirm (plan Task 27)', () => {
    it('sets a password, then the password mode can be picked; the view says whether one is set', async () => {
      expect(service.view().passwordSet).toBe(false)
      expect(await service.setPassword('short')).toEqual({ ok: false, reason: expect.stringMatching(/at least 8/) })
      expect(await service.setPassword(42)).toEqual({ ok: false, reason: expect.stringMatching(/must be text/) })
      indicators.length = 0
      expect(await service.setPassword('correct horse')).toEqual({ ok: true })
      expect(indicators.length).toBeGreaterThan(0)
      expect(service.view().passwordSet).toBe(true)
      // The card's credential states (design-web.md §9.5): states only, read without a decrypt.
      expect(service.view().credentials).toEqual({ accessLink: 'unset', password: 'set' })
      // Nothing of the password or its hash reaches the view.
      expect(JSON.stringify(service.view())).not.toMatch(/correct horse|scrypt/)
      const v = pageOf(await service.set({ enabled: true, mode: 'password' }))
      expect(v.form.mode).toBe('password')
    })

    // Others can reach the gateway (a network bind, a proxy's external origin, server mode): 12
    // characters. A shorter one set while on loopback keeps working, with a hint in the view.
    it('asks 12 characters once others can reach the gateway, and hints at an older shorter password', async () => {
      expect(service.view().passwordMinLength).toBe(8)
      expect(await service.setPassword('eightchr')).toEqual({ ok: true })
      expect(service.view().passwordShort).toBe(false)
      await service.set({ enabled: true, bind: '0.0.0.0', confirm: ['plain-http'] })
      expect(service.view().passwordMinLength).toBe(12)
      expect(service.view().passwordShort).toBe(true)
      expect(service.cliStatus({ store: 'fake', unavailable: null, otherMode: 0, replaced: 0 }, []).passwordShort).toBe(true)
      expect(await service.setPassword('elevenchars')).toEqual({ ok: false, reason: expect.stringMatching(/at least 12/) })
      expect(await service.setPassword('twelve chars')).toEqual({ ok: true })
      expect(service.view().passwordShort).toBe(false)
      await service.set({ bind: '127.0.0.1', externalOrigin: 'https://box.example' })
      expect(service.view().passwordMinLength).toBe(12)
      await service.set({ externalOrigin: null })
      expect(service.view().passwordMinLength).toBe(8)
    })

    it('asks 12 characters in server mode, on loopback too', async () => {
      const server = new WebAccessService({
        gateway,
        auth,
        read: () => stored,
        write: () => undefined,
        emit: () => undefined,
        terminals: { start: () => undefined, drain: async () => undefined },
        accessLog: log,
        version: '9.8.7',
        server: true
      })
      try {
        expect(server.view().passwordMinLength).toBe(12)
        expect(await server.setPassword('elevenchars')).toEqual({ ok: false, reason: expect.stringMatching(/at least 12/) })
      } finally {
        server.dispose()
      }
    })

    it('shows a browser waiting for a confirm in the indicator (never its code), and takes the answer', async () => {
      await service.set({ enabled: true, mode: 'confirm' })
      auth.setMode('confirm')
      indicators.length = 0
      const asked = await auth.requestConfirm({ name: 'Phone' })
      if (!asked.ok) throw new Error(asked.error)
      const shown = indicators.at(-1)?.confirm
      expect(shown).toEqual({ id: expect.any(String), name: 'Phone', expiresAt: asked.expiresAt })
      expect(JSON.stringify(indicators)).not.toContain(asked.code)
      expect(JSON.stringify(indicators)).not.toContain(asked.ticket)
      expect(service.answerConfirm({ id: shown?.id, allow: true, code: '' })).toEqual({ ok: false, reason: expect.stringMatching(/not the code/) })
      expect(service.answerConfirm('junk')).toEqual({ ok: false, reason: expect.stringMatching(/no longer waiting/) })
      expect(service.answerConfirm({ id: shown?.id, allow: true, code: asked.code })).toEqual({ ok: true })
      expect(service.indicator().confirm).toBeUndefined()
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

    // design-web.md §9.6: a server's browser revokes and disconnects from its card; web-access.log
    // names the acting device (main's, from the view it bound) next to the device acted on.
    it('logs the acting browser of a revoke, a revoke all and a disconnect', () => {
      const phone = { device: 'dev-phone', name: 'Phone' }
      const a = signIn('Laptop')
      const b = signIn('Tablet')
      open.set(b, 1)
      expect(service.disconnect(b, phone)).toBe(true)
      expect(service.revoke(a, { by: phone })).toBe(true)
      signIn('Watch')
      expect(service.revokeAll({ by: phone })).toBe(2)
      const acted = log.recent().filter((e) => e.event === 'revoke' || e.event === 'disconnect')
      expect(acted).toEqual([
        { at: expect.any(String), event: 'disconnect', device: b, name: 'Tablet', detail: 'disconnected from a browser', by: 'dev-phone', byName: 'Phone' },
        { at: expect.any(String), event: 'revoke', device: a, name: 'Laptop', detail: 'revoked from a browser', by: 'dev-phone', byName: 'Phone' },
        { at: expect.any(String), event: 'revoke', device: b, name: 'Tablet', detail: 'revoked from a browser', by: 'dev-phone', byName: 'Phone' },
        { at: expect.any(String), event: 'revoke', device: expect.any(String), name: 'Watch', detail: 'revoked from a browser', by: 'dev-phone', byName: 'Phone' }
      ])
      // On disk too, as one JSON line each.
      const lines = readFileSync(join(dir, 'logs', 'web-access.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(lines.filter((l) => l['by'] === 'dev-phone')).toHaveLength(4)
    })

    it('keeps the desktop and shell reasons, with no acting device, and logs no disconnect that closed nothing', () => {
      const a = signIn('Laptop')
      const b = signIn('Tablet')
      expect(service.disconnect(a, { device: 'dev-phone', name: 'Phone' })).toBe(false)
      expect(service.disconnect(a)).toBe(false)
      service.revoke(a)
      service.revoke(b, { reason: 'revoked from the server shell (ccc web revoke)' })
      const acted = log.recent().filter((e) => e.event === 'revoke' || e.event === 'disconnect')
      expect(acted.map((e) => [e.event, e.detail, e.by])).toEqual([
        ['revoke', 'revoked on the desktop', undefined],
        ['revoke', 'revoked from the server shell (ccc web revoke)', undefined]
      ])
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

describe('server mode: applyWebAccessPatch (design-web.md §9.2)', () => {
  const on = { ...base, enabled: true }
  const server = { server: true }

  it('refuses turning web access off and the desktop-confirm mode, with the reason, only in server mode', () => {
    expect(applyWebAccessPatch(on, { enabled: false }, server)).toEqual({ ok: false, error: SERVER_ONLY_WAY_IN })
    expect(applyWebAccessPatch(on, { mode: 'confirm' }, server)).toEqual({ ok: false, error: SERVER_NO_CONFIRM_MODE })
    expect(SERVER_NO_CONFIRM_MODE).toMatch(/no desktop/)
    // The desktop keeps both.
    expect(applyWebAccessPatch(on, { enabled: false })).toMatchObject({ ok: true, value: { enabled: false } })
    expect(applyWebAccessPatch(on, { mode: 'confirm' }, { server: false })).toMatchObject({ ok: true, value: { mode: 'confirm' } })
  })

  it('takes the other modes, and None on loopback needs no confirm', () => {
    for (const mode of ['link', 'password', 'none'] as const) {
      expect(applyWebAccessPatch(on, { mode }, server)).toMatchObject({ ok: true, value: { mode } })
    }
    expect(applyWebAccessPatch(on, { mode: 'none', bind: '127.0.0.1' }, server)).toMatchObject({ ok: true })
  })

  it('the §4.3 confirms apply to network binds as on the desktop', () => {
    expect(applyWebAccessPatch(on, { bind: '0.0.0.0' }, server)).toMatchObject({ ok: false, needsConfirm: ['plain-http'] })
    expect(applyWebAccessPatch(on, { mode: 'none', bind: '10.0.0.4' }, server)).toMatchObject({
      ok: false,
      needsConfirm: ['none-network', 'plain-http']
    })
    const r = applyWebAccessPatch(on, { bind: '0.0.0.0', confirm: ['plain-http'] }, server)
    expect(r).toMatchObject({ ok: true, value: { bind: '0.0.0.0', confirmed: ['plain-http'] } })
  })
})

describe('server mode: what start writes (design-web.md §9.2)', () => {
  it('writes web access on and link over desktop confirm; nothing when it already runs so', () => {
    expect(serverStartSettings(base)).toEqual({ ...base, enabled: true })
    expect(serverStartSettings({ ...base, mode: 'confirm' })).toEqual({ ...base, enabled: true, mode: 'link' })
    expect(serverStartSettings({ ...base, enabled: true, mode: 'confirm' })).toEqual({ ...base, enabled: true, mode: 'link' })
    for (const mode of ['link', 'password', 'none'] as const) expect(serverStartSettings({ ...base, enabled: true, mode })).toBeUndefined()
  })

  it('never makes a risky setting safer, and a confirm left in a record that was off confirms nothing', () => {
    const off = { ...base, bind: '0.0.0.0', mode: 'none' as const, confirmed: ['none-network', 'plain-http'] as WebAccessSettings['confirmed'] }
    const next = serverStartSettings(off)
    expect(next).toEqual({ ...base, enabled: true, bind: '0.0.0.0', mode: 'none' })
    expect(listenPlanOf(next as WebAccessSettings).ok).toBe(false)
    // Already on and confirmed: the confirms stay with it.
    const confirmed = { ...base, enabled: true, bind: '0.0.0.0', confirmed: ['plain-http'] as WebAccessSettings['confirmed'] }
    expect(serverStartSettings(confirmed)).toBeUndefined()
  })

  it('builds the ccc web set line for the unconfirmed risks from the stored record, and that line applies them', () => {
    expect(serverConfirmCommand({ ...base, enabled: true })).toBeUndefined()
    expect(serverConfirmCommand({ ...base, enabled: true, bind: '0.0.0.0' })).toBe('ccc web set --bind 0.0.0.0 --confirm plain-http')
    const both = { ...base, enabled: true, bind: '10.0.0.4', mode: 'none' as const }
    expect(serverConfirmCommand(both)).toBe('ccc web set --bind 10.0.0.4 --confirm none-network --confirm plain-http')
    expect(serverConfirmCommand({ ...both, confirmed: ['none-network'] })).toBe('ccc web set --bind 10.0.0.4 --confirm plain-http')
    // An http proxy origin on a network name: the bind stays loopback and only the confirm is new.
    expect(serverConfirmCommand({ ...base, enabled: true, externalOrigin: 'http://box.lan' })).toBe('ccc web set --bind 127.0.0.1 --confirm plain-http')
    // A bind no confirm can fix has no line.
    expect(serverConfirmCommand({ ...base, enabled: true, bind: 'box.lan' })).toBeUndefined()
    // What the line asks for, as `ccc web set` will send it (Task 12), listens.
    const r = applyWebAccessPatch(both, { bind: '10.0.0.4', confirm: ['none-network', 'plain-http'] }, { server: true })
    expect(r.ok && listenPlanOf(r.value).ok).toBe(true)
  })
})

describe('server mode: WebAccessService start and first lines (design-web.md §9.2, §9.3)', () => {
  let dir: string
  let stored: unknown
  let accessLog: AccessLog
  let auth: WebAuth
  let status: GatewayStatus
  const WRAPPER = '/data/bin/ccc'

  /** A gateway that refuses as the real one does (listenPlanOf), or fails when told to. */
  function make(server: boolean, fail?: string): WebAccessService {
    const gateway: GatewayLike = {
      async apply(settings) {
        const plan = listenPlanOf(settings)
        if (!settings.enabled) status = { state: 'off' }
        else if (!plan.ok) status = { state: 'refused', reason: plan.reason }
        else if (fail !== undefined) status = { state: 'failed', reason: fail }
        else status = { state: 'listening', bind: settings.bind, port: settings.port }
        auth.setMode(settings.mode)
        return status
      },
      status: () => status,
      connections: () => new Map(),
      disconnectDevice: () => 0,
      onConnectionsChanged: () => () => undefined
    }
    return new WebAccessService({
      gateway,
      auth,
      read: () => stored,
      write: (next) => {
        stored = storedWebAccess(stored as Partial<WebAccessSettings> | undefined, next)
      },
      emit: () => undefined,
      terminals: { start: () => undefined, drain: async () => undefined },
      server,
      version: '9.8.7'
    })
  }

  /** One start as main runs it: the write, the apply, the lines. */
  async function startOnce(options: { server?: boolean; tty: boolean; fail?: string }): Promise<string[]> {
    const service = make(options.server ?? true, options.fail)
    const lines: string[] = []
    const turnedOn = service.serverStart()
    if (turnedOn !== undefined) lines.push(turnedOn)
    await service.apply()
    lines.push(...service.serverStartLines({ tty: options.tty, wrapperPath: WRAPPER }))
    service.dispose()
    return lines
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-web-server-'))
    stored = undefined
    status = { state: 'off' }
    accessLog = new AccessLog({ filePath: join(dir, 'logs', 'web-access.log') })
    const devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog })
    auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog, log: () => undefined })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a link that cannot be given says so in server terms (ccc web), the desktop keeps its Settings wording', async () => {
    stored = { enabled: true, mode: 'link', bind: '0.0.0.0' }
    const server = make(true)
    await server.apply()
    expect(await server.link()).toEqual({ ok: false, reason: expect.stringMatching(/^web access is not listening.*`ccc web status` says why$/) })
    expect(server.addDevice()).toEqual({ ok: false, reason: expect.stringMatching(/^web access is not listening/) })
    stored = { enabled: true, mode: 'password' }
    await server.apply()
    expect(server.addDevice()).toEqual({ ok: false, reason: 'links work only in the access-link mode: `ccc web mode link` switches to it' })
    server.dispose()
    stored = { enabled: false }
    const desktop = make(false)
    await desktop.apply()
    expect(await desktop.link()).toEqual({ ok: false, reason: expect.stringMatching(/^Turn web access on first/) })
    stored = { enabled: true, mode: 'password' }
    await desktop.apply()
    expect(desktop.addDevice()).toEqual({ ok: false, reason: 'Links work only in the access-link mode.' })
    desktop.dispose()
  })

  it('a fresh data dir: on, link mode, loopback; the "turned on" line on the first start only', async () => {
    const first = await startOnce({ tty: false })
    expect(webAccessOf(stored)).toMatchObject({ enabled: true, mode: 'link', bind: '127.0.0.1', port: 7330 })
    expect(first.filter((l) => l === SERVER_TURNED_ON_LINE)).toHaveLength(1)
    expect(first[0]).toBe(SERVER_TURNED_ON_LINE)
    const second = await startOnce({ tty: false })
    expect(second).not.toContain(SERVER_TURNED_ON_LINE)
    expect(second).toEqual(['cc-cockpit server mode: web access on http://127.0.0.1:7330', 'add a device: ccc web add-device', `ccc for a shell on this server: ${WRAPPER}`])
  })

  it('writes a stored off and a stored desktop confirm, keeping every other field', async () => {
    stored = { enabled: false, mode: 'confirm', port: 8123, hosts: ['box.lan'], somethingElse: 1 }
    const lines = await startOnce({ tty: false })
    expect(lines[0]).toBe(SERVER_TURNED_ON_LINE)
    expect(stored).toMatchObject({ enabled: true, mode: 'link', port: 8123, hosts: ['box.lan:8123'], somethingElse: 1 })
  })

  it('the desktop writes and prints nothing', async () => {
    stored = { enabled: false, mode: 'confirm' }
    const service = make(false)
    expect(service.serverStart()).toBeUndefined()
    expect(stored).toEqual({ enabled: false, mode: 'confirm' })
    expect(service.serverStartLines({ tty: true, wrapperPath: WRAPPER })).toEqual([])
    service.dispose()
  })

  it('a turn-off or desktop confirm from a change is refused through the service in server mode', async () => {
    const service = make(true)
    service.serverStart()
    await expect(service.set({ enabled: false })).rejects.toThrow(SERVER_ONLY_WAY_IN)
    await expect(service.set({ mode: 'confirm' })).rejects.toThrow(/desktop confirm/)
    expect(webAccessOf(stored)).toMatchObject({ enabled: true, mode: 'link' })
    service.dispose()
  })

  it('on a terminal in link mode: a one-time link that works once; off a terminal none', async () => {
    const lines = await startOnce({ tty: true })
    const linkLine = lines.find((l) => l.includes('#t='))
    expect(linkLine).toMatch(/^Add a device \(works once, expires in 10 minutes\): http:\/\/127\.0\.0\.1:7330\/#t=[A-Za-z0-9_-]{43}$/)
    const token = (linkLine ?? '').split('#t=')[1] ?? ''
    expect(await auth.signInWithToken({ token, name: 'Phone' })).toMatchObject({ ok: true, device: { mode: 'add' } })
    expect(await auth.signInWithToken({ token })).toMatchObject({ ok: false, status: 401 })
    // The log says a start link was issued and used, never the link.
    expect(accessLog.recent().filter((e) => e.event === 'start-link').map((e) => e.detail)).toEqual(['issued', 'used'])
    expect(readFileSync(join(dir, 'logs', 'web-access.log'), 'utf8')).not.toContain(token)
    expect((await startOnce({ tty: false })).some((l) => l.includes('#t='))).toBe(false)
  })

  it('points at the external origin when one is set', async () => {
    stored = { enabled: true, externalOrigin: 'https://box.tailnet.ts.net' }
    const lines = await startOnce({ tty: true })
    expect(lines[0]).toBe('cc-cockpit server mode: web access on https://box.tailnet.ts.net')
    expect(lines[1]).toMatch(/: https:\/\/box\.tailnet\.ts\.net\/#t=/)
  })

  it('password mode prints the address; None the address and the shared-server warning; neither a link', async () => {
    stored = { enabled: true, mode: 'password' }
    expect(await startOnce({ tty: true })).toEqual(['cc-cockpit server mode: web access on http://127.0.0.1:7330', `ccc for a shell on this server: ${WRAPPER}`])
    stored = { enabled: true, mode: 'none' }
    const none = await startOnce({ tty: true })
    expect(none).toEqual(['cc-cockpit server mode: web access on http://127.0.0.1:7330', SERVER_NONE_WARNING, `ccc for a shell on this server: ${WRAPPER}`])
    expect(SERVER_NONE_WARNING).toMatch(/every user of this machine/)
    expect(accessLog.recent().some((e) => e.event === 'start-link')).toBe(false)
  })

  it('a stored unconfirmed risk: refused, the reason and the exact line, no link, the record unchanged', async () => {
    stored = { enabled: true, bind: '0.0.0.0', mode: 'link' }
    const before = JSON.stringify(stored)
    const lines = await startOnce({ tty: true })
    expect(status.state).toBe('refused')
    expect(lines).toEqual([
      expect.stringMatching(/^server mode: web access is not listening: plain http on a network address/),
      'to listen anyway, run: ccc web set --bind 0.0.0.0 --confirm plain-http',
      `ccc for a shell on this server: ${WRAPPER}`
    ])
    expect(JSON.stringify(stored)).toBe(before)
    expect(lines.some((l) => l.includes('#t='))).toBe(false)
    expect(accessLog.recent()).toEqual([])
  })

  it('a record that was off with a risk is turned on, then refused with its line: never made safer', async () => {
    stored = { enabled: false, bind: '10.0.0.4', mode: 'none', confirmed: ['none-network', 'plain-http'] }
    const lines = await startOnce({ tty: true })
    expect(lines[0]).toBe(SERVER_TURNED_ON_LINE)
    expect(lines).toContain('to listen anyway, run: ccc web set --bind 10.0.0.4 --confirm none-network --confirm plain-http')
    expect(stored).toMatchObject({ enabled: true, bind: '10.0.0.4', mode: 'none' })
    expect(stored).not.toHaveProperty('confirmed')
  })

  it('the gateway failing (a port in use): the reason, no link', async () => {
    const lines = await startOnce({ tty: true, fail: 'port 7330 is in use' })
    expect(lines).toEqual([SERVER_TURNED_ON_LINE, 'server mode: web access is not listening: port 7330 is in use', `ccc for a shell on this server: ${WRAPPER}`])
  })
})
