// "Ask before closing a tab that is still running" (design §3 Close). The fixture turns the setting
// off for every other spec; each test here launches its own app with the app's default (on).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchCockpit, test } from './fixtures'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const dialog = (page: Page) => page.getByRole('alertdialog')

test('a running tab asks first: Cancel, Esc and Enter keep it, Close closes it; keys never reach the terminal', async () => {
  const { cockpit: c, close } = await launchCockpit({ confirmTabClose: true })
  try {
    const { page } = c
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')

    // The tab's × asks, with the tab named and Cancel focused (Enter alone is the safe answer).
    await page.getByRole('button', { name: /^Close Shell/ }).click()
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page)).toContainText('Close “Shell · project”?')
    await expect(dialog(page)).toContainText('still running')
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
    // Typing at the dialog reaches nothing behind it: the Enter presses the focused Cancel. (No
    // space: on a focused button a space is a click too.)
    await page.keyboard.type('LEAKED')
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(1)

    // Cmd+W asks the same; Esc cancels (and is not taken for "pop the top overlay").
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await page.keyboard.press(`${MOD}+w`)
    await expect(dialog(page)).toBeVisible()
    // A second Cmd+W while it is up does nothing: no second dialog, no close.
    await page.keyboard.press(`${MOD}+w`)
    await expect(dialog(page)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(1)

    // The Cancel button.
    await page.keyboard.press(`${MOD}+w`)
    await dialog(page).getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog(page)).toHaveCount(0)
    expect(await c.hook<unknown[]>('tabs', c.projectDir)).toHaveLength(1)

    // The keyboard went back to the terminal, and nothing typed at the dialog arrived there.
    await expect(page.locator('.terminal-view:not([hidden]) .xterm-helper-textarea')).toBeFocused()
    await page.keyboard.type('echo BACK')
    await page.keyboard.press('Enter')
    await c.waitForTerminalText('BACK')
    expect(await c.terminalText()).not.toContain('LEAKED')

    // The command palette's Close Tab asks too, and the palette closing does not pull the focus
    // back into the terminal under the dialog.
    await page.keyboard.press(`${MOD}+Shift+P`)
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox').fill('close tab')
    await palette.getByRole('combobox').press('Enter')
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()

    // Close closes it, in main too.
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(page.getByRole('tab')).toHaveCount(0)
    expect(await c.hook<unknown[]>('tabs', c.projectDir)).toEqual([])
  } finally {
    await close()
  }
})

test('a Claude tab’s question names its status; the tab menu’s Close asks too', async () => {
  const { cockpit: c, close } = await launchCockpit({ confirmTabClose: true })
  try {
    const { page } = c
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await expect
      .poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status)
      .toBe('idle')

    await page.getByRole('tab').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close' }).click()
    await expect(dialog(page)).toContainText('Close “Claude · project”?')
    await expect(dialog(page)).toContainText('Claude is idle in this tab')
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(0)
  } finally {
    await close()
  }
})

test('a tab whose process ended closes without asking, from its banner or its ×', async () => {
  const { cockpit: c, close } = await launchCockpit({ confirmTabClose: true })
  try {
    const { page } = c
    // A failed exit keeps the tab with its banner.
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/exit 3')
    const banner = page.getByRole('status')
    await expect(banner).toContainText('exited (code 3)')
    await banner.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(dialog(page)).toHaveCount(0)

    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/exit 3')
    await expect(page.getByRole('status')).toContainText('exited (code 3)')
    await page.getByRole('button', { name: /^Close Claude/ }).click()
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(dialog(page)).toHaveCount(0)
  } finally {
    await close()
  }
})

test('"Don\'t ask again" closes and turns the setting off; then a running tab closes at once', async () => {
  const { cockpit: c, close } = await launchCockpit({ confirmTabClose: true })
  try {
    const { page } = c
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    await c.newTab('shell')
    await expect(page.getByRole('tab')).toHaveCount(2)

    await page.keyboard.press(`${MOD}+w`)
    await dialog(page).getByRole('checkbox', { name: "Don't ask again" }).check()
    await dialog(page).getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect
      .poll(() => (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { confirmTabClose?: unknown }).confirmTabClose)
      .toBe(false)

    // The setting is off now: the other running shell closes with no question.
    await page.getByRole('button', { name: /^Close Shell/ }).click()
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(dialog(page)).toHaveCount(0)

    // And Settings shows it off; turning it back on asks again.
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance and keys' }).click()
    const box = settings.getByRole('checkbox', { name: 'Ask before closing a tab that is still running' })
    await expect(box).not.toBeChecked()
    // A controlled box (it shows main's stored state once the view reloads): click, then wait.
    await box.click()
    await expect(box).toBeChecked()
    await expect(box).toBeEnabled()
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await expect(settings).toHaveCount(0)
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    await page.getByRole('button', { name: /^Close Shell/ }).click()
    await expect(dialog(page)).toBeVisible()
  } finally {
    await close()
  }
})

test('with the setting off a running tab closes at once', async ({ cockpit }) => {
  // The fixture's default data dir has the setting off.
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await cockpit.page.getByRole('button', { name: /^Close Shell/ }).click()
  await expect(cockpit.page.getByRole('tab')).toHaveCount(0)
  await expect(dialog(cockpit.page)).toHaveCount(0)
})
