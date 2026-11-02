// Task 25: the real plugin host (a utilityProcess running out/host/index.js). Two fixture plugins
// are linked and enabled for the project: one activates, one throws. Only the thrower is marked
// errored (⚠ on its panel icon); the other ran inside a host with the minimal env.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')

test('a host activates the enabled plugins and isolates the one that throws', async ({ cockpit }) => {
  for (const name of ['host-ok', 'host-throws']) await cockpit.hook('linkPlugin', join(FIXTURES, name))
  // No enabled plugin with host code yet: the window has no host process.
  expect(await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)).toEqual({
    running: false,
    stopped: false,
    plugins: []
  })
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostok')
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostthrows')

  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toEqual({
      running: true,
      stopped: false,
      plugins: [
        { id: 'test.hostok', state: 'active' },
        { id: 'test.hostthrows', state: 'errored', error: 'activate() failed: fixture boom' }
      ]
    })

  // What the good plugin saw: its own ctx, and an env without main's variables.
  const seen = JSON.parse(readFileSync(join(cockpit.root, 'home', 'host-ok.json'), 'utf8')) as {
    pluginId: string
    api: number
    envKeys: string[]
  }
  expect(seen.pluginId).toBe('test.hostok')
  expect(seen.api).toBe(1)
  expect(seen.envKeys).toContain('HOME')
  expect(seen.envKeys).toContain('PATH')
  for (const leaked of ['CC_COCKPIT_DATA_DIR', 'CC_COCKPIT_TEST', 'FAKE_CLAUDE_LOG']) {
    expect(seen.envKeys).not.toContain(leaked)
  }

  // The thrower's panel is declared and carries the error; the icon shows the warning.
  const view = await cockpit.hook<LayoutView>('layout', cockpit.projectDir)
  expect(view.panels.find((p) => p.panelKey === 'test.hostthrows/board')).toMatchObject({
    title: 'Board',
    error: 'activate() failed: fixture boom'
  })
  const icon = cockpit.page.locator('.zone-left').getByRole('button', { name: /^Board/ })
  await expect(icon.locator('.panel-error')).toHaveAttribute('title', 'activate() failed: fixture boom')
})
