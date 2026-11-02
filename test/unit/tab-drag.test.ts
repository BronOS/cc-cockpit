import { describe, expect, it } from 'vitest'
import { dropIndex, dropMarker } from '../../src/renderer/tabs/tab-drag'

// Three other tabs centred at 50, 150 and 250 (the dragged one already taken out).
const centres = [50, 150, 250]

describe('dropIndex', () => {
  it('counts the other tabs whose centre is left of the pointer', () => {
    expect(dropIndex(centres, 10)).toBe(0)
    expect(dropIndex(centres, 100)).toBe(1)
    expect(dropIndex(centres, 200)).toBe(2)
    expect(dropIndex(centres, 400)).toBe(3)
  })

  it('swaps only once the pointer passes a neighbour\'s centre', () => {
    expect(dropIndex(centres, 150)).toBe(1)
    expect(dropIndex(centres, 151)).toBe(2)
  })

  it('is 0 with no other tabs', () => {
    expect(dropIndex([], 500)).toBe(0)
  })

  it('matches main\'s reorder: splice out, then in at the index', () => {
    // Tabs a b c d; drag a (index 0) past c's centre. Others are b c d.
    const order = ['a', 'b', 'c', 'd']
    const toIndex = dropIndex(centres, 260)
    const next = order.filter((t) => t !== 'a')
    next.splice(toIndex, 0, 'a')
    expect(next).toEqual(['b', 'c', 'd', 'a'])
  })
})

describe('dropMarker', () => {
  const others = ['b', 'c', 'd']

  it('is null when the drop keeps the order', () => {
    expect(dropMarker(others, 1, 1)).toBeNull()
  })

  it('marks the left edge of the tab now at the index', () => {
    expect(dropMarker(others, 3, 0)).toEqual({ tabId: 'b', edge: 'before' })
    expect(dropMarker(others, 0, 2)).toEqual({ tabId: 'd', edge: 'before' })
  })

  it('marks the right edge of the last tab for a drop at the end', () => {
    expect(dropMarker(others, 0, 3)).toEqual({ tabId: 'd', edge: 'after' })
  })

  it('is null with no other tabs', () => {
    expect(dropMarker([], 0, 0)).toBeNull()
  })
})
