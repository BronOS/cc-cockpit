// RemoteCookie (main/remote/remote-cookie.ts): the device cookie of a remote server's partition is
// only ever a session cookie in the jar (never written to the partition's database) and kept
// encrypted in the record. The fake jar replays what Chromium reports for a set over an existing
// cookie (a removal with cause `overwrite`, then the add), so the loop guard is tested against the
// events the re-set really causes.
import { describe, expect, it } from 'vitest'
import { REMOTE_DEVICE_COOKIE, RemoteCookie } from '../../src/main/remote/remote-cookie'
import { FakeCookieStore, FakeJar } from '../fakes/fake-cookie-jar'

function make(origin: string | null = 'http://127.0.0.1:4100') {
  const jar = new FakeJar()
  const store = new FakeCookieStore()
  const logs: string[] = []
  let signedIn = 0
  const current = { origin: origin ?? undefined }
  const cookie = new RemoteCookie({
    serverId: 's1',
    jar,
    store,
    origin: () => current.origin,
    onSignedIn: () => void signedIn++,
    log: (m) => void logs.push(m)
  })
  return { jar, store, logs, cookie, current, signedIn: () => signedIn }
}

/** The server's Set-Cookie after a sign-in: Max-Age, so Chromium gives it an expiry. */
function signIn(jar: FakeJar, value: string, domain = '127.0.0.1'): void {
  jar.put({ name: REMOTE_DEVICE_COOKIE, value, domain, expirationDate: Date.now() / 1000 + 86_400 })
}

describe('RemoteCookie', () => {
  it('restores the saved cookie as a session cookie on the origin, before any load', async () => {
    const t = make()
    t.store.saved = 'dev-1'
    await t.cookie.restore()
    expect(t.jar.sets).toEqual([
      { url: 'http://127.0.0.1:4100/', name: 'ccc_device', value: 'dev-1', path: '/', httpOnly: true, secure: false, sameSite: 'strict' }
    ])
    // No expiry: never in the partition's database.
    expect('expirationDate' in (t.jar.sets[0] as object)).toBe(false)
    // Our own set is not a sign-in: nothing saved again, nobody told.
    await t.cookie.idle()
    expect(t.store.setCalls).toEqual([])
    expect(t.signedIn()).toBe(0)
  })

  it('marks the cookie secure on an https origin', async () => {
    const t = make('https://box.example')
    t.store.saved = 'dev-1'
    await t.cookie.restore()
    expect(t.jar.sets[0]).toMatchObject({ url: 'https://box.example/', secure: true })
  })

  it('sets nothing with no saved cookie or no origin', async () => {
    const t = make()
    await t.cookie.restore()
    expect(t.jar.sets).toEqual([])
    const u = make(null)
    u.store.saved = 'dev-1'
    await u.cookie.restore()
    expect(u.jar.sets).toEqual([])
  })

  it('a sign-in is saved encrypted once and set again without an expiry; the re-set does not loop', async () => {
    const t = make()
    signIn(t.jar, 'dev-2')
    await t.cookie.idle()
    expect(t.store.setCalls).toEqual(['dev-2'])
    expect(t.jar.sets).toHaveLength(1)
    expect(t.jar.sets[0]).toMatchObject({ name: 'ccc_device', value: 'dev-2' })
    // The jar now holds the session copy (the persistent one replaced).
    expect(t.jar.cookies.get('ccc_device@127.0.0.1')?.expirationDate).toBeUndefined()
    expect(t.store.clears).toBe(0)
    expect(t.signedIn()).toBe(1)
  })

  it('the same sign-in reported twice is saved once', async () => {
    const t = make()
    signIn(t.jar, 'dev-2')
    signIn(t.jar, 'dev-2')
    await t.cookie.idle()
    expect(t.store.setCalls).toEqual(['dev-2'])
  })

  it('a refusing store is logged and the jar still gets the session copy', async () => {
    const t = make()
    t.store.refuse = true
    signIn(t.jar, 'dev-3')
    await t.cookie.idle()
    expect(t.jar.cookies.get('ccc_device@127.0.0.1')?.expirationDate).toBeUndefined()
    expect(t.logs.some((l) => l.includes('not remembered') && !l.includes('dev-3'))).toBe(true)
  })

  it('a removal that is not a replacement clears the record', async () => {
    const t = make()
    signIn(t.jar, 'dev-2')
    await t.cookie.idle()
    t.jar.remove('ccc_device', '127.0.0.1', 'expired-overwrite')
    await t.cookie.idle()
    expect(t.store.clears).toBe(1)
    expect(t.store.saved).toBeUndefined()
  })

  it('ignores other cookies and other hosts', async () => {
    const t = make()
    t.jar.put({ name: 'other', value: 'x', domain: '127.0.0.1', expirationDate: 1e10 })
    signIn(t.jar, 'dev-9', 'localhost')
    t.jar.remove('ccc_device', 'localhost', 'explicit')
    await t.cookie.idle()
    expect(t.store.setCalls).toEqual([])
    expect(t.store.clears).toBe(0)
    expect(t.jar.sets).toEqual([])
  })

  it('a jar that refuses the set is a log line, never a throw', async () => {
    const t = make()
    t.store.saved = 'dev-1'
    t.jar.failSet = true
    await expect(t.cookie.restore()).resolves.toBeUndefined()
    expect(t.logs.some((l) => l.includes('setting the device cookie failed') && !l.includes('dev-1'))).toBe(true)
  })
})
