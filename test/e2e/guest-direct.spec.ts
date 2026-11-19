// A guest joins from its own cockpit (design-guests §11, D-29; task 07b): the host serves web access over
// TLS with its own self-signed certificate, so the invite link carries the certificate's SHA-256 (`c=`).
// The guest pastes the link in Remote servers › Connect to server › Link: main reads the certificate the
// host presents, asks once (Trust this certificate?) only because it equals the pin, and the remote
// window, whose verify proc accepts that one certificate for that origin, opens the guest's project.
// A link whose pin is not the host's certificate is refused with no question. This is the real Electron
// run of the pin that 02 only had against fakes (report-02, open item 1).
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { CockpitApi } from '../../src/shared/ipc'
import { certFingerprintText } from '../../src/shared/remote-servers'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { guestList, inviteGuest } from './guest-fixtures'
import { enableWebAccess } from './web-fixtures'

async function invoke<T>(c: Cockpit, channel: string, payload?: unknown): Promise<T> {
  return c.page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
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

/** Pastes the link into the picker's Connect to server › Link dialog and presses Connect. */
async function connectDirect(picker: Page, link: string, name: string): Promise<ReturnType<Page['getByRole']>> {
  await picker.getByRole('button', { name: 'Connect to server…' }).click()
  const dialog = picker.getByRole('dialog', { name: 'Connect to server' })
  await dialog.getByRole('tab', { name: 'Link' }).click()
  await dialog.getByRole('textbox', { name: 'Link' }).fill(link)
  await dialog.getByRole('textbox', { name: 'Name (optional)' }).fill(name)
  await dialog.getByRole('button', { name: 'Connect' }).click()
  return dialog
}

test('a Direct guest invite to a self-signed host: one Trust prompt for the pinned certificate, then the guest project; a wrong pin is refused unasked', async () => {
  test.setTimeout(180_000)
  const dir = mkdtempSync(join(tmpdir(), 'ccc-e2e-guest-tls-'))
  const certPath = join(dir, 'cert.pem')
  const keyPath = join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' })
  const pin = createHash('sha256').update(new X509Certificate(readFileSync(certPath)).raw).digest('hex')
  const host = await launchCockpit()
  const guest = await launchCockpit({ folderArg: false, ready: 'picker' })
  try {
    const web = await enableWebAccess(host.cockpit)
    await host.cockpit.newTab('shell')
    await host.cockpit.waitForTerminalText('FAKE-SHELL ready')
    // TLS on the loopback bind: the gateway serves its own certificate, so invites carry its pin.
    await invoke(host.cockpit, 'settings.webAccessSet', { value: { tls: { certPath, keyPath } } })
    await expect.poll(async () => (await invoke<{ gateway: { state: string } }>(host.cockpit, 'settings.webAccess')).gateway.state).toBe('listening')
    const origin = `https://127.0.0.1:${web.port}`

    // A link whose pin is not the host's certificate: refused, no prompt, no window, no device.
    const wrong = await inviteGuest(host.cockpit, { name: 'Mallory' })
    expect(wrong.link).toContain(`&c=${pin}`)
    const forged = wrong.link.replace(`c=${pin}`, `c=${pin.slice(0, -1)}${pin.endsWith('0') ? '1' : '0'}`)
    const refusedDialog = await connectDirect(guest.cockpit.page, forged, 'Forged pin')
    await expect(refusedDialog).toContainText('is not the one in the invite')
    await expect(guest.cockpit.page.getByTestId('remote-cert-prompt')).toHaveCount(0)
    expect(guest.cockpit.app.windows().some((p) => !p.isClosed() && p.url().startsWith(`${origin}/`))).toBe(false)
    expect((await guestList(host.cockpit)).find((g) => g.name === 'Mallory')?.state).toBe('pending')
    await refusedDialog.getByRole('button', { name: 'Cancel' }).click()

    // The real link: one prompt showing the origin and the presented certificate (equal to the pin).
    const invited = await inviteGuest(host.cockpit, { name: 'Grace' })
    await connectDirect(guest.cockpit.page, invited.link, 'Grace at host')
    const prompt = guest.cockpit.page.getByTestId('remote-cert-prompt')
    await expect(prompt).toBeVisible()
    await expect(prompt.getByTestId('remote-cert-origin')).toHaveText(origin)
    await expect(prompt.getByTestId('remote-cert-fingerprint')).toHaveText(certFingerprintText(pin))
    // Trust takes a click only after the dialog was seen for a moment (ApprovalArm).
    await expect(prompt.getByTestId('remote-cert-trust')).toBeEnabled({ timeout: 5000 })
    await prompt.getByTestId('remote-cert-trust').click()

    // The remote window accepted that certificate and landed on the guest's own project, live.
    const remote = await remoteWindow(guest.cockpit.app, origin)
    await expect(remote).toHaveURL(`${origin}/?project=${encodeURIComponent(web.projectId)}`, { timeout: 20_000 })
    await remote.locator('.tabs-pane').waitFor({ timeout: 20_000 })
    // The shared shell, live in the guest's own app.
    const rows = remote.locator('.terminal-view:not([hidden]) .xterm-rows')
    await host.cockpit.typeLine('echo seen-in-guest-app')
    await expect.poll(async () => (await rows.locator('> div').allInnerTexts()).join('\n'), { timeout: 15_000 }).toContain('seen-in-guest-app')
    await expect.poll(async () => (await guestList(host.cockpit)).find((g) => g.id === invited.guestId)?.state).not.toBe('pending')
    // Saved only now the window opened (design-remote-desktop §5.4): a guest's Direct record at that origin,
    // with the pin (D-29), which the picker labels "Guest at <origin>" (serverViaText, picker-model.test.ts).
    // Read from app.json: main closed the picker when the remote window opened.
    await expect
      .poll(() => {
        const app = JSON.parse(readFileSync(join(guest.cockpit.dataDir, 'app.json'), 'utf8')) as { remoteServers?: Array<Record<string, unknown>> }
        return (app.remoteServers ?? []).map((s) => ({ guest: s.guest, via: s.via, certSha256: s.certSha256 }))
      })
      .toEqual([{ guest: true, via: { kind: 'direct', origin }, certSha256: pin }])

    // A kick reaches the guest's app as the browser's: the page says so, its terminals are cleared.
    expect(await host.cockpit.hook<boolean>('guestKick', invited.guestId)).toBe(true)
    await expect(remote.getByText('Host removed you.')).toBeVisible({ timeout: 1500 })
    await expect(remote.locator('.xterm-rows')).toHaveCount(0)
  } finally {
    await guest.close()
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
