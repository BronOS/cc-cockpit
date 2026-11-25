import { describe, expect, it } from 'vitest'
import { fullIndexOf, isDocked, stepIndex, stripTabs } from '../../src/renderer/tabs/dock-order'

// design-terminal-panel.md §13.6: a strip's drop or Move left / right lands beside the same neighbour in
// main's one order, whatever docked (or undocked) tabs sit between them there.

describe('the strips of the one order', () => {
  const tabs = [{ id: 'a' }, { id: 'p1', dock: 'panel' as const }, { id: 'b' }, { id: 'p2', dock: 'panel' as const }, { id: 'c' }]

  it('splits the order by dock', () => {
    expect(stripTabs(tabs, false).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(stripTabs(tabs, true).map((t) => t.id)).toEqual(['p1', 'p2'])
    expect(isDocked(tabs[1])).toBe(true)
    expect(isDocked(tabs[0])).toBe(false)
    expect(isDocked(undefined)).toBe(false)
  })
})

describe('fullIndexOf', () => {
  const full = ['a', 'p1', 'b', 'p2', 'c']
  const main = ['a', 'b', 'c']

  it('puts the tab before the strip tab at toIndex, counted in the full order without it', () => {
    // c to the front of the main strip: before a.
    expect(fullIndexOf(full, main, ['c'], 0)).toBe(0)
    // a to between b and c: before c, which is at 3 in [p1, b, p2, c].
    expect(fullIndexOf(full, main, ['a'], 1)).toBe(3)
  })

  it('past the end lands right after the strip last tab, not after a docked tab behind it', () => {
    const order = ['a', 'b', 'p1']
    expect(fullIndexOf(order, ['a', 'b'], ['a'], 1)).toBe(1)
  })

  it('maps the panel strip the same way', () => {
    // p2 to the front of the panel: before p1 (at 1 in [a, p1, b, c]).
    expect(fullIndexOf(full, ['p1', 'p2'], ['p2'], 0)).toBe(1)
    // p1 after p2: right after p2 (at 2 in [a, b, p2, c]) is 3.
    expect(fullIndexOf(full, ['p1', 'p2'], ['p1'], 1)).toBe(3)
  })

  it("moves a group's block as one, counting the strip's other tabs", () => {
    const order = ['g1', 'g2', 'p1', 'x', 'y']
    // The block to the end of the main strip: after y.
    expect(fullIndexOf(order, ['g1', 'g2', 'x', 'y'], ['g1', 'g2'], 2)).toBe(3)
  })

  it('with nothing else in the strip, keeps the place it has', () => {
    expect(fullIndexOf(['a', 'p1', 'b'], ['p1'], ['p1'], 0)).toBe(1)
  })

  it('clamps an index outside the strip', () => {
    expect(fullIndexOf(full, main, ['c'], -4)).toBe(0)
    expect(fullIndexOf(full, main, ['a'], 99)).toBe(4)
  })
})

describe('stepIndex (Move left / right)', () => {
  it('steps within the strip and stops at its ends', () => {
    expect(stepIndex(['a', 'b', 'c'], 'b', -1)).toBe(0)
    expect(stepIndex(['a', 'b', 'c'], 'b', 1)).toBe(2)
    expect(stepIndex(['a', 'b', 'c'], 'a', -1)).toBeUndefined()
    expect(stepIndex(['a', 'b', 'c'], 'c', 1)).toBeUndefined()
    expect(stepIndex(['a'], 'x', 1)).toBeUndefined()
  })

  it('a step right past a hidden docked tab is a visible move', () => {
    const full = ['a', 'p1', 'b']
    const to = stepIndex(['a', 'b'], 'a', 1)!
    // After b: [p1, b] without a, after b is index 2.
    expect(fullIndexOf(full, ['a', 'b'], ['a'], to)).toBe(2)
  })
})
