// The Terminal panel (docs/design-terminal-panel.md §11, §13): a VS Code style panel of shell and command tabs in the
// bottom zone. A tab there keeps its session and output while the panel is hidden, moves to the tab area and back as the
// same tab, comes back in the panel after a restart; Cmd+W closes the tab of the area that has the keys; the open state
// is per screen (a browser view opens and closes its own); a guest sees neither the panel nor a docked tab, and a tab it
// was watching cuts its stream off when it is docked (a narrowing, close 4464).
//
// Markers are printed by shell arithmetic (`echo dock-$((6*7))` prints dock-42), so the command line echoed back never
// holds the text a step waits for: only the shell's output does.
import type { Locator, Page } from '@playwright/test'
import type { CockpitApi, TabInfo } from '../../src/shared/ipc'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { inviteGuest, rawSocket, redeemOk, type RawSocket } from './guest-fixtures'
import { enableWebAccess, openBrowser } from './web-fixtures'

const panel = (page: Page): Locator => page.getByTestId('terminal-panel')
const panelTabs = (page: Page): Locator => page.getByRole('tablist', { name: 'Terminal tabs' }).getByRole('tab')
/** The main area's strip: the bottom zone (the panel's strip) is outside `.zones-centre`. */
const mainTabs = (page: Page): Locator => page.locator('.zones-centre').getByRole('tablist').getByRole('tab')

async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return page.evaluate(
    async ([ch, p]) => ((window as unknown as { cockpit: CockpitApi }).cockpit.invoke as unknown as (c: string, q?: unknown) => Promise<unknown>)(ch, p),
    [channel, payload] as const
  ) as Promise<T>
}

const tabsOf = (c: Cockpit): Promise<TabInfo[]> => c.hook<TabInfo[]>('tabs', c.projectDir)

/** Open the panel with its toggle (Ctrl+\`, also on macOS) and wait for it. */
async function togglePanel(page: Page, open: boolean): Promise<void> {
  await page.keyboard.press('Control+Backquote')
  if (open) await expect(panel(page)).toBeVisible()
  else await expect(panel(page)).toHaveCount(0)
}

/** Open an empty panel with its toggle: it starts a shell there (§1) and takes the keys. */
async function openPanelWithShell(c: Cockpit): Promise<void> {
  await togglePanel(c.page, true)
  await expect(panelTabs(c.page)).toHaveCount(1)
  await c.waitForPanelTerminalText('FAKE-SHELL ready')
}

/** A new shell in the panel through its New terminal menu. */
async function newPanelShell(page: Page): Promise<void> {
  await panel(page).getByRole('button', { name: 'New terminal' }).click()
  await page.getByRole('menu', { name: 'New terminal' }).getByRole('menuitem', { name: 'Shell' }).click()
}

test('a panel shell keeps running and its output while the panel is hidden; the main area is left alone', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')

  // Closed by default; the toggle opens it, and an empty panel gets a shell.
  await expect(panel(page)).toHaveCount(0)
  await openPanelWithShell(cockpit)
  const docked = (await tabsOf(cockpit)).filter((t) => t.dock === 'panel')
  expect(docked).toHaveLength(1)
  // The main area still has its one tab, and the panel's is not in its strip.
  await expect(mainTabs(page)).toHaveCount(1)

  // Output over time; the panel hides before most of it arrives.
  await cockpit.panelTypeLine('for i in 1 2 3; do sleep 1; echo tick-$((i*11)); done')
  await togglePanel(page, false)
  await page.waitForTimeout(3800)
  await togglePanel(page, true)
  await cockpit.waitForPanelTerminalText('tick-33')
  expect(await cockpit.panelTerminalText()).toContain('tick-11')
  expect((await tabsOf(cockpit)).find((t) => t.id === docked[0]!.id)).toBeTruthy()
  // The main terminal never got the panel's output.
  expect(await cockpit.terminalText()).not.toContain('tick-')
})

test('a tab moves into the panel and back as the same tab, its session and output kept', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await cockpit.typeLine('echo dock-$((6*7))')
  await cockpit.waitForTerminalText('dock-42')
  const [tab] = (await tabsOf(cockpit)) as [TabInfo]

  // The person's own move: the panel opens on this screen with the tab selected.
  await mainTabs(page).first().click({ button: 'right' })
  await page.getByRole('menu', { name: 'Tab' }).getByRole('menuitem', { name: 'Move to Terminal panel' }).click()
  await expect(panel(page)).toBeVisible()
  await expect(panelTabs(page)).toHaveCount(1)
  await expect(mainTabs(page)).toHaveCount(0)
  await cockpit.waitForPanelTerminalText('dock-42')
  await expect.poll(async () => (await tabsOf(cockpit)).map((t) => [t.id, t.dock])).toEqual([[tab.id, 'panel']])

  // Still the same shell: typing in the panel reaches it.
  await cockpit.panelTypeLine('echo inpanel-$((5*5))')
  await cockpit.waitForPanelTerminalText('inpanel-25')

  // Back to the tab area: selected there, the panel left on "No terminals".
  await panelTabs(page).first().click({ button: 'right' })
  await page.getByRole('menu', { name: 'Terminal tab' }).getByRole('menuitem', { name: 'Move to tab area' }).click()
  await expect(mainTabs(page)).toHaveCount(1)
  await expect(page.getByTestId('terminal-panel-empty')).toBeVisible()
  await cockpit.waitForTerminalText('inpanel-25')
  expect(await cockpit.terminalText()).toContain('dock-42')
  await expect.poll(async () => (await tabsOf(cockpit)).map((t) => [t.id, t.dock])).toEqual([[tab.id, undefined]])
  await cockpit.typeLine('echo back-$((9*9))')
  await cockpit.waitForTerminalText('back-81')
})

test('a docked tab comes back in the panel after a restart; the main area opens on its empty state', async () => {
  test.setTimeout(90_000)
  const first = await launchCockpit()
  const root = first.cockpit.root
  try {
    await openPanelWithShell(first.cockpit)
    await expect.poll(async () => (await tabsOf(first.cockpit)).map((t) => t.dock)).toEqual(['panel'])
  } finally {
    await first.close({ keepFiles: true })
  }

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    await expect.poll(async () => (await tabsOf(c)).map((t) => [t.kind, t.dock])).toEqual([['shell', 'panel']])
    await expect(mainTabs(c.page)).toHaveCount(0)
    if ((await panel(c.page).count()) === 0) await togglePanel(c.page, true)
    await expect(panelTabs(c.page)).toHaveCount(1)
    await c.waitForPanelTerminalText('FAKE-SHELL ready')
  } finally {
    await second.close()
  }
})

test('Cmd+W closes the tab of the area that has the keys: the panel tab with panel keys, the main tab with main keys', async ({ cockpit }) => {
  test.setTimeout(60_000)
  const { page } = cockpit
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await openPanelWithShell(cockpit)

  // Keys in the panel: its tab goes, the main one stays; the last panel tab leaves the panel on "No terminals" (§13.4).
  await page.locator('[data-testid="terminal-panel"] .terminal-view .xterm').click()
  await page.keyboard.press('ControlOrMeta+W')
  await expect(panelTabs(page)).toHaveCount(0)
  await expect(page.getByTestId('terminal-panel-empty')).toContainText('No terminals')
  await expect(mainTabs(page)).toHaveCount(1)

  // A new panel tab, then the keys back in the main area: the main tab goes, the panel's stays.
  await newPanelShell(page)
  await cockpit.waitForPanelTerminalText('FAKE-SHELL ready')
  await page.locator('[data-split-area] .terminal-view:not([hidden]) .xterm').click()
  await page.keyboard.press('ControlOrMeta+W')
  await expect(mainTabs(page)).toHaveCount(0)
  await expect(panelTabs(page)).toHaveCount(1)
  await expect.poll(async () => (await tabsOf(cockpit)).map((t) => t.dock)).toEqual(['panel'])
})

test('a browser view has its own open state and streams the panel tab', async ({ cockpit }) => {
  test.setTimeout(90_000)
  const { page } = cockpit
  const web = await enableWebAccess(cockpit)
  await openPanelWithShell(cockpit)
  await cockpit.panelTypeLine('echo desk-$((40+2))')
  await cockpit.waitForPanelTerminalText('desk-42')

  const browser = await openBrowser(web.link)
  try {
    const { page: webPage } = browser
    await webPage.getByRole('list', { name: 'Open projects' }).getByRole('link').click()
    await webPage.locator('.tabs-pane').waitFor()
    // Open on the desktop, closed here: a view with no open state of its own starts closed (§13.1).
    await expect(panel(webPage)).toHaveCount(0)
    await togglePanel(webPage, true)
    await expect(panelTabs(webPage)).toHaveCount(1)
    await browser.waitForPanelTerminalText('desk-42')
    // Live: the desktop's typing reaches the browser's panel.
    await cockpit.panelTypeLine('echo live-$((60+6))')
    await browser.waitForPanelTerminalText('live-66')

    // Closing it here leaves the desktop's open; closing the desktop's leaves this one's.
    await togglePanel(webPage, false)
    await page.waitForTimeout(500)
    await expect(panel(page)).toBeVisible()
    await togglePanel(webPage, true)
    await togglePanel(page, false)
    await webPage.waitForTimeout(500)
    await expect(panel(webPage)).toBeVisible()
  } finally {
    await browser.close()
  }
})

test("a guest sees no panel and no docked tab; docking the tab it watches cuts its stream (4464)", async ({ cockpit }) => {
  test.setTimeout(90_000)
  const { page } = cockpit
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await openPanelWithShell(cockpit)
  const tabs = await tabsOf(cockpit)
  const mainTab = tabs.find((t) => t.dock === undefined)!
  const panelTab = tabs.find((t) => t.dock === 'panel')!
  const web = await enableWebAccess(cockpit)
  const inv = await inviteGuest(cockpit, { name: 'Gus', role: 'write', scope: 'all' })
  const client = await redeemOk(web.origin, inv.token)

  let callId = 0
  const guestInvoke = async (s: RawSocket, ch: string, p: unknown): Promise<boolean> => {
    const id = ++callId
    s.ws.send(JSON.stringify({ t: 'invoke', id, ch, p }))
    return (await s.next((f) => f.t === 'result' && f.id === id, 5000)).ok === true
  }
  type Ready = { snapshot: { tabs: TabInfo[]; layout: { panels: Array<{ panelKey: string }> } } }

  let g = await rawSocket(client)
  const ready = (await g.next((f) => f.t === 'ready')) as unknown as Ready
  expect(ready.snapshot.tabs.map((t) => t.id)).toEqual([mainTab.id])
  expect(ready.snapshot.layout.panels.map((p) => p.panelKey)).not.toContain('core/terminal')
  expect(g.texts.join('')).not.toContain(panelTab.id)
  expect(await guestInvoke(g, 'tabs.selected', { tabId: panelTab.id })).toBe(false)

  // Watching the main tab: its stream comes.
  expect(await guestInvoke(g, 'tabs.selected', { tabId: mainTab.id })).toBe(true)
  await g.next((f) => f.t === 'term.snapshot' && f.tabId === mainTab.id)

  // The owner docks it: a narrowing, at once.
  const t0 = Date.now()
  await invoke(page, 'tabs.dock', { tabId: mainTab.id, dock: 'panel' })
  const cut = await Promise.race([g.closed, new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000))])
  expect(cut?.code).toBe(4464)
  expect(cut!.at - t0).toBeLessThan(1500)

  // The next socket's snapshot has neither tab, and joining the docked one is refused.
  g = await rawSocket(client)
  const again = (await g.next((f) => f.t === 'ready')) as unknown as Ready
  expect(again.snapshot.tabs).toEqual([])
  expect(await guestInvoke(g, 'tabs.selected', { tabId: mainTab.id })).toBe(false)
  await cockpit.panelTypeLine('echo after-$((3*3))')
  await cockpit.waitForPanelTerminalText('after-9')
  await page.waitForTimeout(500)
  expect(g.frames.some((f) => (f.t === 'term.data' || f.t === 'term.snapshot') && f.tabId === mainTab.id)).toBe(false)
  g.close()
})
