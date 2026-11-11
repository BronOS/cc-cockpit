// Server mode end to end (design-web.md §9; plan 20261111-server-mode): the app started as a server
// with no display (test/e2e/server-fixtures.ts), used only from a plain browser. Every spec ends
// with `expectMainAlive`: a fault on the hidden page's side shows as a dead main, not as a failed
// locator, since the browser keeps its last frame.
//
// Markers are printed by shell arithmetic (`echo srv-$((40+2))` prints srv-42), so the command line
// echoed back never contains the text a step waits for: only the shell's output does.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { WebCliStatus } from '../../src/shared/web-access'
import { IGNORED_LINE } from '../../src/main/second-launch'
import { launchCockpit } from './fixtures'
import { addDeviceLink, ccc, expectMainAlive, launchProfiles, launchServer, secondLaunch, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser } from './web-fixtures'

test.skip(process.platform !== 'linux', 'server mode runs on Linux only')

let server: Server | undefined

test.afterEach(async () => {
  await server?.close()
  server = undefined
})

test('server mode: main runs as a server; a terminal tab opened in the browser takes input and shows output', async () => {
  test.setTimeout(90_000)
  server = await launchServer()
  // Main took the switches as server mode (the flag every later module hangs on).
  expect(await server.cockpit.hook<boolean>('serverMode')).toBe(true)
  // ...under Ozone headless, with no display in its env (the harness removed it from the app only).
  const seen = await server.cockpit.app.evaluate(({ app }) => ({
    ozone: app.commandLine.getSwitchValue('ozone-platform'),
    display: process.env.DISPLAY ?? null,
    wayland: process.env.WAYLAND_DISPLAY ?? null
  }))
  expect(seen).toEqual({ ozone: 'headless', display: null, wayland: null })

  // Mode None on loopback: the bare origin signs the browser in, no link needed.
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)

    // A shell tab started from the browser: its output reaches the browser.
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Shell' }).click()
    await browser.waitForTerminalText('FAKE-SHELL ready')

    // The browser's typing reaches the tab and its output comes back.
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type('echo srv-$((40+2))')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText('srv-42')

    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

test('server mode: the dialogs main wired never reach Electron; main survives each call', async () => {
  test.setTimeout(60_000)
  server = await launchServer()
  // No queued fake in the way: the hook calls the Dialogs implementation index.ts chose. The same
  // calls on Electron's `dialog` abort main under Ozone headless (spike).
  const probe = await server.cockpit.hook<{
    box: string
    open: { canceled: boolean; filePaths: string[] }
    logged: string[]
  }>('dialogProbe')
  expect(probe.box).toBe('ServerDialogError')
  expect(probe.open).toEqual({ canceled: true, filePaths: [] })
  expect(probe.logged).toEqual(['probe title: probe content'])
  await expectMainAlive(server)
})

test('server mode: links never open on the server; they reach the browser as a link notice', async () => {
  test.setTimeout(90_000)
  server = await launchServer()
  const { cockpit } = server
  // A recorder in place of shell.openExternal: a link that reached the host's opener lands here.
  await cockpit.app.evaluate(({ shell }) => {
    const g = globalThis as { __opened?: string[] }
    g.__opened = []
    shell.openExternal = (url: string) => {
      g.__opened!.push(url)
      return Promise.resolve()
    }
  })
  // No browser attached yet: refused (and logged without the query), nothing opened on the server.
  expect(await cockpit.hook<string>('openExternalProbe', 'https://example.com/early?state=x', server.projectId)).toContain('no browser')
  expect(await cockpit.hook<string>('openExternalProbe', 'https://example.com/early-app')).toContain('no browser')

  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const notice = page.locator('.link-notice')
    /** The link reached this browser: opened in a new tab (a recent gesture) or shown as the notice. */
    const reached = async (url: string): Promise<boolean> =>
      (await browser.opened()).includes(url) || (await notice.getByRole('link', { name: url }).count()) > 0

    // Asked by the browser view itself (`app.openExternal`, the router binds the view): Playwright's
    // evaluate is a user gesture, so the notice opens the tab at once.
    await page.evaluate(() => window.cockpit.invoke('app.openExternal', { url: 'https://example.com/from-view' }))
    await expect.poll(() => reached('https://example.com/from-view')).toBe(true)

    // No asking view, for the project's window (a timer, a plugin's own sign-in), then app-wide: the
    // attached browser gets it.
    expect(await cockpit.hook<string>('openExternalProbe', 'https://example.com/no-view', server.projectId)).toBe('opened')
    await expect.poll(() => reached('https://example.com/no-view')).toBe(true)
    expect(await cockpit.hook<string>('openExternalProbe', 'https://example.com/app-wide')).toBe('opened')
    await expect.poll(() => reached('https://example.com/app-wide')).toBe(true)

    // The server's opener saw none of them.
    expect(await cockpit.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toEqual([])
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

test('server mode: a crashed hidden page is reloaded; the window, the tab and the browser view keep working', async () => {
  test.setTimeout(90_000)
  server = await launchServer()
  const { cockpit } = server
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Shell' }).click()
    await browser.waitForTerminalText('FAKE-SHELL ready')

    // Through main: Playwright's handle on the hidden page is dead after a crash, a reload or not.
    const pageState = (): Promise<{ windows: number; windowId: number; project: string }> =>
      cockpit.app.evaluate(async ({ BrowserWindow }) => {
        const all = BrowserWindow.getAllWindows()
        const win = all[0]
        if (!win) return { windows: 0, windowId: -1, project: '' }
        // Asked of the page itself: only a loaded shell page with its preload answers.
        const project = (await win.webContents
          .executeJavaScript(
            "window.cockpit.invoke('window.info').then((i) => (i.kind === 'project' ? i.project.id : ''))"
          )
          .catch(() => '')) as string
        return { windows: all.length, windowId: win.id, project }
      })
    const before = await pageState()
    expect(before.project).toBe(server.projectId)

    const crashed = new Promise<void>((resolve) => cockpit.page.once('crash', () => resolve()))
    expect(await cockpit.hook<boolean>('crashPage', server.projectId)).toBe(true)
    await crashed

    // Reloaded after the pause: the same window (a closed one would have ended the project and its
    // tabs) answers again for the same project.
    await expect.poll(pageState, { timeout: 30_000 }).toEqual(before)

    // The tab lived through it, and the browser view still drives it.
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type('echo srv-$((50+5))')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText('srv-55')
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

test('server mode: a tab no browser sized is 120x40; a browser that attaches sizes it', async () => {
  test.setTimeout(90_000)
  server = await launchServer()
  const { cockpit } = server
  const first = join(cockpit.projectDir, 'size-first.txt')
  // A shell tab opened with no browser attached: from the hidden page itself, which measures its
  // pane (480x320) and must not size the pty with it. The line waits in the tty until sh reads it.
  const tabId = await cockpit.page.evaluate(async (file) => {
    const api = (window as unknown as { cockpit: { invoke(c: string, r: unknown): Promise<unknown> } }).cockpit
    const tab = (await api.invoke('tabs.create', { kind: 'shell' })) as { id: string }
    await api.invoke('tabs.input', { tabId: tab.id, data: `stty size > '${file}'\r` })
    return tab.id
  }, first)
  expect(tabId).toBeTruthy()
  await expect.poll(() => (existsSync(first) ? readFileSync(first, 'utf8').trim() : ''), { timeout: 20_000 }).toBe('40 120')

  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    await browser.waitForTerminalText('FAKE-SHELL ready')
    // The browser measured the tab, so it sizes it (the first view to report): the pty takes the
    // browser's pane, whose row count is the browser's own xterm's.
    const xterm = page.locator('.terminal-view:not([hidden]) .xterm')
    await xterm.click()
    await page.keyboard.type('echo sz-$((1+1))-$(stty size | tr " " x)-end')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText(/sz-2-\d+x\d+-end/)
    const text = (await browser.terminalText()).replaceAll('\n', '')
    const size = /sz-2-(\d+)x(\d+)-end/.exec(text)
    expect(size).not.toBeNull()
    const rows = await page.locator('.terminal-view:not([hidden]) .xterm-rows > div').count()
    expect(Number(size![1])).toBe(rows)
    expect(`${size![1]} ${size![2]}`).not.toBe('40 120')
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

test('server mode: ccc web add-device signs a browser in once; stop and start brings the open page back by itself', async () => {
  test.setTimeout(150_000)
  // Link mode, the way a server runs: nobody is in until the person on the server mints a link.
  server = await launchServer({ mode: 'link' })
  const { port, origin } = server
  // No link, no way in: the project list answers a stranger with 401 and nothing else.
  const stranger = await fetch(`${origin}/api/projects`)
  expect(stranger.status).toBe(401)
  await stranger.body?.cancel()

  const link = await addDeviceLink(server)
  const browser = await openBrowser(link)
  try {
    const { page } = browser
    // The link signed this browser in and left the address bar; the picker lists the open project.
    await expect(page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(1)
    expect(page.url()).toBe(`${origin}/`)
    // The shell's `ccc web status` lists the device the link made.
    const status = JSON.parse((await ccc(server, ['web', 'status', '--json'])).stdout) as WebCliStatus
    expect(status.devices.map((d) => d.mode)).toEqual(['add'])
    // ...and the link is spent: a second use is refused.
    const token = link.split('#t=')[1] ?? ''
    const again = await fetch(`${origin}/auth/link`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name: 'again' })
    })
    expect(again.status).toBe(401)
    await again.body?.cancel()

    await openProjectInBrowser(browser, origin, server.projectId)
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Shell' }).click()
    await browser.waitForTerminalText('FAKE-SHELL ready')

    // A server stop (`ccc web stop`: main sends itself SIGTERM, as systemd's stop does) ends the
    // browsers' sockets with the retried close code: the page shows the host as away.
    const exited = new Promise<void>((resolve) => server!.cockpit.app.process().once('exit', () => resolve()))
    const stop = await ccc(server, ['web', 'stop'])
    expect(stop.code, stop.stderr).toBe(0)
    await exited
    await expect(page.getByText('Host unreachable.')).toBeVisible({ timeout: 30_000 })
    await server.close({ keepFiles: true })

    // Start again on the same data dir and port: the device's cookie is still good, nobody asks for
    // a link, and the open page comes back by itself (no reload, no click).
    const root = server.cockpit.root
    server = await launchServer({ mode: 'link', root, port })
    await expect(page.getByText('Host unreachable.')).toBeHidden({ timeout: 60_000 })
    await expect(page).toHaveURL(`${origin}/?project=${encodeURIComponent(server.projectId)}`)
    // The page is live again: the project's tab (restored with the project) takes the browser's typing.
    await browser.waitForTerminalText('FAKE-SHELL ready')
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type('echo back-$((30+3))')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText('back-33', 20_000)
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

test('server mode: a second launch from a desktop is ignored by the server; its box answered Stop ends the server cleanly', async () => {
  test.setTimeout(90_000)
  server = await launchServer()
  const proc = server.cockpit.app.process()
  let output = ''
  proc.stdout?.on('data', (d: Buffer) => (output += d.toString()))
  proc.stderr?.on('data', (d: Buffer) => (output += d.toString()))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    proc.once('exit', (code, signal) => done({ code, signal }))
  )
  // `cc-cockpit <folder>` typed on a desktop of the same machine while the server holds the data dir.
  // The env answers the launch's box: the box is that desktop process's, never the server's.
  const other = join(server.cockpit.root, 'other')
  mkdirSync(other)

  // Cancel: the launch exits, the server lives on and opened nothing for the launch's folder.
  const cancel = await secondLaunch(server.cockpit, other, 'cancel')
  expect(cancel).toMatchObject({ code: 0, signal: null, files: [] })
  await expect.poll(() => output).toContain(IGNORED_LINE)
  expect(await server.cockpit.hook('windowLook', other)).toBeUndefined()
  await expectMainAlive(server)

  // Stop (`web.stop`): the server quits as systemd's stop makes it, with status 0.
  expect(await secondLaunch(server.cockpit, other, 'stop')).toMatchObject({ code: 0, signal: null, files: [] })
  // The Stop launch swept what the Cancel launch's profile left (an empty dir Chromium made again).
  expect(launchProfiles(cancel.pid)).toEqual([])
  expect(await exited).toEqual({ code: 0, signal: null })
})

// No wall-clock bound on the launch: a cold Electron start under xvfb can come near the 2 s ask
// deadline by itself. That a desktop answer (`server: false`) ends after one ask is a unit test
// (second-launch.test.ts).
test('desktop meets desktop: a second launch opens its folder, with no box', async () => {
  test.setTimeout(60_000)
  const { cockpit, close } = await launchCockpit()
  try {
    const other = join(cockpit.root, 'other')
    mkdirSync(other)
    // A Stop answer in the env would stop a server; a desktop holder answers `web.status` with
    // `server: false`, so the launch never gets that far.
    expect(await secondLaunch(cockpit, other, 'stop')).toMatchObject({ code: 0, signal: null, files: [] })
    await expect.poll(() => cockpit.hook('windowLook', other)).not.toBeUndefined()
    expect(await cockpit.hook('serverMode')).toBe(false)
  } finally {
    await close()
  }
})
