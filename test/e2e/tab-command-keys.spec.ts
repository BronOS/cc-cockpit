// Key bindings for the new-tab menu entries (design §3 Custom commands › Keys for entries): an
// app-wide and a project entry show up in the keybinding list, unbound; a chord recorded for one
// opens its tab (the fake login shell runs the command, which prints a marker and logs the run to
// runs.log in the project folder); the [+] menu shows the chord; the chord does nothing behind the
// settings screen; and once the entry is removed the chord does nothing at all.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Cockpit } from './fixtures'

// `$((...))` proves a shell parsed it; `sleep` keeps the tab open (a clean exit would close it).
const PROJECT_COMMAND = 'echo ran >> runs.log; echo "KEYED-MARKER-$((40 + 2))"; sleep 600'
const APP_COMMAND = 'echo "APP-KEYED-$((6 * 7))"; sleep 600'

const runs = (c: Cockpit): number => {
  const file = join(c.projectDir, 'runs.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}

async function addEntry(page: Page, level: 'app' | 'project', label: string, command: string): Promise<void> {
  const editor = page.locator(`.tab-commands[data-level="${level}"]`)
  await editor.getByPlaceholder('Label').fill(label)
  await editor.getByPlaceholder(/^Command line/).fill(command)
  await editor.getByRole('button', { name: 'Add' }).click()
  await expect(editor.getByRole('textbox', { name: /^Label of command/ }).last()).toHaveValue(label)
}

test('a chord bound to a new-tab menu entry opens its tab, shows in the [+] menu, and stops once the entry is removed', async ({
  cockpit: c
}) => {
  const { page } = c
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'General', exact: true }).click()
  await addEntry(page, 'app', 'App keyed', APP_COMMAND)
  await settings.getByRole('button', { name: 'This Project' }).click()
  await addEntry(page, 'project', 'Proj keyed', PROJECT_COMMAND)

  // Both are in the keybinding list, unbound (no default chord).
  await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
  await settings.getByLabel('Filter commands').fill('New tab:')
  const appRow = settings.locator('[data-command^="tab.newCommand.app."]')
  const projRow = settings.locator('[data-command^="tab.newCommand.project."]')
  await expect(appRow).toContainText('New tab: App keyed')
  await expect(projRow).toContainText('New tab: Proj keyed')
  await expect(appRow.getByLabel('Key of New tab: App keyed')).toHaveText('unbound')
  await expect(projRow.getByLabel('Key of New tab: Proj keyed')).toHaveText('unbound')

  // Record a chord for the project entry, as for any command.
  await projRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('ControlOrMeta+Shift+L')
  await expect(projRow.getByLabel('Key of New tab: Proj keyed')).toHaveText(/L$/)
  await expect(projRow.getByText('custom')).toBeVisible()
  const commandId = await projRow.getAttribute('data-command')
  await expect
    .poll(() => (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { keyOverrides?: Record<string, string> }).keyOverrides)
    .toEqual({ [commandId!]: process.platform === 'darwin' ? 'shift+meta+l' : 'ctrl+shift+l' })

  // Behind the settings screen the chord opens nothing.
  await page.keyboard.press('ControlOrMeta+Shift+L')
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await expect(page.getByRole('tab')).toHaveCount(0)
  expect(runs(c)).toBe(0)

  // In the window: a tab titled by the label, running the entry's command.
  await page.keyboard.press('ControlOrMeta+Shift+L')
  await expect(page.getByRole('tab', { name: 'Proj keyed' })).toHaveCount(1)
  await c.waitForTerminalText('KEYED-MARKER-42')
  expect(runs(c)).toBe(1)

  // The [+] menu shows the chord next to the label (and only there: the app entry is unbound).
  await page.getByRole('button', { name: 'New tab' }).click()
  const menu = page.getByRole('menu')
  const item = menu.getByRole('menuitem', { name: 'Proj keyed', exact: true })
  // One keycap per key (⇧ ⌘ L) inside `.keys`; their joined text is the chord as displayChord shows it.
  await expect(item.locator('.keys')).toHaveText(process.platform === 'darwin' ? '⇧⌘L' : 'Ctrl+Shift+L')
  await expect(item).toHaveAttribute('aria-keyshortcuts', process.platform === 'darwin' ? 'Shift+Meta+L' : 'Ctrl+Shift+L')
  await expect(menu.getByRole('menuitem', { name: 'App keyed', exact: true }).locator('.keys')).toHaveCount(0)
  // Claude and Shell show their default chords too.
  const mac = process.platform === 'darwin'
  const claudeItem = menu.getByRole('menuitem', { name: 'Claude', exact: true })
  const shellItem = menu.getByRole('menuitem', { name: 'Shell', exact: true })
  await expect(claudeItem.locator('.keys')).toHaveText(mac ? '⌘T' : 'Ctrl+T')
  await expect(shellItem.locator('.keys')).toHaveText(mac ? '⇧⌘T' : 'Ctrl+Shift+T')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Rebind Claude and unbind Shell in settings: the menu follows.
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
  await settings.getByLabel('Filter commands').fill('New ')
  const claudeRow = settings.locator('[data-command="tab.newClaude"]')
  const shellRow = settings.locator('[data-command="tab.newShell"]')
  await claudeRow.getByRole('button', { name: 'Change' }).click()
  await page.keyboard.press('ControlOrMeta+Shift+K')
  await expect(claudeRow.getByText('custom')).toBeVisible()
  await shellRow.getByRole('button', { name: 'Unbind' }).click()
  await expect(shellRow.getByLabel('Key of New Shell Tab')).toHaveText('unbound')
  // The Unbind button disabled itself under the focus, so Esc would not reach the screen: toggle.
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeHidden()
  await page.getByRole('button', { name: 'New tab' }).click()
  await expect(claudeItem.locator('.keys')).toHaveText(mac ? '⇧⌘K' : 'Ctrl+Shift+K')
  await expect(shellItem.locator('.keys')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // The palette lists both entries.
  await page.keyboard.press('ControlOrMeta+Shift+P')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Command' }).fill('New tab:')
  await expect(palette.getByRole('option')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  // Remove the entry: its row leaves the keybinding list (the window got the new key table) ...
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'This Project' }).click()
  await settings.getByRole('button', { name: 'Remove Proj keyed' }).click()
  await expect(settings.getByRole('button', { name: 'Remove Proj keyed' })).toHaveCount(0)
  await settings.getByRole('button', { name: 'Keybindings', exact: true }).click()
  await settings.getByLabel('Filter commands').fill('New tab:')
  await expect(appRow).toHaveCount(1)
  await expect(projRow).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  // ... and the chord does nothing: no tab, no run. The menu shows no entry for it either.
  await page.keyboard.press('ControlOrMeta+Shift+L')
  await page.getByRole('button', { name: 'New tab' }).click()
  await expect(menu.getByRole('menuitem')).toHaveText([/^Claude/, 'Shell', 'App keyed'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tab')).toHaveCount(1)
  expect(runs(c)).toBe(1)
})
