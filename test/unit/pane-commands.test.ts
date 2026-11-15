import { describe, expect, it } from 'vitest'
import type { GroupsReply, TabInfo } from '../../src/shared/ipc'
import { paneView } from '../../src/renderer/state/groups-state'
import { initialTabsState, tabsReducer, type TabsAction, type TabsState } from '../../src/renderer/state/tabs-store'
import { paneCommandHandlers, refusalText } from '../../src/renderer/tabs/pane-commands'
import { groupTitle, handleWords, leftSegment, stripRuns } from '../../src/renderer/tabs/strip-groups'
import { isPaneKind, type PaneNode, type PaneSplit, type PlaceIntent, type TabGroup } from '../../src/shared/tab-groups'

const tab = (id: string): TabInfo => ({ id, kind: 'shell', cwd: '/w', gen: 1 })
const leaf = (t: string): PaneNode => ({ tab: t })
const row = (id: string, ...children: PaneNode[]): PaneSplit => ({ id, dir: 'row', children, sizes: children.map(() => 1 / children.length) })
const col = (id: string, ...children: PaneNode[]): PaneSplit => ({ id, dir: 'column', children, sizes: children.map(() => 1 / children.length) })

// row[ b | column[ c / d ] ], plus a plain tab a.
const G: TabGroup = { id: 'g', root: row('s1', leaf('b'), col('s2', leaf('c'), leaf('d'))) }

/** A context over a real reducer, recording what would go to main. */
function harness(selected: string, extra: TabsAction[] = [], auto = false) {
  let state: TabsState = [
    { type: 'loaded', tabs: ['a', 'b', 'c', 'd'].map(tab) } as TabsAction,
    { type: 'groups', snapshot: { seq: 1, order: ['a', 'b', 'c', 'd'], groups: [G] } } as TabsAction,
    { type: 'selected', tabId: selected } as TabsAction,
    ...extra
  ].reduce(tabsReducer, initialTabsState)
  const sent: Array<[string, unknown]> = []
  const intents: Array<[string, string]> = []
  const reports: string[] = []
  const ok = (): Promise<GroupsReply> => Promise.resolve({ ok: true, seq: 2 })
  const handlers = paneCommandHandlers({
    state: () => state,
    view: () => paneView(state.groups, state.activeId, state.zoomed, () => auto),
    dispatch: (a) => {
      state = tabsReducer(state, a)
    },
    place: (i: PlaceIntent) => (sent.push(['place', i]), ok()),
    remove: (tabId) => (sent.push(['remove', tabId]), ok()),
    dissolve: (groupId) => (sent.push(['dissolve', groupId]), ok()),
    resize: (groupId, splitId, sizes) => (sent.push(['resize', { groupId, splitId, sizes }]), ok()),
    intend: (tabId, intent) => intents.push([tabId, intent]),
    openSplit: (edge) => sent.push(['split', edge]),
    openBeside: (edge) => sent.push(['beside', edge]),
    minShare: () => 0.1,
    report: (m) => reports.push(m)
  })
  return { handlers, sent, intents, reports, state: () => state }
}

describe('pane commands', () => {
  it('moves the focus to the spatial neighbour, no wrap', () => {
    const h = harness('b')
    h.handlers['pane.focusRight']!()
    expect(h.state().activeId).toBe('c')
    h.handlers['pane.focusDown']!()
    expect(h.state().activeId).toBe('d')
    h.handlers['pane.focusLeft']!()
    expect(h.state().activeId).toBe('b')
    // At the group's edge: nothing.
    h.handlers['pane.focusLeft']!()
    expect(h.state().activeId).toBe('b')
    expect(h.sent).toEqual([])
  })

  it('a focus chord turns the keys back on after D3 took them off', () => {
    const h = harness('c', [{ type: 'removed', tabId: 'c', gen: 1 }])
    expect(h.state().keysOff).toBe(true)
    const focused = h.state().activeId
    // At an edge with no neighbour: the same pane gets the keys back.
    h.handlers['pane.focusRight']!()
    expect(h.state().keysOff).toBe(false)
    expect(h.state().activeId).toBe(focused)
  })

  it('zoom toggles per view; a focus chord unzooms first; not while auto-zoomed', async () => {
    const h = harness('c')
    h.handlers['pane.zoom']!()
    expect(h.state().zoomed).toEqual({ g: 'c' })
    h.handlers['pane.zoom']!()
    expect(h.state().zoomed).toEqual({})
    h.handlers['pane.zoom']!()
    h.handlers['pane.focusLeft']!()
    expect(h.state().zoomed).toEqual({})
    expect(h.state().activeId).toBe('b')
    const narrow = harness('c', [], true)
    narrow.handlers['pane.zoom']!()
    expect(narrow.state().zoomed).toEqual({})
    expect(narrow.reports).toHaveLength(1)
  })

  it('move out marks the leave and asks main; nothing for a plain tab', () => {
    const h = harness('d')
    h.handlers['pane.moveOut']!()
    expect(h.intents).toEqual([['d', 'leave']])
    expect(h.sent).toEqual([['remove', 'd']])
    const p = harness('a')
    p.handlers['pane.moveOut']!()
    expect(p.sent).toEqual([])
  })

  it('resize sends one resize of the nearest split; none while zoomed', () => {
    const h = harness('b')
    h.handlers['pane.resizeRight']!()
    expect(h.sent).toEqual([['resize', { groupId: 'g', splitId: 's1', sizes: [expect.closeTo(0.55, 9), expect.closeTo(0.45, 9)] }]])
    const z = harness('b', [{ type: 'zoom', groupId: 'g', tabId: 'b' }])
    z.handlers['pane.resizeRight']!()
    expect(z.sent).toEqual([])
  })

  it('move pane places it past its neighbour, marked stay', () => {
    const h = harness('b')
    h.handlers['pane.moveRight']!()
    expect(h.intents).toEqual([['b', 'stay']])
    expect(h.sent).toEqual([['place', { tabId: 'b', at: 'c', edge: 'right' }]])
  })

  it('equalize sends one resize per uneven split (D16); ungroup dissolves', () => {
    const uneven: TabGroup = { id: 'g', root: { ...G.root, sizes: [0.7, 0.3] } }
    const h = harness('b', [{ type: 'groups', snapshot: { seq: 2, order: ['a', 'b', 'c', 'd'], groups: [uneven] } }])
    h.handlers['pane.equalize']!()
    expect(h.sent).toEqual([['resize', { groupId: 'g', splitId: 's1', sizes: [0.5, 0.5] }]])
    h.handlers['pane.ungroup']!()
    expect(h.sent.at(-1)).toEqual(['dissolve', 'g'])
  })

  describe('D23 R1: keys off, commands on the focused pane do nothing', () => {
    // c closed in another view: the view shows d (the pane that took c's space) with the keys off.
    const off = () => {
      const h = harness('c', [{ type: 'removed', tabId: 'c', gen: 1 }])
      expect(h.state().keysOff).toBe(true)
      return h
    }
    it.each([
      ['split', ['pane.splitRight', 'pane.splitDown']],
      ['show beside', ['pane.showBesideRight', 'pane.showBesideDown']],
      ['move out', ['pane.moveOut']],
      ['zoom', ['pane.zoom']],
      ['resize', ['pane.resizeLeft', 'pane.resizeRight', 'pane.resizeUp', 'pane.resizeDown']],
      ['move', ['pane.moveLeft', 'pane.moveRight', 'pane.moveUp', 'pane.moveDown']]
    ])('%s', (_family, names) => {
      const h = off()
      const before = h.state()
      for (const n of names) h.handlers[n]!()
      expect(h.sent).toEqual([])
      expect(h.intents).toEqual([])
      expect(h.state()).toBe(before)
    })
    it('the same commands act once the keys are back on', () => {
      const h = off()
      h.handlers['pane.focusUp']!()
      expect(h.state().keysOff).toBe(false)
      h.handlers['pane.zoom']!()
      expect(Object.keys(h.state().zoomed)).toEqual(['g'])
    })
  })

  it('tells the person what a refusal means', () => {
    expect(refusalText('full')).toMatch(/8 panes/)
    expect(refusalText('too-many-groups')).toMatch(/32/)
    expect(refusalText('not-a-pane')).toMatch(/page tab/)
  })

  it('only terminal kinds may be panes: a page tab never is', () => {
    expect(['claude', 'shell', 'command', 'page'].map(isPaneKind)).toEqual([true, true, true, true])
    expect(isPaneKind('overlay')).toBe(false)
    expect(isPaneKind(undefined)).toBe(false)
  })
})

describe('strip groups', () => {
  it('segments the strip by group, members contiguous', () => {
    const runs = stripRuns(['a', 'b', 'c', 'd'].map(tab), [G])
    expect(runs.map((r) => [r.group?.id, r.tabs.map((t) => t.id)])).toEqual([
      [undefined, ['a']],
      ['g', ['b', 'c', 'd']]
    ])
    // Not contiguous for a moment: one segment per run.
    expect(stripRuns(['b', 'a', 'c'].map(tab), [G]).length).toBe(3)
  })

  it('says zoom, pane count and every asking member in words', () => {
    const status = (id: string) => (id === 'd' ? ('needs-permission' as const) : undefined)
    const w = handleWords({ ...G, name: 'dev' }, { zoomTab: 'b', auto: false }, status, (id) => `tab ${id}`)
    expect(w.text).toBe('dev')
    expect(w.zoomText).toBe('zoomed (2 hidden)')
    expect(w.label).toBe('Group dev, 3 tabs, zoomed')
    expect(w.asks).toBe('tab d needs permission')
    expect(handleWords(G, undefined, () => undefined, (id) => id).label).toBe('Group unnamed, 3 tabs')
    expect(handleWords(G, undefined, () => undefined, (id) => id).zoomText).toBeUndefined()
    expect(groupTitle(G)).toBe('Split')
  })

  it('a member dropped outside its segment leaves it', () => {
    expect(leftSegment({ left: 100, right: 300 }, 50)).toBe(true)
    expect(leftSegment({ left: 100, right: 300 }, 200)).toBe(false)
    expect(leftSegment({ left: 100, right: 300 }, 301)).toBe(true)
  })
})
