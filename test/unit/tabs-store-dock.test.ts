import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../../src/shared/ipc'
import {
  initialTabsState,
  mainTabsOf,
  panelTabsOf,
  tabsReducer,
  type TabsAction,
  type TabsState
} from '../../src/renderer/state/tabs-store'

// The page's half of the Terminal panel (design-terminal-panel.md §2, §4, §13.10, §13.14): docked tabs
// stay in the one list, the main selection never rests on one, and the panel keeps its own selection.

const tab = (id: string, extra: Partial<TabInfo> = {}): TabInfo => ({ id, kind: 'shell', cwd: '/w', gen: 1, ...extra })
const docked = (id: string, extra: Partial<TabInfo> = {}): TabInfo => tab(id, { dock: 'panel', ...extra })
const run = (actions: TabsAction[], from: TabsState = initialTabsState): TabsState => actions.reduce(tabsReducer, from)
const ids = (tabs: readonly TabInfo[]): string[] => tabs.map((t) => t.id)

describe('docked tabs in the page list', () => {
  it('a loaded list splits into the strips; the main selection is a main tab, the panel picks its first', () => {
    const s = run([{ type: 'loaded', tabs: [docked('p1'), tab('a'), docked('p2'), tab('b')] }])
    expect(ids(mainTabsOf(s))).toEqual(['a', 'b'])
    expect(ids(panelTabsOf(s))).toEqual(['p1', 'p2'])
    expect(s.activeId).toBe('a')
    expect(s.panelActiveId).toBe('p1')
  })

  it("a list of docked tabs only leaves the main area with no selection", () => {
    const s = run([{ type: 'loaded', tabs: [docked('p1')] }])
    expect(s.activeId).toBeNull()
    expect(s.panelActiveId).toBe('p1')
  })

  it('a tab created in the panel is selected there and leaves the main selection', () => {
    const s = run([{ type: 'loaded', tabs: [tab('a')] }, { type: 'added', tab: docked('p1') }, { type: 'added', tab: docked('p2') }])
    expect(s.activeId).toBe('a')
    expect(s.panelActiveId).toBe('p2')
  })

  it("an announced docked tab takes the panel's selection only when it has none", () => {
    const s = run([{ type: 'loaded', tabs: [tab('a')] }, { type: 'announced', tab: docked('p1') }])
    expect(s.panelActiveId).toBe('p1')
    expect(run([{ type: 'announced', tab: docked('p2') }], s).panelActiveId).toBe('p1')
  })

  it('a main selection of a docked tab is ignored', () => {
    const s = run([{ type: 'loaded', tabs: [tab('a'), docked('p1')] }, { type: 'selected', tabId: 'p1' }])
    expect(s.activeId).toBe('a')
  })

  it('panelSelected takes a docked tab and ignores anything else', () => {
    const base = run([{ type: 'loaded', tabs: [tab('a'), docked('p1'), docked('p2')] }])
    expect(run([{ type: 'panelSelected', tabId: 'p2' }], base).panelActiveId).toBe('p2')
    expect(run([{ type: 'panelSelected', tabId: 'a' }], base).panelActiveId).toBe('p1')
    expect(run([{ type: 'panelSelected', tabId: 'gone' }], base).panelActiveId).toBe('p1')
  })
})

describe('tabs.docked', () => {
  const base = (): TabsState => run([{ type: 'loaded', tabs: [tab('a'), tab('b'), tab('c')] }, { type: 'selected', tabId: 'b' }])

  it("this view's own move into the panel selects it there, moves the main selection on and keeps the keys", () => {
    const s = run([{ type: 'docked', tabId: 'b', dock: 'panel', own: true }], base())
    expect(ids(panelTabsOf(s))).toEqual(['b'])
    expect(s.panelActiveId).toBe('b')
    expect(s.activeId).not.toBe('b')
    expect(s.activeId).not.toBeNull()
    expect(s.keysOff).toBe(false)
  })

  it("another view's move of the selected tab leaves this view keys-off, as a close would", () => {
    const s = run([{ type: 'docked', tabId: 'b', dock: 'panel' }], base())
    expect(s.activeId).not.toBe('b')
    expect(s.keysOff).toBe(true)
    // The panel had nothing: it shows what came in, without this view's keys.
    expect(s.panelActiveId).toBe('b')
  })

  it("another view's move of an unselected tab changes no selection", () => {
    const s = run([{ type: 'docked', tabId: 'c', dock: 'panel' }], base())
    expect(s.activeId).toBe('b')
    expect(s.keysOff).toBe(false)
  })

  it('docking clears the flag', () => {
    const s = run(
      [{ type: 'loaded', tabs: [tab('a'), tab('b', { flag: { color: 'red' } })] }, { type: 'docked', tabId: 'b', dock: 'panel', own: true }]
    )
    expect(s.tabs.find((t) => t.id === 'b')!.flag).toBeUndefined()
  })

  it('own move back to the tab area selects it there with the keys; the panel picks a neighbour', () => {
    const start = run([{ type: 'loaded', tabs: [tab('a'), docked('p1'), docked('p2')] }, { type: 'panelSelected', tabId: 'p2' }])
    const s = run([{ type: 'docked', tabId: 'p2', dock: 'main', own: true }], start)
    expect(s.activeId).toBe('p2')
    expect(s.keysOff).toBe(false)
    expect(s.panelActiveId).toBe('p1')
    expect(ids(mainTabsOf(s))).toEqual(['a', 'p2'])
  })

  it("another view's move out of the panel leaves the main selection where it was", () => {
    const start = run([{ type: 'loaded', tabs: [tab('a'), docked('p1')] }])
    const s = run([{ type: 'docked', tabId: 'p1', dock: 'main' }], start)
    expect(s.activeId).toBe('a')
    expect(s.panelActiveId).toBeNull()
  })

  it('a move before the list is applied to the list when it comes; after the list an unknown tab is ignored', () => {
    const early = run([{ type: 'docked', tabId: 'b', dock: 'panel' }])
    const s = run([{ type: 'loaded', tabs: [tab('a'), tab('b')] }], early)
    expect(ids(panelTabsOf(s))).toEqual(['b'])
    expect(s.earlyDocks).toEqual({})
    const after = run([{ type: 'docked', tabId: 'x', dock: 'panel' }], s)
    expect(after.earlyDocks).toEqual({})
  })
})

describe('closing in the panel', () => {
  it("closing the panel's selected tab selects the neighbour that slides in", () => {
    const start = run([{ type: 'loaded', tabs: [tab('a'), docked('p1'), docked('p2'), docked('p3')] }, { type: 'panelSelected', tabId: 'p2' }])
    const s = run([{ type: 'closed', tabId: 'p2' }], start)
    expect(s.panelActiveId).toBe('p3')
    expect(s.activeId).toBe('a')
    const last = run([{ type: 'closed', tabId: 'p3' }], s)
    expect(last.panelActiveId).toBe('p1')
    expect(run([{ type: 'closed', tabId: 'p1' }], last).panelActiveId).toBeNull()
  })
})

// Review S3: the panel's own keys-off. Its selected tab going by itself (an exit, another view's close
// or move) leaves the neighbour selected but nobody's pick; the person's own close or move does not.
describe("the panel's keys-off", () => {
  const start = (): TabsState =>
    run([{ type: 'loaded', tabs: [tab('a'), docked('p1'), docked('p2')] }, { type: 'panelSelected', tabId: 'p2' }])

  it("an exit or another view's close of the selected panel tab turns the panel's keys off", () => {
    expect(start().panelKeysOff).toBe(false)
    expect(run([{ type: 'removed', tabId: 'p2', gen: 1 }], start()).panelKeysOff).toBe(true)
    expect(run([{ type: 'closed', tabId: 'p2' }], start()).panelKeysOff).toBe(true)
    expect(run([{ type: 'docked', tabId: 'p2', dock: 'main' }], start()).panelKeysOff).toBe(true)
  })

  it("the person's own close or move keeps them; an unselected tab going changes nothing", () => {
    expect(run([{ type: 'closed', tabId: 'p2', own: true }], start()).panelKeysOff).toBe(false)
    expect(run([{ type: 'docked', tabId: 'p2', dock: 'main', own: true }], start()).panelKeysOff).toBe(false)
    expect(run([{ type: 'removed', tabId: 'p1', gen: 1 }], start()).panelKeysOff).toBe(false)
  })

  it("a pick, a focus there, a create there or main's exit focus turn them on again", () => {
    const off = run([{ type: 'removed', tabId: 'p2', gen: 1 }], start())
    expect(run([{ type: 'panelSelected', tabId: 'p1' }], off).panelKeysOff).toBe(false)
    expect(run([{ type: 'panelKeysOn' }], off).panelKeysOff).toBe(false)
    expect(run([{ type: 'added', tab: docked('p3') }], off).panelKeysOff).toBe(false)
    // main's exit focus (their own Ctrl+D in the panel): the next tab with the keys on.
    expect(run([{ type: 'exitFocus', tabId: 'p1', closed: 'p2' }], off).panelKeysOff).toBe(false)
    // A main-area tab going leaves the panel's keys alone.
    expect(run([{ type: 'removed', tabId: 'a', gen: 1 }], start()).panelKeysOff).toBe(false)
  })
})

// Review S5: a move of a tab the page holds already (a create reply, tabs.added) before the list
// answered must survive the list, which may have been taken before the move.
describe('a dock before the list, of a held tab', () => {
  it('the older list does not undo it', () => {
    const s = run([
      { type: 'added', tab: tab('b') },
      { type: 'docked', tabId: 'b', dock: 'panel' },
      { type: 'loaded', tabs: [tab('a'), tab('b')] }
    ])
    expect(ids(panelTabsOf(s))).toEqual(['b'])
    expect(s.earlyDocks).toEqual({})
  })

  it('a move back to the tab area before the list survives a list that still has it docked', () => {
    const s = run([
      { type: 'announced', tab: docked('p1') },
      { type: 'docked', tabId: 'p1', dock: 'main' },
      { type: 'loaded', tabs: [docked('p1')] }
    ])
    expect(ids(mainTabsOf(s))).toEqual(['p1'])
  })
})
