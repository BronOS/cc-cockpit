// Plan Task 9: Settings > General > Web access and the top bar's indicator. The access link stays
// hidden until Show, a browser (a Node WebSocket with the device cookie) shows up as a connected
// device in the list and the top bar, Disconnect closes it, Revoke signs it out.
import { request } from 'node:http'
import { WebSocket } from 'ws'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

function post(port: number, path: string, body: unknown): Promise<{ status: number; cookie: string }> {
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
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '' }))
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

  // Mode: the ones built later are listed but cannot be picked.
  const mode = settings.getByRole('combobox', { name: 'Sign-in' })
  await expect(mode.locator('option[value="password"]')).toBeDisabled()
  await expect(mode.locator('option[value="confirm"]')).toBeDisabled()

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
