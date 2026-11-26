// Task 14 (shared/design-parts.md §4): the parts' layout in their window (src/renderer/overlays/part-split.ts).
import { describe, expect, it } from 'vitest'
import {
  clampPartFraction,
  dragPartFraction,
  loadPartFraction,
  OPENER_MIN,
  PART_DEFAULT,
  PART_MAX,
  PART_MIN,
  PART_SPLIT_KEY_PREFIX,
  partShares,
  partSplitMode,
  savePartFraction,
  type PartStorage
} from '../../src/renderer/overlays/part-split'

function memory(): PartStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('part-split', () => {
  it('fraction clamped 25-60%; storage that throws gives the default', () => {
    expect([PART_DEFAULT, PART_MIN, PART_MAX]).toEqual([0.4, 0.25, 0.6])
    expect(clampPartFraction(0.1)).toBe(0.25)
    expect(clampPartFraction(0.9)).toBe(0.6)
    expect(clampPartFraction(0.33)).toBe(0.33)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '0.5', null, undefined]) expect(clampPartFraction(bad), String(bad)).toBe(PART_DEFAULT)
    // Remembered per (opener, part plugin), on this device.
    const s = memory()
    savePartFraction(() => s, 'g.mail', 'j.jira', 0.5)
    expect(loadPartFraction(() => s, 'g.mail', 'j.jira')).toBe(0.5)
    expect(loadPartFraction(() => s, 'c.cal', 'j.jira')).toBe(PART_DEFAULT)
    expect([...s.data.keys()]).toEqual([`${PART_SPLIT_KEY_PREFIX}g.mail|j.jira`])
    // A stored value out of range or not a number (another build, a hand edit) is clamped or the default.
    s.data.set(`${PART_SPLIT_KEY_PREFIX}g.mail|j.jira`, '0.95')
    expect(loadPartFraction(() => s, 'g.mail', 'j.jira')).toBe(PART_MAX)
    s.data.set(`${PART_SPLIT_KEY_PREFIX}g.mail|j.jira`, 'wide')
    expect(loadPartFraction(() => s, 'g.mail', 'j.jira')).toBe(PART_DEFAULT)
    // Storage that throws (blocked site data: even reading localStorage throws) or is missing.
    const throwing = (): PartStorage => {
      throw new Error('SecurityError')
    }
    const failing: PartStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(loadPartFraction(throwing, 'g.mail', 'j.jira')).toBe(PART_DEFAULT)
    expect(loadPartFraction(() => failing, 'g.mail', 'j.jira')).toBe(PART_DEFAULT)
    expect(loadPartFraction(() => undefined, 'g.mail', 'j.jira')).toBe(PART_DEFAULT)
    expect(() => savePartFraction(throwing, 'g.mail', 'j.jira', 0.5)).not.toThrow()
    expect(() => savePartFraction(() => failing, 'g.mail', 'j.jira', 0.5)).not.toThrow()
  })

  it('stacked below 1280, switch below 700', () => {
    expect(partSplitMode(1920)).toBe('side')
    expect(partSplitMode(1280)).toBe('side')
    expect(partSplitMode(1279)).toBe('stacked')
    expect(partSplitMode(700)).toBe('stacked')
    expect(partSplitMode(699)).toBe('switch')
    expect(partSplitMode(320)).toBe('switch')
    // Not measured yet: drawn wide until the first measure.
    expect(partSplitMode(Number.POSITIVE_INFINITY)).toBe('side')
    expect(partSplitMode(Number.NaN)).toBe('side')
  })

  it('two parts never leave the opener less than its minimum', () => {
    expect(partShares([0.4])).toEqual([0.4])
    expect(partShares([0.3, 0.3])).toEqual([0.3, 0.3])
    const both = partShares([0.6, 0.6])
    expect(both[0]).toBeCloseTo((1 - OPENER_MIN) / 2)
    expect(1 - both.reduce((a, b) => a + b, 0)).toBeCloseTo(OPENER_MIN)
    // Unknown shares are the default.
    expect(partShares([Number.NaN])).toEqual([PART_DEFAULT])
  })

  it('a divider drag gives the clamped share left of the pointer', () => {
    // A 1000 px body, the pointer at 600 px: the part (the last) takes 40%.
    expect(dragPartFraction(600, 1000, 0)).toBeCloseTo(0.4)
    // The first of two parts, the second at 30%: the first takes what lies between the pointer and the second.
    expect(dragPartFraction(400, 1000, 0.3)).toBeCloseTo(0.3)
    expect(dragPartFraction(10, 1000, 0)).toBe(PART_MAX)
    expect(dragPartFraction(990, 1000, 0)).toBe(PART_MIN)
    expect(dragPartFraction(500, 0, 0)).toBe(PART_DEFAULT)
  })
})
