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
// Built-in SSH and My own tunnel (remote SSH rev 2 Task 7): see the section after the Direct test; the
// SSH server is test/fixtures/ssh-server.mjs.
//
// Linux only: server mode starts nowhere else.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { utils } from 'ssh2'
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
  secrets?: { password?: string; passphrase?: string }
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
    await dialog.getByRole('tab', { name: 'Link' }).click()
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

    // (i) Back to the picker (§4): the tab strip's "+" in the remote window shows the desktop picker,
    // not the server's web one, and the project is still open on the server, so the window stays on it.
    // noWaitAfter: the click starts a navigation main cancels, which Playwright would wait on forever.
    await remote.getByRole('button', { name: 'Open project…' }).click({ noWaitAfter: true })
    const back = await pickerWindow(app, server.origin)
    await expect(back.getByRole('button', { name: 'Connect to server…' })).toBeVisible()
    await new Promise((r) => setTimeout(r, 1000))
    expect(remote.isClosed()).toBe(false)
    // Read through main: Playwright keeps waiting on the navigation main cancelled, so its locators would too.
    const shown = await app.evaluate(async ({ BrowserWindow }, origin) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(`${origin}/`))
      if (win === undefined) return undefined
      const pane = (await win.webContents.executeJavaScript("document.querySelector('.tabs-pane') !== null")) as boolean
      return { url: win.webContents.getURL(), pane }
    }, server.origin)
    expect(shown).toEqual({ url: `${server.origin}/${href}`, pane: true })
    expect(await titles(app)).toEqual([`Test server — ${projectName}`, 'cc-cockpit'].sort())

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

    // (j) Close project in the remote window (§4 "Back to the picker"): the server closes it for every
    // device, the page's move to the server's picker becomes the desktop picker, and the window, whose
    // project is no longer open, closes.
    await remote2.getByRole('button', { name: 'Close project' }).first().click()
    const closeConfirm = remote2.getByRole('alertdialog', { name: /^Close .+ for every device\?$/ }).getByRole('button', { name: 'Close project' })
    await expect(closeConfirm).toBeEnabled({ timeout: 5_000 })
    await closeConfirm.click({ noWaitAfter: true })
    await expect.poll(() => remote2.isClosed(), { timeout: 15_000 }).toBe(true)
    const backPicker = await pickerWindow(app2, server.origin)
    await expect(backPicker.getByRole('list', { name: 'Recent projects on Test server' })).toBeVisible()
    expect(await titles(app2)).toEqual(['cc-cockpit'])

    // (k) The same project from the desktop picker's recent row, closed on the server now: main reopens
    // it there first (the server's own `{ reopen }` POST, with its Origin), so the window shows the
    // project, not the web client's "not open on the host" page.
    await backPicker.getByRole('list', { name: 'Recent projects on Test server' }).getByRole('button', { name: projectName }).click()
    const remote4 = await remoteWindow(app2, server.origin)
    await expect(remote4).toHaveURL(`${server.origin}/${href}`)
    await remote4.locator('.tabs-pane').waitFor()
    await expect(remote4.getByText('This project is not open on the host.')).toHaveCount(0)
    await expect.poll(() => titles(app2)).toEqual([`Test server — ${projectName}`])
    await expect.poll(() => backPicker.isClosed()).toBe(true)
    // Closed again as in (j), so the server's picker below lists it among its recent projects.
    await remote4.getByRole('button', { name: 'Close project' }).first().click()
    const closeAgain = remote4.getByRole('alertdialog', { name: /^Close .+ for every device\?$/ }).getByRole('button', { name: 'Close project' })
    await expect(closeAgain).toBeEnabled({ timeout: 5_000 })
    await closeAgain.click({ noWaitAfter: true })
    await expect.poll(() => remote4.isClosed(), { timeout: 15_000 }).toBe(true)
    const pickerAgain = await pickerWindow(app2, server.origin)

    // The server's own picker in a window again (for Forget below); the desktop picker closes as for any open.
    await pickerAgain.getByRole('button', { name: 'More for Test server' }).click()
    await pickerAgain.getByRole('menuitem', { name: 'Open server’s picker' }).click()
    const remote3 = await remoteWindow(app2, server.origin)
    await remote3.getByRole('list', { name: 'Recent projects' }).waitFor()
    await expect.poll(() => pickerAgain.isClosed()).toBe(true)

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
    await expect.poll(() => titles(app2)).toEqual(['Box', 'cc-cockpit'])
    await expect(picker3.getByRole('list', { name: 'Recent projects on Box' })).toBeVisible()

    await picker3.getByRole('button', { name: 'More for Box' }).click()
    await picker3.getByRole('menuitem', { name: 'Forget…' }).click()
    const confirm = picker3.getByRole('group', { name: 'Forget Box?' })
    await expect(confirm).toContainText('This machine stays in the server’s device list until you revoke it there.')
    await confirm.getByRole('button', { name: 'Forget' }).click()
    await expect.poll(() => remote3.isClosed()).toBe(true)
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

// A session chip of another project in a remote window (design-remote-desktop.md §4): the server sends
// the page to that project (`project.goto`, `?project=<id>&tab=<id>`); main cancels the move and opens
// that project in its own remote window with the tab selected, and the first window stays on its project.
test('Direct: a session chip of another project opens that project in its own remote window, that tab selected', async () => {
  test.setTimeout(180_000)
  // The bundled plugins on in the server (the harness turns them off): the strip is cockpit.sessions'.
  const server = await launchServer({ mode: 'link', env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let desktop: { cockpit: Cockpit; close(options?: { keepFiles?: boolean }): Promise<void> } | undefined
  try {
    const projectName = basename(server.cockpit.projectDir)
    const other = join(realpathSync(server.cockpit.root), 'other')
    mkdirSync(other)
    await server.cockpit.hook('openProject', other)
    // Two Claude tabs there; the second one's chip is clicked (a plain open would select the first).
    let first: string | undefined
    await expect.poll(async () => (first = await server.cockpit.hook<string | undefined>('openClaudeTab', other))).toBeTruthy()
    const second = await server.cockpit.hook<string>('openClaudeTab', other)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)

    const link = await addDeviceLink(server)
    desktop = await launchCockpit({ folderArg: false, ready: 'picker' })
    const { app } = desktop.cockpit
    const picker = desktop.cockpit.page
    await picker.getByRole('button', { name: 'Connect to server…' }).click()
    const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
    await dialog.getByRole('tab', { name: 'Link' }).click()
    await dialog.getByRole('textbox', { name: 'Link' }).fill(link)
    await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill('Test server')
    await dialog.getByRole('button', { name: 'Connect' }).click()
    const remote = await remoteWindow(app, server.origin)
    const href = `?project=${encodeURIComponent(server.projectId)}`
    await remote.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
    await expect(remote).toHaveURL(`${server.origin}/${href}`)
    await remote.locator('.tabs-pane').waitFor()

    // noWaitAfter: the click starts a navigation main cancels, which Playwright would wait on forever.
    const strip = remote.frameLocator('.top-strip iframe[title="sessions-strip slot"]')
    await expect(strip.locator('.entry')).toHaveCount(2, { timeout: 15_000 })
    await strip.locator(`.entry[data-tab-id="${second}"]`).click({ noWaitAfter: true })

    // A second remote window, on the other project, with the clicked tab selected and `tab` dropped.
    await expect.poll(() => titles(app), { timeout: 15_000 }).toEqual([`Test server — ${projectName}`, 'Test server — other'].sort())
    let otherPage: Page | undefined
    await expect
      .poll(() => {
        otherPage = app.windows().find((p) => p !== remote && !p.isClosed() && p.url().startsWith(`${server.origin}/?project=`))
        return otherPage !== undefined
      })
      .toBe(true)
    await otherPage!.locator('.tabs-pane').waitFor()
    await expect(otherPage!.getByRole('tab')).toHaveCount(2)
    await expect(otherPage!.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => otherPage!.url()).not.toContain('tab=')

    // The first window stays on its project. Read through main: Playwright keeps waiting on the
    // navigation main cancelled, so its locators would too.
    const shown = await app.evaluate(({ BrowserWindow }, origin) => {
      return BrowserWindow.getAllWindows()
        .map((w) => w.webContents.getURL())
        .filter((u) => u.startsWith(`${origin}/`))
        .sort()
    }, server.origin)
    expect(shown).toContain(`${server.origin}/${href}`)
    expect(shown).toHaveLength(2)

    // The chip again: the other project's window is focused, none is opened. Clicked through main's
    // frame of the strip, for the same reason (Playwright still waits on the cancelled navigation).
    // The first window has the focus before.
    await app.evaluate(({ BrowserWindow }, title) => BrowserWindow.getAllWindows().find((w) => w.getTitle() === title)?.focus(), `Test server — ${projectName}`)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle())).toBe(`Test server — ${projectName}`)
    const clicked = await app.evaluate(
      async ({ BrowserWindow }, { origin, project, tabId }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === `${origin}/?project=${project}`)
        for (const frame of win?.webContents.mainFrame.framesInSubtree ?? []) {
          const hit = (await frame.executeJavaScript(
            `(() => { const b = document.querySelector('.entry[data-tab-id="${tabId}"]'); if (b) b.click(); return b !== null })()`
          )) as boolean
          if (hit) return true
        }
        return false
      },
      { origin: server.origin, project: encodeURIComponent(server.projectId), tabId: second }
    )
    expect(clicked).toBe(true)
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle())).toBe('Test server — other')
    expect((await titles(app)).length).toBe(2)
    await expectMainAlive(server)
  } finally {
    if (desktop !== undefined) await desktop.close()
    await server.close()
  }
})

// ---------------------------------------------------------------------------------------------
// Built-in SSH and My own tunnel (plan 20261112-remote-ssh-builtin Task 7)
//
// The app's own `ssh2` client dials test/fixtures/ssh-server.mjs, a small `ssh2` server on a loopback
// port that runs the remote command locally against the test server's own `ccc` and connects
// `direct-tcpip` channels to the gateway. The desktop's HOME is launchCockpit's temp home (so its
// `~/.ssh` is empty: nothing of the real keys or known_hosts is read), SSH_AUTH_SOCK is removed from
// its env, and its SHELL is the fixture's fake shell, so the login env cannot bring the real agent
// back. The tunnel's local port differs from the gateway's, which proves the gateway's Host rule
// (design §5.3).

const SSH_SERVER = resolve(__dirname, '../fixtures/ssh-server.mjs')
const SSH_USER = 'alice'
const SSH_PASSWORD = 'correct horse'

type Desktop = { cockpit: Cockpit; close(options?: { keepFiles?: boolean }): Promise<void> }

interface HostKey {
  file: string
  /** `SHA256:...` as `ssh-keygen -lf` prints it. */
  fingerprint: string
}

function makeHostKey(dir: string, name: string): HostKey {
  const pair = utils.generateKeyPairSync('ed25519')
  const file = join(dir, name)
  writeFileSync(file, pair.private, { mode: 0o600 })
  const blob = Buffer.from(pair.public.split(' ')[1] ?? '', 'base64')
  return { file, fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}` }
}

interface SshFixture {
  port: number
  /** The fixture's log lines (`exec <command>`, `tcpip <port>`) of every run on this dir. */
  log(): string[]
  /** Ends the process (and its clients) and waits for it. */
  stop(): Promise<void>
}

/** Starts the fixture; `port` to start again on the port of an earlier run (a restart of the "sshd"). */
async function startSsh(dir: string, server: Server, hostKey: HostKey, port?: number): Promise<SshFixture> {
  const logFile = join(dir, 'ssh.log')
  const child = spawn(
    process.execPath,
    [
      SSH_SERVER,
      '--host-key', hostKey.file,
      '--user', SSH_USER,
      '--password', SSH_PASSWORD,
      '--home', join(dir, 'remote-home'),
      '--ccc', join(server.cockpit.dataDir, 'bin', 'ccc'),
      '--log', logFile,
      ...(port !== undefined ? ['--port', String(port)] : [])
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  )
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  const listening = await new Promise<number>((ok, fail) => {
    let text = ''
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      const line = text.split('\n')[0]
      if (text.includes('\n') && line !== undefined) ok(Number(line))
    })
    child.once('exit', (code) => fail(new Error(`ssh-server.mjs exited with ${String(code)}`)))
  })
  return {
    port: listening,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== '') : []),
    stop: async () => {
      child.kill('SIGTERM')
      await exited
    }
  }
}

/** The desktop app, picker only, with no agent and (as every launch) a temp HOME with no `~/.ssh`. */
function launchDesktop(root?: string): Promise<Desktop> {
  return launchCockpit({ ...(root !== undefined ? { root } : {}), folderArg: false, ready: 'picker', env: { SSH_AUTH_SOCK: undefined } })
}

/** The desktop app's remote window on a tunnel: a loopback page that is not the server's own origin. */
async function tunnelWindow(app: ElectronApplication, server: Server): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = app.windows().find((p) => {
        const u = p.isClosed() ? '' : p.url()
        return u.startsWith('http://127.0.0.1:') && !u.startsWith(`${server.origin}/`)
      })
      return found !== undefined
    })
    .toBe(true)
  return found!
}

/** Fill and submit the SSH tab of the Connect form; resolves with the dialog. */
async function connectSsh(picker: Page, port: number, name: string): Promise<Locator> {
  await picker.getByRole('button', { name: 'Connect to server…' }).click()
  const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
  await dialog.getByTestId('connect-tab-ssh').click()
  await dialog.getByTestId('connect-ssh-host').fill('127.0.0.1')
  await dialog.getByTestId('connect-ssh-user').fill(SSH_USER)
  await dialog.getByTestId('connect-ssh-port').fill(String(port))
  await dialog.getByTestId('connect-ssh-auth-password').check()
  await dialog.getByTestId('connect-name').fill(name)
  await dialog.getByTestId('connect-submit').click()
  return dialog
}

/** The Trust prompt: shown with the fixture's fingerprint, then trusted. */
async function trustHost(picker: Page, key: HostKey, port: number): Promise<void> {
  const trust = picker.getByTestId('remote-hostkey-prompt')
  await expect(trust).toBeVisible()
  await expect(trust.getByTestId('remote-hostkey-fingerprint')).toHaveText(key.fingerprint)
  await expect(trust.getByTestId('remote-hostkey-type')).toHaveText('ssh-ed25519')
  await expect(trust.getByTestId('remote-hostkey-address')).toContainText(`127.0.0.1:${port}`)
  // Armed after about a second (ApprovalArm); a click before is ignored, so the auto-wait covers it.
  await trust.getByTestId('remote-hostkey-trust').click()
}

/** The Password prompt: typed, Remember set as asked. */
async function typePassword(picker: Page, password: string, remember: boolean): Promise<void> {
  const prompt = picker.getByTestId('remote-secret-prompt')
  await expect(prompt).toBeVisible()
  await prompt.getByTestId('remote-secret-input').fill(password)
  await prompt.getByTestId('remote-secret-remember').setChecked(remember)
  await prompt.getByTestId('remote-secret-ok').click()
}

const execs = (ssh: SshFixture, word: string): number => ssh.log().filter((l) => l.startsWith('exec ') && l.includes(`'${word}'`)).length

/** Reload the window until the server's page shows (the tunnel may still be redialling). */
async function reloadUntilSignedIn(page: Page): Promise<void> {
  await expect(async () => {
    await page.reload()
    await page.locator('.tabs-pane, [aria-label="Open projects"]').first().waitFor({ timeout: 8_000 })
  }).toPass({ timeout: 60_000 })
}

const homeOf = (root: string): string => join(root, 'home')

test('Built-in SSH: Trust, password not remembered, a revoke re-pairs once, an sshd restart, a relaunch asks, Remember keeps it', async () => {
  test.setTimeout(300_000)
  const server = await launchServer({ mode: 'link' })
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-sshd-'))
  const key = makeHostKey(dir, 'host_key')
  let ssh = await startSsh(dir, server, key)
  let desktop: Desktop | undefined
  let root: string | undefined
  try {
    const projectName = basename(server.cockpit.projectDir)
    desktop = await launchDesktop()
    root = desktop.cockpit.root
    expect(existsSync(join(homeOf(root), '.ssh', 'known_hosts'))).toBe(false)
    const { app } = desktop.cockpit
    const picker = desktop.cockpit.page

    await connectSsh(picker, ssh.port, 'Box')
    await trustHost(picker, key, ssh.port)
    await typePassword(picker, SSH_PASSWORD, false)

    // The window is on the tunnel's loopback port, not the server's, and signed in with no link pasted.
    const remote = await tunnelWindow(app, server)
    const tunnelPort = Number(new URL(remote.url()).port)
    expect(tunnelPort).not.toBe(server.port)
    expect(tunnelPort).not.toBe(ssh.port)
    await expect.poll(() => picker.isClosed()).toBe(true)
    await remote.getByRole('list', { name: 'Open projects' }).waitFor()
    expect(remote.url()).not.toContain('#t=')
    expect(execs(ssh, 'status')).toBeGreaterThanOrEqual(1)
    expect(execs(ssh, 'add-device')).toBe(1)
    const first = (await status(server)).devices
    expect(first.map((d) => d.name)).toEqual([`cc-cockpit desktop on ${hostname()}`])
    expect(await titles(app)).toEqual(['Box'])

    // Saved, host key and all, but the password was not remembered: no secrets in the record.
    await expect.poll(() => savedServers(desktop!.cockpit.dataDir).map((s) => s.name)).toEqual(['Box'])
    expect(savedServers(desktop.cockpit.dataDir)[0]!.secrets).toBeUndefined()

    // Into the project, so the window's page is a live project client through the tunnel.
    const href = `?project=${encodeURIComponent(server.projectId)}`
    await remote.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
    await remote.locator('.tabs-pane').waitFor()
    await expect.poll(() => titles(app)).toEqual([`Box — ${projectName}`])

    // A revoke on the server: the window's next load finds the sign-in screen and re-pairs once.
    const adds = execs(ssh, 'add-device')
    const res = await ccc(server, ['web', 'revoke', '--', first[0]!.id])
    expect(res.code, res.stderr).toBe(0)
    expect((await status(server)).devices).toHaveLength(0)
    await remote.reload()
    await expect.poll(async () => (await status(server)).devices.length, { timeout: 60_000 }).toBe(1)
    expect((await status(server)).devices[0]!.id).not.toBe(first[0]!.id)
    await remote.locator('.tabs-pane').waitFor({ timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 1500))
    expect((await status(server)).devices).toHaveLength(1)
    expect(execs(ssh, 'add-device')).toBe(adds + 1)

    // The "sshd" restarts on the same port with the same host key: the app redials with the password
    // it holds in memory and the window works again, with no prompt anywhere.
    await ssh.stop()
    ssh = await startSsh(dir, server, key, ssh.port)
    await reloadUntilSignedIn(remote)
    await remote.locator('.tabs-pane').waitFor({ timeout: 30_000 })
    expect((await status(server)).devices).toHaveLength(1)
    expect(app.windows().filter((p) => !p.isClosed() && p !== remote)).toEqual([])
    expect(ssh.log().some((l) => l.startsWith('tcpip '))).toBe(true)

    await desktop.close({ keepFiles: true })
    desktop = undefined

    // A relaunch: the password was not remembered, so the server row asks for it (the host key is
    // known, so no Trust). Remember on this time.
    desktop = await launchDesktop(root)
    let picker2 = desktop.cockpit.page
    await picker2.getByTitle("Open Box's picker").click()
    await expect(picker2.getByTestId('remote-hostkey-prompt')).toHaveCount(0)
    await typePassword(picker2, SSH_PASSWORD, true)
    let window2 = await tunnelWindow(desktop.cockpit.app, server)
    await window2.getByRole('list', { name: 'Open projects' }).waitFor()
    await expect.poll(() => savedServers(desktop!.cockpit.dataDir)[0]!.secrets?.password).toMatch(/^FAKE-SECRET-STORE-NOT-ENCRYPTED:/)
    expect((await status(server)).devices).toHaveLength(1)

    await desktop.close({ keepFiles: true })
    desktop = undefined

    // Remembered: the next relaunch opens with no prompt at all.
    desktop = await launchDesktop(root)
    picker2 = desktop.cockpit.page
    await picker2.getByTitle("Open Box's picker").click()
    window2 = await tunnelWindow(desktop.cockpit.app, server)
    await window2.getByRole('list', { name: 'Open projects' }).waitFor()
    expect(desktop.cockpit.app.windows().some((p) => !p.isClosed() && p.url().startsWith('file:') && p !== picker2)).toBe(false)
    expect((await status(server)).devices).toHaveLength(1)

    await expectMainAlive(server)
  } finally {
    if (desktop !== undefined) await desktop.close()
    else if (root !== undefined) rmSync(root, { recursive: true, force: true })
    await ssh.stop()
    rmSync(dir, { recursive: true, force: true })
    await server.close()
  }
})

test('Built-in SSH: a wrong password asks again, a changed host key refuses with no way to click through', async () => {
  test.setTimeout(240_000)
  const server = await launchServer({ mode: 'link' })
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-sshd-'))
  const key = makeHostKey(dir, 'host_key')
  const other = makeHostKey(dir, 'other_key')
  expect(other.fingerprint).not.toBe(key.fingerprint)
  let ssh = await startSsh(dir, server, key)
  let desktop: Desktop | undefined
  let root: string | undefined
  try {
    desktop = await launchDesktop()
    root = desktop.cockpit.root
    const picker = desktop.cockpit.page

    // Cancel at the Trust prompt leaves nothing saved.
    await connectSsh(picker, ssh.port, 'Box')
    await expect(picker.getByTestId('remote-hostkey-prompt')).toBeVisible()
    await picker.getByTestId('remote-hostkey-cancel').click()
    await expect(picker.getByTestId('remote-hostkey-prompt')).toHaveCount(0)
    expect(savedServers(desktop.cockpit.dataDir)).toEqual([])
    await picker.getByTestId('connect-submit').click()
    await trustHost(picker, key, ssh.port)
    // A wrong password: asked once more, with the reason.
    await typePassword(picker, 'not the password', true)
    await expect(picker.getByTestId('remote-secret-wrong')).toHaveText('Wrong password. Try again.')
    await typePassword(picker, SSH_PASSWORD, true)
    const remote = await tunnelWindow(desktop.cockpit.app, server)
    await remote.getByRole('list', { name: 'Open projects' }).waitFor()
    await expect.poll(() => savedServers(desktop!.cockpit.dataDir).map((s) => s.name)).toEqual(['Box'])

    await desktop.close({ keepFiles: true })
    desktop = undefined

    // The server answers again on the same port with another key: the app refuses, shows why, and
    // offers no Trust (a changed key is never a question).
    await ssh.stop()
    ssh = await startSsh(dir, server, other, ssh.port)
    const logBefore = ssh.log()
    desktop = await launchDesktop(root)
    const picker2 = desktop.cockpit.page
    await picker2.getByTitle("Open Box's picker").click()
    await expect(picker2.getByRole('alert')).toContainText('The host key of')
    await expect(picker2.getByRole('alert')).toContainText('changed')
    await expect(picker2.getByTestId('remote-hostkey-prompt')).toHaveCount(0)
    await expect(picker2.getByTestId('remote-secret-prompt')).toHaveCount(0)
    expect(desktop.cockpit.app.windows().filter((p) => !p.isClosed())).toHaveLength(1)
    // Refused at the handshake: no command ran on the server for it.
    expect(ssh.log()).toEqual(logBefore)

    await expectMainAlive(server)
  } finally {
    if (desktop !== undefined) await desktop.close()
    else if (root !== undefined) rmSync(root, { recursive: true, force: true })
    await ssh.stop()
    rmSync(dir, { recursive: true, force: true })
    await server.close()
  }
})

test('My own tunnel: the waiting page shows the command, a relay to the gateway loads the project with the pasted link', async () => {
  test.setTimeout(240_000)
  const server = await launchServer({ mode: 'link' })
  let desktop: Desktop | undefined
  let relay: NetServer | undefined
  const sockets = new Set<Socket>()
  try {
    const link = await addDeviceLink(server)
    const localPort = await freePort()
    desktop = await launchDesktop()
    const { app } = desktop.cockpit
    const picker = desktop.cockpit.page

    await picker.getByRole('button', { name: 'Connect to server…' }).click()
    const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
    await dialog.getByTestId('connect-tab-tunnel').click()
    await dialog.getByTestId('connect-tunnel-ssh-host').fill('devbox')
    await dialog.getByTestId('connect-tunnel-remote-port').fill(String(server.port))
    await dialog.getByTestId('connect-tunnel-local-port').fill(String(localPort))
    const forward = `127.0.0.1:${localPort}:127.0.0.1:${server.port}`
    await expect(dialog.getByTestId('connect-tunnel-command')).toHaveText(`ssh -N -L ${forward} devbox`)
    await expect(dialog.getByTestId('connect-add-device-command')).toContainText('ccc web add-device')
    await dialog.getByTestId('connect-tunnel-link').fill(link)
    await dialog.getByTestId('connect-name').fill('Tunnel box')
    await dialog.getByTestId('connect-submit').click()

    // Nothing listens on the local port: the window is main's waiting page, with the command.
    await expect.poll(() => picker.isClosed()).toBe(true)
    let waiting: Page | undefined
    await expect
      .poll(async () => {
        for (const p of app.windows()) {
          if (p.isClosed()) continue
          const text = await p.locator('body').innerText().catch(() => '')
          if (text.includes(`Nothing answers on 127.0.0.1:${localPort}`)) {
            waiting = p
            return text
          }
        }
        return ''
      })
      .toContain(`ssh -N -L ${forward} devbox`)
    expect(await waiting!.locator('body').innerText()).toContain('tries again every 3 seconds')
    expect((await status(server)).devices).toHaveLength(0)

    // The person starts the tunnel (here a Node relay to the gateway): the window's next retry loads
    // the server's page, signed in by the pasted link's token.
    relay = createNetServer((client) => {
      const upstream = netConnect({ host: '127.0.0.1', port: server.port })
      sockets.add(client)
      sockets.add(upstream)
      client.pipe(upstream).pipe(client)
      const drop = (): void => {
        client.destroy()
        upstream.destroy()
      }
      client.on('error', drop)
      upstream.on('error', drop)
      client.on('close', drop)
      upstream.on('close', drop)
    })
    await new Promise<void>((ok, fail) => {
      relay!.once('error', fail)
      relay!.listen(localPort, '127.0.0.1', ok)
    })
    const remote = await tunnelWindow(app, server)
    expect(new URL(remote.url()).port).toBe(String(localPort))
    await remote.getByRole('list', { name: 'Open projects' }).waitFor({ timeout: 30_000 })
    const devices = (await status(server)).devices
    expect(devices.map((d) => d.name)).toEqual([`cc-cockpit desktop on ${hostname()}`])
    expect(await titles(app)).toEqual(['Tunnel box'])

    const href = `?project=${encodeURIComponent(server.projectId)}`
    await remote.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
    await remote.locator('.tabs-pane').waitFor()
    await expectMainAlive(server)
  } finally {
    if (desktop !== undefined) await desktop.close()
    for (const s of sockets) s.destroy()
    await new Promise<void>((done) => (relay !== undefined ? relay.close(() => done()) : done()))
    await server.close()
  }
})

/** A loopback port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port
      s.close(() => ok(port))
    })
  })
}
