import { describe, expect, it } from 'vitest'
import { overflowState, scrollToReveal, wheelScrollsSideways } from '../../src/renderer/tabs/tab-overflow'

describe('overflowState', () => {
  it('has no hidden tabs when the content fits', () => {
    expect(overflowState(0, 400, 400)).toEqual({ start: false, end: false })
  })
  it('hides tabs on the right at the start of a long strip', () => {
    expect(overflowState(0, 400, 900)).toEqual({ start: false, end: true })
  })
  it('hides tabs on both sides in the middle', () => {
    expect(overflowState(200, 400, 900)).toEqual({ start: true, end: true })
  })
  it('hides tabs on the left only at the end, tolerating sub-pixel rounding', () => {
    expect(overflowState(500, 400, 900)).toEqual({ start: true, end: false })
    expect(overflowState(499.4, 400, 900)).toEqual({ start: true, end: false })
  })
})

describe('scrollToReveal', () => {
  it('leaves the scroll alone when the tab is fully visible', () => {
    expect(scrollToReveal(100, 400, 150, 300, 8)).toBe(100)
  })
  it('scrolls left to a tab hidden on the left, never below 0', () => {
    expect(scrollToReveal(300, 400, 200, 320, 8)).toBe(192)
    expect(scrollToReveal(300, 400, 3, 120, 8)).toBe(0)
  })
  it('scrolls right to a tab hidden on the right', () => {
    expect(scrollToReveal(0, 400, 380, 520, 8)).toBe(128)
  })
})

describe('wheelScrollsSideways', () => {
  it('takes a vertical wheel only while the strip overflows', () => {
    expect(wheelScrollsSideways(0, 100, true)).toBe(true)
    expect(wheelScrollsSideways(0, 100, false)).toBe(false)
  })
  it('leaves a sideways swipe to the browser', () => {
    expect(wheelScrollsSideways(80, 5, true)).toBe(false)
  })
})
