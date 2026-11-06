// Tab flags (design.md §3 "Tab flags"): the person flags a tab from its right-click menu, with a
// colour and a note; the tab shows a stripe with the note as its tooltip, the Ctrl+Tab switcher and
// All tabs show colour and note (flagged first), a flagged tab scrolled out of a crowded strip
// leaves its colour at the edge, Clear flag and the Toggle Tab Flag chord work, the flag survives a
// relaunch, a flagged Claude tab that finishes in the background pulses until selected, and a plugin
// can read the flag but never set it.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

function savedFlags(c: Cockpit): unknown[] {
  const dir = join(c.dataDir, 'projects')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const file of names) {
    if (!/^[0-9a-f]{16}\.json$/.test(file)) continue
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { path: string; tabs: Array<{ flag?: unknown }> }
    if (record.path === c.projectDir) return record.tabs.map((t) => t.flag ?? null)
  }
  return []
}

/** The stripe of the tab at `index`: its ::after box and colour, and the colour its token resolves to. */
function stripe(page: Page, index: number): Promise<{ content: string; height: string; color: string; token: string }> {
  return page.evaluate((i) => {
    const tab = document.querySelectorAll<HTMLElement>('.tab')[i]!
    const after = getComputedStyle(tab, '::after')
    const probe = document.createElement('span')
    probe.style.color = `var(--cc-flag-${tab.dataset.flag ?? 'none'})`
    document.body.appendChild(probe)
    const token = getComputedStyle(probe).color
    probe.remove()
    return { content: after.content, height: after.height, color: after.backgroundColor, token }
  }, index)
}

async function flagFromMenu(page: Page, index: number, color: string, note?: string): Promise<void> {
  await page.getByRole('tab').nth(index).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Tab', exact: true })
  await menu.getByRole('menuitemradio', { name: `Flag ${color}` }).click()
  if (note === undefined) return
  await page.getByRole('tab').nth(index).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Tab', exact: true }).getByRole('menuitem', { name: 'Edit note…' }).click()
  const input = page.getByRole('dialog', { name: 'Flag note' }).getByRole('textbox', { name: 'Note' })
  await input.fill(note)
  await input.press('Enter')
}

test('flag a tab red with a note: stripe, tooltip, switcher, All tabs, crowded strip, clear, the chord, a relaunch', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    const { page } = c
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.newTab('shell')
    await expect(page.getByRole('tab')).toHaveCount(2)

    // The menu is keyboard-ready: it opens with its first entry focused, arrows walk it.
    await page.getByRole('tab').nth(0).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Tab', exact: true })
    await expect(menu.getByRole('menuitem', { name: 'Move right' })).toBeFocused()
    await expect(menu.getByRole('menuitemradio')).toHaveCount(6)
    await expect(menu.getByRole('menuitem', { name: 'Clear flag' })).toBeDisabled()
    await page.keyboard.press('Escape')

    await flagFromMenu(page, 0, 'Red', 'Review the plan')
    const tab0 = page.locator('.tab').nth(0)
    await expect(tab0).toHaveAttribute('data-flag', 'red')
    const s = await stripe(page, 0)
    expect(s.content).not.toBe('none')
    expect(s.height).toBe('3px')
    expect(s.color).toBe(s.token)
    await expect(page.getByRole('tab').nth(0)).toHaveAttribute('title', /^Review the plan\n/)
    await expect.poll(() => savedFlags(c)).toEqual([{ color: 'red', note: 'Review the plan' }, null])
    // Back in the terminal once the editor is gone: the menu does not strand the keyboard.
    await expect(page.locator('.terminal-view:not([hidden]) .xterm-helper-textarea')).toBeFocused()

    // The switcher (from the palette it opens and waits): the flagged row has its colour and note.
    await page.keyboard.press(`${MOD}+Shift+P`)
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.getByRole('combobox').fill('switch to recent tab')
    await palette.getByRole('option').first().click()
    const switcher = page.getByRole('dialog', { name: 'Switch tab' })
    await expect(switcher).toBeVisible()
    const row = switcher.locator('li[data-flag="red"]')
    await expect(row).toHaveCount(1)
    await expect(row.locator('.switcher-flag-note')).toHaveText('Review the plan')
    await expect(row.locator('.flag-swatch')).toHaveAttribute('data-flag', 'red')
    await page.keyboard.press('Escape')
    await expect(switcher).toHaveCount(0)

    // A crowded strip: the newest tab is in view, the flagged first tab scrolled out of it. Its
    // colour shows at the start edge and on the All tabs button, and All tabs lists it first.
    for (let i = 0; i < 14; i++) await c.newTab('shell')
    await expect(page.getByRole('tab')).toHaveCount(16)
    await expect(page.locator('.tab-flag-hint[data-side="start"]')).toHaveAttribute('data-flag', 'red')
    const all = page.getByRole('button', { name: 'All tabs' })
    await expect(all).toHaveAttribute('data-flag', 'red')
    // A flagged tab keeps a readable width while the others shrink.
    const widths = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.getBoundingClientRect().width))
    expect(widths[0]).toBeGreaterThanOrEqual(150)
    await all.click()
    const allMenu = page.getByRole('menu', { name: 'All tabs' })
    const firstItem = allMenu.getByRole('menuitem').first()
    await expect(firstItem).toHaveAttribute('data-flag', 'red')
    await expect(firstItem.locator('.menu-flag-note')).toHaveText('Review the plan')
    await firstItem.click()
    await expect(page.getByRole('tab').nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.tab-flag-hint')).toHaveCount(0)

    // Clear flag: everything goes, the record too.
    await flagFromMenu(page, 1, 'Blue')
    await page.getByRole('tab').nth(0).click({ button: 'right' })
    await page.getByRole('menu', { name: 'Tab', exact: true }).getByRole('menuitem', { name: 'Clear flag' }).click()
    await expect(page.locator('.tab').nth(0)).not.toHaveAttribute('data-flag', /.*/)
    await expect(page.getByRole('tab').nth(0)).not.toHaveAttribute('title', /Review the plan/)
    await expect.poll(() => savedFlags(c)[0]).toBeNull()

    // The chord flags the current tab with the last colour picked (blue), and clears it again.
    await page.getByRole('tab').nth(0).click()
    await page.keyboard.press(`${MOD}+Shift+F`)
    await expect(page.locator('.tab').nth(0)).toHaveAttribute('data-flag', 'blue')
    await page.keyboard.press(`${MOD}+Shift+F`)
    await expect(page.locator('.tab').nth(0)).not.toHaveAttribute('data-flag', /.*/)
    await page.keyboard.press(`${MOD}+Shift+F`)
    await expect.poll(() => savedFlags(c).slice(0, 2)).toEqual([{ color: 'blue' }, { color: 'blue' }])
  } finally {
    await first.close({ keepFiles: true })
  }

  // A relaunch brings the flags back with the tabs.
  const second = await launchCockpit({ root, folderArg: false })
  try {
    const { page } = second.cockpit
    await expect(page.getByRole('tab')).toHaveCount(16)
    await expect(page.locator('.tab').nth(0)).toHaveAttribute('data-flag', 'blue')
    await expect(page.locator('.tab').nth(1)).toHaveAttribute('data-flag', 'blue')
    await expect(page.locator('.tab[data-flag]')).toHaveCount(2)
  } finally {
    await second.close()
  }
})

test('a flagged Claude tab that finishes while another tab is shown pulses until it is selected', async ({ cockpit: c }) => {
  const { page } = c
  await c.newTab('claude')
  await c.waitForTerminalText('FAKE-CLAUDE banner')
  await expect.poll(async () => (await c.hook<Array<{ status: string }>>('sessions', c.projectDir))[0]?.status, { timeout: 15_000 }).toBe('waiting')
  await flagFromMenu(page, 0, 'Purple')
  // A turn starts, and ends a moment later while the person is in a shell tab.
  await c.typeLine('/prompt go')
  await c.waitForTerminalText('FAKE-CLAUDE hook UserPromptSubmit')
  await c.typeLine('/later 1500 /stop')
  await c.newTab('shell')
  await expect(page.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')
  const claudeTab = page.locator('.tab').nth(0)
  await expect(claudeTab).not.toHaveAttribute('data-attention', /.*/)
  await expect(claudeTab).toHaveAttribute('data-attention', 'true', { timeout: 10_000 })
  const animation = await page.evaluate(() => getComputedStyle(document.querySelector('.tab[data-attention]')!, '::after').animationName)
  expect(animation).toBe('cc-flag-pulse')
  await page.getByRole('tab').nth(0).click()
  await expect(claudeTab).not.toHaveAttribute('data-attention', /.*/)
})

test('a plugin reads the person\'s flag and has no way to set it', async ({ cockpit: c }) => {
  const { page } = c
  await c.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'flag-reader'))
  await c.hook('enablePlugin', c.projectDir, 'test.flagreader')
  await expect
    .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.flagreader', state: 'active' }] })
  await c.newTab('claude')
  await c.waitForTerminalText('FAKE-CLAUDE banner')
  await flagFromMenu(page, 0, 'Red', 'Mine')

  const file = join(c.root, 'home', 'flag-reader.json')
  const seen = (): { list?: unknown[]; changes: unknown[][]; writers?: string[]; after?: unknown[] } =>
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { changes: [] }
  await c.hook('runPluginCommand', c.projectDir, 'test.flagreader/read')
  await expect.poll(() => seen().list).toEqual([{ color: 'red', note: 'Mine' }])
  // The change reached onChange like any other SessionInfo field.
  await expect.poll(() => seen().changes.at(-1)).toEqual([{ color: 'red', note: 'Mine' }])

  await c.hook('runPluginCommand', c.projectDir, 'test.flagreader/tryWrite')
  await expect.poll(() => seen().after).toEqual([{ color: 'red', note: 'Mine' }])
  expect(seen().writers).toEqual([])
  await expect(page.locator('.tab').nth(0)).toHaveAttribute('data-flag', 'red')
  await expect(page.getByRole('tab').nth(0)).toHaveAttribute('title', /^Mine\n/)
})
