// Split groups across a quit and relaunch (design.md §1 "Lifecycle" › Restore; decisions D1, D6, D14).
// The app is closed and started again over the same data dir (fixtures' `root` option). Restored tabs
// get new ids, so a saved group names `TabRecord.id`s and restore remaps them; a leaf whose tab did
// not come back (a plugin command tab whose plugin is gone) is pruned and the group normalized.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStatus } from '../../src/main/plugins/host-manager'
import { expect, launchCockpit, test, type Cockpit } from './fixtures'
import { groupOfShells, groupsOf, invoke, leaves, newTaggedShell, paneShowing, tabsOf, visiblePanes, waitPaneText } from './split-fixtures'

interface SavedRecord {
  path: string
  tabs: Array<{ id?: string; kind: string }>
  tabGroups?: unknown
}

/** The project's record on disk (what the next start reads). */
function savedRecord(dataDir: string, projectDir: string): SavedRecord | undefined {
  const dir = join(dataDir, 'projects')
  if (!existsSync(dir)) return undefined
  for (const name of readdirSync(dir)) {
    if (!/^[0-9a-f]{16}\.json$/.test(name)) continue
    const record = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SavedRecord
    if (record.path === projectDir) return record
  }
  return undefined
}
const savedGroups = (c: Cockpit): unknown[] => {
  const g = savedRecord(c.dataDir, c.projectDir)?.tabGroups
  return Array.isArray(g) ? g : []
}

test('two groups come back after a quit and relaunch, with their sizes and the tab order', async () => {
  test.setTimeout(120_000)
  const first = await launchCockpit()
  const { root, dataDir, projectDir } = first.cockpit
  let sizes: number[]
  try {
    const c = first.cockpit
    const [a, b] = await groupOfShells(c, ['pa', 'pb'])
    // A second group with two other shells (the first group's tabs are not selected while these are made).
    const [x, y] = await groupOfShells(c, ['pc', 'pd'])
    expect(new Set([a, b, x, y]).size).toBe(4)
    const g1 = (await groupsOf(c.page)).groups.find((g) => leaves(g.root).includes(a))!
    const reply = await invoke<{ ok: boolean }>(c.page, 'groups.resize', { groupId: g1.id, splitId: g1.root.id, sizes: [0.3, 0.7] })
    expect(reply.ok).toBe(true)
    sizes = [0.3, 0.7]
    // Saved on every change, in the same record as the tabs.
    await expect.poll(() => savedGroups(c).length).toBe(2)
  } finally {
    await first.close({ keepFiles: true })
  }
  // Quitting killed every tab; that must not have dissolved the groups on disk (the `frozen` guard).
  expect(savedGroups({ dataDir, projectDir } as Cockpit)).toHaveLength(2)

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    await expect(c.page.getByRole('tab')).toHaveCount(4)
    const snap = await groupsOf(c.page)
    expect(snap.groups).toHaveLength(2)
    const live = (await tabsOf(c.page)).map((t) => t.id)
    expect(snap.order).toEqual(live)
    // Each group's members are contiguous in the tab order, in reading order, all of them live tabs.
    const sets = snap.groups.map((g) => leaves(g.root))
    expect(sets.map((s) => s.length)).toEqual([2, 2])
    expect(sets.flat()).toEqual(live)
    for (const s of sets) expect(s.every((id) => live.includes(id))).toBe(true)
    // The divider the person moved is where it was left.
    const moved = snap.groups.find((g) => Math.abs(g.root.sizes[0]! - sizes[0]!) < 1e-3)
    expect(moved).toBeDefined()
    expect(moved!.root.sizes[1]!).toBeCloseTo(sizes[1]!, 3)
    // Two bracketed segments in the strip; selecting the first draws its two panes.
    await expect(c.page.getByRole('group').filter({ has: c.page.getByRole('tab') })).toHaveCount(2)
    await c.page.getByRole('tab').first().click()
    await expect(visiblePanes(c.page)).toHaveCount(2)
  } finally {
    await second.close()
  }
})

test('a command tab dropped by restore (its plugin is gone) is pruned from the group; the rest stays grouped', async () => {
  test.setTimeout(120_000)
  const first = await launchCockpit()
  const { root } = first.cockpit
  // A copy of the fixture plugin that the test deletes before the relaunch: "revoked / gone".
  const copy = join(root, 'plugin-copy')
  cpSync(join(__dirname, '..', 'fixtures', 'plugins', 'split-beside'), copy, { recursive: true })
  try {
    const c = first.cockpit
    await c.hook('linkPlugin', copy)
    await c.hook('enablePlugin', c.projectDir, 'test.splitbeside')
    await expect
      .poll(async () => (await c.hook<HostStatus>('hostStatus', c.projectDir)).plugins.map((p) => `${p.id}:${p.state}`), { timeout: 15_000 })
      .toEqual(['test.splitbeside:active'])
    const a = await newTaggedShell(c, 'pa')
    writeFileSync(join(c.root, 'home', 'anchor.txt'), a.id)
    await c.hook('runPluginCommand', c.projectDir, 'test.splitbeside/open-command') // beside a: a, plug
    await expect.poll(async () => (await tabsOf(c.page)).length).toBe(2)
    const plug = (await tabsOf(c.page)).find((t) => t.kind === 'command')!
    // A third pane, a shell, to the right of the command tab.
    const b = await newTaggedShell(c, 'pb')
    await invoke(c.page, 'groups.place', { tabId: b.id, at: plug.id, edge: 'right' })
    await expect.poll(async () => leaves((await groupsOf(c.page)).groups[0]!.root).length).toBe(3)
    await expect.poll(() => savedGroups(c).length).toBe(1)
  } finally {
    await first.close({ keepFiles: true })
  }
  rmSync(copy, { recursive: true, force: true })

  const second = await launchCockpit({ root, folderArg: false })
  try {
    const c = second.cockpit
    await expect.poll(async () => (await tabsOf(c.page)).length).toBe(2)
    expect((await tabsOf(c.page)).every((t) => t.kind === 'shell')).toBe(true)
    // Still one group of the two shells (a group of two stays a group), sizes valid.
    const snap = await groupsOf(c.page)
    expect(snap.groups).toHaveLength(1)
    const g = snap.groups[0]!
    expect(leaves(g.root)).toEqual((await tabsOf(c.page)).map((t) => t.id))
    expect(g.root.sizes.reduce((s, n) => s + n, 0)).toBeCloseTo(1, 5)
    expect(g.root.sizes.every((n) => n >= 0.1 - 1e-6 && n <= 0.9 + 1e-6)).toBe(true)
    await expect(visiblePanes(c.page)).toHaveCount(2)
    await waitPaneText(paneShowing(c.page, 'FAKE-SHELL ready'), 'FAKE-SHELL ready')
  } finally {
    await second.close()
  }
})

test('closing the project window clears its groups with its tabs', async () => {
  test.setTimeout(120_000)
  const first = await launchCockpit()
  const { root } = first.cockpit
  try {
    const c = first.cockpit
    await groupOfShells(c, ['pa', 'pb'])
    await expect.poll(() => savedGroups(c).length).toBe(1)
    await c.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close()
    })
    await expect.poll(() => savedGroups(c).length).toBe(0)
    expect(savedRecord(c.dataDir, c.projectDir)?.tabs ?? []).toHaveLength(0)
  } finally {
    await first.close({ keepFiles: true })
  }
  const second = await launchCockpit({ root, folderArg: false, ready: 'picker' })
  await second.close()
})
