import { describe, expect, it } from 'vitest'
import type { TabInfo } from '../../src/shared/ipc'
import {
  initialTabsState,
  tabsReducer,
  type TabsAction,
  type TabsState
} from '../../src/renderer/state/tabs-store'

// The terminal UI itself (xterm rendering, the exited banner, the [+] menu, the reorder context
// menu) needs a DOM and a real PTY, so it is covered end to end in test/e2e/tabs.spec.ts.

const tab = (id: string, extra: Partial<TabInfo> = {}): TabInfo => ({
  id,
  kind: 'shell',
  cwd: '/work/a',
  gen: 1,
  ...extra
})

const exit1 = { code: 1, signal: null }

const run = (actions: TabsAction[], from: TabsState = initialTabsState): TabsState =>
  actions.reduce(tabsReducer, from)

const ids = (s: TabsState): string[] => s.tabs.map((t) => t.id)

describe('tabsReducer', () => {
  it('adds tabs at the end and selects the new one', () => {
    const s = run([
      { type: 'added', tab: tab('a') },
      { type: 'added', tab: tab('b') }
    ])
    expect(ids(s)).toEqual(['a', 'b'])
    expect(s.activeId).toBe('b')
  })

  it('replaces a tab added twice instead of duplicating it', () => {
    const s = run([
      { type: 'added', tab: tab('a') },
      { type: 'added', tab: tab('a', { sessionId: 's1' }) }
    ])
    expect(s.tabs).toEqual([tab('a', { sessionId: 's1' })])
  })

  it('appends a tab main started on its own without taking the selection', () => {
    const s = run([
      { type: 'added', tab: tab('a') },
      { type: 'announced', tab: tab('b', { kind: 'claude' }) }
    ])
    expect(ids(s)).toEqual(['a', 'b'])
    expect(s.activeId).toBe('a')
    // Announced twice (the event and a list that already had it): still one tab.
    expect(ids(run([{ type: 'announced', tab: tab('b', { kind: 'claude' }) }], s))).toEqual(['a', 'b'])
    // An empty window has nothing else to show.
    expect(run([{ type: 'announced', tab: tab('c') }]).activeId).toBe('c')
  })

  it('selects an announced tab when main follows it with tabs.select (ctx.sessions.open focus)', () => {
    const s = run([
      { type: 'added', tab: tab('a') },
      { type: 'announced', tab: tab('b', { kind: 'claude' }) },
      { type: 'selected', tabId: 'b' }
    ])
    expect(s.activeId).toBe('b')
  })

  describe('the list (page load)', () => {
    it('selects the first tab, or none for an empty list', () => {
      const base = run([{ type: 'loaded', tabs: [tab('a'), tab('b')] }])
      expect(ids(base)).toEqual(['a', 'b'])
      expect(base.activeId).toBe('a')
      expect(run([{ type: 'loaded', tabs: [] }]).activeId).toBeNull()
    })

    it('keeps a tab announced after the snapshot was taken, after the listed ones', () => {
      // The bug: 'loaded' replaced everything, so a plugin's tab that main started after taking
      // the list (but whose event beat the reply) vanished with its process still running.
      const s = run([
        { type: 'announced', tab: tab('p', { kind: 'claude' }) },
        { type: 'loaded', tabs: [tab('a'), tab('b')] }
      ])
      expect(ids(s)).toEqual(['a', 'b', 'p'])
      // The announced tab was the only one, so it was selected, and it survives.
      expect(s.activeId).toBe('p')
    })

    it('keeps the selection of a tab the user created before the list answered', () => {
      const s = run([
        { type: 'added', tab: tab('n') },
        { type: 'loaded', tabs: [tab('a')] }
      ])
      expect(ids(s)).toEqual(['a', 'n'])
      expect(s.activeId).toBe('n')
    })

    it('does not duplicate a tab that is both announced and listed, and keeps its order from main', () => {
      const s = run([
        { type: 'announced', tab: tab('b') },
        { type: 'loaded', tabs: [tab('a'), tab('b')] }
      ])
      expect(ids(s)).toEqual(['a', 'b'])
    })

    it('keeps an exit that arrived between the snapshot and its reply', () => {
      const s = run([
        { type: 'announced', tab: tab('p') },
        { type: 'exited', tabId: 'p', exit: exit1, gen: 1 },
        { type: 'loaded', tabs: [tab('p')] }
      ])
      expect(s.tabs).toEqual([tab('p', { exit: exit1 })])
    })

    it('does not bring back a tab this page closed before the list answered', () => {
      const s = run([
        { type: 'announced', tab: tab('p') },
        { type: 'closed', tabId: 'p' },
        { type: 'loaded', tabs: [tab('a'), tab('p')] }
      ])
      expect(ids(s)).toEqual(['a'])
      expect(s.closedEarly).toEqual([])
    })

    it('ignores a second answer (the same, older snapshot)', () => {
      const s = run([
        { type: 'loaded', tabs: [tab('a'), tab('b')] },
        { type: 'closed', tabId: 'b' }
      ])
      expect(tabsReducer(s, { type: 'loaded', tabs: [tab('a'), tab('b')] })).toBe(s)
    })
  })

  describe('close', () => {
    const three = run([{ type: 'loaded', tabs: [tab('a'), tab('b'), tab('c')] }])

    it('selects the right neighbour when the active tab closes', () => {
      const s = run([{ type: 'selected', tabId: 'b' }, { type: 'closed', tabId: 'b' }], three)
      expect(ids(s)).toEqual(['a', 'c'])
      expect(s.activeId).toBe('c')
    })

    it('selects the left neighbour when the last tab closes', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'closed', tabId: 'c' }], three)
      expect(s.activeId).toBe('b')
    })

    it('keeps the selection when another tab closes', () => {
      const s = run([{ type: 'selected', tabId: 'c' }, { type: 'closed', tabId: 'a' }], three)
      expect(ids(s)).toEqual(['b', 'c'])
      expect(s.activeId).toBe('c')
    })

    it('ends with no selection when the only tab closes', () => {
      const s = run([{ type: 'closed', tabId: 'a' }], run([{ type: 'added', tab: tab('a') }]))
      expect(s.tabs).toEqual([])
      expect(s.activeId).toBeNull()
    })

    it('ignores an unknown tab', () => {
      expect(tabsReducer(three, { type: 'closed', tabId: 'zzz' })).toBe(three)
    })
  })

  describe('reorder', () => {
    const three = run([{ type: 'loaded', tabs: [tab('a'), tab('b'), tab('c')] }])

    it('moves a tab and keeps the selection', () => {
      const s = run([{ type: 'moved', tabId: 'a', toIndex: 2 }], three)
      expect(ids(s)).toEqual(['b', 'c', 'a'])
      expect(s.activeId).toBe('a')
      expect(ids(run([{ type: 'moved', tabId: 'c', toIndex: 0 }], three))).toEqual(['c', 'a', 'b'])
    })

    it('clamps to the ends like main does', () => {
      expect(ids(run([{ type: 'moved', tabId: 'b', toIndex: 99 }], three))).toEqual(['a', 'c', 'b'])
      expect(ids(run([{ type: 'moved', tabId: 'b', toIndex: -5 }], three))).toEqual(['b', 'a', 'c'])
    })

    it('returns the same state for a no-op or an unknown tab', () => {
      expect(tabsReducer(three, { type: 'moved', tabId: 'b', toIndex: 1 })).toBe(three)
      expect(tabsReducer(three, { type: 'moved', tabId: 'zzz', toIndex: 0 })).toBe(three)
    })
  })

  it('selects only tabs that exist', () => {
    const s = run([{ type: 'loaded', tabs: [tab('a'), tab('b')] }])
    expect(tabsReducer(s, { type: 'selected', tabId: 'zzz' })).toBe(s)
    expect(tabsReducer(s, { type: 'selected', tabId: 'b' }).activeId).toBe('b')
  })

  describe('exit and restart', () => {
    it('records an exit, and restart clears it in place', () => {
      const exited = run([
        { type: 'loaded', tabs: [tab('a'), tab('b')] },
        { type: 'exited', tabId: 'a', exit: exit1, gen: 1 }
      ])
      expect(exited.tabs[0]?.exit).toEqual(exit1)
      const restarted = tabsReducer(exited, { type: 'restarted', tab: tab('a', { gen: 2 }) })
      expect(restarted.tabs[0]).toEqual(tab('a', { gen: 2 }))
      expect(ids(restarted)).toEqual(['a', 'b'])
      expect(restarted.activeId).toBe(exited.activeId)
    })

    it('applies an exit that arrived before its tab', () => {
      const early = run([{ type: 'exited', tabId: 'x', exit: { code: 127, signal: null }, gen: 1 }])
      expect(early.tabs).toEqual([])
      const s = tabsReducer(early, { type: 'added', tab: tab('x') })
      expect(s.tabs[0]?.exit).toEqual({ code: 127, signal: null })
      expect(s.earlyExits).toEqual({})
    })

    it('keeps the exit of a restarted process that died before the restart reply', () => {
      // The bug: the exit updated the old (gen 1) tab, then the reply replaced it with the running
      // snapshot of gen 2, dropping the exited banner and the Restart button for good.
      const s = run([
        { type: 'loaded', tabs: [tab('a', { exit: exit1 })] },
        { type: 'exited', tabId: 'a', exit: { code: 127, signal: null }, gen: 2 },
        { type: 'restarted', tab: tab('a', { gen: 2 }) }
      ])
      expect(s.tabs).toEqual([tab('a', { gen: 2, exit: { code: 127, signal: null } })])
      expect(s.earlyExits).toEqual({})
    })

    it('applies an exit that follows the restart reply, and ignores one of an earlier process', () => {
      const restarted = run([
        { type: 'loaded', tabs: [tab('a', { exit: exit1 })] },
        { type: 'restarted', tab: tab('a', { gen: 2 }) }
      ])
      expect(tabsReducer(restarted, { type: 'exited', tabId: 'a', exit: exit1, gen: 1 })).toBe(restarted)
      const exited = tabsReducer(restarted, { type: 'exited', tabId: 'a', exit: { code: 0, signal: 9 }, gen: 2 })
      expect(exited.tabs[0]).toEqual(tab('a', { gen: 2, exit: { code: 0, signal: 9 } }))
    })

    it('never lets an older snapshot replace a newer one', () => {
      const s = run([
        { type: 'loaded', tabs: [tab('a', { exit: exit1 })] },
        { type: 'restarted', tab: tab('a', { gen: 2 }) },
        // A late duplicate of an older snapshot (e.g. the gen 1 announcement).
        { type: 'announced', tab: tab('a', { exit: exit1 }) }
      ])
      expect(s.tabs).toEqual([tab('a', { gen: 2 })])
    })

    it('a restored command tab that never ran (gen 0) starts with Restart, and a quick exit of that first run sticks', () => {
      const waiting = tab('c', { kind: 'command', gen: 0, notStarted: true, exit: { code: 0, signal: null }, label: 'Dev' })
      const started = run([
        { type: 'loaded', tabs: [waiting] },
        { type: 'restarted', tab: tab('c', { kind: 'command', gen: 1, label: 'Dev' }) }
      ])
      expect(started.tabs).toEqual([tab('c', { kind: 'command', gen: 1, label: 'Dev' })])
      // The first run died before the restart reply landed: its exit is held, then applied.
      const quick = run([
        { type: 'loaded', tabs: [waiting] },
        { type: 'exited', tabId: 'c', exit: { code: 127, signal: null }, gen: 1 },
        { type: 'restarted', tab: tab('c', { kind: 'command', gen: 1, label: 'Dev' }) }
      ])
      expect(quick.tabs[0]).toEqual(tab('c', { kind: 'command', gen: 1, label: 'Dev', exit: { code: 127, signal: null } }))
    })

    it('ignores a restart of a tab that is gone', () => {
      expect(tabsReducer(initialTabsState, { type: 'restarted', tab: tab('a') })).toBe(
        initialTabsState
      )
    })
  })

  // main closed a tab whose process exited cleanly (`tabs.removed`, the tabExit setting).
  describe('removed by main', () => {
    const three = run([{ type: 'loaded', tabs: [tab('a'), tab('b'), tab('c')] }])

    it('closes the tab like Close, selecting its neighbour, and the last one leaves none', () => {
      let s = run([{ type: 'selected', tabId: 'b' }, { type: 'removed', tabId: 'b', gen: 1 }], three)
      expect(ids(s)).toEqual(['a', 'c'])
      expect(s.activeId).toBe('c')
      s = run(
        [
          { type: 'removed', tabId: 'a', gen: 1 },
          { type: 'removed', tabId: 'c', gen: 1 }
        ],
        s
      )
      expect(s.tabs).toEqual([])
      expect(s.activeId).toBeNull()
    })

    it('ignores a removal of a generation older than the one held', () => {
      const s = run([{ type: 'restarted', tab: tab('b', { gen: 2 }) }], three)
      expect(tabsReducer(s, { type: 'removed', tabId: 'b', gen: 1 })).toBe(s)
    })

    it('a create reply that arrives after the removal does not bring the tab back', () => {
      const s = run([
        { type: 'loaded', tabs: [] },
        { type: 'removed', tabId: 'x', gen: 1 },
        { type: 'added', tab: tab('x') }
      ])
      expect(s.tabs).toEqual([])
      expect(s.activeId).toBeNull()
      expect(s.removedEarly).toEqual({})
    })

    it('a restarted process that exits cleanly before the restart reply closes the tab', () => {
      const s = run(
        [
          { type: 'exited', tabId: 'b', exit: exit1, gen: 1 },
          { type: 'removed', tabId: 'b', gen: 2 },
          { type: 'restarted', tab: tab('b', { gen: 2 }) }
        ],
        three
      )
      expect(ids(s)).toEqual(['a', 'c'])
    })

    it('a list taken before the removal does not bring the tab back', () => {
      const s = run([
        { type: 'removed', tabId: 'b', gen: 1 },
        { type: 'loaded', tabs: [tab('a'), tab('b')] }
      ])
      expect(ids(s)).toEqual(['a'])
      expect(s.removedEarly).toEqual({})
    })

    it('drops an exit held for the removed tab', () => {
      const s = run([
        { type: 'loaded', tabs: [tab('a')] },
        { type: 'exited', tabId: 'a', exit: exit1, gen: 2 },
        { type: 'removed', tabId: 'a', gen: 1 }
      ])
      expect(s.tabs).toEqual([])
      expect(s.earlyExits).toEqual({})
    })
  })
})

describe('tabsReducer: who typed last (Task 16)', () => {
  it('sets typedBy on its tab only, ignores an unknown tab, and a later list carries it as main has it', () => {
    let s = run([
      { type: 'added', tab: tab('a') },
      { type: 'added', tab: tab('b') },
      { type: 'typed', tabId: 'a', typedBy: { viewId: 'web:2', device: 'Pixel' } },
      { type: 'typed', tabId: 'gone', typedBy: { viewId: 'web:2', device: 'Pixel' } }
    ])
    expect(s.tabs.map((t) => t.typedBy)).toEqual([{ viewId: 'web:2', device: 'Pixel' }, undefined])
    s = tabsReducer(s, { type: 'typed', tabId: 'a', typedBy: { viewId: 'desktop:1', device: 'Desktop' } })
    expect(s.tabs[0]!.typedBy).toEqual({ viewId: 'desktop:1', device: 'Desktop' })
  })
})
