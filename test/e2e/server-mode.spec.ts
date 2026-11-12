// Server mode end to end (design-web.md §9; plan 20261111-server-mode): the app started as a server
// with no display (test/e2e/server-fixtures.ts), used only from a plain browser. Every spec ends
// with `expectMainAlive`: a fault on the hidden page's side shows as a dead main, not as a failed
// locator, since the browser keeps its last frame.
//
// Markers are printed by shell arithmetic (`echo srv-$((40+2))` prints srv-42), so the command line
// echoed back never contains the text a step waits for: only the shell's output does.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { WebSocket } from 'ws'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { WebCliStatus } from '../../src/shared/web-access'
import { IGNORED_LINE } from '../../src/main/second-launch'
import { MAX_PASTE_ATTEMPTS } from '../../src/main/oauth/plugin-oauth'
import { PROTOCOL_VERSION } from '../../src/shared/web-protocol'
import { OAUTH_PASTE_REFUSED, OAUTH_SIGN_IN_OVER } from '../../src/shared/oauth-paste'
import { FakeOAuthServer } from '../fakes/fake-oauth-server'
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
// Ready to answer takes two signals, both waited for before each Send (pageReady below), never the
// page text: the page says "port ready" once it holds the port the shell posts after load (a Send
// before that posts into nothing), and the overlay's loader is gone (main heard `overlays.ready`;
// until then the loader covers the frame). Send is then pressed with the keyboard on the focused
// button, not clicked: the page is an out-of-process frame, and a mouse click a few ms after it was
// drawn was reported done, the frame focused, yet the button never got it (about 1 run in 30, with
// both signals already up), the opener then waiting for good. Keys go to the focused frame, with no
// hit test.
const ASK_PAGE = `<!doctype html><p>question page</p><p id="ready"></p><button id="send">Send</button><script>
  let port
  window.addEventListener('message', (e) => {
    if (!e.ports[0]) return
    port = e.ports[0]
    document.getElementById('ready').textContent = 'port ready'
  })
  document.getElementById('send').addEventListener('click', () => {
    port?.postMessage({ type: 'result', value: 'answered over ' + location.protocol })
  })
</script>`

/** The overlay's page can be answered: it holds its port and no loader covers it (see ASK_PAGE). */
async function pageReady(overlay: Locator): Promise<void> {
  await expect(overlay.frameLocator('iframe').getByText('port ready')).toBeVisible()
  await expect(overlay.locator('.overlay-loader')).toHaveCount(0)
}

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
    await pageReady(overlay)
    await overlay.frameLocator('iframe').getByRole('button', { name: 'Send' }).press('Enter')
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
    await pageReady(overlay)
    await frame.getByRole('button', { name: 'Send' }).press('Enter')
    // The caller (the tab's ccc) got the browser's answer.
    await browser.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out=".*answered over http:/, 20_000)
    await expect(overlay).toHaveCount(0)
    expect(await cockpit.hook<unknown[]>('overlays', cockpit.projectDir)).toEqual([])
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// design-web.md §9.8: with no desktop the browser picker is the picker. Its folder browser starts in
// the start folder (`ccc web set --start-folder`), lists folders only and marks projects, shows a bad
// path's error in place (nothing is created), completes "Go to path" with Tab and opens the folder
// shown or a double-clicked one. The picker lists the recent projects with no window and reopens
// one; a gone folder shows as missing with Relink… (the same folder browser, then the project opens
// there) and Forget (confirmed in its row). `ccc open <path>` from a server shell opens a project
// too. Nothing of it reaches a native dialog or a window shown on the server.
test('server mode: the browser picker opens folders through the folder browser, reopens, relinks and forgets; ccc open from the shell', async () => {
  test.setTimeout(150_000)
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

  // The folder browser starts in the test's root (default: the server user's home, empty here).
  const set = await ccc(server, ['web', 'set', '--start-folder', root])
  expect(set.code, set.stderr).toBe(0)
  expect(set.stdout).toContain(`start folder: ${root}`)

  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await expect(page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(1)
    await page.getByRole('button', { name: 'Open folder…' }).click()
    const dialog = page.getByRole('dialog', { name: 'Open folder' })
    const folders = dialog.getByRole('list', { name: 'Folders' })
    // Folders only (no a-file.txt), sorted; the app's own project folder is marked a project.
    await expect(folders.getByRole('button', { name: 'second', exact: true })).toBeVisible()
    await expect(folders).not.toContainText('a-file.txt')
    await expect(folders.getByRole('button', { name: 'project', exact: true }).locator('.folder-project-badge')).toHaveText('project')
    await expect(folders.getByRole('button', { name: 'second', exact: true }).locator('.picker-badge')).toHaveCount(0)
    const goTo = dialog.getByLabel('Go to path')
    const open = dialog.getByRole('button', { name: 'Open', exact: true })

    // Errors, in this dialog: a relative path, a file, a folder that is not there (nothing is created).
    await goTo.fill('second')
    await goTo.press('Enter')
    await expect(dialog.getByRole('alert')).toHaveText('Type a full path, starting with / or ~')
    await goTo.fill(join(root, 'a-file.txt'))
    await goTo.press('Enter')
    await expect(dialog.locator('.folder-unreadable')).toHaveText('not a folder')
    await expect(open).toBeDisabled()
    await goTo.fill(join(root, 'nope'))
    await goTo.press('Enter')
    await expect(dialog.locator('.folder-unreadable')).toHaveText('this folder does not exist (any more)')
    await expect(open).toBeDisabled()
    expect(existsSync(join(root, 'nope'))).toBe(false)
    expect(await openCount()).toBe(1)

    // "Go to path" completes from the listing with Tab; Enter goes there; Open takes the folder shown.
    await goTo.fill(`${root}/sec`)
    await expect(async () => {
      await goTo.press('Tab')
      await expect(goTo).toHaveValue(`${second}/`, { timeout: 500 })
    }).toPass({ timeout: 10_000 })
    await goTo.press('Enter')
    await expect(dialog.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current]')).toHaveText('second')
    await expect(dialog.getByText('No folders here.')).toBeVisible()
    await open.click()
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

    // `gone`: opened by a double click in the folder browser, closed, its folder removed.
    await page.goto(`${server.origin}/`)
    await page.getByRole('button', { name: 'Open folder…' }).click()
    await dialog.getByRole('list', { name: 'Folders' }).getByRole('button', { name: 'gone', exact: true }).dblclick()
    await expect(page).toHaveURL(/\?project=/)
    await page.locator('.tabs-pane').waitFor()
    const goneId = new URL(page.url()).searchParams.get('project') ?? ''
    expect(goneId).not.toBe(secondId)
    await expect.poll(openCount).toBe(2)
    await closeNewestWindow()
    await expect.poll(openCount).toBe(1)
    rmSync(gone, { recursive: true })

    await page.goto(`${server.origin}/`)
    const recent = page.getByRole('list', { name: 'Recent projects' })
    const goneRow = recent.getByRole('listitem').filter({ hasText: gone })
    await expect(goneRow.locator('.picker-badge')).toHaveText('missing')
    await expect(goneRow.getByRole('button', { name: 'gone', exact: true })).toBeDisabled()
    // An unknown reopen id is refused with its text, opening nothing.
    const unknown = await fetch(`${server.origin}/api/projects`, {
      method: 'POST',
      headers: { Origin: server.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reopen: 'not-a-project' })
    })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toEqual({ error: 'not a recent project' })
    // Relink and forget are state-changing POSTs: no Origin, no change.
    const noOrigin = await fetch(`${server.origin}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ forget: goneId })
    })
    expect(noOrigin.status).toBe(403)
    await noOrigin.body?.cancel()

    // Forget asks in the row: Cancel keeps it.
    await goneRow.getByRole('button', { name: 'Forget' }).click()
    const ask = goneRow.getByRole('group', { name: 'Forget gone?' })
    await expect(ask).toContainText('Forget it and its saved tabs?')
    await expect(ask.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await expect(goneRow.getByRole('button', { name: 'Relink…' })).toBeVisible()

    // Relink… opens the folder browser for the new place; the project opens there, the same id.
    const moved = join(root, 'moved')
    mkdirSync(moved)
    await goneRow.getByRole('button', { name: 'Relink…' }).click()
    const relink = page.getByRole('dialog', { name: 'Relink gone' })
    await expect(relink).toContainText(`Its folder ${gone} is gone.`)
    await relink.getByRole('list', { name: 'Folders' }).getByRole('button', { name: 'moved', exact: true }).click()
    await expect(relink.getByRole('navigation', { name: 'Folder path' }).locator('[aria-current]')).toHaveText('moved')
    await relink.getByRole('button', { name: 'Relink here' }).click()
    await expect(page).toHaveURL(`${server.origin}/?project=${encodeURIComponent(goneId)}`)
    await page.locator('.tabs-pane').waitFor()
    await expect.poll(openCount).toBe(2)
    await closeNewestWindow()
    await expect.poll(openCount).toBe(1)

    // Forget: the moved folder gone too, confirmed in the row; the project leaves the list for good.
    rmSync(moved, { recursive: true })
    await page.goto(`${server.origin}/`)
    const movedRow = recent.getByRole('listitem').filter({ hasText: moved })
    await expect(movedRow.locator('.picker-badge')).toHaveText('missing')
    await movedRow.getByRole('button', { name: 'Forget' }).click()
    await movedRow.getByRole('group', { name: 'Forget moved?' }).getByRole('button', { name: 'Forget' }).click()
    await expect(recent.getByRole('listitem')).toHaveCount(1)
    const listed = (await (await fetch(`${server.origin}/api/projects`)).json()) as { recent: Array<{ id: string }> }
    expect(listed.recent.map((p) => p.id)).toEqual([secondId])

    // Reopen the recent one: the same project id, its shell.
    await recent.getByRole('button', { name: 'second', exact: true }).click()
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

// The folder list scrolls with the mouse wheel inside its card. Regression: the picker page's own
// `.picker-web .picker-list { overflow: visible }` reached the folder list too (the dialog is drawn
// inside the page), so a long folder was clipped by the card with no way to scroll it.
test('server mode: a long folder list in the folder browser scrolls with the mouse wheel', async () => {
  test.setTimeout(90_000)
  server = await launchServer()
  const many = join(realpathSync(server.cockpit.root), 'many')
  for (let i = 0; i < 80; i++) mkdirSync(join(many, `folder-${String(i).padStart(2, '0')}`), { recursive: true })
  const set = await ccc(server, ['web', 'set', '--start-folder', many])
  expect(set.code, set.stderr).toBe(0)

  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await page.getByRole('button', { name: 'Open folder…' }).click()
    const folders = page.getByRole('dialog', { name: 'Open folder' }).getByRole('list', { name: 'Folders' })
    await expect(folders.getByRole('button', { name: 'folder-00', exact: true })).toBeVisible()
    // Taller content than the list shows, and the list itself is what scrolls.
    expect(await folders.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await folders.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => folders.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
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

// A session chip of another project (the cockpit.sessions strip): its window is a hidden page nothing
// can raise, so main sends the clicking browser view there (`project.goto`), and the page opens with
// that tab selected and `tab` dropped from its address.
test('server mode: a session chip of another project in the browser goes to that project with that tab selected', async () => {
  test.setTimeout(120_000)
  // The bundled plugins on (the harness turns them off): the strip is cockpit.sessions'.
  server = await launchServer({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  const { cockpit } = server
  const other = join(realpathSync(cockpit.root), 'other')
  mkdirSync(other)
  const opened = await fetch(`${server.origin}/api/projects`, {
    method: 'POST',
    headers: { Origin: server.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ open: other })
  })
  expect(opened.status).toBe(200)
  const otherId = ((await opened.json()) as { id: string }).id
  // Two Claude tabs in the other project; the chip of the second one is clicked, so a page that
  // only opened the project (its first tab selected) would not pass.
  const first = await cockpit.hook<string>('openClaudeTab', other)
  const second = await cockpit.hook<string>('openClaudeTab', other)
  expect(first).toBeTruthy()
  expect(second).toBeTruthy()

  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    const strip = page.frameLocator('.top-strip iframe[title="sessions-strip slot"]').locator('.entry')
    await expect(strip).toHaveCount(2, { timeout: 15_000 })
    await page.frameLocator('.top-strip iframe[title="sessions-strip slot"]').locator(`.entry[data-tab-id="${second}"]`).click()

    await expect(page).toHaveURL(`${server.origin}/?project=${encodeURIComponent(otherId)}`, { timeout: 15_000 })
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
    await expectMainAlive(server)
  } finally {
    await browser.close()
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
  ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, project: server.projectId }))
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

// design-web.md §9.9: the app's own notices (a new device, a newer release) are one stdout line each in
// server mode, listed by `ccc web status`, never an OS notification and never an in-page notice. A
// revoked plugin's line is checked in marketplace-revoked.spec.ts (it is printed at start, before a
// spec can listen).
test('server mode: a new device and a newer release are stdout lines, listed in ccc web status', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ mode: 'link', settings: { updateCheck: true } })
  const { cockpit } = server
  const lines: string[] = []
  let partial = ''
  cockpit.app.process().stdout?.on('data', (chunk: Buffer) => {
    const parts = (partial + chunk.toString()).split('\n')
    partial = parts.pop() ?? ''
    lines.push(...parts)
  })
  const statusOf = async (): Promise<WebCliStatus> => JSON.parse((await ccc(server!, ['web', 'status', '--json'])).stdout) as WebCliStatus

  await cockpit.hook('fakeRelease', 'v99.0.0')
  const updateLine = /^cc-cockpit: A new cc-cockpit version is available: 99\.0\.0 \(running .+\)$/
  await expect.poll(() => lines.filter((l) => updateLine.test(l)).length).toBe(1)
  // Asked again: the same version is not announced twice.
  await cockpit.hook('fakeRelease', 'v99.0.0')

  const link = await addDeviceLink(server)
  const browser = await openBrowser(link)
  try {
    const { page } = browser
    await expect(page.getByRole('list', { name: 'Open projects' }).getByRole('link')).toHaveCount(1)
    await expect.poll(() => lines.filter((l) => l.startsWith('cc-cockpit: A new device signed in to web access: ')).length).toBe(1)
    const status = await statusOf()
    const device = status.devices[0]
    expect(device).toBeDefined()
    expect(status.notices.map((n) => n.kind)).toEqual(['update', 'new-device'])
    expect(status.notices[1]).toMatchObject({ text: `A new device signed in to web access: ${device!.name}`, device: device!.id })
    expect(status.notices[0]?.text).toMatch(/^A new cc-cockpit version is available: 99\.0\.0 \(running /)
    // Beside its web-access.log entry: the sign-in with that device id.
    const log = readFileSync(join(cockpit.dataDir, 'logs', 'web-access.log'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { event: string; device?: string })
    expect(log.some((e) => e.event === 'sign-in' && e.device === device!.id)).toBe(true)
    // The text form lists them too, and neither carries a link or a token.
    const text = (await ccc(server, ['web', 'status'])).stdout
    expect(text).toContain('notices: 2')
    expect(text).toContain(`device ${device!.id} (sign-in in web-access.log)`)
    expect(`${text}\n${lines.join('\n')}`).not.toMatch(/#t=|[?&]token=/)
    // Neither is an OS notification (none exists in server mode) or an in-page notice, here or in the browser.
    expect(await cockpit.hook<unknown[]>('notifications')).toEqual([])
    await expect(cockpit.page.getByTestId('page-notice')).toHaveCount(0)
    await expect(page.getByTestId('page-notice')).toHaveCount(0)
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// design-web-browser.md §3.1, §5 (streamed web views, plan Task 2): in server mode a webview panel's
// page is an off-screen BrowserWindow, never a view on any screen. The bundled browser plugin's home
// page at activation is only recorded (no browser shows the panel yet, so no Chromium page is made)
// and the plugin is active; `ccc browser open <file>` from a Claude tab loads at once (the CLI waits
// for the outcome), off-screen, never shown or focused and never taken for a project window; a page
// calling alert() leaves main alive (dialogs disabled). A browser showing the Browser panel is its
// viewer (Task 6 draws the stream), which is what loads the home page; url overlays stay refused.
test('server mode: a web view is an off-screen page; the home page waits for a viewer; alert() leaves main alive', async () => {
  test.setTimeout(120_000)
  server = await launchServer({
    env: { CC_COCKPIT_NO_BUNDLED: '' },
    settings: { pluginSettings: { 'cockpit.browser': { home: 'http://127.0.0.1:9/' } } }
  })
  const { cockpit } = server
  writeFileSync(join(cockpit.projectDir, 'page.html'), '<!doctype html><title>Server page</title><p>served off-screen</p>')
  writeFileSync(
    join(cockpit.projectDir, 'alert.html'),
    '<!doctype html><title>Alert page</title><script>alert("hi"); confirm("sure?"); document.title = "after alert"</script>'
  )
  const none = { urlOverlays: 0, webviews: 0, offscreenWebviews: 0 }
  await expect
    .poll(async () => (await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).plugins.find((p) => p.id === 'cockpit.browser')?.state, {
      timeout: 20_000
    })
    .toBe('active')
  /** Every view main placed on a window (none in server mode) and every off-screen page, read from Electron. */
  const electronViews = () =>
    cockpit.app.evaluate(({ BrowserWindow, WebContentsView, webContents }) => ({
      // A window's own page aside: a url overlay's or a desktop webview panel's view.
      placed: BrowserWindow.getAllWindows().reduce(
        (n, w) => n + w.contentView.children.filter((c) => c instanceof WebContentsView && c.webContents !== w.webContents).length,
        0
      ),
      offscreen: webContents
        .getAllWebContents()
        .filter((w) => !w.isDestroyed() && w.isOffscreen())
        .map((w) => ({ url: w.getURL(), title: w.getTitle(), loading: w.isLoading() }))
    }))
  const browser = await openBrowser(`${server.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, server.origin, server.projectId)
    // Before any browser shows the Browser panel, the home navigate at activation is only recorded.
    expect(await cockpit.hook('nativeViewsMade')).toEqual(none)
    expect((await electronViews()).offscreen).toEqual([])
    const pluginLog = join(cockpit.dataDir, 'logs', 'cockpit.browser.log')
    expect(existsSync(pluginLog) ? readFileSync(pluginLog, 'utf8') : '').not.toContain('home page:')
    const section = page.locator('section.panel[aria-label="Browser"]')
    if (!(await section.isVisible())) await page.getByRole('button', { name: /^Browser/ }).first().click()
    await expect(section).toBeVisible({ timeout: 15_000 })
    // The layout is shared: the hidden page has the panel open too, and its reports change nothing.
    await expect(cockpit.page.locator('section.panel[aria-label="Browser"]')).toBeVisible({ timeout: 15_000 })
    // The browser shows the streamed panel (Task 6): it is the first viewer, so the deferred home
    // page loads now (port 9, which Chromium refuses: the toolbar says so).
    await expect(section.locator('canvas.webview-canvas')).toHaveCount(1)
    await expect(section.locator('.webview-load-error')).toContainText('Could not load the page: ERR_', { timeout: 15_000 })
    expect(await cockpit.hook('nativeViewsMade')).toEqual({ ...none, offscreenWebviews: 1 })

    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'Claude' }).click()
    await browser.waitForTerminalText('FAKE-CLAUDE banner')
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.type('/ccc browser open page.html')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText('FAKE-CLAUDE ccc exit=0 out="ok\\n" err=""')
    expect(await cockpit.hook('nativeViewsMade')).toEqual({ ...none, offscreenWebviews: 1 })
    await expect
      .poll(async () => (await electronViews()).offscreen)
      .toEqual([{ url: expect.stringMatching(/^cc-preview:\/\/t[0-9a-f]+\/page\.html$/), title: 'Server page', loading: false }])
    expect((await electronViews()).placed).toBe(0)
    // Never focused, painting for its viewer (the browser), and nothing main takes for a project
    // window or a page that may send it IPC.
    expect(await cockpit.hook('offscreenWebviews')).toEqual([
      expect.objectContaining({ focused: false, painting: true, projectWindow: false, sender: null })
    ])
    await page.keyboard.type('/ccc browser url')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText(/FAKE-CLAUDE ccc exit=0 out="cc-preview:\/\/t[0-9a-f]+\/page\.html\\tServer page\\n"/)

    // alert() and confirm() return at once in an off-screen page (disableDialogs): main lives, the
    // page goes on to set its title, the same view is reused.
    await page.keyboard.type('/ccc browser open alert.html')
    await page.keyboard.press('Enter')
    const oks = async (): Promise<number> => (await browser.terminalText()).replaceAll('\n', '').split('FAKE-CLAUDE ccc exit=0 out="ok\\n"').length - 1
    await expect.poll(oks).toBe(2)
    await expect.poll(async () => (await electronViews()).offscreen.map((v) => v.title)).toEqual(['after alert'])
    expect(await cockpit.hook('nativeViewsMade')).toEqual({ ...none, offscreenWebviews: 1 })
    await expectMainAlive(server)

    await page.keyboard.type('/ccc overlay --url https://example.com/')
    await page.keyboard.press('Enter')
    await browser.waitForTerminalText('FAKE-CLAUDE ccc exit=1 out="" err="ccc: overlay: url overlays are not available in server mode\\n"')
    expect(await cockpit.hook<unknown[]>('overlays', cockpit.projectDir)).toEqual([])
    expect((await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).plugins.find((p) => p.id === 'cockpit.browser')?.state).toBe('active')
    expect((await electronViews()).placed).toBe(0)
    await expectMainAlive(server)
  } finally {
    await browser.close()
  }
})

// plan Task 24 (design-web.md §9.9): a plugin's ctx.oauth sign-in on a server. The provider's page is a
// link notice in the browser with a box; the redirect to the server's loopback "fails" (the spec plays
// the provider with test/fakes/fake-oauth-server.ts and never follows it), and the address it ended on,
// pasted into the box, finishes the sign-in in main with no request to it. The fake provider is https
// with a throwaway certificate the app trusts through NODE_EXTRA_CA_CERTS, as in plugin-oauth.spec.ts.
const HOST_OAUTH = join(__dirname, '..', 'fixtures', 'plugins', 'host-oauth')
const OAUTH_PLUGIN = 'test.hostoauth'

/** A key and a one-day self-signed certificate for IP 127.0.0.1, in a fresh temp dir (`openssl`, argv only). */
function makeTls(): { key: string; cert: string; certFile: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-tls-'))
  const keyFile = join(dir, 'key.pem')
  const certFile = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'pipe' }
  )
  return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8'), certFile, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('server mode: a plugin signs in by pasting the failed redirect in the browser; a wrong paste is refused, the attempt limit ends it', async () => {
  test.setTimeout(120_000)
  const tls = makeTls()
  const provider = await new FakeOAuthServer({ clientId: 'e2e-client', clientSecret: 'e2e-secret-31d9', tls: { key: tls.key, cert: tls.cert } }).start()
  try {
    server = await launchServer({ env: { NODE_EXTRA_CA_CERTS: tls.certFile } })
    const { cockpit } = server
    // A link that reached the server's own opener would land here.
    await cockpit.app.evaluate(({ shell }) => {
      const g = globalThis as { __opened?: string[] }
      g.__opened = []
      shell.openExternal = (url: string) => {
        g.__opened!.push(url)
        return Promise.resolve()
      }
    })
    const browser = await openBrowser(`${server.origin}/`)
    try {
      const { page } = browser
      await openProjectInBrowser(browser, server.origin, server.projectId)
      // The sign-in ids the notices carry, for the second paste below (the page shows none).
      await page.evaluate(() => {
        const w = window as unknown as { __signIns: string[] }
        w.__signIns = []
        window.cockpit.on('app.linkNotice', (p) => {
          if (p.signIn !== undefined) w.__signIns.push(p.signIn)
        })
      })

      await cockpit.hook('linkPlugin', HOST_OAUTH)
      const saved = await cockpit.hook<{ ok: boolean }>(
        'savePluginProjectSettings',
        cockpit.projectDir,
        OAUTH_PLUGIN,
        { authUrl: provider.authUrl, tokenUrl: provider.tokenUrl, clientId: 'e2e-client' },
        { clientSecret: 'e2e-secret-31d9' }
      )
      expect(saved).toMatchObject({ ok: true })
      await cockpit.hook('enablePlugin', cockpit.projectDir, OAUTH_PLUGIN)
      await expect
        .poll(async () => (await cockpit.hook<{ id: string }[]>('pluginCommands', cockpit.projectDir)).map((c) => c.id), { timeout: 20_000 })
        .toContain(`${OAUTH_PLUGIN}/signin`)

      // Started with no browser origin (a plugin command): every browser of the window gets the notice.
      await cockpit.hook('runPluginCommand', cockpit.projectDir, `${OAUTH_PLUGIN}/signin`)
      const notice = page.getByTestId('oauth-notice')
      await expect(notice).toBeVisible({ timeout: 15_000 })
      const authUrl = await notice.getByRole('link').getAttribute('href')
      expect(new URL(authUrl!).origin).toBe('https://auth.fake.test')
      // The provider's consent, then its redirect to the server's loopback, never followed here.
      const redirect = provider.authorize(authUrl!)
      expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback\?/)
      const box = notice.getByRole('textbox')
      const finish = notice.getByRole('button', { name: 'Finish sign-in' })

      // A wrong state: refused with the one text, which does not echo the address; the sign-in waits on.
      const wrong = new URL(redirect)
      wrong.searchParams.set('state', 'not-the-state')
      await box.fill(wrong.toString())
      await finish.click()
      await expect(notice.getByRole('alert')).toHaveText(OAUTH_PASTE_REFUSED)
      expect(provider.tokenRequests).toEqual([])

      // The real address finishes it: the notice goes, the plugin got and refreshed its tokens.
      await box.fill(redirect)
      await finish.click()
      await expect(notice).toHaveCount(0)
      const record = join(cockpit.root, 'home', 'host-oauth.json')
      await expect.poll(() => existsSync(record), { timeout: 15_000 }).toBe(true)
      const seen = JSON.parse(readFileSync(record, 'utf8')) as { accessToken?: string; refreshedAccessToken?: string; error?: string }
      expect(seen.error).toBeUndefined()
      expect(seen.accessToken).toMatch(/^access-/)
      expect(seen.refreshedAccessToken).toMatch(/^access-/)
      expect(provider.tokenRequests.map((r) => r.grant_type)).toEqual(['authorization_code', 'refresh_token'])

      // A second paste of the same address, after the settle: the same refusal.
      const [signIn] = await page.evaluate(() => (window as unknown as { __signIns: string[] }).__signIns)
      expect(signIn).toBeDefined()
      expect(await page.evaluate((p) => window.cockpit.invoke('oauth.paste', p), { signIn: signIn!, url: redirect })).toEqual({
        ok: false,
        error: OAUTH_PASTE_REFUSED
      })

      // A second sign-in ended by the attempt limit: the notice says it is over instead of keeping a box
      // that refuses everything, and the plugin got the error.
      rmSync(record)
      await cockpit.hook('runPluginCommand', cockpit.projectDir, `${OAUTH_PLUGIN}/signin`)
      await expect(notice).toBeVisible({ timeout: 15_000 })
      const second = new URL(provider.authorize((await notice.getByRole('link').getAttribute('href'))!))
      second.searchParams.set('state', 'not-the-state')
      for (let i = 0; i < MAX_PASTE_ATTEMPTS; i++) {
        await box.fill(second.toString())
        await finish.click()
        // Each answer before the next try; the last one ends the sign-in (checked below).
        if (i < MAX_PASTE_ATTEMPTS - 1) {
          await expect(finish).toBeEnabled()
          await expect(notice.getByRole('alert')).toHaveText(OAUTH_PASTE_REFUSED)
        }
      }
      await expect(notice.getByTestId('oauth-notice-ended')).toHaveText(OAUTH_SIGN_IN_OVER)
      await expect(box).toHaveCount(0)
      await expect.poll(() => existsSync(record), { timeout: 15_000 }).toBe(true)
      expect((JSON.parse(readFileSync(record, 'utf8')) as { error?: string }).error).toContain(`sign-in ended after ${MAX_PASTE_ATTEMPTS}`)
      // Its ✕ takes it down.
      await notice.getByRole('button', { name: 'Dismiss sign-in' }).click()
      await expect(notice).toHaveCount(0)

      // Nothing opened on the server, and the hidden page drew no notice.
      expect(await cockpit.app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toEqual([])
      await expect(cockpit.page.getByTestId('oauth-notice')).toHaveCount(0)
      await expectMainAlive(server)
    } finally {
      await browser.close()
    }
  } finally {
    await server?.close()
    server = undefined
    await provider.stop()
    tls.dispose()
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
