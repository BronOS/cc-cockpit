// design-next §3: the overlay toolbar, end to end. A fixture plugin (overlay-toolbar) opens html
// overlays: one with `ready: 'manual'` (the loader stays until the page calls ccPanel.ready()),
// one with opener buttons and no type (setButtons relabels them; no Discuss), one of the type
// `e2e-thing` with an onDiscuss handler. A second plugin (overlay-type-buttons) adds type buttons
// to that type. Discuss with Claude is checked against the fake `claude`: delivered to a waiting
// tab, queued for a working one, and as a New session (the new tab is selected).
// The url and "…" menu parts of the toolbar are in overlays.spec.ts; the reviewer's Edit button in
// reviewer-annotate.spec.ts.
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import type { OverlayInfo } from '../../src/shared/ipc'
import { expect, test, type Cockpit } from './fixtures'

const TOOLBAR = 'test.overlaytoolbar'
const TYPEBUTTONS = 'test.typebuttons'
const plugin = (name: string): string => join(__dirname, '..', 'fixtures', 'plugins', name)

const stack = (c: Cockpit): Promise<OverlayInfo[]> => c.hook<OverlayInfo[]>('overlays', c.projectDir)
const notes = (c: Cockpit): Promise<string[]> => c.hook<string[]>('notifications')
const run = (c: Cockpit, command: string): Promise<unknown> => c.hook('runPluginCommand', c.projectDir, `${TOOLBAR}/${command}`)

async function enable(c: Cockpit, ...fixtures: Array<[id: string, dir: string]>): Promise<void> {
  for (const [id, dir] of fixtures) {
    await c.hook('linkPlugin', plugin(dir))
    await c.hook('enablePlugin', c.projectDir, id)
  }
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.map((p) => `${p.id}:${p.state}`).sort(), { timeout: 15_000 })
    .toEqual(fixtures.map(([id]) => `${id}:active`).sort())
}

test('a manual-ready page keeps the loader until ccPanel.ready(); then the page shows', async ({ cockpit }) => {
  const { page } = cockpit
  await enable(cockpit, [TOOLBAR, 'overlay-toolbar'])
  await run(cockpit, 'manual')

  const overlay = page.locator('.overlay[data-kind="html"]')
  await expect(overlay.locator('.overlay-title')).toHaveText('Manual page')
  // The page has loaded (its host-side port is up) but never said it is ready: the loader stays.
  await expect(overlay.locator('.overlay-loader')).toBeVisible()
  await expect.poll(async () => (await stack(cockpit))[0]?.loading).toBe(true)
  await page.waitForTimeout(500)
  await expect(overlay.locator('.overlay-loader')).toBeVisible()

  await run(cockpit, 'release')
  await expect(overlay.locator('.overlay-loader')).toHaveCount(0)
  await expect.poll(async () => (await stack(cockpit))[0]?.loading ?? false).toBe(false)
  await expect(overlay.frameLocator('iframe').locator('#hello')).toHaveText('overlay page')

  // The close button works throughout.
  await overlay.getByRole('button', { name: 'Close overlay' }).click()
  await expect.poll(() => notes(cockpit)).toContain(`manual ${JSON.stringify({ kind: 'dismissed' })}`)
})

test('opener buttons: a click reaches the opener, setButtons relabels them; a bare overlay has no Discuss', async ({ cockpit }) => {
  const { page } = cockpit
  await enable(cockpit, [TOOLBAR, 'overlay-toolbar'])
  await run(cockpit, 'opener')

  const toolbar = page.locator('.overlay[data-kind="html"] .overlay-header')
  const opener = toolbar.locator('[data-source="opener"]')
  await expect(opener).toHaveText(['Ping', 'Rename'], { timeout: 15_000 })
  // No type and no onDiscuss handler: no Discuss; no type buttons either.
  await expect(toolbar.locator('.overlay-discuss')).toHaveCount(0)
  await expect(toolbar.locator('[data-source="type"]')).toHaveCount(0)

  await toolbar.getByRole('button', { name: 'Ping' }).click()
  await expect.poll(() => notes(cockpit)).toContain('ping clicked')

  await toolbar.getByRole('button', { name: 'Rename' }).click()
  await expect(opener).toHaveText(['Pong', 'Renamed'])
  await expect(toolbar.getByRole('button', { name: 'Renamed' })).toBeDisabled()
  await expect(toolbar.getByRole('button', { name: 'Pong' })).toHaveClass(/cc-primary/)

  // A terminal overlay with nothing but a title is bare too.
  const terminal = await cockpit.hook<number>('openOverlay', cockpit.projectDir, { kind: 'terminal', argv: ['cat'], cwd: cockpit.projectDir })
  const terminalToolbar = page.locator('.overlay[data-kind="terminal"] .overlay-header')
  await expect(terminalToolbar).toBeVisible()
  await expect(terminalToolbar.locator('.overlay-discuss')).toHaveCount(0)
  expect(terminal).toBeGreaterThan(0)
})

test('type buttons from another plugin: busy, then refreshed; close: true dismisses', async ({ cockpit }) => {
  const { page } = cockpit
  await enable(cockpit, [TOOLBAR, 'overlay-toolbar'], [TYPEBUTTONS, 'overlay-type-buttons'])
  await run(cockpit, 'thing')

  const toolbar = page.locator('.overlay[data-kind="html"] .overlay-header')
  const typeButtons = toolbar.locator('[data-source="type"]')
  await expect(typeButtons).toHaveText(['Mark', 'Alpha', 'Beta', 'Close it'], { timeout: 15_000 })
  // The opener has no buttons of its own; Discuss is there (typed overlay).
  await expect(toolbar.locator('[data-source="opener"]')).toHaveCount(0)
  await expect(toolbar.locator('.overlay-discuss')).toHaveCount(1)

  await toolbar.getByRole('button', { name: 'Mark' }).click()
  await expect(toolbar.locator('[data-button-id="mark"]')).toHaveAttribute('aria-busy', 'true')
  await expect(typeButtons).toHaveText(['Unmark', 'Alpha', 'Beta', 'Close it'])
  await expect.poll(() => notes(cockpit)).toContain('ran mark on {"id":"t1"} from test.overlaytoolbar')

  await toolbar.getByRole('button', { name: 'Close it' }).click()
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect.poll(() => notes(cockpit)).toContain(`thing ${JSON.stringify({ kind: 'dismissed' })}`)
})

const mainPart = (c: Cockpit) => c.page.locator('.overlay .overlay-discuss').getByRole('button', { name: 'Discuss in a new Claude session' })
const menuPart = (c: Cockpit) => c.page.locator('.overlay .overlay-discuss').getByRole('button', { name: 'Discuss in an existing session' })
const menu = (c: Cockpit) => c.page.getByRole('dialog', { name: 'Discuss in an existing session' })

/** Opens the ▾ menu of the top overlay, picks nothing (the preselection stays) and sends. */
async function discuss(c: Cockpit): Promise<void> {
  await menuPart(c).click()
  const popover = menu(c)
  await expect(popover).toBeVisible()
  await expect(popover.getByRole('option', { name: 'New session' })).toHaveCount(0)
  await expect(popover.getByLabel('Note (optional)')).toHaveCount(0)
  await popover.getByRole('button', { name: 'Send' }).click()
}

const claudeTab = async (c: Cockpit): Promise<string> => {
  const [first] = await c.hook<Array<{ tabId: string }>>('sessions', c.projectDir)
  if (!first) throw new Error('no Claude tab')
  return first.tabId
}

test('Discuss to an existing tab: delivered to a waiting tab, queued for a working one', async ({ cockpit }) => {
  const { page } = cockpit
  await enable(cockpit, [TOOLBAR, 'overlay-toolbar'])
  await cockpit.newTab('claude')
  await expect
    .poll(async () => (await cockpit.hook<Array<{ status: string }>>('sessions', cockpit.projectDir))[0]?.status, { timeout: 15_000 })
    .toBe('waiting')
  await cockpit.typeLine('/prompt first')
  await cockpit.typeLine('/stop')
  await expect
    .poll(async () => (await cockpit.hook<Array<{ status: string }>>('sessions', cockpit.projectDir))[0]?.status)
    .toBe('waiting')
  const tabId = await claudeTab(cockpit)

  // Waiting: the text goes straight in as one paste, with the About: head, the opener's context.
  await run(cockpit, 'thing')
  await discuss(cockpit)
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect.poll(() => notes(cockpit)).toContain(`thing ${JSON.stringify({ kind: 'discussed', tabId, queued: false })}`)
  await expect.poll(() => cockpit.pastes().length).toBe(1)
  const [pasted] = cockpit.pastes()
  expect(pasted).toContain('About: Thing')
  expect(pasted).toContain('e2e-thing: id=t1')
  expect(pasted).toContain('context from the opener')

  // The fake submitted it, so the tab is working: the next one is queued and goes in on Stop.
  await expect
    .poll(async () => (await cockpit.hook<Array<{ status: string }>>('sessions', cockpit.projectDir))[0]?.status)
    .toBe('working')
  await run(cockpit, 'thing')
  await menuPart(cockpit).click()
  await expect(menu(cockpit).getByRole('option').first()).toContainText('queued — sent when it is free')
  await menuPart(cockpit).click()
  await expect(menu(cockpit)).toHaveCount(0)
  await discuss(cockpit)
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect.poll(() => notes(cockpit)).toContain(`thing ${JSON.stringify({ kind: 'discussed', tabId, queued: true })}`)
  expect(cockpit.pastes()).toHaveLength(1)
  await cockpit.typeLine('/stop')
  await expect.poll(() => cockpit.pastes().length).toBe(2)
  expect(cockpit.pastes()[1]).toContain('About: Thing')
})

test('Discuss main part opens a new Claude tab with the text as its prompt and selects it, no popover', async ({ cockpit }) => {
  const { page } = cockpit
  await enable(cockpit, [TOOLBAR, 'overlay-toolbar'])
  // A shell tab is selected, so the new Claude tab being selected afterwards is a change.
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  expect(cockpit.claudeRuns()).toEqual([])

  await run(cockpit, 'thing')
  // No Claude tab: the ▾ part is disabled and says why.
  await expect(menuPart(cockpit)).toBeDisabled()
  await expect(menuPart(cockpit)).toHaveAttribute('title', /No Claude session/)
  await mainPart(cockpit).click()
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect(menu(cockpit)).toHaveCount(0)
  await expect.poll(() => cockpit.claudeRuns().length, { timeout: 15_000 }).toBe(1)
  const argv = cockpit.claudeRuns()[0]!
  const prompt = argv[argv.indexOf('--') + 1]
  expect(prompt).toContain('About: Thing')
  expect(prompt).toContain('context from the opener')

  await expect.poll(() => notes(cockpit)).toContainEqual(expect.stringMatching(/^thing \{"kind":"discussed","tabId":"[^"]+","queued":false\}$/))
  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
})

test('Discuss menu keys: Alt+ArrowDown opens it, Esc closes it and gives focus back; Enter in the list sends', async ({ cockpit }) => {
  const { page } = cockpit
  await enable(cockpit, [TOOLBAR, 'overlay-toolbar'])
  await cockpit.newTab('claude')
  await expect
    .poll(async () => (await cockpit.hook<Array<{ status: string }>>('sessions', cockpit.projectDir))[0]?.status, { timeout: 15_000 })
    .toBe('waiting')
  await cockpit.typeLine('/prompt first')
  await cockpit.typeLine('/stop')
  await expect
    .poll(async () => (await cockpit.hook<Array<{ status: string }>>('sessions', cockpit.projectDir))[0]?.status)
    .toBe('waiting')
  const tabId = await claudeTab(cockpit)
  await run(cockpit, 'thing')
  const popover = menu(cockpit)
  await mainPart(cockpit).focus()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(popover).toBeVisible()
  // The window's selected Claude tab is preselected and has the focus.
  await expect(popover.getByRole('option')).toHaveCount(1)
  await expect(popover.getByRole('option').first()).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(page.locator('.overlay')).toHaveCount(1)
  await expect(menuPart(cockpit)).toBeFocused()
  expect(cockpit.pastes()).toHaveLength(0)

  await menuPart(cockpit).click()
  await expect(popover.getByRole('option').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect.poll(() => notes(cockpit)).toContain(`thing ${JSON.stringify({ kind: 'discussed', tabId, queued: false })}`)
  await expect.poll(() => cockpit.pastes().length).toBe(1)
  expect(cockpit.claudeRuns()).toHaveLength(1)
})
