import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../../src/shared/ipc'
import { applyOrder, ignoresMainSelect, keepContiguous, selectionAfterSnapshot } from '../../src/renderer/state/groups-state'
import { initialTabsState, tabsReducer, type TabsAction, type TabsState } from '../../src/renderer/state/tabs-store'
import type { GroupsSnapshot, PaneNode, PaneSplit, TabGroup } from '../../src/shared/tab-groups'

// The split view's part of the page's tab state: snapshots by seq, the order, zoom, the remembered
// focus and D3's keys-off rule. The drawing is covered end to end (task 05).

const tab = (id: string): TabInfo => ({ id, kind: 'shell', cwd: '/w', gen: 1 })
const leaf = (t: string): PaneNode => ({ tab: t })
const row = (id: string, ...children: PaneNode[]): PaneSplit => ({ id, dir: 'row', children, sizes: children.map(() => 1 / children.length) })
const col = (id: string, ...children: PaneNode[]): PaneSplit => ({ id, dir: 'column', children, sizes: children.map(() => 1 / children.length) })
const snap = (seq: number, order: string[], groups: TabGroup[]): GroupsSnapshot => ({ seq, order, groups })
const run = (actions: TabsAction[], from: TabsState = initialTabsState): TabsState => actions.reduce(tabsReducer, from)
const ids = (s: TabsState): string[] => s.tabs.map((t) => t.id)

/** Tabs a b c d loaded, `a` selected; group g = row[b | column[c / d]]. */
const base = (): TabsState =>
  run([
    { type: 'loaded', tabs: ['a', 'b', 'c', 'd'].map(tab) },
    { type: 'groups', snapshot: snap(1, ['a', 'b', 'c', 'd'], [{ id: 'g', root: row('s1', leaf('b'), col('s2', leaf('c'), leaf('d'))) }]) }
  ])

describe('tabs store: groups', () => {
  it('applies snapshots by seq and drops older ones', () => {
    const s = base()
    expect(s.groupsSeq).toBe(1)
    const older = run([{ type: 'groups', snapshot: snap(0, ['d', 'c', 'b', 'a'], []) }], s)
    expect(older).toBe(s)
    const same = run([{ type: 'groups', snapshot: snap(1, ['d', 'c', 'b', 'a'], []) }], s)
    expect(same).toBe(s)
    const newer = run([{ type: 'groups', snapshot: snap(2, ['d', 'c', 'b', 'a'], []) }], s)
    expect(newer.groups).toEqual([])
    expect(ids(newer)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('keeps a tab main has not named in the order after its neighbour', () => {
    expect(applyOrder(['a', 'x', 'b'].map(tab), ['b', 'a']).map((t) => t.id)).toEqual(['b', 'a', 'x'])
    expect(applyOrder(['x', 'a', 'b'].map(tab), ['b', 'a']).map((t) => t.id)).toEqual(['x', 'b', 'a'])
  })

  it('puts a split tab that arrives after its snapshot into its block', () => {
    // main placed e right of a (a new group) and said so before the create reply came.
    const s = run(
      [
        { type: 'groups', snapshot: snap(2, ['a', 'e', 'b', 'c', 'd'], [{ id: 'h', root: row('s3', leaf('a'), leaf('e')) }]) },
        { type: 'added', tab: tab('e') }
      ],
      run([{ type: 'loaded', tabs: ['a', 'b', 'c', 'd'].map(tab) }])
    )
    expect(ids(s)).toEqual(['a', 'e', 'b', 'c', 'd'])
    expect(s.activeId).toBe('e')
    expect(keepContiguous(['a', 'b', 'e'].map(tab), s.groups).map((t) => t.id)).toEqual(['a', 'e', 'b'])
  })

  it('remembers the last focused pane of each group', () => {
    const s = run([{ type: 'selected', tabId: 'c' }, { type: 'selected', tabId: 'a' }], base())
    expect(s.lastFocus).toEqual({ g: 'c' })
  })

  it('zooms per view; selecting a hidden member unzooms first', () => {
    const z = run([{ type: 'selected', tabId: 'c' }, { type: 'zoom', groupId: 'g', tabId: 'c' }], base())
    expect(z.zoomed).toEqual({ g: 'c' })
    // A pane not in the group, or an unknown group: nothing.
    expect(run([{ type: 'zoom', groupId: 'g', tabId: 'a' }], z)).toBe(z)
    expect(run([{ type: 'zoom', groupId: 'nope', tabId: 'c' }], z)).toBe(z)
    // Selecting the zoomed pane keeps the zoom; a hidden one unzooms.
    expect(run([{ type: 'selected', tabId: 'c' }], z).zoomed).toEqual({ g: 'c' })
    expect(run([{ type: 'selected', tabId: 'b' }], z).zoomed).toEqual({})
    // Another tab entirely: the group's zoom waits for the person's return.
    expect(run([{ type: 'selected', tabId: 'a' }], z).zoomed).toEqual({ g: 'c' })
    expect(run([{ type: 'zoom', groupId: 'g', tabId: null }], z).zoomed).toEqual({})
  })

  it('drops a zoom whose pane left the group', () => {
    const z = run([{ type: 'zoom', groupId: 'g', tabId: 'c' }], base())
    const s = run([{ type: 'groups', snapshot: snap(2, ['a', 'b', 'd', 'c'], [{ id: 'g', root: row('s1', leaf('b'), leaf('d')) }]) }], z)
    expect(s.zoomed).toEqual({})
  })

  describe('D3: the focused pane leaves', () => {
    it('own close: the pane that took its space, keys on', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'closed', tabId: 'c', own: true }], base())
      expect(s.activeId).toBe('d')
      expect(s.keysOff).toBe(false)
      // The leaf left this view's copy at once (no "starting" pane for a closed tab).
      expect(s.groups[0]!.root).toEqual(expect.objectContaining({ children: [leaf('b'), leaf('d')] }))
    })

    it('a close from elsewhere: same pane, keys off until a click or a chord', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'removed', tabId: 'c', gen: 1 }], base())
      expect(s.activeId).toBe('d')
      expect(s.keysOff).toBe(true)
      expect(run([{ type: 'keysOn' }], s).keysOff).toBe(false)
      // A selection (a click on a pane, the strip) turns them on too.
      expect(run([{ type: 'selected', tabId: 'd' }], s).keysOff).toBe(false)
    })

    // The final review's MAJOR: a frame the focus check refused leaves the keys on nothing, and the
    // view goes keys off with the selection kept, marked as the refusal's kind (a frame clicked into
    // with evidence may pick, frame-focus.ts). D3's kind is never turned into it, and a D3 change
    // after a refusal makes the keys off D3's.
    it("a refused frame focus: keys off, selection kept, the refusal's kind until the keys come back", () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'focusRefused' }], base())
      expect([s.activeId, s.keysOff, s.focusRefused]).toEqual(['c', true, true])
      expect(run([{ type: 'selected', tabId: 'b' }], s)).toMatchObject({ activeId: 'b', keysOff: false, focusRefused: false })
      expect(run([{ type: 'keysOn' }], s)).toMatchObject({ activeId: 'c', keysOff: false, focusRefused: false })
      expect(run([{ type: 'selected', tabId: 'c' }], s)).toMatchObject({ activeId: 'c', keysOff: false, focusRefused: false })
      // The focused pane closed elsewhere after the refusal: D3's keys off from then on.
      expect(run([{ type: 'removed', tabId: 'c', gen: 1 }], s)).toMatchObject({ activeId: 'd', keysOff: true, focusRefused: false })
      // Already keys off by D3: a refusal changes nothing.
      const d3 = run([{ type: 'selected', tabId: 'c' }, { type: 'removed', tabId: 'c', gen: 1 }], base())
      expect(run([{ type: 'focusRefused' }], d3)).toBe(d3)
      // No tab at all: nothing to take the keys from.
      expect(run([{ type: 'focusRefused' }], initialTabsState)).toBe(initialTabsState)
    })

    // The D3 exception: main's `tabs.exitFocus` (the person ended the pane with their own keys here).
    it('exitFocus after the pane went: the named pane of the shown group, keys on', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'removed', tabId: 'c', gen: 1 }], base())
      expect([s.activeId, s.keysOff]).toEqual(['d', true])
      expect(run([{ type: 'exitFocus', tabId: 'b', closed: 'c' }], s)).toMatchObject({ activeId: 'b', keysOff: false })
      // The pane that took its space is named: keys on there.
      expect(run([{ type: 'exitFocus', tabId: 'd', closed: 'c' }], s)).toMatchObject({ activeId: 'd', keysOff: false })
      // Not of the shown group, unknown, or the closed tab still held: nothing.
      expect(run([{ type: 'exitFocus', tabId: 'a', closed: 'c' }], s)).toBe(s)
      expect(run([{ type: 'exitFocus', tabId: 'zz', closed: 'c' }], s)).toBe(s)
      const held = run([{ type: 'selected', tabId: 'c' }], base())
      expect(run([{ type: 'exitFocus', tabId: 'b', closed: 'c' }], held)).toBe(held)
      // The person acted since (keys on): theirs stays.
      const acted = run([{ type: 'keysOn' }], s)
      expect(run([{ type: 'exitFocus', tabId: 'b', closed: 'c' }], acted)).toBe(acted)
    })

    it('exitFocus after a dissolve: the tab left plain', () => {
      const two = run([
        { type: 'loaded', tabs: ['a', 'b', 'c'].map(tab) },
        { type: 'groups', snapshot: snap(1, ['a', 'b', 'c'], [{ id: 'g', root: row('s1', leaf('b'), leaf('c')) }]) },
        { type: 'selected', tabId: 'c' },
        { type: 'groups', snapshot: snap(2, ['a', 'b'], []) },
        { type: 'removed', tabId: 'c', gen: 1 }
      ])
      expect([two.activeId, two.keysOff]).toEqual(['b', true])
      expect(run([{ type: 'exitFocus', tabId: 'b', closed: 'c' }], two)).toMatchObject({ activeId: 'b', keysOff: false })
      expect(run([{ type: 'exitFocus', tabId: 'a', closed: 'c' }], two)).toBe(two)
    })

    it('a plain tab closed elsewhere keeps the strip rule', () => {
      const s = run([{ type: 'removed', tabId: 'a', gen: 1 }], base())
      expect(s.activeId).toBe('b')
      expect(s.keysOff).toBe(false)
    })

    it('D24: moved out elsewhere: the same tab, now plain, keys off', () => {
      const s = run(
        [
          { type: 'selected', tabId: 'b' },
          { type: 'groups', snapshot: snap(2, ['a', 'c', 'd', 'b'], [{ id: 'g', root: col('s2', leaf('c'), leaf('d')) }]) }
        ],
        base()
      )
      expect(s.activeId).toBe('b')
      expect(s.keysOff).toBe(true)
    })

    it('D24: moved into another group elsewhere: what is left of the old group, keys off', () => {
      const s = run(
        [
          { type: 'selected', tabId: 'b' },
          {
            type: 'groups',
            snapshot: snap(2, ['a', 'b', 'c', 'd'], [
              { id: 'g', root: col('s2', leaf('c'), leaf('d')) },
              { id: 'h', root: row('s4', leaf('a'), leaf('b')) }
            ])
          }
        ],
        base()
      )
      expect(['c', 'd']).toContain(s.activeId)
      expect(s.keysOff).toBe(true)
    })

    it('own move out: the pane that took its space, keys on', () => {
      const s = run(
        [
          { type: 'selected', tabId: 'b' },
          {
            type: 'groups',
            snapshot: snap(2, ['a', 'c', 'd', 'b'], [{ id: 'g', root: col('s2', leaf('c'), leaf('d')) }]),
            intent: { b: 'leave' }
          }
        ],
        base()
      )
      expect(['c', 'd']).toContain(s.activeId)
      expect(s.keysOff).toBe(false)
    })

    it('own placement elsewhere in the group tree: stays on the tab', () => {
      const s = run(
        [
          { type: 'selected', tabId: 'b' },
          {
            type: 'groups',
            snapshot: snap(2, ['a', 'b', 'c', 'd'], [
              { id: 'g', root: col('s2', leaf('c'), leaf('d')) },
              { id: 'h', root: row('s4', leaf('a'), leaf('b')) }
            ]),
            intent: { b: 'stay' }
          }
        ],
        base()
      )
      expect(s.activeId).toBe('b')
      expect(s.keysOff).toBe(false)
    })

    it('a snapshot that beats the close event: the pane that took its space, keys off', () => {
      const s = run(
        [
          { type: 'selected', tabId: 'd' },
          { type: 'groups', snapshot: snap(2, ['a', 'b', 'c'], [{ id: 'g', root: row('s1', leaf('b'), leaf('c')) }]) },
          { type: 'removed', tabId: 'd', gen: 1 }
        ],
        base()
      )
      expect(s.activeId).toBe('c')
      expect(s.keysOff).toBe(true)
    })

    it('D22: a dissolve keeps the same terminal; keys off only when it came from elsewhere', () => {
      const two = run([
        { type: 'loaded', tabs: ['x', 'y'].map(tab) },
        { type: 'groups', snapshot: snap(1, ['x', 'y'], [{ id: 'g', root: row('s', leaf('x'), leaf('y')) }]) },
        { type: 'selected', tabId: 'x' }
      ])
      // Elsewhere (x or y moved out, or an Ungroup: a snapshot cannot tell them apart).
      const elsewhere = run([{ type: 'groups', snapshot: snap(2, ['y', 'x'], []) }], two)
      expect(elsewhere.activeId).toBe('x')
      expect(elsewhere.keysOff).toBe(true)
      // Own Ungroup here.
      const own = run([{ type: 'groups', snapshot: snap(2, ['x', 'y'], []), intent: { x: 'stay' } }], two)
      expect(own.activeId).toBe('x')
      expect(own.keysOff).toBe(false)
      // Own move of the other pane out here.
      const other = run([{ type: 'groups', snapshot: snap(2, ['x', 'y'], []), intent: { y: 'leave' } }], two)
      expect(other.activeId).toBe('x')
      expect(other.keysOff).toBe(false)
      // Own move of this pane out: the one left, keys on.
      const mine = run([{ type: 'groups', snapshot: snap(2, ['y', 'x'], []), intent: { x: 'leave' } }], two)
      expect(mine.activeId).toBe('y')
      expect(mine.keysOff).toBe(false)
    })

    it('D22: an Ungroup elsewhere of a bigger group: same terminal, keys off', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'groups', snapshot: snap(2, ['a', 'b', 'c', 'd'], []) }], base())
      expect(s.activeId).toBe('c')
      expect(s.keysOff).toBe(true)
    })

    it('D24: moved from a two-pane group into another group elsewhere: the tab left behind, keys off', () => {
      const s = run(
        [
          { type: 'loaded', tabs: ['x', 'y', 'z', 'w'].map(tab) },
          {
            type: 'groups',
            snapshot: snap(1, ['x', 'y', 'z', 'w'], [
              { id: 'g', root: row('s', leaf('x'), leaf('y')) },
              { id: 'h', root: row('t', leaf('z'), leaf('w')) }
            ])
          },
          { type: 'selected', tabId: 'x' },
          { type: 'groups', snapshot: snap(2, ['y', 'z', 'w', 'x'], [{ id: 'h', root: row('t', leaf('z'), leaf('w'), leaf('x')) }]) }
        ]
      )
      expect(s.activeId).toBe('y')
      expect(s.keysOff).toBe(true)
    })

    it('D23 R2: while keys are off, main selecting a pane the view shows is ignored', () => {
      expect(ignoresMainSelect(true, ['b', 'd'], 'd')).toBe(true)
      // A tab not on screen is selected as usual; with the keys on, always.
      expect(ignoresMainSelect(true, ['b', 'd'], 'a')).toBe(false)
      expect(ignoresMainSelect(false, ['b', 'd'], 'd')).toBe(false)
    })

    it('own Ungroup keeps the selection on the same terminal, keys on', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'groups', snapshot: snap(2, ['a', 'b', 'c', 'd'], []), intent: { c: 'stay' } }], base())
      expect(s.activeId).toBe('c')
      expect(s.keysOff).toBe(false)
    })
  })

  it('selectionAfterSnapshot leaves a plain or unchanged selection alone', () => {
    const g: TabGroup[] = [{ id: 'g', root: row('s', leaf('x'), leaf('y')) }]
    expect(selectionAfterSnapshot(g, g, ['x', 'y', 'z'], 'z', undefined)).toBeUndefined()
    expect(selectionAfterSnapshot(g, g, ['x', 'y'], 'x', undefined)).toBeUndefined()
    expect(selectionAfterSnapshot(g, [], ['x', 'y'], null, undefined)).toBeUndefined()
    // A two-pane group whose selected tab closed: the one left.
    expect(selectionAfterSnapshot(g, [], ['y'], 'x', undefined)).toEqual({ activeId: 'y', keysOff: true })
  })
})
