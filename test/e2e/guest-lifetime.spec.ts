// Guest lifetimes across a restart (design-guests §6, D-12, D-32; spec-review item 31; task 07b): guests
// are written to `<data>/web-access.json`, so a quit and a relaunch keep them. One guest's lifetime is
// moved into the past while the app is down, one is set to end a few seconds after the relaunch, one
// is kept forever: the first is refused at once (its cookie answered as ended), the second gets 4463
// when its time comes (the sweep, at most SWEEP_MS late), the third keeps working.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SWEEP_MS } from '../../src/main/web/guests'
import { CLOSE } from '../../src/shared/web-protocol'
import { expect, launchCockpit, test } from './fixtures'
import { inviteGuest, rawSocket, redeemOk, session, upgradeRefused } from './guest-fixtures'
import { enableWebAccess } from './web-fixtures'

test('a relaunch keeps guests; an expired one is refused, one ending later gets 4463, a forever one stays', async () => {
  test.setTimeout(150_000)
  const first = await launchCockpit()
  let root = first.cockpit.root
  let closeSecond: (() => Promise<void>) | undefined
  try {
    const web = await enableWebAccess(first.cockpit)
    const expired = await inviteGuest(first.cockpit, { name: 'Expired' })
    const later = await inviteGuest(first.cockpit, { name: 'Later' })
    const forever = await inviteGuest(first.cockpit, { name: 'Forever', lifetime: 'forever' })
    const clients = {
      expired: await redeemOk(web.origin, expired.token),
      later: await redeemOk(web.origin, later.token),
      forever: await redeemOk(web.origin, forever.token)
    }
    await first.close({ keepFiles: true })

    // Edit the stored lifetimes the app itself wrote (never a hand-made record: a malformed one is
    // dropped as damaged, which would look like an expiry and prove nothing).
    const file = join(first.cockpit.dataDir, 'web-access.json')
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { guests: { guests: Array<{ id: string; until: number | null }> } }
    const rows = stored.guests.guests
    expect(rows.map((g) => g.id).sort()).toEqual([expired.guestId, later.guestId, forever.guestId].sort())
    expect(rows.find((g) => g.id === forever.guestId)?.until).toBeNull()
    const laterUntil = Date.now() + 25_000
    for (const g of rows) {
      if (g.id === expired.guestId) g.until = Date.now() - 60_000
      if (g.id === later.guestId) g.until = laterUntil
    }
    writeFileSync(file, JSON.stringify(stored))

    const second = await launchCockpit({ root })
    closeSecond = second.close
    root = ''
    // Web access comes back on by itself, on the same port (app.json kept it).
    await expect
      .poll(() => fetch(`${web.origin}/auth/session`, { headers: { Origin: web.origin } }).then((r) => r.status).catch(() => 0), { timeout: 20_000 })
      .toBe(200)

    // Expired while the app was down: refused at once, its page told the access ended.
    expect(await upgradeRefused(clients.expired)).toBe(true)
    expect((await session(clients.expired)).guestEnded).toBe(true)

    // Forever: survives the restart.
    const keeps = await rawSocket(clients.forever)
    await keeps.next((f) => f.t === 'ready')

    // Ends after the relaunch: connected now, closed 4463 once its time is up (at most a sweep late).
    const ending = await rawSocket(clients.later)
    await ending.next((f) => f.t === 'ready')
    const closed = await Promise.race([
      ending.closed,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), laterUntil - Date.now() + SWEEP_MS + 10_000))
    ])
    expect(closed?.code).toBe(CLOSE.accessEnded)
    expect(closed!.at).toBeGreaterThanOrEqual(laterUntil - 1000)
    expect((await session(clients.later)).guestEnded).toBe(true)

    // The forever guest was never touched by either end.
    expect(keeps.ws.readyState).toBe(keeps.ws.OPEN)
    keeps.close()
  } finally {
    if (closeSecond) await closeSecond()
    else if (root) await first.close().catch(() => {})
  }
})
