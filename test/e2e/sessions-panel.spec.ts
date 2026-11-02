// Task 20: the Sessions panel. The fake `claude` reports an edited file with `/edit <path>`
// (a PostToolUse hook); the panel lists it, and a click opens a terminal overlay that shows the
// diff (inside a git repository) or the file itself (outside any).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OverlayInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test as base, type Cockpit } from './fixtures'

// LESS=FRX is what git puts in its pager's env when LESS is unset, and F quits at once on a
// one-screen output. Set explicitly, so a developer's own LESS (often `-R`) cannot hide that.
const test = base.extend<{ cockpit: Cockpit }>({
  // eslint-disable-next-line no-empty-pattern
  cockpit: async ({}, use) => {
    const { cockpit, close } = await launchCockpit({ env: { LESS: 'FRX' } })
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

async function openPanel(c: Cockpit): Promise<void> {
  await c.page.locator('.zone-right').getByRole('button', { name: /^Sessions/ }).click()
  await expect(c.page.locator('.zone-right section.panel[aria-label="Sessions"]')).toBeVisible()
}

test('a file the fake claude edits shows in the panel; a click outside a repository opens it in less', async ({
  cockpit
}) => {
  const { page } = cockpit
  await openPanel(cockpit)
  await expect(page.getByText('No Claude sessions in this window.')).toBeVisible()

  const file = join(cockpit.projectDir, 'notes.txt')
  writeFileSync(file, lines('plain'))
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine('/prompt tidy the notes')
  await cockpit.typeLine(`/edit ${file}`)

  const item = page.locator('.session-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('tidy the notes')
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

  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.typeLine(`/edit ${tracked}`)
  await cockpit.typeLine(`/edit ${fresh}`)
  await expect(page.locator('.session-file')).toHaveCount(2)

  const overlay = page.locator('.overlay[data-kind="terminal"]')
  const rows = overlay.locator('.xterm-rows')

  // Tracked: git diff -- <file>; a 3-line file with one line changed fits one screen.
  await page.getByRole('button', { name: tracked }).click()
  await expect(overlay).toBeVisible()
  await expect(rows).toContainText('-old line 1')
  await expect(rows).toContainText('+new line 1')
  await staysOpen(cockpit)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)

  // Untracked: git diff --no-index -- /dev/null <file>; all of it is added.
  await page.getByRole('button', { name: fresh }).click()
  await expect(overlay).toBeVisible()
  await expect(rows).toContainText('+brand line 0')
  await staysOpen(cockpit)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)

  // Committed since: an empty diff still leaves the overlay up (an empty pager screen).
  git(projectDir, 'commit', '-q', '-am', 'edit')
  await page.getByRole('button', { name: tracked }).click()
  await expect(overlay).toBeVisible()
  await staysOpen(cockpit)
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect(overlay).toHaveCount(0)
})

test('the session title jumps to its tab', async ({ cockpit }) => {
  const { page } = cockpit
  await openPanel(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  await cockpit.newTab('shell')
  const tabs = page.getByRole('tab')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.locator('.session-item').getByRole('button', { name: 'Claude 1' }).click()
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
})

test('main refuses a diff for a file it did not record or a tab of another project', async ({ cockpit }) => {
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  const outside = mkdtempSync(join(tmpdir(), 'ccc-sp-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret\n')
    const tabs = await cockpit.hook<Array<{ id: string }>>('tabs', cockpit.projectDir)
    const answers = await cockpit.page.evaluate(
      async ({ tabId, file }) => {
        const api = (globalThis as unknown as { cockpit: { invoke(c: string, p: unknown): Promise<boolean> } }).cockpit
        return [
          await api.invoke('sessions.openFile', { tabId, file }),
          await api.invoke('sessions.openFile', { tabId: 'no-such-tab', file })
        ]
      },
      { tabId: tabs[0]!.id, file: join(outside, 'secret.txt') }
    )
    expect(answers).toEqual([false, false])
    expect(await stack(cockpit)).toEqual([])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})
