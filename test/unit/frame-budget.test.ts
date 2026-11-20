import { describe, expect, it } from 'vitest'
import { ANIMATING_PAINTS, FRAME_RATE_FLOOR, FRAME_RATE_MAX, FrameBudget } from '../../src/main/webview/frame-budget'

const BUDGET = 100_000_000

function setup() {
  let t = 1000
  const budget = new FrameBudget(() => t, BUDGET)
  const rates = new Map<string, number>()
  const add = (id: string, w: number, h: number): void => {
    rates.set(id, FRAME_RATE_MAX)
    budget.add(id, { setRate: (r) => rates.set(id, r) }, w, h)
    budget.setViewed(id, true)
  }
  /** `paints` paints spread over the next second, then an evaluation. */
  const animate = (ids: string[], paints = 10): void => {
    for (let i = 0; i < paints; i++) {
      t += 1000 / paints
      for (const id of ids) budget.paint(id)
    }
    budget.evaluate()
  }
  return { budget, rates, add, animate, advance: (ms: number) => (t += ms) }
}

describe('FrameBudget', () => {
  it('leaves pages alone while the sum fits', () => {
    const s = setup()
    s.add('a', 1000, 1000)
    s.animate(['a'])
    expect(s.rates.get('a')).toBe(FRAME_RATE_MAX)
  })

  it('lowers every animating page to one shared rate that fits the budget', () => {
    const s = setup()
    for (const id of ['a', 'b', 'c', 'd']) s.add(id, 1000, 1000)
    s.animate(['a', 'b', 'c', 'd'])
    expect(s.rates.get('a')).toBe(25) // 100M / 4M px
    expect(s.rates.get('d')).toBe(25)
  })

  it('never goes below the floor', () => {
    const s = setup()
    const ids = Array.from({ length: 12 }, (_, i) => 'p' + i)
    for (const id of ids) s.add(id, 4000, 4000)
    s.animate(ids)
    expect(s.rates.get('p0')).toBe(FRAME_RATE_FLOOR)
  })

  it('counts only animating pages, and restores when they stop', () => {
    const s = setup()
    s.add('a', 4000, 1000)
    s.add('b', 4000, 1000)
    s.add('idle', 4000, 4000)
    s.animate(['a', 'b'])
    expect(s.rates.get('a')).toBe(12)
    expect(s.rates.get('idle')).toBe(FRAME_RATE_MAX)
    s.advance(2000)
    s.animate(['a'])
    expect(s.rates.get('a')).toBe(25)
    expect(s.rates.get('b')).toBe(FRAME_RATE_MAX)
  })

  it('restores when a page closes or stops being viewed', () => {
    const s = setup()
    s.add('a', 4000, 1000)
    s.add('b', 4000, 1000)
    s.animate(['a', 'b'])
    s.budget.setViewed('b', false)
    s.budget.evaluate()
    expect(s.rates.get('a')).toBe(25)
    s.budget.remove('b')
    s.animate(['a'])
    expect(s.rates.get('a')).toBe(25)
  })

  it('ignores paints of a page nobody views and calls setRate only on change', () => {
    const s = setup()
    s.add('a', 1000, 1000)
    s.budget.setViewed('a', false)
    for (let i = 0; i < ANIMATING_PAINTS + 2; i++) s.budget.paint('a')
    s.budget.evaluate()
    expect(s.rates.get('a')).toBe(FRAME_RATE_MAX)
  })

  it('follows a resize', () => {
    const s = setup()
    s.add('a', 1000, 1000)
    s.animate(['a'])
    s.budget.resize('a', 4000, 1000)
    s.animate(['a'])
    expect(s.rates.get('a')).toBe(25)
  })
})
