// "Claude Code was not found" at start-up (main/hooks/claude-offer.ts, ClaudeOfferDialog). The launch has a PATH
// with no `claude` (the harness normally puts the fake one first) and a temp HOME with no ~/.local/bin/claude, and
// opts in with CC_COCKPIT_CLAUDE_OFFER=1 (never asked in a test run otherwise). "Install in a new tab" runs a
// harmless stand-in (CC_COCKPIT_CLAUDE_INSTALL_COMMAND, honoured only in a test run): no spec fetches claude.ai.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test } from './fixtures'

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash'
const STAND_IN = 'echo FAKE-INSTALLER-RAN; exit 0'
const NO_CLAUDE = {
  CC_COCKPIT_CLAUDE_OFFER: '1',
  CC_COCKPIT_CLAUDE_INSTALL_COMMAND: STAND_IN,
  // The system folders only: the fake shell and the login-env capture need /bin/sh and /usr/bin/env, nothing else.
  PATH: '/usr/bin:/bin'
}

test('not found: the dialog shows the install command, Copy copies it, Install opens a kept installer tab', async () => {
  const { cockpit: c, close } = await launchCockpit({ env: NO_CLAUDE })
  const saved = await c.app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    const dialog = c.page.getByRole('alertdialog', { name: 'Claude Code was not found' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('The Claude tabs run Claude Code')
    await expect(dialog.getByTestId('claude-offer-command')).toHaveText(INSTALL)
    await expect(dialog).toContainText('brew install --cask claude-code')
    await expect(dialog).toContainText('npm install -g @anthropic-ai/claude-code@latest')
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused()
    await c.page.screenshot({ path: process.env.CLAUDE_OFFER_SHOT ?? join(c.root, 'claude-offer.png') })

    await dialog.getByRole('button', { name: 'Copy the install command' }).click()
    await expect.poll(() => c.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(INSTALL)
    await expect(dialog.getByRole('button', { name: 'Copy the install command' })).toHaveText('Copied')

    await dialog.getByRole('button', { name: 'Install in a new tab' }).click()
    await expect(c.page.getByRole('alertdialog')).toHaveCount(0)
    // A command tab main made from its own constant (here the test stand-in), through the login shell's `-c`.
    await expect
      .poll(async () => (await c.hook<TabInfo[]>('tabs', c.projectDir)).map((t) => [t.kind, t.label, t.command]))
      .toEqual([['command', 'Install Claude Code', STAND_IN]])
    await expect(c.page.getByRole('tab', { name: 'Install Claude Code' })).toBeVisible()
    await c.waitForTerminalText('FAKE-INSTALLER-RAN')
    // It ended with 0 and stays open (the default tabExit closes a clean command tab), its output readable.
    await expect.poll(async () => (await c.hook<TabInfo[]>('tabs', c.projectDir))[0]?.exit).toEqual({ code: 0, signal: null })
    await expect(c.page.getByRole('tab', { name: 'Install Claude Code' })).toBeVisible()
    // The re-check at its exit: still no claude on the tabs' PATH (the stand-in installed nothing).
    await expect.poll(() => c.hook<string[]>('notifications')).toContainEqual(expect.stringMatching(/installer finished, but claude is still not found/))
  } finally {
    await c.app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved).catch(() => {})
    await close()
  }
})

test('not found: asked before the ccc offer, never both at once; Don\'t ask again is saved', async () => {
  const { cockpit: c, close } = await launchCockpit({ env: { ...NO_CLAUDE, CC_COCKPIT_CCC_OFFER: '1' } })
  try {
    const claude = c.page.getByRole('alertdialog', { name: 'Claude Code was not found' })
    await expect(claude).toBeVisible()
    await expect(c.page.getByRole('alertdialog')).toHaveCount(1)
    await claude.getByRole('checkbox', { name: "Don't ask again" }).check()
    await claude.getByRole('button', { name: 'Not now' }).click()
    // The ccc question comes only now, alone.
    await expect(c.page.getByRole('alertdialog', { name: 'Install the ccc command?' })).toBeVisible()
    await expect(c.page.getByRole('alertdialog')).toHaveCount(1)
    await expect.poll(() => (JSON.parse(readFileSync(join(c.dataDir, 'app.json'), 'utf8')) as { claudeOffer?: unknown }).claudeOffer).toBe(false)
  } finally {
    await close()
  }
})

test('found: no dialog (the harness PATH has the fake claude first)', async () => {
  const { cockpit: c, close } = await launchCockpit({ env: { CC_COCKPIT_CLAUDE_OFFER: '1' } })
  try {
    await c.page.waitForTimeout(1500)
    await expect(c.page.getByRole('alertdialog')).toHaveCount(0)
  } finally {
    await close()
  }
})
