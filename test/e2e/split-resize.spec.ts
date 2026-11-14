// Divider drag (design.md §1 "Size", D2, D5): the drag is drawn scaled and the ptys are resized once,
// on release (a live drag would be a SIGWINCH storm into Claude); it stops at the minimum pane size
// and sends one `groups.resize`.
//
// SIGWINCH is counted by a `trap` in each shell: the trap's line contains `winch-$((1+1))`, so the
// text `winch-2` appears only when the trap ran, once per resize of that pty.
import { expect, test } from './fixtures'
import { dividers, groupOfShells, groupsOf, paneShowing, paneText, recordGroupEvents, typeInPane, visiblePanes } from './split-fixtures'

function count(text: string, marker: string): number {
  return text.replaceAll('\n', '').split(marker).length - 1
}

test('a divider drag sends one resize on release, resizes each pty once, and stops at the minimum', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const ids = await groupOfShells(cockpit, ['pa', 'pb'])
  const pa = paneShowing(page, 'pa-2')
  const pb = paneShowing(page, 'pb-2')
  for (const pane of [pa, pb]) await typeInPane(page, pane, "trap 'echo winch-$((1+1))' WINCH")
  await page.waitForTimeout(500)

  const divider = dividers(page)
  await expect(divider).toHaveCount(1)
  const seqs = await recordGroupEvents(page)
  const box = (await divider.boundingBox())!
  const y = box.y + box.height / 2
  const x0 = box.x + box.width / 2

  // Mid-drag: nothing is sent and no pty is resized yet.
  await page.mouse.move(x0, y)
  await page.mouse.down()
  const start = (await groupsOf(page)).groups[0]!.root.sizes
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 - i * 20, y)
  await page.waitForTimeout(600)
  expect(await seqs()).toEqual([])
  expect(count(await paneText(pa), 'winch-2')).toBe(0)
  expect(count(await paneText(pb), 'winch-2')).toBe(0)
  expect((await groupsOf(page)).groups[0]!.root.sizes).toEqual(start)

  // Release: one `groups.resize` (one new snapshot), and each pane's pty resized once.
  await page.mouse.up()
  await expect.poll(async () => (await seqs()).length).toBe(1)
  await expect.poll(async () => count(await paneText(pa), 'winch-2')).toBe(1)
  await expect.poll(async () => count(await paneText(pb), 'winch-2')).toBe(1)
  await page.waitForTimeout(800)
  expect((await seqs()).length).toBe(1)
  expect(count(await paneText(pa), 'winch-2')).toBe(1)
  expect(count(await paneText(pb), 'winch-2')).toBe(1)
  const moved = (await groupsOf(page)).groups[0]!.root.sizes
  expect(moved[0]!).toBeLessThan(start[0]!)
  expect(moved.reduce((s, n) => s + n, 0)).toBeCloseTo(1, 5)

  // Past the minimum: a drag far beyond the window's edge stops at the smallest allowed pane: the
  // share stays at or above the clamp (10%) and the pane keeps at least 20x5 cells (D5).
  const box2 = (await divider.boundingBox())!
  await page.mouse.move(box2.x + box2.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(-2000, y, { steps: 20 })
  await page.mouse.up()
  await expect.poll(async () => (await seqs()).length).toBe(2)
  const clamped = (await groupsOf(page)).groups[0]!.root.sizes
  expect(clamped[0]!).toBeGreaterThanOrEqual(0.1 - 1e-6)
  expect(clamped[1]!).toBeLessThanOrEqual(0.9 + 1e-6)
  await typeInPane(page, pa, 'echo sz-$(stty size | tr " " x)')
  await expect.poll(async () => /sz-(\d+)x(\d+)/.test(await paneText(pa))).toBe(true)
  const m = [...(await paneText(pa)).matchAll(/sz-(\d+)x(\d+)/g)].at(-1)!
  expect(Number(m[1])).toBeGreaterThanOrEqual(5) // rows
  expect(Number(m[2])).toBeGreaterThanOrEqual(20) // cols
  await expect(visiblePanes(page)).toHaveCount(2)
  void ids
})

test('the divider moves with the keyboard and double-click equalizes (design §1 "Strip and ways in/out")', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await groupOfShells(cockpit, ['pa', 'pb'])
  const divider = dividers(page)
  const before = (await groupsOf(page)).groups[0]!.root.sizes
  await divider.focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await groupsOf(page)).groups[0]!.root.sizes[0]!).toBeLessThan(before[0]!)
  await divider.dblclick()
  await expect.poll(async () => (await groupsOf(page)).groups[0]!.root.sizes).toEqual([0.5, 0.5])
})
