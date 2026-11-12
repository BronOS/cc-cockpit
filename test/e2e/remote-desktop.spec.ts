// Remote desktop, Direct (design-remote-desktop.md §3, §4, §6, §10; plan 20261112-remote-desktop Task 7):
// the desktop app's picker connects to a cc-cockpit server on this machine with a one-time add-device
// link and opens the server's web client in a sandboxed remote window.
//
// Two apps: the server is `launchServer` (server-fixtures.ts: headless, link mode, loopback on a random
// port) and the desktop app is the standard harness started with no folder, so the picker is its only
// window. The remote window is a BrowserWindow of the desktop app with no preload; Playwright sees it
// among `app.windows()`, found by its URL's origin (the server's).
//
// The desktop's secrets are the fake store (CC_COCKPIT_FAKE_SECRETS): a reversible encoding kept in
// `app.json`, so a relaunch on the same data dir reads the saved device cookie back as the keychain
// would (the restore half of the spike check).
//
// Linux only: server mode starts nowhere else.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { WebCliStatus } from '../../src/shared/web-access'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { addDeviceLink, ccc, expectMainAlive, launchServer, type Server } from './server-fixtures'

test.skip(process.platform !== 'linux', 'server mode runs on Linux only')

/** The remote window showing `origin`'s page (open, not the picker or a project window). */
async function remoteWindow(app: ElectronApplication, origin: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = app.windows().find((p) => !p.isClosed() && p.url().startsWith(`${origin}/`))
      return found !== undefined
    })
    .toBe(true)
  return found!
}

/** The desktop app's picker window (its page is the app's own renderer, not the server's). */
async function pickerWindow(app: ElectronApplication, origin: string): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(async () => {
      for (const p of app.windows()) {
        if (p.isClosed() || p.url().startsWith(`${origin}/`)) continue
        if ((await p.locator('main.picker').count().catch(() => 0)) > 0) {
          found = p
          return true
        }
      }
      return false
    })
    .toBe(true)
  return found!
}

/** Titles of the desktop app's windows, sorted. */
const titles = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .map((w) => w.getTitle())
      .sort()
  )

/** Replace shell.openExternal in main with a recorder (as overlays.spec.ts): nothing reaches a real browser. */
async function recordOpenExternal(c: Cockpit): Promise<() => Promise<string[]>> {
  await c.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  return () => c.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
}

async function status(server: Server): Promise<WebCliStatus> {
  const res = await ccc(server, ['web', 'status', '--json'])
  expect(res.code, res.stderr).toBe(0)
  return JSON.parse(res.stdout) as WebCliStatus
}

interface SavedServer {
  id: string
  name: string
  cookie?: string
}

function savedServers(dataDir: string): SavedServer[] {
  const app = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')) as { remoteServers?: SavedServer[] }
  return app.remoteServers ?? []
}

test('Direct: pair with a one-time link, work in the remote window, relaunch signed in, Forget', async () => {
  test.setTimeout(240_000)
  const server = await launchServer({ mode: 'link' })
  let desktop: { cockpit: Cockpit; close(options?: { keepFiles?: boolean }): Promise<void> } | undefined
  let root: string | undefined
  try {
    const projectName = basename(server.cockpit.projectDir)
    const link = await addDeviceLink(server)
    desktop = await launchCockpit({ folderArg: false, ready: 'picker' })
    root = desktop.cockpit.root
    const { app } = desktop.cockpit
    const opened = await recordOpenExternal(desktop.cockpit)
    const picker = desktop.cockpit.page

    // The Servers section starts empty, with the way in beside its title.
    await expect(picker.getByText('No servers yet.', { exact: false })).toBeVisible()
    await picker.getByRole('button', { name: 'Connect to server…' }).click()
    const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
    await dialog.getByRole('radio', { name: 'Link' }).check()
    // A link that is no link: the error shows in place and nothing is saved.
    await dialog.getByRole('textbox', { name: 'Link' }).fill('ftp://nowhere')
    await dialog.getByRole('button', { name: 'Connect' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('Cannot connect: only http and https links work')
    expect(savedServers(desktop.cockpit.dataDir)).toEqual([])

    await dialog.getByRole('textbox', { name: 'Link' }).fill(link)
    await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill('Test server')
    await dialog.getByRole('button', { name: 'Connect' }).click()

    // The remote window opens on the server's web picker, signed in by the link; main closes the
    // picker. (e) The app keeps running with only the remote window (Linux quits on a closed last
    // window otherwise).
    const remote = await remoteWindow(app, server.origin)
    await expect.poll(() => picker.isClosed()).toBe(true)
    await remote.getByRole('list', { name: 'Open projects' }).waitFor()
    expect(remote.url()).not.toContain('#t=')
    await new Promise((r) => setTimeout(r, 1500))
    expect(app.process().exitCode).toBeNull()
    expect(await titles(app)).toEqual(['Test server'])

    // (c) The server named the device after this machine (the desktop agent in the user agent).
    const devices = (await status(server)).devices
    expect(devices.map((d) => d.name)).toEqual([`cc-cockpit desktop on ${hostname()}`])
    expect(devices[0]!.mode).toBe('add')

    // (a) A project of the server opens in the remote window, from the server's own picker; main
    // tracks it from `?project=` and titles the window `<server> — <project>`.
    const href = `?project=${encodeURIComponent(server.projectId)}`
    await remote.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
    await expect(remote).toHaveURL(`${server.origin}/${href}`)
    await remote.locator('.tabs-pane').waitFor()
    await expect.poll(() => titles(app)).toEqual([`Test server — ${projectName}`])
    await expect(remote.getByRole('tab')).toHaveCount(0)

    // (b) The desktop key table: Ctrl+T (Cmd on a Mac) is New Claude Tab in a remote window; the
    // browser's Alt variant (web-keys.ts) is not bound there.
    await remote.locator('.tabs-pane').click()
    await remote.keyboard.press('Control+Alt+T')
    await new Promise((r) => setTimeout(r, 800))
    await expect(remote.getByRole('tab')).toHaveCount(0)
    await remote.keyboard.press('Control+T')
    await expect(remote.getByRole('tab')).toHaveCount(1)
    await expect(remote.getByRole('tab').first()).toHaveText(/^Claude/)

    // (d) A link the server's page opens goes to the person's browser (the recorded openExternal),
    // never to a window of the app.
    await remote.evaluate(() => {
      window.open('https://example.com/from-remote', '_blank')
    })
    await expect.poll(opened).toEqual(['https://example.com/from-remote'])
    expect(await titles(app)).toEqual([`Test server — ${projectName}`])

    // The record: one server, its cookie encrypted (the fake store's marked encoding), the recent project.
    await expect.poll(() => savedServers(desktop!.cockpit.dataDir).map((s) => s.name)).toEqual(['Test server'])
    const saved = savedServers(desktop.cockpit.dataDir)[0]!
    expect(saved.cookie?.startsWith('FAKE-SECRET-STORE-NOT-ENCRYPTED:')).toBe(true)

    await desktop.close({ keepFiles: true })
    desktop = undefined

    // (g) The spike check: the partition's cookie database never holds the device cookie (it is
    // kept only as a session cookie in the partition, and encrypted in the record). The database
    // exists (Chromium makes it for a `persist:` partition), so the check is never vacuous.
    const cookies = join(root, 'data', 'Partitions', `remote-${saved.id}`, 'Cookies')
    expect(existsSync(cookies)).toBe(true)
    expect(readFileSync(cookies).includes(Buffer.from('ccc_device'))).toBe(false)

    // (f) A relaunch on the same data dir: the picker lists the server and its recent project; opening
    // it restores the saved cookie and the window is signed in with no token and no new device.
    desktop = await launchCockpit({ root, folderArg: false, ready: 'picker' })
    const app2 = desktop.cockpit.app
    const picker2 = desktop.cockpit.page
    const projects = picker2.getByRole('list', { name: 'Recent projects on Test server' })
    await expect(picker2.getByText(`http://127.0.0.1:${server.port}`, { exact: true }).first()).toBeVisible()
    await projects.getByRole('button', { name: projectName }).click()
    const remote2 = await remoteWindow(app2, server.origin)
    await expect(remote2).toHaveURL(`${server.origin}/${href}`)
    await remote2.locator('.tabs-pane').waitFor()
    await expect(remote2.getByRole('tab')).toHaveCount(1)
    expect((await status(server)).devices).toHaveLength(1)
    await expect.poll(() => titles(app2)).toEqual([`Test server — ${projectName}`])

    // (h) Forget, from a picker opened over the remote window (File › Open Project): the server's
    // windows close and its entry goes, with its cookie.
    await app2.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
      file?.submenu?.items.find((i) => i.label === 'Open Project…')?.click()
    })
    const picker3 = await pickerWindow(app2, server.origin)
    await expect(picker3.getByText('1 window open', { exact: false })).toBeVisible()
    // Rename in place: the open window's title follows.
    await picker3.getByRole('button', { name: 'More for Test server' }).click()
    await picker3.getByRole('menuitem', { name: 'Rename…' }).click()
    const rename = picker3.getByRole('textbox', { name: 'New name for Test server' })
    await rename.fill('Box')
    await rename.press('Enter')
    await expect.poll(() => titles(app2)).toEqual(['Box — ' + projectName, 'cc-cockpit'].sort())
    await expect(picker3.getByRole('list', { name: 'Recent projects on Box' })).toBeVisible()

    await picker3.getByRole('button', { name: 'More for Box' }).click()
    await picker3.getByRole('menuitem', { name: 'Forget…' }).click()
    const confirm = picker3.getByRole('group', { name: 'Forget Box?' })
    await expect(confirm).toContainText('This machine stays in the server’s device list until you revoke it there.')
    await confirm.getByRole('button', { name: 'Forget' }).click()
    await expect.poll(() => remote2.isClosed()).toBe(true)
    await expect(picker3.getByText('No servers yet.', { exact: false })).toBeVisible()
    // app.json is written debounced (store/json-file.ts).
    await expect.poll(() => savedServers(desktop!.cockpit.dataDir)).toEqual([])
    expect(await titles(app2)).toEqual(['cc-cockpit'])

    await expectMainAlive(server)
  } finally {
    // A desktop run still open removes its folders on close; one closed with keepFiles for the
    // relaunch (a failure in between) leaves them to remove here.
    if (desktop !== undefined) await desktop.close()
    else if (root !== undefined) rmSync(root, { recursive: true, force: true })
    await server.close()
  }
})
