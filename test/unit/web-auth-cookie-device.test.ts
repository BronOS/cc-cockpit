// The cookie-only device lookup for a download's GET (auth.ts deviceByCookie, DeviceStore.checkCookie;
// design-download.md §3.1 step 4): a navigation for `<a download>` carries no origin key, so the
// cookie alone binds the one-use token to its browser. It must name a device by its secret, never
// sign anyone in (no None fallback, no `seen`, no drop), and see past planted same-name cookies.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog } from '../../src/main/web/access-log'
import { DEVICE_COOKIE, WebAuth } from '../../src/main/web/auth'
import { DEVICE_IDLE_MS, DeviceStore, TOUCH_INTERVAL_MS } from '../../src/main/web/devices'

let dir: string
let clock: number
let devices: DeviceStore
let auth: WebAuth
let accessLog: AccessLog

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-cookie-device-'))
  clock = 1_700_000_000_000
  accessLog = new AccessLog()
  devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog, now: () => clock })
  auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog, now: () => clock })
  auth.setMode('link')
})

afterEach(() => {
  devices.flush()
  rmSync(dir, { recursive: true, force: true })
})

function addDevice(name: string): { id: string; cookie: string; key: string } {
  const added = devices.add(name, 'link')
  if (!added) throw new Error('setup')
  return { id: added.device.id, cookie: added.cookie, key: added.key }
}

const header = (...values: string[]): string => values.map((v) => `${DEVICE_COOKIE}=${v}`).join('; ')

describe('deviceByCookie', () => {
  it('names the device by its cookie alone, where authorize needs the key too', () => {
    const mac = addDevice('Mac')
    expect(auth.authorize(header(mac.cookie))).toBeUndefined()
    expect(auth.deviceByCookie(header(mac.cookie))).toMatchObject({ id: mac.id, name: 'Mac' })
    expect(auth.deviceByCookie(`theme=dark; ${header(mac.cookie)}; other=1`)?.id).toBe(mac.id)
  })

  it('names nobody for no cookie, a forged one, a wrong secret or an unknown id', () => {
    const mac = addDevice('Mac')
    const [id] = mac.cookie.split('.')
    expect(auth.deviceByCookie(undefined)).toBeUndefined()
    expect(auth.deviceByCookie('')).toBeUndefined()
    expect(auth.deviceByCookie(header('garbage'))).toBeUndefined()
    expect(auth.deviceByCookie(header(`${id}.${'A'.repeat(43)}`))).toBeUndefined()
    expect(auth.deviceByCookie(header(`unknownid.${mac.cookie.split('.')[1]}`))).toBeUndefined()
    // The origin key is no cookie secret.
    expect(auth.deviceByCookie(header(`${id}.${mac.key}`))).toBeUndefined()
  })

  it('has no None fallback: the gateway lets a None token go on the token alone, not this', () => {
    auth.setMode('none')
    expect(auth.authorize(undefined)?.id).toBe('none')
    expect(auth.deviceByCookie(undefined)).toBeUndefined()
    expect(auth.deviceByCookie(header('garbage'))).toBeUndefined()
  })

  it('with `want`, tries every value: another device`s cookie planted first does not hide the jar`s own', () => {
    const mac = addDevice('Mac')
    const phone = addDevice('Phone')
    const both = header(phone.cookie, mac.cookie)
    expect(auth.deviceByCookie(both)?.id).toBe(phone.id)
    expect(auth.deviceByCookie(both, mac.id)?.id).toBe(mac.id)
    expect(auth.deviceByCookie(header(phone.cookie), mac.id)).toBeUndefined()
    expect(auth.deviceByCookie(header('garbage', mac.cookie), mac.id)?.id).toBe(mac.id)
  })

  it('never marks the device seen: a cookie alone must not keep it from expiring', () => {
    const mac = addDevice('Mac')
    const seenAt = devices.list().find((d) => d.id === mac.id)?.lastSeenAt
    clock += TOUCH_INTERVAL_MS * 5
    expect(auth.deviceByCookie(header(mac.cookie))?.id).toBe(mac.id)
    expect(devices.list().find((d) => d.id === mac.id)?.lastSeenAt).toBe(seenAt)
    // authorize with the key does.
    expect(auth.authorize(header(mac.cookie), [mac.key])?.id).toBe(mac.id)
    expect(devices.list().find((d) => d.id === mac.id)?.lastSeenAt).toBe(clock)
  })

  it('an expired device names nobody and is not dropped by the lookup; a revoked one names nobody', () => {
    const mac = addDevice('Mac')
    clock += DEVICE_IDLE_MS + 1
    expect(auth.deviceByCookie(header(mac.cookie))).toBeUndefined()
    // The lookup changed nothing: no expiry logged, the record still there until something that
    // may drop it looks (the list, authorize).
    expect(accessLog.recent().some((e) => e.event === 'expired')).toBe(false)
    expect(devices.list().map((d) => d.id)).not.toContain(mac.id)
    expect(accessLog.recent().filter((e) => e.event === 'expired').map((e) => e.device)).toEqual([mac.id])
    const fresh = addDevice('Fresh')
    expect(auth.deviceByCookie(header(fresh.cookie))?.id).toBe(fresh.id)
    devices.revoke(fresh.id)
    expect(auth.deviceByCookie(header(fresh.cookie))).toBeUndefined()
  })
})
