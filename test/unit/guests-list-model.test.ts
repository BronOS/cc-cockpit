import { describe, expect, it } from 'vitest'
import type { GuestView, PresenceSnapshot } from '../../src/shared/guests'
import {
  downgradeWarning,
  guestRows,
  liveChip,
  projectGuests,
  spanText,
  stateText,
  titleList,
  untilText,
  upgradeTitle
} from '../../src/renderer/guests/guest-list-model'

const NOW = 1_000_000_000_000
const H = 3600_000

const guest = (over: Partial<GuestView> & { id: string }): GuestView => ({
  name: over.id,
  role: 'read',
  projectId: 'p1',
  scope: 'all',
  state: 'live',
  until: null,
  ...over
})

describe('the chip', () => {
  it('filters the list to this window project', () => {
    const list = [guest({ id: 'a' }), guest({ id: 'b', projectId: 'p2' })]
    expect(projectGuests(list, 'p1').map((g) => g.id)).toEqual(['a'])
    expect(projectGuests(null, 'p1')).toEqual([])
    expect(projectGuests(list, undefined)).toEqual([])
  })

  it('offers Share only where this view may invite and web access is on', () => {
    expect(liveChip([], true, true)).toEqual({ kind: 'share' })
    expect(liveChip([], true, false)).toEqual({ kind: 'none' })
    expect(liveChip([], false, true)).toEqual({ kind: 'none' })
  })

  it('shows Live with the count of guests here, whatever this view may widen', () => {
    const list = [guest({ id: 'a' }), guest({ id: 'b', state: 'away' }), guest({ id: 'c', state: 'pending', inviteId: 'i' })]
    expect(liveChip(list, false, false)).toEqual({
      kind: 'live',
      text: 'Live · 1',
      live: 1,
      title: '2 guests, 1 here; 1 invite not used yet'
    })
    expect(liveChip([guest({ id: 'c', state: 'pending' })], true, true)).toMatchObject({ text: 'Live', live: 0 })
  })
})

describe('the rows', () => {
  const presence: PresenceSnapshot = {
    seq: 1,
    lastTyped: {},
    people: [
      { id: 'a', name: 'a', role: 'write', color: 0, state: 'live', tabId: 't1', typing: true },
      { id: 'b', name: 'b', role: 'read', color: 1, state: 'live', tabId: 'unknown', typing: false }
    ]
  }
  const labelOf = (id: string): string | undefined => (id === 't1' ? 'Claude · proj' : undefined)

  it('reads tab and typing from presence, and ends a guest with Kick, an invite with Revoke', () => {
    const rows = guestRows(
      [
        guest({ id: 'a', name: 'Ada', role: 'write', until: NOW + 5 * H }),
        guest({ id: 'b', name: 'Ben', scope: ['t1', 't2'] }),
        guest({ id: 'c', name: 'Cy', state: 'pending', inviteId: 'inv', inviteExpiresAt: NOW + 30 * 60_000, scope: ['t1'] })
      ],
      presence,
      labelOf,
      NOW,
      true
    )
    expect(rows[0]).toMatchObject({
      name: 'Ada',
      roleText: 'Write',
      stateText: 'Here',
      untilText: 'Ends in 5 h',
      tabText: 'Claude · proj',
      typing: true,
      scopeText: 'All tabs',
      end: { kind: 'kick', label: 'Kick' },
      canWrite: true
    })
    expect(rows[1]).toMatchObject({ tabText: 'a tab', typing: false, scopeText: '2 tabs', untilText: 'Until removed' })
    expect(rows[2]).toMatchObject({
      stateText: 'Invited, not joined yet',
      untilText: 'Invite expires in 30 min',
      tabText: undefined,
      scopeText: '1 tab',
      end: { kind: 'revoke', inviteId: 'inv', label: 'Revoke invite' }
    })
  })

  it('has no Write where this owner view may only narrow (a browser of a desktop host), but keeps a write guest switchable down', () => {
    const rows = guestRows([guest({ id: 'r' }), guest({ id: 'w', role: 'write' })], null, labelOf, NOW, false)
    expect(rows.map((r) => r.canWrite)).toEqual([false, true])
  })

  it('words states and spans', () => {
    expect(['pending', 'live', 'away', 'offline'].map((s) => stateText(s as GuestView['state']))).toEqual([
      'Invited, not joined yet',
      'Here',
      'Away',
      'Offline'
    ])
    expect(spanText(0)).toBe('1 min')
    expect(spanText(59 * 60_000)).toBe('59 min')
    expect(spanText(47 * H)).toBe('47 h')
    expect(spanText(7 * 24 * H)).toBe('7 days')
    expect(untilText(guest({ id: 'x', until: NOW - 1 }), NOW)).toBe('Ending')
    expect(untilText(guest({ id: 'x', state: 'pending' }), NOW)).toBe('Invite not used yet')
  })
})

describe('switching roles', () => {
  it('warns before a downgrade that loses unsaved page edits, naming them', () => {
    expect(downgradeWarning(guest({ id: 'a', name: 'Ada', role: 'write', unsaved: ['a.ts', 'b.ts'] }))).toBe(
      'Ada has unsaved changes in a.ts and b.ts; making them read-only loses them.'
    )
    expect(downgradeWarning(guest({ id: 'a', role: 'write', unsaved: [] }))).toBeUndefined()
    expect(downgradeWarning(guest({ id: 'a', role: 'write' }))).toBeUndefined()
    expect(downgradeWarning(guest({ id: 'a', role: 'read', unsaved: ['a.ts'] }))).toBeUndefined()
  })

  it('names at most three titles', () => {
    expect(titleList(['a'])).toBe('a')
    expect(titleList(['a', 'b', 'c'])).toBe('a, b and c')
    expect(titleList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more')
  })

  it('asks before an upgrade', () => {
    expect(upgradeTitle('Ada')).toBe('Let Ada type in shared tabs?')
  })
})
