import { describe, expect, it } from 'vitest'
import { installTestHooks, TEST_HOOKS_GLOBAL } from '../../src/main/test-hooks'

describe('installTestHooks', () => {
  it('publishes hooks on the target under the well-known global name', () => {
    const target: Record<string, unknown> = {}
    installTestHooks({ answer: () => 42 }, target)
    const hooks = target[TEST_HOOKS_GLOBAL] as Record<string, () => number>
    expect(hooks.answer?.()).toBe(42)
  })

  it('lets a later task add more hooks beside the first ones', () => {
    const target: Record<string, unknown> = {}
    installTestHooks({ a: () => 1 }, target)
    installTestHooks({ b: () => 2 }, target)
    expect(Object.keys(target[TEST_HOOKS_GLOBAL] as object).sort()).toEqual(['a', 'b'])
  })

  it('refuses a name that is already taken rather than shadowing it', () => {
    const target: Record<string, unknown> = {}
    installTestHooks({ a: () => 1 }, target)
    expect(() => installTestHooks({ a: () => 2 }, target)).toThrow(/already installed/)
    expect((target[TEST_HOOKS_GLOBAL] as Record<string, () => number>).a?.()).toBe(1)
  })
})
