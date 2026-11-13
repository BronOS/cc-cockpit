// Plugin `beside` (design.md §1 "Plugin API", decisions D4, D6, D7, D8; task 04). The fixture plugin
// test/fixtures/plugins/split-beside opens tabs beside an anchor whose id the test writes to
// $HOME/anchor.txt, with `focus: true`, and logs what each call returned.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, test, type Cockpit } from './fixtures'
import { focusedPanes, groupsOf, leaves, newTaggedShell, paneShowing, paneText, tabsOf, typeInPane, visiblePanes, waitPaneText } from './split-fixtures'

const PLUGIN = 'test.splitbeside'
const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'split-beside')

interface Logged {
  command: string
  result?: { tabId: string; placed?: boolean }
  error?: string
}

async function enable(c: Cockpit): Promise<void> {
  await c.hook('linkPlugin', FIXTURE)
  await c.hook('enablePlugin', c.projectDir, PLUGIN)
  await expect
    .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.map((p) => `${p.id}:${p.state}`), { timeout: 15_000 })
    .toEqual([`${PLUGIN}:active`])
}

const logPath = (c: Cockpit): string => join(c.root, 'home', 'beside.log')
function logged(c: Cockpit): Logged[] {
  if (!existsSync(logPath(c))) return []
  return readFileSync(logPath(c), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged)
}

/** Runs a fixture command and waits for its log line (the n-th). */
async function run(c: Cockpit, command: string): Promise<Logged> {
  const n = logged(c).length
  await c.hook('runPluginCommand', c.projectDir, `${PLUGIN}/${command}`)
  await expect.poll(() => logged(c).length, { timeout: 15_000 }).toBe(n + 1)
  return logged(c)[n]!
}

test('a plugin `beside` opens a pane next to the anchor, marked "Opened by", and takes no focus (D4, D7, D8)', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await enable(cockpit)
  const anchor = await newTaggedShell(cockpit, 'pa')
  writeFileSync(join(cockpit.root, 'home', 'anchor.txt'), anchor.id)
  // The person is in the anchor (it is selected and its terminal focused).
  await cockpit.typeLine('echo before-$((1+1))')
  await cockpit.waitForTerminalText('before-2')

  const out = await run(cockpit, 'open-command')
  expect(out.error).toBeUndefined()
  expect(out.result).toEqual({ tabId: expect.any(String), placed: true })

  // A plain anchor became a group of two, anchor first (right of it), in main's model and on screen.
  const snap = await groupsOf(page)
  expect(snap.groups).toHaveLength(1)
  expect(leaves(snap.groups[0]!.root)).toEqual([anchor.id, out.result!.tabId])
  expect((await tabsOf(page)).map((t) => t.id)).toEqual([anchor.id, out.result!.tabId])
  await expect(visiblePanes(page)).toHaveCount(2)
  await waitPaneText(paneShowing(page, 'plug-7'), 'plug-7')
  // Its header says who opened it (more than one pane is visible, so headers show).
  await expect(page.getByText(/Opened by Split beside/)).toBeVisible()

  // `focus: true` did not move the person's keys: the anchor is still the focused pane, and what is
  // typed now (no click) lands in it, never in the plugin's pane.
  await expect(focusedPanes(page)).toHaveCount(1)
  await page.keyboard.type('echo after-$((2+2))')
  await page.keyboard.press('Enter')
  await waitPaneText(paneShowing(page, 'pa-2'), 'after-4')
  expect(await paneText(paneShowing(page, 'plug-7'))).not.toContain('after-4')
})

test('a plugin\'s `beside` places only below 4 panes, then opens a plain tab with placed: false (D6)', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await enable(cockpit)
  const anchor = await newTaggedShell(cockpit, 'pa')
  writeFileSync(join(cockpit.root, 'home', 'anchor.txt'), anchor.id)

  const placed: Array<boolean | undefined> = []
  for (let i = 0; i < 4; i++) placed.push((await run(cockpit, 'open-command')).result?.placed)
  // Anchor + 3 = 4 panes; the fourth call finds the group at 4 and opens a plain tab.
  expect(placed).toEqual([true, true, true, false])
  const snap = await groupsOf(page)
  expect(snap.groups).toHaveLength(1)
  expect(leaves(snap.groups[0]!.root)).toHaveLength(4)
  const all = await tabsOf(page)
  expect(all).toHaveLength(5)
  // The plain one is the last, outside every group, and the plugin never made the person's
  // selection leave the anchor's group arrangement (the anchor is still a member, first).
  expect(leaves(snap.groups[0]!.root)).not.toContain(all.at(-1)!.id)
  expect(leaves(snap.groups[0]!.root)[0]).toBe(anchor.id)
})

test('`beside` with side "down" splits below the anchor (D7)', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await enable(cockpit)
  const anchor = await newTaggedShell(cockpit, 'pa')
  writeFileSync(join(cockpit.root, 'home', 'anchor.txt'), anchor.id)
  const out = await run(cockpit, 'open-shell-down')
  expect(out.result).toEqual({ tabId: expect.any(String), placed: true })
  const group = (await groupsOf(page)).groups[0]!
  // Two panes stacked: the root split is a column, anchor above the new tab.
  expect(group.root.dir).toBe('column')
  expect(leaves(group.root)).toEqual([anchor.id, out.result!.tabId])
})

test('an unknown anchor is refused with an error and opens nothing', async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await enable(cockpit)
  await newTaggedShell(cockpit, 'pa')
  const before = (await tabsOf(page)).length
  const out = await run(cockpit, 'open-unknown')
  expect(out.result).toBeUndefined()
  expect(out.error).toMatch(/.+/)
  expect(await tabsOf(page)).toHaveLength(before)
  expect((await groupsOf(page)).groups).toEqual([])
  // The refusal did not spend the open budget (design: checked before it): five opens still work.
  writeFileSync(join(cockpit.root, 'home', 'anchor.txt'), (await tabsOf(page))[0]!.id)
  for (let i = 0; i < 5; i++) expect((await run(cockpit, 'open-shell-down')).error, `open ${i + 1}`).toBeUndefined()
})

test("keys typed while a plugin opens a pane beside a tab the person is not on never reach the plugin's pane (D4)", async ({ cockpit }) => {
  test.setTimeout(120_000)
  const { page } = cockpit
  await enable(cockpit)
  const anchor = await newTaggedShell(cockpit, 'pa')
  writeFileSync(join(cockpit.root, 'home', 'anchor.txt'), anchor.id)
  // The person is on another, plain tab when the plugin opens beside the anchor.
  await newTaggedShell(cockpit, 'pz')
  const out = await run(cockpit, 'open-command')
  expect(out.result?.placed).toBe(true)
  // `focus: true` may select the group in the origin view (the plugin asked), but the plugin's new
  // pane never takes focus (D4): keys typed now (no click) never reach it.
  await page.keyboard.type('echo stray-$((9+9))')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  expect(await paneText(paneShowing(page, 'plug-7'))).not.toContain('stray-18')
  await typeInPane(page, paneShowing(page, 'pa-2'), 'echo click-$((1+2))')
  await waitPaneText(paneShowing(page, 'pa-2'), 'click-3')
})
