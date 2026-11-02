import { expect, test } from './fixtures'

// Cmd on macOS, Ctrl elsewhere (the default table maps Cmd to Ctrl on Linux).
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test('Cmd+Shift+T opens a shell tab while the terminal has focus', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  // Focus the terminal the way a user does; the chord must reach the app, not the PTY.
  await cockpit.page.locator('.terminal-view:not([hidden]) .xterm').click()

  await cockpit.page.keyboard.press(`${MOD}+Shift+T`)
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await expect(cockpit.page.getByRole('tab')).toHaveCount(2)
  expect(await cockpit.hook<unknown[]>('tabs', cockpit.projectDir)).toHaveLength(2)

  // Cmd+1 goes back to the first (Claude) tab; Cmd+W closes the active one.
  await cockpit.page.keyboard.press(`${MOD}+1`)
  await expect(cockpit.page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await cockpit.page.keyboard.press(`${MOD}+w`)
  await expect(cockpit.page.getByRole('tab')).toHaveCount(1)

  // Nothing the app binds was typed into the terminal, and unbound keys still reach it.
  await cockpit.page.keyboard.press(`${MOD}+t`)
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('plain typing')
  await cockpit.waitForTerminalText('FAKE-CLAUDE echo: plain typing')
})

test('the command palette runs "New Claude Tab"', async ({ cockpit }) => {
  await cockpit.page.keyboard.press(`${MOD}+Shift+P`)
  const palette = cockpit.page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()

  await palette.getByRole('combobox').fill('new claude')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await palette.getByRole('combobox').press('Enter')

  await expect(palette).toHaveCount(0)
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await expect(cockpit.page.getByRole('tab')).toHaveCount(1)
})

test('Escape closes the palette without opening anything', async ({ cockpit }) => {
  await cockpit.page.keyboard.press(`${MOD}+Shift+P`)
  const palette = cockpit.page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await cockpit.page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
  await expect(cockpit.page.getByRole('tab')).toHaveCount(0)
})
