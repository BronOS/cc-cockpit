// A guest's view never sizes a terminal by itself (design-guests §8, D-14): ViewSizes.report's explicitOnly mark.
// It is remembered for an explicit take (typing, Fit), never taken by a report, by showing again, as an heir or as a
// fallback, even when it is the key's only view; an owner's view always gets the size first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAKE_DEBOUNCE_MS, ViewSizes } from '../../src/main/views/view-sizes'

const OWNER = 'desktop:1'
const OWNER2 = 'web:1'
const GUEST = 'web:7'

function setup(debounceMs?: number) {
  const applied: string[] = []
  const sizes = new ViewSizes<string>({
    apply: (key, cols, rows) => applied.push(`${key} ${cols}x${rows}`),
    ...(debounceMs === undefined ? {} : { debounceMs })
  })
  return { sizes, applied }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ViewSizes with a guest view (explicitOnly)', () => {
  it('a guest that reports first, even as the only view, never becomes the sizer', () => {
    const { sizes, applied } = setup()
    sizes.report('t', GUEST, 40, 10, true)
    sizes.report('t', GUEST, 42, 11, true)
    expect(sizes.sizerOf('t')).toBeUndefined()
    expect(applied).toEqual([])
    // Remembered for its explicit take.
    expect(sizes.sizeOf('t', GUEST)).toEqual({ cols: 42, rows: 11 })
  })

  it("an owner's view keeps the size when a guest reports; the guest's resizes are only remembered", () => {
    const { sizes, applied } = setup()
    sizes.report('t', OWNER, 120, 40)
    sizes.report('t', GUEST, 40, 10, true)
    sizes.report('t', GUEST, 41, 10, true)
    expect(sizes.sizerOf('t')).toBe(OWNER)
    expect(applied).toEqual(['t 120x40'])
  })

  it('the guest mark is sticky: a later plain report from the same view is still a guest', () => {
    const { sizes, applied } = setup()
    sizes.report('t', GUEST, 40, 10, true)
    sizes.report('t', GUEST, 44, 12)
    expect(sizes.sizerOf('t')).toBeUndefined()
    expect(applied).toEqual([])
  })

  it('showing again does not make a guest the sizer', () => {
    const { sizes, applied } = setup()
    sizes.report('t', GUEST, 40, 10, true)
    sizes.visible(GUEST, false)
    sizes.visible(GUEST, true)
    expect(sizes.sizerOf('t')).toBeUndefined()
    expect(applied).toEqual([])
    // An owner's view shown again still does.
    sizes.report('t', OWNER, 120, 40)
    sizes.visible(OWNER, false)
    sizes.visible(OWNER, true)
    expect(sizes.sizerOf('t')).toBe(OWNER)
  })

  it('typing takes the size for a guest after the debounce; so does an explicit take (Fit)', () => {
    const a = setup()
    a.sizes.report('t', OWNER, 120, 40)
    a.sizes.report('t', GUEST, 40, 10, true)
    a.sizes.typed('t', GUEST)
    expect(a.sizes.sizerOf('t')).toBe(OWNER)
    vi.advanceTimersByTime(TAKE_DEBOUNCE_MS)
    expect(a.sizes.sizerOf('t')).toBe(GUEST)
    expect(a.applied).toEqual(['t 120x40', 't 40x10'])

    const b = setup()
    b.sizes.report('t', OWNER, 120, 40)
    b.sizes.report('t', GUEST, 40, 10, true)
    expect(b.sizes.take('t', GUEST)).toBe(true)
    expect(b.applied).toEqual(['t 120x40', 't 40x10'])
  })

  it('typing by a lone guest takes the size at once when the debounce is 0', () => {
    const { sizes, applied } = setup(0)
    sizes.report('t', GUEST, 40, 10, true)
    sizes.typed('t', GUEST)
    expect(sizes.sizerOf('t')).toBe(GUEST)
    expect(applied).toEqual(['t 40x10'])
  })

  it('when the sizing owner leaves, the size goes to another owner view, never to a guest', () => {
    const { sizes, applied } = setup()
    sizes.report('t', OWNER, 120, 40)
    sizes.report('t', GUEST, 40, 10, true) // the guest is the most recent reporter
    sizes.report('t', OWNER2, 100, 30)
    sizes.report('t', GUEST, 41, 10, true)
    sizes.viewGone(OWNER)
    expect(sizes.sizerOf('t')).toBe(OWNER2)
    expect(applied).toEqual(['t 120x40', 't 100x30'])
  })

  it('when the only owner view leaves with a lone guest left, nobody sizes and the pty keeps its size', () => {
    const { sizes, applied } = setup()
    sizes.report('t', OWNER, 120, 40)
    sizes.report('t', GUEST, 40, 10, true)
    sizes.viewGone(OWNER)
    expect(sizes.sizerOf('t')).toBeUndefined()
    expect(applied).toEqual(['t 120x40'])
    // A hidden sizer falls back the same way: only the guest remains visible.
    const b = setup()
    b.sizes.report('t', OWNER, 120, 40)
    b.sizes.report('t', GUEST, 40, 10, true)
    b.sizes.visible(OWNER, false)
    expect(b.sizes.sizerOf('t')).toBeUndefined()
    expect(b.applied).toEqual(['t 120x40'])
  })

  it('an owner view that reports after the guest took nothing becomes the sizer', () => {
    const { sizes, applied } = setup()
    sizes.report('t', GUEST, 40, 10, true)
    sizes.report('t', OWNER, 120, 40)
    expect(sizes.sizerOf('t')).toBe(OWNER)
    expect(applied).toEqual(['t 120x40'])
  })
})
