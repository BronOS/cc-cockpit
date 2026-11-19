// The owner's name for guests (D-24): default "Host", plain one-line text, at most 60 characters, saved
// as a patch with ownerName alone (spec-review 23: the name-only patch a server's browser may send).
import { describe, expect, it } from 'vitest'
import type { WebAccessView } from '../../src/shared/web-access'
import {
  DEFAULT_OWNER_NAME,
  NONE_GUESTS_NOTE,
  OWNER_NAME_MAX,
  ownerNameOf,
  ownerNamePatch,
  ownerNameProblem
} from '../../src/renderer/settings/web-access-model'

const ch = (cp: number): string => String.fromCodePoint(cp)

function view(ownerName?: string): WebAccessView {
  const v = {
    form: { enabled: true, bind: '127.0.0.1', port: 7777, externalOrigin: '', hosts: [], mode: 'link', certPath: '', keyPath: '' },
    network: false,
    gateway: { state: 'off' },
    devices: [],
    risks: [],
    passwordSet: false,
    passwordMinLength: 8,
    passwordShort: false,
    credentials: { accessLink: 'set', password: 'unset' }
  } as WebAccessView
  return ownerName === undefined ? v : ({ ...v, ownerName } as WebAccessView)
}

describe('ownerNameOf', () => {
  it('defaults to Host when main sends none (or a blank one)', () => {
    expect(DEFAULT_OWNER_NAME).toBe('Host')
    expect(ownerNameOf(view())).toBe('Host')
    expect(ownerNameOf(view('  '))).toBe('Host')
    expect(ownerNameOf(view('Oleg'))).toBe('Oleg')
  })
})

describe('ownerNameProblem', () => {
  it('takes 60 characters, counted by code point, not 61', () => {
    expect(OWNER_NAME_MAX).toBe(60)
    expect(ownerNameProblem('a'.repeat(60))).toBeUndefined()
    expect(ownerNameProblem('a'.repeat(61))).toBe('Use at most 60 characters.')
    // 60 astral characters are 120 UTF-16 units: still 60.
    expect(ownerNameProblem(ch(0x1f600).repeat(60))).toBeUndefined()
    // e + combining acute is one character after NFC.
    expect(ownerNameProblem(('e' + ch(0x301)).repeat(60))).toBeUndefined()
  })
  it('refuses line breaks and control characters, keeps punctuation', () => {
    for (const cp of [0x0a, 0x07, 0x7f, 0x85, 0x2028, 0x2029]) expect(ownerNameProblem(`Ann${ch(cp)}Bob`)).toBeDefined()
    expect(ownerNameProblem("O'Neil (host) - <b>")).toBeUndefined()
  })
  it('measures the trimmed name', () => {
    expect(ownerNameProblem(`  ${'a'.repeat(60)}  `)).toBeUndefined()
  })
})

describe('ownerNamePatch', () => {
  it('sends exactly the ownerName key', () => {
    const r = ownerNamePatch(view(), ' Oleg ')
    expect(r).toEqual({ patch: { ownerName: 'Oleg' } })
    if (r !== null && 'patch' in r) expect(Object.keys(r.patch)).toEqual(['ownerName'])
  })
  it('is null when nothing changes, a blank name included while it is the default', () => {
    expect(ownerNamePatch(view('Oleg'), 'Oleg')).toBeNull()
    expect(ownerNamePatch(view(), '')).toBeNull()
    expect(ownerNamePatch(view(), 'Host')).toBeNull()
  })
  it('a blank name goes back to the default', () => {
    expect(ownerNamePatch(view('Oleg'), '   ')).toEqual({ patch: { ownerName: 'Host' } })
  })
  it('carries the problem instead of a patch', () => {
    expect(ownerNamePatch(view(), 'a'.repeat(61))).toEqual({ error: 'Use at most 60 characters.' })
  })
})

describe('the card under sign-in None (D-1, Q3)', () => {
  it('says in one line that inviting guests needs a sign-in mode', () => {
    expect(NONE_GUESTS_NOTE).toBe('Inviting guests needs a sign-in mode.')
  })
})
