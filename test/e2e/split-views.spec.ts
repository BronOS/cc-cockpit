// Split terminal view, desktop + one browser view (design.md §1 "Tests", decisions D1-D5, D8, D12;
// tasks/05-integration.md). Written from the design only. A split is made by the intents the UI sends
// (`groups.place`, `tabs.create` + `beside`, `groups.remove`, `groups.resize`) through `window.cockpit`
// of whichever page, so the specs do not depend on how a drag or a menu is drawn; the chord and the
// hooks the design promises (`data-focused-pane`, the strip's `role=group`, "zoomed (n hidden)",
// "Opened by") are asserted where the design names them.
//
// Panes are told apart by what they printed (`pa-2`, `pb-2`, ...: shell arithmetic, so the typed line
// never contains the text a step waits for).
import type { Page } from '@playwright/test'
import type { GroupsSnapshot } from '../../src/shared/tab-groups'
import { expect, test, type Cockpit } from './fixtures'
import {
  MOD,
  createTab,
  focusedPanes,
  groupFor,
  groupOfShells,
  groupsOf,
  invoke,
  leaves,
  newTaggedShell,
  paneOf,
  paneShowing,
  paneText,
  splitArea,
  place,
  recordGroupEvents,
  tabsOf,
  typeInPane,
  visiblePanes,
  waitPaneText
} from './split-fixtures'
import { enableWebAccess, openBrowser, openProjectInBrowser, type WebBrowser } from './web-fixtures'

/** Opens the project in a browser view and selects the first tab (a group's segment starts at it). */
async function joinBrowser(cockpit: Cockpit): Promise<{ browser: WebBrowser; web: Page }> {
  const on = await enableWebAccess(cockpit)
  const browser = await openBrowser(on.link)
  // A roomy window, set before the project opens (the browser takes the pty size when it loads, and a
  // narrow take would auto-zoom the desktop too, see run-1.md): four panes in a row must not fall
  // under the auto-zoom size (D5) by themselves.
  await browser.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1900, 1000))
  await openProjectInBrowser(browser, on.origin, on.projectId)
  return { browser, web: browser.page }
}

test('a split made on the desktop shows in the browser, and one made in the browser shows on the desktop', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    // Desktop -> browser: the browser's snapshot carries the group; selecting its first tab draws both panes.
    await expect.poll(async () => (await groupsOf(web)).groups.length).toBe(1)
    await web.getByRole('tab').first().click()
    await expect(visiblePanes(web)).toHaveCount(2)
    await waitPaneText(paneShowing(web, 'pa-2'), 'pa-2')
    await waitPaneText(paneShowing(web, 'pb-2'), 'pb-2')
    // The strip: the group is a bracketed segment, role=group with a label, both members inside it.
    const segment = web.getByRole('group').filter({ has: web.getByRole('tab') })
    await expect(segment).toHaveCount(1)
    await expect(segment.getByRole('tab')).toHaveCount(2)
    await expect(segment).toHaveAttribute('aria-label', /.+/)

    // Browser -> desktop: a new pane made with `tabs.create` + `beside` in the browser (create and
    // place in one step, D15: the desktop never sees the tab ungrouped).
    const created = await createTab(web, { kind: 'shell', beside: { tabId: b, edge: 'down' } })
    expect(created).not.toBeNull()
    await expect.poll(async () => leaves((await groupsOf(page)).groups[0]!.root)).toEqual([a, b, created!.id])
    // The desktop shows three panes once its selection is in the group (it is: tab b's group).
    await expect(visiblePanes(page)).toHaveCount(3)
    await expect(visiblePanes(web)).toHaveCount(3)
    // The same model in both views: one group, the same tree, the same tab order.
    const [d, w] = await Promise.all([groupsOf(page), groupsOf(web)])
    expect(w.groups).toEqual(d.groups)
    expect(w.order).toEqual(d.order)
    expect(d.groups[0]!.root.children.length).toBeGreaterThanOrEqual(2)
  } finally {
    await browser.close()
  }
})

test('each view focuses its own pane and typing reaches the right pty', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    await web.getByRole('tab').first().click()
    await expect(visiblePanes(web)).toHaveCount(2)
    await expect(visiblePanes(page)).toHaveCount(2)

    // The desktop types in pane A, the browser in pane B, at the same time.
    await paneShowing(page, 'pa-2').locator('.xterm').click()
    await paneShowing(web, 'pb-2').locator('.xterm').click()
    // Each view marks its own focused pane (more than one pane is visible), exactly one.
    await expect(focusedPanes(page)).toHaveCount(1)
    await expect(focusedPanes(web)).toHaveCount(1)
    await page.keyboard.type('echo fromdesk-$((20+2))')
    await page.keyboard.press('Enter')
    await web.keyboard.type('echo fromweb-$((30+3))')
    await web.keyboard.press('Enter')

    // The desktop's line is on A (both views), the browser's on B (both views); neither crossed.
    for (const view of [page, web]) {
      await waitPaneText(paneShowing(view, 'pa-2'), 'fromdesk-22')
      await waitPaneText(paneShowing(view, 'pb-2'), 'fromweb-33')
    }
    for (const view of [page, web]) {
      expect(await paneText(paneShowing(view, 'pa-2'))).not.toContain('fromweb-33')
      expect(await paneText(paneShowing(view, 'pb-2'))).not.toContain('fromdesk-22')
    }
  } finally {
    await browser.close()
  }
})

test('D3: a pane the desktop types in is unsplit by the browser: the desktop focuses no terminal and keys reach no tab', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b, c] = await groupOfShells(cockpit, ['pa', 'pb', 'pc'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    await web.getByRole('tab').first().click()
    await expect(visiblePanes(web)).toHaveCount(3)

    // The desktop is typing in pane A (a click focuses it; it types a line to prove it).
    await typeInPane(page, paneShowing(page, 'pa-2'), 'echo mine-$((1+1))')
    await waitPaneText(paneShowing(page, 'pa-2'), 'mine-2')
    await expect(focusedPanes(page)).toHaveCount(1)

    // Another view closes that pane's tab (a change made elsewhere): the group keeps B and C.
    await invoke(web, 'tabs.close', { tabId: a })
    await expect.poll(async () => (await tabsOf(page)).map((t) => t.id)).toEqual([b, c])
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(paneOf(page, a)).toHaveCount(0)

    // D3: no terminal is focused on the desktop until the person clicks or uses a chord.
    await expect(focusedPanes(page)).toHaveCount(0)
    // Keys typed now (the person is mid-sentence) go nowhere: not to B, not to C.
    await page.keyboard.type('echo leak-$((7+8))')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    for (const pane of [paneShowing(page, 'pb-2'), paneShowing(page, 'pc-2')]) expect(await paneText(pane)).not.toContain('leak-15')
    await expect(focusedPanes(page)).toHaveCount(0)

    // A click is what focuses again.
    await paneShowing(page, 'pb-2').locator('.xterm').click()
    await expect(focusedPanes(page)).toHaveCount(1)
    await page.keyboard.type('echo ok-$((4+4))')
    await page.keyboard.press('Enter')
    await waitPaneText(paneShowing(page, 'pb-2'), 'ok-8')
    expect(await paneText(paneShowing(page, 'pc-2'))).not.toContain('ok-8')
  } finally {
    await browser.close()
  }
})

test('D3: a browser moves the desktop\'s pane out of its group; the desktop\'s keys reach no other tab', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b, c] = await groupOfShells(cockpit, ['pa', 'pb', 'pc'])
  const plain = await newTaggedShell(cockpit, 'pd')
  const { browser, web } = await joinBrowser(cockpit)
  try {
    // The desktop selects the group and types in pane A.
    await page.getByRole('tab').first().click()
    await expect(visiblePanes(page)).toHaveCount(3)
    await typeInPane(page, paneShowing(page, 'pa-2'), 'echo mine-$((1+1))')
    await waitPaneText(paneShowing(page, 'pa-2'), 'mine-2')

    // The browser unsplits that pane: A is a plain tab again (nothing closes), the group is B, C.
    expect(((await invoke<{ ok: boolean }>(web, 'groups.remove', { tabId: a })).ok)).toBe(true)
    await expect.poll(async () => leaves((await groupsOf(page)).groups[0]!.root)).toEqual([b, c])
    expect((await tabsOf(page)).map((t) => t.id).sort()).toEqual([a, b, c, plain.id].sort())
    // D18: the desktop keeps showing what is left of the group (B and C), with no focused pane.
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(paneOf(page, b)).toBeVisible()
    await expect(paneOf(page, c)).toBeVisible()
    await expect(paneOf(page, a)).toHaveCount(0)
    await expect(focusedPanes(page)).toHaveCount(0)

    // Keys the desktop types without a click reach no tab at all: not A, B, C or the plain tab.
    await page.keyboard.type('echo leak-$((7+8))')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    // Read every tab from the browser (its own selection, no key typed there).
    for (const tab of await tabsOf(web)) {
      await web.getByRole('tab').nth((await tabsOf(web)).findIndex((t) => t.id === tab.id)).click()
      await expect(visiblePanes(web).first()).toBeVisible()
      for (const pane of await visiblePanes(web).all()) expect(await paneText(pane)).not.toContain('leak-15')
    }
  } finally {
    await browser.close()
  }
})

test('a browser joining mid-run draws every pane of the group, each with its screen', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const ids = await groupOfShells(cockpit, ['pa', 'pb', 'pc', 'pd'])
  // Output after the group was made and before any browser exists: only the desktop has seen it.
  await typeInPane(cockpit.page, paneOf(cockpit.page, ids[3]), 'echo late-$((50+5))')
  await waitPaneText(paneOf(cockpit.page, ids[3]), 'late-55')

  const { browser, web } = await joinBrowser(cockpit)
  try {
    await web.getByRole('tab').first().click()
    await expect(visiblePanes(web)).toHaveCount(4)
    for (const tag of ['pa', 'pb', 'pc', 'pd']) await waitPaneText(paneShowing(web, `${tag}-2`), `${tag}-2`)
    // The pane the desktop typed in last has that line too; nothing is blank or "starting" for good.
    await waitPaneText(visiblePanes(web), 'late-55')
    expect((await groupsOf(web)).groups[0] && leaves((await groupsOf(web)).groups[0]!.root)).toEqual(ids)
    // Every pane is live in the browser: a new desktop line reaches the right pane.
    await typeInPane(cockpit.page, paneShowing(cockpit.page, 'pa-2'), 'echo live-$((60+6))')
    await waitPaneText(paneShowing(web, 'pa-2'), 'live-66')
  } finally {
    await browser.close()
  }
})

test('a member of an unselected group asking for permission shows in the strip, on both screens', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await cockpit.newTab('claude')
  await cockpit.waitForTerminalText('FAKE-CLAUDE banner')
  const claude = (await tabsOf(page)).find((t) => t.kind === 'claude')!
  const shellA = await newTaggedShell(cockpit, 'pa')
  expect((await place(page, claude.id, shellA.id, 'left')).ok).toBe(true)
  // A plain shell, selected: the group is not the one the desktop shows.
  await newTaggedShell(cockpit, 'pz')
  await expect(visiblePanes(page)).toHaveCount(1)

  const { browser, web } = await joinBrowser(cockpit)
  try {
    // The Claude tab asks for permission a moment later, while the desktop sits on the plain shell.
    await page.getByRole('tab').first().click() // select the Claude pane to type into it ...
    await expect(visiblePanes(page)).toHaveCount(2)
    await typeInPane(page, paneShowing(page, 'FAKE-CLAUDE banner'), '/later 1500 /permission')
    await page.getByRole('tab').last().click() // ... then leave the group
    await expect(visiblePanes(page)).toHaveCount(1)

    const dot = page.locator('.tab .status-dot[title*="needs permission"]')
    await expect(dot).toHaveCount(1, { timeout: 10_000 })
    // It sits in the group's segment, not on the plain tab, while that group is not shown.
    await expect(page.getByRole('group').filter({ has: dot })).toHaveCount(1)
    // The browser (selected on the plain shell too) sees it the same way.
    await web.getByRole('tab').last().click()
    await expect(web.locator('.tab .status-dot[title*="needs permission"]')).toHaveCount(1)
    await expect(web.getByRole('group').filter({ has: web.locator('.tab .status-dot[title*="needs permission"]') })).toHaveCount(1)
  } finally {
    await browser.close()
  }
})

test('zoom is per view: the desktop zooms one pane, the browser still shows both, the hidden member keeps its tab in the segment', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    await web.getByRole('tab').first().click()
    await expect(visiblePanes(web)).toHaveCount(2)
    await paneShowing(page, 'pb-2').locator('.xterm').click()

    await page.keyboard.press(`${MOD}+Shift+Enter`)
    await expect(visiblePanes(page)).toHaveCount(1)
    await expect(page.getByText(/zoomed \(1 hidden\)/)).toBeVisible()
    // The zoomed pane is the focused one; the hidden member is still in the segment with its dot.
    await expect(paneShowing(page, 'pb-2')).toBeVisible()
    const segment = page.getByRole('group').filter({ has: page.getByRole('tab') })
    await expect(segment.getByRole('tab')).toHaveCount(2)
    // Zoom sends nothing to other views and the shared model is untouched.
    await expect(visiblePanes(web)).toHaveCount(2)
    expect((await groupsOf(page)).groups).toHaveLength(1)

    // Zooming again brings the pane back; selecting a hidden member also unzooms (design §1 "Zoom").
    await page.keyboard.press(`${MOD}+Shift+Enter`)
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(page.getByText(/zoomed \(/)).toHaveCount(0)
  } finally {
    await browser.close()
  }
})

test('ungroup from the handle menu: members become plain tabs and nothing closes, in both views', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    const before = await groupsOf(page)
    await invoke(web, 'groups.dissolve', { groupId: before.groups[0]!.id })
    await expect.poll(async () => (await groupsOf(page)).groups).toEqual([])
    expect((await tabsOf(page)).map((t) => t.id)).toEqual([a, b])
    await expect(visiblePanes(page)).toHaveCount(1)
    await expect(page.getByRole('group').filter({ has: page.getByRole('tab') })).toHaveCount(0)
    await expect.poll(async () => (await groupsOf(web)).groups).toEqual([])
  } finally {
    await browser.close()
  }
})

test('D5, D6: a split past the caps is refused and changes nothing', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const ids = await groupOfShells(cockpit, ['pa', 'pb'])
  // Eight panes is the cap: fill the group (the 2 existing + 6 more), no pane is ever refused before.
  // Placed by `groups.place` (main's rules: caps), not by `beside` on create: the page may refuse a
  // split that would leave a pane under 20 columns in this window (D5), which is not what this checks.
  for (let i = 0; i < 6; i++) {
    const t = await createTab(page, { kind: 'shell' })
    expect(t, `pane ${i + 3}`).not.toBeNull()
    expect((await place(page, t!.id, ids[0]!, 'right')).ok, `pane ${i + 3}`).toBe(true)
  }
  await expect.poll(async () => leaves((await groupsOf(page)).groups[0]!.root).length).toBe(8)
  const full = await groupsOf(page)

  // The ninth is refused as a placement (`full`) ...
  const extra = await createTab(page, { kind: 'shell' })
  expect(extra).not.toBeNull()
  const refused = await place(page, extra!.id, ids[0]!, 'right')
  expect(refused).toEqual({ ok: false, reason: expect.stringMatching(/^(full|too-deep)$/) })
  // ... and the group is as it was; with D15 a refused `beside` on create makes the tab plain.
  const after = await groupsOf(page)
  expect(after.groups).toEqual(full.groups)
  const plainCreate = await createTab(page, { kind: 'shell', beside: { tabId: ids[0]!, edge: 'right' } })
  expect(plainCreate).not.toBeNull()
  expect((await groupsOf(page)).groups.every((g) => !leaves(g.root).includes(plainCreate!.id))).toBe(true)
  // A foreign or unknown tab id is refused with no event.
  const events = await recordGroupEvents(page)
  expect((await place(page, 'no-such-tab', ids[0]!, 'right')).ok).toBe(false)
  expect((await invoke<{ ok: boolean }>(page, 'groups.remove', { tabId: 'no-such-tab' })).ok).toBe(false)
  expect((await invoke<{ ok: boolean }>(page, 'groups.dissolve', { groupId: 'no-such-group' })).ok).toBe(false)
  await page.waitForTimeout(300)
  expect(await events()).toEqual([])
})

test('groups.changed seq only grows, and a stale view never undoes a newer one', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const seen = await recordGroupEvents(page)
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  await createTab(page, { kind: 'shell', beside: { tabId: b, edge: 'down' } })
  await invoke(page, 'groups.remove', { tabId: a })
  await expect.poll(async () => (await seen()).length).toBeGreaterThanOrEqual(3)
  const seqs = await seen()
  expect([...seqs].sort((x, y) => x - y)).toEqual(seqs)
  expect(new Set(seqs).size).toBe(seqs.length)
  const snap: GroupsSnapshot = await groupsOf(page)
  expect(snap.seq).toBeGreaterThanOrEqual(seqs.at(-1)!)
  // The group of the remaining two panes is what the page draws.
  expect(await groupFor(page, b)).toBeDefined()
  await expect(visiblePanes(page).first()).toBeVisible()
})

test('D9, D17: tabs.reorder with block moves the whole group; without it a member dropped outside detaches, inside is a no-op; snapshot.order is the tab order', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  const c = await newTaggedShell(cockpit, 'pc')
  const d = await newTaggedShell(cockpit, 'pd')
  const order = async (): Promise<string[]> => (await groupsOf(page)).order
  expect(await order()).toEqual([a, b, c.id, d.id])
  expect((await tabsOf(page)).map((t) => t.id)).toEqual(await order())

  // Block: the group of `a` goes to index 2 of the order without the block: after c and d.
  await invoke(page, 'tabs.reorder', { tabId: a, toIndex: 2, block: true })
  await expect.poll(order).toEqual([c.id, d.id, a, b])
  expect((await tabsOf(page)).map((t) => t.id)).toEqual([c.id, d.id, a, b])
  expect(leaves((await groupsOf(page)).groups[0]!.root)).toEqual([a, b])

  // Inside its own segment, a member move without block is a no-op (panes move by drag-to-edge).
  await invoke(page, 'tabs.reorder', { tabId: b, toIndex: 2 })
  await page.waitForTimeout(300)
  expect(await order()).toEqual([c.id, d.id, a, b])
  expect((await groupsOf(page)).groups).toHaveLength(1)

  // Without block, dropped outside the segment: detaches as a plain tab there; the group of one dissolves.
  await invoke(page, 'tabs.reorder', { tabId: b, toIndex: 0 })
  await expect.poll(async () => (await groupsOf(page)).groups).toEqual([])
  expect(await order()).toEqual([b, c.id, d.id, a])
  expect((await tabsOf(page)).map((t) => t.id)).toEqual([b, c.id, d.id, a])
})

test('D18: when groups.remove from another view dissolves the group, this view shows the remaining plain tab, unfocused', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    await typeInPane(page, paneShowing(page, 'pa-2'), 'echo mine-$((1+1))')
    await waitPaneText(paneShowing(page, 'pa-2'), 'mine-2')
    await expect(focusedPanes(page)).toHaveCount(1)
    expect((await invoke<{ ok: boolean }>(web, 'groups.remove', { tabId: a })).ok).toBe(true)
    await expect.poll(async () => (await groupsOf(page)).groups).toEqual([])
    // D22: the dissolve keeps the same terminal on screen (the desktop was on A, which is now a plain
    // tab), shown alone with the keys off: nothing typed lands in A or B.
    await expect(visiblePanes(page)).toHaveCount(1)
    await expect(paneOf(page, a)).toBeVisible()
    await expect(focusedPanes(page)).toHaveCount(0)
    await page.keyboard.type('echo leak-$((7+8))')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    expect(await paneText(paneOf(page, a))).not.toContain('leak-15')
    expect(await paneText(paneOf(page, b))).not.toContain('leak-15')
    // A click on the pane is what gives the keys back.
    await paneOf(page, a).locator('.xterm').click()
    await page.keyboard.type('echo back-$((2+2))')
    await page.keyboard.press('Enter')
    await waitPaneText(paneOf(page, a), 'back-4')
  } finally {
    await browser.close()
  }
})

test('D5: a browser view too narrow for its panes shows the group zoomed on the focused pane, automatically, per view', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    await web.getByRole('tab').first().click()
    await expect(visiblePanes(web)).toHaveCount(2)
    await expect(splitArea(web)).not.toHaveAttribute('data-zoom', 'auto')
    await paneOf(web, b).locator('.xterm').click()

    // A phone-sized viewport: panes would fall under about 40x10 cells.
    await web.setViewportSize({ width: 420, height: 700 })
    await expect(splitArea(web)).toHaveAttribute('data-zoom', 'auto')
    await expect(visiblePanes(web)).toHaveCount(1)
    await expect(paneOf(web, b)).toBeVisible() // the focused pane stays
    await expect(web.getByText(/zoomed \(1 hidden\)/)).toBeVisible()
    // The member hidden by zoom keeps its tab in the segment.
    await expect(web.getByRole('group').filter({ has: web.getByRole('tab') }).getByRole('tab')).toHaveCount(2)
    // Per view: the desktop still shows both panes and is not auto-zoomed.
    await expect(visiblePanes(page)).toHaveCount(2)
    await expect(splitArea(page)).not.toHaveAttribute('data-zoom', 'auto')
    expect((await groupsOf(page)).groups).toHaveLength(1)
    expect(leaves((await groupsOf(page)).groups[0]!.root)).toEqual([a, b])

    // Wide again: both panes come back by themselves.
    await web.setViewportSize({ width: 1280, height: 800 })
    await expect(visiblePanes(web)).toHaveCount(2)
    await expect(splitArea(web)).not.toHaveAttribute('data-zoom', 'auto')
  } finally {
    await browser.close()
  }
})

test('R12: exactly one pane is marked focused while several show, and the mark follows the click', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  await paneOf(page, a).locator('.xterm').click()
  await expect(focusedPanes(page)).toHaveCount(1)
  await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', a)
  await expect(paneOf(page, a)).toHaveAttribute('data-focused-pane', a)
  await paneOf(page, b).locator('.xterm').click()
  await expect(focusedPanes(page)).toHaveCount(1)
  await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', b)
  await expect(paneOf(page, a)).not.toHaveAttribute('data-focused-pane', /.+/)
})

test('R10, D10: the focus chord moves to the neighbour once, a held chord is swallowed, no key byte reaches a pty, no wrap', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  // `cat -v` shows any escape sequence that reaches the pty as ^[[C and friends.
  for (const id of [a, b]) await typeInPane(page, paneOf(page, id), 'cat -v')
  await page.waitForTimeout(300)
  await paneOf(page, a).locator('.xterm').click()
  await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', a)

  // ⌥⌘→ (Ctrl+Alt+→ on Linux), held: the first press moves, the auto-repeats do nothing more.
  const mods = process.platform === 'darwin' ? ['Meta', 'Alt'] : ['Control', 'Alt']
  for (const m of mods) await page.keyboard.down(m)
  for (let i = 0; i < 6; i++) await page.keyboard.down('ArrowRight')
  await page.keyboard.up('ArrowRight')
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
  await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', b)

  // No wrap: the rightmost pane stays focused on another press.
  for (const m of mods) await page.keyboard.down(m)
  await page.keyboard.press('ArrowRight')
  for (const m of [...mods].reverse()) await page.keyboard.up(m)
  await page.waitForTimeout(300)
  await expect(focusedPanes(page)).toHaveAttribute('data-focused-pane', b)

  // Keys typed now reach B only, and nothing of the chord reached either pty.
  await page.keyboard.type('hello-$((1+1))')
  await page.keyboard.press('Enter')
  await waitPaneText(paneOf(page, b), 'hello-$((1+1))')
  for (const id of [a, b]) expect(await paneText(paneOf(page, id))).not.toContain('^[')
  expect(await paneText(paneOf(page, a))).not.toContain('hello-')
})

test('a group name is plain text and never stands in for a member\'s status or label; bad names are refused', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  const [a, b] = await groupOfShells(cockpit, ['pa', 'pb'])
  const { browser, web } = await joinBrowser(cockpit)
  try {
    const group = (await groupsOf(page)).groups[0]!
    const before = await page.getByRole('tab').allInnerTexts()
    const name = 'needs you · question'
    expect((await invoke<{ ok: boolean }>(web, 'groups.rename', { groupId: group.id, name })).ok).toBe(true)
    for (const view of [page, web]) {
      const segment = view.getByRole('group').filter({ has: view.getByRole('tab') })
      await expect(segment).toHaveAttribute('aria-label', new RegExp(`Group ${name}, 2 tabs`))
      // Not a status: no member has a "needs you" dot, and the tab labels are unchanged.
      await expect(view.locator('.tab .status-dot[title*="needs permission"]')).toHaveCount(0)
    }
    expect(await page.getByRole('tab').allInnerTexts()).toEqual(before)
    // Names follow the tab name rule: control and bidi characters are refused, nothing changes.
    for (const bad of ['line\nbreak', 'rtl\u202eevil']) {
      const reply = await invoke<{ ok: boolean; reason?: string }>(web, 'groups.rename', { groupId: group.id, name: bad })
      expect(reply.ok, JSON.stringify(bad)).toBe(false)
    }
    expect((await groupsOf(page)).groups[0]!.name).toBe(name)
    expect(leaves((await groupsOf(page)).groups[0]!.root)).toEqual([a, b])
  } finally {
    await browser.close()
  }
})
