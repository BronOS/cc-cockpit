import { describe, expect, it } from 'vitest'
import { mainPaneFocused, mainSelectHandlers, ownerOfFocus, panelCommandHandlers, panelStep } from '../../src/renderer/tabs/panel-keys'
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
  function setup(ids: string[], activeId: string | null, keysOff = false, panelOff = false) {
    const calls: string[] = []
    const h = panelCommandHandlers({
      panel: () => ({ ids, activeId }),
      mainKeysOff: () => keysOff,
      panelKeysOff: () => panelOff,
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

// Review S3: the panel's selection moved by itself (its tab exited, another view moved or closed it):
// Close Tab must not close the neighbour nobody picked.
describe("the panel's keys-off", () => {
  function handlers(panelOff: boolean) {
    const calls: string[] = []
    const h = panelCommandHandlers({
      panel: () => ({ ids: ['p1', 'p2'], activeId: 'p2' }),
      mainKeysOff: () => false,
      panelKeysOff: () => panelOff,
      close: (id) => calls.push(`close ${id}`),
      pick: (id) => calls.push(`pick ${id}`),
      newShell: () => calls.push('newShell')
    })
    return { h, calls }
  }

  it('Close Tab closes nothing while the panel is keys-off; a step is a pick and still works', () => {
    const { h, calls } = handlers(true)
    h['tab.close']!()
    h[SWITCH_NEXT]!()
    expect(calls).toEqual(['pick p1'])
  })
})

// Review M1: a main tab going while the panel holds the keys must not make its neighbour the focused
// pane (its TerminalView focus effect would take the keyboard into a Claude prompt).
describe('mainPaneFocused', () => {
  it('only the main selection with the main keys on and the panel not holding them', () => {
    expect(mainPaneFocused('a', 'a', false, false)).toBe(true)
    expect(mainPaneFocused('a', 'a', false, true)).toBe(false)
    expect(mainPaneFocused('a', 'a', true, false)).toBe(false)
    expect(mainPaneFocused('b', 'a', false, false)).toBe(false)
  })
})

// Review R2-S1: the main area's selecting chords are the person asking for a main tab; with the
// Terminal panel holding the keys they must bring the keys back before selecting (M1's gate kept them
// in the panel, the main tab selected under an unfocused terminal).
describe('mainSelectHandlers', () => {
  function setup(ids: string[]) {
    const calls: string[] = []
    const h = mainSelectHandlers({
      mainTabIds: () => ids,
      pick: (id) => calls.push(`pick ${id}`),
      create: (kind) => calls.push(`create ${kind}`),
      takeMainKeys: () => calls.push('take')
    })
    return { h, calls }
  }

  it('tab.select.N takes the main keys, then picks the n-th main tab', () => {
    const { h, calls } = setup(['a', 'b', 'c'])
    h['tab.select.3']!()
    h['tab.select.1']!()
    expect(calls).toEqual(['take', 'pick c', 'take', 'pick a'])
  })

  it('tab.select.N past the strip does nothing, the keys stay where they are', () => {
    const { h, calls } = setup(['a'])
    h['tab.select.4']!()
    expect(calls).toEqual([])
  })

  it('New Claude and New Shell take the main keys, then create', () => {
    const { h, calls } = setup([])
    h['tab.newClaude']!()
    h['tab.newShell']!()
    expect(calls).toEqual(['take', 'create claude', 'take', 'create shell'])
  })

  it('every tab.select.1..9 is there', () => {
    const { h } = setup([])
    for (let n = 1; n <= 9; n++) expect(h[`tab.select.${n}`]).toBeTypeOf('function')
  })
})
