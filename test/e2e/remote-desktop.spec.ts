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
// SSH (plan Task 8): the desktop app's PATH starts with a bin dir holding an `ssh` that runs
// test/fixtures/fake-ssh.mjs, which parses the argv like OpenSSH, runs the remote command locally
// against the test server's own `ccc`, and relays `-N -L` to the server's port. The tunnel's local
// port differs from the server's, which proves the gateway's Host rule (design §5.3).
//
// Linux only: server mode starts nowhere else.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { WebCliStatus } from '../../src/shared/web-access'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { addDeviceLink, ccc, expectMainAlive, launchServer, type Server } from './server-fixtures'

const FAKE_SSH = resolve(__dirname, '../fixtures/fake-ssh.mjs')

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

// ---------------------------------------------------------------------------------------------
// SSH

interface FakeSsh {
  /** Env for the desktop app: the fake `ssh` first on PATH and what the fake reads. */
  env: Record<string, string>
  /** The fake's log lines (`command ...`, `tunnel L P pid=N`). */
  log(): string[]
  dispose(): void
}

/** A temp bin dir with an `ssh` wrapper for fake-ssh.mjs, wired to `server`'s own `ccc`. */
function fakeSsh(server: Server, badHosts: string[] = ['badhost']): FakeSsh {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-ssh-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const wrapper = join(bin, 'ssh')
  writeFileSync(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${FAKE_SSH}' "$@"\n`)
  chmodSync(wrapper, 0o755)
  const logFile = join(dir, 'ssh.log')
  writeFileSync(logFile, '')
  // launchCockpit's own PATH (fixture bin, node, inherited) goes behind the fake's dir.
  const fixtureBin = resolve(__dirname, '../fixtures/bin')
  return {
    env: {
      PATH: [bin, fixtureBin, join(process.execPath, '..'), process.env.PATH ?? ''].join(delimiter),
      FAKE_SSH_CCC: join(server.cockpit.dataDir, 'bin', 'ccc'),
      FAKE_SSH_HOME: join(dir, 'remote-home'),
      FAKE_SSH_BAD_HOSTS: badHosts.join(','),
      FAKE_SSH_LOG: logFile
    },
    log: () => readFileSync(logFile, 'utf8').split('\n').filter((l) => l !== ''),
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}

/** The desktop app's remote window on the tunnel: a loopback page that is not the server's own origin. */
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

async function connectSsh(picker: Page, host: string, name?: string): Promise<ReturnType<Page['getByRole']>> {
  await picker.getByRole('button', { name: 'Connect to server…' }).click()
  const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
  await dialog.getByRole('tab', { name: 'SSH' }).click()
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill(host)
  if (name !== undefined) await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill(name)
  await dialog.getByRole('button', { name: 'Connect' }).click()
  return dialog
}

// The app no longer spawns `ssh` (remote SSH rev 2 Task 5: the built-in `ssh2` client), so this fake-ssh
// test cannot pass: replaced in Task 7 (an `ssh2` server fixture).
test.skip('SSH: tunnel on another port, signed in by add-device, one re-pair after a revoke, tunnel restart, bad auth', async () => {
  test.setTimeout(300_000)
  const server = await launchServer({ mode: 'link' })
  const ssh = fakeSsh(server)
  let desktop: { cockpit: Cockpit; close(options?: { keepFiles?: boolean }): Promise<void> } | undefined
  try {
    const projectName = basename(server.cockpit.projectDir)
    desktop = await launchCockpit({ folderArg: false, ready: 'picker', env: ssh.env })
    const { app } = desktop.cockpit
    const picker = desktop.cockpit.page

    // (3) A host whose login fails: ssh's own refusal with the one command that fixes it, nothing saved.
    const bad = await connectSsh(picker, 'badhost')
    await expect(bad.getByRole('alert')).toContainText('Run `ssh badhost` once in a terminal')
    await expect(bad.getByRole('alert')).toHaveText(/^Cannot connect: .*Run `ssh badhost` once in a terminal.*\.$/)
    expect(savedServers(desktop.cockpit.dataDir)).toEqual([])
    await bad.getByRole('textbox', { name: 'Host', exact: true }).fill('testhost')
    await bad.getByRole('textbox', { name: 'Name (optional)' }).fill('Box')
    await bad.getByRole('button', { name: 'Connect' }).click()

    // (1) The window is on the tunnel's port, not the server's, and signed in with no link pasted.
    const remote = await tunnelWindow(app, server)
    const tunnelPort = Number(new URL(remote.url()).port)
    expect(tunnelPort).not.toBe(server.port)
    await expect.poll(() => picker.isClosed()).toBe(true)
    await remote.getByRole('list', { name: 'Open projects' }).waitFor()
    expect(remote.url()).not.toContain('#t=')
    expect(ssh.log().some((l) => l.startsWith('tunnel ') && l.includes(`${tunnelPort} ${server.port} `))).toBe(true)
    const commands = (): string[] => ssh.log().filter((l) => l.startsWith('command '))
    expect(commands().filter((l) => l.includes("'status'"))).toHaveLength(1)
    expect(commands().filter((l) => l.includes("'add-device'"))).toHaveLength(1)
    const first = (await status(server)).devices
    expect(first.map((d) => d.name)).toEqual([`cc-cockpit desktop on ${hostname()}`])
    expect(await titles(app)).toEqual(['Box'])

    // Into the project, so the window's page is a live project client through the tunnel.
    const href = `?project=${encodeURIComponent(server.projectId)}`
    await remote.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
    await remote.locator('.tabs-pane').waitFor()
    await expect.poll(() => titles(app)).toEqual([`Box — ${projectName}`])

    // A second window of the same server (the server's picker, from the desktop's own picker).
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === 'File')
      file?.submenu?.items.find((i) => i.label === 'Open Project…')?.click()
    })
    const picker2 = await pickerWindow(app, `http://127.0.0.1:${tunnelPort}`)
    await picker2.getByRole('button', { name: 'Box', exact: true }).first().click()
    await expect.poll(async () => (await titles(app)).includes('Box')).toBe(true)
    const second = await expect
      .poll(() => app.windows().filter((p) => !p.isClosed() && p.url() === `http://127.0.0.1:${tunnelPort}/`).length)
      .toBe(1)
      .then(() => app.windows().find((p) => !p.isClosed() && p.url() === `http://127.0.0.1:${tunnelPort}/`)!)
    await second.getByRole('list', { name: 'Open projects' }).waitFor()

    // (2) Revoke the device on the server; both windows go to the sign-in screen when they reload,
    // and exactly one add-device is minted for the pair of them (one new device, not two).
    const addsBefore = commands().filter((l) => l.includes("'add-device'")).length
    const res = await ccc(server, ['web', 'revoke', first[0]!.id])
    expect(res.code, res.stderr).toBe(0)
    expect((await status(server)).devices).toHaveLength(0)
    await Promise.all([remote.reload(), second.reload()])
    await expect.poll(async () => (await status(server)).devices.length, { timeout: 60_000 }).toBe(1)
    const now = (await status(server)).devices
    expect(now[0]!.id).not.toBe(first[0]!.id)
    await remote.locator('.tabs-pane').waitFor({ timeout: 30_000 })
    await second.getByRole('list', { name: 'Open projects' }).waitFor({ timeout: 30_000 })
    await new Promise((r) => setTimeout(r, 1500))
    expect((await status(server)).devices).toHaveLength(1)
    expect(commands().filter((l) => l.includes("'add-device'")).length).toBe(addsBefore + 1)

    // (4) The tunnel's ssh dies: the app starts it again on the same port and the window works.
    const pids = ssh
      .log()
      .filter((l) => l.startsWith('tunnel '))
      .map((l) => Number(/pid=(\d+)/.exec(l)![1]))
    expect(pids).toHaveLength(1)
    process.kill(pids[0]!, 'SIGKILL')
    await expect
      .poll(() => ssh.log().filter((l) => l.startsWith('tunnel ')).length, { timeout: 30_000 })
      .toBe(2)
    expect(ssh.log().filter((l) => l.startsWith('tunnel '))[1]).toContain(`${tunnelPort} ${server.port} `)
    await remote.reload()
    await remote.locator('.tabs-pane').waitFor({ timeout: 30_000 })
    expect((await status(server)).devices).toHaveLength(1)

    await expectMainAlive(server)
  } finally {
    if (desktop !== undefined) await desktop.close()
    ssh.dispose()
    await server.close()
  }
})
