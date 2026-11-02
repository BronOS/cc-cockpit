// The one path containment check (src/main/path-within.ts) the plugin, skill and preview folder
// rules share.
import { describe, expect, it } from 'vitest'
import { within } from '../../src/main/path-within'

describe('within', () => {
  it('is true for the folder itself and anything below it', () => {
    expect(within('/a/b', '/a/b')).toBe(true)
    expect(within('/a/b', '/a/b/c')).toBe(true)
    expect(within('/a/b/', '/a/b/c/d')).toBe(true)
  })

  it('is false for a sibling sharing the prefix, the parent and another tree', () => {
    expect(within('/a/b', '/a/bc')).toBe(false)
    expect(within('/a/b', '/a')).toBe(false)
    expect(within('/a/b', '/x/b')).toBe(false)
  })

  it('takes a name starting with two dots as a name, not as a step up', () => {
    expect(within('/a', '/a/..b')).toBe(true)
  })
})
