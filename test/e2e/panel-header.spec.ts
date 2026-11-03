// ctx.panels.header / onAction in the real app: a linked fixture plugin puts a meta text and three
// actions (a core icon, its own .svg, another core icon) in its panel's title bar, before the "…"
// menu. A click reaches the plugin's onAction through main; a busy action spins and takes no click;
// null clears the header back to the bare title.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'panel-header')

test('a plugin sets its panel header, hears a click, shows busy and clears it', async ({ cockpit }) => {
  const { page } = cockpit
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.panelheader')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.panelheader', state: 'active' }] })
  const seenFile = join(cockpit.root, 'home', 'panel-header.json')
  const clicks = (): string[] =>
    existsSync(seenFile) ? (JSON.parse(readFileSync(seenFile, 'utf8')) as { clicks: string[] }).clicks : []

  // Panels start closed: open it from the left strip.
  await page.locator('.zone-left').getByRole('button', { name: /^Board/ }).click()
  const header = page.locator('section.panel[aria-label="Board"] header.panel-header')
  const meta = header.locator('.panel-plugin-meta')
  await expect(meta).toHaveText('synced just now, 3 items open in this board')
  await expect(meta).toHaveAttribute('title', 'synced just now, 3 items open in this board')

  // The three actions in the plugin's order, then the "…" menu, still last.
  const buttons = header.getByRole('button')
  await expect(buttons).toHaveCount(4)
  await expect(buttons.nth(0)).toHaveAccessibleName('Refresh')
  await expect(buttons.nth(1)).toHaveAccessibleName('Star')
  await expect(buttons.nth(2)).toHaveAccessibleName('Clear header')
  await expect(buttons.nth(3)).toHaveAccessibleName('Move or hide Board')
  const refresh = header.getByRole('button', { name: 'Refresh' })
  await expect(refresh).toHaveAttribute('title', 'Refresh')
  await expect(refresh.locator('svg.glyph')).toHaveCount(1)
  // The plugin's own .svg is a mask over currentColor, from its cc-plugin:// origin.
  const star = header.getByRole('button', { name: 'Star' }).locator('.panel-action-img')
  await expect(star).toHaveAttribute('style', /cc-plugin:\/\/test\.panelheader\/icons\/star\.svg/)

  // A click reaches onAction; the plugin answers by making Refresh busy: its icon spins.
  await refresh.click()
  await expect.poll(clicks).toEqual(['refresh'])
  await expect(refresh).toHaveAttribute('aria-busy', 'true')
  await expect
    .poll(() => refresh.locator('svg').evaluate((el) => getComputedStyle(el).animationName))
    .toBe('cc-panel-action-spin')
  // A busy action takes no click. The Clear click after it goes the same way (renderer, main,
  // host, in order), so the log shows whether the busy one got through.
  await refresh.click({ force: true })
  await header.getByRole('button', { name: 'Clear header' }).click()
  await expect.poll(clicks).toEqual(['refresh', 'clear'])

  // null: the bare title and the "…" menu.
  await expect(meta).toHaveCount(0)
  await expect(buttons).toHaveCount(1)
  await expect(buttons.nth(0)).toHaveAccessibleName('Move or hide Board')
  const view = await cockpit.hook<LayoutView>('layout', cockpit.projectDir)
  expect(view.panels.find((p) => p.panelKey === 'test.panelheader/board')?.header).toBeUndefined()
})
