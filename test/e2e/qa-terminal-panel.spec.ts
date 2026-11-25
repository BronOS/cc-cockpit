// qa-carol blind verify (Terminal panel; design-terminal-panel.md, §13 overrides): written from the design, the
// decisions and the tasks only, never the implementation. Desktop toggle / hide / show keeping output, keys by area
// (chords, the palette, exits), moves in and out, restart, per-screen open state with a browser view, a guest's raw
// socket, the panel in the left zone, Cmd+J, the toggle under a modal and from a Cyrillic layout, the last tab closing.
import type { Locator, Page } from '@playwright/test'
import type { TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest, rawSocket, redeemOk, type RawSocket } from './guest-fixtures'
import { groupOfShells, groupsOf, invoke, MOD, place, tabsOf } from './split-fixtures'
import { expectMainAlive, launchServer } from './server-fixtures'
import { enableWebAccess, openBrowser, openProjectInBrowser, type WebBrowser } from './web-fixtures'

const TOGGLE = 'Control+Backquote'
const NEW_TERMINAL = 'Control+Shift+Backquote'

const panel = (p: Page): Locator => p.getByTestId('terminal-panel')
const panelStrip = (p: Page): Locator => p.getByRole('tablist', { name: 'Terminal tabs' })
const panelTabs = (p: Page): Locator => panelStrip(p).getByRole('tab')
/** The main strip's tab wrappers (never the panel's: those are `.terminal-panel-tab`). */
const mainTabs = (p: Page): Locator => p.locator('.zones-centre .tab[data-tab-id]')
const mainTabIds = async (p: Page): Promise<string[]> =>
  mainTabs(p).evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id') ?? ''))
const panelTabIds = async (p: Page): Promise<string[]> =>
  p.locator('.terminal-panel-tab[data-panel-tab-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-panel-tab-id') ?? ''))
const selectedPanelTabId = async (p: Page): Promise<string | null> =>
  p.locator('.terminal-panel-tab.active').getAttribute('data-panel-tab-id')

/** Whether the DOM focus is inside `loc`. */
const focusIn = (loc: Locator): Promise<boolean> => loc.evaluate((e) => e.contains(document.activeElement)).catch(() => false)
const mainArea = (p: Page): Locator => p.locator('[data-split-area]')

const docked = async (p: Page): Promise<TabInfo[]> => (await tabsOf(p)).filter((t) => t.dock === 'panel')
const undocked = async (p: Page): Promise<TabInfo[]> => (await tabsOf(p)).filter((t) => t.dock !== 'panel')

const FAILING = { id: 'qa-failing', label: 'QA failing', command: 'echo QA-CMD-RAN; sleep 1; exit 3' }

/** A clean `exit` closes a shell tab only after the shell lived a while (design §13.4, SHELL_MIN_LIFE_MS). */
const LIVED = 5_000

async function openPanelWithShell(c: Cockpit): Promise<void> {
  await c.page.keyboard.press(TOGGLE)
  await expect(panel(c.page)).toBeVisible()
  await c.waitForPanelTerminalText('FAKE-SHELL ready')
}

async function mainShell(c: Cockpit): Promise<string> {
  const before = new Set((await tabsOf(c.page)).map((t) => t.id))
  await c.newTab('shell')
  await c.waitForTerminalText('FAKE-SHELL ready')
  const added = (await tabsOf(c.page)).find((t) => !before.has(t.id))
  if (!added) throw new Error('no new tab')
  return added.id
}

test('qa: Ctrl+` opens an empty panel with a focused shell; hiding keeps output that arrives meanwhile; the toggle gives the keys back', async ({ cockpit: c }) => {
  test.setTimeout(60_000)
  const { page } = c
  await mainShell(c)
  await c.typeLine('echo main-ready')
  await c.waitForTerminalText('main-ready')
  await expect(panel(page)).toHaveCount(0) // closed at first

  await page.keyboard.press(TOGGLE)
  await expect(panel(page)).toBeVisible()
  await expect(panelTabs(page)).toHaveCount(1)
  await c.waitForPanelTerminalText('FAKE-SHELL ready')
  // The new shell has the keys without a click.
  await expect.poll(() => focusIn(panel(page))).toBe(true)
  // The panel's tab is not in the main strip.
  expect(await mainTabIds(page)).toHaveLength(1)
  expect(await docked(page)).toHaveLength(1)

  // A loop that finishes while the panel is hidden: everything it prints arrives with no view attached.
  await page.keyboard.type('i=0; while [ $i -lt 12 ]; do echo tick-$i; i=$((i+1)); sleep 0.3; done; echo LOOP-DONE\n')
  await c.waitForPanelTerminalText('tick-1')
  await page.keyboard.press(TOGGLE) // on screen with the keys: closes
  await expect(panel(page)).toHaveCount(0)
  // The keys went back to the main area's tab.
  await expect.poll(() => focusIn(mainArea(page))).toBe(true)
  await page.keyboard.type('echo typed-in-main-again\n')
  await c.waitForTerminalText('typed-in-main-again')
  await page.waitForTimeout(5_000) // the loop ends while hidden

  await page.keyboard.press(TOGGLE)
  await expect(panel(page)).toBeVisible()
  await c.waitForPanelTerminalText('LOOP-DONE', 5_000)
  await c.waitForPanelTerminalText('tick-11', 1_000)
  // Still the same tab, still running (input reaches it) and focused again.
  expect(await docked(page)).toHaveLength(1)
  await expect.poll(() => focusIn(panel(page))).toBe(true)
  await page.keyboard.type('echo after-show\n')
  await c.waitForPanelTerminalText('after-show')
  // The main terminal never got the panel's text.
  expect(await c.terminalText()).not.toContain('after-show')
})

test('qa: on screen without the keys the toggle takes them; Ctrl+Shift+` adds a shell to the panel', async ({ cockpit: c }) => {
  const { page } = c
  await mainShell(c)
  await openPanelWithShell(c)
  await c.typeLine('echo main-click') // a click into the main area takes the keys there
  await c.waitForTerminalText('main-click')
  await expect.poll(() => focusIn(panel(page))).toBe(false)
  await page.keyboard.press(TOGGLE)
  await expect(panel(page)).toBeVisible() // not closed: it took the keys
  await expect.poll(() => focusIn(panel(page))).toBe(true)

  await page.keyboard.press(NEW_TERMINAL)
  await expect(panelTabs(page)).toHaveCount(2)
  await expect.poll(() => focusIn(panel(page))).toBe(true)
  const ids = await panelTabIds(page)
  expect(await selectedPanelTabId(page)).toBe(ids[1])
  expect(await mainTabIds(page)).toHaveLength(1)
})

test('qa: keys by area: with panel keys Cmd+W, Ctrl+Tab, Cmd+Shift+T and the palette act on the panel; Cmd+1 and a main click act on the main area', async ({ cockpit: c }) => {
  test.setTimeout(60_000)
  const { page } = c
  const m1 = await mainShell(c)
  const m2 = await mainShell(c)
  await openPanelWithShell(c)
  await page.keyboard.press(NEW_TERMINAL)
  await expect(panelTabs(page)).toHaveCount(2)
  const [p1, p2] = await panelTabIds(page)
  expect(await selectedPanelTabId(page)).toBe(p2)

  // Ctrl+Tab: a plain step through the panel's tabs, no switcher.
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('dialog', { name: 'Switch tab' })).toHaveCount(0)
  await expect.poll(() => selectedPanelTabId(page)).toBe(p1)
  await expect(page.locator(`.zones-centre .tab.active[data-tab-id="${m2}"]`)).toHaveCount(1) // the main selection stays

  // Cmd+Shift+T: a new shell in the panel.
  await page.keyboard.press(`${MOD}+Shift+T`)
  await expect(panelTabs(page)).toHaveCount(3)
  expect(await mainTabIds(page)).toEqual([m1, m2])

  // Cmd+W: closes the panel's selected tab.
  await page.keyboard.press(`${MOD}+W`)
  await expect(panelTabs(page)).toHaveCount(2)
  expect(await mainTabIds(page)).toEqual([m1, m2])

  // The palette's Close Tab: the palette does not move the keys, so it closes the panel's tab too.
  await page.keyboard.press(`${MOD}+Shift+P`)
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox', { name: 'Command' }).fill('Close Tab')
  await palette.getByRole('option', { name: /^Close Tab/ }).first().click()
  await expect(palette).toHaveCount(0)
  await expect(panelTabs(page)).toHaveCount(1)
  expect(await mainTabIds(page)).toEqual([m1, m2])

  // Cmd+1 selects the main area's first tab even with panel keys.
  await page.keyboard.press(`${MOD}+1`)
  await expect(page.locator(`.zones-centre .tab.active[data-tab-id="${m1}"]`)).toHaveCount(1)
  await expect(panelTabs(page)).toHaveCount(1)

  // A click into the main area moves the keys there: Cmd+W closes the main tab now.
  await c.typeLine('echo focus-main')
  await page.keyboard.press(`${MOD}+W`)
  await expect.poll(() => mainTabIds(page)).toHaveLength(1)
  await expect(panelTabs(page)).toHaveCount(1)
})

test('qa: exits: a clean exit gives the keys to the panel next tab, a failed command stays with its mark and restarts, the last one leaves "No terminals" and never the main area', async () => {
  test.setTimeout(90_000)
  const { cockpit: c, close } = await launchCockpit({ settings: { tabCommands: [FAILING] } })
  try {
    const { page } = c
    await mainShell(c)
    await openPanelWithShell(c)
    await page.keyboard.press(NEW_TERMINAL)
    await expect(panelTabs(page)).toHaveCount(2)
    const [p1] = await panelTabIds(page)
    await page.waitForTimeout(LIVED)

    // p2 (selected, with the keys) exits cleanly: closed, the keys go to p1.
    await page.keyboard.type('exit\n')
    await expect.poll(() => panelTabIds(page), { timeout: 10_000 }).toEqual([p1])
    expect(await selectedPanelTabId(page)).toBe(p1)
    await expect.poll(() => focusIn(panel(page))).toBe(true)
    await page.keyboard.type('echo keys-after-exit\n')
    await c.waitForPanelTerminalText('keys-after-exit')
    expect(await c.terminalText()).not.toContain('keys-after-exit')

    // A failing command from New terminal stays with its exit mark; its menu has Restart. (A shell closes
    // on any exit, in the panel as in the main area.)
    await panel(page).getByRole('button', { name: 'New terminal' }).click()
    await page.getByRole('menu', { name: 'New terminal' }).getByRole('menuitem', { name: FAILING.label }).click()
    await expect(panelTabs(page)).toHaveCount(2)
    const p3 = (await panelTabIds(page))[1]!
    const exited = page.locator(`.terminal-panel-tab.exited[data-panel-tab-id="${p3}"]`)
    await expect(exited).toHaveCount(1, { timeout: 10_000 })
    await expect(panelTabs(page).nth(1)).toHaveAccessibleName(/exited/)
    await c.waitForPanelTerminalText('QA-CMD-RAN')
    await panelTabs(page).nth(1).click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Terminal tab' })
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Restart' }).click()
    await expect(exited).toHaveCount(0, { timeout: 5_000 })
    await expect(exited).toHaveCount(1, { timeout: 10_000 }) // it ran again and failed again
    expect(await mainTabIds(page)).toHaveLength(1)
    await panelStrip(page).getByRole('button', { name: new RegExp(`^Close ${FAILING.label}`) }).click()
    await expect.poll(() => panelTabIds(page)).toEqual([p1])

    // The last panel tab ends with the person's own keys: the panel stays open on "No terminals"; the keys
    // never jump to the main area (keys-off), so typing reaches no terminal.
    await panel(page).locator('.terminal-view').click()
    await page.keyboard.type('exit\n')
    await expect(page.getByTestId('terminal-panel-empty')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('terminal-panel-empty')).toContainText('No terminals')
    await expect(panel(page)).toBeVisible()
    await page.keyboard.type('echo leak-to-main\n')
    await page.waitForTimeout(1_500)
    expect(await c.terminalText()).not.toContain('leak-to-main')

    // The empty state's Shell button.
    await page.getByTestId('terminal-panel-empty').getByRole('button', { name: 'Shell' }).click()
    await expect(panelTabs(page)).toHaveCount(1)
    await c.waitForPanelTerminalText('FAKE-SHELL ready')
  } finally {
    await close()
  }
})

test('qa: the last panel tab closed by its × leaves the panel open on "No terminals"', async ({ cockpit: c }) => {
  const { page } = c
  await openPanelWithShell(c)
  await panelStrip(page).getByRole('button', { name: /^Close Shell/ }).click()
  await expect(page.getByTestId('terminal-panel-empty')).toBeVisible()
  await expect(panel(page)).toBeVisible()
  expect(await tabsOf(page)).toHaveLength(0)
})

test('qa: moves keep the session both ways; the person own move opens the panel with the keys; Claude tabs cannot move', async ({ cockpit: c }) => {
  test.setTimeout(60_000)
  const { page } = c
  const a = await mainShell(c)
  await c.typeLine('echo tag-alpha')
  await c.waitForTerminalText('tag-alpha')
  const b = await mainShell(c)
  await page.locator(`.zones-centre .tab[data-tab-id="${a}"]`).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Tab' }).getByRole('menuitem', { name: 'Move to Terminal panel' }).click()

  await expect(panel(page)).toBeVisible()
  await expect.poll(() => panelTabIds(page)).toEqual([a])
  expect(await selectedPanelTabId(page)).toBe(a)
  await c.waitForPanelTerminalText('tag-alpha') // same session: its old output is there
  await expect.poll(() => focusIn(panel(page))).toBe(true)
  expect(await mainTabIds(page)).toEqual([b])
  expect((await tabsOf(page)).find((t) => t.id === a)?.dock).toBe('panel')
  await page.keyboard.type('echo moved-in\n')
  await c.waitForPanelTerminalText('moved-in')

  await panelTabs(page).first().click({ button: 'right' })
  await page.getByRole('menu', { name: 'Terminal tab' }).getByRole('menuitem', { name: 'Move to tab area' }).click()
  await expect.poll(() => mainTabIds(page)).toContain(a)
  await expect(page.locator(`.zones-centre .tab.active[data-tab-id="${a}"]`)).toHaveCount(1) // selected there
  await c.waitForTerminalText('moved-in')
  await expect(page.getByTestId('terminal-panel-empty')).toBeVisible()
  expect((await tabsOf(page)).find((t) => t.id === a)?.dock).toBeUndefined()

  // A Claude tab's menu has no move.
  await c.newTab('claude')
  await c.waitForTerminalText('FAKE-CLAUDE banner')
  const claude = (await tabsOf(page)).find((t) => t.kind === 'claude')!
  await page.locator(`.zones-centre .tab[data-tab-id="${claude.id}"]`).click({ button: 'right' })
  const menu = page.getByRole('menu', { name: 'Tab' })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Move to Terminal panel' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  // And main refuses it for a Claude tab.
  await expect(invoke(page, 'tabs.dock', { tabId: claude.id, dock: 'panel' })).rejects.toThrow()
  expect((await tabsOf(page)).find((t) => t.id === claude.id)?.dock).toBeUndefined()
})

test('qa: docking a grouped tab takes it out of its group; a flagged tab loses its flag; Move left steps past a hidden docked tab', async ({ cockpit: c }) => {
  test.setTimeout(60_000)
  const { page } = c
  const [g1, g2] = await groupOfShells(c, ['grp-one', 'grp-two'] as const)
  expect((await groupsOf(page)).groups).toHaveLength(1)
  await invoke(page, 'tabs.dock', { tabId: g1, dock: 'panel' })
  await expect.poll(async () => (await groupsOf(page)).groups.length).toBe(0)
  expect((await tabsOf(page)).find((t) => t.id === g1)?.dock).toBe('panel')
  // Placing a docked tab beside another is refused.
  const placed = await place(page, g1, g2, 'right')
  expect(placed).toEqual({ ok: false, reason: 'docked' })
  await invoke(page, 'tabs.dock', { tabId: g1, dock: 'main' })

  // A flag is cleared by the dock and does not come back.
  await page.locator(`.zones-centre .tab[data-tab-id="${g2}"]`).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Tab' }).getByRole('menuitemradio', { name: 'Flag Red' }).click()
  await expect(page.locator(`.zones-centre .tab[data-tab-id="${g2}"][data-flag]`)).toHaveCount(1)
  await invoke(page, 'tabs.dock', { tabId: g2, dock: 'panel' })
  expect((await tabsOf(page)).find((t) => t.id === g2)?.flag).toBeUndefined()
  // A flag on a docked tab is refused (thrown or answered null): either way none is set.
  await invoke(page, 'tabs.flag', { tabId: g2, flag: { color: 'red' } }).catch(() => null)
  expect((await tabsOf(page)).find((t) => t.id === g2)?.flag).toBeUndefined()
  await invoke(page, 'tabs.dock', { tabId: g2, dock: 'main' })
  await expect(page.locator(`.zones-centre .tab[data-tab-id="${g2}"][data-flag]`)).toHaveCount(0)

  // Order a, d (docked), b in the one order: Move left on b puts it before a in the main strip.
  const a = await mainShell(c)
  const d = await mainShell(c)
  const b = await mainShell(c)
  await invoke(page, 'tabs.dock', { tabId: d, dock: 'panel' })
  const before = await mainTabIds(page)
  expect(before.slice(-2)).toEqual([a, b])
  await page.locator(`.zones-centre .tab[data-tab-id="${b}"]`).click({ button: 'right' })
  await page.getByRole('menu', { name: 'Tab' }).getByRole('menuitem', { name: 'Move left' }).click()
  await expect.poll(async () => (await mainTabIds(page)).slice(-2)).toEqual([b, a])
  expect((await tabsOf(page)).find((t) => t.id === d)?.dock).toBe('panel')
})

test('qa: docked tabs are not in Cmd+N, the switcher or the tab count', async ({ cockpit: c }) => {
  const { page } = c
  const a = await mainShell(c)
  const d = await mainShell(c)
  const b = await mainShell(c)
  await invoke(page, 'tabs.dock', { tabId: d, dock: 'panel' })
  await expect.poll(() => mainTabIds(page)).toEqual([a, b])
  await c.typeLine('echo focus-main')
  await page.keyboard.press(`${MOD}+2`)
  await expect(page.locator(`.zones-centre .tab.active[data-tab-id="${b}"]`)).toHaveCount(1)
  await page.keyboard.down('Control')
  await page.keyboard.press('Tab')
  const sw = page.getByRole('dialog', { name: 'Switch tab' })
  await expect(sw).toBeVisible()
  await expect(sw.getByRole('option')).toHaveCount(2)
  await page.keyboard.press('Escape')
  await page.keyboard.up('Control')
})

test('qa: a restart brings panel tabs back in the panel, a shell fresh', async () => {
  test.setTimeout(90_000)
  const first = await launchCockpit({ settings: { tabCommands: [{ id: 'qa-cmd', label: 'QA long', command: 'echo QA-LONG-RAN; sleep 60' }] } })
  const root = first.cockpit.root
  try {
    const c = first.cockpit
    await mainShell(c)
    await openPanelWithShell(c)
    await c.page.getByTestId('terminal-panel').getByRole('button', { name: 'New terminal' }).click()
    await c.page.getByRole('menu', { name: 'New terminal' }).getByRole('menuitem', { name: 'QA long' }).click()
    await expect(panelTabs(c.page)).toHaveCount(2)
    await c.waitForPanelTerminalText('QA-LONG-RAN')
    // Saved: wait for the debounced writer.
    await c.page.waitForTimeout(2_000)
  } finally {
    await first.close({ keepFiles: true })
  }
  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    const tabs = await c.hook<TabInfo[]>('tabs', c.projectDir)
    expect(tabs).toHaveLength(3)
    expect(tabs.filter((t) => t.dock === 'panel').map((t) => t.kind)).toEqual(['shell', 'command'])
    await expect.poll(() => mainTabIds(c.page).then((x) => x.length)).toBe(1)
    if (!(await panel(c.page).isVisible())) await c.page.keyboard.press(TOGGLE)
    await expect(panel(c.page)).toBeVisible()
    await expect(panelTabs(c.page)).toHaveCount(2)
    // The command tab is back not started (its name says so), the shell fresh.
    await expect(panelTabs(c.page).nth(1)).toHaveAccessibleName(/not started/)
    await panelTabs(c.page).first().click()
    await c.waitForPanelTerminalText('FAKE-SHELL ready')
  } finally {
    await second.close()
  }
})

test('qa: per screen: the browser view starts closed and opens and closes the panel on its own; both see the same tab live', async ({ cockpit: c }) => {
  test.setTimeout(90_000)
  const { page } = c
  await mainShell(c)
  await openPanelWithShell(c)
  const web = await enableWebAccess(c)
  let br: WebBrowser | undefined
  try {
    br = await openBrowser(web.link)
    await openProjectInBrowser(br, web.origin, web.projectId)
    const bp = br.page
    await br.waitForTerminalText('FAKE-SHELL ready')
    await expect(panel(bp)).toHaveCount(0) // a browser that never opened it starts closed
    await expect(bp.locator('.zones-centre .tab[data-tab-id]')).toHaveCount(1) // the docked tab is not in its main strip

    await bp.getByRole('toolbar', { name: 'Bottom panels' }).getByRole('button', { name: 'Terminal' }).click()
    await expect(panel(bp)).toBeVisible()
    await expect(panelTabs(bp)).toHaveCount(1)
    await br.waitForPanelTerminalText('FAKE-SHELL ready')

    // The desktop types in its panel; the browser's panel shows it live.
    await c.panelTypeLine('echo from-desktop-panel')
    await br.waitForPanelTerminalText('from-desktop-panel')
    // The browser types in its panel; the desktop shows it.
    await bp.locator('[data-testid="terminal-panel"] .terminal-view').click()
    await bp.keyboard.type('echo from-browser-panel\n')
    await c.waitForPanelTerminalText('from-browser-panel')

    // The browser closes its panel: the desktop's stays open.
    await bp.keyboard.press(TOGGLE)
    await expect(panel(bp)).toHaveCount(0)
    await page.waitForTimeout(1_000)
    await expect(panel(page)).toBeVisible()
    // The desktop closes its panel and the browser opens its own: neither follows the other.
    await c.panelTypeLine('echo desk-keys')
    await page.keyboard.press(TOGGLE)
    await expect(panel(page)).toHaveCount(0)
    await bp.getByRole('toolbar', { name: 'Bottom panels' }).getByRole('button', { name: 'Terminal' }).click()
    await expect(panel(bp)).toBeVisible()
    await page.waitForTimeout(1_000)
    await expect(panel(page)).toHaveCount(0)
    // Output the browser missed while closed is there.
    await br.waitForPanelTerminalText('desk-keys')
  } finally {
    await br?.close()
  }
})

let callId = 5000
async function rawInvoke(s: RawSocket, ch: string, p?: unknown): Promise<{ ok: boolean; v?: unknown; err?: string }> {
  const id = ++callId
  s.ws.send(JSON.stringify({ t: 'invoke', id, ch, p }))
  const f = await s.next((x) => x.t === 'result' && x.id === id, 5000)
  return { ok: f.ok === true, v: f.v, err: typeof f.err === 'string' ? f.err : undefined }
}
const readyTabs = async (s: RawSocket): Promise<string[]> => {
  const ready = await s.next((f) => f.t === 'ready')
  return ((ready.snapshot as { tabs: Array<{ id: string }> }).tabs ?? []).map((t) => t.id)
}
const closedWithin = (s: RawSocket, ms: number): Promise<{ code: number } | undefined> =>
  Promise.race([s.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])

test('qa: a write guest: no panel, no docked tab, docking takes the tab away at once and undocking gives it back; panel channels refused', async ({ cockpit: c }) => {
  test.setTimeout(90_000)
  const { page } = c
  const shared = await mainShell(c)
  const web = await enableWebAccess(c)
  const invited = await inviteGuest(c, { name: 'Quinn', role: 'write' })
  const client = await redeemOk(web.origin, invited.token)
  const marker = 'QAZX-PANEL-SECRET'

  const s1 = await rawSocket(client)
  expect(await readyTabs(s1)).toEqual([shared])
  expect(s1.texts.join('\n')).not.toContain('core/terminal')

  // The owner docks the tab the guest sees: the guest's socket goes (a narrowing), quickly.
  const t0 = Date.now()
  await invoke(page, 'tabs.dock', { tabId: shared, dock: 'panel' })
  const closed = await closedWithin(s1, 5_000)
  expect(closed, 'the guest socket was not closed after the dock').toBeDefined()
  console.log(`QA guest closed code=${closed?.code} after ${Date.now() - t0} ms`)

  const s2 = await rawSocket(client)
  expect(await readyTabs(s2)).toEqual([])
  // The owner makes a panel shell and types the marker in the docked tab.
  const panelTab = await invoke<TabInfo | null>(page, 'tabs.create', { kind: 'shell', dock: 'panel' })
  expect(panelTab?.dock).toBe('panel')
  await invoke(page, 'tabs.input', { tabId: shared, data: `echo ${marker}\r` })
  await page.waitForTimeout(2_000)
  const seen = s2.texts.join('\n')
  expect(seen).not.toContain(marker)
  expect(seen).not.toContain('core/terminal')
  expect(seen).not.toContain(panelTab!.id)
  expect(seen).not.toContain('tabs.docked')

  // Channels naming the docked tab answer as for a tab that does not exist; panel channels are refused.
  const unknown = await rawInvoke(s2, 'tabs.input', { tabId: '00000000-0000-4000-8000-000000000000', data: 'x' })
  const dockedInput = await rawInvoke(s2, 'tabs.input', { tabId: shared, data: 'echo guest-typed\r' })
  expect(dockedInput.ok).toBe(false)
  expect(dockedInput.err).toBe(unknown.err)
  for (const [ch, p] of [
    ['tabs.dock', { tabId: shared, dock: 'main' }],
    ['tabs.panelSelected', { tabId: shared }],
    ['tabs.create', { kind: 'shell', dock: 'panel' }]
  ] as const) {
    const r = await rawInvoke(s2, ch, p)
    expect(r.ok, `${ch} was accepted for a guest`).toBe(false)
  }
  expect((await tabsOf(page)).find((t) => t.id === shared)?.dock).toBe('panel')
  expect(await c.panelTerminalText().catch(() => '')).not.toContain('guest-typed')

  // Undocking gives it back (a widening).
  await invoke(page, 'tabs.dock', { tabId: shared, dock: 'main' })
  await closedWithin(s2, 5_000)
  const s3 = await rawSocket(client)
  await expect.poll(async () => (await readyTabs(s3)).includes(shared)).toBe(true)
  expect(await readyTabs(s3)).not.toContain(panelTab!.id)
  s3.close()
})

test('qa: the panel moved to the left zone: Cmd+J leaves it alone, the toggle closes and opens it there, and unhides a hidden one', async ({ cockpit: c }) => {
  test.setTimeout(60_000)
  const { page } = c
  await mainShell(c)
  await openPanelWithShell(c)
  await page.getByRole('button', { name: 'Move or hide Terminal' }).click()
  const zoneMenu = page.getByRole('menu').last()
  await expect(zoneMenu).toBeVisible()
  console.log('QA zone menu:', await zoneMenu.ariaSnapshot())
  await zoneMenu.getByRole('menuitem', { name: /left/i }).first().click()
  await expect(page.getByRole('toolbar', { name: 'Left panels' }).getByRole('button', { name: 'Terminal' })).toBeVisible()
  await expect(panel(page)).toBeVisible()

  await c.typeLine('echo main-focus')
  await page.keyboard.press(`${MOD}+J`)
  await page.waitForTimeout(500)
  await expect(panel(page)).toBeVisible()

  await page.keyboard.press(TOGGLE) // takes the keys
  await expect.poll(() => focusIn(panel(page))).toBe(true)
  await page.keyboard.press(TOGGLE) // closes
  await expect(panel(page)).toHaveCount(0)
  await page.keyboard.press(TOGGLE) // opens again in the left zone
  await expect(panel(page)).toBeVisible()
  await expect(page.locator('.zone-left [data-testid="terminal-panel"]')).toHaveCount(1)

  // Hidden from its menu: the toggle unhides it into its remembered zone.
  await page.getByRole('button', { name: 'Move or hide Terminal' }).click()
  await page.getByRole('menu').last().getByRole('menuitem', { name: /^Hide/ }).click()
  await expect(panel(page)).toHaveCount(0)
  await page.keyboard.press(TOGGLE)
  await expect(panel(page)).toBeVisible()
  await expect(page.locator('.zone-left [data-testid="terminal-panel"]')).toHaveCount(1)
  expect(await docked(page)).toHaveLength(1)
})

test('qa: Cmd+J collapses the bottom zone with the panel in it; its shell keeps running and the toggle brings it back', async ({ cockpit: c }) => {
  const { page } = c
  await mainShell(c)
  await openPanelWithShell(c)
  await page.keyboard.type('sleep 2; echo after-collapse\n')
  await page.keyboard.press(`${MOD}+J`)
  await expect(panel(page)).toBeHidden()
  await page.waitForTimeout(3_000)
  expect(await docked(page)).toHaveLength(1)
  await page.keyboard.press(TOGGLE)
  await expect(panel(page)).toBeVisible()
  await c.waitForPanelTerminalText('after-collapse', 3_000)
})

test('qa: the toggle does nothing while the palette or the settings dialog is open', async ({ cockpit: c }) => {
  const { page } = c
  await mainShell(c)
  await page.keyboard.press(`${MOD}+Shift+P`)
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
  await page.keyboard.press(TOGGLE)
  await page.waitForTimeout(800)
  await expect(panel(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)

  await page.getByRole('banner').getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog').first()
  await expect(settings).toBeVisible()
  await page.keyboard.press(TOGGLE)
  await page.waitForTimeout(800)
  await expect(panel(page)).toHaveCount(0)
  expect(await docked(page)).toHaveLength(0)
  await page.keyboard.press('Escape')
})

test('qa: the toggle from a Cyrillic layout (the Backquote key types ё)', async ({ cockpit: c }) => {
  const { page } = c
  await mainShell(c)
  await c.typeLine('echo main-focus')
  const cdp = await page.context().newCDPSession(page)
  const key = { key: 'ё', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192, modifiers: 2 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
  await expect(panel(page)).toBeVisible()
  await c.waitForPanelTerminalText('FAKE-SHELL ready')
  expect(await undocked(page)).toHaveLength(1)
})

test('qa: a move made in a browser view opens the panel there only; the desktop keeps its panel closed', async ({ cockpit: c }) => {
  test.setTimeout(90_000)
  const { page } = c
  const a = await mainShell(c)
  await c.typeLine('echo tag-from-desktop')
  const b = await mainShell(c)
  const web = await enableWebAccess(c)
  let br: WebBrowser | undefined
  try {
    br = await openBrowser(web.link)
    await openProjectInBrowser(br, web.origin, web.projectId)
    const bp = br.page
    await expect(bp.locator('.zones-centre .tab[data-tab-id]')).toHaveCount(2)
    await bp.locator(`.zones-centre .tab[data-tab-id="${a}"]`).click({ button: 'right' })
    await bp.getByRole('menu', { name: 'Tab' }).getByRole('menuitem', { name: 'Move to Terminal panel' }).click()
    await expect(panel(bp)).toBeVisible()
    await br.waitForPanelTerminalText('tag-from-desktop')
    await expect(bp.locator('.zones-centre .tab[data-tab-id]')).toHaveCount(1)
    // The desktop: the tab left its main strip, its panel stayed closed.
    await expect.poll(() => mainTabIds(page)).toEqual([b])
    await page.waitForTimeout(1_000)
    await expect(panel(page)).toHaveCount(0)
  } finally {
    await br?.close()
  }
})

test('qa: closing a running panel tab asks like any running tab; Cancel keeps it', async () => {
  const { cockpit: c, close } = await launchCockpit({ confirmTabClose: true })
  try {
    const { page } = c
    await openPanelWithShell(c)
    await page.keyboard.type('sleep 60\n')
    await page.waitForTimeout(500)
    await page.keyboard.press(`${MOD}+W`)
    const ask = page.getByRole('alertdialog')
    await expect(ask).toBeVisible()
    await expect(ask).toContainText('still running')
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await expect(ask).toHaveCount(0)
    await expect(panelTabs(page)).toHaveCount(1)
    await panelStrip(page).getByRole('button', { name: /^Close Shell/ }).click()
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByTestId('terminal-panel-empty')).toBeVisible()
  } finally {
    await close()
  }
})

test('qa: Move left and Move right in the panel strip reorder the panel tabs only', async ({ cockpit: c }) => {
  const { page } = c
  const m = await mainShell(c)
  await openPanelWithShell(c)
  await page.keyboard.press(NEW_TERMINAL)
  await page.keyboard.press(NEW_TERMINAL)
  await expect(panelTabs(page)).toHaveCount(3)
  const [p1, p2, p3] = await panelTabIds(page)
  await page.locator(`.terminal-panel-tab[data-panel-tab-id="${p3}"]`).getByRole('tab').click({ button: 'right' })
  await page.getByRole('menu', { name: 'Terminal tab' }).getByRole('menuitem', { name: 'Move left' }).click()
  await expect.poll(() => panelTabIds(page)).toEqual([p1, p3, p2])
  await page.locator(`.terminal-panel-tab[data-panel-tab-id="${p1}"]`).getByRole('tab').click({ button: 'right' })
  await page.getByRole('menu', { name: 'Terminal tab' }).getByRole('menuitem', { name: 'Move right' }).click()
  await expect.poll(() => panelTabIds(page)).toEqual([p3, p1, p2])
  expect(await mainTabIds(page)).toEqual([m])
  // Main's own order agrees with the strip (one order, docked tabs in the same relative order).
  expect((await docked(page)).map((t) => t.id)).toEqual([p3, p1, p2])
})

test('qa: a window whose tabs are all in the panel opens on "No tabs yet" after a restart, the panel tabs intact', async () => {
  test.setTimeout(60_000)
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    await openPanelWithShell(first.cockpit)
    await first.cockpit.page.waitForTimeout(2_000)
  } finally {
    await first.close({ keepFiles: true })
  }
  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    await expect(c.page.getByText('No tabs yet')).toBeVisible()
    expect((await c.hook<TabInfo[]>('tabs', c.projectDir)).map((t) => t.dock)).toEqual(['panel'])
    if (!(await panel(c.page).isVisible())) await c.page.keyboard.press(TOGGLE)
    await expect(panelTabs(c.page)).toHaveCount(1)
    await c.waitForPanelTerminalText('FAKE-SHELL ready')
  } finally {
    await second.close()
  }
})

test('qa: server mode: the hidden page draws no panel; a browser opens it with Ctrl+` and runs a shell in it', async () => {
  test.setTimeout(90_000)
  const server = await launchServer()
  let br: WebBrowser | undefined
  try {
    br = await openBrowser(`${server.origin}/`)
    await openProjectInBrowser(br, server.origin, server.projectId)
    const bp = br.page
    await bp.locator('.tabs-pane').click()
    await bp.keyboard.press(TOGGLE)
    await expect(panel(bp)).toBeVisible()
    await br.waitForPanelTerminalText('FAKE-SHELL ready')
    await bp.keyboard.type('echo srv-panel-$((40+2))\n')
    await br.waitForPanelTerminalText('srv-panel-42')
    expect((await server.cockpit.hook<TabInfo[]>('tabs', server.cockpit.projectDir)).map((t) => t.dock)).toEqual(['panel'])
    // The hidden page never draws the panel.
    await expect(panel(server.cockpit.page)).toHaveCount(0)
    await expectMainAlive(server)
  } finally {
    await br?.close()
    await server.close()
  }
})
