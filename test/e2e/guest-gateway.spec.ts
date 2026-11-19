// Guests at the gateway (design-guests §3-§5, spec-review items 30-31; task 07b): a redeemed invite against
// the real app, from a raw client. What a guest can reach by guessing (each refusal looks exactly like the
// answer to something that does not exist: no oracle), and a kick: the 4460 close within 1 s of the
// kick, the cookie then answered as ended (D-32) and its upgrade refused. The clock starts at the store's
// kick (the hook); once 07a wires the router, the owner page's guests.kick reply starts it.
// The guest's page (05) and what it shows are guest-views.spec.ts; plugins and tabs need 07a's wiring.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import { CLOSE, FOLDERS_PATH, PROJECTS_PATH, SESSIONS_PATH } from '../../src/shared/web-protocol'
import { filesTree, joinProject, pluginActive, treeRow } from './download-fixtures'
import { expect, launchCockpit, test } from './fixtures'
import { guestGet, guestList, inviteGuest, rawSocket, redeem, redeemOk, session, upgradeRefused } from './guest-fixtures'
import { enableWebAccess, type WebBrowser } from './web-fixtures'

test('a read guest: redeems once, opens only its own project, and every guessed URL answers as a nonexistent one', async ({ cockpit }) => {
  test.setTimeout(90_000)
  const web = await enableWebAccess(cockpit)
  // A second project open in the same app: its id is real, so a refusal must not tell it from a made-up one.
  const otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-guest-other-')))
  try {
    await cockpit.hook('openProject', otherDir)
    let otherId = ''
    await expect
      .poll(async () => {
        for (const w of cockpit.app.windows()) {
          if (w === cockpit.page || w.isClosed()) continue
          const info = await w
            .evaluate(() => (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('window.info'))
            .catch(() => undefined)
          if (info?.kind === 'project' && info.project.path === otherDir) otherId = info.project.id
        }
        return otherId
      }, { timeout: 15_000 })
      .not.toBe('')

    const invited = await inviteGuest(cockpit, { name: 'Ada' })
    // Loopback bind: the link works on this computer only, and the answer says so (D-35).
    expect(invited.link.startsWith(`${web.origin}/#i=`)).toBe(true)
    expect(invited.warning).toBe('loopback-only')
    expect((await guestList(cockpit)).map((g) => [g.name, g.state])).toEqual([['Ada', 'pending']])

    const guest = await redeemOk(web.origin, invited.token)
    expect(guest.project).toBe(web.projectId)
    // One use: a second redeem of the same token is refused, and makes no device.
    const again = await redeem(web.origin, invited.token)
    expect(again.status).not.toBe(200)
    expect(again.client).toBeUndefined()
    expect((await guestList(cockpit)).map((g) => g.name)).toEqual(['Ada'])

    const s = await session(guest)
    expect(s.guest).toEqual({ name: 'Ada', role: 'read', project: web.projectId })

    // Its project list: its own project only, with no host path (D-33).
    const projects = JSON.parse((await guestGet(guest, PROJECTS_PATH)).body) as { projects: Array<{ id: string; path: string }> }
    expect(projects.projects.map((p) => [p.id, p.path])).toEqual([[web.projectId, '']])

    // Guessed routes: the owner's folder browser and session counts answer as a route that does not exist.
    const missing = (await guestGet(guest, '/api/no-such-route'))
    expect(missing.status).toBe(404)
    expect((await guestGet(guest, SESSIONS_PATH))).toEqual(missing)
    expect((await guestGet(guest, `${FOLDERS_PATH}?path=${encodeURIComponent(cockpit.projectDir)}`))).toEqual(missing)
    // Plugin pages, inline overlays and downloads by guessed token: as a token that never existed.
    const noPage = (await guestGet(guest, '/p/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/cockpit.files/index.html'))
    expect(noPage.status).toBe(404)
    expect((await guestGet(guest, '/o/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/index.html')).status).toBe(404)

    // The socket: its own project gives a ready snapshot marked guest, with no overlay prefix and no host path.
    const own = await rawSocket(guest)
    const ready = await own.next((f) => f.t === 'ready')
    const snap = ready.snapshot as Record<string, unknown>
    expect(snap.guest).toMatchObject({ name: 'Ada', role: 'read' })
    expect((ready.paths as { overlays: string }).overlays).toBe('')
    expect(own.texts.join('\n')).not.toContain(cockpit.projectDir)
    own.close()

    // Another project by id, open or made up: the same 4403 close, the same reason (no oracle).
    const other = await rawSocket(guest, otherId)
    const otherClose = await other.closed
    const madeUp = await rawSocket(guest, 'p-does-not-exist')
    const madeUpClose = await madeUp.closed
    expect(otherClose.code).toBe(CLOSE.guestProject)
    expect([otherClose.code, otherClose.reason]).toEqual([madeUpClose.code, madeUpClose.reason])
    expect(other.frames.some((f) => f.t === 'ready')).toBe(false)
  } finally {
    rmSync(otherDir, { recursive: true, force: true })
  }
})

test('kick: the guest socket closes 4460 within 1 s of the owner\'s kick, and its cookie is ended', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const web = await enableWebAccess(cockpit)
  const invited = await inviteGuest(cockpit, { name: 'Bo', role: 'write' })
  const guest = await redeemOk(web.origin, invited.token)
  const socket = await rawSocket(guest)
  await socket.next((f) => f.t === 'ready')
  expect((await guestList(cockpit)).find((g) => g.id === invited.guestId)?.state).not.toBe('pending')

  const kicked = await cockpit.hook<boolean>('guestKick', invited.guestId)
  const repliedAt = Date.now()
  expect(kicked).toBe(true)
  const closed = await socket.closed
  expect(closed.code).toBe(CLOSE.kicked)
  expect(closed.at - repliedAt).toBeLessThan(1000)

  // The cookie is a tombstone now (D-32): the session says ended, every API answers as an unknown device,
  // and the upgrade is refused.
  expect((await session(guest)).guestEnded).toBe(true)
  expect((await guestGet(guest, PROJECTS_PATH)).status).not.toBe(200)
  expect(await upgradeRefused(guest)).toBe(true)
  expect(await guestList(cockpit)).toEqual([])
})

test("a guest holding the owner's live /d/ token gets the answer a made-up token gets (cookie-bound, design-download §5)", async () => {
  test.setTimeout(120_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let owner: WebBrowser | undefined
  try {
    writeFileSync(join(c.projectDir, 'secret.txt'), 'owner only\n')
    const web = await enableWebAccess(c)
    await pluginActive(c, 'cockpit.files')
    owner = await joinProject(web)
    // The owner's Download, stopped in the browser before it reaches the gateway: a live, unused token.
    // In the browser's own session (a download is not a page request page.route sees): cancelled before it is sent.
    // Two of them: the owner spends one (proof a token caught this way is live), the guest tries the other.
    await owner.app.evaluate(({ session }) => {
      const g = globalThis as unknown as { capturedDownloads: string[] }
      g.capturedDownloads = []
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/d/*'] }, (details, callback) => {
        g.capturedDownloads.push(details.url)
        callback({ cancel: true })
      })
    })
    const captured = (): Promise<string[]> =>
      owner!.app.evaluate(() => (globalThis as unknown as { capturedDownloads: string[] }).capturedDownloads)
    const tree = await filesTree(owner.page)
    for (let i = 1; i <= 2; i++) {
      await treeRow(tree, 'secret.txt').click({ button: 'right' })
      await tree.getByRole('menu').getByRole('menuitem', { name: 'Download', exact: true }).click()
      await expect.poll(async () => (await captured()).length).toBe(i)
    }
    await owner.app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null))
    const [spent, ownerUrl] = await captured()
    const ownersOwn = await owner.page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: 'same-origin' })
      return { status: res.status, body: await res.text() }
    }, spent!)
    expect(ownersOwn).toEqual({ status: 200, body: 'owner only\n' })
    const ownerPath = ownerUrl!.slice(web.origin.length)

    const guest = await redeemOk(web.origin, (await inviteGuest(c, { name: 'Dee', role: 'write' })).token)
    const stolen = await guestGet(guest, ownerPath)
    const madeUp = await guestGet(guest, `/d/${'A'.repeat(43)}`)
    expect(stolen.status).not.toBe(200)
    expect(stolen).toEqual(madeUp)
    expect(stolen.body).not.toContain('owner only')
  } finally {
    await owner?.close()
    await close()
  }
})
