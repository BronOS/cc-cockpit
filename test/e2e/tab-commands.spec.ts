// User-defined entries of the new-tab menu (design §3 Tabs, "Custom commands"): an app-wide entry
// and a project entry are added in Settings, the [+] menu lists them after Claude and Shell, and
// picking one runs its command line in the login shell (here test/fixtures/bin/fake-shell, which
// runs `-l -i -c <command>` under /bin/sh) in a new tab titled by the label. A relaunch brings
// the tab back NOT started; only Restart runs it again. Each run appends to runs.log in the
// project folder (the tab's cwd), so "did not run" is checked on disk, not inferred from a screen.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { TabInfo } from '../../src/shared/ipc'
import type { TabRecord } from '../../src/shared/types'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

// `$((...))` proves a shell parsed the line (the marker text itself is not in the command), and
// `sleep` keeps the tab running: a clean exit would close it under the default tabExit setting.
const PROJECT_COMMAND = 'echo ran >> runs.log; echo "PROJ-MARKER-$((40 + 2))"; sleep 600'
const APP_COMMAND = 'echo "APP-MARKER-$((7 * 6))" | tr A-Z a-z; sleep 600'

/** The tabs saved in the project's record on disk (what the next start reads). */
function savedTabs(c: Cockpit): TabRecord[] {
  const dir = join(c.dataDir, 'projects')
  if (!existsSync(dir)) return []
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{16}\.json$/.test(name)) continue
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { path: string; tabs: TabRecord[] }
    if (record.path === c.projectDir) return record.tabs
  }
  return []
}

const runs = (c: Cockpit): number => {
  const file = join(c.projectDir, 'runs.log')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}

async function addEntry(page: Page, level: 'app' | 'project', label: string, command: string): Promise<void> {
  const editor = page.locator(`.tab-commands[data-level="${level}"]`)
  await editor.getByPlaceholder('Label').fill(label)
  await editor.getByPlaceholder(/^Command line/).fill(command)
  await editor.getByRole('button', { name: 'Add' }).click()
  // Shown once main stored it and the page reloaded the view.
  await expect(editor.getByRole('textbox', { name: /^Label of command/ }).last()).toHaveValue(label)
}

test('entries added in Settings appear in the [+] menu and run in the login shell in a tab named after them', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    const { page } = c
    const settings = page.getByRole('dialog', { name: 'Settings' })
    await page.keyboard.press('ControlOrMeta+,')
    await settings.getByRole('button', { name: 'Appearance and keys' }).click()
    await addEntry(page, 'app', 'App tool', APP_COMMAND)
    await settings.getByRole('button', { name: 'This project' }).click()
    await addEntry(page, 'project', 'Proj tool', PROJECT_COMMAND)
    await expect
      .poll(() => (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { tabCommands?: unknown }).tabCommands)
      .toEqual([{ id: expect.any(String), label: 'App tool', command: APP_COMMAND }])
    await settings.getByRole('button', { name: 'Close settings' }).click()
    await expect(settings).toHaveCount(0)

    // The menu: Claude, Shell, then the app-wide group, then the project's.
    await page.getByRole('button', { name: 'New tab' }).click()
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem')).toHaveText([/^Claude/, /^Shell/, 'App tool', 'Proj tool'])
    await expect(menu.getByRole('group', { name: 'App commands' }).getByRole('menuitem')).toHaveText(['App tool'])
    await expect(menu.getByRole('group', { name: 'Project commands' }).getByRole('menuitem')).toHaveText(['Proj tool'])
    await expect(menu.getByRole('separator')).toHaveCount(2)
    await menu.getByRole('menuitem', { name: 'Proj tool', exact: true }).click()

    // A new tab titled by the label, running the command in the project folder.
    await expect(page.getByRole('tab', { name: 'Proj tool' })).toHaveCount(1)
    await c.waitForTerminalText('PROJ-MARKER-42')
    expect(runs(c)).toBe(1)
    const live = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(live).toEqual([
      expect.objectContaining({ kind: 'command', label: 'Proj tool', command: PROJECT_COMMAND, cwd: c.projectDir })
    ])

    // The app-wide entry too.
    await page.getByRole('button', { name: 'New tab' }).click()
    await page.getByRole('menuitem', { name: 'App tool', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'App tool' })).toHaveCount(1)
    await c.waitForTerminalText('app-marker-42')
    // Saved for restore with the tab's own copy of label and command (the debounced writer).
    await expect
      .poll(() => savedTabs(c).map((t) => [t.kind, t.label, t.command]))
      .toEqual([
        ['command', 'Proj tool', PROJECT_COMMAND],
        ['command', 'App tool', APP_COMMAND]
      ])
  } finally {
    await first.close({ keepFiles: true })
  }

  // Relaunch: the tabs come back, stopped. Nothing ran by itself.
  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    const { page } = c
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: 'Proj tool (not started)' })).toHaveCount(1)
    await expect(page.getByRole('tab', { name: 'App tool (not started)' })).toHaveCount(1)
    await page.getByRole('tab', { name: 'Proj tool (not started)' }).click()
    const banner = page.getByRole('status')
    await expect(banner).toContainText('not started')
    expect(runs(c)).toBe(1)
    const waiting = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(waiting.map((t) => [t.label, t.notStarted, t.gen])).toEqual([
      ['Proj tool', true, 0],
      ['App tool', true, 0]
    ])

    // Restart runs the tab's own command.
    await banner.getByRole('button', { name: 'Restart' }).click()
    await expect(banner).toHaveCount(0)
    await c.waitForTerminalText('PROJ-MARKER-42')
    expect(runs(c)).toBe(1 + 1)
    await expect(page.getByRole('tab', { name: 'Proj tool', exact: true })).toHaveCount(1)
    // The other one still waits.
    await expect(page.getByRole('tab', { name: 'App tool (not started)' })).toHaveCount(1)
  } finally {
    await second.close()
  }
})

test('a command that exits cleanly closes its tab; a failing one keeps the banner, and Restart re-runs it', async ({
  cockpit: c
}) => {
  const { page } = c
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await settings.getByRole('button', { name: 'This project' }).click()
  await addEntry(page, 'project', 'Fails', 'echo ran >> runs.log; echo FAIL-MARKER; exit 3')
  await addEntry(page, 'project', 'Done', 'echo ok')
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await expect(settings).toHaveCount(0)

  await page.getByRole('button', { name: 'New tab' }).click()
  await page.getByRole('menuitem', { name: 'Fails', exact: true }).click()
  const banner = page.getByRole('status')
  await expect(banner).toContainText('exited (code 3)')
  await c.waitForTerminalText('FAIL-MARKER')
  expect(runs(c)).toBe(1)
  await banner.getByRole('button', { name: 'Restart' }).click()
  await expect.poll(() => runs(c)).toBe(2)
  await expect(banner).toContainText('exited (code 3)')

  await page.getByRole('button', { name: 'New tab' }).click()
  await page.getByRole('menuitem', { name: 'Done', exact: true }).click()
  // Exit 0 under the default tabExit: the tab closes on its own; the failing one stays.
  await expect(page.getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'Fails (exited)' })).toHaveCount(1)
})
