// Presence on tabs and in the guest banner (design-guests §10, §16.7), DOM-free so unit tests run it
// in plain Node. Main sends whole snapshots (`presence.changed`, at most 4 a second), already
// filtered for a guest view (a tab it cannot see reads `tabId: null`); this only decides what one
// view draws from one snapshot. Every name is plain text (an owner's typed guest name, the owner's
// D-24 setting): React text nodes and `title` attributes only, never markup.

import type { PresencePerson, PresenceSnapshot } from '../../shared/guests'
import type { GuestRole, ViewAccess } from '../../shared/views'

/** The presence palette's size: `PresencePerson.color` is an index into it (styles.css `.guest-avatar[data-color]`). */
export const PRESENCE_COLORS = 8

/** The owner's person id in presence (every owner device is one person). */
export const OWNER_PERSON_ID = 'owner'

/**
 * This view's own person id: the owner's, or the guest's from the shell's hint. Used only to leave
 * yourself out of what you are shown (a wrong hint costs a missing or an extra avatar, nothing more).
 */
export function selfPersonId(guestId: string | undefined): string {
  return guestId ?? OWNER_PERSON_ID
}

/** A palette slot from main's index, clamped: a stray value draws the first colour, never no colour. */
export function colorSlot(color: number): number {
  return Number.isInteger(color) && color >= 0 && color < PRESENCE_COLORS ? color : 0
}

/**
 * The avatar's letter: the name's first character (a whole code point, so an emoji or a CJK name is
 * not cut in half), upper-cased; '?' for an empty name.
 */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0]
  return first === undefined ? '?' : first.toUpperCase()
}

/** How a person's role reads in a tooltip: the owner by name alone, a guest with its role. */
export function roleWords(role: ViewAccess): string {
  if (role === 'read') return ' (read-only guest)'
  if (role === 'write') return ' (guest who can type)'
  return ''
}

/** "Ada (read-only guest) is here", "... is typing", "... is away". */
export function personTitle(person: PresencePerson): string {
  const what = person.typing ? 'is typing' : person.state === 'live' ? 'is here' : person.state === 'away' ? 'is away' : 'is reconnecting'
  return `${person.name}${roleWords(person.role)} ${what}`
}

/** One avatar on a tab or in the banner. */
export interface PresenceAvatar {
  id: string
  name: string
  initial: string
  color: number
  typing: boolean
  /** Not live (away, reconnecting): drawn faded. */
  faded: boolean
  title: string
}

function avatarOf(person: PresencePerson): PresenceAvatar {
  return {
    id: person.id,
    name: person.name,
    initial: initialOf(person.name),
    color: colorSlot(person.color),
    typing: person.typing,
    faded: person.state !== 'live',
    title: personTitle(person)
  }
}

/** The people (other than this view's own person) who look at `tabId`, in the snapshot's order. */
export function avatarsForTab(snapshot: PresenceSnapshot | null, tabId: string, selfId: string): PresenceAvatar[] {
  if (!snapshot) return []
  return snapshot.people.filter((p) => p.id !== selfId && p.tabId === tabId).map(avatarOf)
}

/**
 * "Ada typed last" for a tab, from `lastTyped` (D-7: no turn-taking, presence says who typed last).
 * Undefined when nobody did, when it was this view's own person, or when the person left the snapshot.
 */
export function lastTypedText(snapshot: PresenceSnapshot | null, tabId: string, selfId: string): string | undefined {
  if (!snapshot) return undefined
  const id = Object.hasOwn(snapshot.lastTyped, tabId) ? snapshot.lastTyped[tabId] : undefined
  if (id === undefined || id === selfId) return undefined
  const person = snapshot.people.find((p) => p.id === id)
  return person ? `${person.name} typed last` : undefined
}

/** The tooltip lines presence adds to a tab: who is here (or typing), then who typed last. */
export function presenceLines(snapshot: PresenceSnapshot | null, tabId: string, selfId: string): string[] {
  const lines = avatarsForTab(snapshot, tabId, selfId).map((a) => a.title)
  const last = lastTypedText(snapshot, tabId, selfId)
  if (last !== undefined) lines.push(last)
  return lines
}

/** Everyone but this view's own person, for the guest banner and the owner's list. */
export function otherPeople(snapshot: PresenceSnapshot | null, selfId: string): PresenceAvatar[] {
  if (!snapshot) return []
  return snapshot.people.filter((p) => p.id !== selfId).map(avatarOf)
}

/** One person's presence by id (the owner's guest list reads a guest's tab and typing from it). */
export function personOf(snapshot: PresenceSnapshot | null, id: string): PresencePerson | undefined {
  return snapshot?.people.find((p) => p.id === id)
}

/** The guest banner (spec-review 24): "Guest · read-only — Host's cc-cockpit". */
export function bannerText(role: GuestRole, ownerName: string): string {
  return `Guest · ${role === 'read' ? 'read-only' : 'write'} — ${ownerName}'s cc-cockpit`
}

/**
 * Whether a snapshot is newer than the one held: `seq` counts up per snapshot, so a `presence.get`
 * answer that lands after an event (or two events out of order) is dropped.
 */
export function newerSnapshot(held: PresenceSnapshot | null, next: PresenceSnapshot): boolean {
  return held === null || next.seq > held.seq
}
