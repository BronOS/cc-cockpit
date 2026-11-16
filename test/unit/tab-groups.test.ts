import { describe, expect, it } from 'vitest'
import {
  AUTO_ZOOM_CELLS,
  GROUP_CAPS,
  besideSpan,
  contiguousOrder,
  depthOf,
  dissolve,
  fitShares,
  fitsMinimum,
  groupOf,
  isLeaf,
  leavesOf,
  neighbour,
  normalizeGroups,
  place,
  rectsOf,
  removeLeaf,
  rename,
  restoreGroups,
  setSizes,
  type GroupsResult,
  type MintId,
  type PaneNode,
  type PaneSplit,
  type TabGroup
} from '../../src/shared/tab-groups'

const minter = (): MintId => {
  let n = 0
  return () => `id${++n}`
}
const leaf = (tab: string): PaneNode => ({ tab })
const split = (id: string, dir: 'row' | 'column', children: PaneNode[], sizes?: number[]): PaneSplit => ({
  id,
  dir,
  children,
  sizes: sizes ?? children.map(() => 1 / children.length)
})
const group = (id: string, root: PaneSplit, name?: string): TabGroup => (name ? { id, name, root } : { id, root })

function ok(r: GroupsResult): { groups: TabGroup[]; order: string[] } {
  if (!r.ok) throw new Error(`refused: ${r.reason}`)
  return r
}

/** Every invariant of design §1 / D6, checked on any groups the module returns. */
function expectValid(groups: TabGroup[], live: Iterable<string>): void {
  const liveSet = new Set(live)
  const seenTabs = new Set<string>()
  const seenIds = new Set<string>()
  expect(groups.length).toBeLessThanOrEqual(GROUP_CAPS.maxGroups)
  for (const g of groups) {
    expect(seenIds.has(g.id)).toBe(false)
    seenIds.add(g.id)
    expect(isLeaf(g.root)).toBe(false)
    const leaves = leavesOf(g.root)
    expect(leaves.length).toBeGreaterThanOrEqual(2)
    expect(leaves.length).toBeLessThanOrEqual(GROUP_CAPS.maxPanes)
    expect(depthOf(g.root)).toBeLessThanOrEqual(GROUP_CAPS.maxDepth)
    for (const t of leaves) {
      expect(liveSet.has(t)).toBe(true)
      expect(seenTabs.has(t)).toBe(false)
      seenTabs.add(t)
    }
    const walk = (n: PaneNode, parentDir?: string): void => {
      if (isLeaf(n)) return
      expect(seenIds.has(n.id) && n !== g.root ? n.id : 'fresh').toBe('fresh')
      seenIds.add(n.id)
      expect(['row', 'column']).toContain(n.dir)
      expect(n.dir).not.toBe(parentDir)
      expect(n.children.length).toBeGreaterThanOrEqual(2)
      expect(n.sizes.length).toBe(n.children.length)
      for (const s of n.sizes) {
        expect(Number.isFinite(s)).toBe(true)
        expect(s).toBeGreaterThanOrEqual(GROUP_CAPS.minShare - 1e-9)
      }
      expect(n.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
      for (const c of n.children) walk(c, n.dir)
    }
    walk(g.root)
  }
}

/** The order invariant: every group's members are one block in leaf reading order. */
function expectContiguous(order: string[], groups: TabGroup[]): void {
  for (const g of groups) {
    const leaves = leavesOf(g.root).filter((t) => order.includes(t))
    const at = order.indexOf(leaves[0]!)
    expect(order.slice(at, at + leaves.length)).toEqual(leaves)
  }
}

describe('place', () => {
  it('makes a new group from a plain anchor, the tab beside it in the order', () => {
    const r = ok(place([], ['a', 'b', 'c'], { tabId: 'c', at: 'a', edge: 'right' }, { mint: minter() }))
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.root).toEqual({ id: 'id2', dir: 'row', children: [leaf('a'), leaf('c')], sizes: [0.5, 0.5] })
    expect(r.groups[0]!.id).toBe('id1')
    expect(r.order).toEqual(['a', 'c', 'b'])
  })

  it('left and up put the tab before the anchor', () => {
    const left = ok(place([], ['a', 'b'], { tabId: 'b', at: 'a', edge: 'left' }, { mint: minter() }))
    expect(leavesOf(left.groups[0]!.root)).toEqual(['b', 'a'])
    expect(left.order).toEqual(['b', 'a'])
    const up = ok(place([], ['a', 'b'], { tabId: 'b', at: 'a', edge: 'up' }, { mint: minter() }))
    expect(up.groups[0]!.root.dir).toBe('column')
    expect(leavesOf(up.groups[0]!.root)).toEqual(['b', 'a'])
  })

  it('joins a group as a sibling in the same direction, halving the anchor', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]))
    const r = ok(place([g], ['a', 'b', 'c'], { tabId: 'c', at: 'a', edge: 'right' }, { mint: minter() }))
    expect(r.groups[0]!.root).toEqual({ id: 's', dir: 'row', children: [leaf('a'), leaf('c'), leaf('b')], sizes: [0.25, 0.25, 0.5] })
    expect(r.groups[0]!.id).toBe('g')
    expect(r.order).toEqual(['a', 'c', 'b'])
  })

  it('nests a cross-direction split in place of the anchor', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]))
    const r = ok(place([g], ['a', 'b', 'c'], { tabId: 'c', at: 'b', edge: 'down' }, { mint: minter() }))
    expect(r.groups[0]!.root).toEqual({
      id: 's',
      dir: 'row',
      children: [leaf('a'), { id: 'id1', dir: 'column', children: [leaf('b'), leaf('c')], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5]
    })
    expect(r.order).toEqual(['a', 'b', 'c'])
  })

  it('clamps a halved share to the minimum', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')], [0.15, 0.85]))
    const r = ok(place([g], ['a', 'b', 'c'], { tabId: 'c', at: 'a', edge: 'right' }, { mint: minter() }))
    const sizes = r.groups[0]!.root.sizes
    expect(sizes[0]).toBeCloseTo(0.1)
    expect(sizes[1]).toBeCloseTo(0.1)
    expect(sizes[2]).toBeCloseTo(0.8)
  })

  it('moves a tab between groups; the source shrinks', () => {
    const g1 = group('g1', split('s1', 'row', [leaf('a'), leaf('b'), leaf('c')]))
    const g2 = group('g2', split('s2', 'row', [leaf('d'), leaf('e')]))
    const r = ok(place([g1, g2], ['a', 'b', 'c', 'd', 'e'], { tabId: 'b', at: 'e', edge: 'right' }, { mint: minter() }))
    expect(leavesOf(r.groups[0]!.root)).toEqual(['a', 'c'])
    expect(r.groups[0]!.root.sizes).toEqual([0.5, 0.5])
    expect(leavesOf(r.groups[1]!.root)).toEqual(['d', 'e', 'b'])
    expect(r.order).toEqual(['a', 'c', 'd', 'e', 'b'])
    expectValid(r.groups, r.order)
  })

  it('moving the second-last member out dissolves the source group', () => {
    const g1 = group('g1', split('s1', 'row', [leaf('a'), leaf('b')]))
    const r = ok(place([g1], ['a', 'b', 'c'], { tabId: 'b', at: 'c', edge: 'down' }, { mint: minter() }))
    expect(r.groups).toHaveLength(1)
    expect(leavesOf(r.groups[0]!.root)).toEqual(['c', 'b'])
    expect(groupOf(r.groups, 'a')).toBeUndefined()
    expect(r.order).toEqual(['a', 'c', 'b'])
  })

  it('moves a tab inside its own group, keeping the group (even with two panes)', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]), 'pair')
    const r = ok(place([g], ['a', 'b'], { tabId: 'a', at: 'b', edge: 'down' }, { mint: minter() }))
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0]!.id).toBe('g')
    expect(r.groups[0]!.name).toBe('pair')
    expect(r.groups[0]!.root.dir).toBe('column')
    expect(leavesOf(r.groups[0]!.root)).toEqual(['b', 'a'])
    expect(r.order).toEqual(['b', 'a'])
  })

  it('collapses a nested split left with one child after an inside move', () => {
    const g = group('g', split('s', 'row', [leaf('a'), split('t', 'column', [leaf('b'), leaf('c')])]))
    const r = ok(place([g], ['a', 'b', 'c'], { tabId: 'c', at: 'a', edge: 'left' }, { mint: minter() }))
    expect(r.groups[0]!.root).toEqual({ id: 's', dir: 'row', children: [leaf('c'), leaf('a'), leaf('b')], sizes: [0.25, 0.25, 0.5] })
    expect(r.order).toEqual(['c', 'a', 'b'])
  })

  it('refuses unknown tabs, itself, a bad edge, a non-object', () => {
    const m = { mint: minter() }
    expect(place([], ['a', 'b'], { tabId: 'x', at: 'a', edge: 'right' }, m)).toEqual({ ok: false, reason: 'unknown-tab' })
    expect(place([], ['a', 'b'], { tabId: 'a', at: 'x', edge: 'right' }, m)).toEqual({ ok: false, reason: 'unknown-tab' })
    expect(place([], ['a', 'b'], { tabId: 'a', at: 'a', edge: 'right' }, m)).toEqual({ ok: false, reason: 'same-tab' })
    expect(place([], ['a', 'b'], { tabId: 'a', at: 'b', edge: 'diagonal' as never }, m)).toEqual({ ok: false, reason: 'bad-edge' })
    expect(place([], ['a', 'b'], null as never, m)).toEqual({ ok: false, reason: 'unknown-tab' })
    expect(place([], ['a', 'b'], { tabId: 1, at: 'b', edge: 'right' } as never, m)).toEqual({ ok: false, reason: 'unknown-tab' })
  })

  it('refuses a ninth pane, and a plugin from the fourth', () => {
    const tabs = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 'x']
    const eight = group('g', split('s', 'row', tabs.slice(0, 8).map(leaf)))
    expect(place([eight], tabs, { tabId: 'x', at: 't1', edge: 'down' }, { mint: minter() })).toEqual({ ok: false, reason: 'full' })
    // Moving inside a full group is not adding a pane.
    expect(place([eight], tabs, { tabId: 't8', at: 't1', edge: 'down' }, { mint: minter() }).ok).toBe(true)

    const three = group('g', split('s', 'row', tabs.slice(0, 3).map(leaf)))
    expect(place([three], tabs, { tabId: 'x', at: 't1', edge: 'right' }, { mint: minter(), plugin: true }).ok).toBe(true)
    const four = group('g', split('s', 'row', tabs.slice(0, 4).map(leaf)))
    expect(place([four], tabs, { tabId: 'x', at: 't1', edge: 'right' }, { mint: minter(), plugin: true })).toEqual({ ok: false, reason: 'full' })
    expect(place([four], tabs, { tabId: 'x', at: 't1', edge: 'right' }, { mint: minter() }).ok).toBe(true)
  })

  it('refuses a fifth nested level', () => {
    // row > column > row > column: depth 4; one more cross split at the deepest leaf is 5.
    const deep = group(
      'g',
      split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), split('s3', 'row', [leaf('c'), split('s4', 'column', [leaf('d'), leaf('e')])])])])
    )
    expect(depthOf(deep.root)).toBe(4)
    const order = ['a', 'b', 'c', 'd', 'e', 'x']
    expect(place([deep], order, { tabId: 'x', at: 'e', edge: 'right' }, { mint: minter() })).toEqual({ ok: false, reason: 'too-deep' })
    // Same direction as the deepest split: a sibling, no new level.
    expect(place([deep], order, { tabId: 'x', at: 'e', edge: 'down' }, { mint: minter() }).ok).toBe(true)
  })

  it('refuses a 33rd group', () => {
    const groups: TabGroup[] = []
    const order: string[] = []
    for (let i = 0; i < 32; i++) {
      groups.push(group(`g${i}`, split(`s${i}`, 'row', [leaf(`a${i}`), leaf(`b${i}`)])))
      order.push(`a${i}`, `b${i}`)
    }
    order.push('x', 'y')
    expect(place(groups, order, { tabId: 'x', at: 'y', edge: 'right' }, { mint: minter() })).toEqual({ ok: false, reason: 'too-many-groups' })
    // Joining an existing group is fine; so is a move that dissolves one group while making another.
    expect(place(groups, order, { tabId: 'x', at: 'a0', edge: 'right' }, { mint: minter() }).ok).toBe(true)
    expect(place(groups, order, { tabId: 'a0', at: 'y', edge: 'right' }, { mint: minter() }).ok).toBe(true)
  })

  it('never returns the input objects mutated', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]))
    const before = JSON.stringify(g)
    const order = ['a', 'b', 'c']
    place([g], order, { tabId: 'c', at: 'a', edge: 'down' }, { mint: minter() })
    place([g], order, { tabId: 'a', at: 'b', edge: 'down' }, { mint: minter() })
    expect(JSON.stringify(g)).toBe(before)
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

// A plugin's `beside` places evenly (the Team plugin stacks room members down a column to the right of the
// coordinator): beside an anchor whose parent split already runs the side's way the new pane joins it and every child
// gets an equal share; a cross split still nests (halves), and the person's own split still halves only the anchor.
describe('place: a plugin stacks evenly', () => {
  const caps = { ...GROUP_CAPS, pluginBelow: GROUP_CAPS.maxPanes }
  const shares = (r: GroupsResult, splitOf: string): number[] => {
    if (!r.ok) throw new Error(r.reason)
    const g = groupOf(r.groups, splitOf)!
    const find = (n: PaneNode): PaneSplit | undefined =>
      isLeaf(n) ? undefined : n.children.some((c) => isLeaf(c) && c.tab === splitOf) ? n : n.children.map(find).find(Boolean)
    return find(g.root)!.sizes
  }

  it('a column of 1..7 members beside a coordinator: every member gets the same height', () => {
    const order = ['co', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']
    const mint = minter()
    // The Team plugin's way: the first member right of the coordinator, each next one down beside the previous.
    let r = place([], order, { tabId: 'm1', at: 'co', edge: 'right' }, { mint, caps, plugin: true })
    expect(r.ok && rectsOf(r.groups[0]!.root).panes.map((p) => p.w)).toEqual([0.5, 0.5])
    for (let k = 2; k <= 7; k++) {
      if (!r.ok) throw new Error(r.reason)
      r = place(r.groups, r.order, { tabId: `m${k}`, at: `m${k - 1}`, edge: 'down' }, { mint, caps, plugin: true })
      if (!r.ok) throw new Error(r.reason)
      const { panes } = rectsOf(r.groups[0]!.root)
      const column = panes.filter((p) => p.tab !== 'co')
      expect(column.map((p) => p.tab)).toEqual(order.slice(1, k + 1))
      // Equal within the 1e-6 share grid; the coordinator keeps its half and the column stays one split (depth 2).
      for (const p of column) expect(p.h).toBeCloseTo(1 / k, 5)
      expect(panes.find((p) => p.tab === 'co')!.w).toBe(0.5)
      expect(depthOf(r.groups[0]!.root)).toBe(2)
    }
    expect(r.ok && leavesOf(r.groups[0]!.root)).toHaveLength(GROUP_CAPS.maxPanes)
  })

  it('a row: a pane right of an anchor in a row evens the row, whatever its sizes were', () => {
    const order = ['a', 'b', 'x', 'y']
    const row = group('g', split('s', 'row', [leaf('a'), leaf('b')], [0.7, 0.3]))
    const r = place([row], order, { tabId: 'x', at: 'b', edge: 'right' }, { mint: minter(), plugin: true })
    expect(r.ok && leavesOf(r.groups[0]!.root)).toEqual(['a', 'b', 'x'])
    for (const v of shares(r, 'x')) expect(v).toBeCloseTo(1 / 3, 5)
    // Placed after the anchor, not at the end: beside the first pane it goes second.
    const r2 = place([row], order, { tabId: 'y', at: 'a', edge: 'right' }, { mint: minter(), plugin: true })
    expect(r2.ok && leavesOf(r2.groups[0]!.root)).toEqual(['a', 'y', 'b'])
  })

  it('mixed directions still nest: down beside a pane of a row halves that pane in a new column', () => {
    const order = ['a', 'b', 'x']
    const row = group('g', split('s', 'row', [leaf('a'), leaf('b')], [0.7, 0.3]))
    const r = place([row], order, { tabId: 'x', at: 'b', edge: 'down' }, { mint: minter(), plugin: true })
    if (!r.ok) throw new Error(r.reason)
    const root = r.groups[0]!.root as PaneSplit
    expect(root.sizes).toEqual([0.7, 0.3])
    expect(root.children[1]).toMatchObject({ dir: 'column', children: [{ tab: 'b' }, { tab: 'x' }], sizes: [0.5, 0.5] })
    // A plain anchor is a pair of halves, as before.
    const plain = place([], ['a', 'x'], { tabId: 'x', at: 'a', edge: 'down' }, { mint: minter(), plugin: true })
    expect(plain.ok && (plain.groups[0]!.root as PaneSplit).sizes).toEqual([0.5, 0.5])
  })

  it('the person’s own split is unchanged: only the anchor is halved, the others keep their sizes', () => {
    const order = ['a', 'b', 'x']
    const row = group('g', split('s', 'row', [leaf('a'), leaf('b')], [0.7, 0.3]))
    const r = place([row], order, { tabId: 'x', at: 'b', edge: 'right' }, { mint: minter() })
    expect(shares(r, 'x')).toEqual([0.7, 0.15, 0.15])
  })

  it('still respects the plugin cap and the depth cap', () => {
    const tabs = ['t1', 't2', 't3', 't4', 'x']
    const three = group('g', split('s', 'column', tabs.slice(0, 3).map(leaf)))
    expect(place([three], tabs, { tabId: 'x', at: 't3', edge: 'down' }, { mint: minter(), plugin: true, caps: { ...GROUP_CAPS, pluginBelow: 3 } })).toEqual({
      ok: false,
      reason: 'full'
    })
    const deep = group(
      'g',
      split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), split('s3', 'row', [leaf('c'), split('s4', 'column', [leaf('d'), leaf('e')])])])])
    )
    const order = ['a', 'b', 'c', 'd', 'e', 'x']
    const opts = { mint: minter(), plugin: true, caps }
    expect(place([deep], order, { tabId: 'x', at: 'e', edge: 'right' }, opts)).toEqual({ ok: false, reason: 'too-deep' })
    // Into the deepest column: a sibling, no new level, and the column's three panes even.
    const r = place([deep], order, { tabId: 'x', at: 'e', edge: 'down' }, opts)
    for (const v of shares(r, 'x')) expect(v).toBeCloseTo(1 / 3, 5)
  })

  it('besideSpan: the anchor’s share and the pane count of an even placement, else halves', () => {
    const col = group('g', split('s', 'row', [leaf('co'), split('c', 'column', [leaf('m1'), leaf('m2'), leaf('m3')])]))
    expect(besideSpan([col], 'm2', 'down', true)).toEqual({ share: 1 / 3, panes: 4 })
    expect(besideSpan([col], 'm2', 'right', true)).toEqual({ share: 1, panes: 2 })
    expect(besideSpan([col], 'co', 'right', true)).toEqual({ share: 0.5, panes: 3 })
    expect(besideSpan([col], 'm2', 'down', false)).toEqual({ share: 1, panes: 2 })
    expect(besideSpan([col], 'plain', 'down', true)).toEqual({ share: 1, panes: 2 })
    expect(besideSpan([col], 'm2', 'diagonal' as never, true)).toEqual({ share: 1, panes: 2 })
  })
})

describe('removeLeaf', () => {
  it('moves a tab out: plain, right after the block; siblings take its space', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b'), leaf('c')], [0.2, 0.3, 0.5]))
    const r = ok(removeLeaf([g], ['a', 'b', 'c', 'd'], 'a'))
    expect(r.groups[0]!.root).toEqual({ id: 's', dir: 'row', children: [leaf('b'), leaf('c')], sizes: [0.375, 0.625] })
    expect(r.order).toEqual(['b', 'c', 'a', 'd'])
  })

  it('dissolves a group down to one pane; the other tab stays in place', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]))
    const r = ok(removeLeaf([g], ['x', 'a', 'b', 'y'], 'a'))
    expect(r.groups).toEqual([])
    expect(r.order).toEqual(['x', 'b', 'a', 'y'])
  })

  it('a closed tab (not in the order) is only pruned', () => {
    const g = group('g', split('s', 'row', [leaf('a'), split('t', 'column', [leaf('b'), leaf('c')])]))
    const r = ok(removeLeaf([g], ['a', 'c', 'd'], 'b'))
    // The column lost a child and was lifted; the row keeps its id.
    expect(r.groups[0]!.root).toEqual({ id: 's', dir: 'row', children: [leaf('a'), leaf('c')], sizes: [0.5, 0.5] })
    expect(r.order).toEqual(['a', 'c', 'd'])
  })

  it('flattens a lifted child of the parent direction', () => {
    // row[ a, column[ row[b, c], d ] ]: removing d lifts row[b,c] into the root row.
    const g = group('g', split('s', 'row', [leaf('a'), split('t', 'column', [split('u', 'row', [leaf('b'), leaf('c')]), leaf('d')])]))
    const r = ok(removeLeaf([g], ['a', 'b', 'c', 'd'], 'd'))
    expect(r.groups[0]!.root).toEqual({ id: 's', dir: 'row', children: [leaf('a'), leaf('b'), leaf('c')], sizes: [0.5, 0.25, 0.25] })
    expectValid(r.groups, r.order)
  })

  it('refuses a plain tab', () => {
    expect(removeLeaf([], ['a'], 'a')).toEqual({ ok: false, reason: 'not-grouped' })
    expect(removeLeaf([], ['a'], 5 as never)).toEqual({ ok: false, reason: 'not-grouped' })
  })
})

describe('dissolve', () => {
  it('ungroups in place', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]))
    const r = ok(dissolve([g], ['x', 'a', 'b'], 'g'))
    expect(r.groups).toEqual([])
    expect(r.order).toEqual(['x', 'a', 'b'])
    expect(dissolve([g], ['a', 'b'], 'nope')).toEqual({ ok: false, reason: 'unknown-group' })
  })
})

describe('setSizes', () => {
  const g = group('g', split('s', 'row', [leaf('a'), split('t', 'column', [leaf('b'), leaf('c')])]))

  it('sets, scales and clamps one split', () => {
    const r = setSizes([g], 'g', 't', [3, 1])
    if (!r.ok) throw new Error(r.reason)
    expect((r.groups[0]!.root.children[1] as PaneSplit).sizes).toEqual([0.75, 0.25])
    expect(r.groups[0]!.root.sizes).toEqual([0.5, 0.5])
    const tiny = setSizes([g], 'g', 's', [0.01, 0.99])
    if (!tiny.ok) throw new Error(tiny.reason)
    expect(tiny.groups[0]!.root.sizes[0]).toBeCloseTo(0.1)
    expect(tiny.groups[0]!.root.sizes[1]).toBeCloseTo(0.9)
    expect(g.root.sizes).toEqual([0.5, 0.5])
  })

  it('refuses bad input', () => {
    expect(setSizes([g], 'x', 's', [1, 1])).toEqual({ ok: false, reason: 'unknown-group' })
    expect(setSizes([g], 'g', 'x', [1, 1])).toEqual({ ok: false, reason: 'unknown-split' })
    for (const bad of [[1], [1, 1, 1], [1, NaN], [1, Infinity], [1, 0], [1, -1], [1, '1'], 'no', null]) {
      expect(setSizes([g], 'g', 's', bad as never)).toEqual({ ok: false, reason: 'bad-sizes' })
    }
  })
})

describe('rename', () => {
  const g = group('g', split('s', 'row', [leaf('a'), leaf('b')]))
  it('names, clears, refuses', () => {
    const named = rename([g], 'g', '  dev  ')
    expect(named.ok && named.groups[0]!.name).toBe('dev')
    const cleared = rename(named.ok ? named.groups : [], 'g', null)
    expect(cleared.ok && 'name' in cleared.groups[0]!).toBe(false)
    expect(rename([g], 'g', '')).toEqual({ ok: false, reason: 'bad-name' })
    expect(rename([g], 'g', 'a‮b')).toEqual({ ok: false, reason: 'bad-name' })
    expect(rename([g], 'g', 'x'.repeat(61))).toEqual({ ok: false, reason: 'bad-name' })
    expect(rename([g], 'x', 'dev')).toEqual({ ok: false, reason: 'unknown-group' })
  })
})

describe('contiguousOrder', () => {
  it('pulls members into one block at the first member, in reading order', () => {
    const g = group('g', split('s', 'row', [leaf('c'), leaf('a')]))
    expect(contiguousOrder(['x', 'a', 'y', 'c', 'z'], [g])).toEqual(['x', 'c', 'a', 'y', 'z'])
  })
  it('leaves out leaves not in the order and duplicates', () => {
    const g = group('g', split('s', 'row', [leaf('a'), leaf('gone'), leaf('b')]))
    expect(contiguousOrder(['b', 'x', 'a', 'x'], [g])).toEqual(['a', 'b', 'x'])
  })
  it('is the identity with no groups', () => {
    expect(contiguousOrder(['a', 'b'], [])).toEqual(['a', 'b'])
  })
})

describe('rectsOf and neighbour', () => {
  // +---+-------+
  // | a |   b   |
  // |   +---+---+
  // |   | c | d |
  // +---+---+---+
  const root = split('s', 'row', [leaf('a'), split('t', 'column', [leaf('b'), split('u', 'row', [leaf('c'), leaf('d')])])], [0.25, 0.75])

  it('gives fractional rects in reading order and dividers', () => {
    const { panes, dividers } = rectsOf(root)
    expect(panes.map((p) => p.tab)).toEqual(['a', 'b', 'c', 'd'])
    expect(panes[0]).toEqual({ tab: 'a', x: 0, y: 0, w: 0.25, h: 1 })
    expect(panes[1]).toEqual({ tab: 'b', x: 0.25, y: 0, w: 0.75, h: 0.5 })
    expect(panes[2]).toEqual({ tab: 'c', x: 0.25, y: 0.5, w: 0.375, h: 0.5 })
    expect(panes[3]).toEqual({ tab: 'd', x: 0.625, y: 0.5, w: 0.375, h: 0.5 })
    expect(dividers).toEqual([
      { splitId: 's', index: 0, dir: 'row', x: 0.25, y: 0, length: 1, area: { x: 0, y: 0, w: 1, h: 1 } },
      { splitId: 't', index: 0, dir: 'column', x: 0.25, y: 0.5, length: 0.75, area: { x: 0.25, y: 0, w: 0.75, h: 1 } },
      { splitId: 'u', index: 0, dir: 'row', x: 0.625, y: 0.5, length: 0.5, area: { x: 0.25, y: 0.5, w: 0.75, h: 0.5 } }
    ])
  })

  it('moves spatially, most overlap, ties top/left, no wrap', () => {
    expect(neighbour(root, 'a', 'right')).toBe('b') // b and c overlap a equally: the top one
    expect(neighbour(root, 'c', 'left')).toBe('a')
    expect(neighbour(root, 'd', 'left')).toBe('c')
    expect(neighbour(root, 'b', 'down')).toBe('c') // c and d overlap b equally: the left one
    expect(neighbour(root, 'd', 'up')).toBe('b')
    expect(neighbour(root, 'a', 'left')).toBeUndefined()
    expect(neighbour(root, 'b', 'up')).toBeUndefined()
    expect(neighbour(root, 'd', 'right')).toBeUndefined()
    expect(neighbour(root, 'x', 'right')).toBeUndefined()
    expect(neighbour(root, 'a', 'sideways' as never)).toBeUndefined()
  })

  it('prefers the pane with the most overlap', () => {
    const r = split('s', 'row', [leaf('a'), split('t', 'column', [leaf('b'), leaf('c')], [0.3, 0.7])])
    expect(neighbour(r, 'a', 'right')).toBe('c')
  })
})

describe('fitsMinimum', () => {
  const cell = { width: 8, height: 16 }
  it('checks the cell minimum', () => {
    expect(fitsMinimum({ width: 160, height: 80 }, cell)).toBe(true) // 20x5
    expect(fitsMinimum({ width: 159, height: 80 }, cell)).toBe(false)
    expect(fitsMinimum({ width: 160, height: 79 }, cell)).toBe(false)
    expect(fitsMinimum({ width: 320, height: 160 }, cell, AUTO_ZOOM_CELLS)).toBe(true)
    expect(fitsMinimum({ width: 300, height: 160 }, cell, AUTO_ZOOM_CELLS)).toBe(false)
    expect(fitsMinimum({ width: NaN, height: 80 }, cell)).toBe(false)
    expect(fitsMinimum({ width: 160, height: 80 }, { width: 0, height: 16 })).toBe(false)
  })
})

describe('fitShares', () => {
  it('fills bad entries, scales, clamps', () => {
    expect(fitShares([1, 1], 2, 0.1)).toEqual([0.5, 0.5])
    expect(fitShares([NaN, 2, undefined], 3, 0)).toEqual([0.333334, 0.333333, 0.333333])
    const s = fitShares([0.001, 0.001, 1], 3, 0.1)
    expect(s[0]).toBeCloseTo(0.1)
    expect(s[2]).toBeCloseTo(0.8)
    expect(fitShares([1e308, 1e308], 2, 0.1)).toEqual([0.5, 0.5])
    const twelve = fitShares(new Array(12).fill(1), 12, 0.1)
    expect(twelve.every((v) => Math.abs(v - 1 / 12) < 1e-5)).toBe(true)
    // Fitting fitted shares again changes nothing (no float drift).
    for (const s of [twelve, fitShares([0.3, 0.3, 0.4], 3, 0.1), fitShares([1, 2, 3, 7], 4, 0.1)]) {
      expect(fitShares(s, s.length, 0.1)).toEqual(s)
    }
  })
})

describe('normalizeGroups', () => {
  it('keeps a valid record as it is', () => {
    const g = group('g', split('s', 'row', [leaf('a'), split('t', 'column', [leaf('b'), leaf('c')], [0.4, 0.6])], [0.3, 0.7]), 'dev')
    expect(normalizeGroups([g], ['a', 'b', 'c'])).toEqual([g])
  })

  it('yields [] for anything unreadable', () => {
    for (const raw of [undefined, null, 1, 'x', {}, { 0: {} }, [null], [1], [{ root: 5 }], [{ id: 'g', root: { tab: 'a' } }]]) {
      expect(normalizeGroups(raw, ['a', 'b'])).toEqual([])
    }
  })

  it('prunes dead leaves and dissolves groups under two', () => {
    const raw = [group('g1', split('s1', 'row', [leaf('a'), leaf('dead')])), group('g2', split('s2', 'row', [leaf('b'), leaf('c'), leaf('dead2')]))]
    const out = normalizeGroups(raw, ['a', 'b', 'c'])
    expect(out).toEqual([group('g2', split('s2', 'row', [leaf('b'), leaf('c')]))])
  })

  it('first group wins a duplicate tab; a dissolved group frees its tab', () => {
    const raw = [
      group('g0', split('s0', 'row', [leaf('a'), leaf('dead')])),
      group('g1', split('s1', 'row', [leaf('a'), leaf('b'), leaf('b')])),
      group('g2', split('s2', 'row', [leaf('b'), leaf('c'), leaf('d')]))
    ]
    const out = normalizeGroups(raw, ['a', 'b', 'c', 'd'])
    expect(out.map((g) => leavesOf(g.root))).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('flattens same-direction children with scaled sizes', () => {
    const raw = [group('g', split('s', 'row', [leaf('a'), split('t', 'row', [leaf('b'), leaf('c')], [0.5, 0.5])], [0.5, 0.5]))]
    expect(normalizeGroups(raw, ['a', 'b', 'c'])[0]!.root).toEqual({ id: 's', dir: 'row', children: [leaf('a'), leaf('b'), leaf('c')], sizes: [0.5, 0.25, 0.25] })
  })

  it('fixes sizes: missing, NaN, wrong length, below the minimum', () => {
    const base = (sizes: unknown): unknown => [{ id: 'g', root: { id: 's', dir: 'row', children: [leaf('a'), leaf('b')], sizes } }]
    for (const sizes of [undefined, 'x', [], [NaN, NaN], [1], [-1, -1], [Infinity, 1]]) {
      const root = normalizeGroups(base(sizes), ['a', 'b'])[0]!.root
      expect(root.sizes[0]).toBeCloseTo(0.5)
      expect(root.sizes[1]).toBeCloseTo(0.5)
    }
    const clamped = normalizeGroups(base([0.001, 1]), ['a', 'b'])[0]!.root.sizes
    expect(clamped[0]).toBeCloseTo(0.1)
  })

  it('rejects bad directions and inherited keys', () => {
    expect(normalizeGroups([{ id: 'g', root: { id: 's', dir: 'diagonal', children: [leaf('a'), leaf('b')] } }], ['a', 'b'])).toEqual([])
    const proto = Object.create({ tab: 'a' }) as object
    const inherited = Object.create({ dir: 'row', children: [leaf('a'), leaf('b')] }) as object
    expect(normalizeGroups([{ id: 'g', root: { id: 's', dir: 'row', children: [proto, leaf('b')] } }], ['a', 'b'])).toEqual([])
    expect(normalizeGroups([{ id: 'g', root: inherited }], ['a', 'b'])).toEqual([])
  })

  it('ignores __proto__, constructor and polluting keys from JSON', () => {
    const raw = JSON.parse(
      '[{"__proto__":{"root":{"dir":"row","children":[{"tab":"a"},{"tab":"b"}]}},"id":"g"},' +
        '{"id":"h","name":{"x":1},"root":{"__proto__":{"polluted":true},"id":"s","dir":"row","children":[{"tab":"a"},{"tab":"constructor"},{"tab":"b"}],"sizes":[1,1,1]}}]'
    )
    const out = normalizeGroups(raw, ['a', 'b'])
    expect(out).toEqual([{ id: 'h', root: { id: 's', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] } }])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('mints ids for missing, bad and duplicate ones', () => {
    const raw = [
      { root: { dir: 'row', children: [leaf('a'), leaf('b')] } },
      { id: 'dup', root: { id: 'dup', dir: 'row', children: [leaf('c'), { id: 'x'.repeat(65), dir: 'column', children: [leaf('d'), leaf('e')] }] } }
    ]
    const out = normalizeGroups(raw, ['a', 'b', 'c', 'd', 'e'], GROUP_CAPS, minter())
    expectValid(out, ['a', 'b', 'c', 'd', 'e'])
    expect(out[1]!.id).toBe('dup')
    expect(out[1]!.root.id).not.toBe('dup')
  })

  it('drops a bad name', () => {
    const raw = [{ id: 'g', name: 'a\u0000b', root: split('s', 'row', [leaf('a'), leaf('b')]) }]
    expect('name' in normalizeGroups(raw, ['a', 'b'])[0]!).toBe(false)
  })

  it('caps panes (reading order), depth and group count', () => {
    const tabs = Array.from({ length: 12 }, (_, i) => `t${i}`)
    const wide = normalizeGroups([group('g', split('s', 'row', tabs.map(leaf)))], tabs)
    expect(leavesOf(wide[0]!.root)).toEqual(tabs.slice(0, 8))
    expectValid(wide, tabs)

    const five = group(
      'g',
      split('s1', 'row', [leaf('a'), split('s2', 'column', [leaf('b'), split('s3', 'row', [leaf('c'), split('s4', 'column', [leaf('d'), split('s5', 'row', [leaf('e'), leaf('f')])])])])])
    )
    const ok2 = group('h', split('h1', 'row', [leaf('e'), leaf('f')]))
    // The too-deep group is dropped and its tabs are free for a later group.
    expect(normalizeGroups([five, ok2], ['a', 'b', 'c', 'd', 'e', 'f'])).toEqual([ok2])

    const many: TabGroup[] = []
    const live: string[] = []
    for (let i = 0; i < 40; i++) {
      many.push(group(`g${i}`, split(`s${i}`, 'row', [leaf(`a${i}`), leaf(`b${i}`)])))
      live.push(`a${i}`, `b${i}`)
    }
    const capped = normalizeGroups(many, live)
    expect(capped).toHaveLength(32)
    expect(capped[31]!.id).toBe('g31')
  })

  it('survives depth 1000 without descending it', () => {
    let node: unknown = leaf('a')
    for (let i = 0; i < 1000; i++) node = { id: `s${i}`, dir: i % 2 ? 'row' : 'column', children: [node, leaf(`x${i}`)] }
    const live = ['a', ...Array.from({ length: 1000 }, (_, i) => `x${i}`)]
    const out = normalizeGroups([{ id: 'g', root: node }], live)
    expectValid(out, live)
  })

  it('survives a same-direction chain 1000 deep (prunes past the raw limit)', () => {
    let node: unknown = leaf('a')
    for (let i = 0; i < 1000; i++) node = { id: `s${i}`, dir: 'row', children: [node, leaf(`x${i}`)] }
    const live = ['a', ...Array.from({ length: 1000 }, (_, i) => `x${i}`)]
    const out = normalizeGroups([{ id: 'g', root: node }], live)
    expectValid(out, live)
    expect(out).toHaveLength(1)
  })

  it('handles 10,000 leaves quickly', () => {
    const tabs = Array.from({ length: 10_000 }, (_, i) => `t${i}`)
    const started = Date.now()
    const out = normalizeGroups([{ id: 'g', root: { id: 's', dir: 'row', children: tabs.map(leaf), sizes: tabs.map(() => 1) } }], tabs)
    expect(Date.now() - started).toBeLessThan(1000)
    expectValid(out, tabs)
    expect(leavesOf(out[0]!.root)).toHaveLength(8)
    const groups = normalizeGroups(
      Array.from({ length: 10_000 }, (_, i) => ({ id: `g${i}`, root: { id: `s${i}`, dir: 'row', children: [leaf(`t${i}`), leaf(`t${(i + 1) % 10_000}`)] } })),
      tabs
    )
    expect(groups.length).toBeLessThanOrEqual(32)
    expectValid(groups, tabs)
  })

  it('never throws on fuzzed records and always returns valid groups', () => {
    let seed = 12345
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return seed / 2 ** 31
    }
    const tabs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const junk = (): unknown => [NaN, null, -1, 'row', {}, [], Infinity, '__proto__', true][Math.floor(rand() * 9)]
    const node = (depth: number): unknown => {
      const r = rand()
      if (r < 0.05) return junk()
      if (depth > 6 || r < 0.45) return { tab: rand() < 0.9 ? tabs[Math.floor(rand() * tabs.length)] : 'dead' }
      const n = Math.floor(rand() * 5)
      return {
        id: rand() < 0.8 ? `s${Math.floor(rand() * 20)}` : junk(),
        dir: rand() < 0.9 ? (rand() < 0.5 ? 'row' : 'column') : junk(),
        children: rand() < 0.95 ? Array.from({ length: n }, () => node(depth + 1)) : junk(),
        sizes: rand() < 0.7 ? Array.from({ length: n }, () => (rand() < 0.8 ? rand() * 3 : junk())) : junk()
      }
    }
    for (let i = 0; i < 500; i++) {
      const raw = Array.from({ length: Math.floor(rand() * 5) }, () => ({ id: rand() < 0.8 ? `g${Math.floor(rand() * 5)}` : junk(), name: rand() < 0.5 ? 'n' : junk(), root: node(0) }))
      const out = normalizeGroups(raw, tabs, GROUP_CAPS, minter())
      expectValid(out, tabs)
      // Normalizing again changes nothing.
      expect(normalizeGroups(out, tabs, GROUP_CAPS, minter())).toEqual(out)
    }
  })
})

describe('restoreGroups', () => {
  it('maps saved ids, prunes tabs that did not come back, mints fresh ids', () => {
    const saved = [
      group('g1', split('s1', 'row', [leaf('old-a'), split('s2', 'column', [leaf('old-b'), leaf('old-gone')])]), 'dev'),
      group('g2', split('s3', 'row', [leaf('old-c'), leaf('old-dropped')]))
    ]
    const idMap = new Map([
      ['old-a', 'A'],
      ['old-b', 'B'],
      ['old-c', 'C']
    ])
    const out = restoreGroups(JSON.parse(JSON.stringify(saved)), idMap, minter())
    expect(out).toEqual([{ id: 'id2', name: 'dev', root: { id: 'id1', dir: 'row', children: [leaf('A'), leaf('B')], sizes: [0.5, 0.5] } }])
  })

  it('takes a plain record map, own keys only', () => {
    const saved = [group('g', split('s', 'row', [leaf('x'), leaf('toString')]))]
    expect(restoreGroups(saved, { x: 'X' })).toEqual([])
    expect(restoreGroups(saved, { x: 'X', toString: 'Y' })[0]!.root.children).toEqual([leaf('X'), leaf('Y')])
  })

  it('yields [] for a bad record', () => {
    expect(restoreGroups('nope', new Map())).toEqual([])
    expect(restoreGroups([{ root: { dir: 'row', children: [leaf('a'), leaf('b')] } }], new Map())).toEqual([])
  })
})

describe('op sequences keep every invariant', () => {
  it.each([777, 4242, 90210])('random places, removes, resizes and dissolves (seed %i)', (start) => {
    let seed = start
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31
      return Math.floor((seed / 2 ** 31) * n)
    }
    const edges = ['left', 'right', 'up', 'down'] as const
    const mint = minter()
    let order = Array.from({ length: 14 }, (_, i) => `t${i}`)
    let groups: TabGroup[] = []
    for (let step = 0; step < 2000; step++) {
      const op = rand(10)
      if (op < 6) {
        const r = place(groups, order, { tabId: order[rand(order.length)]!, at: order[rand(order.length)]!, edge: edges[rand(4)]! }, { mint, plugin: rand(5) === 0 })
        if (r.ok) ({ groups, order } = r)
      } else if (op < 8) {
        const r = removeLeaf(groups, order, order[rand(order.length)]!)
        if (r.ok) ({ groups, order } = r)
      } else if (op < 9 && groups.length > 0) {
        const g = groups[rand(groups.length)]!
        const r = setSizes(groups, g.id, g.root.id, g.root.children.map(() => rand(10) + 0.01))
        if (r.ok) groups = r.groups
      } else if (groups.length > 0) {
        const r = dissolve(groups, order, groups[rand(groups.length)]!.id)
        if (r.ok) ({ groups, order } = r)
      }
      expectValid(groups, order)
      expectContiguous(order, groups)
      expect([...order].sort()).toEqual(Array.from({ length: 14 }, (_, i) => `t${i}`).sort())
      expect(normalizeGroups(groups, order)).toEqual(groups)
    }
  })
})
