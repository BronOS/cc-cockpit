// examples/plugin (the public template repo's master copy), linked and driven through the real app.
// The unit test checks its host against a fake ctx; only this proves the manifest, the panel page
// under the plugin CSP, and the real storage and badge work together for someone who copies it.
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const EXAMPLE = join(__dirname, '..', '..', 'examples', 'plugin')
const ID = 'example.plugin'

test('example plugin: panel, click counter, badge, storage and command', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', EXAMPLE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, ID)
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: ID, state: 'active' }] })

  await cockpit.page.locator('.zone-left').getByRole('button', { name: /^Example/ }).click()
  const panel = cockpit.page.frameLocator('section.panel[aria-label="Example"] iframe')
  await expect(panel.locator('#greeting')).toHaveText('Hello')

  await panel.locator('#click').click()
  await panel.locator('#click').click()
  await expect(panel.locator('#clicks')).toHaveText('2')
  const badge = async (): Promise<unknown> =>
    (await cockpit.hook<LayoutView>('layout', cockpit.projectDir)).panels.find((p) => p.panelKey === `${ID}/main`)?.badge
  await expect.poll(badge).toEqual({ kind: 'count', count: 2 })

  await cockpit.hook('runPluginCommand', cockpit.projectDir, `${ID}/say-hello`)
  await expect.poll(() => cockpit.hook<string[]>('notifications')).toContain('Hello! 2 clicks so far.')

  await panel.locator('#reset').click()
  await expect(panel.locator('#clicks')).toHaveText('0')
  await expect.poll(badge).toBeFalsy()
})
