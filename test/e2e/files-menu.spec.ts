// The Files panel's right-click menu (cockpit.files 0.2.0) over the real app: the menu opens on a
// right click and from the keyboard, Rename and New folder write through the plugin host, Move to
// Trash asks the person first (the test run's QueuedTrashConfirm, answered by the `answerTrash`
// hook) and reaches `shell.trashItem`, and Reveal / Open with default app reach their `shell` calls.
// The three `shell` members are replaced in main by recorders (as the openExternal specs do), so
// nothing reaches the real file manager, an app or the Trash.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

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

type ShellCall = [string, string]

/** Replace shell's file calls in main with recorders; trashItem removes the file so the tree follows. */
async function stubShell(c: Cockpit): Promise<() => Promise<ShellCall[]>> {
  await c.app.evaluate(({ shell }) => {
    const g = globalThis as { __shellCalls?: Array<[string, string]> }
    g.__shellCalls = []
    // No `require` in an evaluated function: Node's own loader for built-ins.
    const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
    shell.showItemInFolder = (p: string) => {
      g.__shellCalls!.push(['showItemInFolder', p])
    }
    shell.openPath = (p: string) => {
      g.__shellCalls!.push(['openPath', p])
      return Promise.resolve('')
    }
    shell.trashItem = (p: string) => {
      g.__shellCalls!.push(['trashItem', p])
      fs.rmSync(p, { recursive: true, force: true })
      return Promise.resolve()
    }
  })
  return () => c.app.evaluate(() => (globalThis as { __shellCalls?: Array<[string, string]> }).__shellCalls ?? [])
}

async function filesPanel(c: Cockpit) {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === 'cockpit.files')?.state, {
      timeout: 15_000
    })
    .toBe('active')
  const section = c.page.locator('section.panel[aria-label="Files"]')
  if (!(await section.isVisible())) await c.page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
  return c.page.frameLocator('section.panel[aria-label="Files"] iframe')
}

test('right-click menu: items per kind, rename, new folder, Move to Trash with the confirmation, reveal and open', async ({ cockpit }) => {
  const { projectDir } = cockpit
  mkdirSync(join(projectDir, 'src'))
  writeFileSync(join(projectDir, 'src', 'a.txt'), 'a\n')
  writeFileSync(join(projectDir, 'notes.md'), 'n\n')
  writeFileSync(join(projectDir, 'run.sh'), 'echo hi\n')
  const shellCalls = await stubShell(cockpit)
  const tree = await filesPanel(cockpit)
  const row = (name: string) => tree.locator('.row', { has: tree.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
  await expect(row('notes.md')).toBeVisible()

  // A file's menu, on a right click.
  await row('notes.md').click({ button: 'right' })
  const menu = tree.getByRole('menu')
  await expect(menu).toBeVisible()
  const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Open in file manager'
  await expect(menu.getByRole('menuitem')).toHaveText([
    'Open',
    'Open with default app',
    reveal,
    'Ask Claude about this file',
    'Copy path',
    'Copy relative path',
    'Rename…',
    'Move to Trash'
  ])
  // The first item has the focus; arrows move it, Escape closes and gives the focus back to the tree.
  await expect(menu.getByRole('menuitem', { name: 'Open', exact: true })).toBeFocused()
  await cockpit.page.keyboard.press('ArrowDown')
  await expect(menu.getByRole('menuitem', { name: 'Open with default app' })).toBeFocused()
  await cockpit.page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(tree.locator('#list')).toBeFocused()

  // Shift+F10 opens the selected row's menu from the keyboard; a folder's items.
  await row('src').click()
  await cockpit.page.keyboard.press('Shift+F10')
  await expect(menu.getByRole('menuitem')).toHaveText([reveal, 'New file…', 'New folder…', 'Copy path', 'Copy relative path', 'Rename…', 'Move to Trash'])

  // New folder… inside src: the name bar, then the folder exists, src opens and the new one is selected.
  await menu.getByRole('menuitem', { name: 'New folder…' }).click()
  const input = tree.locator('#namebar-input')
  await expect(input).toBeFocused()
  await input.fill('made')
  await input.press('Enter')
  await expect.poll(() => existsSync(join(projectDir, 'src', 'made'))).toBe(true)
  await expect(row('made')).toHaveClass(/sel/)

  // Rename… a file: the stem is selected, an existing name is refused with a notice.
  await row('notes.md').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rename…' }).click()
  await expect(input).toHaveValue('notes.md')
  await input.fill('run.sh')
  await input.press('Enter')
  await expect(tree.locator('#error')).toContainText('already exists')
  await row('notes.md').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Rename…' }).click()
  await input.fill('readme.md')
  await input.press('Enter')
  await expect(row('readme.md')).toBeVisible()
  await expect(row('notes.md')).toHaveCount(0)
  expect(existsSync(join(projectDir, 'readme.md'))).toBe(true)

  // Move to Trash: the app asks; a no moves nothing and shows nothing, a yes reaches shell.trashItem.
  await row('readme.md').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect.poll(() => cockpit.hook<unknown[]>('trashDialogs')).toHaveLength(1)
  expect((await cockpit.hook<Array<Record<string, unknown>>>('trashDialogs'))[0]).toMatchObject({ path: 'readme.md', kind: 'file', pluginId: 'cockpit.files' })
  await expect(tree.locator('#error')).toBeHidden()
  expect(existsSync(join(projectDir, 'readme.md'))).toBe(true)
  await cockpit.hook('answerTrash', true)
  await row('readme.md').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(row('readme.md')).toHaveCount(0)
  expect((await shellCalls()).filter(([m]) => m === 'trashItem')).toEqual([['trashItem', join(projectDir, 'readme.md')]])

  // Reveal and Open with default app reach the system through main; a script is refused with a notice.
  await row('src').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: reveal }).click()
  await row('a.txt').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Open with default app' }).click()
  await expect
    .poll(async () => (await shellCalls()).filter(([m]) => m !== 'trashItem'))
    .toEqual([
      ['showItemInFolder', join(projectDir, 'src')],
      ['openPath', join(projectDir, 'src', 'a.txt')]
    ])
  await row('run.sh').click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Open with default app' }).click()
  await expect(tree.locator('#error')).toContainText('.sh file runs when opened')
  expect(await shellCalls()).toHaveLength(3)
})

test('Copy path and Copy relative path write the clipboard from the panel', async ({ cockpit }) => {
  const { app, projectDir } = cockpit
  writeFileSync(join(projectDir, 'notes.md'), 'n\n')
  const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const tree = await filesPanel(cockpit)
    const row = tree.locator('.row', { has: tree.locator('.name', { hasText: /^notes\.md$/ }) })
    await row.click({ button: 'right' })
    await tree.getByRole('menuitem', { name: 'Copy relative path' }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('notes.md')
    await row.click({ button: 'right' })
    await tree.getByRole('menuitem', { name: 'Copy path' }).click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(join(projectDir, 'notes.md'))
    await expect(tree.locator('#error')).toBeHidden()
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
  }
})

test('Ask Claude about this file opens a Claude tab with a prompt naming the path', async ({ cockpit }) => {
  writeFileSync(join(cockpit.projectDir, 'notes.md'), 'n\n')
  const tree = await filesPanel(cockpit)
  await tree.locator('.row', { has: tree.locator('.name', { hasText: /^notes\.md$/ }) }).click({ button: 'right' })
  await tree.getByRole('menuitem', { name: 'Ask Claude about this file' }).click()
  await expect.poll(() => cockpit.claudeRuns().length, { timeout: 15_000 }).toBe(1)
  const argv = cockpit.claudeRuns()[0]!
  expect(argv.at(-1)).toContain('Have a look at notes.md in this project')
})
