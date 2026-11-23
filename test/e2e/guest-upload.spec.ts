// Uploads and guests (design-upload.md §3.2, §6, §9; plan 20261122-upload Task 14): a read guest has no Upload
// here item and its drops do nothing, and a guessed `/u/` PUT (a made-up token, the owner's live token) gets the
// bytes a route that does not exist gets, for a read and for a write guest; a write guest's Upload here lands, and
// a file it drops on a shared Claude tab is pasted into the tab as a path relative to the tab's folder (D-33:
// no host path ever reaches a guest).
//
// The "device" is a temp folder outside the project; the guests are plain browsers (test/fixtures/web-browser).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import { DEVICE_KEY_HEADER } from '../../src/shared/web-protocol'
import { filesTree, joinProject, pluginActive, treeRow } from './download-fixtures'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestGet, inviteGuest, redeemOk, type Answer, type GuestClient } from './guest-fixtures'
import { centreOf, chooseAndGo, dropPaths, resultNotice, uploadHere } from './upload-fixtures'
import { enableWebAccess, openBrowser, type WebBrowser } from './web-fixtures'

/** Files shown to guests (hidden by default, bundled included, design.md §5 "Guests"). */
async function showFiles(c: Cockpit): Promise<void> {
  await c.page.evaluate(async () => {
    const api = (window as unknown as { cockpit: CockpitApi }).cockpit
    await (api.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)('settings.pluginGuestAccessSet', { pluginId: 'cockpit.files', target: 'app', value: 'shown' })
  })
}

/** A PUT as a page's keyed fetch makes it (cookie, origin key, the gateway's own Origin). */
async function guestPut(client: GuestClient, path: string): Promise<Answer> {
  const res = await fetch(`${client.origin}${path}`, {
    method: 'PUT',
    headers: { Origin: client.origin, Cookie: client.cookie, [DEVICE_KEY_HEADER]: client.key, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('guessed bytes'),
    redirect: 'manual'
  })
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() }
}

const statusOf = async (c: Cockpit): Promise<string | undefined> => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status

test("a read guest: no Upload here item, its drops do nothing, and a guessed /u/ PUT (made-up or the owner's live token) answers as a route that does not exist", async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let owner: WebBrowser | undefined
  let guest: WebBrowser | undefined
  const device = mkdtempSync(join(tmpdir(), 'ccc-e2e-device-'))
  try {
    const { projectDir } = c
    mkdirSync(join(projectDir, 'dest'))
    writeFileSync(join(device, 'mine.txt'), 'owner bytes\n')
    writeFileSync(join(device, 'guest.txt'), 'guest bytes\n')
    const web = await enableWebAccess(c)
    await pluginActive(c, 'cockpit.files')
    await showFiles(c)
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')

    // The owner's upload, stopped in the browser before it reaches the gateway: a live token of the owner's.
    owner = await joinProject(web)
    await owner.app.evaluate(({ session }) => {
      const g = globalThis as unknown as { capturedUploads: string[] }
      g.capturedUploads = []
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/u/*'] }, (details, callback) => {
        g.capturedUploads.push(details.url)
        callback({ cancel: true })
      })
    })
    const ownerTree = await filesTree(owner.page)
    await uploadHere(owner.page, ownerTree, 'dest', [join(device, 'mine.txt')])
    await expect
      .poll(() => owner!.app.evaluate(() => (globalThis as unknown as { capturedUploads: string[] }).capturedUploads.length), { timeout: 20_000 })
      .toBeGreaterThan(0)
    const [ownerUrl] = await owner.app.evaluate(() => (globalThis as unknown as { capturedUploads: string[] }).capturedUploads)
    const ownerPath = ownerUrl!.slice(web.origin.length)
    expect(ownerPath).toMatch(/^\/u\/[A-Za-z0-9_-]{43}\?offset=0$/)

    // Raw clients, read and write: the owner's token, a made-up one and a route that is not there answer alike.
    for (const role of ['read', 'write'] as const) {
      const client = await redeemOk(web.origin, (await inviteGuest(c, { name: `Raw ${role}`, role })).token)
      const stolen = await guestPut(client, ownerPath)
      const madeUp = await guestPut(client, `/u/${'A'.repeat(43)}?offset=0`)
      // A route that does not exist, as a guest's GET meets it (a PUT elsewhere is a 405 for everyone: `/u/`
      // is the one PUT route, so that it takes PUT is no secret; what a token is, or was, must be).
      const nothing = await guestGet(client, `/nothing-here/${'A'.repeat(43)}`)
      expect(stolen.status).toBe(404)
      expect(stolen).toEqual(madeUp)
      expect(stolen).toEqual(nothing)
    }
    // The owner's client is let through now (its token is live, it was only held back): its own bytes land and
    // nothing of a guest's PUT is in the file or beside it.
    await owner.app.evaluate(({ session }) => session.defaultSession.webRequest.onBeforeRequest(null))
    await expect(resultNotice(owner.page, /^Uploaded mine\.txt to dest/)).toBeVisible({ timeout: 90_000 })
    expect(readdirSync(join(projectDir, 'dest'))).toEqual(['mine.txt'])
    expect(readFileSync(join(projectDir, 'dest', 'mine.txt'), 'utf8')).toBe('owner bytes\n')

    // The read guest's page: Files shows no Upload here, and a drop on a folder row or on the tab does nothing.
    const invited = await inviteGuest(c, { name: 'Rae', role: 'read' })
    guest = await openBrowser(invited.link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toContainText('read-only', { timeout: 20_000 })
    await guest.waitForTerminalText('FAKE-CLAUDE banner')
    const tree = await filesTree(page)
    await expect(treeRow(tree, 'dest')).toBeVisible({ timeout: 20_000 })
    await treeRow(tree, 'dest').click({ button: 'right' })
    const menu = tree.getByRole('menu')
    await expect(menu).toBeVisible()
    const items = await menu.getByRole('menuitem').allInnerTexts()
    expect(items.length).toBeGreaterThan(0)
    expect(items).not.toContainEqual(expect.stringMatching(/^Upload/))
    await page.keyboard.press('Escape')
    await dropPaths(page, await centreOf(treeRow(tree, 'dest')), [join(device, 'guest.txt')])
    await dropPaths(page, await centreOf(page.locator('.terminal-view:not([hidden])')), [join(device, 'guest.txt')])
    await new Promise((r) => setTimeout(r, 1_500))
    for (const id of ['upload-dialog', 'upload-progress', 'upload-result', 'upload-clash']) await expect(page.getByTestId(id)).toHaveCount(0)
    expect(existsSync(join(projectDir, 'guest.txt'))).toBe(false)
    expect(readdirSync(join(projectDir, 'dest'))).toEqual(['mine.txt'])
  } finally {
    await guest?.close()
    await owner?.close()
    await close()
    rmSync(device, { recursive: true, force: true })
  }
})

test('a write guest: Upload here lands in the folder, and a file dropped on the shared Claude tab is pasted as a path relative to the tab', async () => {
  test.setTimeout(180_000)
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let guest: WebBrowser | undefined
  const device = mkdtempSync(join(tmpdir(), 'ccc-e2e-device-'))
  try {
    const { projectDir } = c
    mkdirSync(join(projectDir, 'dest'))
    writeFileSync(join(device, 'up.txt'), 'uploaded by the guest\n')
    writeFileSync(join(device, 'drop me.txt'), 'dropped by the guest\n')
    await enableWebAccess(c)
    await pluginActive(c, 'cockpit.files')
    await showFiles(c)
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await expect.poll(() => statusOf(c), { timeout: 15_000 }).toBe('waiting')

    const invited = await inviteGuest(c, { name: 'Wes', role: 'write' })
    guest = await openBrowser(invited.link)
    const { page } = guest
    await expect(page.getByTestId('guest-banner')).toHaveAttribute('data-role', 'write', { timeout: 20_000 })
    await guest.waitForTerminalText('FAKE-CLAUDE banner')

    // Upload here: the item is there for a write guest, the file lands, the notice names no host path.
    const tree = await filesTree(page)
    await expect(treeRow(tree, 'dest')).toBeVisible({ timeout: 20_000 })
    await uploadHere(page, tree, 'dest', [join(device, 'up.txt')])
    await expect(resultNotice(page, /^Uploaded up\.txt to dest/)).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(join(projectDir, 'dest', 'up.txt'), 'utf8')).toBe('uploaded by the guest\n')
    expect(await resultNotice(page).allInnerTexts()).not.toContainEqual(expect.stringContaining(projectDir))

    // A drop on the shared Claude tab: the path pasted is relative to the tab's folder (the project), never absolute.
    await dropPaths(page, await centreOf(page.locator('.terminal-view:not([hidden])')), [join(device, 'drop me.txt')])
    await chooseAndGo(page)
    await expect(resultNotice(page, /^Uploaded drop me\.txt to the project folder/)).toBeVisible({ timeout: 30_000 })
    expect(readFileSync(join(projectDir, 'drop me.txt'), 'utf8')).toBe('dropped by the guest\n')
    await guest.waitForTerminalText('./drop\\ me.txt')
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.press('Enter')
    await guest.waitForTerminalText('FAKE-CLAUDE echo: ./drop\\ me.txt ')
    expect(await guest.terminalText()).not.toContain(projectDir)
  } finally {
    await guest?.close()
    await close()
    rmSync(device, { recursive: true, force: true })
  }
})
