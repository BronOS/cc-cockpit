// Task 33: the settings overlay's "This Project", "Appearance" and "Keybindings" pages. A fixture plugin
// with a panel is enabled for the project (its icon appears, the host restarts), moved to another
// zone and disabled again (icon gone); a project settings form is saved (main validates) and no
// account picker is shown (accounts left core, design §6); each field is "Use global" until it is
// overridden, and a save stores the overrides only (design-next §5.2); its secret field is set,
// replaced and cleared, keyed by this project's id and never shown; a global value set on the
// plugin's global page (Plugins › Settings) reaches the fields that use global; the theme is
// switched; a keybinding is changed, a conflict is warned about, and the new chord is used.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { expect, test } from './fixtures'

const PANELS = join(__dirname, '..', 'fixtures', 'plugins', 'panels')
const SETTINGS_UI = join(__dirname, '..', 'fixtures', 'plugins', 'settings-ui')

// A string expression: the e2e tsconfig has no DOM lib, and the code runs in the page anyway.
const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate<string>(`getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`)

test('settings: enable a plugin for the project, its settings, a zone, a theme and a key', async ({
  cockpit
}) => {
  const { page } = cockpit
  const settings = page.getByRole('dialog', { name: 'Settings' })
  const icon = (zone: 'left' | 'right'): ReturnType<Page['locator']> => page.locator(`.zone-${zone} button[title="Echo"]`)
  // Records are written atomically (a `.tmp` sibling renamed over the `.json`), so a listing can
  // name a `.tmp` that is gone by the read; only the `.json` records count, and one that vanishes
  // between listing and read is skipped (the poll reads again).
  const projectFiles = (): string => {
    const dir = join(cockpit.dataDir, 'projects')
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return readFileSync(join(dir, f), 'utf8')
        } catch {
          return ''
        }
      })
      .join('\n')
  }

  await cockpit.hook('linkPlugin', PANELS)
  await cockpit.hook('linkPlugin', SETTINGS_UI)
  await expect(icon('left')).toHaveCount(0)

  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'This Project' }).click()
  const panels = settings.locator('[data-plugin="test.panels"]')
  const enablePanels = settings.getByLabel('Enable Panels')
  await expect(panels).toBeVisible()
  await expect(enablePanels).not.toBeChecked()

  // Enable: the host restarts with the new set and the panel's icon appears in its default zone.
  await enablePanels.click()
  await expect(icon('left')).toHaveCount(1, { timeout: 20_000 })
  await expect(enablePanels).toBeChecked()
  await expect.poll(() => projectFiles(), { timeout: 5_000 }).toContain('test.panels')

  // The panel's zone: the page lists it, a move takes the icon to the other strip.
  const zone = settings.getByLabel('Zone of Echo')
  await expect(zone).toHaveValue('left')
  await zone.selectOption('right')
  await expect(icon('right')).toHaveCount(1)
  await expect(icon('left')).toHaveCount(0)

  // Disable: its icon goes (the placement is remembered, layout.ts reconcile).
  await enablePanels.click()
  await expect(icon('right')).toHaveCount(0, { timeout: 20_000 })
  await expect(icon('left')).toHaveCount(0)
  await expect(enablePanels).not.toBeChecked()
  // Enabled again it comes back where the user put it.
  await enablePanels.click()
  await expect(icon('right')).toHaveCount(1, { timeout: 20_000 })
  await enablePanels.click()
  await expect(icon('right')).toHaveCount(0, { timeout: 20_000 })

  // A plugin with project settings: enable it. The page offers no account picker any more.
  await settings.getByRole('button', { name: 'Projects' }).click()
  await settings.getByRole('button', { name: 'This Project' }).click()
  const ui = settings.locator('[data-plugin="test.settingsui"]')
  await ui.getByLabel('Enable Settings UI fixture').click()
  await expect(ui.getByLabel('Enable Settings UI fixture')).toBeChecked()
  await expect(ui.getByText(/account/i)).toHaveCount(0)

  // The project settings form (@rjsf): every field starts on "Use global" (shown, not editable).
  await ui.getByRole('button', { name: 'Settings' }).click()
  const useGlobal = (field: string): ReturnType<Page['locator']> =>
    ui.locator(`[data-override-field="${field}"]`).getByRole('checkbox', { name: 'Use global' })
  await expect(ui.getByLabel('Board')).toHaveValue('main')
  await expect(ui.getByLabel('Board')).toBeDisabled()
  for (const field of ['board', 'pageSize', 'key']) await expect(useGlobal(field)).toBeChecked()
  // Overridden, a field is edited here: main refuses a value the schema refuses, and stores a good one.
  await useGlobal('pageSize').click()
  await expect(useGlobal('pageSize')).not.toBeChecked()
  await ui.getByLabel('Page size').fill('0')
  await ui.getByRole('button', { name: 'Save settings' }).click()
  await expect(ui.getByRole('alert')).toContainText('pageSize')
  await ui.getByLabel('Page size').fill('50')
  await useGlobal('board').click()
  await ui.getByLabel('Board').fill('release')
  await ui.getByRole('button', { name: 'Save settings' }).click()
  await expect(ui.getByRole('status')).toHaveText('Saved.')
  await expect.poll(() => projectFiles(), { timeout: 5_000 }).toContain('release')
  expect(projectFiles()).toMatch(/"pageSize":\s*50/)
  await expect(useGlobal('board')).not.toBeChecked()
  // "Use global" again drops the override: the field shows the global value (the default here),
  // and the record keeps only the field still overridden.
  await useGlobal('board').click()
  await expect(ui.getByLabel('Board')).toHaveValue('main')
  await ui.getByRole('button', { name: 'Save settings' }).click()
  await expect.poll(() => projectFiles(), { timeout: 5_000 }).not.toContain('release')
  expect(projectFiles()).toMatch(/"test\.settingsui":\s*\{\s*"pageSize":\s*50\s*\}/)
  await expect(useGlobal('board')).toBeChecked()

  // The project's secret field: stored under this project's id, never in its record or the page.
  const PROJECT_FIRST = 'e2e-project-key-first'
  const PROJECT_SECOND = 'e2e-project-key-second'
  const projectIds = readdirSync(join(cockpit.dataDir, 'projects'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
  const storedKeys = async (): Promise<Record<string, string>> => {
    const file = join(cockpit.dataDir, 'secrets.json')
    if (!existsSync(file)) return {}
    const entry = (JSON.parse(readFileSync(file, 'utf8')) as { plugins: Record<string, Record<string, string>> }).plugins[
      'test.settingsui'
    ]
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(entry ?? {})) out[k] = await fakeSecretStore().decrypt(v)
    return out
  }
  const keyState = ui.locator('[data-secret-state]')
  const keyInput = ui.locator('input[type="password"]')
  await expect(keyState).toHaveText('Not set')
  await useGlobal('key').click()
  await ui.getByRole('button', { name: 'Add Project key' }).click()
  await keyInput.fill(PROJECT_FIRST)
  await ui.getByRole('button', { name: 'Save settings' }).click()
  await expect(keyState).toHaveText('Set')
  await expect.poll(storedKeys, { timeout: 5_000 }).toEqual({ [`setting:project:${projectIds[0]}:key`]: PROJECT_FIRST })
  expect(projectIds).toHaveLength(1)
  expect(projectFiles()).not.toContain(PROJECT_FIRST)
  expect(await page.content()).not.toContain(PROJECT_FIRST)
  await ui.getByRole('button', { name: 'Replace Project key' }).click()
  await keyInput.fill(PROJECT_SECOND)
  await ui.getByRole('button', { name: 'Save settings' }).click()
  await expect.poll(storedKeys, { timeout: 5_000 }).toEqual({ [`setting:project:${projectIds[0]}:key`]: PROJECT_SECOND })
  await expect(keyState).toHaveText('Set')
  expect(await page.content()).not.toContain(PROJECT_SECOND)
  expect(projectFiles()).toMatch(/"pageSize":\s*50/)
  await ui.getByRole('button', { name: 'Clear Project key' }).click()
  await ui.getByRole('button', { name: 'Save settings' }).click()
  await expect(keyState).toHaveText('Not set')
  await expect.poll(storedKeys, { timeout: 5_000 }).toEqual({})
  // A cleared override is no override: the field is back on "Use global".
  await expect(useGlobal('key')).toBeChecked()

  // The plugin's global page (Plugins › Settings): the global values of its project fields, under
  // the app fields. A global Board reaches this project, which uses global for it; the overridden
  // Page size stays.
  await settings.getByRole('button', { name: 'Plugins' }).click()
  const pluginRow = settings.locator('[data-plugin="test.settingsui"]')
  const globalToggle = pluginRow.getByRole('button', { name: 'Settings' })
  if ((await globalToggle.getAttribute('aria-expanded')) !== 'true') await globalToggle.click()
  const globals = pluginRow.getByTestId('project-defaults-form')
  await expect(globals.getByLabel('Board')).toHaveValue('main')
  await expect(globals.getByRole('checkbox', { name: 'Use global' })).toHaveCount(0)
  await globals.getByLabel('Board').fill('global-board')
  await globals.getByRole('button', { name: 'Save global values' }).click()
  await expect(globals.getByRole('status')).toHaveText('Saved.')
  await expect
    .poll(() => (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginProjectDefaults?: unknown }).pluginProjectDefaults)
    .toEqual({ 'test.settingsui': { board: 'global-board', pageSize: 20 } })
  await settings.getByRole('button', { name: 'This Project', exact: true }).click()
  const uiToggle = ui.getByRole('button', { name: 'Settings' })
  if ((await uiToggle.getAttribute('aria-expanded')) !== 'true') await uiToggle.click()
  await expect(ui.getByLabel('Board')).toHaveValue('global-board')
  await expect(useGlobal('board')).toBeChecked()
  await expect(ui.getByLabel('Page size')).toHaveValue('50')
  expect(projectFiles()).not.toContain('global-board')

  // Appearance: the theme picker reaches the page (and so the panels and terminals that follow it).
  await settings.getByRole('button', { name: 'Appearance', exact: true }).click()
  const theme = settings.getByLabel('Theme', { exact: true })
  await theme.selectOption({ label: 'Dark (dark)' })
  await expect.poll(() => cssVar(page, '--cc-bg')).toBe('#1a1817')
  await theme.selectOption({ label: 'Light (light)' })
  await expect.poll(() => cssVar(page, '--cc-bg')).toBe('#faf8f6')
  await theme.selectOption({ label: 'Follow the system' })
  await expect(theme).toHaveValue('')

  // Keys (their own page): record a new chord for "New Shell Tab".
  await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
  const shellRow = settings.locator('[data-command="tab.newShell"]')
  const closeRow = settings.locator('[data-command="tab.close"]')
  await settings.getByLabel('Filter commands').fill('tab')
  await shellRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await expect(shellRow.getByLabel('Key of New Shell Tab')).toHaveText(/Y$/)
  await expect(shellRow.getByText('custom')).toBeVisible()
  await expect.poll(() => readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')).toContain('tab.newShell')
  // The recording field is gone, but the keyboard stays in the screen (not on body, where Esc
  // reaches nothing).
  await expect.poll(() => page.evaluate<boolean>(`!!document.activeElement?.closest('[role="dialog"]')`)).toBe(true)

  // Pressing a bound chord while recording records it and does not run its command: Cmd+Shift+W
  // closes the top overlay, which is this screen.
  await closeRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('ControlOrMeta+Shift+W')
  await expect(settings).toBeVisible()
  await expect(closeRow.getByLabel('Key of Close Tab')).toHaveText(/W$/)
  await expect(closeRow.getByText('custom')).toBeVisible()
  await closeRow.getByRole('button', { name: 'Reset' }).click()
  await expect(closeRow.getByText('custom')).toHaveCount(0)

  // Esc while recording cancels it and leaves the screen open, with the focus on the row's
  // button: a second Esc then closes the screen.
  await closeRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('Escape')
  await expect(closeRow.getByRole('button', { name: 'Change' })).toBeFocused()
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
  await settings.getByLabel('Filter commands').fill('tab')

  // The menu's Open Folder accelerator follows a rebind (a menu accelerator wins over the page).
  const openFolderAccelerator = (): Promise<string | undefined> =>
    cockpit.app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()?.items.flatMap((i) => i.submenu?.items ?? []) ?? []
      return items.find((i) => i.label === 'Open Folder…')?.accelerator ?? undefined
    })
  const cmd = process.platform === 'darwin' ? 'Meta' : 'Ctrl'
  expect(await openFolderAccelerator()).toBe(`${cmd}+O`)
  await settings.getByLabel('Filter commands').fill('open folder')
  const folderRow = settings.locator('[data-command="app.openFolder"]')
  await folderRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('ControlOrMeta+Shift+O')
  await expect(folderRow.getByText('custom')).toBeVisible()
  await expect.poll(openFolderAccelerator).toBe(process.platform === 'darwin' ? 'Shift+Meta+O' : 'Ctrl+Shift+O')
  await folderRow.getByRole('button', { name: 'Unbind' }).click()
  await expect.poll(openFolderAccelerator).toBeUndefined()
  await folderRow.getByRole('button', { name: 'Reset' }).click()
  await expect.poll(openFolderAccelerator).toBe(`${cmd}+O`)
  await settings.getByLabel('Filter commands').fill('tab')

  // A chord two commands claim is allowed and warned about on both; and neither fires (two overrides tie).
  await closeRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await expect(shellRow).toContainText('Also bound to Close Tab')
  await expect(closeRow).toContainText('Also bound to New Shell Tab')
  await expect(settings.getByRole('alert').filter({ hasText: 'share a key' })).toBeVisible()
  await closeRow.getByRole('button', { name: 'Reset' }).click()
  await expect(closeRow).not.toContainText('Also bound to')
  await expect(shellRow).not.toContainText('Also bound to')

  // Close the screen and use the new chord; the old one no longer opens a shell tab.
  await page.keyboard.press('ControlOrMeta+Shift+W')
  await expect(settings).toBeHidden()
  await expect(page.getByRole('tab')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+T')
  await page.keyboard.press('ControlOrMeta+Shift+Y')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await expect(page.getByRole('tab')).toHaveCount(1)
  await page.waitForTimeout(500)
  await expect(page.getByRole('tab')).toHaveCount(1)

  // Reset puts the default back.
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
  await settings.getByLabel('Filter commands').fill('new shell')
  await settings.locator('[data-command="tab.newShell"]').getByRole('button', { name: 'Reset' }).click()
  await expect(settings.locator('[data-command="tab.newShell"]').getByText('custom')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+W')
  await page.keyboard.press('ControlOrMeta+Shift+T')
  await expect(page.getByRole('tab')).toHaveCount(2)
})

test("the menu leaves Cmd+O to a plugin command the focused project's keys give it", async ({ cockpit }) => {
  const { page } = cockpit
  const openFolderAccelerator = (): Promise<string | undefined> =>
    cockpit.app.evaluate(({ Menu }) => {
      const items = Menu.getApplicationMenu()?.items.flatMap((i) => i.submenu?.items ?? []) ?? []
      return items.find((i) => i.label === 'Open Folder…')?.accelerator ?? undefined
    })
  const cmd = process.platform === 'darwin' ? 'Meta' : 'Ctrl'
  const setKey = (chord: string | null): Promise<void> =>
    page.evaluate<void>(
      `window.cockpit.invoke('settings.keySet', ${JSON.stringify({ commandId: 'test.panels/pick', chord })})`
    )

  await cockpit.hook('linkPlugin', PANELS)
  await page.evaluate<void>(
    `window.cockpit.invoke('settings.projectPluginEnable', { pluginId: 'test.panels', enabled: true })`
  )
  await expect(page.locator('.zone-left button[title="Echo"]')).toHaveCount(1, { timeout: 20_000 })
  // The accelerator is the focused window's; the test runner may not have given it the focus.
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => !w.isDestroyed())
      ?.focus()
  })
  await expect.poll(openFolderAccelerator).toBe(`${cmd}+O`)

  // The bug: the menu read the core key table only, so it kept Cmd+O and opened the folder dialog
  // in this window although the settings screen showed the plugin's command as the chord's owner.
  // The command is registered once the host has activated the plugin: retry until it is known.
  await expect(() => setKey('Cmd+O')).toPass({ timeout: 10_000 })
  await expect.poll(openFolderAccelerator).toBeUndefined()
  await setKey(null)
  await expect.poll(openFolderAccelerator).toBe(`${cmd}+O`)
})
