// Edges-only scrolling's fade (src/sdk/scroll-edges-core.ts) is a mask, which clips everything inside
// the scroller to its box, `position: fixed` menus included. A scroller holding an open menu drops
// the mask while the menu is open (OPEN_POPUP), and dialogs that scroll keep their own border and
// shadow (styles.css). The cases a review found: the Remote servers row menu (a fixed `.picker-menu`
// inside the servers `.picker-list`) opened near the bottom of a list long enough to scroll, and the
// guest invite dialog (`.confirm-dialog.guest-dialog`, a scroller) in a short window.
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchCockpit, test } from './fixtures'
import { enableWebAccess } from './web-fixtures'

// Set by hand to keep screenshots of the two cases (not in CI).
const SHOTS = process.env.CC_SCROLL_SHOTS

const maskOf = (page: Page, selector: string): Promise<string> =>
  page.evaluate((s) => getComputedStyle(document.querySelector(s)!).maskImage, selector)

test('a scroller holding an open menu drops its fade; the menu shows whole and the fade comes back after', async () => {
  test.setTimeout(60_000)
  // Direct servers on loopback ports nothing listens on: the rows only need to exist.
  const servers = Array.from({ length: 20 }, (_, i) => ({
    id: `s${i}`,
    name: `Server ${i}`,
    via: { kind: 'direct', origin: `http://127.0.0.1:${45100 + i}` }
  }))
  const { cockpit, close } = await launchCockpit({ folderArg: false, ready: 'picker', settings: { remoteServers: servers } })
  try {
    const { page, app } = cockpit
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(900, 560)))
    const list = page.locator('ul.picker-list[aria-label="Servers"]')
    await expect(list.locator('li')).not.toHaveCount(0)
    // The list must scroll (it is capped), and scrolled to the middle both edges are hidden.
    const metrics = await list.evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
      return { sh: el.scrollHeight, ch: el.clientHeight }
    })
    expect(metrics.sh).toBeGreaterThan(metrics.ch)
    await expect.poll(() => maskOf(page, 'ul.picker-list[aria-label="Servers"]')).toContain('linear-gradient')

    // The ⋯ of the last row still in view: its fixed menu would hang past the list's bottom edge.
    const box = (await list.boundingBox())!
    const row = await list.evaluate((el, bottom) => {
      const rows = [...el.querySelectorAll('li')].filter((li) => li.getBoundingClientRect().bottom <= bottom)
      return rows[rows.length - 1]!.querySelector('button[aria-haspopup="menu"]')!.getAttribute('aria-label')
    }, box.y + box.height)
    await page.getByRole('button', { name: row! }).click()
    const menu = page.getByRole('menu', { name: /menu$/ })
    await expect(menu).toBeVisible()
    await expect.poll(() => maskOf(page, 'ul.picker-list[aria-label="Servers"]')).toBe('none')
    // Its last item is drawn where it is laid out (nothing over it, nothing clipping it).
    await expect(menu.getByRole('menuitem', { name: 'Forget' })).toBeVisible()
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'servers-menu-open.png') })

    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect.poll(() => maskOf(page, 'ul.picker-list[aria-label="Servers"]')).toContain('linear-gradient')
  } finally {
    await close()
  }
})

test('a dialog that scrolls in a short window keeps its border and shadow: no fade on it', async () => {
  test.setTimeout(60_000)
  const { cockpit, close } = await launchCockpit()
  try {
    const { page, app } = cockpit
    await enableWebAccess(cockpit)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.setSize(900, 380)))
    await page.getByRole('button', { name: 'Share' }).click()
    const dialog = page.getByTestId('guest-invite-dialog')
    await expect(dialog).toBeVisible()
    const scrolls = await dialog.evaluate((el) => {
      el.scrollTop = 40
      return el.scrollHeight > el.clientHeight && el.hasAttribute('data-cc-scroller')
    })
    expect(scrolls).toBe(true)
    await page.waitForTimeout(100)
    expect(await dialog.evaluate((el) => getComputedStyle(el).maskImage)).toBe('none')
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'guest-invite-short-window.png') })
  } finally {
    await close()
  }
})
