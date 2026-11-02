// Bundled reviewer and editor (plan: bundled reviewer and editor, Task 2). Like the browser, they ship
// with the app and are on by default; CC_COCKPIT_NO_BUNDLED=1 (the harness default) loads none of them.
// This spec opts out of that switch for the first test and keeps it for the second.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

const IDS = ['cockpit.browser', 'cockpit.editor', 'cockpit.reviewer']

const test = base.extend<{ cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const { cockpit, close } = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' } })
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

/** The suite must not read the developer's git config (same shape as sessions-panel.spec.ts). */
const git = (cwd: string, ...args: string[]): void => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore', env })
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

test('the reviewer and editor load by default, show as built in, and a modified-file click opens the reviewer', async ({
  cockpit
}) => {
  const { page, projectDir } = cockpit
  await expect
    .poll(
      async () => (await cockpit.hook<HostStatus>('hostStatus', projectDir)).plugins.map((p) => `${p.id}:${p.state}`).sort(),
      { timeout: 15_000 }
    )
    .toEqual(IDS.map((id) => `${id}:active`))

  // Settings > Plugins lists both as built in.
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByRole('navigation').getByRole('button', { name: 'Plugins', exact: true }).click()
  for (const id of ['cockpit.reviewer', 'cockpit.editor']) {
    await expect(settings.locator(`[data-plugin="${id}"]`)).toContainText('built in')
  }
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  // A file the fake claude edits, changed since the last commit, opens the reviewer overlay.
  mkdirSync(join(projectDir, 'src'))
  const file = join(projectDir, 'src', 'a.txt')
  writeFileSync(file, 'one\ntwo\n')
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')
  git(projectDir, 'commit', '-q', '-m', 'first')
  writeFileSync(file, 'one\ntwo\nthree\n')

  await page.locator('.zone-right').getByRole('button', { name: /^Sessions/ }).click()
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/edit ${file}`)
  await expect(page.locator('.session-file')).toHaveCount(1)
  await page.getByRole('button', { name: file }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Review: src/a.txt'])
})

test.describe('with CC_COCKPIT_NO_BUNDLED=1', () => {
  test('neither plugin loads', async () => {
    const { cockpit, close } = await launchCockpit()
    try {
      await cockpit.page.waitForTimeout(1500)
      const status = await cockpit.hook<HostStatus>('hostStatus', cockpit.projectDir)
      expect(status.plugins.map((p) => p.id)).toEqual([])
    } finally {
      await close()
    }
  })
})
