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
export const zoomMark = (page: Page): Locator => page.locator('[data-zoom]')
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
 * A new shell tab on the desktop (the [+] menu), tagged `tag`. Alone on screen when no group is shown,
 * so the single visible terminal is the one that is typed into.
 */
export async function newTaggedShell(cockpit: Cockpit, tag: string): Promise<TabInfo> {
  const before = new Set((await tabsOf(cockpit.page)).map((t) => t.id))
  await cockpit.newTab('shell')
  await cockpit.waitForTerminalText('FAKE-SHELL ready')
  await expect.poll(async () => (await tabsOf(cockpit.page)).filter((t) => !before.has(t.id)).length).toBe(1)
  const created = (await tabsOf(cockpit.page)).find((t) => !before.has(t.id))!
  await cockpit.typeLine(`echo ${tag}-$((1+1))`)
  await cockpit.waitForTerminalText(`${tag}-2`)
  return created
}

/**
 * Tagged shells `tags` on the desktop, then one group of them: each next tab placed to the right of
 * the previous one (so a 3-pane group is a row of three; its root is one split). Returns the tab ids
 * in `tags` order.
 */
export async function groupOfShells<const T extends readonly string[]>(cockpit: Cockpit, tags: T): Promise<{ [K in keyof T]: string }> {
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
