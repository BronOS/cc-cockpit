// "Claude Code was not found" on a server (design-web.md §9.9, main/hooks/claude-offer.ts): the case the offer
// exists for. The server runs with a PATH that has no `claude` and the test opt-in; the owner's browser gets the
// dialog (the hidden page asks first and never takes it), Install in a new tab runs the stand-in installer on the
// server, its exit-0 re-check reaches the browser as an in-page notice, and the start line is in `ccc web status`.
import { expect, test } from '@playwright/test'
import type { TabInfo } from '../../src/shared/ipc'
import { ccc, expectMainAlive, launchServer, type Server } from './server-fixtures'
import { openBrowser, openProjectInBrowser } from './web-fixtures'

test.skip(process.platform === 'win32', 'server mode does not run on Windows')

const STAND_IN = 'echo FAKE-INSTALLER-RAN; exit 0'

let server: Server | undefined

test.afterEach(async () => {
  await server?.close()
  server = undefined
})

test("server: the owner's browser gets the dialog, installs on the server and hears the re-check; ccc web status has the line", async () => {
  test.setTimeout(120_000)
  server = await launchServer({
    env: { CC_COCKPIT_CLAUDE_OFFER: '1', CC_COCKPIT_CLAUDE_INSTALL_COMMAND: STAND_IN, PATH: '/usr/bin:/bin' }
  })
  const s = server
  // The start line: stdout and `ccc web status`, plain text pointing at Settings.
  await expect
    .poll(async () => (await ccc(s, ['web', 'status'])).stdout, { timeout: 15_000 })
    .toContain('Claude Code (claude) was not found on the PATH Claude tabs get')

  const browser = await openBrowser(`${s.origin}/`)
  try {
    const { page } = browser
    await openProjectInBrowser(browser, s.origin, s.projectId)
    const dialog = page.getByRole('alertdialog', { name: 'Claude Code was not found' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('claude-offer-command')).toHaveText('curl -fsSL https://claude.ai/install.sh | bash')
    // The hidden page asked first and was never shown it.
    await expect(s.cockpit.page.getByRole('alertdialog')).toHaveCount(0)

    await dialog.getByRole('button', { name: 'Install in a new tab' }).click()
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
    await expect
      .poll(async () => (await s.cockpit.hook<TabInfo[]>('tabs', s.cockpit.projectDir)).map((t) => [t.kind, t.label, t.command]))
      .toEqual([['command', 'Install Claude Code', STAND_IN]])
    await browser.waitForTerminalText('FAKE-INSTALLER-RAN')
    // The re-check at its exit 0, in this browser (the stand-in installed nothing).
    await expect(page.getByTestId('page-notice').filter({ hasText: 'claude is still not found' })).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await s.cockpit.hook<TabInfo[]>('tabs', s.cockpit.projectDir))[0]?.exit).toEqual({ code: 0, signal: null })

    await expectMainAlive(s)
  } finally {
    await browser.close()
  }
})

test('server: a second browser after the first took the question gets no dialog', async () => {
  test.setTimeout(120_000)
  server = await launchServer({ env: { CC_COCKPIT_CLAUDE_OFFER: '1', PATH: '/usr/bin:/bin' } })
  const s = server
  const first = await openBrowser(`${s.origin}/`)
  try {
    await openProjectInBrowser(first, s.origin, s.projectId)
    const dialog = first.page.getByRole('alertdialog', { name: 'Claude Code was not found' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Not now' }).click()
    const second = await openBrowser(`${s.origin}/`)
    try {
      await openProjectInBrowser(second, s.origin, s.projectId)
      // Settings is where the command is now; the start-up question is spent for this launch.
      await second.page.keyboard.press('ControlOrMeta+,')
      await expect(second.page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
      await expect(second.page.getByRole('alertdialog')).toHaveCount(0)
    } finally {
      await second.close()
    }
    await expectMainAlive(s)
  } finally {
    await first.close()
  }
})
