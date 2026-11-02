import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

// Tabs are created through the [+] menu here (what a mouse user does); commands.spec.ts covers the
// keyboard path.

test('a project given on the command line opens its own window with no tabs yet', async ({ cockpit }) => {
  await expect(cockpit.page.getByText('No tabs yet')).toBeVisible()
  await expect(cockpit.page.getByRole('tab')).toHaveCount(0)
})

test('a Claude tab runs `claude` with the app hooks file and echoes typing', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  // The fake recorded how the app started it: --settings <data>/hooks.json and the generated core
  // Claude plugin (the cc-cockpit skill), each value one argv element, nothing else yet.
  const core = join(cockpit.dataDir, 'claude-plugins', 'core')
  await expect.poll(() => cockpit.claudeRuns()).toEqual([
    ['--settings', join(cockpit.dataDir, 'hooks.json'), '--plugin-dir', core]
  ])
  // The folder it names is a complete Claude Code plugin by the time claude starts.
  expect(JSON.parse(readFileSync(join(core, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('cc-cockpit')
  expect(readFileSync(join(core, 'skills', 'cc-cockpit', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: cc-cockpit\n/)

  await cockpit.typeLine('hello cockpit')
  await cockpit.waitForTerminalText('FAKE-CLAUDE echo: hello cockpit')
})

test('/exit 3 (a failed exit) keeps the tab with the exited banner and Restart relaunches claude', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  await cockpit.typeLine('/exit 3')
  const banner = cockpit.page.getByRole('status')
  await expect(banner).toContainText('exited (code 3)')

  await banner.getByRole('button', { name: 'Restart' }).click()
  await expect(banner).toHaveCount(0)
  await expect.poll(() => cockpit.claudeRuns().length).toBe(2)

  // The restarted process is live: it echoes again.
  await cockpit.typeLine('again')
  await cockpit.waitForTerminalText('FAKE-CLAUDE echo: again')
})

test('a clean exit closes the tab (Claude /exit, shell exit); the window stays with no tabs', async ({ cockpit }) => {
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  // The fake exits 0 on a bare /exit: the tab goes, no banner, and main forgot it too.
  await cockpit.typeLine('/exit')
  await expect(cockpit.page.getByRole('tab')).toHaveCount(1)
  await expect(cockpit.page.getByRole('status')).toHaveCount(0)
  await expect
    .poll(async () => (await cockpit.hook<{ kind: string }[]>('tabs', cockpit.projectDir)).map((t) => t.kind))
    .toEqual(['shell'])

  // The shell tab is selected now; its `exit` closes the last tab and the window stays, and
  // after a failing command (exit code 1) too: a shell's code is its last command's status.
  await cockpit.typeLine('false; exit')
  await expect(cockpit.page.getByRole('tab')).toHaveCount(0)
  await expect(cockpit.page.getByText('No tabs yet')).toBeVisible()
  expect(await cockpit.hook<unknown[]>('tabs', cockpit.projectDir)).toEqual([])
})

test('with "Keep the tab open" a clean exit shows the exited banner', async ({ cockpit }) => {
  const { page } = cockpit
  await page.keyboard.press('ControlOrMeta+,')
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Appearance and keys' }).click()
  const choice = settings.getByRole('combobox', { name: "When a tab's process exits" })
  await expect(choice).toHaveValue('close-clean')
  await choice.selectOption('keep')
  await expect(choice).toHaveValue('keep')
  await expect(choice).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/exit')
  await expect(page.getByRole('status')).toContainText('exited (code 0)')
  await expect(page.getByRole('tab')).toHaveCount(1)
})

test('a shell tab opens $SHELL as a login shell in the project folder', async ({ cockpit }) => {
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')

  // 6*7 is computed by the shell: the typed line contains no "42".
  await cockpit.typeLine('echo $((6*7)) && pwd -P && echo "$SHELL"')
  await cockpit.waitForTerminalText('42')
  await cockpit.waitForTerminalText(cockpit.projectDir)
  await cockpit.waitForTerminalText('fake-shell')

  // Shell tabs never run claude.
  expect(cockpit.claudeRuns()).toEqual([])
})

test('main reports the tabs of the project and closing a tab removes it', async ({ cockpit }) => {
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  const tabs = await cockpit.hook<{ kind: string; cwd: string }[]>('tabs', cockpit.projectDir)
  expect(tabs.map((t) => [t.kind, t.cwd])).toEqual([
    ['shell', cockpit.projectDir],
    ['claude', cockpit.projectDir]
  ])

  await cockpit.page.getByRole('button', { name: /^Close Claude/ }).click()
  await expect(cockpit.page.getByRole('tab')).toHaveCount(1)
  const after = await cockpit.hook<{ kind: string }[]>('tabs', cockpit.projectDir)
  expect(after.map((t) => t.kind)).toEqual(['shell'])
})

test('the tab context menu moves a tab and main keeps the new order', async ({ cockpit }) => {
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')

  await cockpit.page.getByRole('tab', { name: /^Claude/ }).click({ button: 'right' })
  await cockpit.page.getByRole('menuitem', { name: 'Move left' }).click()

  await expect(cockpit.page.getByRole('tab').first()).toHaveText(/^Claude/)
  const tabs = await cockpit.hook<{ kind: string }[]>('tabs', cockpit.projectDir)
  expect(tabs.map((t) => t.kind)).toEqual(['claude', 'shell'])
})
