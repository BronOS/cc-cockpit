import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GUEST_LIFETIME,
  GUEST_LIFETIME_MS,
  guestLifetimeOf,
  guestRoleOf,
  guestScopeOf,
  guestUntil,
  inScope,
  INVITE_ATTEMPT_CAPACITY,
  INVITE_ATTEMPT_DELAY_MS,
  INVITE_ATTEMPT_MAX_WAITING,
  INVITE_ATTEMPT_REFILL_MS,
  INVITE_UNUSED_MS,
  MAX_GUEST_TABS,
  MAX_SCOPE_TABS,
  viewAccessOf
} from '../../src/shared/guests'
import { AttemptLimiter } from '../../src/main/web/auth'
import type { DeviceSignIn } from '../../src/main/web/devices'
import { isOwnerWho } from '../../src/shared/views'

// design-guests §2, §3, §16.1; D-12, D-19, D-21.

describe('guest records', () => {
  it('fixes the numbers the design names', () => {
    expect(INVITE_UNUSED_MS).toBe(24 * 3600_000)
    expect(MAX_GUEST_TABS).toBe(4)
    expect(DEFAULT_GUEST_LIFETIME).toBe('1d')
    expect(GUEST_LIFETIME_MS).toEqual({ '1d': 86_400_000, '7d': 604_800_000, forever: null })
  })

  it('inScope: all is every tab, a list only its own', () => {
    expect(inScope('all', 'anything')).toBe(true)
    expect(inScope(['a', 'b'], 'b')).toBe(true)
    expect(inScope(['a', 'b'], 'c')).toBe(false)
    expect(inScope([], 'a')).toBe(false)
  })

  it('reads a scope from untrusted input: all, or distinct bounded ids', () => {
    expect(guestScopeOf('all')).toBe('all')
    expect(guestScopeOf(['a', 'b', 'a'])).toEqual(['a', 'b'])
    expect(guestScopeOf([])).toEqual([])
    for (const bad of ['ALL', 'a', null, undefined, {}, [1], [''], ['x'.repeat(129)], Array.from({ length: MAX_SCOPE_TABS + 1 }, (_, i) => `t${i}`)]) {
      expect(guestScopeOf(bad), JSON.stringify(bad)?.slice(0, 40)).toBeUndefined()
    }
  })

  it('reads roles and lifetimes from untrusted input', () => {
    expect(guestRoleOf('read')).toBe('read')
    expect(guestRoleOf('write')).toBe('write')
    expect(guestRoleOf('owner')).toBeUndefined()
    expect(guestLifetimeOf('7d')).toBe('7d')
    expect(guestLifetimeOf('forever')).toBe('forever')
    expect(guestLifetimeOf('toString')).toBeUndefined()
    expect(guestLifetimeOf(1)).toBeUndefined()
  })

  it('counts a lifetime from the redeem; forever never ends by itself', () => {
    expect(guestUntil('1d', 1000)).toBe(1000 + 86_400_000)
    expect(guestUntil('forever', 1000)).toBeNull()
  })

  it('maps access to what plugins learn; revoked has none', () => {
    expect(viewAccessOf({ kind: 'owner' })).toBe('owner')
    expect(viewAccessOf({ kind: 'guest', id: 'g', name: 'Bob', role: 'read', projectId: 'p', scope: 'all' })).toBe('read')
    expect(viewAccessOf({ kind: 'revoked' })).toBeUndefined()
    expect(isOwnerWho('owner')).toBe(true)
    expect(isOwnerWho({ guest: 'g' })).toBe(false)
  })

  it('declares the guest sign-in mode for task 02 (devices.ts recordOf does not take it yet)', () => {
    const mode: DeviceSignIn = 'guest'
    expect(mode).toBe('guest')
  })
})

describe('D-19: the invite bucket is its own', () => {
  it('a drained invite bucket leaves the owner sign-in bucket at full speed', async () => {
    let now = 0
    const sleeps: number[] = []
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms)
      now += ms
    }
    const invites = new AttemptLimiter({
      capacity: INVITE_ATTEMPT_CAPACITY,
      refillMs: INVITE_ATTEMPT_REFILL_MS,
      delayMs: INVITE_ATTEMPT_DELAY_MS,
      maxWaiting: INVITE_ATTEMPT_MAX_WAITING,
      now: () => now,
      sleep
    })
    const owner = new AttemptLimiter({ now: () => now, sleep })
    for (let i = 0; i < INVITE_ATTEMPT_CAPACITY + 3; i++) await invites.run(() => ({ ok: false }))
    expect(sleeps.length).toBeGreaterThan(0)
    const before = sleeps.length
    expect(await owner.run(() => ({ ok: true }))).toEqual({ ok: true })
    expect(sleeps.length).toBe(before)
  })
})
