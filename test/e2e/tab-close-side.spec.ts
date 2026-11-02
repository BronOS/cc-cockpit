// Settings › Appearance and keys › Tabs › "Close button position" (design §3 Close): the × moves to
// the start of every tab in every open window at once, stays a working close, is saved to app.json
// and is what a window opened later starts with.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, launchCockpit, test } from './fixtures'

/** The class of each tab's children, in DOM order (label, chip, close). */
const tabParts = (page: Page): Promise<string[][]> =>
  page.locator('.tab').evaluateAll((tabs) => tabs.map((t) => [...t.children].map((c) => c.className)))

/** Whether each tab's × is drawn left of its label (what the user sees, not only the DOM). */
const closeIsLeft = (page: Page): Promise<boolean[]> =>
  page.locator('.tab').evaluateAll((tabs) =>
    tabs.map((t) => {
      const close = t.querySelector('.tab-close')!.getBoundingClientRect()
      const label = t.querySelector('.tab-label')!.getBoundingClientRect()
      return close.right <= label.left
    })
  )

test('the close button moves to the left in every window, live, still closes, and is kept for new windows', async () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'cc-e2e-close-side-')))
  const third = realpathSync(mkdtempSync(join(tmpdir(), 'cc-e2e-close-side-')))
  const { cockpit: c, close } = await launchCockpit()
  try {
    const { page } = c
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    await c.newTab('shell')
    await expect(page.getByRole('tab')).toHaveCount(2)
    // Today's layout by default: the × after the label.
    expect(await tabParts(page)).toEqual([
      ['tab-label', 'tab-close'],
      ['tab-label', 'tab-close']
    ])
    expect(await closeIsLeft(page)).toEqual([false, false])

    // A second project window with a tab: the change must reach it without a reload.
    await c.hook('openProject', other)
    await expect.poll(() => c.app.windows().length).toBe(2)
    const second = c.app.windows().find((p) => p !== page)!
    await second.locator('.tabs-pane').waitFor()
    await second.getByRole('button', { name: 'New tab' }).click()
    await second.getByRole('menuitem', { name: 'Shell' }).click()
    await expect(second.getByRole('tab')).toHaveCount(1)
    expect(await tabParts(second)).toEqual([['tab-label', 'tab-close']])

    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance and keys' }).click()
    const side = settings.getByRole('combobox', { name: 'Close button position' })
    await expect(side).toHaveValue('right')
    await side.selectOption('left')
    await expect(side).toHaveValue('left')
    await expect
      .poll(() => (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { tabCloseSide?: unknown }).tabCloseSide)
      .toBe('left')
    await page.keyboard.press('Escape')
    await expect(settings).toHaveCount(0)

    // Both windows: the × first in the DOM and drawn before the label.
    await expect.poll(() => tabParts(page)).toEqual([
      ['tab-close', 'tab-label'],
      ['tab-close', 'tab-label']
    ])
    expect(await closeIsLeft(page)).toEqual([true, true])
    await expect.poll(() => tabParts(second)).toEqual([['tab-close', 'tab-label']])
    expect(await closeIsLeft(second)).toEqual([true])

    // It still closes (the fixture turns the running-tab question off).
    await page.getByRole('button', { name: /^Close Shell/ }).first().click()
    await expect(page.getByRole('tab')).toHaveCount(1)
    await expect.poll(async () => (await c.hook<unknown[]>('tabs', c.projectDir)).length).toBe(1)

    // An overlay's ✕ follows the same setting: first in its header, drawn left of the title.
    await c.hook('openOverlay', c.projectDir, { kind: 'terminal', argv: ['cat'], cwd: c.projectDir })
    const header = page.locator('.overlay-header')
    await expect(header).toBeVisible()
    expect(await header.evaluate((h) => [...h.children].map((e) => e.className))).toEqual([
      'overlay-close',
      'overlay-title'
    ])
    await header.getByRole('button', { name: 'Close overlay' }).click()
    await expect(page.locator('.overlay')).toHaveCount(0)

    // A window that opens later reads the pick at load (prefs.get), before its strip first draws.
    await c.hook('openProject', third)
    await expect.poll(() => c.app.windows().length).toBe(3)
    const late = c.app.windows().find((p) => p !== page && p !== second)!
    await late.locator('.tabs-pane').waitFor()
    await late.getByRole('button', { name: 'New tab' }).click()
    await late.getByRole('menuitem', { name: 'Shell' }).click()
    await expect(late.getByRole('tab')).toHaveCount(1)
    expect(await tabParts(late)).toEqual([['tab-close', 'tab-label']])
  } finally {
    await close()
    rmSync(other, { recursive: true, force: true })
    rmSync(third, { recursive: true, force: true })
  }
})
