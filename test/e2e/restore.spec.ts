// Task 22: windows and tabs come back after a quit. The app is closed and started again over the
// same data dir (the fixtures' `root` option); the fake `claude` logs its argv, so a resumed
// session shows up as `--resume <id>`.
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'

/** The tabs saved in the project's record on disk (what the next start reads). */
function savedTabs(c: Cockpit): Array<{ kind: string; cwd: string; sessionId?: string }> {
  const dir = join(c.dataDir, 'projects')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return [] // the debounced writer has not created the folder yet
  }
  for (const name of names) {
    if (!/^[0-9a-f]{16}\.json$/.test(name)) continue
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      path: string
      tabs: Array<{ kind: string; cwd: string; sessionId?: string }>
    }
    if (record.path === c.projectDir) return record.tabs
  }
  return []
}

test('a quit and relaunch brings the windows and tabs back, resuming the Claude session', async () => {
  // Own launches: this test starts the app twice over one data dir.
  const first = await launchCockpit()
  const root = first.cockpit.root
  let sessionId: string
  try {
    const c = first.cockpit
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    // A prompt makes the session resumable (its SessionStart alone does not: Claude refuses to
    // resume a session nobody typed into).
    await c.typeLine('/prompt hello')
    await c.waitForTerminalText('FAKE-CLAUDE hook UserPromptSubmit')
    await c.newTab('shell')
    // The fake's SessionStart hook reports its session id to main.
    await expect
      .poll(async () => (await c.hook<TabInfo[]>('tabs', c.projectDir)).find((t) => t.kind === 'claude')?.sessionId)
      .toMatch(/^fake-session-\d+$/)
    sessionId = (await c.hook<TabInfo[]>('tabs', c.projectDir)).find((t) => t.kind === 'claude')!
      .sessionId!

    // Saved on every change (the debounced writer, not only at quit): both tabs, in order, with the id.
    await expect
      .poll(() => savedTabs(c).map((t) => [t.kind, t.sessionId]))
      .toEqual([
        ['claude', sessionId],
        ['shell', undefined]
      ])
    expect(c.claudeRuns()).toHaveLength(1)
  } finally {
    await first.close({ keepFiles: true })
  }

  // A plain start, no folder argument: only the restore can open this window.
  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    const tabs = c.page.getByRole('tab')
    await expect(tabs).toHaveCount(2)

    // The Claude tab resumed its session: `--resume <id>` as separate argv entries.
    await expect.poll(() => c.claudeRuns().length).toBe(2)
    expect(c.claudeRuns()[1]).toEqual(['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core'), '--resume', sessionId])
    await c.waitForTerminalText(`FAKE-CLAUDE resume=${sessionId}`)

    // The shell tab is a fresh shell, not a second claude.
    const live = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(live.map((t) => t.kind)).toEqual(['claude', 'shell'])
    expect(c.claudeRuns()).toHaveLength(2)
  } finally {
    await second.close()
  }
})

test('a Claude tab that never reported a session restarts fresh', async () => {
  const first = await launchCockpit({ env: { FAKE_CLAUDE_NO_HOOKS: '1' } })
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await expect.poll(() => savedTabs(c).map((t) => t.kind)).toEqual(['claude'])
    expect(savedTabs(c)[0]!.sessionId).toBeUndefined()
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false, env: { FAKE_CLAUDE_NO_HOOKS: '1' } })
  try {
    const c = second.cockpit
    await expect(c.page.getByRole('tab')).toHaveCount(1)
    await expect.poll(() => c.claudeRuns().length).toBe(2)
    // No id to resume: the same argv as a new tab.
    expect(c.claudeRuns()[1]).toEqual(['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core')])
  } finally {
    await second.close()
  }
})

test('a Claude tab nobody typed into restores fresh, not as a resume of an empty session', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE hook SessionStart')
    await c.newTab('shell')
    await expect.poll(() => savedTabs(c).map((t) => t.kind)).toEqual(['claude', 'shell'])
    // The SessionStart arrived (above) and still no id is saved: there is nothing to resume.
    expect(savedTabs(c)[0]!.sessionId).toBeUndefined()
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    await expect.poll(() => c.claudeRuns().length).toBe(2)
    expect(c.claudeRuns()[1]).toEqual(['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core')])
  } finally {
    await second.close()
  }
})

test('a resumed Claude that fails at start keeps the saved id: Restart runs fresh, the next launch resumes', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  let sessionId: string
  try {
    const c = first.cockpit
    await c.newTab('claude')
    await c.waitForTerminalText('FAKE-CLAUDE banner')
    await c.typeLine('/prompt hello')
    await expect.poll(() => savedTabs(c)[0]?.sessionId).toMatch(/^fake-session-\d+$/)
    sessionId = savedTabs(c)[0]!.sessionId!
  } finally {
    await first.close({ keepFiles: true })
  }

  // Every claude now dies right after its banner (exit 1, no SessionStart): what the real one does
  // on "No conversation found", and also what a launch whose PATH has no `claude` looks like.
  const second = await launchCockpit({ root, folderArg: false, env: { FAKE_CLAUDE_EXIT: '1' } })
  try {
    const c = second.cockpit
    const banner = c.page.getByRole('status')
    await expect(banner).toContainText('exited (code 1)')
    expect(c.claudeRuns()[1]).toEqual(['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core'), '--resume', sessionId])

    await banner.getByRole('button', { name: 'Restart' }).click()
    await expect.poll(() => c.claudeRuns().length).toBe(3)
    expect(c.claudeRuns()[2]).toEqual(['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core')])
    await expect(banner).toContainText('exited (code 1)')
    // No process ever reported a SessionStart, so nothing replaced the id.
    expect(savedTabs(c).map((t) => [t.kind, t.sessionId])).toEqual([['claude', sessionId]])
  } finally {
    await second.close({ keepFiles: true })
  }

  // Once claude can start again, the conversation is still linked.
  const third = await launchCockpit({ root, folderArg: false })
  try {
    const c = third.cockpit
    await expect.poll(() => c.claudeRuns().length).toBe(4)
    expect(c.claudeRuns()[3]).toEqual(['--settings', join(c.dataDir, 'hooks.json'), '--plugin-dir', join(c.dataDir, 'claude-plugins', 'core'), '--resume', sessionId])
  } finally {
    await third.close()
  }
})

test('a project whose folder is gone opens the picker with relink and forget; forget removes it', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.newTab('shell')
    await expect.poll(() => savedTabs(c).length).toBe(1)
  } finally {
    await first.close({ keepFiles: true })
  }
  rmSync(join(root, 'project'), { recursive: true, force: true })

  const second = await launchCockpit({ root, folderArg: false, ready: 'picker' })
  try {
    const { page } = second.cockpit
    const row = page.locator('.picker li', { hasText: 'project' })
    await expect(row).toContainText('(missing)')
    await expect(row.getByRole('button', { name: 'Relink…' })).toBeVisible()
    await row.getByRole('button', { name: 'Forget' }).click()
    await expect(page.getByText('No recent projects.')).toBeVisible()
  } finally {
    await second.close()
  }
})

test('closing a project window ends its tabs: the next start restores neither window nor tabs', async () => {
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await c.newTab('shell')
    await expect.poll(() => savedTabs(c).length).toBe(1)
    // The user closes the window (not a quit): main clears the record and the open list.
    await c.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close()
    })
    await expect.poll(() => savedTabs(c).length).toBe(0)
  } finally {
    await first.close({ keepFiles: true })
  }

  // Nothing to restore, so the picker is the first window.
  const second = await launchCockpit({ root, folderArg: false, ready: 'picker' })
  await second.close()
})
