// Settings › Appearance and keys › Terminal (design §4 Terminal font): a change goes to the open
// terminal at once (xterm draws with it), the PTY learns the new cols x rows (the shell's own
// `stty size` says so), the pick is saved to app.json, and Reset brings the defaults back. The
// family is a dropdown (bundled fonts, installed fonts, Custom…); with nothing set the terminals
// draw with the bundled JetBrains Mono NF, which must really load in the built app (CSP, paths).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Cockpit } from './fixtures'

const rows = (c: Cockpit) => c.page.locator('.terminal-view:not([hidden]) .xterm-rows')

const DEFAULT_FAMILY = '"Cockpit JetBrains Mono NF", monospace'
const MESLO_FAMILY = '"Cockpit MesloLGS NF", monospace'

/** The PTY's size as the shell sees it, read through a fresh marker so an earlier answer never matches. */
async function ptySize(c: Cockpit, marker: string): Promise<{ rows: number; cols: number }> {
  // `$(...)` keeps the typed command line itself from matching `<marker>=<n> <n>.`
  await c.typeLine(`echo ${marker}=$(stty size).`)
  const pattern = new RegExp(`${marker}=(\\d+) (\\d+)\\.`)
  let match: RegExpMatchArray | null = null
  await expect
    .poll(async () => {
      match = (await c.terminalText()).match(pattern)
      return match !== null
    })
    .toBe(true)
  const [, r, cols] = match as unknown as [string, string, string]
  return { rows: Number(r), cols: Number(cols) }
}

const storedFont = (c: Cockpit): unknown =>
  (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { terminalFont?: unknown }).terminalFont

/**
 * Whether a bundled family's regular and bold faces have loaded. `fonts.check` is true for a
 * family no @font-face declares (nothing to load), so this is meaningful only for the bundled ones.
 */
const faceLoaded = (page: Page, family: string): Promise<boolean> =>
  page.evaluate((f) => document.fonts.check(`13px "${f}"`) && document.fonts.check(`bold 13px "${f}"`), family)

async function openAppearance(c: Cockpit) {
  await c.page.keyboard.press('ControlOrMeta+,')
  const settings = c.page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance and keys' }).click()
  return settings
}

test('size and family apply to the open terminal and resize its PTY; Reset restores the defaults', async ({ cockpit: c }) => {
  const { page } = c
  await c.newTab('shell')
  await c.waitForTerminalText('FAKE-SHELL ready')
  // The defaults: the bundled JetBrains Mono NF, loaded (the terminal waited for it).
  await expect(rows(c)).toHaveCSS('font-size', '13px')
  await expect(rows(c)).toHaveCSS('font-family', DEFAULT_FAMILY)
  expect(await faceLoaded(page, 'Cockpit JetBrains Mono NF')).toBe(true)
  const before = await ptySize(c, 'SZA')

  const settings = await openAppearance(c)
  const size = settings.getByRole('spinbutton', { name: 'Terminal font size' })
  const family = settings.getByRole('combobox', { name: 'Terminal font family' })
  await expect(size).toHaveValue('13')
  await expect(family).toHaveValue('JetBrains Mono Nerd Font')
  // The default is no Custom… value: its field is not shown.
  await expect(settings.getByRole('textbox', { name: 'Custom terminal font family' })).toHaveCount(0)

  // A bigger cell: fewer cols and rows fit the same pane.
  await size.fill('20')
  await size.press('Enter')
  await expect.poll(() => (storedFont(c) as { size?: unknown } | undefined)?.size).toBe(20)
  // A family by hand: Custom… reveals the CSS font list field (focused), Enter saves it.
  await family.click()
  await page.getByRole('option', { name: 'Custom…' }).click()
  const custom = settings.getByRole('textbox', { name: 'Custom terminal font family' })
  await expect(custom).toBeFocused()
  await custom.fill('"Courier New", monospace')
  await custom.press('Enter')
  await expect.poll(() => (storedFont(c) as { family?: unknown } | undefined)?.family).toBe('"Courier New", monospace')
  await expect(family).toHaveValue('Custom')
  // The preview draws with it too.
  await expect(settings.getByTestId('terminal-font-preview')).toHaveCSS('font-size', '20px')

  // A refused value says why and changes nothing.
  await size.fill('99')
  await size.press('Enter')
  await expect(settings.getByRole('alert')).toContainText('from 6 to 72')
  expect((storedFont(c) as { size?: unknown }).size).toBe(20)

  // The fields are disabled while a save is in flight; when a frame paints in that window the
  // focused field is blurred to <body>, outside the screen, and Esc would not reach it (seen as
  // a flake in the full run). Put the keyboard back on the screen's field first.
  await size.focus()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(rows(c)).toHaveCSS('font-size', '20px')
  await expect(rows(c)).toHaveCSS('font-family', '"Courier New", monospace')
  const after = await ptySize(c, 'SZB')
  expect(after.cols).toBeLessThan(before.cols)
  expect(after.rows).toBeLessThan(before.rows)
  // What xterm draws is what the PTY was told: one DOM row per PTY row.
  await expect(rows(c).locator('> div')).toHaveCount(after.rows)

  // Reset: the defaults again, nothing left in app.json, and the PTY back at its first size.
  await openAppearance(c)
  await settings.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(size).toHaveValue('13')
  await expect(family).toHaveValue('JetBrains Mono Nerd Font')
  await expect(settings.getByRole('textbox', { name: 'Custom terminal font family' })).toHaveCount(0)
  await expect(settings.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled()
  await expect.poll(() => storedFont(c)).toBeUndefined()
  await page.keyboard.press('Escape')
  await expect(rows(c)).toHaveCSS('font-size', '13px')
  await expect(rows(c)).toHaveCSS('font-family', DEFAULT_FAMILY)
  expect(await ptySize(c, 'SZC')).toEqual(before)
})

test('the dropdown lists both bundled fonts; MesloLGS NF, picked from the keyboard, is stored and drawn', async ({ cockpit: c }) => {
  const { page } = c
  await c.newTab('shell')
  await c.waitForTerminalText('FAKE-SHELL ready')
  const settings = await openAppearance(c)
  const family = settings.getByRole('combobox', { name: 'Terminal font family' })
  await family.click()
  const list = page.getByRole('listbox', { name: 'Terminal fonts' })
  const bundled = list.getByRole('group', { name: 'Bundled' })
  await expect(bundled.getByRole('option')).toHaveText([/^JetBrains Mono Nerd Font/, /^MesloLGS NF/])
  // The font in use is the selected option; each name is drawn in its own face.
  await expect(bundled.getByRole('option', { name: 'JetBrains Mono Nerd Font' })).toHaveAttribute('aria-selected', 'true')
  await expect(bundled.getByRole('option', { name: 'MesloLGS NF' }).locator('.font-picker-name')).toHaveCSS(
    'font-family',
    MESLO_FAMILY
  )
  await expect(list.getByRole('option', { name: 'Custom…' })).toBeVisible()

  // Esc closes the list only; a second Esc is the Settings screen's.
  await family.press('Escape')
  await expect(list).toHaveCount(0)
  await expect(settings).toBeVisible()

  // Type to filter, then Enter picks the highlighted (first) match.
  await family.press('ArrowDown')
  await expect(list).toBeVisible()
  await page.keyboard.type('meslo')
  // Enabled options only: the Installed section's "Listing…" line (a disabled option) may still be there.
  await expect(list.getByRole('option', { disabled: false })).toHaveText([/^MesloLGS NF/, 'Custom…'])
  await family.press('Enter')
  await expect(list).toHaveCount(0)
  await expect.poll(() => (storedFont(c) as { family?: unknown } | undefined)?.family).toBe(MESLO_FAMILY)
  await expect(family).toHaveValue('MesloLGS NF')

  await settings.getByRole('spinbutton', { name: 'Terminal font size' }).focus()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await expect(rows(c)).toHaveCSS('font-family', MESLO_FAMILY)
  await expect.poll(() => faceLoaded(page, 'Cockpit MesloLGS NF')).toBe(true)
})

test('the installed monospaced fonts are listed in the dropdown (the shell page may ask)', async ({ cockpit: c }) => {
  test.skip(process.platform !== 'darwin', 'Menlo is the known monospaced font of macOS')
  const { page } = c
  const settings = await openAppearance(c)
  // The click that opens the list is the user activation queryLocalFonts needs.
  await settings.getByRole('combobox', { name: 'Terminal font family' }).click()
  const installed = page.getByRole('listbox', { name: 'Terminal fonts' }).getByRole('group', { name: 'Installed' })
  // Granted by main's permission handler to this page only: a refusal would say "cannot be listed".
  await expect(installed.getByRole('option', { name: 'Menlo', exact: true })).toBeVisible({ timeout: 15_000 })
  // Proportional families are left out.
  await expect(installed.getByRole('option', { name: 'Helvetica', exact: true })).toHaveCount(0)
  await expect(installed).not.toContainText('cannot be listed')
})
