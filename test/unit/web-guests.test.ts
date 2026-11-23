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
import { ACCESS_MAX_WAIT_MS, ACCESS_QUIET_MS, ENDED_TOMBSTONE_MS, GuestStore, inviteHash, SWEEP_MS, type GuestStoreDeps, type GuestTabInfo } from '../../src/main/web/guests'
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
let timers: Array<{ fn: () => void; ms: number; stopped: boolean }>
let droppedDownloads: string[]
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
  timers = []
  droppedDownloads = []
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
    dropDownloads: (d) => droppedDownloads.push(d),
    notify: (t) => notices.push(t),
    log: () => {},
    now: () => clock,
    setInterval: (fn) => {
      ticks.push(fn)
      return { stop: () => {} }
    },
    setTimeout: (fn, ms) => {
      const t = { fn, ms, stopped: false }
      timers.push(t)
      return { stop: () => (t.stopped = true) }
    },
    ...over
  })
}

/** Runs the one-shot timers still armed (the coalesced D-30 reconnects), as their time had come. */
function fireTimers(): void {
  for (const t of timers.splice(0)) {
    if (t.stopped) continue
    t.stopped = true
    t.fn()
  }
}
const armed = (): number[] => timers.filter((t) => !t.stopped).map((t) => t.ms)

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

  it('every end calls `ended` once with the guest id (D-9: its close asks settle), and a throwing hook ends it anyway', async () => {
    const endedIds: string[] = []
    const s = store({ ended: (id) => void endedIds.push(id) })
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    expect(s.kick(guestId)).toBe(true)
    expect(endedIds).toEqual([guestId])
    expect(s.kick(guestId)).toBe(false)
    expect(endedIds).toEqual([guestId])
    const s2 = store({
      ended: () => {
        throw new Error('boom')
      }
    })
    const second = await invited(s2)
    expect(s2.kick(second.guestId)).toBe(true)
    expect(s2.access({ guest: second.guestId })).toEqual({ kind: 'revoked' })
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
    const db = redeemed(s, b.token)
    devices.revoke(da.deviceId, 'from the card')
    expect(s.access({ guest: a.guestId })).toEqual({ kind: 'revoked' })
    expect(s.access({ guest: b.guestId }).kind).toBe('guest')
    // The device was gone before the guest ended: its cookie still reads "ended" (D-32), not the sign-in form.
    expect(s.endedCookie([da.cookie])).toBe(true)
    expect(s.endedCookie([db.cookie])).toBe(false)
    devices.revokeAll('revoke all')
    expect(s.access({ guest: b.guestId })).toEqual({ kind: 'revoked' })
    expect(s.endedCookie([db.cookie])).toBe(true)
    expect(s.list()).toEqual([])
  })

  it('an idle guest device expiring ends the guest (one device per invite: it could never come back)', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { lifetime: 'forever' })
    const { cookie } = redeemed(s, token)
    clock += DEVICE_IDLE_MS + 1
    devices.list()
    expect(s.access({ guest: guestId })).toEqual({ kind: 'revoked' })
    expect(s.endedCookie([cookie])).toBe(true)
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
    // Both widen: the page tokens die at once, the one 4464 comes after the quiet period.
    expect(dropped).toEqual([deviceId, deviceId])
    expect(closed).toEqual([])
    fireTimers()
    expect(closed.map((c) => c.code)).toEqual([CLOSE.accessChanged])
    // "all" has no per-tab share.
    expect(s.shareTab(guestId, 't1', false)).toBe(false)
  })

  it('D-30 coalescing: four quick shares make one 4464, after ACCESS_QUIET_MS of quiet, never later than ACCESS_MAX_WAIT_MS', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    const { deviceId } = redeemed(s, token)
    for (const t of ['t2', 'n1', 'n2', 'n3']) tabs.set(t, { projectId: P })
    for (const t of ['t2', 'n1', 'n2', 'n3']) {
      expect(s.shareTab(guestId, t, true)).toBe(true)
      clock += 400
    }
    expect(closed).toEqual([])
    expect(dropped).toEqual([deviceId, deviceId, deviceId, deviceId])
    // Each share re-armed the quiet period (the 4th came 1200 ms after the 1st, well inside the cap): one timer.
    expect(armed()).toEqual([ACCESS_QUIET_MS])
    fireTimers()
    expect(closed.map((c) => c.code)).toEqual([CLOSE.accessChanged])
    expect(s.access({ guest: guestId })).toMatchObject({ scope: ['t1', 't2', 'n1', 'n2', 'n3'] })
  })

  it('the coalescing cap: a run of shares reconnects at most ACCESS_MAX_WAIT_MS after its first', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    redeemed(s, token)
    for (const t of ['n1', 'n2']) tabs.set(t, { projectId: P })
    s.shareTab(guestId, 't2', true)
    clock += 1_800
    s.shareTab(guestId, 'n1', true)
    expect(armed()).toEqual([ACCESS_MAX_WAIT_MS - 1_800])
    clock += 300
    s.shareTab(guestId, 'n2', true)
    expect(armed()).toEqual([0])
    fireTimers()
    expect(closed.map((c) => c.code)).toEqual([CLOSE.accessChanged])
    // The next share starts a new run.
    s.shareTab(guestId, 'n2', false)
    s.shareTab(guestId, 'n2', true)
    expect(armed()).toEqual([ACCESS_QUIET_MS])
  })

  it('narrowing never waits: unshare, a narrower scope and a plugin visibility change reconnect at once and take a waiting widening with them', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    redeemed(s, token)
    s.shareTab(guestId, 't2', true)
    expect(closed).toEqual([])
    s.shareTab(guestId, 't1', false)
    expect(closed.map((c) => c.code)).toEqual([CLOSE.accessChanged])
    fireTimers()
    expect(closed).toHaveLength(1)

    s.shareTab(guestId, 't1', true)
    expect(s.setScope(guestId, ['t1'])).toBe(true)
    expect(closed).toHaveLength(2)
    fireTimers()
    expect(closed).toHaveLength(2)

    s.setScope(guestId, 'all')
    expect(closed).toHaveLength(2)
    expect(s.setScope(guestId, ['t1', 't2'])).toBe(true)
    expect(closed).toHaveLength(3)

    s.shareTab(guestId, 'tp', true)
    s.pluginAccessChanged(P)
    expect(closed).toHaveLength(4)
    fireTimers()
    expect(closed).toHaveLength(4)
  })

  it('a role switch or an end cancels a waiting 4464 (the fresh ready or the end already covers it)', async () => {
    const s = store()
    const a = await invited(s, { scope: ['t1'] })
    redeemed(s, a.token)
    s.shareTab(a.guestId, 't2', true)
    s.setRole(a.guestId, 'read')
    fireTimers()
    expect(closed.map((c) => c.code)).toEqual([CLOSE.roleChanged])

    closed = []
    s.shareTab(a.guestId, 'tp', true)
    expect(s.kick(a.guestId)).toBe(true)
    fireTimers()
    expect(closed.map((c) => c.code)).toEqual([CLOSE.kicked])

    // dispose stops a waiting one too.
    const b = await invited(s, { name: 'Ben', scope: ['t1'] })
    redeemed(s, b.token)
    s.shareTab(b.guestId, 't2', true)
    s.dispose()
    expect(armed()).toEqual([])
  })

  it('a lifetime ends at its until, not at the next sweep: one timer at the nearest end, re-armed on redeem, end and restart', async () => {
    const s = store()
    const day = await invited(s, { name: 'Day', lifetime: '1d' })
    redeemed(s, day.token)
    expect(armed()).toEqual([24 * 3600_000])
    const forever = await invited(s, { name: 'Ever' })
    redeemed(s, forever.token)
    expect(armed()).toEqual([24 * 3600_000])
    clock += 3600_000
    const week = await invited(s, { name: 'Week', lifetime: '7d' })
    redeemed(s, week.token)
    // Still the day guest's end (23 h away now); the week guest's comes next.
    expect(armed()).toEqual([23 * 3600_000])
    clock += 23 * 3600_000
    fireTimers()
    expect(closed).toEqual([{ guestId: day.guestId, code: CLOSE.accessEnded }])
    expect(armed()).toEqual([7 * 24 * 3600_000 - 24 * 3600_000 + 3600_000])
    // A kick re-arms for whoever is left: none with an end.
    s.kick(week.guestId)
    expect(armed()).toEqual([])
    // A restart arms from the saved records (a new store over the same file).
    const later = await invited(s, { name: 'Later', lifetime: '1d' })
    redeemed(s, later.token)
    s.dispose()
    timers = []
    // A restart: a new device store and guest store over the same file.
    devices = newDevices()
    const s2 = store()
    expect(armed()).toEqual([24 * 3600_000])
    clock += 24 * 3600_000
    closed = []
    fireTimers()
    expect(closed).toEqual([{ guestId: later.guestId, code: CLOSE.accessEnded }])
    expect(s2.access({ guest: later.guestId })).toMatchObject({ kind: 'revoked' })
  })

  it('a timer that fires early ends nobody and arms again for the rest', async () => {
    const s = store()
    const day = await invited(s, { name: 'Day', lifetime: '1d' })
    redeemed(s, day.token)
    clock += 24 * 3600_000 - 5
    fireTimers()
    expect(closed).toEqual([])
    expect(armed()).toEqual([5])
  })

  it('downloads end with every 4464 and on a downgrade to read (D-23), never on an upgrade', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    const { deviceId } = redeemed(s, token)
    s.shareTab(guestId, 't1', false)
    expect(droppedDownloads).toEqual([deviceId])
    s.shareTab(guestId, 't2', true)
    // A widening: the downloads go with its one 4464, not before.
    expect(droppedDownloads).toEqual([deviceId])
    fireTimers()
    expect(droppedDownloads).toEqual([deviceId, deviceId])
    s.pluginAccessChanged(P)
    expect(droppedDownloads).toHaveLength(3)
    s.setRole(guestId, 'read')
    expect(droppedDownloads).toHaveLength(4)
    s.setRole(guestId, 'write')
    expect(droppedDownloads).toHaveLength(4)
  })

  it('uploads end where downloads do, and on a kick before the devices are revoked (design-upload.md §3.4)', async () => {
    const droppedUploads: Array<{ deviceId: string; listed: boolean }> = []
    let guestId = ''
    const s = store({
      // Whether the device was still listed when its uploads were dropped: the end must not rest on the revoke.
      dropUploads: (d) => droppedUploads.push({ deviceId: d, listed: devices.devicesOfGuest(guestId).some((x) => x.id === d) })
    })
    const inv = await invited(s, { scope: ['t1'] })
    const token = inv.token
    guestId = inv.guestId
    const { deviceId } = redeemed(s, token)
    s.setRole(guestId, 'write')
    expect(droppedUploads).toEqual([])
    s.setRole(guestId, 'read')
    expect(droppedUploads.map((x) => x.deviceId)).toEqual([deviceId])
    s.shareTab(guestId, 't1', false)
    expect(droppedUploads.map((x) => x.deviceId)).toEqual([deviceId, deviceId])
    expect(s.kick(guestId)).toBe(true)
    expect(droppedUploads).toHaveLength(3)
    expect(droppedUploads[2]).toEqual({ deviceId, listed: true })
    expect(devices.devicesOfGuest(guestId)).toEqual([])
  })

  it('a throwing dropUploads is logged, never stops the guest ending', async () => {
    const lines: string[] = []
    const s = store({
      dropUploads: () => {
        throw new Error('boom')
      },
      log: (line) => lines.push(line)
    })
    const { token, guestId } = await invited(s)
    redeemed(s, token)
    expect(s.kick(guestId)).toBe(true)
    expect(s.list()).toEqual([])
    expect(lines.some((l) => l.includes('dropping uploads failed'))).toBe(true)
  })

  it('unsharing a tab the guest opened takes it from openedTabs too: it is no longer visible, and the views reconnect', async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    redeemed(s, token)
    s.noteOpenedTab(guestId, 't2')
    expect(s.tabVisible(guestId, 't2')).toBe(true)
    expect(s.shareTab(guestId, 't2', false)).toBe(true)
    expect(s.tabVisible(guestId, 't2')).toBe(false)
    expect(s.openedTabs(guestId)).toEqual([])
    expect(closed.map((c) => c.code)).toEqual([CLOSE.accessChanged])
  })

  it("Share with <name> on a pending invite edits the invite's scope (no view, nothing to close); the redeem keeps it", async () => {
    const s = store()
    const { token, guestId } = await invited(s, { scope: ['t1'] })
    expect(s.shareTab(guestId, 't2', true)).toBe(true)
    expect(s.shareTab(guestId, 'other', true)).toBe(false)
    expect(s.shareTab(guestId, 't1', false)).toBe(true)
    expect(s.list().find((g) => g.id === guestId)).toMatchObject({ scope: ['t2'] })
    expect(closed).toEqual([])
    expect(dropped).toEqual([])
    redeemed(s, token)
    expect(s.access({ guest: guestId })).toMatchObject({ scope: ['t2'] })
    expect(s.tabVisible(guestId, 't2')).toBe(true)
    expect(s.tabVisible(guestId, 't1')).toBe(false)
  })

  it('Share with <name> refuses an all-tabs invite and an expired one', async () => {
    const s = store()
    const all = await invited(s, { name: 'Al' })
    expect(s.shareTab(all.guestId, 't2', true)).toBe(false)
    const sel = await invited(s, { name: 'Sel', scope: ['t1'] })
    clock += INVITE_UNUSED_MS + 1
    expect(s.shareTab(sel.guestId, 't2', true)).toBe(false)
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
