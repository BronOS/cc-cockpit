// Task 02 (spec-review S5, leo Q8): a guest's Ask chats end at once on every narrowing of its access and at its end,
// through GuestStoreDeps.dropAsks (wired to AskApi.dropGuest). One test per path.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccessLog } from '../../src/main/web/access-log'
import { DeviceStore } from '../../src/main/web/devices'
import { GuestStore, type GuestStoreDeps } from '../../src/main/web/guests'
import type { GuestInviteRequest } from '../../src/shared/guests'
import { parseInviteFragment } from '../../src/shared/web-protocol'

const P = 'proj1'
let dir: string
let clock: number
let dropped: string[]
let ticks: (() => void)[]
let shown: Set<string>
let devices: DeviceStore
let log: AccessLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-ask-guests-'))
  clock = 1_700_000_000_000
  dropped = []
  ticks = []
  shown = new Set(['a.jira'])
  log = new AccessLog({ now: () => clock })
  devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog: log, now: () => clock })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function store(over: Partial<GuestStoreDeps> = {}): GuestStore {
  return new GuestStore({
    devices,
    accessLog: log,
    mode: () => 'link',
    target: () => ({ origin: 'https://box.example:7330', loopbackOnly: false }),
    pluginShown: (_p, id) => shown.has(id),
    tabOf: (id) => (id === 't1' || id === 't2' ? { projectId: P } : undefined),
    whoOfView: () => undefined,
    closeGuestViews: () => 1,
    guestLive: () => true,
    dropAsks: (guestId) => dropped.push(guestId),
    log: () => {},
    now: () => clock,
    setInterval: (fn) => {
      ticks.push(fn)
      return { stop: () => {} }
    },
    setTimeout: () => ({ stop: () => {} }),
    ...over
  })
}

async function guest(s: GuestStore, over: Partial<GuestInviteRequest> = {}): Promise<{ guestId: string; deviceId: string }> {
  const a = await s.invite(P, { name: 'Bob', role: 'write', scope: 'all', lifetime: 'forever', ...over } as GuestInviteRequest)
  if (!a.ok) throw new Error(a.error)
  const token = parseInviteFragment(new URL(a.link).hash)!.token
  const r = s.redeem({ token }, { ownerDevice: false })
  if (!r.ok) throw new Error(r.error)
  return { guestId: a.guestId, deviceId: r.device.id }
}

describe('a guest Ask ends at once', () => {
  it('on a role switch to read', async () => {
    const s = store()
    const { guestId } = await guest(s)
    s.setRole(guestId, 'read')
    expect(dropped).toContain(guestId)
  })

  it('when a plugin is hidden from guests', async () => {
    const s = store()
    const { guestId } = await guest(s)
    shown.delete('a.jira')
    s.pluginAccessChanged(P)
    expect(dropped).toContain(guestId)
  })

  it('when a tab is unshared', async () => {
    const s = store()
    const { guestId } = await guest(s, { scope: ['t1', 't2'] })
    expect(s.shareTab(guestId, 't2', false)).toBe(true)
    expect(dropped).toContain(guestId)
  })

  it('on a kick', async () => {
    const s = store()
    const { guestId } = await guest(s)
    expect(s.kick(guestId)).toBe(true)
    expect(dropped).toContain(guestId)
  })

  it('on a device revoke', async () => {
    const s = store()
    const { guestId, deviceId } = await guest(s)
    devices.revoke(deviceId, 'from the card')
    expect(dropped).toContain(guestId)
  })

  it('at the end of its lifetime', async () => {
    const s = store()
    const { guestId } = await guest(s, { lifetime: '1d' })
    clock += 24 * 3600_000 + 1
    for (const t of ticks) t()
    expect(dropped).toContain(guestId)
  })

  it('on a widening too (a tab shared): its mode and document were decided under the old access (S5)', async () => {
    const s = store()
    const { guestId } = await guest(s, { scope: ['t1'] })
    s.shareTab(guestId, 't2', true)
    expect(dropped).toContain(guestId)
  })
})
