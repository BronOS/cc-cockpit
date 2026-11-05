// Bundled reviewer and editor (plan: bundled reviewer and editor, Task 2). Like the browser, they ship
// with the app and are on by default; CC_COCKPIT_NO_BUNDLED=1 (the harness default) loads none of them.
// This spec opts out of that switch for the first test and keeps it for the second.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

const IDS = ['cockpit.browser', 'cockpit.editor', 'cockpit.files', 'cockpit.reviewer', 'cockpit.sessions']

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

  // The Sessions panel is the bundled cockpit.sessions plugin's (default zone left); its file click
  // goes through ctx.sessions.openFile to the project's open-file pick, the reviewer here.
  await page.locator('.zone-left').getByRole('button', { name: /^Sessions/ }).click()
  const sessionsPanel = page.frameLocator('section.panel[aria-label="Sessions"] iframe')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/edit ${file}`)
  await expect(sessionsPanel.locator('.file')).toHaveCount(1)
  await sessionsPanel.getByRole('button', { name: file }).click()
  await expect.poll(async () => (await stack(cockpit)).map((o) => o.title), { timeout: 15_000 }).toEqual(['Review: src/a.txt'])

  // Esc right after typing keeps the text: the page posts every change at once (a 300 ms page
  // debounce lost the last keystrokes), and the host flushes its pending write at close.
  const review = page.frameLocator('iframe[title="Review: src/a.txt"]')
  const comment = review.getByPlaceholder('Comment on the whole file (optional)')
  await comment.fill('kept through Esc')
  await expect(review.locator('#draft-error')).toBeHidden()
  await expect(review.locator('#notes-limit')).toBeHidden()
  // One action bar: the app's toolbar (actions, a divider, ✕); the page has no footer or Close.
  await expect(review.locator('footer, #close')).toHaveCount(0)
  const toolbar = page.locator('.overlay-header').first()
  await expect(toolbar.locator('.overlay-divider[data-before="close"] + .overlay-close')).toHaveCount(1)
  const discuss = toolbar.locator('.overlay-discuss-main')
  await expect(discuss).not.toHaveClass(/cc-primary/) // no note yet
  // A native key press, as a person types it: main sees it before the page (overlays.spec.ts).
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
  await expect.poll(async () => (await stack(cockpit)).length).toBe(0)
  await sessionsPanel.getByRole('button', { name: file }).click()
  await expect(page.frameLocator('iframe[title="Review: src/a.txt"]').getByPlaceholder('Comment on the whole file (optional)')).toHaveValue(
    'kept through Esc'
  )

  // "Add note" floats under a selection in the diff too (no toolbar button), and goes once used.
  const addNote = review.locator('#add-note')
  await expect(addNote).toBeHidden()
  await review.locator('.cm-merge-b .cm-line', { hasText: 'three' }).dblclick()
  await expect(addNote).toBeVisible()
  await addNote.click()
  await expect(review.locator('.note .link').first()).toHaveText('Line 3 · new')
  await expect(page.locator('.overlay-header .overlay-discuss-main').first()).toHaveClass(/cc-primary/) // a note: Discuss is primary
  await expect(review.locator('main > aside:visible')).toHaveCount(0) // no notes sidebar, no details column
  await expect(addNote).toBeHidden()
})

const running = async (c: Cockpit, dir: string): Promise<string[]> =>
  (await c.hook<HostStatus>('hostStatus', dir)).plugins.filter((p) => p.state === 'active').map((p) => p.id).sort()

const storedOff = (c: Cockpit): string[] | undefined =>
  (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { disabledBundled?: string[] }).disabledBundled

/** Settings opened on one of its pages in `page`. */
async function openSettings(page: Cockpit['page'], section: 'Plugins' | 'This Project') {
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByRole('navigation').getByRole('button', { name: section, exact: true }).click()
  return settings
}

test('off in all projects stops a built-in plugin in every window, locks the project switch, and undoes cleanly', async ({ cockpit }) => {
  const { page, app, projectDir } = cockpit
  await expect.poll(() => running(cockpit, projectDir), { timeout: 15_000 }).toEqual(IDS)
  const dirB = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-e2e-bundled-b-')))
  try {
    // Settings > Plugins: the built-in rows carry the switch, off; this project's host drops the reviewer.
    const settings = await openSettings(page, 'Plugins')
    const offSwitch = settings.getByRole('checkbox', { name: 'Off in all projects: Reviewer' })
    await expect(offSwitch).not.toBeChecked()
    // A controlled switch: it shows the new state once main answered and the page reloaded.
    await offSwitch.click()
    await expect(offSwitch).toBeChecked()
    await expect(settings.locator('[data-plugin="cockpit.reviewer"] [data-testid="off-in-all-projects"]')).toBeVisible()
    await expect.poll(() => running(cockpit, projectDir), { timeout: 15_000 }).toEqual(['cockpit.browser', 'cockpit.editor', 'cockpit.files', 'cockpit.sessions'])
    // app.json is written debounced.
    await expect.poll(() => storedOff(cockpit)).toEqual(['cockpit.reviewer'])

    // This project: the reviewer is off and its switch cannot turn it on, with the note.
    await settings.getByRole('navigation').getByRole('button', { name: 'This Project', exact: true }).click()
    const row = settings.locator('[data-plugin="cockpit.reviewer"]')
    await expect(row.getByRole('checkbox', { name: 'Enable Reviewer' })).not.toBeChecked()
    await expect(row.getByRole('checkbox', { name: 'Enable Reviewer' })).toBeDisabled()
    await expect(row.getByTestId('off-in-all-projects')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toBeHidden()

    // A second project, never told anything about the reviewer, does not run it either.
    await cockpit.hook('openProject', dirB)
    await expect.poll(() => app.windows().length).toBe(2)
    await expect.poll(() => running(cockpit, dirB), { timeout: 15_000 }).toEqual(['cockpit.browser', 'cockpit.editor', 'cockpit.files', 'cockpit.sessions'])

    // Undone: both projects run it again (their own switches were on all along).
    const again = await openSettings(page, 'Plugins')
    await again.getByRole('checkbox', { name: 'Off in all projects: Reviewer' }).click()
    await expect.poll(() => running(cockpit, projectDir), { timeout: 15_000 }).toEqual(IDS)
    await expect.poll(() => running(cockpit, dirB), { timeout: 15_000 }).toEqual(IDS)
    await expect.poll(() => storedOff(cockpit)).toBeUndefined()
  } finally {
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('a third-party open-file plugin replaces the reviewer through the pick, and alone once the reviewer is off', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  await expect.poll(() => running(cockpit, projectDir), { timeout: 15_000 }).toEqual(IDS)
  const seenFile = join(cockpit.root, 'home', 'open-file.json')
  const seen = (): Array<{ path: string }> => JSON.parse(readFileSync(seenFile, 'utf8')) as Array<{ path: string }>
  await cockpit.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'open-file'))
  await cockpit.hook('enablePlugin', projectDir, 'test.openfile')
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)

  // Both on: the pick lists both and has chosen neither (no priority for the built-in one).
  const settings = await openSettings(page, 'This Project')
  const select = settings.getByLabel('Plugin used to open files')
  await expect(select).toHaveValue('')
  await expect(select.locator('option')).toHaveText([
    'Pick one (built-in viewer until then)',
    // Plugin order (the project's enabledPlugins first, then the default-on ones), not built-in first.
    'Review (Open File Fixture)',
    'Reviewer (diff and notes) (Reviewer)',
    'Built-in viewer'
  ])

  // The reviewer off in this project: the fixture is the only candidate and is used without a pick.
  await settings.getByRole('navigation').getByRole('button', { name: 'This Project', exact: true }).click()
  await settings.locator('[data-plugin="cockpit.reviewer"]').getByRole('checkbox', { name: 'Enable Reviewer' }).click()
  await expect.poll(() => running(cockpit, projectDir), { timeout: 15_000 }).toEqual(['cockpit.browser', 'cockpit.editor', 'cockpit.files', 'cockpit.sessions', 'test.openfile'])
  // Read the picks again once the host restarted without the reviewer (the page loads them on open).
  await settings.getByRole('navigation').getByRole('button', { name: 'Projects', exact: true }).click()
  await settings.getByRole('navigation').getByRole('button', { name: 'This Project', exact: true }).click()
  await expect(select).toHaveValue('test.openfile')
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  const file = join(projectDir, 'notes.txt')
  writeFileSync(file, 'one\n')
  // The Sessions panel is the bundled cockpit.sessions plugin's (default zone left); its file click
  // goes through ctx.sessions.openFile to the project's open-file pick, the reviewer here.
  await page.locator('.zone-left').getByRole('button', { name: /^Sessions/ }).click()
  const sessionsPanel = page.frameLocator('section.panel[aria-label="Sessions"] iframe')
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/edit ${file}`)
  await expect(sessionsPanel.locator('.file')).toHaveCount(1)
  await sessionsPanel.getByRole('button', { name: file }).click()
  await expect.poll(() => seen().map((r) => r.path), { timeout: 10_000 }).toEqual(['notes.txt'])
  expect(await stack(cockpit)).toEqual([])
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
