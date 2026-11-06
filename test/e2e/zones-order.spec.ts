// Panel order inside a zone: the menus' Move up / down / to top, dragging icons in the strips
// (reorder, move to the other side zone, Escape, a click-sized press), and the order surviving a
// window reopen. Test panels come from the `pluginPanels` hook, three in the right zone.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { projectFile, projectId } from '../../src/main/paths'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'

const layout = (c: Cockpit): Promise<LayoutView> => c.hook<LayoutView>('layout', c.projectDir)
const order = async (c: Cockpit, zone: 'left' | 'right'): Promise<string[]> =>
  (await layout(c)).layout.zones[zone].panels.map((p) => p.panelKey.replace('t/', ''))
const icon = (page: Page, zone: string, title: string) =>
  page.locator(`.zone-${zone} .icon-strip`).getByRole('button', { name: new RegExp(`^${title}`) })

async function declare(c: Cockpit, page: Page = c.page, count = 3): Promise<void> {
  await c.hook('pluginPanels', c.projectDir, 't', [
    { id: 'a', title: 'Alpha', defaultZone: 'right' },
    { id: 'b', title: 'Beta', defaultZone: 'right' },
    { id: 'c', title: 'Gamma', defaultZone: 'right' }
  ])
  await expect(page.locator('.icon-strip .panel-icon[data-panel]')).toHaveCount(count)
}

/** Press on an icon, move in steps past the drag threshold to (x, y), optionally release. */
async function drag(page: Page, from: Locator, to: { x: number; y: number }, release = true): Promise<void> {
  const b = (await from.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 10 })
  if (release) await page.mouse.up()
}

test.beforeEach(async ({ cockpit }) => {
  await declare(cockpit)
  // Keep the real OS cursor off the window (see zones.spec.ts keepOsCursorOff).
  await cockpit.app.evaluate(({ BrowserWindow, screen }) => {
    const p = screen.getCursorScreenPoint()
    for (const w of BrowserWindow.getAllWindows()) {
      const b = w.getBounds()
      if (p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height) w.setPosition(p.x + 20, b.y)
    }
  })
})

test('Move up / down / to top in the icon menu and the header menu, disabled at the ends', async ({ cockpit }) => {
  const { page } = cockpit
  expect(await order(cockpit, 'right')).toEqual(['a', 'b', 'c'])

  await icon(page, 'right', 'Alpha').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Move to top' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeEnabled()
  await page.getByRole('menuitem', { name: 'Move down' }).click()
  await expect.poll(() => order(cockpit, 'right')).toEqual(['b', 'a', 'c'])

  await icon(page, 'right', 'Gamma').click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Move down' })).toBeDisabled()
  await page.getByRole('menuitem', { name: 'Move up' }).click()
  await expect.poll(() => order(cockpit, 'right')).toEqual(['b', 'c', 'a'])

  // The header's "…" opens the same menu: open Alpha, then send it to the top from there.
  await icon(page, 'right', 'Alpha').click()
  await page.getByRole('button', { name: 'Move or hide Alpha' }).click()
  await page.getByRole('menuitem', { name: 'Move to top' }).click()
  await expect.poll(() => order(cockpit, 'right')).toEqual(['a', 'b', 'c'])
  // The strip shows the same order.
  await expect(page.locator('.zone-right .icon-strip .panel-icon[data-panel]')).toHaveText(['A', 'B', 'G'])
})

test('drag icons to reorder, Escape cancels, a click still toggles, order survives a reopen', async ({ cockpit }) => {
  const { page } = cockpit
  const alpha = icon(page, 'right', 'Alpha')
  const gamma = icon(page, 'right', 'Gamma')

  // A press that moves under the threshold is a click: it toggles the panel, nothing moves.
  const ab = (await alpha.boundingBox())!
  await page.mouse.move(ab.x + 10, ab.y + 10)
  await page.mouse.down()
  await page.mouse.move(ab.x + 12, ab.y + 10)
  await page.mouse.up()
  await expect(alpha).toHaveAttribute('aria-pressed', 'true')
  await alpha.click()
  expect(await order(cockpit, 'right')).toEqual(['a', 'b', 'c'])

  // Escape during a drag: the line goes, nothing is saved.
  const gb = (await gamma.boundingBox())!
  await drag(page, gamma, { x: ab.x + 10, y: ab.y - 4 }, false)
  await expect(page.locator('.panel-drop-line')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.panel-drop-line')).toHaveCount(0)
  expect(await order(cockpit, 'right')).toEqual(['a', 'b', 'c'])
  await expect(gamma).toHaveAttribute('aria-pressed', 'false')

  // Gamma above Alpha.
  await drag(page, gamma, { x: ab.x + 10, y: ab.y + 2 })
  await expect.poll(() => order(cockpit, 'right')).toEqual(['c', 'a', 'b'])
  await expect(gamma).toHaveAttribute('aria-pressed', 'false')
  void gb

  // Beta onto the left strip: it moves there.
  const left = (await page.locator('.zone-left .icon-strip').boundingBox())!
  await drag(page, icon(page, 'right', 'Beta'), { x: left.x + left.width / 2, y: left.y + 30 })
  await expect.poll(() => order(cockpit, 'left')).toEqual(['b'])
  expect(await order(cockpit, 'right')).toEqual(['c', 'a'])

  // Alpha to the left strip too, above Beta (the strip's first slot).
  await drag(page, icon(page, 'right', 'Alpha'), { x: left.x + left.width / 2, y: left.y + 2 })
  await expect.poll(() => order(cockpit, 'left')).toEqual(['a', 'b'])

  // Reopen the window: same order, from the project file.
  const otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-order-b-')))
  try {
    const before = (await layout(cockpit)).layout
    await cockpit.hook('openProject', otherDir)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const pageB = cockpit.app.windows().find((p) => p !== page)!
    await page.close()
    await expect.poll(() => cockpit.app.windows().length).toBe(1)
    const file = projectFile(cockpit.dataDir, projectId(cockpit.projectDir))
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).layout).toEqual(before)
    await cockpit.hook('openProject', cockpit.projectDir)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const reopened = cockpit.app.windows().find((p) => p !== pageB)!
    await reopened.locator('.tabs-pane').waitFor()
    await declare(cockpit, reopened, 3)
    await expect(reopened.locator('.zone-left .icon-strip .panel-icon[data-panel]')).toHaveText(['A', 'B'])
    await expect(reopened.locator('.zone-right .icon-strip .panel-icon[data-panel]')).toHaveText(['G'])
    expect((await layout(cockpit)).layout.zones.left.panels.map((p) => p.panelKey)).toEqual(['t/a', 't/b'])
  } finally {
    rmSync(otherDir, { recursive: true, force: true })
  }
})
