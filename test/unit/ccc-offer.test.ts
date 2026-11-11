import { describe, expect, it } from 'vitest'
import type { CccCommandState } from '../../src/shared/ipc'
import { CccOffer, shouldOfferCcc } from '../../src/main/hooks/ccc-offer'

const base = { testRun: false, forcedByTest: false, enabled: true, state: 'missing' as CccCommandState }

describe('shouldOfferCcc', () => {
  it('offers when the link is missing', () => {
    expect(shouldOfferCcc(base)).toBe(true)
  })
  it('does not offer when installed and current', () => {
    expect(shouldOfferCcc({ ...base, state: 'installed' })).toBe(false)
  })
  it('does not offer for something else at the path (stale link, own file): the install would be refused', () => {
    expect(shouldOfferCcc({ ...base, state: 'foreign' })).toBe(false)
  })
  it('does not offer after "Don\'t ask again"', () => {
    expect(shouldOfferCcc({ ...base, enabled: false })).toBe(false)
  })
  it('never offers in server mode (its modal left the hidden page inert), forced by a test or not', () => {
    expect(shouldOfferCcc({ ...base, server: true })).toBe(false)
    expect(shouldOfferCcc({ ...base, server: true, testRun: true, forcedByTest: true })).toBe(false)
    expect(new CccOffer({ server: true, testRun: false, forcedByTest: false, enabled: () => true, state: () => 'missing' }).claim()).toBe(false)
  })
  it('does not offer in a test run unless the test asks', () => {
    expect(shouldOfferCcc({ ...base, testRun: true })).toBe(false)
    expect(shouldOfferCcc({ ...base, testRun: true, forcedByTest: true })).toBe(true)
  })
})

describe('CccOffer', () => {
  const make = (state: () => CccCommandState, enabled = () => true): CccOffer =>
    new CccOffer({ testRun: false, forcedByTest: false, enabled, state })

  it('answers the first asker only, once per launch', () => {
    const offer = make(() => 'missing')
    expect(offer.claim()).toBe(true)
    expect(offer.claim()).toBe(false)
  })
  it('spends the claim even when nothing is offered', () => {
    let state: CccCommandState = 'installed'
    const offer = make(() => state)
    expect(offer.claim()).toBe(false)
    state = 'missing'
    expect(offer.claim()).toBe(false)
  })
  it('does not offer when the link cannot be inspected', () => {
    expect(make(() => { throw new Error('EACCES') }).claim()).toBe(false)
  })
  it('reads the setting at the claim', () => {
    expect(make(() => 'missing', () => false).claim()).toBe(false)
  })
})
