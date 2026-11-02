// Task 27: ctx.sessions and ctx.badge in the real plugin host. The plugin opens a Claude tab with a
// prompt (argv after `--`, never typed), the window shows that tab without being asked, the plugin
// sees it in its session list, a cwd outside the project is refused, and its panel badge shows.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { LayoutView } from '../../src/shared/ipc'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'host-sessions')

test('a plugin opens a Claude tab, lists it and badges its own panel', async ({ cockpit }) => {
  await cockpit.hook('linkPlugin', FIXTURE)
  await cockpit.hook('enablePlugin', cockpit.projectDir, 'test.hostsessions')
  await expect
    .poll(() => cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir), { timeout: 15_000 })
    .toMatchObject({ running: true, plugins: [{ id: 'test.hostsessions', state: 'active' }] })
  const seenFile = join(cockpit.root, 'home', 'host-sessions.json')
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
  const seen = JSON.parse(readFileSync(seenFile, 'utf8')) as {
    opened: { tabId: string }
    list: { tabId: string; cwd: string }[]
    outsideError: string
    badgeError: string
    error?: string
  }
  expect(seen.error).toBeUndefined()
  expect(seen.list.map((s) => s.tabId)).toEqual([seen.opened.tabId])
  expect(seen.list[0]!.cwd).toBe(cockpit.projectDir)
  expect(seen.outsideError).toContain('outside the project')
  expect(seen.badgeError).toContain('not declared')

  // The window learned about the tab it did not ask for, and the prompt reached claude as argv.
  await expect(cockpit.page.getByRole('tab')).toHaveCount(1)
  await expect.poll(() => cockpit.claudeRuns().at(-1)).toEqual(expect.arrayContaining(['--', ' -p from the plugin']))

  const view = await cockpit.hook<LayoutView>('layout', cockpit.projectDir)
  expect(view.panels.find((p) => p.panelKey === 'test.hostsessions/board')?.badge).toEqual({ kind: 'count', count: 3 })
})
