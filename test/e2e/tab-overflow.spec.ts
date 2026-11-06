// Many tabs must never push the centre column past the right zone (the tab strip scrolls inside its
// own share), the newest tab stays visible, and an all-tabs menu lists the hidden ones.
import { expect, test } from './fixtures'

test('many tabs stay inside the centre column beside a right zone, and the active tab is in view', async ({ cockpit: c }) => {
  const { page } = c
  await c.hook('pluginPanels', c.projectDir, 'stand', [{ id: 'sessions', title: 'Sessions', defaultZone: 'right' }])
  await expect(page.getByRole('button', { name: /^Sessions/ })).toHaveCount(1)
  await page.getByRole('button', { name: /^Sessions/ }).click()
  await expect(page.locator('.zone-right section.panel')).toBeVisible()

  for (let i = 0; i < 14; i++) await c.newTab('shell')
  await expect(page.getByRole('tab')).toHaveCount(14)

  const geo = (): Promise<Record<'barRight' | 'centreRight' | 'zoneLeft' | 'activeLeft' | 'activeRight' | 'listLeft' | 'listRight' | 'scrollWidth' | 'clientWidth', number>> =>
    page.evaluate(() => {
      const r = (s: string): DOMRect => document.querySelector(s)!.getBoundingClientRect()
      const active = document.querySelector('.tab.active')!.getBoundingClientRect()
      return {
        barRight: r('.tab-bar').right,
        listRight: r('.tab-list').right,
        centreRight: r('.zones-centre').right,
        zoneLeft: r('.zone-right').left,
        activeLeft: active.left,
        activeRight: active.right,
        listLeft: r('.tab-list').left,
        scrollWidth: document.querySelector('.tab-list')!.scrollWidth,
        clientWidth: document.querySelector('.tab-list')!.clientWidth
      }
    })
  const g = await geo()
  expect(g.barRight).toBeLessThanOrEqual(g.centreRight + 0.5)
  expect(g.centreRight).toBeLessThanOrEqual(g.zoneLeft + 0.5)
  expect(g.scrollWidth).toBeGreaterThan(g.clientWidth)
  // The newest tab is the active one and is scrolled into the visible part of the strip.
  await expect.poll(async () => {
    const a = await geo()
    return a.activeLeft >= a.listLeft - 0.5 && a.activeRight <= a.listRight + 0.5
  }).toBe(true)

  // A vertical wheel over the strip scrolls it sideways.
  const before = await page.evaluate(() => document.querySelector('.tab-list')!.scrollLeft)
  await page.locator('.tab-list').hover()
  await page.mouse.wheel(0, -150)
  await expect.poll(() => page.evaluate(() => document.querySelector('.tab-list')!.scrollLeft)).toBeLessThan(before)

  // The all-tabs menu lists every tab and selects on click.
  await page.getByRole('button', { name: 'All tabs' }).click()
  await expect(page.getByRole('menuitem')).toHaveCount(14)
  await page.getByRole('menuitem').first().click()
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
  await expect.poll(async () => {
    const a = await geo()
    return a.activeLeft >= a.listLeft - 0.5
  }).toBe(true)
})
