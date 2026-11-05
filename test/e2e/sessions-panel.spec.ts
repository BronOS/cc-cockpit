// Task 20: the Sessions panel, now the bundled cockpit.sessions plugin's (design-next §4): its page in
// the panel's iframe, fed by ctx.sessions, its file click through ctx.sessions.openFile. The fake
// `claude` reports an edited file with `/edit <path>` (a PostToolUse hook); the panel lists it, and a
// click opens a terminal overlay that shows the diff (inside a git repository) or the file itself
// (outside any) when the project's "open files with" pick is the built-in viewer (the bundled
// reviewer takes the click otherwise, bundled-plugins.spec.ts).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OverlayInfo } from '../../src/shared/ipc'
import type { FrameLocator, Page } from '@playwright/test'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

// LESS=FRX is what git puts in its pager's env when LESS is unset, and F quits at once on a
// one-screen output. Set explicitly, so a developer's own LESS (often `-R`) cannot hide that. The
// bundled plugins are on (the harness turns them off by default): the panel is cockpit.sessions'.
const test = base.extend<{ cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const { cockpit, close } = await launchCockpit({ env: { LESS: 'FRX', CC_COCKPIT_NO_BUNDLED: '' } })
    try {
      await use(cockpit)
    } finally {
      await close()
    }
  }
})

/**
 * A few lines only, on purpose: git's default pager env (LESS=FRX) quits at once on output that
 * fits one screen, and the overlay closes with its program. The argv must keep it up anyway.
 */
const lines = (marker: string): string => Array.from({ length: 3 }, (_, i) => `${marker} line ${i}`).join('\n') + '\n'

/** The overlay is still up a moment after its text showed (a pager that quit would close it). */
async function staysOpen(c: Cockpit): Promise<void> {
  await c.page.waitForTimeout(1000)
  await expect(c.page.locator('.overlay[data-kind="terminal"]')).toBeVisible()
  expect(await stack(c)).toHaveLength(1)
}

const git = (cwd: string, ...args: string[]): void => {
  // The suite must not read the developer's git config either. HOME alone is not enough (git also
  // reads $XDG_CONFIG_HOME/git/config, and GIT_CONFIG_GLOBAL wins over both): the global file is
  // /dev/null, the system one is off and XDG_CONFIG_HOME is dropped.
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore', env })
}

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)

const invoke = (page: Page, channel: string, req: unknown): Promise<unknown> =>
  page.evaluate(`window.cockpit.invoke(${JSON.stringify(channel)}, ${JSON.stringify(req)})`)

/** The panel's page (the plugin's sessions.html in its sandboxed iframe). */
const panel = (c: Cockpit): FrameLocator => c.page.frameLocator('section.panel[aria-label="Sessions"] iframe')

/** Open the plugin's Sessions panel (default zone left) once its host declared it. */
async function openPanel(c: Cockpit): Promise<void> {
  const icon = c.page.locator('.zone-left').getByRole('button', { name: /^Sessions/ })
  await expect(icon).toBeVisible({ timeout: 15_000 })
  await icon.click()
  await expect(c.page.locator('.zone-left section.panel[aria-label="Sessions"]')).toBeVisible()
  await expect(panel(c).locator('main')).toBeVisible()
}

/** The project's "open files with" pick: the built-in viewer, so the bundled reviewer does not take the click. */
async function builtinViewer(c: Cockpit): Promise<void> {
  await invoke(c.page, 'settings.pluginServiceProvider', { service: '@open-file', pluginId: '@builtin' })
}

test('a file the fake claude edits shows in the panel; a click outside a repository opens it in less', async ({
  cockpit
}) => {
  const { page } = cockpit
  await builtinViewer(cockpit)
  await openPanel(cockpit)
  await expect(panel(cockpit).getByText('No Claude sessions in this window.')).toBeVisible()

  const file = join(cockpit.projectDir, 'notes.txt')
  writeFileSync(file, lines('plain'))
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/prompt tidy the notes')
  await cockpit.typeLine(`/edit ${file}`)

  const item = panel(cockpit).locator('.card')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('tidy the notes')
  // The header's meta, set by the plugin (ctx.panels.header).
  await expect(page.locator('section.panel[aria-label="Sessions"] .panel-plugin-meta')).toHaveText('1 in this window')
  const button = item.getByRole('button', { name: file })
  await expect(button).toBeVisible()

  // A double click still opens one overlay (main keeps the diffs open per window, tab and file).
  await button.dblclick()
  const overlay = page.locator('.overlay[data-kind="terminal"]')
  await expect(overlay).toBeVisible()
  // `less -- <file>`: the file's own text, no diff markers.
  await expect(overlay.locator('.xterm-rows')).toContainText('plain line 0')
  await staysOpen(cockpit)

  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)
})

test('inside a repository a click shows the diff of a tracked file and of a new one', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  mkdirSync(join(projectDir, 'src'))
  git(projectDir, 'init', '-q')
  const tracked = join(projectDir, 'src', 'tracked.txt')
  writeFileSync(tracked, lines('old'))
  git(projectDir, 'add', '.')
  git(projectDir, 'commit', '-q', '-m', 'init')
  writeFileSync(tracked, lines('old').replace('old line 1\n', 'new line 1\n'))
  const fresh = join(projectDir, 'src', 'fresh.txt')
  writeFileSync(fresh, lines('brand'))

  await builtinViewer(cockpit)
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/edit ${tracked}`)
  await cockpit.typeLine(`/edit ${fresh}`)
  await expect(panel(cockpit).locator('.file')).toHaveCount(2)

  const overlay = page.locator('.overlay[data-kind="terminal"]')
  const rows = overlay.locator('.xterm-rows')

  // Tracked: git diff -- <file>; a 3-line file with one line changed fits one screen.
  await panel(cockpit).getByRole('button', { name: tracked }).click()
  await expect(overlay).toBeVisible()
  await expect(rows).toContainText('-old line 1')
  await expect(rows).toContainText('+new line 1')
  await staysOpen(cockpit)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)

  // Untracked: git diff --no-index -- /dev/null <file>; all of it is added.
  await panel(cockpit).getByRole('button', { name: fresh }).click()
  await expect(overlay).toBeVisible()
  await expect(rows).toContainText('+brand line 0')
  await staysOpen(cockpit)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)

  // Committed since: an empty diff still leaves the overlay up (an empty pager screen).
  git(projectDir, 'commit', '-q', '-am', 'edit')
  await panel(cockpit).getByRole('button', { name: tracked }).click()
  await expect(overlay).toBeVisible()
  await staysOpen(cockpit)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)
})

test('a question from Claude reads as needing you on the card and the tab dot', async ({ cockpit }) => {
  const { page } = cockpit
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/prompt plan it')
  await cockpit.typeLine('/tool AskUserQuestion')
  const item = panel(cockpit).locator('.card')
  await expect(item).toHaveAttribute('data-status', 'needs-permission')
  await expect(item.locator('.status')).toHaveText('needs you · question')
  await expect(page.locator('.tab .status-dot')).toHaveAttribute('title', 'needs you · question')

  await cockpit.typeLine('/done AskUserQuestion')
  await expect(item.locator('.status')).toHaveText('working')
  await cockpit.typeLine('/tool ExitPlanMode')
  await expect(item.locator('.status')).toHaveText('needs you · plan approval')
})

test('the card shows a pasted prompt without Claude\'s paste wrapper', async ({ cockpit }) => {
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/stop')
  await expect(panel(cockpit).locator('.card')).toHaveAttribute('data-status', 'waiting')
  const [tab] = await cockpit.hook<Array<{ tabId: string }>>('sessions', cockpit.projectDir)
  // The fake submits a paste as the prompt verbatim, as Claude reports a wrapped paste.
  await cockpit.hook('send', tab?.tabId, 'look:\n<pasted_content id="91a8">\nnpm ERR!\n</pasted_content id="91a8">\nthanks')
  const prompt = panel(cockpit).locator('.card .summary')
  await expect(prompt).toHaveText(/npm ERR!/)
  await expect(prompt).not.toContainText('pasted_content')
})

test('the session title jumps to its tab', async ({ cockpit }) => {
  const { page } = cockpit
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.newTab('shell')
  const tabs = page.getByRole('tab')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await panel(cockpit).locator('.card').getByRole('button', { name: 'Claude 1' }).click()
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
})

test('the window has no channel of its own to open a session file or focus a tab: only the plugin API does', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  const outside = mkdtempSync(join(tmpdir(), 'ccc-sp-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    const tabs = await cockpit.hook<Array<{ id: string }>>('tabs', cockpit.projectDir)
    // The core panel's and strip's channels went with them (design-next §4): the preload refuses both.
    const answers = await cockpit.page.evaluate(
      async ({ tabId, file }) => {
        const api = (globalThis as unknown as { cockpit: { invoke(c: string, p: unknown): Promise<boolean> } }).cockpit
        const settle = (p: Promise<unknown>): Promise<string> => p.then(() => 'answered', () => 'refused')
        return [await settle(api.invoke('sessions.openFile', { tabId, file })), await settle(api.invoke('sessions.focus', { tabId }))]
      },
      { tabId: tabs[0]!.id, file: join(outside, 'secret.txt') }
    )
    expect(answers).toEqual(['refused', 'refused'])
    expect(await stack(cockpit)).toEqual([])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

// Friction round 1, Task 12: a plugin that declares `contributes.openFile` takes the click through
// ctx.files.onOpen (the fixture records `{ path, tabId }` in $HOME/open-file.json); the built-in
// viewer opens when its listener throws, and when the project picks "Built-in viewer" in Settings.
// The bundled reviewer opens files too, so the fixture is picked for the project first.
test('a plugin that opens files takes the click; the built-in viewer opens when it fails or is not picked', async ({ cockpit }) => {
  const { page, projectDir } = cockpit
  const seenFile = join(cockpit.root, 'home', 'open-file.json')
  const seen = (): Array<{ path: string; tabId: string }> => JSON.parse(readFileSync(seenFile, 'utf8')) as Array<{ path: string; tabId: string }>
  await cockpit.hook('linkPlugin', join(__dirname, '..', 'fixtures', 'plugins', 'open-file'))
  await cockpit.hook('enablePlugin', projectDir, 'test.openfile')
  await expect.poll(() => existsSync(seenFile), { timeout: 15_000 }).toBe(true)
  await invoke(page, 'settings.pluginServiceProvider', { service: '@open-file', pluginId: 'test.openfile' })

  mkdirSync(join(projectDir, 'src'))
  const mine = join(projectDir, 'src', 'notes.txt')
  const failing = join(projectDir, 'fail.txt')
  writeFileSync(mine, lines('mine'))
  writeFileSync(failing, lines('failing'))
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/edit ${mine}`)
  await cockpit.typeLine(`/edit ${failing}`)
  await expect(panel(cockpit).locator('.file')).toHaveCount(2)
  const [session] = await cockpit.hook<Array<{ tabId: string }>>('sessions', projectDir)

  // The plugin gets the path relative to the project and the tab the list belongs to; no overlay.
  await panel(cockpit).getByRole('button', { name: mine }).click()
  await expect.poll(seen, { timeout: 10_000 }).toEqual([{ path: 'src/notes.txt', tabId: session!.tabId }])
  await page.waitForTimeout(500)
  expect(await stack(cockpit)).toEqual([])

  // Its listener throws for this one: the built-in viewer shows the file instead.
  const overlay = page.locator('.overlay[data-kind="terminal"]')
  await panel(cockpit).getByRole('button', { name: failing }).click()
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.xterm-rows')).toContainText('failing line 0')
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)

  // Settings > Plugins: the pick offers the plugin (by its title), the reviewer and the built-in viewer.
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByRole('navigation').getByRole('button', { name: 'Plugins', exact: true }).click()
  const select = settings.getByLabel('Plugin used to open files')
  await expect(select).toHaveValue('test.openfile')
  await expect(select.locator('option')).toContainText(['Review (Open File Fixture)', 'Built-in viewer'])
  await select.selectOption('@builtin')
  await expect(select).toHaveValue('@builtin')
  await page.screenshot({ path: process.env.OPEN_FILE_SHOT ?? join(cockpit.root, 'open-file-pick.png') })
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()

  // Picked "Built-in viewer": the click opens the viewer and the plugin hears nothing.
  await panel(cockpit).getByRole('button', { name: mine }).click()
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('.xterm-rows')).toContainText('mine line 0')
  expect(seen()).toHaveLength(1)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)
})

test('past the plugin\'s "Changed files shown per session" setting the rest are behind Show all, and a change shows at once', async ({
  cockpit
}) => {
  const { page, projectDir } = cockpit
  const files = ['a.txt', 'b.txt', 'c.txt'].map((n) => join(projectDir, n))
  for (const f of files) writeFileSync(f, lines(f))
  // The plugin's own app setting (Settings › Plugins › Sessions), saved the way its form saves it.
  await invoke(page, 'settings.pluginSettingsSave', { id: 'cockpit.sessions', values: { filesShown: 2 } })
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  for (const f of files) await cockpit.typeLine(`/edit ${f}`)

  const item = panel(cockpit).locator('.card')
  await expect(item.locator('.caption')).toHaveText('3 changed files')
  await expect(item.locator('.file')).toHaveCount(2)
  const more = item.getByRole('button', { name: 'Show all (1 more)' })
  await more.click()
  await expect(item.locator('.file')).toHaveCount(3)
  await item.getByRole('button', { name: 'Hide (1)' }).click()
  await expect(item.locator('.file')).toHaveCount(2)

  // A larger setting shows them all and drops the button, without a reload of the window.
  await invoke(page, 'settings.pluginSettingsSave', { id: 'cockpit.sessions', values: { filesShown: 10 } })
  await expect(item.locator('.file')).toHaveCount(3, { timeout: 15_000 })
  await expect(item.locator('.more')).toHaveCount(0)
})
