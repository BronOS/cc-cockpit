// The guest store (main/web/guests.ts): invites minted and redeemed once, every way a guest ends (kick,
// lifetime, its device revoked or expired, its project forgotten), the close codes its views get, the
// tombstone that says "your access ended" (D-32), and the live answers (access, tabVisible, pluginVisible).
// A real DeviceStore on a temp file: the guest section lives in the same web-access.json.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { INVITE_UNUSED_MS, MAX_GUESTS, type GuestInviteRequest } from '../../src/shared/guests'
import { CLOSE, parseInviteFragment } from '../../src/shared/web-protocol'
import { remoteViewId, type ViewId, type Who } from '../../src/shared/views'
import { AccessLog } from '../../src/main/web/access-log'
import { DEVICE_IDLE_MS, DeviceStore, MAX_DEVICES } from '../../src/main/web/devices'
import { ENDED_TOMBSTONE_MS, GuestStore, inviteHash, SWEEP_MS, type GuestStoreDeps, type GuestTabInfo } from '../../src/main/web/guests'
import type { WebAccessMode } from '../../src/shared/types'

let dir: string
let clock: number
let mode: WebAccessMode
let closed: Array<{ guestId: string; code: number }>
let live: Set<string>
let tabs: Map<string, GuestTabInfo>
let shown: Set<string>
let views: Map<ViewId, Who>
let notices: string[]
let dropped: string[]
let ticks: Array<() => void>
let log: AccessLog
let devices: DeviceStore

const P = 'proj1'
const req = (over: Partial<GuestInviteRequest> = {}): GuestInviteRequest => ({ name: 'Bob', role: 'write', scope: 'all', lifetime: 'forever', ...over }) as GuestInviteRequest

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-guests-'))
  clock = 1_700_000_000_000
  mode = 'link'
  closed = []
  live = new Set()
  tabs = new Map([
    ['t1', { projectId: P }],
    ['t2', { projectId: P }],
    ['tp', { projectId: P, openedBy: 'x.hidden' }],
    ['other', { projectId: 'proj2' }]
  ])
  shown = new Set()
  views = new Map()
  notices = []
  dropped = []
  ticks = []
  log = new AccessLog({ now: () => clock })
  devices = newDevices()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function newDevices(): DeviceStore {
  return new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog: log, now: () => clock })
}

function store(over: Partial<GuestStoreDeps> = {}): GuestStore {
  return new GuestStore({
    devices,
    accessLog: log,
    mode: () => mode,
    target: () => ({ origin: 'https://box.example:7330', loopbackOnly: false }),
    pluginShown: (_p, id) => shown.has(id),
    tabOf: (id) => tabs.get(id),
    whoOfView: (v) => views.get(v),
    closeGuestViews: (guestId, code) => {
      closed.push({ guestId, code })
      return 1
    },
    guestLive: (id) => live.has(id),
    dropPageTokens: (d) => dropped.push(d),
    notify: (t) => notices.push(t),
    log: () => {},
    now: () => clock,
    setInterval: (fn) => {
      ticks.push(fn)
      return { stop: () => {} }
    },
    ...over
  })
}

async function invited(s: GuestStore, over: Partial<GuestInviteRequest> = {}): Promise<{ token: string; guestId: string; inviteId: string }> {
  const a = await s.invite(P, req(over))
  if (!a.ok) throw new Error(a.error)
  const parsed = parseInviteFragment(new URL(a.link).hash)
  if (!parsed) throw new Error('no token in the link')
  return { token: parsed.token, guestId: a.guestId, inviteId: a.inviteId }
}

function redeemed(s: GuestStore, token: string): { cookie: string; deviceId: string } {
  const r = s.redeem({ token }, { ownerDevice: false })
  if (!r.ok) throw new Error(r.error)
  return { cookie: r.cookie, deviceId: r.device.id }
}

describe('invite', () => {
  it('mints a one-use link with the token only in the fragment, and keeps only its hash', async () => {
    const s = store()
    const a = await s.invite(P, req())
    if (!a.ok) throw new Error(a.error)
    const url = new URL(a.link)
    expect(url.origin).toBe('https://box.example:7330')
    expect(url.pathname).toBe('/')
    const token = parseInviteFragment(url.hash)?.token as string
    expect(token).toHaveLength(43)
    const disk = readFileSync(join(dir, 'web-access.json'), 'utf8')
    expect(disk).not.toContain(token)
    expect(disk).toContain(inviteHash(token))
    expect(a.expiresAt).toBe(clock + INVITE_UNUSED_MS)
    expect(a.warning).toBeUndefined()
    // The pending invite is listed for the owner.
    expect(s.list()).toEqual([expect.objectContaining({ name: 'Bob', state: 'pending', inviteId: a.inviteId })])
  })

  it('carries the certificate pin and warns when only loopback can open it (D-29, D-35)', async () => {
    const s = store({ target: () => ({ origin: 'http://127.0.0.1:7330', loopbackOnly: true, certPin: 'ab'.repeat(32) }) })
    const a = await s.invite(P, req())
    if (!a.ok) throw new Error(a.error)
    expect(parseInviteFragment(new URL(a.link).hash)?.cert).toBe('ab'.repeat(32))
    expect(a.warning).toBe('loopback-only')
  })

  it('refuses under None, a taken name (any case), past the cap, and with the device store full', async () => {
    const s = store()
    mode = 'none'
    expect(await s.invite(P, req())).toEqual({ ok: false, error: 'none-mode' })
    mode = 'link'
    await invited(s)
    expect(await s.invite(P, req({ name: '  bOB ' }))).toEqual({ ok: false, error: 'name-taken' })
    for (let i = 1; i < MAX_GUESTS; i++) await invited(s, { name: `g${i}` })
    expect(await s.invite(P, req({ name: 'one more' }))).toEqual({ ok: false, error: 'cap' })
  })

  it('answers full when no device fits', async () => {
    for (let i = 0; i < MAX_DEVICES; i++) devices.add(`d${i}`, 'link')
    expect(await store().invite(P, req())).toEqual({ ok: false, error: 'full' })
  })

  it('throws on a malformed request (a hostile page, not a choice the dialog offers)', async () => {
    const s = store()
    await expect(s.invite(P, req({ name: '' }))).rejects.toThrow()
    await expect(s.invite(P, req({ role: 'admin' as never }))).rejects.toThrow()
    await expect(s.invite(P, req({ lifetime: 'session' as never }))).rejects.toThrow()
    await expect(s.invite(P, req({ scope: 'some' as never }))).rejects.toThrow()
  })

  it("keeps only the project's own tabs in a selected scope", async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1', 'other', 'gone'] })
    redeemed(s, token)
    expect(s.access({ guest: guestId })).toMatchObject({ kind: 'guest', scope: ['t1'] })
  })
})

describe('redeem', () => {
  it('makes one guest device and the guest, once; a second redeem is told used', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    const r = s.redeem({ token }, { ownerDevice: false })
    if (!r.ok) throw new Error(r.error)
    expect(r.project).toBe(P)
    expect(r.device).toMatchObject({ mode: 'guest', guestId, name: 'Bob' })
    expect(devices.devicesOfGuest(guestId)).toHaveLength(1)
    expect(s.access({ guest: guestId })).toEqual({ kind: 'guest', id: guestId, name: 'Bob', role: 'write', projectId: P, scope: 'all' })
    expect(notices).toEqual(['Bob joined as a write guest'])
    expect(s.redeem({ token }, { ownerDevice: false })).toEqual({ ok: false, status: 410, error: 'used' })
    expect(devices.devicesOfGuest(guestId)).toHaveLength(1)
  })

  it('answers invalid for an unknown token and bad-request for a malformed one', () => {
    const s = store()
    expect(s.redeem({ token: 'A'.repeat(43) }, { ownerDevice: false })).toEqual({ ok: false, status: 404, error: 'invalid' })
    expect(s.redeem({ token: 'short' }, { ownerDevice: false })).toEqual({ ok: false, status: 400, error: 'bad-request' })
    expect(s.redeem({ token: 'A'.repeat(42) + '!' }, { ownerDevice: false })).toEqual({ ok: false, status: 400, error: 'bad-request' })
    expect(s.redeem(null, { ownerDevice: false })).toEqual({ ok: false, status: 400, error: 'bad-request' })
  })

  it('refuses an owner device (it would lose its owner cookie) and None mode, leaving the invite good', async () => {
    const s = store()
    const { token } = await invited(s)
    expect(s.redeem({ token }, { ownerDevice: true })).toEqual({ ok: false, status: 409, error: 'owner-device' })
    mode = 'none'
    expect(s.redeem({ token }, { ownerDevice: false })).toEqual({ ok: false, status: 409, error: 'none-mode' })
    mode = 'link'
    expect(s.redeem({ token }, { ownerDevice: false }).ok).toBe(true)
  })

  it('answers expired after 24 h unused, and the invite is gone', async () => {
    const s = store()
    const { token } = await invited(s)
    clock += INVITE_UNUSED_MS
    expect(s.redeem({ token }, { ownerDevice: false })).toEqual({ ok: false, status: 410, error: 'expired' })
    expect(s.list()).toEqual([])
  })

  it('answers full with the device store full and leaves the invite unspent', async () => {
    const s = store()
    const { token } = await invited(s)
    for (let i = 0; i < MAX_DEVICES; i++) devices.add(`d${i}`, 'link')
    expect(s.redeem({ token }, { ownerDevice: false })).toEqual({ ok: false, status: 503, error: 'full' })
    devices.revoke(devices.list()[0]!.id, 'make room')
    expect(s.redeem({ token }, { ownerDevice: false }).ok).toBe(true)
  })

  it('survives a restart: the guest and its device are read back from the file', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { role: 'read', lifetime: '1d' })
    redeemed(s, token)
    s.dispose()
    devices = newDevices()
    const again = store()
    expect(again.access({ guest: guestId })).toMatchObject({ kind: 'guest', role: 'read' })
    expect(again.redeem({ token }, { ownerDevice: false })).toEqual({ ok: false, status: 410, error: 'used' })
  })
})

describe('ends', () => {
  it('kick closes the views with 4460 first, then revokes the device, and tombstones its cookie (D-32)', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    const { cookie } = redeemed(s, token)
    const order: string[] = []
    devices.onRevoked(() => order.push('revoked'))
    const s2closed = closed
    expect(s.kick(guestId)).toBe(true)
    expect(s2closed).toEqual([{ guestId, code: CLOSE.kicked }])
    expect(order).toEqual(['revoked'])
    expect(s.access({ guest: guestId })).toEqual({ kind: 'revoked' })
    expect(devices.devicesOfGuest(guestId)).toEqual([])
    expect(s.endedCookie([cookie])).toBe(true)
    expect(s.endedCookie(['nope.' + 'A'.repeat(43)])).toBe(false)
    clock += ENDED_TOMBSTONE_MS
    expect(s.endedCookie([cookie])).toBe(false)
    expect(s.kick(guestId)).toBe(false)
  })

  it('kick of a pending guest cancels its invite', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    expect(s.kick(guestId)).toBe(true)
    expect(s.redeem({ token }, { ownerDevice: false })).toEqual({ ok: false, status: 404, error: 'invalid' })
  })

  it('a lifetime ends in the sweep with 4463, and access says revoked as soon as it is over', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { lifetime: '1d' })
    redeemed(s, token)
    clock += 24 * 3600_000
    // Before any sweep ran: `access` reads the time itself.
    expect(s.access({ guest: guestId })).toEqual({ kind: 'revoked' })
    for (const t of ticks) t()
    expect(closed).toEqual([{ guestId, code: CLOSE.accessEnded }])
    expect(devices.devicesOfGuest(guestId)).toEqual([])
    expect(SWEEP_MS).toBeLessThanOrEqual(60_000)
  })

  it('revoking the device in the device list, or Revoke all, ends the guest', async () => {
    const s = store()
    const a = await invited(s, { name: 'A' })
    const b = await invited(s, { name: 'B' })
    const da = redeemed(s, a.token)
    redeemed(s, b.token)
    devices.revoke(da.deviceId, 'from the card')
    expect(s.access({ guest: a.guestId })).toEqual({ kind: 'revoked' })
    expect(s.access({ guest: b.guestId }).kind).toBe('guest')
    devices.revokeAll('revoke all')
    expect(s.access({ guest: b.guestId })).toEqual({ kind: 'revoked' })
    expect(s.list()).toEqual([])
  })

  it('an idle guest device expiring ends the guest (one device per invite: it could never come back)', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { lifetime: 'forever' })
    redeemed(s, token)
    clock += DEVICE_IDLE_MS + 1
    devices.list()
    expect(s.access({ guest: guestId })).toEqual({ kind: 'revoked' })
  })

  it("revoking the owner's link devices never ends a guest", async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    devices.add('owner phone', 'link')
    devices.revokeSignedInWith('link', 'regenerated')
    expect(s.access({ guest: guestId }).kind).toBe('guest')
  })

  it('a forgotten project ends its guests and drops its invites', async () => {
    const s = store()
    const a = await invited(s, { name: 'A' })
    await invited(s, { name: 'B' })
    redeemed(s, a.token)
    s.projectRemoved(P)
    expect(s.list()).toEqual([])
    expect(closed).toEqual([{ guestId: a.guestId, code: CLOSE.kicked }])
  })
})

describe('changes', () => {
  it('a role switch reconnects the views with 4461', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    expect(s.setRole(guestId, 'read')).toBe(true)
    expect(closed).toEqual([{ guestId, code: CLOSE.roleChanged }])
    expect(s.access({ guest: guestId })).toMatchObject({ role: 'read' })
    // The same role again changes nothing and closes nothing.
    expect(s.setRole(guestId, 'read')).toBe(true)
    expect(closed).toHaveLength(1)
  })

  it('a scope change and a tab share close the views with 4464 and drop the page tokens (D-30)', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    const { deviceId } = redeemed(s, token)
    expect(s.shareTab(guestId, 't2', true)).toBe(true)
    expect(s.tabVisible(guestId, 't2')).toBe(true)
    expect(s.shareTab(guestId, 'other', true)).toBe(false)
    expect(s.setScope(guestId, 'all')).toBe(true)
    expect(closed.map((c) => c.code)).toEqual([CLOSE.accessChanged, CLOSE.accessChanged])
    expect(dropped).toEqual([deviceId, deviceId])
    // "all" has no per-tab share.
    expect(s.shareTab(guestId, 't1', false)).toBe(false)
  })

  it('a plugin visibility change reconnects the project guests', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    s.pluginAccessChanged('proj2')
    expect(closed).toEqual([])
    s.pluginAccessChanged(P)
    expect(closed).toEqual([{ guestId, code: CLOSE.accessChanged }])
  })

  it('remap moves scopes and opened tabs to the restored ids, only for ids in the map', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1', 't2'] })
    redeemed(s, token)
    s.noteOpenedTab(guestId, 't2')
    tabs.set('n1', { projectId: P })
    s.remap(P, new Map([['t1', 'n1']]))
    expect(s.access({ guest: guestId })).toMatchObject({ scope: ['n1', 't2'] })
    expect(s.openedTabs(guestId)).toEqual(['t2'])
  })
})

describe('live answers', () => {
  it('tabVisible: scope, opened tabs, never another project, never a hidden plugin tab', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1', 'tp', 'other'] })
    redeemed(s, token)
    expect(s.tabVisible(guestId, 't1')).toBe(true)
    expect(s.tabVisible(guestId, 't2')).toBe(false)
    s.noteOpenedTab(guestId, 't2')
    expect(s.tabVisible(guestId, 't2')).toBe(true)
    expect(s.tabVisible(guestId, 'other')).toBe(false)
    expect(s.tabVisible(guestId, 'tp')).toBe(false)
    shown.add('x.hidden')
    expect(s.tabVisible(guestId, 'tp')).toBe(true)
    expect(s.tabVisible('nobody', 't1')).toBe(false)
  })

  it('pluginVisible fails closed: off in the project, or a lookup that throws', () => {
    shown.add('a.b')
    expect(store().pluginVisible(P, 'a.b')).toBe(true)
    expect(store({ pluginEnabled: () => false }).pluginVisible(P, 'a.b')).toBe(false)
    expect(store({ pluginShown: () => { throw new Error('x') } }).pluginVisible(P, 'a.b')).toBe(false)
    expect(store({ pluginShown: undefined }).pluginVisible(P, 'a.b')).toBe(false)
  })

  it('whoAccess: a desktop view is the owner, an unknown remote view is revoked', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    const v = remoteViewId(3)
    expect(s.whoAccess('desktop:1' as ViewId)).toEqual({ kind: 'owner' })
    expect(s.whoAccess(v)).toEqual({ kind: 'revoked' })
    views.set(v, { guest: guestId })
    expect(s.whoAccess(v).kind).toBe('guest')
    views.set(v, 'owner')
    expect(s.whoAccess(v)).toEqual({ kind: 'owner' })
  })

  it('list: live, away within the hour, then offline; blockingNone names guests and invites (D-15)', async () => {
    const s = store()
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    await invited(s, { name: 'Carol' })
    live.add(guestId)
    expect(s.list().find((v) => v.id === guestId)?.state).toBe('live')
    live.delete(guestId)
    s.viewsChanged(guestId, false)
    expect(s.list().find((v) => v.id === guestId)?.state).toBe('away')
    clock += 3600_000
    expect(s.list().find((v) => v.id === guestId)?.state).toBe('offline')
    expect(s.blockingNone().sort()).toEqual(['Bob', 'Carol (invited)'])
  })
})
