// Autopilot v2 Task 6: a plugin opens a Claude tab with model and effort, and the person's typing
// takes the tab over (SessionInfo.typed). A fixture plugin (session-takeover) opens the tab and
// sends texts; Discuss (core) comes from the overlay-toolbar fixture. Terminal reports the app
// itself provokes (focus, clicks, a wheel) are not typing; a letter is.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test, type Cockpit } from './fixtures'

const TAKEOVER = 'test.takeover'
const TOOLBAR = 'test.overlaytoolbar'
const plugin = (name: string): string => join(__dirname, '..', 'fixtures', 'plugins', name)

interface Entry {
  tabId: string
  status: string
  typed: boolean
  queue: Array<{ id: string; text: string }>
}
const entries = (c: Cockpit): Promise<Entry[]> => c.hook<Entry[]>('sessions', c.projectDir)
const claude = async (c: Cockpit): Promise<Entry> => {
  const [first] = await entries(c)
  if (!first) throw new Error('no Claude tab yet')
  return first
}
const run = (c: Cockpit, id: string, command: string): Promise<unknown> =>
  c.hook('runPluginCommand', c.projectDir, `${id}/${command}`)
const seen = (c: Cockpit): { opened?: { tabId: string }; sent?: unknown; sendError?: string; openError?: string } =>
  JSON.parse(readFileSync(join(c.root, 'home', 'takeover.json'), 'utf8'))

async function enable(c: Cockpit): Promise<void> {
  for (const [id, dir] of [[TAKEOVER, 'session-takeover'], [TOOLBAR, 'overlay-toolbar']]) {
    await c.hook('linkPlugin', plugin(dir!))
    await c.hook('enablePlugin', c.projectDir, id)
  }
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.map((p) => `${p.id}:${p.state}`).sort(), { timeout: 15_000 })
    .toEqual([`${TOOLBAR}:active`, `${TAKEOVER}:active`].sort())
}

const terminal = (c: Cockpit) => c.page.locator('.terminal-view:not([hidden]) .xterm')

test('model and effort reach claude; focus, clicks and a wheel leave typed false; a letter sets it', async ({ cockpit }) => {
  await enable(cockpit)
  await run(cockpit, TAKEOVER, 'open')
  await expect.poll(() => cockpit.claudeRuns().length, { timeout: 15_000 }).toBe(1)
  const argv = cockpit.claudeRuns()[0]!
  expect(argv[argv.indexOf('--model') + 1]).toBe('opus')
  expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
  await cockpit.waitForTerminalText('FAKE-CLAUDE model=opus')
  await cockpit.waitForTerminalText('FAKE-CLAUDE effort=high')
  await expect.poll(async () => (await claude(cockpit)).status, { timeout: 15_000 }).toBe('waiting')
  expect((await claude(cockpit)).typed).toBe(false)

  // Away to a shell tab and back by clicking the Claude tab, then clicks in its terminal.
  await cockpit.newTab('shell')
  await expect(cockpit.page.getByRole('tab')).toHaveCount(2)
  await cockpit.page.getByRole('tab').first().click()
  await terminal(cockpit).click()
  await terminal(cockpit).click({ position: { x: 40, y: 40 } })
  // A wheel scroll: the fake never enters the alternate screen, so xterm scrolls its own
  // scrollback and sends the program nothing (in alt-screen it would send arrow keys, which
  // count as typing, terminal-reports.ts).
  await terminal(cockpit).hover()
  await cockpit.page.mouse.wheel(0, -300)
  await cockpit.page.mouse.wheel(0, 300)
  await cockpit.page.waitForTimeout(500)
  expect((await claude(cockpit)).typed).toBe(false)

  await terminal(cockpit).click()
  await cockpit.page.keyboard.type('a')
  await expect.poll(async () => (await claude(cockpit)).typed).toBe(true)
})

const menuPart = (c: Cockpit) => c.page.locator('.overlay .overlay-discuss').getByRole('button', { name: 'Discuss in an existing session' })

test('a plugin send queued while busy is dropped when the person types; Discuss still delivers', async ({ cockpit }) => {
  await enable(cockpit)
  await run(cockpit, TAKEOVER, 'open')
  await expect.poll(async () => (await entries(cockpit))[0]?.status, { timeout: 15_000 }).toBe('waiting')
  const { tabId } = await claude(cockpit)

  // Busy without a keystroke: a core text through the hook goes in as a paste and the fake
  // submits it, so the tab works and typed is still false.
  await cockpit.hook('send', tabId, 'start')
  await expect.poll(async () => (await claude(cockpit)).status).toBe('working')
  expect((await claude(cockpit)).typed).toBe(false)

  // A plugin text and a Discuss text queue behind it.
  await run(cockpit, TAKEOVER, 'send')
  await expect.poll(async () => (await claude(cockpit)).queue.map((q) => q.text)).toEqual(['plugin text'])
  await run(cockpit, TOOLBAR, 'thing')
  await menuPart(cockpit).click()
  await cockpit.page.getByRole('dialog', { name: 'Discuss in an existing session' }).getByRole('button', { name: 'Send' }).click()
  await expect.poll(async () => (await claude(cockpit)).queue.length).toBe(2)

  // The person types a letter (no Enter): the plugin text is dropped at once, Discuss stays.
  await terminal(cockpit).click()
  await cockpit.page.keyboard.type('x')
  await expect.poll(async () => (await claude(cockpit)).typed).toBe(true)
  await expect
    .poll(async () => (await claude(cockpit)).queue.map((q) => q.text.startsWith('About: Thing')))
    .toEqual([true])

  // A send after the takeover is refused.
  await run(cockpit, TAKEOVER, 'send')
  await expect.poll(() => seen(cockpit).sendError ?? '').toContain('typing')

  // Stop: the waiting tab gets the Discuss text and never the plugin's. (The pending `x` is
  // cooked-mode input the fake reads with the next line.)
  await cockpit.page.keyboard.press('Enter')
  await cockpit.typeLine('/stop')
  await expect.poll(() => cockpit.pastes().length).toBe(2)
  expect(cockpit.pastes()[0]).toBe('\x1b[200~start\x1b[201~')
  expect(cockpit.pastes()[1]).toContain('About: Thing')
  expect(cockpit.pastes().join('')).not.toContain('plugin text')
})

test('a plugin session opened without focus leaves the selected tab, its keyboard focus and its pty alone', async ({ cockpit }) => {
  await enable(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE')
  await terminal(cockpit).click()
  const tabs = cockpit.page.getByRole('tab')
  await expect(tabs).toHaveCount(1)
  const inTerminal = (): Promise<boolean> =>
    cockpit.page.evaluate(() => !!document.activeElement?.closest('.terminal-view:not([hidden])'))
  expect(await inTerminal()).toBe(true)

  await run(cockpit, TAKEOVER, 'openBackground')
  await expect(tabs).toHaveCount(2)
  await expect.poll(() => cockpit.claudeRuns().length, { timeout: 15_000 }).toBe(2)
  await cockpit.page.waitForTimeout(500) // a late focus grab would land here

  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')
  expect(await inTerminal()).toBe(true)

  // Keys go to tab 1's pty: its fake echoes the line.
  await cockpit.page.keyboard.type('only-for-one')
  await cockpit.page.keyboard.press('Enter')
  await cockpit.waitForTerminalText('FAKE-CLAUDE echo: only-for-one')

  // Tab 2 never saw it.
  await tabs.nth(1).click()
  await cockpit.waitForTerminalText('FAKE-CLAUDE')
  expect(await cockpit.terminalText()).not.toContain('only-for-one')
})

test('a plugin session opened with focus: true is selected', async ({ cockpit }) => {
  await enable(cockpit)
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE')
  await run(cockpit, TAKEOVER, 'openFocused')
  const tabs = cockpit.page.getByRole('tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
})
