// Spike (guest invite, task 02, spec-review item 26): does Remote servers' Direct window open a
// DESKTOP (non-server-mode) host's project? Today's access link (#t=), no guest code. Three cases:
// loopback http, a non-loopback bind over plain http (confirmed), and a self-signed certificate
// (expected to fail: the remote window refuses certificate errors, electron-remote-window.ts).
// Throwaway: kept on guest/02-web as the seed of 07's Direct guest spec.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { CockpitApi } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { enableWebAccess } from './web-fixtures'

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return undefined
}

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => (window as unknown as { cockpit: CockpitApi }).cockpit.invoke(ch as never, p as never),
    [channel, payload] as const
  ) as Promise<T>
}

async function remoteWindow(app: ElectronApplication, origin: string, timeout = 20_000): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(() => {
      found = app.windows().find((p) => !p.isClosed() && p.url().startsWith(`${origin}/`))
      return found !== undefined
    }, { timeout })
    .toBe(true)
  return found!
}

const titles = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => `${w.getTitle()} @ ${w.webContents.getURL()}`).sort())

/** Pastes the link into the picker's Connect to server › Link dialog. */
async function connectDirect(picker: Page, link: string, name: string): Promise<void> {
  await picker.getByRole('button', { name: 'Connect to server…' }).click()
  const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
  await dialog.getByRole('tab', { name: 'Link' }).click()
  await dialog.getByRole('textbox', { name: 'Link' }).fill(link)
  await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill(name)
  await dialog.getByRole('button', { name: 'Connect' }).click()
  // Plain http to another machine: the form warns first and a second Connect goes ahead (connect-form.tsx).
  const warning = dialog.getByTestId('connect-plain-http')
  if (link.startsWith('http://') && !link.startsWith('http://127.0.0.1')) {
    await warning.waitFor()
    console.log(`SPIKE plain-http warning: ${(await warning.innerText()).replaceAll('\n', ' ')}`)
    await dialog.getByRole('button', { name: 'Connect' }).click()
  }
}

/** The remote window lands, opens the host's project, and shows the host's shell tab live. */
async function provesProject(app: ElectronApplication, origin: string, projectId: string, host: Cockpit, log: string[]): Promise<void> {
  const remote = await remoteWindow(app, origin)
  log.push(`remote url after connect: ${remote.url()}`)
  await remote.getByRole('list', { name: 'Open projects' }).waitFor({ timeout: 15_000 })
  log.push('landed on the host web picker (Open projects list)')
  const href = `?project=${encodeURIComponent(projectId)}`
  await remote.getByRole('list', { name: 'Open projects' }).locator(`a[href="${href}"]`).click()
  await expect(remote).toHaveURL(`${origin}/${href}`)
  await remote.locator('.tabs-pane').waitFor()
  await remote.getByRole('tab').first().click()
  const rows = remote.locator('.terminal-view:not([hidden]) .xterm-rows')
  await expect.poll(async () => (await rows.locator('> div').allInnerTexts()).join('\n'), { timeout: 15_000 }).toContain('FAKE-SHELL ready')
  log.push('project page loaded, host shell tab live in the remote window')
  // Typing reaches the host's pty: the fake shell echoes a line.
  await remote.locator('.terminal-view:not([hidden])').click()
  await remote.keyboard.type('echo spike-typed\n')
  await host.waitForTerminalText('spike-typed')
  log.push('typing in the remote window reached the host tab')
  // A reload keeps the sign-in (cookie + origin key in the persist partition).
  await remote.reload()
  await remote.locator('.tabs-pane').waitFor({ timeout: 15_000 })
  log.push(`reload kept the sign-in: ${remote.url()}`)
  log.push(`windows: ${JSON.stringify(await titles(app))}`)
  const view = await invoke<{ devices: Array<{ name: string; mode: string; connected: boolean }> }>(host, 'settings.webAccess')
  log.push(`host devices: ${JSON.stringify(view.devices.map((d) => [d.name, d.mode, d.connected]))}`)
}

test('spike: Direct opens a desktop host project over loopback http', async () => {
  test.setTimeout(180_000)
  const host = await launchCockpit()
  const guest = await launchCockpit({ folderArg: false, ready: 'picker' })
  const log: string[] = []
  try {
    const web = await enableWebAccess(host.cockpit)
    await host.cockpit.newTab('shell')
    await host.cockpit.waitForTerminalText('FAKE-SHELL ready')
    await connectDirect(guest.cockpit.page, web.link, 'Loopback host')
    await provesProject(guest.cockpit.app, web.origin, web.projectId, host.cockpit, log)
  } finally {
    console.log('SPIKE loopback:\n  ' + log.join('\n  '))
    await guest.close()
    await host.close()
  }
})

test('spike: Direct opens a desktop host project over a non-loopback bind (plain http, confirmed)', async () => {
  test.setTimeout(180_000)
  const lan = lanAddress()
  test.skip(lan === undefined, 'no LAN address')
  const host = await launchCockpit()
  const guest = await launchCockpit({ folderArg: false, ready: 'picker' })
  const log: string[] = []
  try {
    const web = await enableWebAccess(host.cockpit)
    await host.cockpit.newTab('shell')
    await host.cockpit.waitForTerminalText('FAKE-SHELL ready')
    const reply = await invoke<unknown>(host.cockpit, 'settings.webAccessSet', { value: { bind: lan, confirm: ['plain-http'] } })
    log.push(`bind reply: ${JSON.stringify((reply as { gateway?: unknown }).gateway ?? reply)}`)
    await expect.poll(async () => (await invoke<{ gateway: { state: string; origin?: string } }>(host.cockpit, 'settings.webAccess')).gateway.state).toBe('listening')
    const link = await invoke<{ ok: boolean; link: string }>(host.cockpit, 'settings.webAccessLink')
    log.push(`link origin: ${link.link.split('#')[0]}`)
    const origin = `http://${lan}:${web.port}`
    expect(link.link.startsWith(`${origin}/#t=`)).toBe(true)
    await connectDirect(guest.cockpit.page, link.link, 'LAN host')
    await provesProject(guest.cockpit.app, origin, web.projectId, host.cockpit, log)
  } finally {
    console.log('SPIKE lan-http:\n  ' + log.join('\n  '))
    await guest.close()
    await host.close()
  }
})

test('spike: Direct against a self-signed certificate (expected refused)', async () => {
  test.setTimeout(180_000)
  const lan = lanAddress()
  test.skip(lan === undefined, 'no LAN address')
  const dir = mkdtempSync(join(tmpdir(), 'ccc-spike-tls-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', `/CN=${lan}`, '-addext', `subjectAltName=IP:${lan},IP:127.0.0.1`], { stdio: 'pipe' })
  const host = await launchCockpit()
  const guest = await launchCockpit({ folderArg: false, ready: 'picker' })
  const log: string[] = []
  try {
    const web = await enableWebAccess(host.cockpit)
    await host.cockpit.newTab('shell')
    await host.cockpit.waitForTerminalText('FAKE-SHELL ready')
    const reply = await invoke<unknown>(host.cockpit, 'settings.webAccessSet', { value: { bind: lan, tls: { certPath, keyPath } } })
    log.push(`tls reply: ${JSON.stringify((reply as { gateway?: unknown }).gateway ?? reply)}`)
    await expect.poll(async () => (await invoke<{ gateway: { state: string } }>(host.cockpit, 'settings.webAccess')).gateway.state).toBe('listening')
    const link = await invoke<{ ok: boolean; link: string }>(host.cockpit, 'settings.webAccessLink')
    const origin = `https://${lan}:${web.port}`
    log.push(`link origin: ${link.link.split('#')[0]}`)
    log.push(`cert sha256: ${execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256']).toString().trim()}`)
    // Sanity: the gateway does serve TLS with that cert.
    await connectDirect(guest.cockpit.page, link.link, 'TLS host')
    await new Promise((r) => setTimeout(r, 8000))
    const app = guest.cockpit.app
    log.push(`windows after 8 s: ${JSON.stringify(await titles(app))}`)
    for (const p of app.windows()) {
      if (p.isClosed()) continue
      const text = (await p.locator('body').innerText().catch(() => '')).slice(0, 600).replaceAll('\n', ' | ')
      log.push(`window ${p.url().slice(0, 80)} text: ${text}`)
    }
    const signedIn = (await invoke<{ devices: unknown[] }>(host.cockpit, 'settings.webAccess')).devices.length
    log.push(`host devices signed in: ${signedIn}`)
    expect(app.windows().some((p) => !p.isClosed() && p.url().startsWith(`${origin}/`) && p.url().includes('project='))).toBe(false)
  } finally {
    console.log('SPIKE self-signed:\n  ' + log.join('\n  '))
    await guest.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
