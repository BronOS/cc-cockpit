// The bundled editor (cockpit.editor, design-editor.md) over the real app on the desktop: a file tab
// from the Files panel's Edit button and from `ccc edit`, typing, autosave to disk, a change on disk
// while the tab is clean (reload), while it has edits (merge, conflict), a language server's
// diagnostics (the fake one of plugins/editor/test/fixtures/fake-lsp.mjs, set through the editor's
// `servers` app setting: no real server is needed), the close question of a tab with unsaved text,
// the quit question, and quick chat against the fake `claude` of plugins/editor/test/fixtures.
//
// The editor page is a plugin page tab: a sandboxed iframe in the page's layer (`iframe.page-tab-frame`,
// hidden while its tab is not the shown one), so the selectors go through `frameLocator`.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
import { pageTabOfFrameName } from '../../src/shared/page-tabs'
import { expect, launchCockpit, test, type Cockpit, type LaunchOptions } from './fixtures'

const REPO = resolve(__dirname, '../..')
const FAKE_LSP = join(REPO, 'plugins/editor/test/fixtures/fake-lsp.mjs')
const FAKE_CLAUDE = join(REPO, 'plugins/editor/test/fixtures/fake-claude.mjs')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** The shown page tab's page (the one iframe not hidden). */
const editorFrame = (page: Page) => page.frameLocator('iframe.page-tab-frame:not([hidden])')

/** The editor plugin's `app` settings, written into app.json before the app starts. */
function editorSettings(app: Record<string, unknown>): LaunchOptions['settings'] {
  return { pluginSettings: { 'cockpit.editor': app } }
}

async function waitForEditor(c: Cockpit): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === 'cockpit.editor')?.state, {
      timeout: 15_000
    })
    .toBe('active')
}

/** The Files panel's Edit button for `name` (the tree opens the left zone's panel first). */
async function editFromFiles(c: Cockpit, name: string): Promise<void> {
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.find((p) => p.id === 'cockpit.files')?.state, {
      timeout: 15_000
    })
    .toBe('active')
  const section = c.page.locator('section.panel[aria-label="Files"]')
  if (!(await section.isVisible())) await c.page.locator('.zone-left').getByRole('button', { name: /^Files/ }).click()
  const tree = c.page.frameLocator('section.panel[aria-label="Files"] iframe')
  const row = tree.locator('.row', { has: tree.locator('.name', { hasText: new RegExp(`^${name}$`) }) })
  await row.hover()
  await row.getByRole('button', { name: 'Edit' }).click()
}

/**
 * Focus the buffer and put the cursor at the very start. The pointer comes in over the shell just
 * above the frame, as a person's does: a click whose pointer jumped into the frame leaves the shell no
 * evidence (frame-focus.ts), and once the focus moved within the shell (a button focused) even the
 * focused tab's own frame is refused then.
 */
async function toStart(c: Cockpit): Promise<void> {
  const content = editorFrame(c.page).locator('.cm-content')
  const box = await c.page.locator('iframe.page-tab-frame:visible').boundingBox()
  if (box) await c.page.mouse.move(box.x + 40, box.y - 8)
  await content.click()
  await c.page.keyboard.press(`${MOD}+Home`)
}

const stateOf = (c: Cockpit) => editorFrame(c.page).locator('#state')

/**
 * A chord as a person types it: a native key event into the window's webContents, which main's
 * `before-input-event` sees before any frame does (index.ts, page-tab-keys.ts). Playwright's own
 * keyboard is dispatched over DevTools and is not what that listener is about, so a test of the
 * forwarding goes this way (as reviewer-views.spec.ts does for Esc).
 */
async function nativeChord(c: Cockpit, keyCode: string, modifiers: Array<'control' | 'meta' | 'shift' | 'alt'>): Promise<void> {
  await c.app.evaluate(
    ({ BrowserWindow }, { keyCode, modifiers }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    },
    { keyCode, modifiers }
  )
}
const NATIVE_MOD = process.platform === 'darwin' ? 'meta' : 'control'

/** The suite must not read the developer's git config (same shape as bundled-plugins.spec.ts). */
const git = (cwd: string, ...args: string[]): void => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  delete env.XDG_CONFIG_HOME
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore', env })
}

/**
 * Folders a test needs before the app starts (outside the cockpit's root, which only exists once
 * launchCockpit made it), removed after each test so a run leaves nothing in the temp dir.
 */
const ownTemp: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  ownTemp.push(dir)
  return dir
}

test.describe('editor, desktop', () => {
  test.afterEach(() => {
    for (const dir of ownTemp.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('Files > Edit opens a sandboxed file tab; typing autosaves to disk; a change on disk reloads a clean tab; app chords typed in it reach the shell', async () => {
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 1 })
    })
    try {
      const { page, projectDir } = c
      const file = join(projectDir, 'notes.txt')
      writeFileSync(file, 'one\ntwo\nthree\n')
      await waitForEditor(c)
      await editFromFiles(c, 'notes.txt')

      // The tab is the file's name, selected, and its page shows the file.
      await expect(page.getByRole('tab', { name: /notes\.txt/ })).toHaveAttribute('aria-selected', 'true')
      const frame = editorFrame(page)
      await expect(frame.locator('#path')).toHaveText('notes.txt')
      await expect(frame.locator('.cm-content')).toContainText('three')
      await expect(stateOf(c)).toHaveText('Saved')

      // Type: Unsaved at once, then the idle autosave writes the file and says Saved.
      await toStart(c)
      await page.keyboard.type('ABC ')
      await expect(stateOf(c)).toHaveAttribute('data-status', /unsaved|saving/)
      await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toBe('ABC one\ntwo\nthree\n')
      await expect(stateOf(c)).toHaveText('Saved')

      // Claude (here: the test) writes the file while the tab has no edits: the page shows it, no merge.
      writeFileSync(file, 'ABC one\ntwo\nthree\nfour from disk\n')
      await expect(frame.locator('.cm-content')).toContainText('four from disk', { timeout: 10_000 })
      await expect(stateOf(c)).toHaveText('Saved')
      expect(readFileSync(file, 'utf8')).toBe('ABC one\ntwo\nthree\nfour from disk\n')

      // The page's frame is sandboxed as every plugin frame is: scripts only, never same-origin (a
      // plugin page with its parent's origin could reach into the shell), and named after its tab so
      // main knows whose frame has the keyboard (page-tab-keys.ts PageTabFrameTabs).
      const iframe = page.locator('iframe.page-tab-frame:not([hidden])')
      await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
      const frameName = await iframe.getAttribute('name')
      expect(frameName === null ? undefined : pageTabOfFrameName(frameName)).toMatch(/^[0-9a-f-]{36}$/)

      // App chords typed in the editor reach the shell, not the page (main's before-input-event,
      // page-tab-keys.ts): a sandboxed frame keeps its key events, so without that wiring Cmd+W or
      // Cmd+Shift+T in a file tab would do nothing. A recorder in the page proves the page never saw
      // the chord's key (a lone modifier's keydown does reach it: it is no chord yet).
      const pageFrame = page.frame({ name: frameName ?? '' })
      if (!pageFrame) throw new Error('no page tab frame')
      await pageFrame.evaluate(() => {
        const w = window as unknown as { seenKeys: string[] }
        w.seenKeys = []
        window.addEventListener('keydown', (e) => w.seenKeys.push(e.key), true)
      })
      const seenKeys = () => pageFrame.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)
      await toStart(c)
      await nativeChord(c, 'T', [NATIVE_MOD, 'shift'])
      await expect(page.getByRole('tab', { name: /Shell/ })).toHaveAttribute('aria-selected', 'true')
      await c.waitForTerminalText('FAKE-SHELL ready')
      expect((await seenKeys()).filter((k) => k.toLowerCase() === 't')).toEqual([])
      // Back in the file, the cursor in the buffer: Cmd+W closes the clean file tab, no question.
      await page.getByRole('tab', { name: /notes\.txt/ }).click()
      await toStart(c)
      await nativeChord(c, 'W', [NATIVE_MOD])
      await expect(page.getByRole('tab', { name: /notes\.txt/ })).toHaveCount(0)
      await expect(page.getByRole('tab')).toHaveCount(1)
      expect(readFileSync(file, 'utf8')).toBe('ABC one\ntwo\nthree\nfour from disk\n')
    } finally {
      await close()
    }
  })

  test('a change on disk while the tab has edits merges cleanly or shows conflicts; nothing is overwritten', async () => {
    // Idle autosave off and no save on blur: the edits stay unsaved until the test says so.
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 0, autosaveOnBlur: false })
    })
    try {
      const { page, projectDir } = c
      const file = join(projectDir, 'merge.txt')
      writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\n')
      await waitForEditor(c)
      await editFromFiles(c, 'merge.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('five')

      // Edits on line 1, then Claude edits line 5: three-way merge, saved at once with a notice.
      await toStart(c)
      await page.keyboard.type('mine ')
      await expect(stateOf(c)).toHaveText('Unsaved')
      expect(readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\nfour\nfive\n')
      writeFileSync(file, 'one\ntwo\nthree\nfour\nfive changed by claude\n')
      await expect(frame.locator('#bar')).toContainText("Merged Claude's changes.", { timeout: 10_000 })
      await expect
        .poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 })
        .toBe('mine one\ntwo\nthree\nfour\nfive changed by claude\n')
      await expect(frame.locator('.cm-content')).toContainText('five changed by claude')

      // Edits on line 1 again, and Claude edits the SAME line: a conflict. Nothing is saved until
      // it is resolved, and disk keeps Claude's line.
      await toStart(c)
      await page.keyboard.type('again ')
      await expect(stateOf(c)).toHaveText('Unsaved')
      writeFileSync(file, 'claude line one\ntwo\nthree\nfour\nfive changed by claude\n')
      const bar = frame.locator('#bar')
      await expect(bar).toContainText('One conflict', { timeout: 10_000 })
      await expect(bar).toContainText('Nothing is saved until all are resolved')
      expect(readFileSync(file, 'utf8')).toBe('claude line one\ntwo\nthree\nfour\nfive changed by claude\n')
      // Claude's version is shown in the text, next to mine.
      await expect(frame.locator('.cm-content')).toContainText('claude line one')

      // Keep all mine: the conflict is resolved to my text; autosave is off, so Ctrl+S saves it
      // (over theirs: the person chose it).
      await bar.getByRole('button', { name: 'Keep all mine' }).click()
      await expect(bar).toBeHidden({ timeout: 10_000 })
      await expect(stateOf(c)).toHaveText('Unsaved')
      expect(readFileSync(file, 'utf8')).toBe('claude line one\ntwo\nthree\nfour\nfive changed by claude\n')
      await frame.locator('.cm-content').click()
      await page.keyboard.press(`${MOD}+s`)
      await expect
        .poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 })
        .toBe('again mine one\ntwo\nthree\nfour\nfive changed by claude\n')
      await expect(stateOf(c)).toHaveText('Saved')
    } finally {
      await close()
    }
  })

  test('`ccc edit path:line:col` opens the tab marked, not selected, at the line; the fake language server reports diagnostics', async () => {
    const lspLog = join(tempDir('ccc-e2e-lsp-'), 'lsp.log')
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({
        autosaveIdleSeconds: 0,
        servers: [{ language: 'typescript', extensions: 'ts', argv: [process.execPath, FAKE_LSP, '--log', lspLog] }]
      })
    })
    try {
      const { page, projectDir } = c
      mkdirSync(join(projectDir, 'src'))
      const lines = Array.from({ length: 600 }, (_, i) => `const line${i + 1} = ${i + 1}`)
      writeFileSync(join(projectDir, 'src', 'a.ts'), lines.join('\n') + '\n')
      await waitForEditor(c)
      await c.newTab('shell')
      await c.waitForTerminalText('FAKE-SHELL ready')

      // From a terminal in the project: the tab opens beside the shell tab and does not take the selection.
      await c.typeLine('ccc edit src/a.ts:300:7')
      await c.waitForTerminalText('src/a.ts:300:7 is open in the editor')
      const fileTab = page.getByRole('tab', { name: /a\.ts/ })
      await expect(fileTab).toBeVisible()
      await expect(fileTab).toHaveAttribute('aria-selected', 'false')
      await expect(page.getByRole('tab', { name: /Shell/ })).toHaveAttribute('aria-selected', 'true')
      // Main marks it: the unseen dot, until a view shows the tab.
      expect((await c.hook<Array<{ kind: string; unseen?: boolean }>>('tabs', projectDir)).find((t) => t.kind === 'page')?.unseen).toBe(true)

      // A file that is not there is told, nothing opens.
      await c.typeLine('ccc edit src/missing.ts; echo "exit=$?"')
      await c.waitForTerminalText('exit=1')
      await expect(page.getByRole('tab')).toHaveCount(2)

      // Selecting the tab mounts its page: it shows line 300 (scrolled there), and the fake server reports.
      await fileTab.click()
      await expect.poll(async () => (await c.hook<Array<{ kind: string; unseen?: boolean }>>('tabs', projectDir)).find((t) => t.kind === 'page')?.unseen).toBeUndefined()
      const frame = editorFrame(page)
      await expect(frame.locator('#path')).toHaveText('src/a.ts')
      // Line 300 of 600: the cursor's line is drawn and active, the top of the file is out of the viewport.
      await expect(frame.locator('.cm-activeLine')).toContainText('const line300 = 300', { timeout: 10_000 })
      await expect(frame.locator('.cm-content')).not.toContainText('const line1 =')
      await expect(frame.locator('#lsp')).toBeVisible({ timeout: 15_000 })
      // The fake server marks the first character of line 1 (an error), which the viewport has
      // scrolled away from: go to the top to see the mark, then hover it for the message.
      await frame.locator('.cm-content').click()
      await page.keyboard.press(`${MOD}+Home`)
      const mark = frame.locator('.cm-lintRange-error').first()
      await expect(mark).toBeVisible({ timeout: 15_000 })
      await mark.hover()
      await expect(frame.locator('.cm-tooltip-lint')).toContainText('fake', { timeout: 10_000 })
      expect(existsSync(lspLog)).toBe(true)
      const sent = readFileSync(lspLog, 'utf8')
      expect(sent).toContain('"method":"initialize"')
      expect(sent).toContain('textDocument/didOpen')
      expect(sent).toContain('src/a.ts')
    } finally {
      await close()
    }
  })

  test('a quit and relaunch brings a file tab back (type and params), and selecting it shows the file at its line', async () => {
    // Own launches over one data dir (as restore.spec.ts); a relaunch keeps the first run's app.json.
    const first = await launchCockpit({ env: { CC_COCKPIT_NO_BUNDLED: '' }, settings: editorSettings({ autosaveIdleSeconds: 0 }) })
    const root = first.cockpit.root
    const lines = Array.from({ length: 400 }, (_, i) => `const row${i + 1} = ${i + 1}`)
    try {
      const c = first.cockpit
      writeFileSync(join(c.projectDir, 'big.ts'), lines.join('\n') + '\n')
      await waitForEditor(c)
      await c.newTab('shell')
      await c.waitForTerminalText('FAKE-SHELL ready')
      await c.typeLine('ccc edit big.ts:250')
      await c.waitForTerminalText('big.ts:250 is open in the editor')
      await expect(c.page.getByRole('tab', { name: /big\.ts/ })).toBeVisible()
    } finally {
      await first.close({ keepFiles: true })
    }

    const second = await launchCockpit({ root, folderArg: false, env: { CC_COCKPIT_NO_BUNDLED: '' } })
    try {
      const c = second.cockpit
      await waitForEditor(c)
      // Not mounted at restore: the tab is there, its page loads when it is selected.
      const fileTab = c.page.getByRole('tab', { name: /big\.ts/ })
      await expect(fileTab).toBeVisible({ timeout: 15_000 })
      await fileTab.click()
      const frame = editorFrame(c.page)
      await expect(frame.locator('#path')).toHaveText('big.ts', { timeout: 15_000 })
      await expect(frame.locator('.cm-content')).toContainText('const row250 = 250', { timeout: 10_000 })
    } finally {
      await second.close()
    }
  })

  // Review finding (Task 19): basicSetup's rectangularSelection takes every Alt+left press, so whether
  // Alt+click still adds a cursor rests on its style honouring clickAddsSelectionRange. Both, for real.
  test('Alt+click adds a cursor; Alt+drag still selects a column, beside the cursors already there', async () => {
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 0, autosaveOnBlur: false })
    })
    try {
      const { page, projectDir } = c
      const file = join(projectDir, 'cursors.txt')
      writeFileSync(file, 'abcd\nefgh\nijkl\n')
      await waitForEditor(c)
      await editFromFiles(c, 'cursors.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('ijkl')
      const line = (text: string) => frame.locator('.cm-line', { hasText: text })

      // A cursor at the start of line 1, then Alt+click the start of lines 2 and 3 (x 9 is inside the line's
      // text, past the gutters, on the left half of its first letter). One typed letter lands at all three.
      await toStart(c)
      await line('efgh').click({ modifiers: ['Alt'], position: { x: 9, y: 4 } })
      await line('ijkl').click({ modifiers: ['Alt'], position: { x: 9, y: 4 } })
      await page.keyboard.type('X')
      await expect(frame.locator('.cm-content')).toContainText('XabcdXefghXijkl')

      // Back to one cursor at the end of the file (its empty last line), then Alt+drag down the left
      // edge of lines 1 to 3: a zero-width column, a cursor on each, added to the one at the end.
      await page.keyboard.press('Escape')
      await page.keyboard.press(`${MOD}+End`)
      const top = await line('Xabcd').boundingBox()
      const bottom = await line('Xijkl').boundingBox()
      if (!top || !bottom) throw new Error('no line boxes')
      await page.keyboard.down('Alt')
      await page.mouse.move(top.x + 1, top.y + top.height / 2)
      await page.mouse.down()
      await page.mouse.move(bottom.x + 1, bottom.y + bottom.height / 2, { steps: 5 })
      await page.mouse.up()
      await page.keyboard.up('Alt')
      await page.keyboard.type('Y')
      await page.keyboard.press(`${MOD}+s`)
      await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toBe('YXabcd\nYXefgh\nYXijkl\nY')
    } finally {
      await close()
    }
  })

  test('closing a tab with unsaved text asks; Cancel keeps it, Discard drops it and the file is untouched; quit and a window reopen ask too', async () => {
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 0, autosaveOnBlur: false })
    })
    try {
      const { page, projectDir } = c
      const file = join(projectDir, 'draft.txt')
      writeFileSync(file, 'original\n')
      await waitForEditor(c)
      await editFromFiles(c, 'draft.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('original')
      await toStart(c)
      await page.keyboard.type('edited ')
      await expect(stateOf(c)).toHaveText('Unsaved')
      // The tab shows the dot the page set (core draws it) and main knows the tab is dirty.
      await expect.poll(async () => (await c.hook<Array<{ dirty?: boolean }>>('tabs', projectDir)).some((t) => t.dirty === true)).toBe(true)

      // The × asks whatever the "ask before closing" setting says (it is off in this run).
      const dialog = page.getByRole('alertdialog')
      await page.getByRole('button', { name: /^Close draft\.txt/ }).click()
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText('Close “draft.txt”?')
      await expect(dialog).toContainText(/unsaved/i)
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
      await dialog.getByRole('button', { name: 'Cancel' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(page.getByRole('tab', { name: /draft\.txt/ })).toBeVisible()
      await expect(frame.locator('.cm-content')).toContainText('edited original')

      // Quit asks as well (the test run's box answers what the test queued, and records what it said).
      await c.hook('answerUnsaved', false)
      await c.app.evaluate(({ app }) => app.quit())
      await expect.poll(() => c.hook<Array<{ titles: string[]; kind: string }>>('unsavedAsks')).toHaveLength(1)
      expect((await c.hook<Array<{ titles: string[]; kind: string }>>('unsavedAsks'))[0]).toMatchObject({ kind: 'quit', titles: ['draft.txt'] })
      // Cancel: the app is still here with the tab and its text.
      await expect(frame.locator('.cm-content')).toContainText('edited original')
      expect(readFileSync(file, 'utf8')).toBe('original\n')

      // Settings › Window's "Reopen window" (window.reopen) makes the window again, which would end the
      // page's buffer: it asks the same way, and Cancel (the test box's default for a reopen) keeps
      // this window, its tab and its text.
      const windowIds = (): Promise<number[]> => c.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.id))
      const before = await windowIds()
      await page.evaluate<void>(`window.cockpit.invoke('window.reopen')`)
      await expect.poll(() => c.hook<Array<{ titles: string[]; kind: string }>>('unsavedAsks')).toHaveLength(2)
      expect((await c.hook<Array<{ titles: string[]; kind: string }>>('unsavedAsks'))[1]).toMatchObject({ kind: 'reopen', titles: ['draft.txt'] })
      expect(page.isClosed()).toBe(false)
      expect(await windowIds()).toEqual(before)
      await expect(frame.locator('.cm-content')).toContainText('edited original')
      await expect(stateOf(c)).toHaveText('Unsaved')

      // Discard and Close on the tab: it goes, the file keeps what is on disk.
      await page.getByRole('button', { name: /^Close draft\.txt/ }).click()
      await dialog.getByRole('button', { name: 'Discard and Close' }).click()
      await expect(page.getByRole('tab', { name: /draft\.txt/ })).toHaveCount(0)
      expect(readFileSync(file, 'utf8')).toBe('original\n')
      expect(await c.hook<unknown[]>('tabs', projectDir)).toEqual([])
    } finally {
      await close()
    }
  })

  test('find in files opens from the keyboard (Ctrl+Shift+H) and the context menu; a mixed-EOL file loads clean and is never rewritten', async () => {
    // Autosave on blur: a buffer that differed from its base at load would be written back on the first blur.
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 1, autosaveOnBlur: true })
    })
    try {
      const { page, projectDir } = c
      const mixed = 'one\r\ntwo\nthree\rfour\nfive\r\n'
      writeFileSync(join(projectDir, 'mixed.txt'), mixed)
      writeFileSync(join(projectDir, 'other.txt'), 'alpha\nneedle here\nomega\n')
      await waitForEditor(c)
      await editFromFiles(c, 'mixed.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('five')
      await expect(stateOf(c)).toHaveText('Saved')

      // Ctrl+Shift+H: the find palette (Ctrl+Shift+F is Toggle Tab Flag in the default table).
      await frame.locator('.cm-content').click()
      await page.keyboard.press(`${MOD}+Shift+H`)
      const palette = frame.locator('#palette')
      await expect(palette).toBeVisible()
      await expect(frame.locator('#palette-toggles')).toBeVisible()
      await frame.locator('#palette-query').fill('needle')
      const match = palette.locator('li.row.match', { hasText: 'needle here' })
      await expect(match).toBeVisible({ timeout: 10_000 })
      await expect(palette.locator('li.group', { hasText: 'other.txt' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette).toBeHidden()

      // The same from the context menu.
      await frame.locator('.cm-content').click({ button: 'right' })
      await frame.getByRole('menuitem', { name: /Find in files/ }).click()
      await expect(palette).toBeVisible()
      await expect(frame.locator('#palette-toggles')).toBeVisible()
      await page.keyboard.press('Escape')

      // The mixed file was never dirty: leaving the tab (a blur) saved nothing, its CRs are all there.
      await expect(stateOf(c)).toHaveText('Saved')
      await page.getByRole('button', { name: /new tab/i }).first().focus()
      await page.waitForTimeout(1500)
      expect(readFileSync(join(projectDir, 'mixed.txt'), 'utf8')).toBe(mixed)
      // An edit keeps the other lines' endings as they were.
      await toStart(c)
      await page.keyboard.type('X')
      await expect.poll(() => readFileSync(join(projectDir, 'mixed.txt'), 'utf8'), { timeout: 10_000 }).toBe(`X${mixed}`)
    } finally {
      await close()
    }
  })

  test('quick chat: Ctrl+K asks Claude about the line, a proposal is accepted into the buffer only', async () => {
    // The fake `claude` of the editor's own tests, found first on the login-shell PATH as `claude`.
    const bin = tempDir('ccc-e2e-claude-bin-')
    const shim = join(bin, 'claude')
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`)
    chmodSync(shim, 0o755)
    const { cockpit: c, close } = await launchCockpit({
      env: {
        CC_COCKPIT_NO_BUNDLED: '',
        PATH: [bin, join(REPO, 'test/fixtures/bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter)
      },
      settings: editorSettings({ autosaveIdleSeconds: 0, autosaveOnBlur: false })
    })
    try {
      const { page, projectDir } = c
      const file = join(projectDir, 'chat.txt')
      writeFileSync(file, 'first line\nsecond line\nthird line\n')
      await waitForEditor(c)
      await editFromFiles(c, 'chat.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('third line')

      // The cursor on line 2; Ctrl+K opens the chat docked under the editor.
      await frame.locator('.cm-line', { hasText: 'second line' }).click()
      await page.keyboard.press(`${MOD}+k`)
      const chat = frame.locator('#chat')
      await expect(chat).toBeVisible()
      await expect(chat.locator('#chat-input')).toBeFocused()
      await chat.locator('#chat-input').fill('PROPOSE please')
      await chat.getByRole('button', { name: 'Send' }).click()

      // The fake answers with a `replacement` block: a proposal card with Accept, an inline diff in the buffer.
      const accept = chat.getByRole('button', { name: 'Accept' })
      await expect(accept).toBeVisible({ timeout: 20_000 })
      // Nothing is written by asking: the buffer is as it was and so is the file.
      await expect(stateOf(c)).toHaveText('Saved')
      expect(readFileSync(file, 'utf8')).toBe('first line\nsecond line\nthird line\n')

      // Accept puts the text in the BUFFER (unsaved); the file changes only when the tab saves.
      await accept.click()
      await expect(stateOf(c)).toHaveText('Unsaved')
      expect(readFileSync(file, 'utf8')).toBe('first line\nsecond line\nthird line\n')
      await expect(frame.locator('.cm-content')).not.toContainText('second line')
      await expect(frame.locator('.cm-content')).toContainText('NEW ```x```')
      await page.keyboard.press(`${MOD}+s`)
      await expect(stateOf(c)).toHaveText('Saved', { timeout: 10_000 })
      // The fake's replacement ("NEW ```x```" and "line 2") took the place of the cursor's line.
      expect(readFileSync(file, 'utf8')).toBe('first line\nNEW ```x```\nline 2\nthird line\n')
    } finally {
      await close()
    }
  })

  test("Claude's changes and the Reviewer's notes in the gutter (hover, a click opens the diff); Ctrl+P opens another file; Ctrl+L asks Claude and gives the keyboard back", async () => {
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 0, autosaveOnBlur: false })
    })
    try {
      const { page, projectDir } = c
      // A repository with both files committed, then a working-tree change on line 2 of a.txt: the
      // editor reads HEAD's text through git (lib/git.js) and draws the difference from the buffer.
      const file = join(projectDir, 'a.txt')
      writeFileSync(file, 'one\ntwo\nthree\n')
      writeFileSync(join(projectDir, 'b.txt'), 'bee\n')
      git(projectDir, 'init', '-q')
      git(projectDir, 'add', '-A')
      git(projectDir, 'commit', '-q', '-m', 'first')
      writeFileSync(file, 'one\nTWO\nthree\n')
      await waitForEditor(c)
      await expect
        .poll(async () => (await c.hook<HostStatus>('hostStatus', projectDir)).plugins.find((p) => p.id === 'cockpit.reviewer')?.state, {
          timeout: 15_000
        })
        .toBe('active')
      await editFromFiles(c, 'a.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('three')

      // A modified bar on line 2 only; hovering it shows the line as HEAD has it.
      const bar = frame.locator('.cc-changes-gutter .cc-change-modified')
      await expect(bar).toHaveCount(1, { timeout: 15_000 })
      await bar.hover()
      const changePop = frame.locator('.cc-change-pop')
      await expect(changePop).toContainText('Changed since the last commit')
      await expect(changePop.locator('.cc-change-pop-old')).toHaveText('two')
      await expect(changePop).toContainText('Click to open the diff')

      // A review note from the context menu, stored by the bundled Reviewer through its `reviewer`
      // service. The item shows only once the host said a Reviewer answers (notes.mjs `has`), which
      // may come after the page's first paint, so the menu is opened again until it is there.
      await frame.locator('.cm-line', { hasText: 'three' }).click()
      const addNote = frame.getByRole('menuitem', { name: /Add review note/ })
      await expect(async () => {
        await page.keyboard.press('Escape')
        await frame.locator('.cm-line', { hasText: 'three' }).click({ button: 'right' })
        await expect(addNote).toBeVisible({ timeout: 1000 })
      }).toPass({ timeout: 15_000 })
      await addNote.click()
      const box = frame.getByRole('dialog', { name: 'Add review note' })
      await expect(box).toContainText('Review note on line 3')
      await box.locator('#notebox-text').fill('say it in full')
      await box.getByRole('button', { name: 'Add note' }).click()
      await expect(box).toBeHidden({ timeout: 10_000 })
      // The Reviewer's list comes back to the gutter: a mark on line 3, its text on hover.
      const noteMark = frame.locator('.cc-notes-gutter [aria-label="Review note"]')
      await expect(noteMark).toHaveCount(1, { timeout: 15_000 })
      await noteMark.hover()
      const notePop = frame.locator('.cc-note-pop')
      await expect(notePop).toContainText('Review note, line 3')
      await expect(notePop).toContainText('say it in full')
      // Nothing of this touched the file.
      expect(readFileSync(file, 'utf8')).toBe('one\nTWO\nthree\n')

      // A click on the bar opens the Reviewer's diff of the file (the `reviewer` service's open).
      await bar.click()
      await expect
        .poll(async () => (await c.hook<OverlayInfo[]>('overlays', projectDir)).map((o) => o.title), { timeout: 15_000 })
        .toEqual(['Review: a.txt'])
      await nativeChord(c, 'Escape', [])
      await expect.poll(async () => (await c.hook<OverlayInfo[]>('overlays', projectDir)).length).toBe(0)

      // Ctrl+P: quick open lists the project's files (rg); picking b.txt opens its own tab.
      await frame.locator('.cm-content').click()
      await page.keyboard.press(`${MOD}+p`)
      const palette = frame.locator('#palette')
      await expect(palette).toBeVisible()
      await frame.locator('#palette-query').fill('b.txt')
      await expect(palette.locator('li.row', { hasText: 'b.txt' })).toBeVisible({ timeout: 10_000 })
      await page.keyboard.press('Enter')
      await expect(page.getByRole('tab', { name: /b\.txt/ })).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 })
      await expect(frame.locator('#path')).toHaveText('b.txt')
      await expect(frame.locator('.cm-content')).toContainText('bee')

      // Ctrl+L: core's Discuss box for the page tab (PageTabDiscussDialog) over the shell. Esc cancels
      // it and the keyboard goes back to the editor, where the cursor was: the next key is typing.
      await toStart(c)
      await page.keyboard.press(`${MOD}+l`)
      const discuss = page.getByRole('dialog', { name: 'Ask Claude about “b.txt”' })
      await expect(discuss).toBeVisible()
      await expect(discuss.getByRole('textbox', { name: 'Your question' })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(discuss).toHaveCount(0)
      // The shell hands the frame the keyboard a frame after the box goes (TabsPane focusActive), and
      // the page puts it in the buffer (file.js refocusAfterInert: the inert layer under the box had
      // dropped the frame's own focus). Typing before that would go to the shell's body.
      await expect(frame.locator('.cm-content')).toBeFocused()
      await expect.poll(() => page.evaluate(() => document.activeElement?.className)).toBe('page-tab-frame')
      await page.keyboard.type('Z')
      await expect(frame.locator('.cm-content')).toContainText('Zbee')
      await expect(stateOf(c)).toHaveText('Unsaved')
      expect(readFileSync(join(projectDir, 'b.txt'), 'utf8')).toBe('bee\n')
    } finally {
      await close()
    }
  })

  // Plan Task 19's edge case for real: the buffer lives in the page, the file service in the plugin
  // host, so a host that dies (and is restarted by main after its crash backoff) must leave the
  // unsaved text where it is, still dirty, and the page must save it through the new host.
  test('the plugin host crashes and restarts under a tab with unsaved text: the text stays dirty and Ctrl+S saves it', async () => {
    const { cockpit: c, close } = await launchCockpit({
      env: { CC_COCKPIT_NO_BUNDLED: '' },
      settings: editorSettings({ autosaveIdleSeconds: 0, autosaveOnBlur: false })
    })
    try {
      const { page, projectDir } = c
      const file = join(projectDir, 'kept.txt')
      writeFileSync(file, 'base\n')
      await waitForEditor(c)
      await editFromFiles(c, 'kept.txt')
      const frame = editorFrame(page)
      await expect(frame.locator('.cm-content')).toContainText('base')
      await toStart(c)
      await page.keyboard.type('unsaved ')
      await expect(stateOf(c)).toHaveText('Unsaved')

      // The project's host is the utility process main named after it (host-manager.ts, the metrics'
      // `name`; `serviceName` is node's mojo service there); SIGKILL is a
      // crash to main, which starts a new one after its first backoff (1 s).
      const hostPids = () =>
        c.app.evaluate(({ app }) =>
          app
            .getAppMetrics()
            .filter((m) => m.type === 'Utility' && (m.name ?? '').startsWith('cc-cockpit plugin host'))
            .map((m) => m.pid)
        )
      const [before] = await hostPids()
      if (before === undefined) throw new Error('no plugin host process')
      await c.app.evaluate((_, pid) => process.kill(pid, 'SIGKILL'), before)
      await expect.poll(async () => (await hostPids()).filter((p) => p !== before).length, { timeout: 15_000 }).toBe(1)
      await waitForEditor(c)

      // The text is still the page's, unsaved, and main still counts the tab dirty; the file is as it was.
      await expect(frame.locator('.cm-content')).toContainText('unsaved base')
      await expect(stateOf(c)).toHaveText('Unsaved')
      await expect.poll(async () => (await c.hook<Array<{ dirty?: boolean }>>('tabs', projectDir)).some((t) => t.dirty === true)).toBe(true)
      expect(readFileSync(file, 'utf8')).toBe('base\n')

      // Ctrl+S goes to the new host and writes it.
      await frame.locator('.cm-content').click()
      await page.keyboard.press(`${MOD}+s`)
      await expect.poll(() => readFileSync(file, 'utf8'), { timeout: 10_000 }).toBe('unsaved base\n')
      await expect(stateOf(c)).toHaveText('Saved')
      await expect.poll(async () => (await c.hook<Array<{ dirty?: boolean }>>('tabs', projectDir)).some((t) => t.dirty === true)).toBe(false)
    } finally {
      await close()
    }
  })
})
