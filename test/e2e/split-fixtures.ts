// Helpers of the split-view e2e specs (design.md §1 "Tests", tasks/05-integration.md). Written from the
// design, the decisions and the shared contract (src/shared/tab-groups.ts, src/shared/ipc.ts) only.
//
// What these rely on, and nothing else of the UI:
//  - `window.cockpit.invoke` in BOTH pages (the desktop's preload and the web shell's bridge), so a
//    "split made in the browser" is the same intent the UI sends (`groups.place`, `tabs.create` +
//    `beside`, `groups.remove`, `groups.resize`), not a drag;
//  - a pane is a visible `[data-pane]` element (D19; one hidden by zoom or another group is not visible);
//  - the focused pane is `data-focused-pane="<tabId>"` on its `data-pane="<tabId>"` element (D19; only
//    while more than one pane is visible);
//  - the strip segment is `role=group` with a label, panes are labelled regions, a zoomed group says
//    "zoomed (n hidden)", a plugin-opened pane's header says "Opened by <plugin name>" (D8).
//
// A pane is told apart by what it printed: `tag(page, 'pa')` types `echo pa-$((1+1))` into the pane
// the page has focused, and the pane then shows `pa-2` (the typed line has `$((1+1))`, never `pa-2`).
import { expect, type Locator, type Page } from '@playwright/test'
import type { GroupsReply, TabCreateRequest, TabInfo } from '../../src/shared/ipc'
import type { GroupsSnapshot, PaneEdge, PaneNode, TabGroup } from '../../src/shared/tab-groups'
import type { Cockpit } from './fixtures'

export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

type Invoke = (channel: string, payload?: unknown) => Promise<unknown>

/** One `invoke` from inside `page` (the desktop's or the browser's `window.cockpit`). */
export async function invoke<T>(page: Page, channel: string, payload?: unknown): Promise<T> {
  return (await page.evaluate(
    ([c, p]) => (window as unknown as { cockpit: { invoke: Invoke } }).cockpit.invoke(c as string, p),
    [channel, payload] as const
  )) as T
}

export const tabsOf = (page: Page): Promise<TabInfo[]> => invoke<TabInfo[]>(page, 'tabs.list')
export const groupsOf = (page: Page): Promise<GroupsSnapshot> => invoke<GroupsSnapshot>(page, 'groups.get')

export const place = (page: Page, tabId: string, at: string, edge: PaneEdge): Promise<GroupsReply> =>
  invoke<GroupsReply>(page, 'groups.place', { tabId, at, edge })

/** `tabs.create` with an optional placement: create and place in one step. */
export const createTab = (page: Page, req: TabCreateRequest): Promise<TabInfo | null> => invoke<TabInfo | null>(page, 'tabs.create', req)

/** The tab ids of a group in tree (reading) order. */
export function leaves(node: PaneNode): string[] {
  return 'tab' in node ? [node.tab] : node.children.flatMap(leaves)
}
export const groupOfTab = (snap: GroupsSnapshot, tabId: string): TabGroup | undefined => snap.groups.find((g) => leaves(g.root).includes(tabId))

/** Visible panes: terminals drawn right now in this page. */
export const visiblePanes = (page: Page): Locator => page.locator('[data-pane]:visible')
/** One pane by its tab id (D19: `data-pane="<tabId>"`). */
export const paneOf = (page: Page, tabId: string): Locator => page.locator(`[data-pane="${tabId}"]`)
/** Dividers (D19: `role=separator` with `data-split-divider="<splitId>:<index>"`). */
export const dividers = (page: Page): Locator => page.locator('[role="separator"][data-split-divider]')
/** The split area's zoom state (D19: `data-zoom="manual"` or `"auto"`). */
export const splitArea = (page: Page): Locator => page.locator('[data-split-area]')
/** The visible pane whose screen shows `text`. */
export const paneShowing = (page: Page, text: string): Locator => visiblePanes(page).filter({ hasText: text })
/** What the pane has focused: the `data-focused-pane` mark (an unfocused pane has none, or "false"). */
export const focusedPanes = (page: Page): Locator => page.locator('[data-pane][data-focused-pane]')
/** A group's strip segment (`role=group`, labelled). */
export const segments = (page: Page): Locator => page.getByRole('group')

/** Rows of one pane's screen joined with newlines. */
export async function paneText(pane: Locator): Promise<string> {
  return (await pane.locator('.xterm-rows > div').allInnerTexts()).join('\n')
}

export async function waitPaneText(pane: Locator, text: string, timeout = 10_000): Promise<void> {
  await expect.poll(async () => (await paneText(pane)).replaceAll('\n', '').includes(text), { timeout, message: `pane never showed ${text}` }).toBe(true)
}

/** Click a pane's terminal (focuses it in this view) and type a line into it. */
export async function typeInPane(page: Page, pane: Locator, line: string): Promise<void> {
  await pane.locator('.xterm').click()
  await page.keyboard.type(line)
  await page.keyboard.press('Enter')
}

/** Names a pane by what it prints: `<tag>-2` appears on its screen. The pane must be locatable by `showing`. */
export async function tagPane(page: Page, pane: Locator, tag: string): Promise<void> {
  await typeInPane(page, pane, `echo ${tag}-$((1+1))`)
  await waitPaneText(visiblePanes(page).filter({ hasText: `${tag}-2` }), `${tag}-2`)
}

/**
 * A new shell tab on the desktop (the [+] menu), tagged `tag`. Its own pane is waited for and typed
 * into, by the new tab's id: `.terminal-view:not([hidden])` and the shell's ready line do not tell it
 * from the tab before it (whose screen shows `FAKE-SHELL ready` too), and on a loaded macOS run the
 * click went to a terminal that was not the one drawn ("element is not visible").
 */
export async function newTaggedShell(cockpit: Cockpit, tag: string): Promise<TabInfo> {
  const { page } = cockpit
  const before = new Set((await tabsOf(page)).map((t) => t.id))
  await cockpit.newTab('shell')
  await expect.poll(async () => (await tabsOf(page)).filter((t) => !before.has(t.id)).length).toBe(1)
  const created = (await tabsOf(page)).find((t) => !before.has(t.id))!
  const pane = paneOf(page, created.id)
  await expect(pane).toBeVisible()
  await waitPaneText(pane, 'FAKE-SHELL ready')
  await typeInPane(page, pane, `echo ${tag}-$((1+1))`)
  await waitPaneText(pane, `${tag}-2`)
  return created
}

/**
 * Tagged shells `tags` on the desktop, then one group of them: each next tab placed to the right of
 * the previous one (so a 3-pane group is a row of three; its root is one split). Returns the tab ids
 * in `tags` order.
 */
export async function groupOfShells<const T extends readonly string[]>(cockpit: Cockpit, tags: T): Promise<{ [K in keyof T]: string }> {
  // A roomy window: three or four panes in a row would otherwise fall under the auto-zoom size (D5)
  // on the default window, and this helper wants every pane drawn.
  await roomyDesktop(cockpit)
  const ids: string[] = []
  for (const tag of tags) ids.push((await newTaggedShell(cockpit, tag)).id)
  for (let i = 1; i < ids.length; i++) {
    const reply = await place(cockpit.page, ids[i]!, ids[i - 1]!, 'right')
    expect(reply.ok, JSON.stringify(reply)).toBe(true)
  }
  await expect(visiblePanes(cockpit.page)).toHaveCount(tags.length)
  return ids as unknown as { [K in keyof T]: string }
}

/** The group `groups.get` returns for `tabId`, or undefined. */
export async function groupFor(page: Page, tabId: string): Promise<TabGroup | undefined> {
  return groupOfTab(await groupsOf(page), tabId)
}

/** `groups.changed` events the page sees from now on (seq numbers), to count what an action sent. */
export async function recordGroupEvents(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { cockpit: { on: (c: string, f: (p: { seq: number }) => void) => void }; __groupSeqs?: number[] }
    w.__groupSeqs = []
    w.cockpit.on('groups.changed', (snap) => w.__groupSeqs!.push(snap.seq))
  })
  return () => page.evaluate(() => (window as unknown as { __groupSeqs?: number[] }).__groupSeqs ?? [])
}

/** Whether the page's DOM focus is inside a terminal (an xterm textarea): false once keys go off (D18). */
export function domFocusInTerminal(page: Page): Promise<boolean> {
  return page.evaluate(() => document.activeElement?.closest('.xterm') != null)
}

/**
 * The desktop window at 1900x1000 and not resizable: a tiling window manager (Hyprland) floats a
 * fixed-size window and so leaves it alone when the browser window appears, instead of re-tiling it
 * to half the screen (which would auto-zoom the split view there, D5/D25). Test code only.
 */
export async function roomyDesktop(cockpit: Cockpit): Promise<void> {
  await cockpit.app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w?.setSize(1900, 1000)
    w?.setResizable(false)
  })
  await expect.poll(() => cockpit.page.evaluate(() => innerWidth)).toBeGreaterThan(1500)
}

/**
 * Move every window off the real OS cursor right before a synthetic mouse drag (zones.spec.ts
 * keepOsCursorOff). A cursor over the window, above all one the person at the Mac is moving, sends
 * buttonless moves (trusted, at fractional coordinates the test never used) between Playwright's
 * pressed ones; Chromium then drops the divider's pointer capture and the Splitter ends the drag
 * there (its `onLostPointerCapture`, kept for a real lost capture), sending a `groups.resize`
 * mid-drag. Seen on master and on branches alike, whenever the desk was in use. Test code only:
 * layout and the test's viewport coordinates do not depend on where the window sits.
 */
export async function keepOsCursorOff(cockpit: Cockpit): Promise<void> {
  await cockpit.app.evaluate(({ BrowserWindow, screen }) => {
    const p = screen.getCursorScreenPoint()
    for (const w of BrowserWindow.getAllWindows()) {
      const b = w.getBounds()
      const over = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
      // Partly off screen is fine: layout and the test's coordinates do not depend on it.
      if (over) w.setPosition(p.x + 20, b.y)
    }
  })
}
