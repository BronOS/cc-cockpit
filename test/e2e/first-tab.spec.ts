// A project that opens with no tabs gets one Claude tab (main/tabs/first-tab.ts), unless the app
// setting is off. The harness turns the setting off for every other spec (fixtures.ts), so each
// test here launches its own app with `claudeTabOnOpen: true`.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test } from './fixtures'

test('a fresh project opens with one Claude tab running in the project folder', async () => {
  const { cockpit: c, close } = await launchCockpit({ claudeTabOnOpen: true })
  try {
    await expect(c.page.getByRole('tab')).toHaveCount(1)
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    // A fresh `claude`, as New tab > Claude starts it: the hooks file and nothing else.
    expect(c.claudeRuns()).toEqual([['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core')]])
    const tabs = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(tabs.map((t) => [t.kind, t.cwd])).toEqual([['claude', c.projectDir]])

    // Closing the last tab leaves the window empty: the first tab is only for the window opening.
    await c.page.getByRole('button', { name: /^Close Claude/ }).click()
    await expect(c.page.getByRole('tab')).toHaveCount(0)
    await expect(c.page.getByText('No tabs yet')).toBeVisible()
    expect(await c.hook<TabInfo[]>('tabs', c.projectDir)).toEqual([])
    expect(c.claudeRuns()).toHaveLength(1)
  } finally {
    await close()
  }
})

test('with the setting off a fresh project opens with no tabs', async ({ cockpit }) => {
  // The fixture's default. A tab the user adds is then the only one, and no claude ever ran.
  await expect(cockpit.page.getByText('No tabs yet')).toBeVisible()
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await expect(cockpit.page.getByRole('tab')).toHaveCount(1)
  expect((await cockpit.hook<TabInfo[]>('tabs', cockpit.projectDir)).map((t) => t.kind)).toEqual(['shell'])
  expect(cockpit.claudeRuns()).toEqual([])
})

test('a relaunch that restores tabs adds no Claude tab', async () => {
  const first = await launchCockpit({ claudeTabOnOpen: true })
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    // Swap the first Claude tab for a shell, so the saved record holds only the shell.
    await c.newTab('shell')
    await c.waitForTerminalText('FAKE-SHELL ready')
    await c.page.getByRole('button', { name: /^Close Claude/ }).click()
    await expect(c.page.getByRole('tab')).toHaveCount(1)
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    await c.waitForTerminalText('FAKE-SHELL ready')
    await expect(c.page.getByRole('tab')).toHaveCount(1)
    expect((await c.hook<TabInfo[]>('tabs', c.projectDir)).map((t) => t.kind)).toEqual(['shell'])
    // Only the first launch's Claude tab ever ran.
    expect(c.claudeRuns()).toHaveLength(1)
  } finally {
    await second.close()
  }
})

test('the setting is a checkbox in Appearance and keys, on by default, saved to app.json', async () => {
  const { cockpit: c, close } = await launchCockpit({ claudeTabOnOpen: true })
  try {
    const { page } = c
    await expect(page.getByRole('tab')).toHaveCount(1)
    await page.keyboard.press('ControlOrMeta+,')
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await settings.getByRole('button', { name: 'Appearance and keys' }).click()
    const box = settings.getByRole('checkbox', { name: 'Open a Claude tab when a project opens with no tabs' })
    await expect(box).toBeChecked()
    // A controlled box: it shows the new state once main stored it and the page reloaded the view,
    // so uncheck()'s immediate state check would fail. Click, then wait for the state.
    await box.click()
    await expect(box).not.toBeChecked()
    await expect(box).toBeEnabled()
    await expect
      .poll(() => (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { claudeTabOnOpen?: unknown }).claudeTabOnOpen)
      .toBe(false)
    // Settings only: the tab already open stays.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tab')).toHaveCount(1)
  } finally {
    await close()
  }
})
