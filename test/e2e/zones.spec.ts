// Task 18: zones. Panels in the left / right / bottom zones, their icon strips and menus, the
// collapse keys, draggable splitters, badges, and a layout that survives closing the window.
// Only the core Sessions panel `core/sessions` (default zone right) exists by default; a second panel is declared
// through the `pluginPanels` test hook, the way Task 25 will declare a plugin's.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { projectFile, projectId } from '../../src/main/paths'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'

// Cmd on macOS, Ctrl elsewhere (the default table maps Cmd to Ctrl on Linux).
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const sessionsIcon = (page: Page, zone: string) =>
  page.locator(`.zone-${zone}`).getByRole('button', { name: /^Sessions/ })
const sessionsPanel = (page: Page, zone: string) =>
  page.locator(`.zone-${zone} section.panel[aria-label="Sessions"]`)

const layout = (c: Cockpit): Promise<LayoutView> => c.hook<LayoutView>('layout', c.projectDir)

/**
 * Move every window off the real OS cursor before a mouse drag. A cursor resting over the window
 * sends buttonless moves now and then (seen as lostpointercapture at a fractional clientY the test
 * never used), which drops the splitter's capture and cuts a synthetic drag short at random.
 */
async function keepOsCursorOff(c: Cockpit): Promise<void> {
  await c.app.evaluate(({ BrowserWindow, screen }) => {
    const p = screen.getCursorScreenPoint()
    for (const w of BrowserWindow.getAllWindows()) {
      const b = w.getBounds()
      const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      // Partly off screen is fine: layout and the test's coordinates do not depend on it.
      if (over) w.setPosition(p.x + 20, b.y)
    }
  })
}

async function moveTo(page: Page, from: string, to: string): Promise<void> {
  await sessionsIcon(page, from).click({ button: 'right' })
  await page.getByRole('menuitem', { name: `Move to ${to}` }).click()
}

test('the Sessions panel starts closed in the right strip; a click opens and closes it', async ({
  cockpit
}) => {
  const { page } = cockpit
  await expect(sessionsIcon(page, 'right')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('section.panel')).toHaveCount(0)

  await sessionsIcon(page, 'right').click()
  await expect(sessionsPanel(page, 'right')).toBeVisible()
  await expect(sessionsIcon(page, 'right')).toHaveAttribute('aria-pressed', 'true')

  await sessionsIcon(page, 'right').click()
  await expect(page.locator('section.panel')).toHaveCount(0)
})

test('move a panel to the bottom zone, hide and unhide it, collapse a zone, reopen the window', async ({
  cockpit
}) => {
  const { page } = cockpit
  // Sessions starts in the right zone (Task 20); these tests were written for the left one.
  await moveTo(page, 'right', 'left')
  // A second project window keeps the app on a project window while the first one is closed.
  const otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-zones-b-')))
  try {
    // A shell tab must survive every layout change below: the terminal is never remounted.
    await cockpit.newTab('shell')
    await cockpit.waitForTerminalText('FAKE-SHELL ready')

    await sessionsIcon(page, 'left').click()
    await expect(sessionsPanel(page, 'left')).toBeVisible()

    // Move: the right-click menu offers the other two zones and Hide, not the current zone.
    await sessionsIcon(page, 'left').click({ button: 'right' })
    await expect(page.getByRole('menuitem')).toHaveText(['Move to right', 'Move to bottom', 'Hide'])
    await page.getByRole('menuitem', { name: 'Move to bottom' }).click()
    await expect(sessionsPanel(page, 'bottom')).toBeVisible()
    await expect(sessionsIcon(page, 'left')).toHaveCount(0)
    await expect(sessionsIcon(page, 'bottom')).toHaveAttribute('aria-pressed', 'true')
    expect((await layout(cockpit)).layout.zones.bottom.panels.map((p) => p.panelKey)).toEqual([
      'core/sessions'
    ])

    // Hide: gone from the strip and the area, listed under "..." of a strip.
    await sessionsIcon(page, 'bottom').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Hide' }).click()
    await expect(page.locator('section.panel')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Sessions/ })).toHaveCount(0)
    expect((await layout(cockpit)).layout.hidden).toEqual(['core/sessions'])

    // Unhide from the "..." of the LEFT strip: it returns where it was (bottom), still open.
    await page.locator('.zone-left').getByRole('button', { name: 'Hidden panels' }).click()
    await page.getByRole('menuitem', { name: 'Sessions' }).click()
    await expect(sessionsPanel(page, 'bottom')).toBeVisible()
    expect((await layout(cockpit)).layout.hidden).toEqual([])

    // "..." with nothing hidden says so.
    await page.locator('.zone-right').getByRole('button', { name: 'Hidden panels' }).click()
    await expect(page.getByText('No hidden panels')).toBeVisible()
    await page.keyboard.press('Escape')

    // Collapse the bottom zone with its key: the area goes, the strip stays, the terminal grows.
    await page.keyboard.press(`${MOD}+j`)
    await expect(sessionsPanel(page, 'bottom')).toHaveCount(0)
    await expect(sessionsIcon(page, 'bottom')).toBeVisible()
    await expect.poll(async () => (await layout(cockpit)).layout.zones.bottom.collapsed).toBe(true)

    // The terminal is the same one: its banner is still on screen.
    await cockpit.waitForTerminalText('FAKE-SHELL ready')

    // Close window A and open the same folder again: same layout.
    const before = (await layout(cockpit)).layout
    await cockpit.hook('openProject', otherDir)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const pageB = cockpit.app.windows().find((p) => p !== page)!
    await page.close()
    await expect.poll(() => cockpit.app.windows().length).toBe(1)
    // The registry keeps the record cached after the window closes, so reopening alone would pass
    // without a write: check the project file itself (the debounced write lands within ~300ms).
    const file = projectFile(cockpit.dataDir, projectId(cockpit.projectDir))
    await expect.poll(() => JSON.parse(readFileSync(file, 'utf8')).layout).toEqual(before)
    await cockpit.hook('openProject', cockpit.projectDir)
    await expect.poll(() => cockpit.app.windows().length).toBe(2)
    const reopened = cockpit.app.windows().find((p) => p !== pageB)!
    await reopened.locator('.tabs-pane').waitFor()

    // The same layout: the bottom zone is collapsed, its strip shows the panel, and the key
    // expands it again with the panel still open.
    await expect(sessionsIcon(reopened, 'bottom')).toHaveAttribute('aria-pressed', 'true')
    await expect(sessionsPanel(reopened, 'bottom')).toHaveCount(0)
    expect((await layout(cockpit)).layout).toEqual(before)
    await reopened.keyboard.press(`${MOD}+j`)
    await expect(sessionsPanel(reopened, 'bottom')).toBeVisible()
  } finally {
    rmSync(otherDir, { recursive: true, force: true })
  }
})

test('Cmd+B, Cmd+J and Cmd+Shift+B collapse and expand their zones through the command registry', async ({
  cockpit
}) => {
  const { page } = cockpit
  // Sessions starts in the right zone (Task 20); these tests were written for the left one.
  await moveTo(page, 'right', 'left')
  await sessionsIcon(page, 'left').click()
  await expect(sessionsPanel(page, 'left')).toBeVisible()

  await page.keyboard.press(`${MOD}+b`)
  await expect(sessionsPanel(page, 'left')).toHaveCount(0)
  await expect(page.locator('.zone-left')).toHaveClass(/collapsed/)
  await page.keyboard.press(`${MOD}+b`)
  await expect(sessionsPanel(page, 'left')).toBeVisible()

  // Right and bottom zones toggle their own collapsed flag.
  await page.keyboard.press(`${MOD}+Shift+b`)
  await expect.poll(async () => (await layout(cockpit)).layout.zones.right.collapsed).toBe(true)
  await expect(page.locator('.zone-right')).toHaveClass(/collapsed/)
  await page.keyboard.press(`${MOD}+Shift+b`)
  await expect.poll(async () => (await layout(cockpit)).layout.zones.right.collapsed).toBe(false)
  await page.keyboard.press(`${MOD}+j`)
  await expect.poll(async () => (await layout(cockpit)).layout.zones.bottom.collapsed).toBe(true)
  // A collapsed bottom strip says what it is, with the key that opens it.
  await expect(page.locator('.zone-bottom .zone-caption')).toHaveText(/^Bottom zone collapsed/)

  // Clicking an icon in a collapsed zone expands it and shows the panel.
  await page.keyboard.press(`${MOD}+b`)
  await expect(sessionsPanel(page, 'left')).toHaveCount(0)
  await sessionsIcon(page, 'left').click()
  await expect(sessionsPanel(page, 'left')).toBeVisible()
  await expect(page.locator('.zone-left')).not.toHaveClass(/collapsed/)
})

test('panels stack with a draggable splitter, and zone and panel sizes are saved', async ({
  cockpit
}) => {
  const { page } = cockpit
  // Sessions starts in the right zone (Task 20); these tests were written for the left one.
  await moveTo(page, 'right', 'left')
  await keepOsCursorOff(cockpit)
  await cockpit.hook('pluginPanels', cockpit.projectDir, 'test', [
    { id: 'notes', title: 'Notes', defaultZone: 'left' }
  ])
  const notesIcon = page.locator('.zone-left').getByRole('button', { name: /^Notes/ })
  await expect(notesIcon).toBeVisible()
  await sessionsIcon(page, 'left').click()
  await notesIcon.click()
  const sessions = sessionsPanel(page, 'left')
  const notes = page.locator('.zone-left section.panel[aria-label="Notes"]')
  await expect(sessions).toBeVisible()
  await expect(notes).toBeVisible()

  // Left zone: stacked vertically, Sessions above Notes.
  const a = (await sessions.boundingBox())!
  const b = (await notes.boundingBox())!
  expect(b.y).toBeGreaterThan(a.y)
  expect(Math.abs(a.x - b.x)).toBeLessThan(1)

  // Drag the splitter between them down by 60px: Sessions grows by 60.
  const splitter = page.getByRole('separator', { name: 'Resize Sessions' })
  const s = (await splitter.boundingBox())!
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 30, { steps: 3 })
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2 + 60, { steps: 3 })
  await page.mouse.up()
  await expect.poll(async () => (await sessions.boundingBox())!.height).toBeGreaterThan(a.height + 50)
  const stored = (await layout(cockpit)).layout.zones.left
  expect(stored.panels.find((p) => p.panelKey === 'core/sessions')!.size).toBeGreaterThan(280)

  // Drag the zone edge 50px to the right: the left zone gets wider and the size is saved.
  const widthBefore = (await page.locator('.zone-left .panel-area').boundingBox())!.width
  const edge = page.getByRole('separator', { name: 'Resize left zone' })
  const eb = (await edge.boundingBox())!
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2)
  await page.mouse.down()
  await page.mouse.move(eb.x + eb.width / 2 + 50, eb.y + eb.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await page.locator('.zone-left .panel-area').boundingBox())!.width)
    .toBeGreaterThan(widthBefore + 40)
  await expect.poll(async () => (await layout(cockpit)).layout.zones.left.size).toBeGreaterThan(320)

  // The splitter also answers the keyboard.
  const sizeBefore = (await layout(cockpit)).layout.zones.left.size
  await edge.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await layout(cockpit)).layout.zones.left.size).toBe(sizeBefore - 16)

  // Bottom zone: the same two panels sit side by side.
  await moveTo(page, 'left', 'bottom')
  await page.locator('.zone-left').getByRole('button', { name: /^Notes/ }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Move to bottom' }).click()
  const sb = (await page.locator('.zone-bottom section.panel[aria-label="Sessions"]').boundingBox())!
  const nb = (await page.locator('.zone-bottom section.panel[aria-label="Notes"]').boundingBox())!
  expect(nb.x).toBeGreaterThan(sb.x)
  expect(Math.abs(nb.y - sb.y)).toBeLessThan(1)
})

test('badges (count, dot) and a plugin error warning show on the icon', async ({ cockpit }) => {
  const { page } = cockpit
  // Sessions starts in the right zone (Task 20); these tests were written for the left one.
  await moveTo(page, 'right', 'left')
  const icon = sessionsIcon(page, 'left')

  await cockpit.hook('panelStatus', cockpit.projectDir, 'core/sessions', {
    badge: { kind: 'count', count: 3 }
  })
  await expect(icon.locator('.panel-badge')).toHaveText('3')
  await expect(icon).toHaveAccessibleName('Sessions, 3 new')

  await cockpit.hook('panelStatus', cockpit.projectDir, 'core/sessions', { badge: { kind: 'dot' } })
  await expect(icon.locator('.panel-badge-dot')).toBeVisible()
  await expect(icon).toHaveAccessibleName('Sessions, needs you')

  await cockpit.hook('panelStatus', cockpit.projectDir, 'core/sessions', {
    error: 'jira: 401 unauthorized'
  })
  await expect(icon.locator('.panel-badge')).toHaveCount(0)
  await expect(icon.locator('.panel-error')).toHaveAttribute('title', 'jira: 401 unauthorized')
  await expect(icon).toHaveAccessibleName('Sessions, has an error')

  await cockpit.hook('panelStatus', cockpit.projectDir, 'core/sessions', null)
  await expect(icon.locator('.panel-error')).toHaveCount(0)
  await expect(icon).toHaveAccessibleName('Sessions')
})

test('a splitter or zone edge dragged far past the window keeps every panel and bar reachable', async ({
  cockpit
}) => {
  const { page } = cockpit
  // Sessions starts in the right zone (Task 20); these tests were written for the left one.
  await moveTo(page, 'right', 'left')
  await keepOsCursorOff(cockpit)
  await cockpit.hook('pluginPanels', cockpit.projectDir, 'test', [
    { id: 'notes', title: 'Notes', defaultZone: 'left' }
  ])
  const notesIcon = page.locator('.zone-left').getByRole('button', { name: /^Notes/ })
  await expect(notesIcon).toBeVisible()
  await sessionsIcon(page, 'left').click()
  await notesIcon.click()
  const notes = page.locator('.zone-left section.panel[aria-label="Notes"]')
  await expect(notes).toBeVisible()

  // Panel splitter: 2000px down, far past the window's bottom edge (pointer capture keeps the
  // moves coming). Notes keeps its MIN_SIZE (48) inside the zone and the bar stays on screen.
  const splitter = page.getByRole('separator', { name: 'Resize Sessions' })
  const s = (await splitter.boundingBox())!
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  await page.mouse.move(s.x + s.width / 2, s.y + 2000, { steps: 5 })
  await page.mouse.up()
  const stack = (await page.locator('.zone-left .panel-stack').boundingBox())!
  await expect.poll(async () => (await notes.boundingBox())!.height).toBeLessThan(60)
  const nb = (await notes.boundingBox())!
  expect(nb.height).toBeGreaterThanOrEqual(47)
  expect(nb.y + nb.height).toBeLessThanOrEqual(stack.y + stack.height + 1)
  const sAfter = (await splitter.boundingBox())!
  expect(sAfter.y + sAfter.height).toBeLessThanOrEqual(stack.y + stack.height)
  await expect
    .poll(async () => (await layout(cockpit)).layout.zones.left.panels[0]!.size)
    .toBeLessThanOrEqual(stack.height)

  // Dragging back up moves the bar at once (no dead zone to travel through first).
  await page.mouse.move(sAfter.x + sAfter.width / 2, sAfter.y + sAfter.height / 2)
  await page.mouse.down()
  await page.mouse.move(sAfter.x + sAfter.width / 2, sAfter.y + sAfter.height / 2 - 100, { steps: 5 })
  await page.mouse.up()
  await expect.poll(async () => (await notes.boundingBox())!.height).toBeGreaterThan(140)

  // Zone edge: 5000px to the right. The zone stops at the 70vw cap, the terminal keeps room.
  const edge = page.getByRole('separator', { name: 'Resize left zone' })
  const eb = (await edge.boundingBox())!
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2)
  await page.mouse.down()
  await page.mouse.move(eb.x + 5000, eb.y + eb.height / 2, { steps: 5 })
  await page.mouse.up()
  const innerWidth = await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth)
  await expect
    .poll(async () => (await layout(cockpit)).layout.zones.left.size)
    .toBeLessThanOrEqual(Math.ceil(innerWidth * 0.7))
  expect((await page.locator('.zones-centre').boundingBox())!.width).toBeGreaterThanOrEqual(159)

  // Dragging the edge back moves it at once too.
  const before = (await page.locator('.zone-left .panel-area').boundingBox())!.width
  const eAfter = (await edge.boundingBox())!
  await page.mouse.move(eAfter.x + eAfter.width / 2, eAfter.y + eAfter.height / 2)
  await page.mouse.down()
  await page.mouse.move(eAfter.x + eAfter.width / 2 - 100, eAfter.y + eAfter.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect
    .poll(async () => (await page.locator('.zone-left .panel-area').boundingBox())!.width)
    .toBeLessThan(before - 80)
})

test("a panel header's … button opens the same zone menu as a right-click on the icon", async ({ cockpit }) => {
  const { page } = cockpit
  await sessionsIcon(page, 'right').click()
  await expect(sessionsPanel(page, 'right')).toBeVisible()

  // Named after what it does, so it never also matches the icon's /^Sessions/ name.
  const more = sessionsPanel(page, 'right').getByRole('button', { name: 'Move or hide Sessions' })
  await more.click()
  // The click that opened it must not also close it (the strip's outside-click dismiss skips it).
  await expect(page.getByRole('menu')).toHaveCount(1)
  await expect(page.locator('.zone-right [role="menu"]')).toHaveCount(1)
  await expect(page.getByRole('menuitem')).toHaveText(['Move to left', 'Move to bottom', 'Hide'])
  // A second click closes it, as does a click elsewhere.
  await more.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await more.click()
  await expect(page.getByRole('menu')).toHaveCount(1)
  await page.locator('.zones-centre').click({ position: { x: 200, y: 200 } })
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Its items act like the right-click menu's: the panel moves, still open.
  await more.click()
  await page.getByRole('menuitem', { name: 'Move to left' }).click()
  await expect(sessionsPanel(page, 'left')).toBeVisible()
  await expect(sessionsIcon(page, 'right')).toHaveCount(0)

  // The right-click on the icon still opens it too.
  await sessionsIcon(page, 'left').click({ button: 'right' })
  await expect(page.getByRole('menuitem')).toHaveText(['Move to right', 'Move to bottom', 'Hide'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
})

test('opening a menu in one strip closes the menu open in another', async ({ cockpit }) => {
  const { page } = cockpit
  // Sessions starts in the right zone (Task 20); these tests were written for the left one.
  await moveTo(page, 'right', 'left')
  await page.locator('.zone-left').getByRole('button', { name: 'Hidden panels' }).click()
  await expect(page.locator('.zone-left [role="menu"]')).toHaveCount(1)

  // "..." of another strip: only its list is open now.
  await page.locator('.zone-right').getByRole('button', { name: 'Hidden panels' }).click()
  await expect(page.getByRole('menu')).toHaveCount(1)
  await expect(page.locator('.zone-right [role="menu"]')).toHaveCount(1)

  // A right-click (no click event) on an icon in another strip: only its context menu is open.
  await sessionsIcon(page, 'left').click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(1)
  await expect(page.getByRole('menuitem', { name: 'Hide' })).toBeVisible()

  // An icon click in another strip closes it as well.
  await page.locator('.zone-right').getByRole('button', { name: 'Hidden panels' }).click()
  await expect(page.getByRole('menu')).toHaveCount(1)
  await sessionsIcon(page, 'left').click()
  await expect(page.getByRole('menu')).toHaveCount(0)
})
