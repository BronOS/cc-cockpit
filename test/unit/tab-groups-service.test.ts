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

describe('page tabs are never panes (design.md §3 "Split groups", §4 "Page tabs")', () => {
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

  it('refuses a page tab as the tab placed and as the anchor, changing nothing', () => {
    const t = withPage()
    expect(t.groups.place('p', { tabId: 'pg', at: 'a', edge: 'right' })).toEqual({ ok: false, reason: 'not-a-pane' })
    expect(t.groups.place('p', { tabId: 'a', at: 'pg', edge: 'down' })).toEqual({ ok: false, reason: 'not-a-pane' })
    expect(t.published).toEqual([])
    expect(t.groups.groupsOf('p')).toEqual([])
    // An unknown or foreign id is still the one `unknown-tab` refusal.
    expect(refusalOf(t.groups.place('p', { tabId: 'zz', at: 'a', edge: 'right' }))).toBe('unknown-tab')
    // The terminal tabs around it still group, and the page tab is moved out of their block.
    expect(t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' }).ok).toBe(true)
    expect(t.orders.get('p')).toEqual(['a', 'b', 'pg'])
  })

  it('a split beside a page tab (tabs.create, a plugin’s beside) opens the new tab plain', () => {
    const t = withPage()
    const { placed } = t.groups.createBeside('p', { tabId: 'pg', edge: 'right' }, () => {
      t.orders.get('p')!.push('n')
      return { id: 'n' }
    })
    expect(placed).toBe(false)
    expect(t.groups.groupsOf('p')).toEqual([])
  })

  it('a restored group naming a page tab drops that leaf (a damaged or hand-edited record)', () => {
    const t = withPage({ p: ['n1', 'pg', 'n2'] })
    const saved = [{ root: { dir: 'row', children: [{ tab: 's1' }, { tab: 'sp' }, { tab: 's2' }] } }]
    t.groups.restore('p', saved, new Map([['s1', 'n1'], ['sp', 'pg'], ['s2', 'n2']]))
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['n1', 'n2'])
    // A two-pane group with a page tab in it is no group at all.
    const u = withPage({ p: ['n1', 'pg'] })
    u.groups.restore('p', [{ root: { dir: 'row', children: [{ tab: 's1' }, { tab: 'sp' }] } }], new Map([['s1', 'n1'], ['sp', 'pg']]))
    expect(u.groups.groupsOf('p')).toEqual([])
  })

  it('a page tab dropped on a group’s segment lands after the group, as any plain tab', () => {
    const t = withPage({ p: ['a', 'b', 'pg'] })
    t.groups.place('p', { tabId: 'b', at: 'a', edge: 'right' })
    t.groups.reorder('p', 'pg', 1)
    expect(t.orders.get('p')).toEqual(['a', 'b', 'pg'])
    expect(members(t.groups.groupsOf('p')[0])).toEqual(['a', 'b'])
  })
})
