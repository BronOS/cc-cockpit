// Session rename (design-next §4.1): the tab menu's Rename names a Claude tab, the name replaces
// Claude's topic in the strip, an empty name goes back, and a quit and relaunch keeps it (saved in
// the project's record, restored with the tab).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

function savedNames(c: Cockpit): Array<string | undefined> {
  const dir = join(c.dataDir, 'projects')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  for (const file of names) {
    if (!/^[0-9a-f]{16}\.json$/.test(file)) continue
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { path: string; tabs: Array<{ name?: string }> }
    if (record.path === c.projectDir) return record.tabs.map((t) => t.name)
  }
  return []
}

test('Rename names a Claude tab, an empty name clears it, and the name survives a relaunch', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    const { page } = c
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.newTab('shell')
    await expect(page.getByRole('tab')).toHaveCount(2)

    // A shell tab has no Rename entry.
    await page.getByRole('tab').nth(1).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Close' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0)
    await page.keyboard.press('Escape')

    const claudeTab = page.getByRole('tab').nth(0)
    await claudeTab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const input = page.getByLabel('Tab name')
    await input.fill('Release prep')
    await input.press('Enter')
    await expect(page.getByRole('tab').nth(0)).toContainText('Release prep')
    await expect.poll(() => savedNames(c)).toEqual(['Release prep', undefined])
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    const { page } = c
    await expect(page.getByRole('tab')).toHaveCount(2)
    await expect(page.getByRole('tab').nth(0)).toContainText('Release prep')

    // Empty goes back to Claude's own title (the plain label here: the fake sets no topic).
    await page.getByRole('tab').nth(0).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const input = page.getByLabel('Tab name')
    await input.fill('')
    await input.press('Enter')
    await expect(page.getByRole('tab').nth(0)).not.toContainText('Release prep')
    await expect.poll(() => savedNames(c)).toEqual([undefined, undefined])
  } finally {
    await second.close()
  }
})
