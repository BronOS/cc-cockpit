// New-tab menu entries that open as an overlay (design §3 Custom commands): an entry set to
// "Overlay" in Settings runs its command line in the login shell (test/fixtures/bin/fake-shell) in a
// terminal overlay over the tabs instead of a tab. The program gets Esc (a full-screen TUI needs
// it), the overlay fills the window and the PTY follows its size, and it closes when the program
// exits or on Cmd+Shift+W. A tab entry next to it still opens a tab.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { OverlayInfo, TabInfo } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'

// Cmd on macOS, Ctrl elsewhere (the default table maps Cmd to Ctrl on Linux).
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// A tiny TUI stand-in: no echo, no line buffering, then one line per byte read, in hex (`GOT-1b`
// for Esc). `s` prints the terminal size the program sees, `q` quits with 0. `$((...))` proves a
// shell parsed it; runs.log (in the project folder, the cwd) proves where it ran.
const OVERLAY_COMMAND = [
  'echo ran >> runs.log',
  "printf 'OVL-MARKER-%s\\n' $((6 * 7))",
  'stty -icanon -echo min 1',
  'while :; do b=$(dd bs=1 count=1 2>/dev/null | od -An -tx1 | tr -d " \\n"); echo "GOT-$b"; ' +
    'case $b in 73) echo "SIZE-$(stty size | tr " " x)-END";; 71) exit 0;; esac; done'
].join('; ')
const TAB_COMMAND = 'echo "TAB-MARKER-$((7 * 6))"; sleep 600'

const runs = (c: Cockpit): number => {
  const file = join(c.projectDir, 'runs.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

async function addEntry(page: Page, level: 'app' | 'project', label: string, command: string, open: 'tab' | 'overlay'): Promise<void> {
  const editor = page.locator(`.tab-commands[data-level="${level}"]`)
  await editor.getByPlaceholder('Label').fill(label)
  await editor.getByPlaceholder(/^Command line/).fill(command)
  await editor.getByRole('combobox', { name: /^New .* opens as$/ }).selectOption(open)
  await editor.getByRole('button', { name: 'Add' }).click()
  await expect(editor.getByRole('textbox', { name: /^Label of command/ }).last()).toHaveValue(label)
}

/** The rows-x-cols the program last printed for `s`. */
async function lastSize(overlay: ReturnType<Page['locator']>): Promise<{ rows: number; cols: number } | undefined> {
  const text = (await overlay.locator('.xterm-rows').innerText()).replaceAll('\n', '')
  const all = [...text.matchAll(/SIZE-(\d+)x(\d+)-END/g)]
  const m = all.at(-1)
  return m ? { rows: Number(m[1]), cols: Number(m[2]) } : undefined
}

test('an overlay entry opens a full-window terminal overlay, not a tab: Esc reaches the program, exit and Cmd+Shift+W close it', async ({
  cockpit: c
}) => {
  const { page } = c
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'This project' }).click()
  await addEntry(page, 'project', 'Lazy', OVERLAY_COMMAND, 'overlay')
  await addEntry(page, 'project', 'Tabbed', TAB_COMMAND, 'tab')
  // Stored with `open` only on the overlay entry; the row's select shows it.
  const editor = page.locator('.tab-commands[data-level="project"]')
  await expect(editor.getByRole('combobox', { name: 'Command 1 opens as' })).toHaveValue('overlay')
  await expect(editor.getByRole('combobox', { name: 'Command 2 opens as' })).toHaveValue('tab')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toHaveCount(0)

  // The menu marks each entry with where it opens (an icon left of the label); the accessible
  // name stays the label.
  await page.getByRole('button', { name: 'New tab' }).click()
  const menu = page.getByRole('menu')
  const lazy = menu.getByRole('menuitem', { name: 'Lazy', exact: true })
  await expect(lazy.locator('.menu-icon')).toHaveAttribute('data-open', 'overlay')
  await expect(menu.getByRole('menuitem', { name: 'Tabbed', exact: true }).locator('.menu-icon')).toHaveAttribute(
    'data-open',
    'tab'
  )
  await expect(menu.getByRole('menuitem', { name: /^Claude/ }).locator('.menu-icon')).toHaveAttribute('data-open', 'tab')
  await lazy.click()

  // An overlay titled by the label, running the command in the project folder; no tab.
  const overlay = page.getByRole('dialog', { name: 'Lazy' })
  await expect(overlay).toHaveAttribute('data-kind', 'terminal')
  await expect(overlay.locator('.xterm-rows')).toContainText('OVL-MARKER-42')
  await expect(overlay.locator('.xterm-helper-textarea')).toBeFocused()
  expect(runs(c)).toBe(1)
  expect(await c.hook<TabInfo[]>('tabs', c.projectDir)).toEqual([])
  await expect(page.getByRole('tab')).toHaveCount(0)

  // Large: it covers the window, and the program sees the size xterm fitted (not the PTY's 80x24).
  // On macOS it starts under the in-page title bar (40px), which stays the window's own.
  const box = await overlay.boundingBox()
  const viewport = await page.evaluate(() => {
    const w = globalThis as unknown as { innerWidth: number; innerHeight: number }
    return { width: w.innerWidth, height: w.innerHeight }
  })
  const top = process.platform === 'darwin' ? 40 : 0
  expect(box).toEqual({ x: 0, y: top, width: viewport.width, height: viewport.height - top })
  await page.keyboard.press('s')
  await expect.poll(() => lastSize(overlay)).toEqual({ rows: expect.any(Number), cols: expect.any(Number) })
  const before = (await lastSize(overlay))!
  expect(before.cols).toBeGreaterThan(100)
  expect(before.rows).toBeGreaterThan(30)
  // ... and follows the window.
  await c.app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const [w, h] = win.getSize()
    win.setSize(w! - 300, h! - 200)
  })
  await expect
    .poll(async () => {
      await page.keyboard.press('s')
      return (await lastSize(overlay))?.cols
    })
    .toBeLessThan(before.cols)

  // Esc is the program's: it reads the byte, the overlay stays.
  await page.keyboard.press('Escape')
  await expect(overlay.locator('.xterm-rows')).toContainText('GOT-1b')
  expect(await stack(c)).toHaveLength(1)

  // The program exits: the overlay goes with it, nothing left behind or saved as a tab.
  await page.keyboard.press('q')
  await expect(overlay).toHaveCount(0)
  expect(await stack(c)).toEqual([])
  await expect(page.getByRole('tab')).toHaveCount(0)

  // Again, from the palette (the entry's command, the path a key binding takes): Cmd+Shift+W.
  await page.keyboard.press('ControlOrMeta+Shift+P')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await palette.getByRole('combobox', { name: 'Command' }).fill('Overlay: Lazy')
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(overlay.locator('.xterm-rows')).toContainText('OVL-MARKER-42')
  expect(runs(c)).toBe(2)
  await page.keyboard.press(`${MOD}+Shift+KeyW`)
  await expect(overlay).toHaveCount(0)
  expect(await stack(c)).toEqual([])

  // The tab entry still opens a tab.
  await page.getByRole('button', { name: 'New tab' }).click()
  await menu.getByRole('menuitem', { name: 'Tabbed', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Tabbed' })).toHaveCount(1)
  await c.waitForTerminalText('TAB-MARKER-42')
  expect(await stack(c)).toEqual([])
})
