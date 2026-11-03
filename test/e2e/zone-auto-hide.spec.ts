// Side zone auto-hide (design §4 "Auto-hide"): as the window narrows the right zone gives way
// first, then the left one, and they come back left first as it widens, with a margin; the stored
// layout never changes; a zone the person shows by hand stays until the window shrinks again.
// Sessions (right) and a test panel declared through the `pluginPanels` hook (left) are opened.
import type { Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

// The fixture turns the setting off for every other spec; these launch with the app's default (on).
const it = test.extend<{ on: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  on: async ({}, use) => {
    const { cockpit, close } = await launchCockpit({ zoneAutoHide: true })
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

const area = (page: Page, zone: string) => page.locator(`.zone-${zone} .panel-area`)
const zoneEl = (page: Page, zone: string) => page.locator(`.zone-${zone}`)

/** Size the window's page; the zones' row is that wide (the icon strips take 40 px each). */
async function resize(c: Cockpit, width: number): Promise<void> {
  await c.app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setContentSize(w, 800)
  }, width)
  await expect.poll(() => c.page.evaluate(() => window.innerWidth)).toBe(width)
}

async function openBoth(c: Cockpit): Promise<void> {
  const { page } = c
  // 400 px keeps the widths below on a small display: left 280, right 320, strips 80, so the right
  // zone goes under 1080 px, the left under 760, the left is back at 808 (the 48 px margin) and the
  // right at 1128.
  await page.evaluate<void>("window.cockpit.invoke('settings.minTerminalWidthSet', { value: 400 })")
  await resize(c, 1300)
  await c.hook('pluginPanels', c.projectDir, 'test', [{ id: 'notes', title: 'Notes', defaultZone: 'left' }])
  await page.locator('.zone-left').getByRole('button', { name: /^Notes/ }).click()
  await page.locator('.zone-right').getByRole('button', { name: /^Sessions/ }).click()
  await expect(area(page, 'left')).toBeVisible()
  await expect(area(page, 'right')).toBeVisible()
}

it('the right zone hides first, then the left; they come back left first, past a margin', async ({ on: c }) => {
  const { page } = c
  await openBoth(c)

  await resize(c, 1000)
  await expect(area(page, 'right')).toHaveCount(0)
  await expect(zoneEl(page, 'right')).toHaveAttribute('data-auto-hidden', 'true')
  await expect(area(page, 'left')).toBeVisible()
  // The strip stays, and the stored layout still has the zone open: only the window hid it.
  await expect(page.locator('.zone-right').getByRole('button', { name: /^Sessions/ })).toHaveAttribute('aria-pressed', 'true')
  const stored = (await c.hook<LayoutView>('layout', c.projectDir)).layout.zones.right
  expect(stored.collapsed).toBe(false)
  expect(stored.panels.find((p) => p.panelKey === 'core/sessions')?.open).toBe(true)

  await resize(c, 700)
  await expect(area(page, 'left')).toHaveCount(0)
  await expect(area(page, 'right')).toHaveCount(0)

  // 900: room for the left zone, not yet for both.
  await resize(c, 900)
  await expect(area(page, 'left')).toBeVisible()
  await expect(area(page, 'right')).toHaveCount(0)
  // 1100 would fit the right zone at the minimum, but not with the margin: it stays hidden.
  await resize(c, 1100)
  await expect(area(page, 'right')).toHaveCount(0)
  await resize(c, 1300)
  await expect(area(page, 'right')).toBeVisible()
  await expect(area(page, 'left')).toBeVisible()
  await expect(zoneEl(page, 'right')).not.toHaveAttribute('data-auto-hidden', 'true')
})

it('a zone shown by hand stays until the window shrinks; a zone the person closed stays closed', async ({ on: c }) => {
  const { page } = c
  await openBoth(c)
  await resize(c, 1000)
  await expect(area(page, 'right')).toHaveCount(0)

  // An icon click shows the auto-hidden zone with its panel (it does not close the panel).
  const sessions = page.locator('.zone-right').getByRole('button', { name: /^Sessions/ })
  await sessions.click()
  await expect(area(page, 'right')).toBeVisible()
  await expect(sessions).toHaveAttribute('aria-pressed', 'true')
  // The next shrink: it gives way again.
  await resize(c, 990)
  await expect(area(page, 'right')).toHaveCount(0)

  // Closed by the person (shown, then its panel closed): it does not come back on a wide window.
  await sessions.click()
  await expect(area(page, 'right')).toBeVisible()
  await sessions.click()
  await expect(area(page, 'right')).toHaveCount(0)
  await resize(c, 1400)
  await expect(area(page, 'left')).toBeVisible()
  await expect(area(page, 'right')).toHaveCount(0)
  await expect(sessions).toHaveAttribute('aria-pressed', 'false')
})

it('the setting off keeps both zones at any width', async ({ on: c }) => {
  const { page } = c
  await openBoth(c)
  await page.evaluate<void>("window.cockpit.invoke('settings.zoneAutoHideSet', { value: false })")
  await resize(c, 900)
  await expect(area(page, 'left')).toBeVisible()
  await expect(area(page, 'right')).toBeVisible()
  // On again: checked at once.
  await page.evaluate<void>("window.cockpit.invoke('settings.zoneAutoHideSet', { value: true })")
  await expect(area(page, 'right')).toHaveCount(0)
  await expect(area(page, 'left')).toBeVisible()
})

/** The generated `<data>/bin/ccc` as a terminal outside the app runs it (no tab token), as in panels.spec.ts. */
function ccc(c: Cockpit, args: string[]): Promise<string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  env.HOME = c.dataDir
  return new Promise((resolve, reject) => {
    execFile(join(c.dataDir, 'bin', 'ccc'), args, { env, timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

it('ccc panel show (ctx.panels.show) brings back the auto-hidden zone of a panel already open', async ({ on: c }) => {
  const { page } = c
  await page.evaluate<void>("window.cockpit.invoke('settings.minTerminalWidthSet', { value: 400 })")
  await resize(c, 1300)
  await c.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'panels'))
  await c.hook('enablePlugin', c.projectDir, 'test.panels')
  await expect
    .poll(() => c.hook<HostStatus>('hostStatus', c.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.panels', state: 'active' }] })
  const show = (): Promise<string> => ccc(c, ['panel', 'show', '--project', c.projectDir, 'test.panels/echo'])
  expect(await show()).toBe('showing test.panels/echo\n')
  await expect(area(page, 'left')).toBeVisible()

  await resize(c, 700)
  await expect(area(page, 'left')).toHaveCount(0)
  // The layout already has it open in an expanded zone: only the published `reveal` can show it.
  expect(await show()).toBe('showing test.panels/echo\n')
  await expect(page.locator('section.panel[data-panel="test.panels/echo"]')).toBeVisible()
})
