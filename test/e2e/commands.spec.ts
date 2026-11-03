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

test('Ctrl+Tab flips to the last tab; held, it walks the tabs in recent order with an overlay', async ({ cockpit }) => {
  const page = cockpit.page
  const tabs = page.getByRole('tab')
  const selected = (i: number) => expect(tabs.nth(i)).toHaveAttribute('aria-selected', 'true')
  await cockpit.newTab('shell')
  await cockpit.newTab('shell')
  await cockpit.newTab('shell')
  await expect(tabs).toHaveCount(3)
  // Visit order: 3, then 1 (the most recent), so the recent list is 1, 3, 2.
  await page.keyboard.press(`${MOD}+1`)
  await selected(0)
  const switcher = page.getByRole('dialog', { name: 'Switch tab' })

  // A quick press goes back to the tab before and never shows the overlay.
  await page.keyboard.press('Control+Tab')
  await selected(2)
  await expect(switcher).toHaveCount(0)
  await page.keyboard.press('Control+Tab')
  await selected(0)

  // Held: Tab twice walks to the third most recent (tab 2); the overlay lists all three.
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(switcher).toBeVisible()
  await expect(switcher.getByRole('option')).toHaveCount(3)
  await expect(switcher.getByRole('option', { selected: true })).toHaveCount(1)
  // Shift+Tab steps back without picking.
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await page.keyboard.up('Control')
  await expect(switcher).toHaveCount(0)
  await selected(1)

  // Esc cancels: the tab stays.
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  await expect(switcher).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.up('Control')
  await expect(switcher).toHaveCount(0)
  await selected(1)

  // The mouse: moving over a row keeps the overlay open past the release; a click picks it.
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  await expect(switcher).toBeVisible()
  const last = switcher.getByRole('option').nth(2)
  const box = (await last.boundingBox())!
  await page.mouse.move(box.x + 10, box.y + box.height / 2)
  await page.mouse.move(box.x + 30, box.y + box.height / 2)
  await page.keyboard.up('Control')
  await expect(switcher).toBeVisible()
  await last.click()
  await expect(switcher).toHaveCount(0)
  await selected(2)
})

test('Switch to Recent Tab from the palette opens the switcher and waits for a pick', async ({ cockpit }) => {
  const page = cockpit.page
  const tabs = page.getByRole('tab')
  await cockpit.newTab('shell')
  await cockpit.newTab('shell')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press(`${MOD}+Shift+P`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox').fill('switch to recent tab')
  await palette.getByRole('option').first().click()
  // No Ctrl is held, so nothing is released: the overlay shows and stays until Enter.
  const switcher = page.getByRole('dialog', { name: 'Switch tab' })
  await expect(switcher).toBeVisible()
  await page.keyboard.press('a')
  await expect(switcher).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(switcher).toHaveCount(0)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
})
