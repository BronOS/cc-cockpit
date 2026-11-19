import { describe, expect, it } from 'vitest'
import type { PresencePerson, PresenceSnapshot } from '../../src/shared/guests'
import {
  avatarsForTab,
  bannerText,
  colorSlot,
  initialOf,
  lastTypedText,
  newerSnapshot,
  otherPeople,
  personTitle,
  presenceLines,
  selfPersonId
} from '../../src/renderer/guests/presence-model'

const person = (over: Partial<PresencePerson> & { id: string; name: string }): PresencePerson => ({
  role: 'read',
  color: 0,
  state: 'live',
  tabId: null,
  typing: false,
  ...over
})

const snap = (people: PresencePerson[], lastTyped: Record<string, string> = {}, seq = 1): PresenceSnapshot => ({ seq, people, lastTyped })

const OWNER = person({ id: 'owner', name: 'Host', role: 'owner', color: 1, tabId: 't1' })
const ADA = person({ id: 'g-ada', name: 'ada', role: 'read', color: 3, tabId: 't1' })
const BEN = person({ id: 'g-ben', name: 'Ben', role: 'write', color: 9, tabId: 't2', typing: true })

describe('presence on tabs', () => {
  it('shows the others on a tab and leaves this view out: the owner skips owner, a guest skips itself', () => {
    const s = snap([OWNER, ADA, BEN])
    expect(avatarsForTab(s, 't1', selfPersonId(undefined)).map((a) => a.id)).toEqual(['g-ada'])
    expect(avatarsForTab(s, 't1', selfPersonId('g-ada')).map((a) => a.id)).toEqual(['owner'])
    expect(avatarsForTab(s, 't3', 'owner')).toEqual([])
    expect(avatarsForTab(null, 't1', 'owner')).toEqual([])
  })

  it('draws an initial and a palette slot, clamping a stray colour to the first slot', () => {
    const [ada] = avatarsForTab(snap([ADA]), 't1', 'owner')
    expect(ada).toMatchObject({ initial: 'A', color: 3, typing: false, faded: false })
    const [ben] = avatarsForTab(snap([BEN]), 't2', 'owner')
    expect(ben?.color).toBe(0)
    expect(colorSlot(7)).toBe(7)
    expect(colorSlot(-1)).toBe(0)
    expect(colorSlot(2.5)).toBe(0)
  })

  it('takes a whole code point for the initial, and ? for an empty name', () => {
    expect(initialOf('  zoë')).toBe('Z')
    expect(initialOf('😀 smile')).toBe('😀')
    expect(initialOf('   ')).toBe('?')
  })

  it('says who is here, typing or away in the tooltip', () => {
    expect(personTitle(ADA)).toBe('ada (read-only guest) is here')
    expect(personTitle(BEN)).toBe('Ben (guest who can type) is typing')
    expect(personTitle(OWNER)).toBe('Host is here')
    expect(personTitle({ ...ADA, state: 'away' })).toBe('ada (read-only guest) is away')
    expect(avatarsForTab(snap([{ ...ADA, state: 'reconnecting' }]), 't1', 'owner')[0]?.faded).toBe(true)
  })

  it('names who typed last on a tab, not when it was this view itself or the person is gone', () => {
    const s = snap([OWNER, ADA, BEN], { t1: 'owner', t2: 'g-ben', t3: 'g-gone' })
    expect(lastTypedText(s, 't1', 'g-ada')).toBe('Host typed last')
    expect(lastTypedText(s, 't1', 'owner')).toBeUndefined()
    expect(lastTypedText(s, 't2', 'owner')).toBe('Ben typed last')
    expect(lastTypedText(s, 't3', 'owner')).toBeUndefined()
    // An inherited key is not a tab id.
    expect(lastTypedText(s, 'toString', 'owner')).toBeUndefined()
    expect(presenceLines(s, 't2', 'owner')).toEqual(['Ben (guest who can type) is typing', 'Ben typed last'])
  })

  it('lists everyone but this view for the banner', () => {
    expect(otherPeople(snap([OWNER, ADA, BEN]), 'g-ada').map((a) => a.name)).toEqual(['Host', 'Ben'])
  })

  it('keeps the newest snapshot by seq', () => {
    expect(newerSnapshot(null, snap([], {}, 1))).toBe(true)
    expect(newerSnapshot(snap([], {}, 5), snap([], {}, 4))).toBe(false)
    expect(newerSnapshot(snap([], {}, 5), snap([], {}, 6))).toBe(true)
  })

  it('writes the guest banner with the role and the owner name', () => {
    expect(bannerText('read', 'Host')).toBe("Guest · read-only — Host's cc-cockpit")
    expect(bannerText('write', 'Oleg')).toBe("Guest · write — Oleg's cc-cockpit")
  })
})
