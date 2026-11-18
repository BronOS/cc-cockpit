import { describe, expect, it } from 'vitest'
import type { GroupsSnapshot, TabGroup } from '../../src/shared/tab-groups'
import { leavesOf } from '../../src/shared/tab-groups'
import { refusalOf, TabGroups } from '../../src/main/tabs/tab-groups'

/** A TabGroups over plain arrays: `orders` stands in for TabManager's order per project. */
function setup(initial: Record<string, string[]> = { p: ['a', 'b', 'c', 'd'] }) {
  const orders = new Map(Object.entries(initial).map(([k, v]) => [k, [...v]]))
  const published: Array<{ projectId: string; snapshot: GroupsSnapshot }> = []
  const saves: string[] = []
  const told: string[] = []
  const groups = new TabGroups({
    order: (p) => [...(orders.get(p) ?? [])],
    setOrder: (p, ids) => {
      orders.set(p, [...ids])
    },
    publish: (projectId, snapshot) => published.push({ projectId, snapshot: structuredClone(snapshot) }),
    changed: (p) => saves.push(p),
    groupsChanged: (p) => told.push(p),
    log: () => {}
  })
  const last = (): GroupsSnapshot => published[published.length - 1]!.snapshot
  return { groups, orders, published, saves, told, last }
}

const members = (g: TabGroup | undefined): string[] => (g ? leavesOf(g.root) : [])

describe('TabGroups edits', () => {
  it('places a tab beside another: one snapshot with a new seq, the order contiguous, one save', () => {
    const t = setup()
    const reply = t.groups.place('p', { tabId: 'd', at: 'a', edge: 'right' })
    expect(reply.ok).toBe(true)
    expect(t.published).toHaveLength(1)
    const snap = t.last()
    expect(reply).toEqual({ ok: true, seq: snap.seq })
    expect(snap.order).toEqual(['a', 'd', 'b', 'c'])
    expect(t.orders.get('p')).toEqual(['a', 'd', 'b', 'c'])
    expect(snap.groups).toHaveLength(1)
    expect(members(snap.groups[0])).toEqual(['a', 'd'])
    expect(t.saves).toEqual(['p'])
    expect(t.told).toEqual(['p'])
  })

  it('refuses an unknown or foreign tab id the same way, with no event and no save', () => {
    const t = setup({ p: ['a', 'b'], q: ['x', 'y'] })
    const foreign = t.groups.place('p', { tabId: 'x', at: 'a', edge: 'right' })
    const unknown = t.groups.place('p', { tabId: 'zz', at: 'a', edge: 'right' })
    const foreignAnchor = t.groups.place('p', { tabId: 'a', at: 'y', edge: 'down' })
    expect(foreign).toEqual({ ok: false, reason: 'unknown-tab' })
    expect(unknown).toEqual(foreign)
    expect(foreignAnchor).toEqual(foreign)
    expect(t.groups.remove('p', 'x')).toEqual(t.groups.remove('p', 'zz'))
    expect(t.groups.dissolve('p', 'nope')).toEqual({ ok: false, reason: 'unknown-group' })
    expect(t.published).toEqual([])
    expect(t.saves).toEqual([])
  })

  it('cannot reach another project’s group by its id', () => {
    const t = setup({ p: ['a', 'b'], q: ['x', 'y'] })
    t.groups.place('q', { tabId: 'y', at: 'x', edge: 'right' })
    const gid = t.groups.groupsOf('q')[0]!.id
    const splitId = t.groups.groupsOf('q')[0]!.root.id
    t.published.length = 0
    expect(refusalOf(t.groups.dissolve('p', gid))).toBe('unknown-group')
    expect(refusalOf(t.groups.rename('p', gid, 'mine'))).toBe('unknown-group')
    expect(refusalOf(t.groups.resize('p', gid, splitId, [0.5, 0.5]))).toBe('unknown-group')
    expect(t.published).toEqual([])
    expect(t.groups.groupsOf('q')).toHaveLength(1)
  })

  it('resizes (clamped to the minimum share) and renames, each a snapshot', () => {
    const t = setup()
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    const g = t.groups.groupsOf('p')[0]!
    expect(t.groups.resize('p', g.id, g.root.id, [0.99, 0.01]).ok).toBe(true)
    expect(t.groups.groupsOf('p')[0]!.root.sizes).toEqual([0.9, 0.1])
    expect(t.groups.rename('p', g.id, 'dev').ok).toBe(true)
    expect(t.last().groups[0]!.name).toBe('dev')
    expect(refusalOf(t.groups.rename('p', g.id, ''))).toBe('bad-name')
    expect(t.published).toHaveLength(3)
    const seqs = t.published.map((e) => e.snapshot.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
  })

  it('an edit that changes nothing publishes nothing', () => {
    const t = setup()
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    const g = t.groups.groupsOf('p')[0]!
    t.groups.resize('p', g.id, g.root.id, [0.5, 0.5])
    expect(t.published).toHaveLength(1)
  })

  it('remove: the tab goes right after the block, a two-pane group dissolves', () => {
    const t = setup({ p: ['a', 'b', 'c', 'd'] })
    t.groups.place('p', { tabId: 'c', at: 'a', edge: 'right' }) // a c b d
    t.groups.place('p', { tabId: 'd', at: 'c', edge: 'down' }) // a c d b
    expect(t.orders.get('p')).toEqual(['a', 'c', 'd', 'b'])
    expect(t.groups.remove('p', 'a').ok).toBe(true)
    expect(t.orders.get('p')).toEqual(['c', 'd', 'a', 'b'])
    expect(t.groups.remove('p', 'c').ok).toBe(true)
    expect(t.groups.groupsOf('p')).toEqual([])
    expect(t.last().groups).toEqual([])
  })

  it('dissolve keeps the members in place', () => {
    const t = setup()
    t.groups.place('p', { tabId: 'd', at: 'b', edge: 'left' })
    const before = t.orders.get('p')
    expect(t.groups.dissolve('p', t.groups.groupsOf('p')[0]!.id).ok).toBe(true)
    expect(t.orders.get('p')).toEqual(before)
    expect(t.groups.groupsOf('p')).toEqual([])
  })

  it('caps: a plugin places only below 4 panes, a person up to 8', () => {
    const tabs = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']
    const t = setup({ p: tabs })
    for (let i = 1; i < 4; i++) expect(t.groups.place('p', { tabId: tabs[i]!, at: 't0', edge: i % 2 ? 'right' : 'down' }).ok).toBe(true)
    expect(refusalOf(t.groups.place('p', { tabId: 't4', at: 't0', edge: 'right' }, { plugin: true }))).toBe('full')
    for (let i = 4; i < 8; i++) expect(t.groups.place('p', { tabId: tabs[i]!, at: tabs[i - 1]!, edge: 'right' }).ok).toBe(true)
    expect(refusalOf(t.groups.place('p', { tabId: 't8', at: 't0', edge: 'right' }))).toBe('full')
  })
})

describe('TabGroups.createBeside', () => {
  it('creates and places in one snapshot: no view sees the new tab plain', () => {
    const t = setup({ p: ['a', 'b'] })
    const { tab, placed } = t.groups.createBeside('p', { tabId: 'a', edge: 'down' }, () => {
      t.orders.get('p')!.push('n')
      // TabManager's own change during the create (onTabsChanged → sync) must not publish.
      t.groups.sync('p')
      return { id: 'n' }
    })
    expect(tab).toEqual({ id: 'n' })
    expect(placed).toBe(true)
    expect(t.published).toHaveLength(1)
    expect(t.last().order).toEqual(['a', 'n', 'b'])
    expect(members(t.last().groups[0])).toEqual(['a', 'n'])
    expect(t.last().groups[0]!.root.dir).toBe('column')
    expect(t.saves).toEqual(['p'])
  })

  it('a refused anchor leaves the new tab plain (D15), still one snapshot', () => {
    const t = setup({ p: ['a'], q: ['x'] })
    const { placed } = t.groups.createBeside('p', { tabId: 'x', edge: 'right' }, () => {
      t.orders.get('p')!.push('n')
      return { id: 'n' }
    })
    expect(placed).toBe(false)
    expect(t.published).toHaveLength(1)
    expect(t.last()).toMatchObject({ order: ['a', 'n'], groups: [] })
  })

  it('an overlay entry (create returns null) is never a pane', () => {
    const t = setup({ p: ['a'] })
    const { tab, placed } = t.groups.createBeside('p', { tabId: 'a', edge: 'right' }, () => null)
    expect(tab).toBeNull()
    expect(placed).toBe(false)
    expect(t.groups.groupsOf('p')).toEqual([])
  })

  it('a throwing create publishes nothing half done and releases the hold', () => {
    const t = setup({ p: ['a'] })
    expect(() =>
      t.groups.createBeside('p', { tabId: 'a', edge: 'right' }, () => {
        throw new Error('spawn failed')
      })
    ).toThrow('spawn failed')
    t.orders.get('p')!.push('b')
    t.groups.sync('p')
    expect(t.last().order).toEqual(['a', 'b'])
  })
})

describe('TabGroups lifecycle', () => {
  it('a member closing removes its leaf and publishes, without a save of its own', () => {
    const t = setup({ p: ['a', 'b', 'c'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    t.groups.place('p', { tabId: 'c', at: 'b', edge: 'right' })
    t.saves.length = 0
    t.told.length = 0
    // TabManager tells `closed` while the tab is still in its order.
    t.groups.tabClosed('b')
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['a', 'c'])
    expect(t.last().order).toEqual(['a', 'c'])
    expect(t.saves).toEqual([])
    expect(t.told).toEqual(['p'])
    // Then TabManager drops it and reports its change: the order is already published.
    t.orders.set('p', ['a', 'c'])
    const n = t.published.length
    t.groups.sync('p')
    expect(t.published).toHaveLength(n)
  })

  it('the last-but-one member closing dissolves the group, the survivor stays in place', () => {
    const t = setup({ p: ['x', 'a', 'b', 'y'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    t.groups.tabClosed('a')
    expect(t.groups.groupsOf('p')).toEqual([])
    expect(t.last().order).toEqual(['x', 'b', 'y'])
  })

  it('a plain tab closing publishes only through sync', () => {
    const t = setup({ p: ['a', 'b'] })
    t.groups.tabClosed('a')
    expect(t.published).toEqual([])
    t.orders.set('p', ['b'])
    t.groups.sync('p')
    expect(t.last()).toMatchObject({ order: ['b'], groups: [] })
  })

  it('closeProject forgets the groups: a later close of its tabs publishes nothing', () => {
    const t = setup({ p: ['a', 'b'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    const n = t.published.length
    t.groups.closeProject('p')
    t.groups.tabClosed('a')
    expect(t.published).toHaveLength(n)
    expect(t.groups.groupsOf('p')).toEqual([])
  })

  it('seq never goes back, across projects and a closed project', () => {
    const t = setup({ p: ['a', 'b'], q: ['x', 'y'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    t.groups.place('q', { tabId: 'y', at: 'x', edge: 'right' })
    t.groups.closeProject('p')
    t.groups.place('p', { tabId: 'a', at: 'b', edge: 'down' })
    const seqs = t.published.map((e) => e.snapshot.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(t.groups.get('p').seq).toBe(seqs[seqs.length - 1])
  })
})

describe('TabGroups.reorder (D9)', () => {
  const grouped = () => {
    const t = setup({ p: ['a', 'b', 'c', 'd', 'e'] })
    t.groups.place('p', { tabId: 'c', at: 'b', edge: 'right' })
    t.groups.place('p', { tabId: 'd', at: 'c', edge: 'down' })
    // order: a [b c d] e
    expect(t.orders.get('p')).toEqual(['a', 'b', 'c', 'd', 'e'])
    t.published.length = 0
    t.saves.length = 0
    return t
  }

  it('a plain tab moves as before, and every reorder publishes the order', () => {
    const t = setup({ p: ['a', 'b', 'c'] })
    t.groups.reorder('p', 'c', 0)
    expect(t.orders.get('p')).toEqual(['c', 'a', 'b'])
    expect(t.last().order).toEqual(['c', 'a', 'b'])
    expect(t.saves).toEqual(['p'])
    t.groups.reorder('p', 'c', 99)
    expect(t.orders.get('p')).toEqual(['a', 'b', 'c'])
  })

  it('throws for a tab that is not the project’s', () => {
    const t = setup({ p: ['a'], q: ['x'] })
    expect(() => t.groups.reorder('p', 'x', 0)).toThrow('unknown tab')
    expect(() => t.groups.reorder('p', 'a', 0.5)).toThrow()
  })

  it('the handle drag (block) moves the whole group', () => {
    const t = grouped()
    t.groups.reorder('p', 'c', 0, true)
    expect(t.orders.get('p')).toEqual(['b', 'c', 'd', 'a', 'e'])
    t.groups.reorder('p', 'b', 99, true)
    expect(t.orders.get('p')).toEqual(['a', 'e', 'b', 'c', 'd'])
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['b', 'c', 'd'])
  })

  it('a member dropped inside its own segment changes nothing', () => {
    const t = grouped()
    t.groups.reorder('p', 'b', 2) // between c and d
    t.groups.reorder('p', 'd', 2) // between b and c
    expect(t.orders.get('p')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(t.published).toEqual([])
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['b', 'c', 'd'])
  })

  it('a member’s plain reorder is a no-op only at its own position or strictly between two mates (D26 N2)', () => {
    // a [b c d] e. In the order without the tab, b's mates c d sit at 1..2, so 2 (between them) and
    // 1 (its own position) are no-ops; c's mates b d at 1..2: only 2 (its own); d's: 2 and 3.
    const t = grouped()
    const noops: Array<[string, number]> = [['b', 1], ['b', 2], ['c', 2], ['d', 2], ['d', 3]]
    for (const [tab, at] of noops) t.groups.reorder('p', tab, at)
    expect(t.orders.get('p')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(t.published).toEqual([])
    expect(t.saves).toEqual([])
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['b', 'c', 'd'])
    // Just past the bracket detaches: b after its last mate, then c before its first.
    t.groups.reorder('p', 'b', 3)
    expect(t.orders.get('p')).toEqual(['a', 'c', 'd', 'b', 'e'])
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['c', 'd'])
    t.groups.reorder('p', 'd', 1)
    expect(t.orders.get('p')).toEqual(['a', 'd', 'c', 'b', 'e'])
    expect(t.groups.groupsOf('p')).toEqual([])
  })

  it('a group at the end of the strip can be dragged out on that side (D26 N2)', () => {
    // [c,d,a,b], group {a,b}. b to 3 or 99 is its own position: nothing. a to 99 lands after its
    // last mate: it detaches (the group dissolves), as does b to 2, before its first mate.
    const make = () => {
      const q = setup({ p: ['c', 'd', 'a', 'b'] })
      q.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
      q.published.length = 0
      q.saves.length = 0
      return q
    }
    const q = make()
    q.groups.reorder('p', 'b', 3)
    q.groups.reorder('p', 'b', 99)
    q.groups.reorder('p', 'a', 2)
    expect(q.published).toEqual([])
    expect(members(q.groups.groupsOf('p')[0])).toEqual(['a', 'b'])
    q.groups.reorder('p', 'a', 99)
    expect(q.orders.get('p')).toEqual(['c', 'd', 'b', 'a'])
    expect(q.groups.groupsOf('p')).toEqual([])
    expect(q.published).toHaveLength(1)
    const r = make()
    r.groups.reorder('p', 'b', 2)
    expect(r.orders.get('p')).toEqual(['c', 'd', 'b', 'a'])
    expect(r.groups.groupsOf('p')).toEqual([])
  })

  it('a member dropped outside its segment detaches as a plain tab there', () => {
    const t = grouped()
    t.groups.reorder('p', 'c', 0)
    expect(t.orders.get('p')).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['b', 'd'])
    expect(t.published).toHaveLength(1)
    expect(t.told).toContain('p')
    t.groups.reorder('p', 'b', 99)
    expect(t.orders.get('p')).toEqual(['c', 'a', 'd', 'e', 'b'])
    expect(t.groups.groupsOf('p')).toEqual([])
  })

  it('a plain tab dropped inside a segment lands after the group', () => {
    const t = grouped()
    t.groups.reorder('p', 'e', 2)
    expect(t.orders.get('p')).toEqual(['a', 'b', 'c', 'd', 'e'])
    t.groups.reorder('p', 'a', 2)
    expect(t.orders.get('p')).toEqual(['b', 'c', 'd', 'a', 'e'])
  })
})

describe('TabGroups.restore', () => {
  it('maps saved ids to the restored tabs, prunes the ones that did not come back, re-mints ids', () => {
    const t = setup({ p: ['n1', 'n2', 'n3'] })
    const saved = [
      { id: 'old-g', root: { id: 'old-s', dir: 'row', children: [{ tab: 's1' }, { tab: 's2' }, { tab: 'gone' }], sizes: [0.2, 0.3, 0.5] } }
    ]
    t.groups.restore('p', saved, new Map([['s1', 'n1'], ['s2', 'n3']]))
    const g = t.groups.groupsOf('p')
    expect(g).toHaveLength(1)
    expect(members(g[0])).toEqual(['n1', 'n3'])
    expect(g[0]!.id).not.toBe('old-g')
    expect(g[0]!.root.id).not.toBe('old-s')
    expect(t.orders.get('p')).toEqual(['n1', 'n3', 'n2'])
    expect(t.last().order).toEqual(['n1', 'n3', 'n2'])
    expect(t.saves).toEqual(['p'])
  })

  it('a dropped command tab dissolves its two-pane group; a junk record restores no groups', () => {
    const t = setup({ p: ['n1'] })
    t.groups.restore('p', [{ id: 'g', root: { id: 's', dir: 'row', children: [{ tab: 's1' }, { tab: 'cmd' }], sizes: [0.5, 0.5] } }], new Map([['s1', 'n1']]))
    expect(t.groups.groupsOf('p')).toEqual([])
    t.groups.restore('p', { evil: true }, new Map())
    t.groups.restore('p', [null, 7, { root: { dir: 'diagonal' } }], new Map())
    expect(t.groups.groupsOf('p')).toEqual([])
    expect(t.last()).toMatchObject({ order: ['n1'], groups: [] })
  })

  it('keeps groups made before the restore first (a tab is in one group only)', () => {
    const t = setup({ p: ['a', 'b', 'n1'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    t.groups.restore('p', [{ root: { dir: 'row', children: [{ tab: 's1' }, { tab: 'sa' }] } }], new Map([['s1', 'n1'], ['sa', 'a']]))
    const g = t.groups.groupsOf('p')
    expect(g).toHaveLength(1)
    expect(members(g[0])).toEqual(['a', 'b'])
  })

  it('the restored order wins over nothing: joinOrder lists the selected tab first', () => {
    const t = setup({ p: ['a', 'b', 'c'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    t.groups.place('p', { tabId: 'c', at: 'b', edge: 'down' })
    expect(t.groups.joinOrder('p', 'b')).toEqual(['b', 'a', 'c'])
    expect(t.groups.joinOrder('p', 'zz')).toEqual(['zz'])
    expect(t.groups.joinOrder('q', 'a')).toEqual(['a'])
  })
})

describe('a plugin’s beside (D4 D5 D7)', () => {
  const withSizes = (sizes: Record<string, { cols: number; rows: number }>) => {
    const orders = new Map([['p', ['a', 'b', 'c', 'd', 'e']]])
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      setOrder: (p, ids) => void orders.set(p, [...ids]),
      publish: () => {},
      changed: () => {},
      sizeOf: (_p, t) => sizes[t],
      log: () => {}
    })
    return groups
  }

  it('places a plugin’s tab only while both halves of the anchor keep 20 x 5 cells; a person’s split is not checked here', () => {
    const g = withSizes({ a: { cols: 41, rows: 11 }, b: { cols: 40, rows: 10 } })
    expect(g.createBeside('p', { tabId: 'a', edge: 'right' }, () => ({ id: 'c' }), { plugin: true }).placed).toBe(true)
    expect(g.createBeside('p', { tabId: 'b', edge: 'right' }, () => ({ id: 'd' }), { plugin: true }).placed).toBe(false)
    expect(g.createBeside('p', { tabId: 'b', edge: 'down' }, () => ({ id: 'd' }), { plugin: true }).placed).toBe(false)
    expect(g.createBeside('p', { tabId: 'b', edge: 'down' }, () => ({ id: 'd' })).placed).toBe(true)
    // An unknown size (no pty, nobody measured it) is no reason to refuse.
    expect(g.createBeside('p', { tabId: 'e', edge: 'down' }, () => ({ id: 'd' }), { plugin: true }).placed).toBe(true)
  })

  it('focus: a placed pane never takes focus; the origin view selects the anchor unless it shows that group already', () => {
    const g = withSizes({})
    g.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    g.place('p', { tabId: 'c', at: 'a', edge: 'down' })
    const shows = (tab: string | undefined) => () => tab
    // The view is somewhere else: it is shown the group, at the anchor.
    expect(g.pluginFocus('p', { tabId: 'c', placed: true, anchor: 'a' }, 'web:1', shows('d'))).toEqual({ to: 'view', view: 'web:1', tabId: 'a' })
    expect(g.pluginFocus('p', { tabId: 'c', placed: true, anchor: 'a' }, 'desktop:1', shows(undefined))).toEqual({ to: 'view', view: 'desktop:1', tabId: 'a' })
    // It already shows the group (the person is typing in b): nothing moves its keys.
    expect(g.pluginFocus('p', { tabId: 'c', placed: true, anchor: 'a' }, 'web:1', shows('b'))).toBeUndefined()
    // Not placed: the new plain tab is selected in the window, as before groups.
    expect(g.pluginFocus('p', { tabId: 'e', placed: false, anchor: 'a' }, 'web:1', shows('b'))).toEqual({ to: 'window', tabId: 'e' })
    expect(g.pluginFocus('p', { tabId: 'e', placed: false }, 'web:1', shows('b'))).toEqual({ to: 'window', tabId: 'e' })
  })
})

// The person's `panesPerGroup` limit (shared/plugin-limits.ts), read by main at each placement through
// TabGroupsDeps.pluginPanes with the plugin id HostApi put in the placement; and the size check on the equal share.
describe('a plugin’s panesPerGroup and even stacks', () => {
  const make = (opts: { panes?: (id: string) => number; sizes?: Record<string, { cols: number; rows: number }> } = {}) => {
    const orders = new Map([['p', ['co', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']]])
    const asked: string[] = []
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      setOrder: (p, ids) => void orders.set(p, [...ids]),
      publish: () => {},
      changed: () => {},
      sizeOf: (_p, t) => opts.sizes?.[t],
      ...(opts.panes
        ? {
            pluginPanes: (id: string) => {
              asked.push(id)
              return opts.panes!(id)
            }
          }
        : {}),
      log: () => {}
    })
    return { groups, asked }
  }
  /** The Team plugin's stack: m1 right of the coordinator, each next member down beside the previous one. */
  const stack = (g: TabGroups, n: number, pluginId = 'a.one'): boolean[] =>
    Array.from({ length: n }, (_, i) =>
      g.place('p', { tabId: `m${i + 1}`, at: i === 0 ? 'co' : `m${i}`, edge: i === 0 ? 'right' : 'down' }, { plugin: true, pluginId }).ok
    )

  it('defaults to 4 panes; the plugin’s limit is read at every placement, so a change applies to the next one', () => {
    expect(stack(make().groups, 4)).toEqual([true, true, true, false])
    let limit = 3
    const { groups, asked } = make({ panes: () => limit })
    expect(stack(groups, 3)).toEqual([true, true, false])
    limit = 8
    expect(groups.place('p', { tabId: 'm3', at: 'm2', edge: 'down' }, { plugin: true, pluginId: 'a.one' }).ok).toBe(true)
    expect(asked.every((id) => id === 'a.one')).toBe(true)
    expect(asked).toHaveLength(4)
  })

  it('a column of 7 members fills a group of 8 with the limit at 8, every member the same height', () => {
    const { groups } = make({ panes: () => 8 })
    expect(stack(groups, 8)).toEqual([true, true, true, true, true, true, true, false])
    const root = groups.groupsOf('p')[0]!.root
    expect(leavesOf(root)).toHaveLength(8)
    const column = (root as { children: Array<{ sizes?: number[] }> }).children[1]!
    for (const v of column.sizes!) expect(v).toBeCloseTo(1 / 7, 5)
  })

  it('clamps what it reads to 2..8 and takes the default for junk, a throw or no plugin id', () => {
    expect(stack(make({ panes: () => 1 }).groups, 2)).toEqual([true, false])
    expect(stack(make({ panes: () => 99 }).groups, 8)).toEqual([true, true, true, true, true, true, true, false])
    expect(stack(make({ panes: () => Number.NaN }).groups, 4)).toEqual([true, true, true, false])
    const throws = make({
      panes: () => {
        throw new Error('disk')
      }
    })
    expect(stack(throws.groups, 4)).toEqual([true, true, true, false])
    const noId = make({ panes: () => 8 })
    const placed = Array.from({ length: 4 }, (_, i) =>
      noId.groups.place('p', { tabId: `m${i + 1}`, at: i === 0 ? 'co' : `m${i}`, edge: i === 0 ? 'right' : 'down' }, { plugin: true }).ok
    )
    expect(placed).toEqual([true, true, true, false])
    expect(noId.asked).toEqual([])
  })

  it('a person’s placement is not bound by the plugin limit and never asks for it', () => {
    const { groups, asked } = make({ panes: () => 2 })
    for (let i = 1; i <= 7; i++) expect(groups.place('p', { tabId: `m${i}`, at: i === 1 ? 'co' : `m${i - 1}`, edge: i === 1 ? 'right' : 'down' }).ok).toBe(true)
    expect(asked).toEqual([])
  })

  it('checks the size on the equal share of the column, not on half the anchor', () => {
    // Three members of 6 rows each, as m3 reports once the stack is drawn: 18 rows of panes in the column (+2 dividers).
    // Halving m3 would leave 2 rows each; the even stack gives 4 equal panes of (20 - 3) / 4 = 4 rows: under 5, not placed.
    const sizes: Record<string, { cols: number; rows: number }> = {}
    const g = make({ panes: () => 8, sizes })
    expect(stack(g.groups, 3)).toEqual([true, true, true])
    sizes.m3 = { cols: 80, rows: 6 }
    expect(g.groups.createBeside('p', { tabId: 'm3', edge: 'down' }, () => ({ id: 'm4' }), { plugin: true, pluginId: 'a.one' }).placed).toBe(false)
    // 11 rows each: (35 - 3) / 4 = 8 rows, placed, enough to be shown side by side (AUTO_ZOOM_CELLS 6 rows plus 2 of
    // chrome); halving m3 alone would have given 5 and refused it.
    const tallSizes: Record<string, { cols: number; rows: number }> = {}
    const tall = make({ panes: () => 8, sizes: tallSizes })
    expect(stack(tall.groups, 3)).toEqual([true, true, true])
    tallSizes.m3 = { cols: 80, rows: 11 }
    expect(tall.groups.createBeside('p', { tabId: 'm3', edge: 'down' }, () => ({ id: 'm4' }), { plugin: true, pluginId: 'a.one' }).placed).toBe(true)
  })
})

// The size check of a plugin's beside: every pane the placement shrinks keeps PANE_MIN_CELLS, not only the anchor and
// the new one; and the anchor's size is read against the layout it was measured under, never the one main has now
// (a view reports a pane's new size a round trip after the layout changed).
describe('a plugin’s beside: every pane it shrinks, from a size and the layout it was measured under', () => {
  const make = (order: string[]) => {
    const orders = new Map([['p', order]])
    const sizes = new Map<string, { cols: number; rows: number }>()
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      setOrder: (p, ids) => void orders.set(p, [...ids]),
      publish: () => {},
      changed: () => {},
      sizeOf: (_p, t) => sizes.get(t),
      pluginPanes: () => 8,
      log: () => {}
    })
    const beside = (at: string, id: string, edge: 'right' | 'down' = 'right'): boolean =>
      groups.createBeside('p', { tabId: at, edge }, () => ({ id }), { plugin: true, pluginId: 'a.one' }).placed
    const ids = (g: TabGroups) => {
      const group = g.groupsOf('p')[0]!
      return { group: group.id, split: group.root.id }
    }
    return { groups, sizes, beside, ids }
  }
  /** a at 20% of a row, then a column of b over a row of c and d, c taking `c` of that row; every pane reported under it. */
  const nested = (c: number) => {
    const t = make(['a', 'b', 'c', 'd', 'x'])
    const root = {
      id: 's',
      dir: 'row' as const,
      children: [
        { tab: 'a' },
        { id: 'c1', dir: 'column' as const, children: [{ tab: 'b' }, { id: 'r1', dir: 'row' as const, children: [{ tab: 'c' }, { tab: 'd' }], sizes: [c, 1 - c] }], sizes: [0.5, 0.5] }
      ],
      sizes: [0.2, 0.8]
    }
    t.groups.restore('p', [{ id: 'g', root }], new Map(['a', 'b', 'c', 'd'].map((k) => [k, k])))
    // A 300 x 50 group (wide enough that the evened group is shown side by side, so only the 20x5 rule decides): a is
    // (300 - 1) * 0.2 wide (59, read back as 296 columns), c (239 - 1) * c.
    t.sizes.set('a', { cols: 59, rows: 50 })
    t.sizes.set('b', { cols: 239, rows: 24 })
    t.sizes.set('c', { cols: Math.floor(238 * c), rows: 25 })
    t.sizes.set('d', { cols: Math.floor(238 * (1 - c)), rows: 25 })
    return t
  }

  it('refuses a placement whose equal shares squeeze a nested pane under 20 columns', () => {
    // Beside a: the row becomes three thirds of 98 columns, so c (20% of the 97 left in its row) falls from 47 to 19.
    const narrow = nested(0.2)
    expect(narrow.beside('a', 'x')).toBe(false)
    expect(leavesOf(narrow.groups.groupsOf('p')[0]!.root)).toEqual(['a', 'b', 'c', 'd'])
    // c at half its row keeps 48 of them: placed.
    expect(nested(0.5).beside('a', 'x')).toBe(true)
  })

  it('a pane that shrinks by less than a cell still counts as shrunk when it is under 20 columns', () => {
    // A 131 x 50 group: a at 66.5% of the row, then a column of b over a row of c (46%) and d. a reports 86 columns
    // (130 x 0.665 = 86.45), which reads as a 130.3-column row. Thirds beside a take c from 19.47 to 19.21 columns:
    // both floor to 19, but c gets narrower under the minimum, so the placement is refused.
    const t = make(['a', 'b', 'c', 'd', 'x'])
    const root = {
      id: 's',
      dir: 'row' as const,
      children: [
        { tab: 'a' },
        { id: 'c1', dir: 'column' as const, children: [{ tab: 'b' }, { id: 'r1', dir: 'row' as const, children: [{ tab: 'c' }, { tab: 'd' }], sizes: [0.46, 0.54] }], sizes: [0.5, 0.5] }
      ],
      sizes: [0.665, 0.335]
    }
    t.groups.restore('p', [{ id: 'g', root }], new Map(['a', 'b', 'c', 'd'].map((k) => [k, k])))
    t.sizes.set('a', { cols: 86, rows: 50 })
    expect(t.beside('a', 'x')).toBe(false)
    expect(leavesOf(t.groups.groupsOf('p')[0]!.root)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reads a stale size against the layout it was measured under: a grown anchor places, a shrunk one does not', () => {
    // A 181-column row of halves: a reports 90. The person drags a to 75%; its new size is not reported yet.
    const grown = make(['a', 'b', 'x'])
    grown.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    grown.sizes.set('a', { cols: 90, rows: 24 })
    const g = grown.ids(grown.groups)
    expect(grown.groups.resize('p', g.group, g.split, [0.75, 0.25]).ok).toBe(true)
    // Thirds of the 181 columns are 59 each (90 read as 75% would make 39, too narrow to be shown side by side, and refuse).
    expect(grown.beside('a', 'x')).toBe(true)

    // A 121-column row with a at 75%: a reports 90. Dragged back to halves, before the new report: thirds are 39.
    const shrunk = make(['a', 'b', 'x'])
    shrunk.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    const s = shrunk.ids(shrunk.groups)
    shrunk.groups.resize('p', s.group, s.split, [0.75, 0.25])
    shrunk.sizes.set('a', { cols: 90, rows: 24 })
    shrunk.groups.resize('p', s.group, s.split, [0.5, 0.5])
    expect(shrunk.beside('a', 'x')).toBe(false)
    // The report for the halves comes (60 columns): the same 121 columns, still no room.
    shrunk.sizes.set('a', { cols: 60, rows: 24 })
    expect(shrunk.beside('a', 'x')).toBe(false)
    // A wider window (a reports 80 of 161 columns): thirds of 53, placed.
    shrunk.sizes.set('a', { cols: 80, rows: 24 })
    expect(shrunk.beside('a', 'x')).toBe(true)
  })
})

// A plugin opening panes back to back (the Team plugin's room members): each new tab is placed, and the next one asked
// beside it, before any view has sized it. TabManager.sizeOf knows no size for such a tab (its spawn size is no pane's),
// so the check reads the area from the anchor or a group mate, a size measured where it is now first.
describe('a plugin’s beside, back to back: panes no view has sized yet', () => {
  const make = (order: string[], panes = 8) => {
    const orders = new Map([['p', [...order]]])
    // Only tabs a view has sized: a new tab has no entry, as TabManager.sizeOf answers for it.
    const sizes = new Map<string, { cols: number; rows: number }>()
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      setOrder: (p, ids) => void orders.set(p, [...ids]),
      publish: () => {},
      changed: () => {},
      sizeOf: (_p, t) => sizes.get(t),
      pluginPanes: () => panes,
      log: () => {}
    })
    /** A new tab created and placed under one snapshot, as index.ts announcePluginTab does for `rooms.open`. */
    const open = (id: string, at: string, edge: 'right' | 'down'): boolean =>
      groups.createBeside(
        'p',
        { tabId: at, edge },
        () => {
          orders.get('p')!.push(id)
          return { id }
        },
        { plugin: true, pluginId: 'bronos.team' }
      ).placed
    const shape = () => groups.groupsOf('p').map((g) => leavesOf(g.root))
    return { groups, sizes, open, shape }
  }

  it('the live Team run: m3 is refused because the lead’s group already holds 6 panes (the person’s column of 3), not by size', () => {
    // As the saved record after the run: the lead L had the person's own column of x, y, z beside it (their splits:
    // 1/2, 1/4, 1/4) before Team opened anything, in a window of about 180 x 48 cells.
    const run = (panes: number) => {
      const t = make(['L', 'x', 'y', 'z'], panes)
      t.groups.place('p', { tabId: 'x', at: 'L', edge: 'right' })
      t.groups.place('p', { tabId: 'y', at: 'x', edge: 'down' })
      t.groups.place('p', { tabId: 'z', at: 'y', edge: 'down' })
      for (const [tab, size] of [
        ['L', { cols: 89, rows: 48 }],
        ['x', { cols: 90, rows: 23 }],
        ['y', { cols: 90, rows: 11 }],
        ['z', { cols: 90, rows: 11 }]
      ] as const) {
        t.sizes.set(tab, size)
      }
      // Five hires within a second: no view reports any member's size in between.
      const placed = [t.open('m1', 'L', 'right'), t.open('m2', 'm1', 'down'), t.open('m3', 'm2', 'down')]
      placed.push(t.open('m4', 'm3', 'down'), t.open('m5', 'm4', 'down'))
      return { t, placed }
    }
    const live = run(6)
    expect(live.placed).toEqual([true, true, false, true, true])
    // m1 joined the lead's row evenly (thirds), m2 halved m1: 6 panes, the person's panesPerGroup for Team.
    expect(live.t.shape()).toEqual([
      ['L', 'm1', 'm2', 'x', 'y', 'z'],
      ['m3', 'm4', 'm5']
    ])
    const lead = live.t.groups.groupsOf('p')[0]!.root
    expect(lead.dir === 'row' && lead.sizes.map((s) => s.toFixed(3))).toEqual(['0.333', '0.333', '0.333'])
    // The count is what refused: the size check leaves m3 a third of the middle column, and a limit of 7 places it.
    expect(refusalOf(live.t.groups.place('p', { tabId: 'm5', at: 'm2', edge: 'down' }, { plugin: true, pluginId: 'bronos.team' }))).toBe('full')
    expect(run(7).placed.slice(0, 3)).toEqual([true, true, true])
  })

  it('reads the area from a group mate measured in its place when the anchor’s own size may come from an older place', () => {
    // A 240-column window. A plugin opens m1 right of L, then m2 beside m1, back to back: m1 moves (a half, then a
    // third) before any view sized it. The view then reports the thirds: 79 columns each.
    const t = make(['L'])
    t.sizes.set('L', { cols: 240, rows: 40 })
    expect(t.open('m1', 'L', 'right')).toBe(true)
    expect(t.open('m2', 'm1', 'right')).toBe(true)
    for (const tab of ['L', 'm1', 'm2']) t.sizes.set(tab, { cols: 79, rows: 40 })
    // m1's 79 columns may have been measured at a half (159 columns) or a third (239): read alone, the smaller made
    // quarters of 39, too narrow to be shown side by side, and refused. m2 has had one place since it was sized, so its
    // 79 columns are a third of 239: quarters of 59, placed.
    expect(t.open('m3', 'm1', 'right')).toBe(true)
    expect(t.shape()).toEqual([['L', 'm1', 'm3', 'm2']])
  })

  it('the Column test 7 run: five members stack beside the lead in a 1080p window, a sixth would zoom the view and opens plain', () => {
    // About 200 x 52 cells of terminal: L left, the members in a column on the right. Five members get (52 - 4) / 5 = 9
    // rows, shown side by side (AUTO_ZOOM_CELLS' 6 rows plus 2 of chrome); while the view's minimum was 10 rows, it
    // zoomed this group to the lead's pane. A sixth would get 7 rows: the view would zoom, so it opens as a plain tab.
    const t = make(['L'])
    t.sizes.set('L', { cols: 200, rows: 52 })
    const placed = [t.open('m1', 'L', 'right')]
    for (let i = 2; i <= 6; i++) placed.push(t.open(`m${i}`, `m${i - 1}`, 'down'))
    expect(placed).toEqual([true, true, true, true, true, false])
    expect(t.shape()).toEqual([['L', 'm1', 'm2', 'm3', 'm4', 'm5']])
  })

  it('a group the view already zooms is left to the 20x5 rule: a pane that keeps it is still placed', () => {
    // A short window (14 rows) the person split themselves: halves of 6 rows, already zoomed in a view this size.
    const t = make(['L', 'B'])
    t.groups.place('p', { tabId: 'B', at: 'L', edge: 'down' })
    t.sizes.set('L', { cols: 100, rows: 6 })
    t.sizes.set('B', { cols: 100, rows: 6 })
    // C right of B: two panes of 49 x 6, over 20 x 5. The group was not shown side by side before either.
    expect(t.open('C', 'B', 'right')).toBe(true)
    // In a group still shown side by side, the same short panes would tip it over: refused.
    const tall = make(['L'])
    tall.sizes.set('L', { cols: 100, rows: 14 })
    expect(tall.open('B', 'L', 'down')).toBe(false)
  })

  it('an anchor with no size is checked against a group mate’s older size rather than not at all', () => {
    // A short window (20 rows), L sized. B opens below L and C below B before any view reports: B has no size, and
    // L's 20 rows are from before it moved (not where it is now), but they still tell the group: halves (9 rows) are
    // shown side by side, thirds (6 rows, under AUTO_ZOOM_CELLS' 6 plus 2 of chrome) would zoom the view.
    const t = make(['L'])
    t.sizes.set('L', { cols: 100, rows: 20 })
    expect(t.open('B', 'L', 'down')).toBe(true)
    expect(t.open('C', 'B', 'down')).toBe(false)
    expect(t.shape()).toEqual([['L', 'B']])
    // No tab of the group has a size (a window no view has measured): nothing to check against, placed.
    const blind = make(['a'])
    expect(blind.open('b', 'a', 'down')).toBe(true)
    expect(blind.open('c', 'b', 'down')).toBe(true)
  })

  it('never reads a tab outside the anchor’s group: a hidden tab keeps its size after the window changed', () => {
    // H is a plain tab the view does not show: it kept 100 x 8 from before the window grew, and its place never
    // changed, so nothing marks the size old. The plain anchor p has no size yet: no check, placed (H's 8 rows would
    // have refused halves that fit), and the same in the other direction (H's 40 rows would have passed a short window).
    const t = make(['H', 'p'])
    t.sizes.set('H', { cols: 100, rows: 8 })
    expect(t.open('q', 'p', 'down')).toBe(true)
    expect(t.shape()).toEqual([['p', 'q']])
  })
})

describe('page tabs are panes (design-split-pages.md)', () => {
  /** A TabGroups with TabManager's kinds: `pg` is a plugin's page tab, the rest terminal tabs. */
  function withPage(initial: Record<string, string[]> = { p: ['a', 'pg', 'b'] }) {
    const orders = new Map(Object.entries(initial).map(([k, v]) => [k, [...v]]))
    const published: GroupsSnapshot[] = []
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      kindOf: (p, id) => ((orders.get(p) ?? []).includes(id) ? (id === 'pg' ? 'page' : 'shell') : undefined),
      setOrder: (p, ids) => {
        orders.set(p, [...ids])
      },
      publish: (_p, snapshot) => published.push(structuredClone(snapshot)),
      changed: () => {},
      log: () => {}
    })
    return { groups, orders, published }
  }

  it('places a page tab as the tab placed and as the anchor', () => {
    const t = withPage()
    expect(t.groups.place('p', { tabId: 'pg', at: 'a', edge: 'right' }).ok).toBe(true)
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['a', 'pg'])
    const u = withPage()
    expect(u.groups.place('p', { tabId: 'a', at: 'pg', edge: 'down' }).ok).toBe(true)
    expect(members(u.groups.groupsOf('p')[0]).sort()).toEqual(['a', 'pg'])
    // An unknown or foreign id is still the one `unknown-tab` refusal.
    expect(refusalOf(u.groups.place('p', { tabId: 'zz', at: 'a', edge: 'right' }))).toBe('unknown-tab')
  })

  it('a split beside a page tab (tabs.create, a plugin’s beside) places the new tab', () => {
    const t = withPage()
    const { placed } = t.groups.createBeside('p', { tabId: 'pg', edge: 'right' }, () => {
      t.orders.get('p')!.push('n')
      return { id: 'n' }
    })
    expect(placed).toBe(true)
    expect(members(t.groups.groupsOf('p')[0]).sort()).toEqual(['n', 'pg'])
  })

  it('a plugin beside naming a page tab places with the halves check skipped (no size)', () => {
    const t = withPage()
    const { placed } = t.groups.createBeside('p', { tabId: 'pg', edge: 'right' }, () => {
      t.orders.get('p')!.push('n')
      return { id: 'n' }
    }, { plugin: true })
    expect(placed).toBe(true)
  })

  it('a restored group maps page leaves through the id map', () => {
    const t = withPage({ p: ['n1', 'pg', 'n2'] })
    const saved = [{ root: { dir: 'row', children: [{ tab: 's1' }, { tab: 'sp' }, { tab: 's2' }] } }]
    t.groups.restore('p', saved, new Map([['s1', 'n1'], ['sp', 'pg'], ['s2', 'n2']]))
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['n1', 'pg', 'n2'])
  })

  it('a dropped or later page tab prunes its leaf; a two-pane group dissolves', () => {
    const t = withPage({ p: ['n1', 'n2'] })
    const saved = [{ root: { dir: 'row', children: [{ tab: 's1' }, { tab: 'sp' }, { tab: 's2' }] } }]
    t.groups.restore('p', saved, new Map([['s1', 'n1'], ['s2', 'n2']]))
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['n1', 'n2'])
    const u = withPage({ p: ['n1'] })
    u.groups.restore('p', [{ root: { dir: 'row', children: [{ tab: 's1' }, { tab: 'sp' }] } }], new Map([['s1', 'n1']]))
    expect(u.groups.groupsOf('p')).toEqual([])
  })

  it('joinOrder lists the selected tab and terminal members only', () => {
    const t = withPage({ p: ['a', 'pg', 'b'] })
    t.groups.place('p', { tabId: 'pg', at: 'a', edge: 'right' })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'down' })
    expect(t.groups.joinOrder('p', 'a')).toEqual(['a', 'b'])
    // Selected a page tab: it comes first, its terminal siblings follow.
    expect(t.groups.joinOrder('p', 'pg')).toEqual(['pg', 'a', 'b'])
  })

})

describe('a plugin’s beside judged by each view’s own zoom rule (groups.area, shared/pane-zoom.ts)', () => {
  const make = (order: string[], server = false) => {
    const orders = new Map([['p', [...order]]])
    const sizes = new Map<string, { cols: number; rows: number }>()
    const groups = new TabGroups({
      order: (p) => [...(orders.get(p) ?? [])],
      setOrder: (p, ids) => void orders.set(p, [...ids]),
      publish: () => {},
      changed: () => {},
      sizeOf: (_p, t) => sizes.get(t),
      pluginPanes: () => 8,
      // Server mode: the hidden page (a desktop view id) never counts.
      ...(server ? { measured: (viewId: string) => viewId.startsWith('web:') } : {}),
      log: () => {}
    })
    const open = (id: string, at: string, edge: 'right' | 'down'): boolean =>
      groups.createBeside(
        'p',
        { tabId: at, edge },
        () => {
          orders.get('p')!.push(id)
          return { id }
        },
        { plugin: true, pluginId: 'bronos.team' }
      ).placed
    const area = (viewId: string, width: number, height: number, cw: number, ch: number): void =>
      groups.viewArea('p', viewId as never, { area: { width, height }, cell: { width: cw, height: ch } })
    const shape = () => groups.groupsOf('p').map((g) => leavesOf(g.root))
    return { groups, sizes, open, area, shape }
  }

  it('near the 40-column boundary: a third pane that zooms is refused, a plain tab’s first split that shows is placed', () => {
    // 720 x 400 px, 8 x 16 cells: halves hold 40 columns (shown), thirds 25 (zoomed). The anchor reports 41 columns.
    const t = make(['L', 'B'])
    t.groups.place('p', { tabId: 'B', at: 'L', edge: 'right' })
    t.sizes.set('L', { cols: 41, rows: 22 })
    t.sizes.set('B', { cols: 41, rows: 22 })
    t.area('web:1', 720, 400, 8, 16)
    expect(t.open('C', 'B', 'right')).toBe(false)
    // A plain tab in the same area (85 columns): halves of 40 show, placed. The cell model refused it (42 < 40 + 4).
    const plain = make(['L'])
    plain.sizes.set('L', { cols: 85, rows: 22 })
    plain.area('desktop:1', 720, 400, 8, 16)
    expect(plain.open('N', 'L', 'right')).toBe(true)
    // The view gone, no geometry left: the cell model's fallback decides again, and refuses it.
    const gone = make(['L'])
    gone.sizes.set('L', { cols: 85, rows: 22 })
    gone.area('desktop:1', 720, 400, 8, 16)
    gone.groups.viewGone('desktop:1' as never)
    expect(gone.open('N', 'L', 'right')).toBe(false)
  })

  it('tiny fonts: a split down that leaves 5 rows in the view is refused', () => {
    // 1000 x 160 px with 4 x 8 cells: the halves hold (80 - 39) / 8 = 5 rows, under 6.
    const t = make(['L'])
    t.sizes.set('L', { cols: 241, rows: 15 })
    t.area('desktop:1', 1000, 160, 4, 8)
    expect(t.open('N', 'L', 'down')).toBe(false)
    expect(t.shape()).toEqual([])
  })

  it('dragged shares: a pane under 20x5 at the shared sizes zooms the view, refused', () => {
    // 1840 x 800 px, 8 x 16 cells: L | [X over Y] at [0.8, 0.2]. X is 368 px wide (41 columns); split right, its halves
    // get 18 columns at these shares, and the view zooms on the 20x5 branch although evened it would show.
    const t = make(['L', 'X', 'Y'])
    t.groups.place('p', { tabId: 'X', at: 'L', edge: 'right' })
    t.groups.place('p', { tabId: 'Y', at: 'X', edge: 'down' })
    const g = t.groups.groupsOf('p')[0]!
    expect(refusalOf(t.groups.resize('p', g.id, (g.root as { id: string }).id, [0.8, 0.2]))).toBeUndefined()
    t.sizes.set('L', { cols: 179, rows: 46 })
    t.sizes.set('X', { cols: 41, rows: 22 })
    t.sizes.set('Y', { cols: 41, rows: 22 })
    t.area('web:1', 1840, 800, 8, 16)
    expect(t.open('N', 'X', 'right')).toBe(false)
  })

  it('a view already zoomed before is no reason; any other view that would start zooming is', () => {
    // A remote phone (300 px: 33 columns) is too small for any split: it does not count for a plain anchor. The
    // desktop shows the halves. Placed.
    const t = make(['L'])
    t.sizes.set('L', { cols: 195, rows: 52 })
    t.area('web:8', 300, 500, 8, 16)
    t.area('desktop:1', 1600, 900, 8, 16)
    expect(t.open('N', 'L', 'right')).toBe(true)
    // A third view that shows the halves but would zoom the thirds (720 px): refused.
    t.sizes.set('N', { cols: 97, rows: 52 })
    t.area('web:9', 720, 400, 8, 16)
    expect(t.open('M', 'N', 'right')).toBe(false)
    expect(t.shape()).toEqual([['L', 'N']])
  })

  it('ignores geometry of a view that does not count (the server’s hidden page) and drops a malformed report', () => {
    // 720 x 200 px would zoom halves; reported by the hidden page, it does not count and the cell model places them.
    const hidden = make(['L'], true)
    hidden.sizes.set('L', { cols: 85, rows: 40 })
    hidden.area('desktop:1', 720, 200, 8, 16)
    expect(hidden.open('N', 'L', 'down')).toBe(true)
    // A malformed report forgets what the view said before.
    const m = make(['L'])
    m.sizes.set('L', { cols: 85, rows: 40 })
    m.area('desktop:1', 720, 200, 8, 16)
    m.groups.viewArea('p', 'desktop:1' as never, undefined)
    expect(m.open('N', 'L', 'down')).toBe(true)
    // Kept, it refuses.
    const k = make(['L'])
    k.sizes.set('L', { cols: 85, rows: 40 })
    k.area('desktop:1', 720, 200, 8, 16)
    expect(k.open('N', 'L', 'down')).toBe(false)
  })

  it('a plain anchor: a local view is strict (the page never zooms a plain tab), a remote one counts only if it can show a split', () => {
    // The desktop at 300 px shows the plain tab whole (no zoom for a plain tab) and would zoom the halves: refused.
    const narrow = make(['L'])
    narrow.area('desktop:1', 300, 500, 8, 16)
    expect(narrow.open('N', 'L', 'right')).toBe(false)
    // A remote phone that would zoom any split, beside a wide desktop: the desktop decides, placed.
    const phone = make(['L'])
    phone.area('web:7', 300, 500, 8, 16)
    phone.area('desktop:1', 1600, 900, 8, 16)
    expect(phone.open('N', 'L', 'right')).toBe(true)
    // The same phone with a desktop that would zoom the halves (600 px: 33 columns each): refused by the desktop.
    const both = make(['L'])
    both.area('web:7', 300, 500, 8, 16)
    both.area('desktop:1', 600, 900, 8, 16)
    expect(both.open('N', 'L', 'right')).toBe(false)
    // A remote view alone that shows the plain tab and would zoom the halves is ignored for a plain anchor.
    const remote = make(['L'])
    remote.area('web:7', 600, 900, 8, 16)
    expect(remote.open('N', 'L', 'right')).toBe(true)
    // Only an ignored phone has reported (the desktop not yet): nothing judged by geometry, so the cell model still
    // checks the desktop's 70 columns, whose halves (34) it would zoom: refused, as with no report at all.
    const early = make(['L'])
    early.sizes.set('L', { cols: 70, rows: 30 })
    expect(early.open('N', 'L', 'right')).toBe(false)
    const early2 = make(['L'])
    early2.sizes.set('L', { cols: 70, rows: 30 })
    early2.area('web:7', 300, 500, 8, 16)
    expect(early2.open('N', 'L', 'right')).toBe(false)
  })
})
