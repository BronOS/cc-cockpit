// The owner's Live chip and guest list (design-guests §10, acceptance 2; D-11, spec-review 10, 23),
// DOM-free so unit tests run it: which guests a window lists, each row's texts and actions, and the
// downgrade warning. Every name and title here is plain text (the owner's typed guest names, main's
// clamped page titles): React text nodes only.

import type { GuestView, PresenceSnapshot } from '../../shared/guests'
import type { GuestRole } from '../../shared/views'
import { personOf } from './presence-model'

/** This window's project's guests and invites (`guests.list` answers every project's). */
export function projectGuests(guests: readonly GuestView[] | null, projectId: string | undefined): GuestView[] {
  if (guests === null || projectId === undefined) return []
  return guests.filter((g) => g.projectId === projectId)
}

/** What the top bar shows for guests: nothing, the Share button (Invite… with no guest yet), or the Live chip. */
export type LiveChipState = { kind: 'none' } | { kind: 'share' } | { kind: 'live'; text: string; live: number; title: string }

/**
 * The chip from this project's guests. With none, a small Share button while this view may invite
 * (`canInvite`: the desktop page, or a server's browser behind an armed confirm, D-11) and web access
 * is on, sign-in None included: there the dialog says why it cannot invite (D-1), which a hidden button
 * could not. Else nothing, so a window with web access off looks as it always did. With guests or
 * invites, "Live" (with the count of guests here now when any), whatever this owner view may widen:
 * every owner view may narrow (kick, revoke, read-only).
 */
export function liveChip(guests: readonly GuestView[], canInvite: boolean, webOn: boolean): LiveChipState {
  if (guests.length === 0) return canInvite && webOn ? { kind: 'share' } : { kind: 'none' }
  const live = guests.filter((g) => g.state === 'live').length
  const pending = guests.filter((g) => g.state === 'pending').length
  const joined = guests.length - pending
  const parts = [`${joined} ${joined === 1 ? 'guest' : 'guests'}, ${live} here`]
  if (pending > 0) parts.push(`${pending} ${pending === 1 ? 'invite' : 'invites'} not used yet`)
  return { kind: 'live', text: live > 0 ? `Live · ${live}` : 'Live', live, title: parts.join('; ') }
}

/** A row's state as words. */
export function stateText(state: GuestView['state']): string {
  switch (state) {
    case 'pending':
      return 'Invited, not joined yet'
    case 'live':
      return 'Here'
    case 'away':
      return 'Away'
    case 'offline':
      return 'Offline'
  }
}

/** A span of time as words, rounded up so "ends in" never says 0: "45 min", "5 h", "6 days". */
export function spanText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.ceil(minutes / 60)
  if (hours < 48) return `${hours} h`
  const days = Math.ceil(hours / 24)
  return `${days} days`
}

/** When a guest's access ends, or its invite expires (a pending row), relative to `now`. */
export function untilText(guest: GuestView, now: number): string {
  if (guest.state === 'pending') {
    return guest.inviteExpiresAt === undefined ? 'Invite not used yet' : `Invite expires in ${spanText(guest.inviteExpiresAt - now)}`
  }
  if (guest.until === null) return 'Until removed'
  return guest.until <= now ? 'Ending' : `Ends in ${spanText(guest.until - now)}`
}

/** One row of the guest list. */
export interface GuestRow {
  id: string
  name: string
  role: GuestRole
  roleText: string
  stateText: string
  untilText: string
  /** The tab the guest looks at (presence), by its label; undefined when none or not here. */
  tabText: string | undefined
  typing: boolean
  /** "All tabs" or "3 tabs": what the guest was given. */
  scopeText: string
  /** A pending invite is revoked (`guests.revokeInvite`), a guest kicked (`guests.kick`). */
  end: { kind: 'revoke'; inviteId: string; label: string } | { kind: 'kick'; label: string }
  /** The role switch: read-only always (narrowing); Write only where this view may widen (D-11). */
  canWrite: boolean
}

/**
 * The rows of the guest list. `labelOf` names a tab id (the strip's label; undefined for a tab this
 * view does not know). `canWiden`: the desktop page, or a server's owner browser (D-11); an owner
 * browser of a desktop host may only narrow, so it has no Write switch (main would refuse it).
 */
export function guestRows(
  guests: readonly GuestView[],
  presence: PresenceSnapshot | null,
  labelOf: (tabId: string) => string | undefined,
  now: number,
  canWiden: boolean
): GuestRow[] {
  return guests.map((g) => {
    const person = g.state === 'pending' ? undefined : personOf(presence, g.id)
    const tabId = person?.tabId ?? null
    const end: GuestRow['end'] =
      g.state === 'pending' && g.inviteId !== undefined
        ? { kind: 'revoke', inviteId: g.inviteId, label: 'Revoke invite' }
        : { kind: 'kick', label: 'Kick' }
    return {
      id: g.id,
      name: g.name,
      role: g.role,
      roleText: g.role === 'read' ? 'Read-only' : 'Write',
      stateText: stateText(g.state),
      untilText: untilText(g, now),
      tabText: tabId === null ? undefined : (labelOf(tabId) ?? 'a tab'),
      typing: person?.typing === true,
      scopeText: g.scope === 'all' ? 'All tabs' : `${g.scope.length} ${g.scope.length === 1 ? 'tab' : 'tabs'}`,
      end,
      canWrite: canWiden || g.role === 'write'
    }
  })
}

/** At most this many titles are named in the downgrade warning; the rest are counted. */
const NAMED_TITLES = 3

/** "a.ts", "a.ts and b.ts", "a.ts, b.ts, c.ts and 2 more". */
export function titleList(titles: readonly string[]): string {
  const named = titles.slice(0, NAMED_TITLES)
  const more = titles.length - named.length
  if (more > 0) return `${named.join(', ')} and ${more} more`
  if (named.length > 1) return `${named.slice(0, -1).join(', ')} and ${named.at(-1)!}`
  return named[0] ?? ''
}

/**
 * Spec-review 10: switching a write guest to read-only reconnects it under the new role, which drops
 * its unsaved page edits, so the owner is told first. Undefined when there is nothing to lose (the
 * switch is made at once).
 */
export function downgradeWarning(guest: GuestView): string | undefined {
  const titles = guest.unsaved ?? []
  if (guest.role !== 'write' || titles.length === 0) return undefined
  return `${guest.name} has unsaved changes in ${titleList(titles)}; making them read-only loses them.`
}

/** The armed confirm's question for an upgrade to write (D-11). */
export function upgradeTitle(name: string): string {
  return `Let ${name} type in shared tabs?`
}
