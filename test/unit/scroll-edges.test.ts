// Edges-only scrolling (src/sdk/scroll-edges-core.ts): the pure rules the page script applies. The
// script and the sheets in a real page are checked by test/e2e/panels.spec.ts.
import { describe, expect, it } from 'vitest'
import {
  NEAR_EDGE_PX,
  SCROLLING_MS,
  ScrollingMarks,
  isScrollOverflow,
  nearScrollbar,
  scrollEdges
} from '../../src/sdk/scroll-edges-core'

describe('scrollEdges', () => {
  it('shows the bottom edge only at the top, both in the middle, the top only at the bottom', () => {
    expect(scrollEdges(0, 1000, 200)).toEqual({ top: false, bottom: true })
    expect(scrollEdges(400, 1000, 200)).toEqual({ top: true, bottom: true })
    expect(scrollEdges(800, 1000, 200)).toEqual({ top: true, bottom: false })
  })

  it('shows neither when nothing overflows', () => {
    expect(scrollEdges(0, 200, 200)).toEqual({ top: false, bottom: false })
    expect(scrollEdges(0, 150, 200)).toEqual({ top: false, bottom: false })
  })

  it('allows a px of slack at both ends (fractional zoom)', () => {
    expect(scrollEdges(0.6, 1000, 200)).toEqual({ top: false, bottom: true })
    expect(scrollEdges(799.4, 1000, 200)).toEqual({ top: true, bottom: false })
    expect(scrollEdges(1.5, 1000, 200).top).toBe(true)
    expect(scrollEdges(798, 1000, 200).bottom).toBe(true)
  })
})

describe('nearScrollbar', () => {
  const box = { left: 100, top: 50, right: 400, bottom: 450 }
  const vertical = { vertical: true, horizontal: false }
  const horizontal = { vertical: false, horizontal: true }

  it('is near within NEAR_EDGE_PX of the right edge of a vertical scroller, inside the box', () => {
    expect(nearScrollbar(box, 400 - NEAR_EDGE_PX, 200, vertical)).toBe(true)
    expect(nearScrollbar(box, 399, 200, vertical)).toBe(true)
    expect(nearScrollbar(box, 400, 200, vertical)).toBe(true)
    expect(nearScrollbar(box, 400 - NEAR_EDGE_PX - 1, 200, vertical)).toBe(false)
    expect(nearScrollbar(box, 150, 200, vertical)).toBe(false)
  })

  it('is not near outside the box, even beside the edge', () => {
    expect(nearScrollbar(box, 401, 200, vertical)).toBe(false)
    expect(nearScrollbar(box, 390, 49, vertical)).toBe(false)
    expect(nearScrollbar(box, 390, 451, vertical)).toBe(false)
  })

  it('uses the bottom edge for a sideways scroller, and nothing for one that cannot scroll', () => {
    expect(nearScrollbar(box, 150, 440, horizontal)).toBe(true)
    expect(nearScrollbar(box, 390, 200, horizontal)).toBe(false)
    expect(nearScrollbar(box, 390, 440, { vertical: false, horizontal: false })).toBe(false)
    expect(nearScrollbar(box, 150, 440, vertical)).toBe(false)
  })

  it('takes another distance', () => {
    expect(nearScrollbar(box, 395, 200, vertical, 4)).toBe(false)
    expect(nearScrollbar(box, 397, 200, vertical, 4)).toBe(true)
  })
})

describe('ScrollingMarks', () => {
  it('marks on the first scroll only and keeps the mark SCROLLING_MS after the last one', () => {
    const marks = new ScrollingMarks<string>()
    expect(marks.touch('list', 0)).toBe(true)
    expect(marks.touch('list', 300)).toBe(false)
    expect(marks.next()).toBe(300 + SCROLLING_MS)
    expect(marks.expire(SCROLLING_MS)).toEqual([])
    expect(marks.expire(300 + SCROLLING_MS - 1)).toEqual([])
    expect(marks.expire(300 + SCROLLING_MS)).toEqual(['list'])
    expect(marks.size).toBe(0)
    expect(marks.next()).toBeUndefined()
    // Scrolled again after it went: marked again.
    expect(marks.touch('list', 5000)).toBe(true)
  })

  it('expires each element on its own clock and names the next deadline', () => {
    const marks = new ScrollingMarks<string>(100)
    marks.touch('a', 0)
    marks.touch('b', 50)
    expect(marks.next()).toBe(100)
    expect(marks.expire(120)).toEqual(['a'])
    expect(marks.next()).toBe(150)
    marks.touch('b', 140)
    expect(marks.expire(150)).toEqual([])
    expect(marks.expire(240)).toEqual(['b'])
  })
})

describe('isScrollOverflow', () => {
  it('is a scroll container for auto, scroll and the legacy overlay only', () => {
    expect(['auto', 'scroll', 'overlay'].map(isScrollOverflow)).toEqual([true, true, true])
    expect(['visible', 'hidden', 'clip', ''].map(isScrollOverflow)).toEqual([false, false, false, false])
  })
})
