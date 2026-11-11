// Server mode end to end (design-web.md §9; plan 20261111-server-mode): the app started as a server
// with no display (test/e2e/server-fixtures.ts), used only from a plain browser. Every spec ends
// with `expectMainAlive`: a fault on the hidden page's side shows as a dead main, not as a failed
// locator, since the browser keeps its last frame.
//
// Markers are printed by shell arithmetic (`echo srv-$((40+2))` prints srv-42), so the command line
// echoed back never contains the text a step waits for: only the shell's output does.
import { expect, test } from '@playwright/test'
import { expectMainAlive, launchServer, type Server } from './server-fixtures'
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
