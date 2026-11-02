// Task 32: the settings overlay (Cmd+,): projects and plugins. A fixture plugin is linked through
// the Plugins page (the native folder dialog is stubbed in main), its app-wide settings form
// (@rjsf, no validator in the page: main is the authority) is saved, and a terminal overlay opened
// over the screen shows on top of it. There is no Accounts page any more (design §6: a plugin
// brings its own sign-in); its secret settings field (`"format": "secret"`) is set, replaced and
// cleared here, stored encrypted by main (the harness's fake secret store) and never shown.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'settings-ui')
const FIRST = 'e2e-app-token-first'
const SECOND = 'e2e-app-token-second'

test('settings: link a plugin, save its app settings, an overlay over the screen', async ({ cockpit }) => {
  const { page, app } = cockpit
  // The page's CSP stays strict: a form that needed 'unsafe-eval' would log a violation here.
  const violations: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (/Content Security Policy|unsafe-eval|EvalError/i.test(text)) violations.push(text)
  })

  // Cmd+, opens the screen from the terminal's focus; Esc closes it; Cmd+, opens it again.
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await cockpit.newTab('shell')
  await page.locator('.terminal-view:not([hidden]) .xterm').click()
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  // "Open Settings" from the palette: the palette closing queues a focus frame for the terminal
  // before the screen opens. The keyboard must end up on the screen, not in the shell under it.
  // The specs compile without the DOM lib: the page's globals are typed structurally.
  type PageGlobals = {
    document: { activeElement: { closest(selector: string): unknown } | null }
    requestAnimationFrame(cb: () => void): void
  }
  const focusWithin = (selector: string): Promise<boolean> =>
    page.evaluate((s) => (globalThis as unknown as PageGlobals).document.activeElement?.closest(s) != null, selector)
  const focusInSettings = (): Promise<boolean> => focusWithin('.settings')
  const focusBehind = (): Promise<boolean> => focusWithin('.zones, .top-strip')
  await page.keyboard.press('ControlOrMeta+Shift+P')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('open settings')
  await palette.getByRole('combobox').press('Enter')
  await expect(settings).toBeVisible()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const g = globalThis as unknown as PageGlobals
        g.requestAnimationFrame(() => g.requestAnimationFrame(resolve))
      })
  )
  expect(await focusInSettings()).toBe(true)
  // The window behind is inert: Tab and Shift+Tab never walk into the tab bar or the terminal.
  await expect(page.locator('.zones')).toHaveAttribute('inert', '')
  for (const key of [...Array<string>(15).fill('Tab'), ...Array<string>(15).fill('Shift+Tab')]) {
    await page.keyboard.press(key)
    expect(await focusBehind()).toBe(false)
  }
  // Cmd+Shift+W closes the top core overlay, here the settings screen itself.
  await page.keyboard.press('ControlOrMeta+Shift+W')
  await expect(settings).toBeHidden()
  await expect(page.locator('.zones')).not.toHaveAttribute('inert')

  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await expect(settings.getByRole('navigation').getByRole('button')).toHaveText([
    'Projects',
    'Plugins',
    'Marketplace',
    'This project',
    'Appearance and keys'
  ])

  // Projects: this window's project is listed as open and cannot be removed.
  const projectRow = settings.locator('[data-project="project"]')
  await expect(projectRow).toContainText(cockpit.projectDir)
  await expect(projectRow.locator('.settings-badge')).toHaveText('open')
  await expect(projectRow.getByRole('button', { name: 'Remove' })).toHaveCount(0)

  // Plugins: link the fixture folder (the dialog is stubbed in main).
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
  }, FIXTURE)
  await settings.getByRole('button', { name: 'Link folder…' }).click()
  const plugin = settings.locator('[data-plugin="test.settingsui"]')
  await expect(plugin).toContainText('Settings UI fixture')
  await expect(plugin).toContainText(`linked ${FIXTURE}`)

  // Its app-wide settings form is rendered from the manifest's schema, defaults filled in.
  await plugin.getByRole('button', { name: 'Settings' }).click()
  const greeting = plugin.getByLabel('Greeting')
  await expect(greeting).toHaveValue('hello')
  await expect(plugin.getByLabel('Limit')).toHaveValue('10')

  // A value the schema refuses (minimum 1) is not checked in the page: main answers with the reason.
  await plugin.getByLabel('Limit').fill('0')
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(plugin.getByRole('alert')).toContainText('limit')
  await expect(plugin.getByRole('status')).toHaveCount(0)

  await plugin.getByLabel('Limit').fill('25')
  await greeting.fill('hi there')
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(plugin.getByRole('status')).toHaveText('Saved.')
  const appJson = (): { pluginSettings?: Record<string, unknown> } =>
    JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginSettings?: Record<string, unknown> }
  await expect
    .poll(() => appJson().pluginSettings?.['test.settingsui'], { timeout: 5_000 })
    .toEqual({ greeting: 'hi there', limit: 25 })

  // The secret field (required, and unset: the plugin is not disabled for it). Set it: the value
  // goes to main once, which stores it encrypted in secrets.json, never in app.json or the page.
  const secretState = plugin.locator('[data-secret-state]')
  // The password field Add or Replace opens (labelled "API token" plus rjsf's required mark).
  const tokenInput = plugin.locator('input[type="password"]')
  const storedToken = async (): Promise<string | null> => {
    const file = join(cockpit.dataDir, 'secrets.json')
    if (!existsSync(file)) return null
    const stored = (JSON.parse(readFileSync(file, 'utf8')) as { plugins: Record<string, Record<string, string>> }).plugins[
      'test.settingsui'
    ]?.['setting:app:token']
    return stored === undefined ? null : fakeSecretStore().decrypt(stored)
  }
  await expect(secretState).toHaveText('Not set')
  await expect(plugin.getByText('Stored settings are invalid')).toHaveCount(0)
  await plugin.getByRole('button', { name: 'Add API token' }).click()
  await tokenInput.fill(FIRST)
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(plugin.getByRole('status')).toHaveText('Saved.')
  await expect(secretState).toHaveText('Set')
  await expect(tokenInput).toHaveCount(0)
  await expect.poll(storedToken, { timeout: 5_000 }).toBe(FIRST)
  expect(readFileSync(join(cockpit.dataDir, 'secrets.json'), 'utf8')).not.toContain(FIRST)
  expect(JSON.stringify(appJson())).not.toContain(FIRST)
  expect(await page.content()).not.toContain(FIRST)

  // Replace: a new value over the old one; Cancel first leaves it as it is.
  await plugin.getByRole('button', { name: 'Replace API token' }).click()
  await tokenInput.fill('typed then cancelled')
  await plugin.getByRole('button', { name: 'Cancel' }).click()
  await expect(secretState).toHaveText('Set')
  await plugin.getByRole('button', { name: 'Replace API token' }).click()
  await tokenInput.fill(SECOND)
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect.poll(storedToken, { timeout: 5_000 }).toBe(SECOND)
  await expect(secretState).toHaveText('Set')
  // The other settings were saved as they were.
  expect(appJson().pluginSettings?.['test.settingsui']).toEqual({ greeting: 'hi there', limit: 25 })

  // Back on the page (the list loaded again), it is still set: main's answer, not the form's memory.
  await settings.getByRole('button', { name: 'Projects' }).click()
  await settings.getByRole('button', { name: 'Plugins' }).click()
  const toggle = plugin.getByRole('button', { name: 'Settings' })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(secretState).toHaveText('Set')
  expect(await page.content()).not.toContain(SECOND)

  // Clear: shown as pending until Save, then gone from secrets.json.
  await plugin.getByRole('button', { name: 'Clear API token' }).click()
  await expect(secretState).toHaveText('Cleared on save')
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(secretState).toHaveText('Not set')
  await expect.poll(storedToken, { timeout: 5_000 }).toBeNull()

  // An overlay opened while the screen shows (a plugin's terminal overlay, here through the test
  // hook) sits on top of it, the screen stays open under it, and when the program ends the
  // keyboard is back on the screen, so Esc closes it.
  const overlay = page.getByRole('dialog', { name: 'Sleeping program' })
  const openOverlay = (script: string): Promise<unknown> =>
    cockpit.hook('openOverlay', cockpit.projectDir, {
      kind: 'terminal',
      argv: ['sh', '-c', script],
      cwd: cockpit.projectDir,
      title: 'Sleeping program'
    })
  await openOverlay('sleep 1')
  await expect(overlay).toBeVisible()
  await expect(settings).toBeVisible()
  await expect(overlay).toBeHidden({ timeout: 15_000 })
  await expect(settings).toBeVisible()
  await expect.poll(focusInSettings).toBe(true)
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()

  // Cmd+Shift+W closes the overlay over the screen first, then (the chord given back to it) the
  // screen. The program sleeps long enough for the first press to find the overlay.
  await openOverlay('sleep 30')
  await expect(overlay).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+W')
  await expect(overlay).toBeHidden()
  await expect(settings).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Shift+W')
  await expect(settings).toBeHidden()
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()

  // Uninstalling the linked plugin takes it off the list (its folder stays).
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await plugin.getByRole('button', { name: 'Uninstall' }).click()
  await plugin.getByRole('button', { name: 'Yes, uninstall' }).click()
  await expect(plugin).toHaveCount(0)

  expect(violations).toEqual([])
})
