// Web access devices (main/web/devices.ts, plan Task 5): hashed secrets, the sliding 30-day expiry
// with no rotation, revoke / revoke all / revoke by sign-in method, the new-device notice, and a
// file that a hand edit can damage without costing the other devices.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AccessLog } from '../../src/main/web/access-log'
import {
  DEFAULT_DEVICE_NAME,
  DEVICE_IDLE_MS,
  DeviceStore,
  hashSecret,
  matchesHash,
  MAX_DEVICES,
  TOUCH_INTERVAL_MS
} from '../../src/main/web/devices'

const DAY = 24 * 60 * 60 * 1000

let dir: string
let file: string
let clock: number
let notices: string[]
let log: AccessLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-devices-'))
  file = join(dir, 'web-access.json')
  clock = 1_700_000_000_000
  notices = []
  log = new AccessLog({ now: () => clock })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function store(): DeviceStore {
  return new DeviceStore({ filePath: file, accessLog: log, notify: (t) => notices.push(t), now: () => clock })
}

function onDisk(): { devices: Array<Record<string, unknown>>; accessToken?: unknown } {
  return JSON.parse(readFileSync(file, 'utf8')) as { devices: Array<Record<string, unknown>> }
}

describe('add and check', () => {
  it('gives a cookie `<id>.<secret>`, keeps only the secret hash, and checks it', () => {
    const s = store()
    const added = s.add('Pixel', 'link')
    if (!added) throw new Error('not added')
    const [id, secret] = added.cookie.split('.')
    expect(id).toBe(added.device.id)
    expect(secret).toHaveLength(43)
    // On disk at once (credentials are flushed), as a hash only.
    const text = readFileSync(file, 'utf8')
    expect(text).not.toContain(secret)
    expect(onDisk().devices[0]).toMatchObject({ id, name: 'Pixel', mode: 'link', secretHash: hashSecret(secret ?? '') })
    expect(s.check(added.cookie)).toMatchObject({ id, name: 'Pixel', mode: 'link' })
    expect(Object.keys(s.check(added.cookie) ?? {})).not.toContain('secretHash')
  })

  it('refuses a wrong secret, an unknown id and malformed values', () => {
    const s = store()
    const added = s.add('x', 'link')
    if (!added) throw new Error('not added')
    const id = added.device.id
    for (const bad of [`${id}.${'A'.repeat(43)}`, `nobody.${added.cookie.split('.')[1]}`, id, `.${id}`, `${id}.`, `${id}.a b`, '', 'x'.repeat(500), undefined]) {
      expect(s.check(bad), String(bad)).toBeUndefined()
    }
  })

  it('notifies the desktop and logs the sign-in, with the name as plain text', () => {
    const s = store()
    s.add('Evil‮\u0007Phone\n', 'add')
    expect(notices).toEqual(['A new device signed in to web access: EvilPhone'])
    expect(log.recent()).toMatchObject([{ event: 'sign-in', name: 'EvilPhone', detail: 'add' }])
  })

  it('caps and defaults the name', () => {
    const s = store()
    expect(s.add('n'.repeat(500), 'link')?.device.name).toHaveLength(60)
    expect(s.add('  \u0000 ', 'link')?.device.name).toBe(DEFAULT_DEVICE_NAME)
    expect(s.add(42, 'link')?.device.name).toBe(DEFAULT_DEVICE_NAME)
  })

  it('refuses a device past the cap', () => {
    const s = store()
    for (let i = 0; i < MAX_DEVICES; i++) expect(s.add(`d${i}`, 'link')).toBeDefined()
    expect(s.add('one more', 'link')).toBeUndefined()
  })
})

describe('sliding expiry, no rotation', () => {
  it('stays valid while used within 30 days, with the same cookie, and goes after 30 idle days', () => {
    const s = store()
    const added = s.add('x', 'link')
    if (!added) throw new Error('not added')
    const gone: string[][] = []
    s.onRevoked((ids) => gone.push([...ids]))
    for (let i = 0; i < 3; i++) {
      clock += 29 * DAY
      expect(s.check(added.cookie)?.lastSeenAt).toBe(clock)
    }
    clock += DEVICE_IDLE_MS + 1
    expect(s.check(added.cookie)).toBeUndefined()
    expect(gone).toEqual([[added.device.id]])
    expect(onDisk().devices).toEqual([])
    expect(log.recent().at(-1)).toMatchObject({ event: 'expired', device: added.device.id })
  })

  it('moves lastSeenAt at most once a minute', () => {
    const s = store()
    const added = s.add('x', 'link')
    if (!added) throw new Error('not added')
    const created = clock
    clock += TOUCH_INTERVAL_MS - 1
    expect(s.check(added.cookie)?.lastSeenAt).toBe(created)
    clock += 1
    expect(s.check(added.cookie)?.lastSeenAt).toBe(clock)
  })

  it('list drops expired devices, newest first', () => {
    const s = store()
    s.add('old', 'link')
    clock += 20 * DAY
    s.add('new', 'link')
    expect(s.list().map((d) => d.name)).toEqual(['new', 'old'])
    clock += 11 * DAY
    expect(s.list().map((d) => d.name)).toEqual(['new'])
  })
})

describe('revoke', () => {
  it('revokes one, by sign-in method, and all; listeners hear the ids; the file has it at once', () => {
    const s = store()
    const a = s.add('a', 'link')
    const b = s.add('b', 'add')
    const c = s.add('c', 'link')
    const d = s.add('d', 'password')
    const heard: string[][] = []
    s.onRevoked((ids) => heard.push([...ids]))
    expect(s.revoke(a?.device.id ?? '')).toBe(true)
    expect(s.revoke('nobody')).toBe(false)
    expect(s.check(a?.cookie)).toBeUndefined()
    expect(s.revokeSignedInWith('link', 'access link regenerated')).toBe(1)
    expect(s.check(c?.cookie)).toBeUndefined()
    expect(s.check(b?.cookie)).toBeDefined()
    expect(store().list().map((x) => x.name).sort()).toEqual(['b', 'd'])
    expect(s.revokeAll()).toBe(2)
    expect(heard).toEqual([[a?.device.id], [c?.device.id], [b?.device.id, d?.device.id]])
    expect(store().list()).toEqual([])
    expect(log.recent().filter((e) => e.event === 'revoke').map((e) => e.detail)).toEqual([
      'revoked on the desktop',
      'access link regenerated',
      'revoke all',
      'revoke all'
    ])
  })

  it('a throwing listener does not stop the others', () => {
    const s = store()
    const a = s.add('a', 'link')
    const heard: string[] = []
    s.onRevoked(() => {
      throw new Error('boom')
    })
    s.onRevoked((ids) => heard.push(...ids))
    s.revoke(a?.device.id ?? '')
    expect(heard).toEqual([a?.device.id])
  })
})

describe('the file', () => {
  it('survives a restart; damaged records and a damaged token record are dropped', () => {
    const s = store()
    const good = s.add('good', 'link')
    s.setAccessToken({ hash: hashSecret('t'), stored: 'enc', createdAt: 1 })
    const data = onDisk()
    data.devices.push({ id: 'bad id', name: 'x', createdAt: 1, lastSeenAt: 1, secretHash: 'f'.repeat(64), mode: 'link' })
    data.devices.push({ id: 'abc', name: 'x', createdAt: 1, lastSeenAt: 1, secretHash: 'short', mode: 'link' })
    data.devices.push({ id: 'abd', name: 'x', createdAt: 1, lastSeenAt: 1, secretHash: 'f'.repeat(64), mode: 'root' })
    writeFileSync(file, JSON.stringify(data))
    const again = store()
    expect(again.list().map((d) => d.name)).toEqual(['good'])
    expect(again.check(good?.cookie)?.name).toBe('good')
    expect(again.accessToken()).toEqual({ hash: hashSecret('t'), stored: 'enc', createdAt: 1 })
    writeFileSync(file, JSON.stringify({ ...data, accessToken: { hash: 'nothex', stored: 'enc', createdAt: 1 } }))
    expect(store().accessToken()).toBeUndefined()
  })

  it('writes nothing until something changes', () => {
    const s = store()
    expect(s.list()).toEqual([])
    expect(s.check('a.b')).toBeUndefined()
    s.flush()
    expect(() => readFileSync(file)).toThrow(/ENOENT/)
  })
})

describe('matchesHash', () => {
  it('matches only the secret, and a damaged hash never matches', () => {
    expect(matchesHash('secret', hashSecret('secret'))).toBe(true)
    expect(matchesHash('secreT', hashSecret('secret'))).toBe(false)
    expect(matchesHash('secret', '')).toBe(false)
    expect(matchesHash('secret', 'zz')).toBe(false)
  })
})
