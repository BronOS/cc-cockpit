// Plan Task 9: Settings > General > Web access and the top bar's indicator. The access link stays
// hidden until Show, a browser (a Node WebSocket with the device cookie) shows up as a connected
// device in the list and the top bar, Disconnect closes it, Revoke signs it out.
// Plan Task 27: the password mode asks for a password before it switches; a desktop-confirm request
// shows as a card in the window, never answered by Enter, allowed only with the browser's code.
// Plan Task 28: a network bind over plain http, and None on a network address, open the §4.3
// confirm; Cancel (or Esc) leaves loopback.
// The confirm is drawn over the settings screen it opens from (manual-test bug: at the shell's
// confirm z-index it sat under the settings screen, hidden, with the page in front inert: "the app
// stuck"), and accepting it rebinds the gateway to 0.0.0.0 with a browser view connected; that view
// reconnects and stays live. The one network bind in the specs: a random port, turned off at the end.
import { request } from 'node:http'
import type { Page } from '@playwright/test'
import { WebSocket } from 'ws'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'
import { enableWebAccess, openBrowser } from './web-fixtures'

/**
 * Whether the element with `testId` is what is drawn at its own centre, and not something painted
 * over it. A portalled confirm makes #root inert, and an inert element is skipped by hit tests, so
 * Playwright's toBeVisible and click see straight through a settings screen painted on top (the
 * bug this guards passed both). One synchronous hit test with inert lifted sees what the person sees.
 */
function paintedOnTop(page: Page, testId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    const root = document.getElementById('root')
    if (!el || !root) return false
    const box = el.getBoundingClientRect()
    const inert = root.hasAttribute('inert')
    root.removeAttribute('inert')
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    if (inert) root.setAttribute('inert', '')
    return hit !== null && el.contains(hit)
  }, testId)
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; cookie: string; body: string }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }
      },
      (res) => {
        let data = ''
        res.on('data', (d: Buffer) => (data += d.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '', body: data }))
      }
    )
    req.on('error', reject)
    req.end(text)
  })
}

test('web access settings: Show hides the link, a device is listed and revoked, the top bar counts it', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  const port = 20000 + Math.floor(Math.random() * 20000)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const strip = page.locator('header.top-strip')

  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('heading', { name: 'Web access', exact: true })).toBeVisible()
  const enabled = settings.getByRole('checkbox', { name: 'Allow browsers to connect' })
  await expect(enabled).not.toBeChecked()
  await expect(strip.locator('.web-access-chip')).toHaveCount(0)

  // Mode: all four can be picked (plan Task 27).
  const mode = settings.getByRole('combobox', { name: 'Sign-in' })
  await expect(mode.locator('option[value="password"]')).toBeEnabled()
  await expect(mode.locator('option[value="confirm"]')).toBeEnabled()

  // A bad port is refused on the page, with nothing saved.
  await settings.getByLabel('Port', { exact: true }).fill('80')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByRole('alert')).toContainText('port must be a whole number')
  await settings.getByLabel('Port', { exact: true }).fill(String(port))
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByLabel('Port', { exact: true })).toHaveValue(String(port))

  await enabled.click()
  await expect(enabled).toBeChecked()
  await expect(settings.getByText(`listening on port ${port}`)).toBeVisible()

  // The link is not in the page until Show; Hide takes it away again.
  const row = settings.getByTestId('web-access-link')
  await expect(settings.locator('body, *').filter({ hasText: '#t=' })).toHaveCount(0)
  await row.getByRole('button', { name: 'Show', exact: true }).click()
  const link = settings.getByLabel('Access link', { exact: true })
  await expect(link).toContainText(`http://127.0.0.1:${port}/#t=`)
  await expect(settings.getByRole('img', { name: 'Access link as a QR code' })).toBeVisible()
  const text = (await link.textContent()) ?? ''
  const token = text.split('#t=')[1] ?? ''
  expect(token.length).toBeGreaterThanOrEqual(40)
  await row.getByRole('button', { name: 'Hide' }).click()
  await expect(link).toHaveCount(0)
  await expect(settings.getByText('#t=')).toHaveCount(0)

  // A browser signs in and connects: listed as connected, counted in the top bar (settings closed).
  const signed = await post(port, '/auth/link', { token, name: 'Test phone' })
  expect(signed.status).toBe(200)
  const device = settings.getByTestId('web-access-device').filter({ hasText: 'Test phone' })
  await expect(device).toBeVisible()
  const projectId = await page.evaluate(async () => {
    const info = await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('window.info')
    return info.kind === 'project' ? info.project.id : ''
  })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}`, headers: { Cookie: signed.cookie } })
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('error', reject)
  })
  ws.send(JSON.stringify({ t: 'hello', v: 1, project: projectId }))
  await expect(device).toContainText('connected now')
  await expect(strip.locator('.web-access-chip')).toContainText('1 device')

  // Disconnect closes the socket and keeps the device; Revoke removes it.
  await device.getByRole('button', { name: 'Disconnect' }).click()
  await closed
  await expect(device).toContainText('last used')
  await expect(strip.locator('.web-access-chip')).toHaveCount(0)
  await device.getByRole('button', { name: 'Revoke', exact: true }).click()
  await expect(settings.getByTestId('web-access-devices')).toContainText('No device has signed in.')
})

test('web access sign-in modes: a password before the switch, a desktop confirm by the browser\'s code', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  const port = 20000 + Math.floor(Math.random() * 20000)
  const settings = page.getByRole('dialog', { name: 'Settings' })

  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByLabel('Port', { exact: true }).fill(String(port))
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByLabel('Port', { exact: true })).toHaveValue(String(port))
  await settings.getByRole('checkbox', { name: 'Allow browsers to connect' }).click()
  await expect(settings.getByText(`listening on port ${port}`)).toBeVisible()

  // Password: with none set, picking the mode asks for one first; main switches once it is saved.
  const mode = settings.getByRole('combobox', { name: 'Sign-in' })
  await mode.selectOption('password')
  await expect(settings.getByTestId('web-access-link')).toHaveCount(0)
  await settings.getByLabel('Password', { exact: true }).fill('correct horse')
  await settings.getByLabel('Repeat it', { exact: true }).fill('correct horse')
  await settings.getByRole('button', { name: 'Set password' }).click()
  await expect(settings.getByRole('button', { name: 'Change password' })).toBeVisible()
  await expect(mode).toHaveValue('password')
  expect((await post(port, '/auth/password', { password: 'wrong horse' })).status).toBe(401)
  const signed = await post(port, '/auth/password', { password: 'correct horse', name: 'Test laptop' })
  expect(signed.status).toBe(200)
  expect(signed.cookie).toContain('ccc_device=')
  await expect(settings.getByTestId('web-access-device').filter({ hasText: 'Test laptop' })).toContainText('password')

  // Desktop confirm: a browser asks; the card shows its own name, never the code.
  await mode.selectOption('confirm')
  await expect(mode).toHaveValue('confirm')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toBeHidden()
  const asked = await post(port, '/auth/confirm', { name: 'Test tablet' })
  expect(asked.status).toBe(200)
  const { code, ticket } = JSON.parse(asked.body) as { code: string; ticket: string }
  const card = page.getByTestId('web-confirm-card')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Test tablet')
  await expect(card).not.toContainText(code)
  // Nothing is focused for the person: their keys keep going where they were going.
  await expect(card.getByRole('textbox')).not.toBeFocused()

  // Enter never answers it, with a wrong code or the right one.
  const input = card.getByRole('textbox')
  const wrong = code === '000000' ? '111111' : '000000'
  await input.fill(wrong)
  await input.press('Enter')
  await card.getByRole('button', { name: 'Allow' }).click()
  await expect(card.getByRole('alert')).toContainText('not the code')
  await input.fill(code)
  await input.press('Enter')
  await expect(card).toBeVisible()
  expect(JSON.parse((await post(port, '/auth/confirm/poll', { ticket })).body)).toMatchObject({ state: 'pending' })

  // Allow with the browser's code: the card goes, the browser's next poll carries the cookie.
  await card.getByRole('button', { name: 'Allow' }).click()
  await expect(card).toHaveCount(0)
  const allowed = await post(port, '/auth/confirm/poll', { ticket })
  expect(JSON.parse(allowed.body)).toMatchObject({ state: 'allowed', device: { name: 'Test tablet' } })
  expect(allowed.cookie).toContain('ccc_device=')
})

test('web access network binds: the §4.3 confirms, and a cancelled one leaves loopback', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  const port = 20000 + Math.floor(Math.random() * 20000)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const confirm = page.getByTestId('web-access-risk-confirm')
  const saved = (): Promise<{ bind: string; enabled: boolean; mode: string }> =>
    page.evaluate(async () => (await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('settings.webAccess')).form)

  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByLabel('Port', { exact: true }).fill(String(port))
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByLabel('Port', { exact: true })).toHaveValue(String(port))
  const enabled = settings.getByRole('checkbox', { name: 'Allow browsers to connect' })
  await enabled.click()
  await expect(settings.getByText(`listening on port ${port}`)).toBeVisible()

  // Plain http on every network: the confirm says what it means; Cancel has the focus, so Enter keeps loopback.
  const bind = settings.getByLabel('Listen on', { exact: true })
  await bind.fill('0.0.0.0')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(confirm).toBeVisible()
  expect(await paintedOnTop(page, 'web-access-risk-confirm')).toBe(true)
  await expect(confirm).toHaveAttribute('data-risk', 'plain-http')
  await expect(confirm).toContainText('unencrypted')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(confirm).toHaveCount(0)
  expect(await saved()).toMatchObject({ bind: '127.0.0.1', enabled: true })
  await expect(settings.getByText(`listening on port ${port}`)).toBeVisible()
  await expect(page.locator('header.top-strip .web-access-chip.warn')).toHaveCount(0)

  // None on a network address (with TLS, so only that risk), chosen while off: turning on asks with
  // the design's words; Esc cancels and web access stays off.
  await enabled.click()
  await expect(enabled).not.toBeChecked()
  await settings.getByLabel('Certificate file').fill('/nonexistent/cert.pem')
  await settings.getByLabel('Key file').fill('/nonexistent/key.pem')
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByLabel('Listen on', { exact: true })).toHaveValue('0.0.0.0')
  await expect(confirm).toHaveCount(0)
  await settings.getByRole('combobox', { name: 'Sign-in' }).selectOption('none')
  await expect(settings.getByText('Revoke has no effect in this mode')).toBeVisible()
  await expect(settings.getByTestId('web-access-none-revoke')).toBeVisible()
  await enabled.click()
  await expect(confirm).toBeVisible()
  await expect(confirm).toHaveAttribute('data-risk', 'none-network')
  await expect(confirm.getByRole('heading')).toHaveText('Anyone who can reach this address controls this computer.')
  await expect(confirm).toContainText('run Claude with your account')
  await expect(confirm.getByRole('button', { name: 'I understand, turn off sign-in' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  expect(await saved()).toMatchObject({ bind: '0.0.0.0', enabled: false, mode: 'none' })
  await expect(enabled).not.toBeChecked()
})

test('web access network bind accepted: the confirm is on top, the gateway rebinds to 0.0.0.0, a connected browser comes back', async ({ cockpit }) => {
  test.setTimeout(90_000)
  const { page } = cockpit
  const web = await enableWebAccess(cockpit)
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  const browser = await openBrowser(web.link)
  const gateway = (): Promise<string> =>
    page.evaluate(async () => JSON.stringify((await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('settings.webAccess')).gateway))
  try {
    // A browser view is live on the loopback listener.
    await browser.page.getByRole('list', { name: 'Open projects' }).getByRole('link').click()
    await browser.waitForTerminalText('FAKE-SHELL ready')
    await expect(page.locator('header.top-strip .web-access-chip')).toContainText('1 device')

    const settings = page.getByRole('dialog', { name: 'Settings' })
    const confirm = page.getByTestId('web-access-risk-confirm')
    await page.keyboard.press('ControlOrMeta+,')
    await expect(settings).toBeVisible()
    const bind = settings.getByLabel('Listen on', { exact: true })
    await bind.fill('0.0.0.0')
    await settings.getByRole('button', { name: 'Save' }).click()

    // The confirm is up, over the settings screen, and has the keyboard.
    await expect(confirm).toBeVisible()
    expect(await paintedOnTop(page, 'web-access-risk-confirm')).toBe(true)
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    expect(JSON.parse(await gateway())).toMatchObject({ state: 'listening', bind: '127.0.0.1', port: web.port })
    await confirm.getByRole('button', { name: /^I understand/ }).click()
    await expect(confirm).toHaveCount(0)

    // The gateway listens on every address (same port), and the settings page is live again.
    await expect.poll(async () => JSON.parse(await gateway()), { timeout: 15_000 }).toMatchObject({ state: 'listening', bind: '0.0.0.0', port: web.port })
    expect(await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))).toBe(false)
    await expect(bind).toHaveValue('0.0.0.0')
    await expect(settings.getByTestId('web-access-risks')).toBeVisible()
    await expect(page.locator('header.top-strip .web-access-chip.warn')).toBeVisible()

    // The browser's socket was dropped with the old listener; it reconnects to the new one (0.0.0.0
    // covers loopback) and is live: the desktop's output reaches it.
    await expect(page.locator('header.top-strip .web-access-chip')).toContainText('1 device', { timeout: 15_000 })
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await expect(settings).toBeHidden()
    await cockpit.typeLine('echo rebound-$((80+8))')
    await cockpit.waitForTerminalText('rebound-88')
    await browser.waitForTerminalText('rebound-88', 15_000)

    // Responsive to the end: turning web access off from the page closes the network listener.
    await page.keyboard.press('ControlOrMeta+,')
    await expect(settings).toBeVisible()
    const enabled = settings.getByRole('checkbox', { name: 'Allow browsers to connect' })
    await enabled.click()
    await expect(enabled).not.toBeChecked()
    await expect.poll(async () => JSON.parse(await gateway())).toMatchObject({ state: 'off' })
  } finally {
    // Never leave a listener on every address behind, even when a step above failed.
    await page
      .evaluate(async () => {
        await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('settings.webAccessSet', { value: { enabled: false } })
      })
      .catch(() => undefined)
    await browser.close()
  }
})
