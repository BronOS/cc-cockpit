// Server mode end to end (design-web.md §9; plan 20261111-server-mode): the app started as a server
// with no display (test/e2e/server-fixtures.ts), used only from a plain browser. Every spec ends
// with `expectMainAlive`: a fault on the hidden page's side shows as a dead main, not as a failed
// locator, since the browser keeps its last frame.
//
// Markers are printed by shell arithmetic (`echo srv-$((40+2))` prints srv-42), so the command line
// echoed back never contains the text a step waits for: only the shell's output does.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { WebSocket } from 'ws'
import type { HostStatus } from '../../src/main/plugins/host-manager'
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

// design-web.md §9.6: with no desktop, every signed-in browser is the owner. `ccc plugin link` from a
// tab is asked in the browser (never a native box, which aborts main under Ozone headless, nor the
// test run's queued fake), in the guarded dialog: no focus taken, Enter does nothing, Allow armed
// after a second. A browser that joins mid-ask (a reload) finds it, and its Allow links the plugin.
test('server mode: ccc plugin link from a tab is Allowed in the browser; the plugin loads', async () => {
  test.setTimeout(120_000)
  server = await launchServer()
  const { cockpit } = server
  const dir = join(cockpit.root, 'devplugin')
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const dialog = page.getByRole('alertdialog', { name: /Link plugin local\.devplugin/ })
    const allow = dialog.getByRole('button', { name: 'Allow' })
    const typeLine = async (text: string): Promise<void> => {
      await page.locator('.terminal-view:not([hidden]) .xterm').click()
      await page.keyboard.type(text)
      await page.keyboard.press('Enter')
    }
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Claude' }).click()
    await browser.waitForTerminalText('FAKE-CLAUDE banner')
    await typeLine(`/ccc plugin new ${dir} --cli devdemo`)
    await browser.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="created plugin local\.devplugin in /)

    await typeLine(`/ccc plugin link ${dir}`)
    await expect(dialog).toBeVisible()
    // Allow is offered (no "Approve on the desktop") but not armed yet, and the terminal keeps the focus.
    await expect(dialog.getByText('Approve on the desktop')).toHaveCount(0)
    await expect(allow).toBeDisabled()
    expect(await page.evaluate(() => document.activeElement?.closest('.xterm') !== null)).toBe(true)
    // Armed after about a second. Enter and Space on a focused Allow do nothing.
    await expect(allow).toBeEnabled({ timeout: 5_000 })
    await allow.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press(' ')
    await page.keyboard.type('y')
    await expect(dialog).toBeVisible()

    // A browser joining mid-ask (this one, reloaded) finds it in ready, with Allow disarmed again.
    await page.reload()
    await page.locator('.tabs-pane').waitFor()
    await expect(dialog).toBeVisible()
    await expect(allow).toBeDisabled()
    await expect(allow).toBeEnabled({ timeout: 5_000 })
    await allow.click()
    await expect(dialog).toHaveCount(0)
    await browser.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="linked local\.devplugin \(Devplugin\)/, 20_000)
    await expect
      .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).plugins.find((p) => p.id === 'local.devplugin')?.state, {
        timeout: 20_000
      })
      .toBe('active')
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// plan Task 16: ctx.files.trash in server mode is a shared ask the browser answers (never a native
// box, which aborts main under Ozone headless, nor the test run's queued fake), through the real
// `shell` with no session bus. Task 13 recorded that `shell.trashItem` rejects cleanly here ("Failed to
// move item to trash", the file stays): the Files panel then shows "not moved" with the reason. A
// machine where the call succeeds trashes the file; either clean end passes, and main lives.
test('server mode: Move to Trash from Files is confirmed in the browser; the result reaches the panel, main lives', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const { cockpit } = server
  const file = join(cockpit.projectDir, 'to-trash.txt')
  writeFileSync(file, 'x')
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).plugins.find((p) => p.id === 'cockpit.files')?.state, {
      timeout: 20_000
    })
    .toBe('active')
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const section = page.locator('section.panel[aria-label="Files"]')
    if (!(await section.isVisible())) await page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
    await expect(section).toBeVisible({ timeout: 15_000 })
    const tree = page.frameLocator('section.panel[aria-label="Files"] iframe')
    const row = tree.locator('.row', { has: tree.locator('.name', { hasText: /^to-trash\.txt$/ }) })
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await tree.getByRole('menu').getByRole('menuitem', { name: 'Move to Trash' }).click()

    // The guarded dialog in the browser, the file name as plain text; Move armed after a second.
    const dialog = page.getByRole('alertdialog', { name: /Move the file to-trash\.txt to the Trash/ })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('cockpit.files')
    const move = dialog.getByRole('button', { name: 'Move to Trash' })
    await expect(move).toBeEnabled({ timeout: 5_000 })
    // The queued fake was not asked: the browser is.
    expect(await cockpit.hook<unknown[]>('trashDialogs')).toEqual([])
    await move.click()
    await expect(dialog).toHaveCount(0)

    const error = tree.locator('#error')
    await expect.poll(async () => (existsSync(file) ? ((await error.textContent()) ?? '') : 'trashed'), { timeout: 20_000 }).toMatch(/trashed|not moved to the Trash: /)
    if (existsSync(file)) {
      await expect(error).toContainText('to-trash.txt was not moved to the Trash: Failed to move item to trash')
      console.log(`Move to Trash in server mode: ${await error.textContent()}`)
    }
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// plan Task 21 (design-web.md §9.9): with no OS notifier, `ccc notify` and ctx.notify are in-page
// notices in the browsers, never on the hidden page: one shown before any browser attached waits for
// the first, the chime rings there, and a click on a plugin notice's action resolves its ctx.notify.
const HOST_CTX = join(__dirname, '..', 'fixtures', 'plugins', 'host-ctx')

test('server mode: ccc notify and ctx.notify are in-page notices in the browser; a click runs the action', async () => {
  test.setTimeout(120_000)
  server = await launchServer()
  const { cockpit } = server
  // No browser yet: the notice waits in main.
  expect((await ccc(server, ['notify', 'build finished'])).code).toBe(0)
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const notices = page.getByTestId('page-notice')
    const early = notices.filter({ hasText: 'build finished' })
    await expect(early).toBeVisible()
    await expect(early).toContainText('cc-cockpit')
    // The chime as this browser hears it (the hidden page's is checked below).
    await page.evaluate(() => {
      const w = window as unknown as { __chimes: string[] }
      w.__chimes = []
      window.cockpit.on('notify.chime', (p) => w.__chimes.push(p.sound))
    })

    // ctx.notify from a plugin: plain notices, one with a sound, one with an action that waits.
    await cockpit.hook('linkPlugin', HOST_CTX)
    await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostctx')
    const reminder = notices.filter({ hasText: 'Standup in 2 min' })
    await expect(reminder).toBeVisible({ timeout: 20_000 })
    await expect(reminder).toContainText('Calendar')
    await expect(notices.filter({ hasText: 'hello from the fixture plugin' })).toContainText('cc-cockpit: test.hostctx')
    await expect(notices.filter({ hasText: 'chime please' })).toContainText('Fixture reminder')
    await expect.poll(() => page.evaluate(() => (window as unknown as { __chimes: string[] }).__chimes)).toEqual(['builtin:bell'])
    // Nothing reached an OS notifier, and nothing was drawn on the hidden page.
    expect(await cockpit.hook<unknown[]>('notifications')).toEqual([])
    await expect(cockpit.page.getByTestId('page-notice')).toHaveCount(0)

    // The ✕ ends a notice; the action resolves the plugin's call with a click.
    await early.getByRole('button', { name: 'Dismiss notification' }).click()
    await expect(early).toHaveCount(0)
    const clickFile = join(cockpit.root, 'home', 'notify-click.json')
    expect(existsSync(clickFile)).toBe(false)
    await reminder.getByRole('button', { name: 'Join' }).click()
    await expect.poll(() => existsSync(clickFile)).toBe(true)
    expect(JSON.parse(readFileSync(clickFile, 'utf8'))).toEqual({ clicked: true })
    await expect(reminder).toHaveCount(0)
    // A click for an id main does not show answers false; the browser cannot settle one that is gone.
    expect(await page.evaluate(() => window.cockpit.invoke('notices.click', { requestId: 'nope' }))).toBe(false)
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// plan Task 19 (design-web.md §9.8): an html overlay with no browser origin is held by a browser, never
// by the hidden page. One opened while no browser is attached waits and goes to the first to join;
// `ccc overlay` from a Claude tab goes to the browser that typed it. Neither shows "Take over", and
// the answer given in the browser reaches the opener.
const ASK_PAGE = `<!doctype html><p>question page</p><button id="send">Send</button><script>
  let port
  window.addEventListener('message', (e) => { if (e.ports[0]) port = e.ports[0] })
  document.getElementById('send').addEventListener('click', () => {
    port?.postMessage({ type: 'result', value: 'answered over ' + location.protocol })
  })
</script>`

test('server mode: html overlays are held by a browser; ccc overlay from a Claude tab is answered there', async () => {
  test.setTimeout(120_000)
  server = await launchServer()
  const { cockpit } = server
  // No browser yet: the overlay waits with nobody holding it.
  const handle = await cockpit.hook<number | undefined>('openOverlay', cockpit.projectDir, { kind: 'html', html: ASK_PAGE, title: 'Early' })
  if (handle === undefined) throw new Error('no window for the project')
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const overlay = page.locator('.overlay[data-kind="html"]')
    // The first browser to join holds it: the page is here, with no "Open on …" and no Take over.
    await expect(overlay.frameLocator('iframe').getByText('question page')).toBeVisible()
    await expect(overlay.getByTestId('held-elsewhere')).toHaveCount(0)
    await expect(overlay.getByRole('button', { name: 'Take over' })).toHaveCount(0)
    await overlay.frameLocator('iframe').getByRole('button', { name: 'Send' }).click()
    await expect
      .poll(async () => (await cockpit.hook<{ result?: unknown } | undefined>('overlayResult', handle))?.result)
      .toEqual({ kind: 'value', value: 'answered over http:' })
    await expect(overlay).toHaveCount(0)

    // `ccc overlay --html` from a Claude tab the browser typed into: the page opens in that browser.
    const file = join(cockpit.root, 'ask.html')
    writeFileSync(file, ASK_PAGE)
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Claude' }).click()
    await browser.waitForTerminalText('FAKE-CLAUDE banner')
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type(`/ccc overlay --html ${file}`)
    await page.keyboard.press('Enter')
    const frame = overlay.frameLocator('iframe')
    await expect(frame.getByText('question page')).toBeVisible()
    await expect(overlay.getByTestId('held-elsewhere')).toHaveCount(0)
    await expect(overlay.getByRole('button', { name: 'Take over' })).toHaveCount(0)
    await frame.getByRole('button', { name: 'Send' }).click()
    // The caller (the tab's ccc) got the browser's answer.
    await browser.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out=".*answered over http:/, 20_000)
    await expect(overlay).toHaveCount(0)
    expect(await cockpit.hook<unknown[]>('overlays', cockpit.projectDir)).toEqual([])
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// design-web.md §9.8: with no desktop the browser picker is the picker. It opens a folder by its
// path on the server (an error for a bad one, in the asking view), lists the recent projects with no
// window and reopens one, and shows a gone folder as missing. `ccc open <path>` from a server shell
// opens a project too. Nothing of it reaches a native dialog or a window shown on the server.
test('server mode: projects are opened by path and reopened from the browser picker; ccc open from the shell', async () => {
  test.setTimeout(120_000)
  server = await launchServer()
  const { cockpit } = server
  const root = realpathSync(cockpit.root)
  const second = join(root, 'second')
  const gone = join(root, 'gone')
  const fromShell = join(root, 'from-shell')
  for (const dir of [second, gone, fromShell]) mkdirSync(dir)
  writeFileSync(join(root, 'a-file.txt'), 'x')
  // The window with the highest id: the project opened last (each open makes a new BrowserWindow).
  const closeNewestWindow = (): Promise<void> =>
    cockpit.app.evaluate(({ BrowserWindow }) => {
      const newest = BrowserWindow.getAllWindows().sort((a, b) => b.id - a.id)[0]
      newest?.close()
    })
  const openCount = (): Promise<number> => cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await expect(page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(1)
    await page.getByRole('button', { name: 'Open folder…' }).click()
    const field = page.getByLabel('Folder on the server')
    const alert = page.locator('.web-picker-error')

    // Errors, in this view: a relative path, a file, a folder that is not there (nothing is created).
    await field.fill('second')
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(alert).toHaveText('Cannot open: not an absolute path: second')
    await field.fill(join(root, 'a-file.txt'))
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(alert).toHaveText(`Cannot open: not a folder: ${join(root, 'a-file.txt')}`)
    await field.fill(join(root, 'nope'))
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(alert).toHaveText(`Cannot open: not a folder: ${join(root, 'nope')}`)
    expect(existsSync(join(root, 'nope'))).toBe(false)
    expect(await openCount()).toBe(1)

    // A folder by its path: main opens it and the page goes on to the shell bound to it.
    await field.fill(second)
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await expect(page).toHaveURL(/\?project=/)
    await page.locator('.tabs-pane').waitFor()
    const secondId = new URL(page.url()).searchParams.get('project') ?? ''
    expect(secondId).not.toBe('')
    expect(secondId).not.toBe(server.projectId)
    expect(await openCount()).toBe(2)

    // Closed on the server (Close project in the browser has its own spec below): now a recent project.
    // The bound view loses its window, so the picker is loaded again by hand.
    await closeNewestWindow()
    await expect.poll(openCount).toBe(1)
    // `gone`: opened, closed, its folder removed: listed as missing, with nothing to click.
    const goneOpen = await fetch(`${server.origin}/api/projects`, {
      method: 'POST',
      headers: { Origin: server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ open: gone })
    })
    expect(goneOpen.status).toBe(200)
    await goneOpen.body?.cancel()
    await expect.poll(openCount).toBe(2)
    await closeNewestWindow()
    await expect.poll(openCount).toBe(1)
    rmSync(gone, { recursive: true })

    await page.goto(`${server.origin}/`)
    const recent = page.getByRole('list', { name: 'Recent projects' })
    await expect(recent.getByRole('button')).toHaveCount(1)
    await expect(recent).toContainText('missing')
    await expect(recent).toContainText(gone)
    // An unknown reopen id is refused with its text, opening nothing.
    const unknown = await fetch(`${server.origin}/api/projects`, {
      method: 'POST',
      headers: { Origin: server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reopen: 'not-a-project' })
    })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ error: 'not a recent project' })

    // Reopen the recent one: the same project id, its shell.
    await recent.getByRole('button', { name: /second/ }).click()
    await expect(page).toHaveURL(`${server.origin}/?project=${encodeURIComponent(secondId)}`)
    await page.locator('.tabs-pane').waitFor()
    expect(await openCount()).toBe(2)

    // `ccc open <path>` from a shell on the server: opened, listed in the browser's picker.
    const opened = await ccc(server, ['open', fromShell])
    expect(opened.code, opened.stderr).toBe(0)
    await expect.poll(openCount).toBe(3)
    await page.goto(`${server.origin}/`)
    await expect(page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(3)
    await expect(page.getByRole('list', { name: 'Open projects' })).toContainText(fromShell)

    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// design-web.md §9.8: Close project in the browser shell asks in that view (the guarded in-page
// approval), then `projects.close` closes the window main bound the view to, for every device: each
// browser of that project goes back to the picker, the other project's window stays, and closing the
// last one leaves main running with no project open (no picker window, no quit).
test('server mode: Close project in the browser closes it for every device; the picker again; main lives with none open', async () => {
  test.setTimeout(120_000)
  server = await launchServer()
  const { cockpit } = server
  const other = join(realpathSync(cockpit.root), 'other')
  mkdirSync(other)
  const openCount = (): Promise<number> => cockpit.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const opened = await fetch(`${server.origin}/api/projects`, {
    method: 'POST',
    headers: { Origin: server.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ open: other })
  })
  expect(opened.status).toBe(200)
  const otherId = ((await opened.json()) as { id: string }).id
  await expect.poll(openCount).toBe(2)

  const first = await openBrowser(`${server.origin}/`)
  const second = await openBrowser(`${server.origin}/`)
  try {
    for (const b of [first, second]) await openProjectInBrowser(b, server.origin, server.projectId)
    const { page } = first
    const closeButton = page.getByRole('button', { name: 'Close project' }).first()
    const dialog = page.getByRole('alertdialog', { name: /^Close .+ for every device\?$/ })
    const confirm = dialog.getByRole('button', { name: 'Close project' })

    // Cancel leaves everything as it was. The other browser was never asked.
    await closeButton.click()
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Its tabs end.')
    await expect(second.page.getByRole('alertdialog')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await openCount()).toBe(2)

    // Asked again: not armed at first, Enter on the armed button does nothing, a click closes.
    await closeButton.click()
    await expect(confirm).toBeDisabled()
    await expect(confirm).toBeEnabled({ timeout: 5_000 })
    await confirm.focus()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeVisible()
    expect(await openCount()).toBe(2)
    await confirm.click()

    // Every browser of that project is back at the picker, which lists the other project only and
    // offers the closed one as recent.
    for (const b of [first, second]) {
      await expect(b.page).toHaveURL(`${server.origin}/`, { timeout: 15_000 })
      const list = b.page.getByRole('list', { name: 'Open projects' })
      await expect(list.getByRole('link')).toHaveCount(1)
      await expect(list.locator(`a[href="?project=${encodeURIComponent(otherId)}"]`)).toHaveCount(1)
      await expect(b.page.getByRole('list', { name: 'Recent projects' })).toContainText(realpathSync(cockpit.projectDir))
    }
    expect(await openCount()).toBe(1)

    // The last one, closed from the browser too: main runs on with no project open.
    await openProjectInBrowser(first, server.origin, otherId)
    await page.getByRole('button', { name: 'Close project' }).first().click()
    await expect(confirm).toBeEnabled({ timeout: 5_000 })
    await confirm.click()
    await expect(page).toHaveURL(`${server.origin}/`, { timeout: 15_000 })
    await expect(page.getByRole('list', { name: 'Recent projects' }).getByRole('button')).toHaveCount(2)
    expect(await openCount()).toBe(0)
    await expectMainAlive(server)
  } finally {
    await first.close()
    await second.close()
  }
})

// design-web.md §9.4, §9.6: with no desktop, a browser's Settings shows the web access card read-only
// (never a link), lists the devices with Revoke and Disconnect behind the in-page approval, follows
// `ccc web` changes live, and web-access.log names the device that revoked.
test('server mode: the web access card in the browser lists a second device, revokes it, and follows ccc web mode live', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ mode: 'link' })
  const { origin, cockpit } = server
  const browser = await openBrowser(await addDeviceLink(server))
  // Signed in before the next link is made: a new one-time link ends the one before it.
  await expect(browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(1)
  // A second device, signed in with its own one-time link and connected to the project.
  const token = (await addDeviceLink(server)).split('#t=')[1] ?? ''
  const signed = await fetch(`${origin}/auth/link`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'Second phone' })
  })
  expect(signed.status).toBe(200)
  await signed.body?.cancel()
  const cookie = (signed.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin, headers: { Cookie: cookie } })
  const wsClosed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ t: 'hello', v: 1, project: server.projectId }))
  try {
    const { page } = browser
    await openProjectInBrowser(browser, origin, server.projectId)

    // The top bar counts both devices in the browser too; its click opens this browser's Settings.
    const chip = page.locator('header.top-strip .web-access-chip')
    await expect(chip).toContainText('2 devices')
    await chip.click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await expect(settings).toBeVisible()
    const card = settings.getByTestId('web-access-server-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('web-access-row-mode')).toContainText('Access link')
    await expect(card.getByTestId('web-access-row-address')).toContainText(origin)
    await expect(card.getByTestId('web-access-row-confirm')).toContainText('Not available in server mode')
    await expect(card).toContainText('ccc web')
    // Read-only, and never a link: no switch, no Show, no QR code, no token anywhere in the page.
    await expect(settings.getByRole('checkbox', { name: 'Allow browsers to connect' })).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Show' })).toHaveCount(0)
    await expect(settings.getByRole('img', { name: /QR code/ })).toHaveCount(0)
    expect(await page.content()).not.toContain('#t=')

    const second = settings.getByTestId('web-access-device').filter({ hasText: 'Second phone' })
    await expect(second).toContainText('connected now')
    await expect(settings.getByTestId('web-access-device')).toHaveCount(2)

    // Revoke asks first in the page (not armed at once), Cancel leaves it signed in.
    await second.getByRole('button', { name: 'Revoke', exact: true }).click()
    const ask = page.getByRole('alertdialog', { name: 'Revoke Second phone?' })
    await expect(ask).toBeVisible()
    const allow = ask.getByRole('button', { name: 'Revoke', exact: true })
    await expect(allow).toBeDisabled()
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await expect(ask).toHaveCount(0)
    await expect(second).toContainText('connected now')

    // Asked again and allowed: its socket closes at once and it leaves the list.
    await second.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(allow).toBeEnabled({ timeout: 5_000 })
    await allow.click()
    await wsClosed
    await expect(second).toHaveCount(0)
    await expect(settings.getByTestId('web-access-device')).toHaveCount(1)
    const status = JSON.parse((await ccc(server, ['web', 'status', '--json'])).stdout) as WebCliStatus
    expect(status.devices.map((d) => d.name)).not.toContain('Second phone')

    // web-access.log names the browser that revoked it (its own device, the one left).
    const me = status.devices[0]
    const log = readFileSync(join(cockpit.dataDir, 'logs', 'web-access.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(log.find((e) => e['event'] === 'revoke' && e['name'] === 'Second phone')).toMatchObject({
      detail: 'revoked from a browser',
      by: me?.id,
      byName: me?.name
    })

    // A change made with `ccc web` on the server shows on the open card, no reload.
    const mode = await ccc(server, ['web', 'mode', 'none'])
    expect(mode.code, mode.stderr).toBe(0)
    await expect(card.getByTestId('web-access-row-mode')).toContainText('No sign-in')
    await expect(card.getByTestId('web-access-row-none')).toContainText('every user of this machine')
    await expectMainAlive(server)
  } finally {
    ws.close()
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
