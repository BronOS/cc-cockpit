// The bundled editor (cockpit.editor, design-editor.md) over the real app on the desktop: a file tab
// from the Files panel's Edit button and from `ccc edit`, typing, autosave to disk, a change on disk
// while the tab is clean (reload), while it has edits (merge, conflict), a language server's
// diagnostics (the fake one of plugins/editor/test/fixtures/fake-lsp.mjs, set through the editor's
// `servers` app setting: no real server is needed), the close question of a tab with unsaved text,
// the quit question, and quick chat against the fake `claude` of plugins/editor/test/fixtures.
//
// The editor page is a plugin page tab: a sandboxed iframe in the page's layer (`iframe.page-tab-frame`,
// hidden while its tab is not the shown one), so the selectors go through `frameLocator`.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import type { HostStatus } from '../../src/main/plugins/host-manager'
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

/** Focus the buffer and put the cursor at the very start. */
async function toStart(c: Cockpit): Promise<void> {
  const content = editorFrame(c.page).locator('.cm-content')
  await content.click()
  await c.page.keyboard.press(`${MOD}+Home`)
}

const stateOf = (c: Cockpit) => editorFrame(c.page).locator('#state')

test.describe('editor, desktop', () => {
  test('Files > Edit opens a file tab; typing autosaves to disk; a change on disk reloads a clean tab', async () => {
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
    const lspLog = join(mkdtempSync(join(tmpdir(), 'ccc-e2e-lsp-')), 'lsp.log')
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

  test('closing a tab with unsaved text asks; Cancel keeps it, Discard drops it and the file is untouched; quit asks too', async () => {
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

  test('quick chat: Ctrl+K asks Claude about the line, a proposal is accepted into the buffer only', async () => {
    // The fake `claude` of the editor's own tests, found first on the login-shell PATH as `claude`.
    const bin = mkdtempSync(join(tmpdir(), 'ccc-e2e-claude-bin-'))
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
})
