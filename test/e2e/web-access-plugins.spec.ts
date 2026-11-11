// Plan Task 30: web access part 2, the web shell in a plain browser (test/e2e/web-fixtures.ts) next
// to the Electron window, with web access on loopback.
//
//  1. Panels: the bundled Sessions panel (cockpit.sessions) draws in both views, and a card click
//     acts in the view it came from only (design-web.md §5.3 "Where an action came from": the
//     plugin host carries the origin view, so ctx.sessions.focus selects in the browser and leaves
//     the desktop's selection alone, and the other way round).
//  2. One tab strip: a tab the browser opens or closes does so on the desktop too (§5.1).
//     Take over and shared asks: an html overlay's page lives in one view (§5.4); the browser takes
//     it over, answers it, and the opener settles once while the overlay goes from both screens. A
//     plugin's close ask (ctx.sessions.close, §5.1) is asked on both screens; the browser's answer
//     is the one main takes and the desktop's dialog goes down unanswered.
//  3. Security end to end (§4.1): a socket with the browser's own device cookie but a foreign
//     Origin is refused (from the same browser too, where the cookie does go along: a page on
//     another localhost port is same-site), no cookie is refused, and revoking the device on the
//     desktop closes its sockets at once and leaves the web shell signed out.
import { randomBytes } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
// Named apart from the page's own WebSocket, which the foreign page below uses.
import { WebSocket as WsClient } from 'ws'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { enableWebAccess, openBrowser, type WebAccessOn, type WebBrowser } from './web-fixtures'

/** Opens the access link in a fresh browser and joins the cockpit's project from the web picker. */
async function joinProject(web: WebAccessOn): Promise<WebBrowser> {
  const browser = await openBrowser(web.link)
  try {
    const projects = browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link')
    await expect(projects).toHaveCount(1)
    await projects.click()
    await expect(browser.page).toHaveURL(`${web.origin}/?project=${encodeURIComponent(web.projectId)}`)
    await expect(browser.page.locator('.tabs-pane')).toBeVisible()
    return browser
  } catch (err) {
    await browser.close()
    throw err
  }
}

/**
 * Waits until the tab at `index` is the selected one in a shell (the desktop's or the browser's).
 * By place: both shells draw the window's one tab list in the same order.
 */
async function expectSelected(page: Page, index: number): Promise<void> {
  const tabs = page.getByRole('tab')
  await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { selected: true })).toHaveCount(1)
}

// ---------------------------------------------------------------------------------------------
// 1. The Sessions panel in both views

test('the Sessions panel shows in the browser and on the desktop; a card click selects in its own view only', async () => {
  test.setTimeout(120_000)
  // The bundled plugins on (the harness turns them off): the Sessions panel is cockpit.sessions'.
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  let browser: WebBrowser | undefined
  try {
    const { page } = c
    // On before the tabs start (a tab running at turn-on mirrors from blank, docs/features.md).
    const web = await enableWebAccess(c)
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/prompt alpha errand')
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/prompt beta errand')
    await expect(page.getByRole('tab')).toHaveCount(2)
    // alpha is the first tab, beta the second (and the desktop's selected one, the newest).
    const ALPHA = 0
    const BETA = 1
    await expectSelected(page, BETA)

    // The desktop's panel lists both sessions.
    const panelOf = (p: Page) => p.frameLocator('section.panel[aria-label="Sessions"] iframe')
    const icon = (p: Page) => p.locator('.zone-left').getByRole('button', { name: /^Sessions/ })
    await expect(icon(page)).toBeVisible({ timeout: 15_000 })
    await icon(page).click()
    await expect(panelOf(page).locator('.card')).toHaveCount(2)
    await expect(panelOf(page).locator('.card', { hasText: 'alpha errand' })).toHaveCount(1)

    browser = await joinProject(web)
    const webPage = browser.page
    await expect(webPage.getByRole('tab')).toHaveCount(2)
    // The layout is the window's: the panel the desktop opened is open in the browser too, its
    // page served over HTTP (plugin-pages.ts) and fed by its own port of the plugin host.
    await expect(webPage.locator('.zone-left section.panel[aria-label="Sessions"]')).toBeVisible({ timeout: 15_000 })
    const webPanel = panelOf(webPage)
    await expect(webPanel.locator('.card')).toHaveCount(2)
    await expect(webPanel.locator('.card', { hasText: 'beta errand' })).toHaveCount(1)
    expect(await webPanel.locator('body').evaluate(() => location.protocol)).toBe('http:')

    // A click on a browser card selects that tab in the browser only: the desktop stays on beta.
    // Its selection is read once the browser's has visibly moved: nothing else is in flight that
    // could move it later, so a click that leaked to the desktop would show by then.
    const card = (p: Page, text: string) => panelOf(p).locator('.card', { hasText: text }).locator('button.title')
    await card(webPage, 'alpha errand').click()
    await expectSelected(webPage, ALPHA)
    await expectSelected(page, BETA)
    await card(webPage, 'beta errand').click()
    await expectSelected(webPage, BETA)
    await expectSelected(page, BETA)

    // And the other way round: the desktop's click selects alpha on the desktop only.
    await card(page, 'alpha errand').click()
    await expectSelected(page, ALPHA)
    await expectSelected(webPage, BETA)

    // The panel is live in the browser: a session that ends leaves both lists.
    await c.typeLine('/exit')
    await expect(panelOf(page).locator('.card')).toHaveCount(1)
    await expect(webPanel.locator('.card')).toHaveCount(1)
  } finally {
    await browser?.close()
    await close()
  }
})

// ---------------------------------------------------------------------------------------------
// 2. An html overlay taken over by the browser; a close ask answered there

interface Outcome {
  result?: { kind: string; value?: unknown }
  error?: string
}

/** What the overlay's opener got, once it got anything. */
async function outcome(c: Cockpit, handle: number): Promise<Outcome> {
  let last: Outcome = {}
  await expect
    .poll(async () => {
      last = (await c.hook<Outcome | undefined>('overlayResult', handle)) ?? {}
      return last.result !== undefined || last.error !== undefined
    })
    .toBe(true)
  return last
}

// The page answers through the port the shell hands it, only on a click, and says which view it
// was in (the desktop serves it as cc-overlay:, the browser over http:).
const OVERLAY_PAGE = `<!doctype html><p>question page</p><button id="send">Send</button><script>
  let port
  window.addEventListener('message', (e) => { if (e.ports[0]) port = e.ports[0] })
  document.getElementById('send').addEventListener('click', () => {
    port?.postMessage({ type: 'result', value: 'answered over ' + location.protocol })
  })
</script>`

test('the browser takes over an html overlay and its answer settles the opener once; a close ask answered in the browser settles on the desktop', async () => {
  test.setTimeout(120_000)
  // The app's default (ask before closing a running tab): the plugin close below asks.
  const { cockpit: c, close } = await launchCockpit({ confirmTabClose: true })
  let browser: WebBrowser | undefined
  try {
    const { page } = c
    const web = await enableWebAccess(c)
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    browser = await joinProject(web)
    const webPage = browser.page
    await expect(webPage.getByRole('tab')).toHaveCount(1)
    const deskAsk = page.getByRole('alertdialog')
    const webAsk = webPage.getByRole('alertdialog')

    // The tab strip is the window's: a tab the browser opens shows on the desktop, and one the
    // browser closes (its own close question, asked where the person clicked) leaves it.
    await webPage.getByRole('button', { name: 'New tab' }).click()
    await webPage.getByRole('menuitem', { name: 'Shell' }).click()
    await expect(webPage.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab')).toHaveCount(2)
    await webPage.getByRole('button', { name: /^Close Shell/ }).last().click()
    await expect(webAsk).toBeVisible()
    await expect(deskAsk).toHaveCount(0)
    await webAsk.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(webPage.getByRole('tab')).toHaveCount(1)
    await expect(page.getByRole('tab')).toHaveCount(1)
    expect(await c.hook<unknown[]>('tabs', c.projectDir)).toHaveLength(1)

    // The overlay opens on the desktop (the opener is no browser view), so its page is there.
    const handle = await c.hook<number | undefined>('openOverlay', c.projectDir, {
      kind: 'html',
      html: OVERLAY_PAGE,
      title: 'Question'
    })
    if (handle === undefined) throw new Error('no window for the project')
    const deskOverlay = page.locator('.overlay[data-kind="html"]')
    const webOverlay = webPage.locator('.overlay[data-kind="html"]')
    await expect(deskOverlay.frameLocator('iframe').getByText('question page')).toBeVisible()
    // The browser shows where the page is and Take over, not a second copy of the page.
    await expect(webOverlay).toBeVisible()
    await expect(webOverlay.getByTestId('held-elsewhere')).toContainText('Open on Desktop')
    await expect(webOverlay.locator('iframe')).toHaveCount(0)

    // Take over: the page loads in the browser (over http, under the device's overlay path) and
    // the desktop now says the browser has it.
    await webOverlay.getByRole('button', { name: 'Take over' }).click()
    const webFrame = webOverlay.frameLocator('iframe')
    await expect(webFrame.getByText('question page')).toBeVisible()
    await expect(deskOverlay.getByTestId('held-elsewhere')).toContainText(/Open on Chrome/)
    await expect(deskOverlay.locator('iframe')).toHaveCount(0)
    expect(await c.hook<Outcome>('overlayResult', handle)).toEqual({})

    // The browser's answer settles the opener once, and the overlay closes on both screens.
    await webFrame.getByRole('button', { name: 'Send' }).click()
    expect(await outcome(c, handle)).toEqual({ result: { kind: 'value', value: 'answered over http:' } })
    await expect(deskOverlay).toHaveCount(0)
    await expect(webOverlay).toHaveCount(0)
    expect(await c.hook<unknown[]>('overlays', c.projectDir)).toEqual([])

    // A plugin's close of the running tab asks on both screens (the hook resolves once the window
    // answered, so it is not awaited before the dialogs are driven).
    const tabId = (await c.hook<Array<{ id: string }>>('tabs', c.projectDir))[0]!.id
    const pluginClose = (): Promise<boolean> => c.hook<boolean>('pluginCloseTab', c.projectDir, tabId)

    // Cancel in the browser: closed false, and the desktop's dialog goes down unanswered.
    let answer = pluginClose()
    await expect(deskAsk).toBeVisible()
    await expect(webAsk).toBeVisible()
    await webAsk.getByRole('button', { name: 'Cancel' }).click()
    expect(await answer).toBe(false)
    await expect(webAsk).toHaveCount(0)
    await expect(deskAsk).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(1)

    // Close in the browser: closed true, the desktop's dialog goes, the tab is gone everywhere.
    answer = pluginClose()
    await expect(deskAsk).toBeVisible()
    await expect(webAsk).toBeVisible()
    await webAsk.getByRole('button', { name: 'Close', exact: true }).click()
    expect(await answer).toBe(true)
    await expect(deskAsk).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(webPage.getByRole('tab')).toHaveCount(0)
    expect(await c.hook<unknown[]>('tabs', c.projectDir)).toEqual([])
  } finally {
    await browser?.close()
    await close()
  }
})

// ---------------------------------------------------------------------------------------------
// 3. Security end to end

/** The browser's cookies as a Cookie header (its own profile: only the gateway's device cookie). */
async function cookieHeader(browser: WebBrowser): Promise<string> {
  const cookies = await browser.app.evaluate(async ({ session }) => session.defaultSession.cookies.get({}))
  expect(cookies.length).toBeGreaterThan(0)
  return cookies.map((k) => `${k.name}=${k.value}`).join('; ')
}

/** A WebSocket upgrade by hand: the HTTP status the gateway answered (101 when it upgraded). */
function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers
      }
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode ?? 0)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

/** A plain GET of the project list: 200 signed in, 401 not. */
function projectsStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/projects', headers }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

test('security: a foreign Origin and a missing cookie are refused; a revoked device has its sockets closed', async ({
  cockpit
}) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const web = await enableWebAccess(cockpit)
  const browser = await joinProject(web)
  // Another site's page, on another localhost port: same-site with the gateway, so the browser
  // sends the device cookie with its upgrade, and only the Origin check keeps it out.
  const foreign: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><title>foreign</title><p>foreign page</p>')
  })
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  const foreignUrl = `http://127.0.0.1:${(foreign.address() as AddressInfo).port}/`
  let socket: WsClient | undefined
  try {
    const webPage = browser.page
    await expect(page.locator('header.top-strip .web-access-chip')).toContainText('1 device')
    const cookie = await cookieHeader(browser)

    // The right Origin with the cookie upgrades (the control: what follows fails for its one
    // difference, not for a request the gateway would refuse anyway).
    expect(await upgradeStatus(web.port, { Origin: web.origin, Cookie: cookie })).toBe(101)
    // Wrong Origin, the cookie still there: refused, on the upgrade and on a state-changing post.
    expect(await upgradeStatus(web.port, { Origin: foreignUrl.slice(0, -1), Cookie: cookie })).toBe(403)
    expect(await upgradeStatus(web.port, { Origin: 'http://localhost.evil.example', Cookie: cookie })).toBe(403)
    expect(await upgradeStatus(web.port, { Cookie: cookie })).toBe(403)
    // No cookie, the right Origin: not signed in.
    expect(await upgradeStatus(web.port, { Origin: web.origin })).toBe(401)
    expect(await projectsStatus(web.port, {})).toBe(401)
    expect(await projectsStatus(web.port, { Cookie: cookie })).toBe(200)

    // The same refusal from inside the browser: the foreign page's socket never opens.
    const opened = browser.app.waitForEvent('window')
    await browser.app.evaluate(({ BrowserWindow }, url) => {
      const win = new BrowserWindow({ width: 600, height: 400, webPreferences: { sandbox: true, contextIsolation: true } })
      void win.loadURL(url)
    }, foreignUrl)
    const foreignPage = await opened
    await expect(foreignPage.getByText('foreign page')).toBeVisible()
    const fromForeign = await foreignPage.evaluate(
      (url) =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(url)
          ws.onopen = () => resolve('open')
          ws.onclose = (e) => resolve(`closed ${e.code}`)
        }),
      `ws://127.0.0.1:${web.port}/ws`
    )
    expect(fromForeign).toBe('closed 1006')
    await foreignPage.close()

    // A second live view of the same device (the cookie on a socket of our own, past `hello`).
    socket = new WsClient(`ws://127.0.0.1:${web.port}/ws`, { headers: { Origin: web.origin, Cookie: cookie } })
    const live = socket
    const ready = new Promise<string>((resolve, reject) => {
      live.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as { t?: string }
        if (frame.t === 'ready') resolve(frame.t)
      })
      live.on('error', reject)
    })
    await new Promise<void>((resolve, reject) => {
      live.once('open', () => resolve())
      live.once('error', reject)
    })
    const closed = new Promise<number>((resolve) => live.once('close', (code: number) => resolve(code)))
    live.send(JSON.stringify({ t: 'hello', v: 1, project: web.projectId }))
    expect(await ready).toBe('ready')
    await expect(page.locator('header.top-strip .web-access-chip')).toContainText('1 device')

    // Revoke the device on the desktop: both of its sockets close at once (terminated, 1006, not a
    // hello timeout's 4401), the web shell says it is signed out, and the cookie opens nothing.
    const devices = await page.evaluate(async () => {
      const api = (window as unknown as { cockpit: CockpitApi }).cockpit
      return (await api.invoke('settings.webAccess')).devices.map((d) => d.id)
    })
    expect(devices).toHaveLength(1)
    const revoked = await page.evaluate(async (id) => {
      const api = (window as unknown as { cockpit: CockpitApi }).cockpit
      return api.invoke('settings.webDeviceRevoke', { id })
    }, devices[0]!)
    expect(revoked).toBe(true)
    expect(await closed).toBe(1006)
    await expect(webPage.getByText('This browser is signed out of the host. Sign in again.')).toBeVisible()
    // No device connected: the desktop's chip goes (it counts connected devices only).
    await expect(page.locator('header.top-strip .web-access-chip')).toHaveCount(0)
    expect(await upgradeStatus(web.port, { Origin: web.origin, Cookie: cookie })).toBe(401)
    expect(await projectsStatus(web.port, { Cookie: cookie })).toBe(401)
  } finally {
    socket?.terminate()
    await new Promise<void>((resolve) => foreign.close(() => resolve()))
    await browser.close()
  }
})
