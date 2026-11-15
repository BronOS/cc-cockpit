import { describe, expect, it } from 'vitest'
import type { CommandsView, GroupsReply, TabInfo } from '../../src/shared/ipc'
import { paneView } from '../../src/renderer/state/groups-state'
import { initialTabsState, tabsReducer, type TabsAction, type TabsState } from '../../src/renderer/state/tabs-store'
import { activeTabHandlers, inGroupEdge, inGroupHandlers, paneCommandHandlers, refusalText, TOO_SMALL_TO_SPLIT } from '../../src/renderer/tabs/pane-commands'
import { chordTarget } from '../../src/renderer/tabs/frame-focus'
import { TOGGLE_FLAG_COMMAND } from '../../src/shared/tab-flag'
import { groupTitle, handleWords, leftSegment, stripRuns } from '../../src/renderer/tabs/strip-groups'
import { GROUP_CAPS, isPaneKind, type PaneNode, type PaneSplit, type PlaceIntent, type TabGroup } from '../../src/shared/tab-groups'

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
    openSplit: (tabId, edge) => sent.push(['split', { tabId, edge }]),
    openBeside: (tabId, edge) => sent.push(['beside', { tabId, edge }]),
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

  // design-split-pages.md §4 "Chords from a frame name their tab": a chord typed in a page frame runs
  // for that frame's tab. The shell picked it just before, but the state still names the pane the
  // person left (TabsPane's state ref is written in an effect, the chord runs at once).
  describe('a chord from a frame acts on the tab it names, not activeId', () => {
    it('focus moves from the target, not from the stale active pane', () => {
      const h = harness('d')
      h.handlers['pane.focusRight']!({ tabId: 'b' })
      expect(h.state().activeId).toBe('c')
      const u = harness('b')
      u.handlers['pane.focusUp']!({ tabId: 'd' })
      expect(u.state().activeId).toBe('c')
    })

    it('move out, zoom, resize and move act on the target', () => {
      const h = harness('b')
      h.handlers['pane.moveOut']!({ tabId: 'd' })
      expect(h.intents).toEqual([['d', 'leave']])
      expect(h.sent).toEqual([['remove', 'd']])
      const z = harness('b')
      z.handlers['pane.zoom']!({ tabId: 'c' })
      expect(z.state().zoomed).toEqual({ g: 'c' })
      const r = harness('b')
      r.handlers['pane.resizeDown']!({ tabId: 'c' })
      expect(r.sent).toEqual([['resize', { groupId: 'g', splitId: 's2', sizes: [expect.closeTo(0.55, 9), expect.closeTo(0.45, 9)] }]])
      const m = harness('b')
      m.handlers['pane.moveUp']!({ tabId: 'd' })
      expect(m.intents).toEqual([['d', 'stay']])
      expect(m.sent).toEqual([['place', { tabId: 'd', at: 'c', edge: 'up' }]])
    })

    it('split right / down and show beside open at the target', () => {
      const h = harness('b')
      h.handlers['pane.splitRight']!({ tabId: 'c' })
      h.handlers['pane.splitDown']!()
      h.handlers['pane.showBesideDown']!({ tabId: 'd' })
      expect(h.sent).toEqual([
        ['split', { tabId: 'c', edge: 'right' }],
        ['split', { tabId: 'b', edge: 'down' }],
        ['beside', { tabId: 'd', edge: 'down' }]
      ])
    })

    it('a page tab splits and shows beside like any other (no refusal text for it any more)', () => {
      const page: TabInfo = { id: 'p', kind: 'page', cwd: '/w', gen: 1 }
      const h = harness('p', [{ type: 'added', tab: page } as TabsAction])
      h.handlers['pane.splitRight']!({ tabId: 'p' })
      h.handlers['pane.showBesideRight']!({ tabId: 'p' })
      expect(h.sent).toEqual([
        ['split', { tabId: 'p', edge: 'right' }],
        ['beside', { tabId: 'p', edge: 'right' }]
      ])
      expect(h.reports).toEqual([])
    })

    it('Close Tab and the flag act on the target; with no target on activeId; with the keys off on nothing', () => {
      const run = (selected: string, extra: TabsAction[] = []) => {
        const state = [
          { type: 'loaded', tabs: ['a', 'b', 'c', 'd'].map(tab) } as TabsAction,
          { type: 'groups', snapshot: { seq: 1, order: ['a', 'b', 'c', 'd'], groups: [G] } } as TabsAction,
          { type: 'selected', tabId: selected } as TabsAction,
          ...extra
        ].reduce(tabsReducer, initialTabsState)
        const log: string[] = []
        const handlers = activeTabHandlers({ state: () => state, close: (id) => log.push(`close ${id}`), toggleFlag: (id) => log.push(`flag ${id}`) })
        return { handlers, log }
      }
      const h = run('b')
      h.handlers['tab.close']!({ tabId: 'c' })
      h.handlers[TOGGLE_FLAG_COMMAND]!({ tabId: 'd' })
      h.handlers['tab.close']!()
      expect(h.log).toEqual(['close c', 'flag d', 'close b'])
      const off = run('c', [{ type: 'removed', tabId: 'c', gen: 1 }])
      off.handlers['tab.close']!()
      off.handlers[TOGGLE_FLAG_COMMAND]!()
      expect(off.log).toEqual([])
    })

    it("main's chord runs for the frame with the keys, for activeId with no frame, and not at all for a blurred one", () => {
      expect(chordTarget({ tab: 'page-1' })).toEqual({ tabId: 'page-1' })
      expect(chordTarget('none')).toEqual({})
      expect(chordTarget('blurred')).toBeNull()
    })
  })

  it('tells the person what a refusal means', () => {
    expect(refusalText('full')).toMatch(/8 panes/)
    expect(refusalText('too-many-groups')).toMatch(/32/)
    expect(refusalText('not-a-pane')).toMatch(/cannot be a pane/)
  })

  it('every tab kind may be a pane, a page tab included', () => {
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

describe('New tab in Group (inGroupHandlers, design-split-pages.md §4)', () => {
  const table: CommandsView = {
    commands: [
      { id: 'tab.newClaude', title: 'New Claude Tab', source: 'core' },
      { id: 'tab.inGroup.tab.newClaude', title: 'New Claude Tab in Group', source: 'core' },
      { id: 'tab.inGroup.tab.newShell', title: 'New Shell Tab in Group', source: 'core' },
      { id: 'tab.inGroup.tab.newCommand.app.lg', title: 'New tab: lazygit in Group', source: 'tabCommand' },
      { id: 'tab.inGroup.bogus', title: 'junk', source: 'core' }
    ],
    conflicts: []
  }

  /** Panes sized by tab; `fits` says which edges fit for which tab. */
  function rig(
    selected: string,
    sizes: Record<string, { w: number; h: number }>,
    fits: (tabId: string, edge: string) => boolean = () => true,
    extra: TabsAction[] = []
  ) {
    const h = harness(selected, extra)
    const created: Array<[unknown, unknown]> = []
    const reports: string[] = []
    const handlers = inGroupHandlers(table, {
      state: h.state,
      paneSize: (id) => sizes[id] ?? { w: 0, h: 0 },
      fits,
      create: (what, beside) => created.push([what, beside]),
      report: (m) => reports.push(m)
    })
    return { handlers, created, reports }
  }

  it('has one handler per derived command whose base opens a tab, none for anything else', () => {
    const r = rig('a', {})
    expect(Object.keys(r.handlers)).toEqual(['tab.inGroup.tab.newClaude', 'tab.inGroup.tab.newShell', 'tab.inGroup.tab.newCommand.app.lg'])
  })

  it('opens beside the focused pane (the frame tab a chord names, else the active one): right when wider than tall, else down', () => {
    const r = rig('b', { b: { w: 800, h: 400 }, c: { w: 400, h: 300 }, d: { w: 300, h: 400 } })
    r.handlers['tab.inGroup.tab.newClaude']!()
    r.handlers['tab.inGroup.tab.newShell']!({ tabId: 'd' })
    r.handlers['tab.inGroup.tab.newCommand.app.lg']!({ tabId: 'c' })
    expect(r.created).toEqual([
      [{ kind: 'claude' }, { tabId: 'b', edge: 'right' }],
      [{ kind: 'shell' }, { tabId: 'd', edge: 'down' }],
      [{ kind: 'command', level: 'app', entryId: 'lg' }, { tabId: 'c', edge: 'right' }]
    ])
    expect(r.reports).toEqual([])
  })

  it('a square pane goes down: right only when strictly wider than tall', () => {
    expect(inGroupEdge({ w: 500, h: 500 }, () => true)).toBe('down')
    expect(inGroupEdge({ w: 501, h: 500 }, () => true)).toBe('right')
  })

  it('a plain tab forms a group beside it', () => {
    const r = rig('a', { a: { w: 1200, h: 800 } })
    r.handlers['tab.inGroup.tab.newClaude']!()
    expect(r.created).toEqual([[{ kind: 'claude' }, { tabId: 'a', edge: 'right' }]])
  })

  it('tries the other edge when the first does not fit, and refuses when neither does', () => {
    const r = rig('b', { b: { w: 800, h: 400 } }, (_id, edge) => edge === 'down')
    r.handlers['tab.inGroup.tab.newClaude']!()
    expect(r.created).toEqual([[{ kind: 'claude' }, { tabId: 'b', edge: 'down' }]])
    const none = rig('b', { b: { w: 800, h: 400 } }, () => false)
    none.handlers['tab.inGroup.tab.newClaude']!()
    expect(none.created).toEqual([])
    expect(none.reports).toEqual([TOO_SMALL_TO_SPLIT])
  })

  it('refuses when the group is full, opening nothing (main would open the tab plain)', () => {
    const ids = Array.from({ length: GROUP_CAPS.maxPanes }, (_, i) => `p${i}`)
    const full: TabGroup = { id: 'f', root: row('sf', ...ids.map(leaf)) }
    const r = rig('b', { p0: { w: 800, h: 400 } }, () => true, [
      { type: 'loaded', tabs: [...['a', 'b', 'c', 'd'], ...ids].map(tab) } as TabsAction,
      { type: 'groups', snapshot: { seq: 2, order: ['a', 'b', 'c', 'd', ...ids], groups: [G, full] } } as TabsAction
    ])
    r.handlers['tab.inGroup.tab.newClaude']!({ tabId: 'p0' })
    expect(r.created).toEqual([])
    expect(r.reports).toEqual([refusalText('full')])
  })

  it('does nothing with the keys off', () => {
    const r = rig('c', { c: { w: 800, h: 400 } }, () => true, [{ type: 'removed', tabId: 'c', gen: 1 } as TabsAction])
    r.handlers['tab.inGroup.tab.newClaude']!()
    r.handlers['tab.inGroup.tab.newClaude']!({ tabId: 'b' })
    expect(r.created).toEqual([])
  })
})
