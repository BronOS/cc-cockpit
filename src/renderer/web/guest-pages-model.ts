// The web client's guest pages (design-guests §3, §10, §16.4; decisions D-29, D-32): the texts a
// guest's browser shows when an invite does not work, when its access ended, and where a signed-in
// guest lands. DOM-free so unit tests run it in plain Node (sign-in.ts, bridge.ts and main.tsx use it).
//
// Every right here is main's: a guest page that showed a picker link would only lead to a 404, and a
// guest whose page did not redirect would get close 4403 at `hello`. These rules spare the person
// dead ends; they decide nothing.
import type { GuestRole } from '../../shared/views'
import { CLOSE, guestCloseText, type WebInviteError } from '../../shared/web-protocol'
import { projectHref } from './picker-model'

/**
 * Why `/auth/invite` did not let this browser in, as the page says it. A closed table: the gateway's
 * own `error` text is never shown (an answer from a proxy or a stranger's page is not trusted text).
 * `full` and `busy` leave the invite unspent, so opening the link again is the way on.
 */
const INVITE_ERROR_TEXT: Readonly<Record<WebInviteError, string>> = Object.freeze({
  used: 'This invite was already used. Ask the host for a new one.',
  expired: 'This invite expired. Ask the host for a new one.',
  invalid: 'This invite link does not work. Check that it was copied whole, or ask the host for a new one.',
  'owner-device': 'This browser is signed in as the host. Open the invite in a private window.',
  'none-mode': 'The host does not take guests right now (web access sign-in is off). Ask the host.',
  busy: 'Too many tries just now. Wait a minute, then open the invite link again.',
  full: 'The host has too many devices signed in. Ask the host to remove one, then open the invite link again.',
  'bad-request': 'This invite link is broken. Ask the host for a new one.'
})

const INVITE_ERRORS = Object.keys(INVITE_ERROR_TEXT) as WebInviteError[]

/** An `/auth/invite` error code from an untrusted answer, else undefined. */
export function inviteErrorOf(value: unknown): WebInviteError | undefined {
  return typeof value === 'string' && (INVITE_ERRORS as string[]).includes(value) ? (value as WebInviteError) : undefined
}

/** The page text for an invite error; undefined (no code the page knows) gets the generic one. */
export function inviteErrorText(error: WebInviteError | undefined): string {
  return error === undefined ? 'The invite did not work. Ask the host for a new one.' : INVITE_ERROR_TEXT[error]
}

/** The redeem post got no answer at all (the host away, the network gone). */
export const INVITE_UNREACHABLE_TEXT = 'The host did not answer. Check the connection, then open the invite link again.'

/**
 * A guest's cookie whose guest ended (kicked, its lifetime over; `WebSessionReply.guestEnded`, D-32),
 * or a guest page that finds itself signed out: never the owner's sign-in form, never a picker link.
 */
export const GUEST_ENDED_TEXT = 'Your guest access ended. Ask the host for a new invite.'

/** What a guest's page says when its project is not open on the host (4404, 4410 to a guest). */
export const GUEST_PROJECT_CLOSED_TEXT = 'The host closed this project.'

/** The owner's name when the page has no snapshot yet to read it from (a close before the first `ready`). */
export const DEFAULT_OWNER_NAME = 'Host'

/** The signed-in guest as the session answer names it (`WebSessionReply.guest`). */
export interface SessionGuest {
  name: string
  role: GuestRole
  project: string
}

/**
 * Where a signed-in page goes (D-32): a guest never sees the picker and never another project's
 * `hello` (4403): any page that is not its own project's is replaced by it. The owner keeps today's
 * rule: the picker with no `?project=`, else the project.
 */
export type Landing = { go: 'shell' } | { go: 'picker' } | { go: 'redirect'; href: string }

export function landingOf(guest: SessionGuest | undefined, project: string): Landing {
  if (guest !== undefined) return project === guest.project ? { go: 'shell' } : { go: 'redirect', href: projectHref(guest.project) }
  return project === '' ? { go: 'picker' } : { go: 'shell' }
}

/**
 * The text of a guest's final close or a close it reconnects after (shared/web-protocol.ts
 * guestCloseText), with the owner's name the page last had, or the default before any.
 */
export function guestGoneText(code: number, ownerName: string | undefined, role?: GuestRole): string | undefined {
  return guestCloseText(code, ownerName ?? DEFAULT_OWNER_NAME, role)
}

/**
 * The line a guest sees once its page is back after a role switch (4461): only the new `ready`
 * knows the new role, so the text waits for it. Undefined after any other reconnect.
 */
export function reconnectNotice(after: number | undefined, guest: { role: GuestRole; ownerName: string } | undefined): string | undefined {
  if (after !== CLOSE.roleChanged || guest === undefined) return undefined
  return guestCloseText(CLOSE.roleChanged, guest.ownerName, guest.role)
}
