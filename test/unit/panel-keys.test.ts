import { describe, expect, it } from 'vitest'
import { ownerOfFocus, panelCommandHandlers, panelStep } from '../../src/renderer/tabs/panel-keys'
import { SWITCH_NEXT, SWITCH_PREV } from '../../src/renderer/tabs/tab-switcher'

// design-terminal-panel.md §6, §13.3 (D10): the keys follow the area the person last focused, and the
// panel's overrides act on the panel's strip only.

const inside = (...selectors: string[]) => ({ closest: (s: string) => (selectors.includes(s) ? {} : null) })

describe('ownerOfFocus', () => {
  it('names the area a focus lands in, and nothing for anything else', () => {
    expect(ownerOfFocus(inside('[data-terminal-panel]'))).toBe('panel')
    expect(ownerOfFocus(inside('.zones-centre'))).toBe('main')
    // A popup, a dialog, the palette: the owner stays as it was.
    expect(ownerOfFocus(inside())).toBeUndefined()
    expect(ownerOfFocus(null)).toBeUndefined()
  })
})

describe('panelStep', () => {
  it('wraps around the strip', () => {
    expect(panelStep(['a', 'b', 'c'], 'c', 1)).toBe('a')
    expect(panelStep(['a', 'b', 'c'], 'a', -1)).toBe('c')
    expect(panelStep(['a', 'b'], 'a', 1)).toBe('b')
  })

  it('with no selection starts at an end; an empty strip has nothing', () => {
    expect(panelStep(['a', 'b'], null, 1)).toBe('a')
    expect(panelStep(['a', 'b'], 'gone', -1)).toBe('b')
    expect(panelStep([], null, 1)).toBeUndefined()
  })
})

describe('panelCommandHandlers', () => {
  function setup(ids: string[], activeId: string | null, keysOff = false) {
    const calls: string[] = []
    const h = panelCommandHandlers({
      panel: () => ({ ids, activeId }),
      mainKeysOff: () => keysOff,
      close: (id) => calls.push(`close ${id}`),
      pick: (id) => calls.push(`pick ${id}`),
      newShell: () => calls.push('newShell')
    })
    return { h, calls }
  }

  it("Close Tab closes the panel's selected tab, or nothing in an empty panel", () => {
    const a = setup(['p1', 'p2'], 'p2')
    a.h['tab.close']!()
    expect(a.calls).toEqual(['close p2'])
    const b = setup([], null)
    b.h['tab.close']!()
    expect(b.calls).toEqual([])
  })

  it("a frame's forwarded Close Tab names its own tab: closed by the main area's rule", () => {
    const a = setup(['p1'], 'p1')
    a.h['tab.close']!({ tabId: 'page1' })
    expect(a.calls).toEqual(['close page1'])
    const off = setup(['p1'], 'p1', true)
    off.h['tab.close']!({ tabId: 'page1' })
    expect(off.calls).toEqual([])
  })

  it('the switch chords are a plain step in the panel, and one tab steps nowhere', () => {
    const a = setup(['p1', 'p2', 'p3'], 'p1')
    a.h[SWITCH_NEXT]!()
    a.h[SWITCH_PREV]!()
    expect(a.calls).toEqual(['pick p2', 'pick p3'])
    const one = setup(['p1'], 'p1')
    one.h[SWITCH_NEXT]!()
    expect(one.calls).toEqual([])
  })

  it('New Shell opens it in the panel', () => {
    const a = setup([], null)
    a.h['tab.newShell']!()
    expect(a.calls).toEqual(['newShell'])
  })
})
