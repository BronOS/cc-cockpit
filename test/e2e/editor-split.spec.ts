// Page tabs and split groups together (design.md §3 "Split groups", §4 "Page tabs"): a page tab is never
// a pane. Main refuses it in a placement, its tab menu has no split entries, a split chord on it says why
// and makes nothing, and its frame's fixed layer covers the whole split area while a group exists.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { PAGE_TAB_FRAME_NAME } from '../../src/shared/page-tabs'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { groupOfShells, groupsOf, place, splitArea, tabsOf, visiblePanes } from './split-fixtures'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const NATIVE_MOD = process.platform === 'darwin' ? 'meta' : 'control'

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === id)?.state, { timeout: 15_000 })
    .toBe('active')
}

/** The Files panel's Edit button for `name` (as editor.spec.ts does). */
async function editFromFiles(c: Cockpit, name: string): Promise<void> {
  await pluginActive(c, 'cockpit.files')
  const section = c.page.locator('section.panel[aria-label="Files"]')
  if (!(await section.isVisible())) await c.page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
  const tree = c.page.frameLocator('section.panel[aria-label="Files"] iframe')
  const row = tree.locator('.row', { has: tree.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
  await row.hover()
  await row.getByRole('button', { name: 'Edit' }).click()
}

/** A native chord into the window, which main's before-input-event sees first (editor.spec.ts nativeChord). */
async function nativeChord(c: Cockpit, keyCode: string, modifiers: Array<'control' | 'meta' | 'shift' | 'alt'>): Promise<void> {
  await c.app.evaluate(
    ({ BrowserWindow }, { keyCode, modifiers }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    { keyCode, modifiers }
  )
}

test('a page tab is never a split pane: refused by main, no split entries or chord, its frame covers the split area', async () => {
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
  try {
    const { page, projectDir } = c
    writeFileSync(join(projectDir, 'notes.txt'), 'one\ntwo\n')
    const [a, b] = await groupOfShells(c, ['pa', 'pb'])
    await pluginActive(c, 'cockpit.editor')
    await editFromFiles(c, 'notes.txt')
    const fileTab = page.getByRole('tab', { name: /notes\.txt/ })
    await expect(fileTab).toHaveAttribute('aria-selected', 'true')
    const frame = page.frameLocator('iframe.page-tab-frame:not([hidden])')
    await expect(frame.locator('.cm-content')).toContainText('two')
    const pageTab = (await tabsOf(page)).find((t) => t.kind === 'page')
    if (!pageTab) throw new Error('no page tab')

    // Main is the authority: a page tab is refused as the tab placed and as the anchor; nothing changes.
    const before = await groupsOf(page)
    expect(await place(page, pageTab.id, a, 'right')).toEqual({ ok: false, reason: 'not-a-pane' })
    expect(await place(page, b, pageTab.id, 'down')).toEqual({ ok: false, reason: 'not-a-pane' })
    expect((await groupsOf(page)).groups).toEqual(before.groups)

    // No pane is drawn for it, and its frame's fixed layer lies over the whole split area.
    await expect(page.locator(`[data-pane="${pageTab.id}"]`)).toHaveCount(0)
    await expect(visiblePanes(page)).toHaveCount(0)
    const area = await splitArea(page).boundingBox()
    const layer = await page.locator('.page-tab-layer').boundingBox()
    if (!area || !layer) throw new Error('no split area or page layer box')
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(layer[k] - area[k])).toBeLessThanOrEqual(1)

    // Its tab menu has no split entries (a terminal tab's has them).
    await fileTab.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Tab' })
    await expect(menu.getByRole('menuitem', { name: 'Close' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^Split (right|down)$/ })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /Show beside/ })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // Split Right typed in the file tab reaches the shell (an app chord) and says why nothing happens.
    const tabCount = (await tabsOf(page)).length
    await frame.locator('.cm-content').click()
    await page.keyboard.press(`${MOD}+Home`)
    await nativeChord(c, 'D', [NATIVE_MOD, 'shift'])
    await expect(page.getByRole('alert')).toContainText('terminal tabs only')
    await expect(page.getByRole('menu')).toHaveCount(0)
    expect((await tabsOf(page)).length).toBe(tabCount)
    expect(page.frame({ name: PAGE_TAB_FRAME_NAME })).toBeTruthy()

    // Back to the group: both panes drawn again, the page layer hidden.
    await page.locator('[data-group-handle]').click()
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(page.locator('.page-tab-layer')).toBeHidden()
    // And the file tab again: the layer comes back over the area as it is now (the error line above it
    // changed its height meanwhile, which the layer follows).
    await fileTab.click()
    await expect(page.locator('.page-tab-layer')).toBeVisible()
    await expect
      .poll(async () => {
        const [l, a] = [await page.locator('.page-tab-layer').boundingBox(), await splitArea(page).boundingBox()]
        if (!l || !a) return Infinity
        return Math.max(...(['x', 'y', 'width', 'height'] as const).map((k) => Math.abs(l[k] - a[k])))
      })
      .toBeLessThanOrEqual(1)
  } finally {
    await close()
  }
})
