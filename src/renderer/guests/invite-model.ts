// The owner's invite dialog (design-guests §10, acceptance 1; D-1, D-5, D-12, D-13, D-35), DOM-free so
// unit tests run it: the form's rules, what it sends, and every text it shows. Main checks the request
// again (guests.ts `guestScopeOf`, `guestRoleOf`, `guestLifetimeOf`; the name's uniqueness and the
// caps): this only keeps a form main would refuse from being sent, and says why in plain words.

import {
  DEFAULT_GUEST_LIFETIME,
  GUEST_NAME_MAX,
  INVITE_UNUSED_MS,
  MAX_GUESTS,
  type GuestInviteError,
  type GuestInviteRequest,
  type GuestLifetime
} from '../../shared/guests'
import type { PluginView, TabInfo } from '../../shared/ipc'
import type { WebAccessMode } from '../../shared/types'
import type { GuestRole } from '../../shared/views'
import { tabLabel } from '../tabs/tab-label'

/** The dialog's fields as the person edits them. */
export interface InviteForm {
  name: string
  role: GuestRole
  /** All tabs (now and later) or the ones ticked in `selected`. */
  tabs: 'all' | 'selected'
  /** TabInfo ids. */
  selected: readonly string[]
  lifetime: GuestLifetime
}

/** A fresh form: read-only, all tabs, the default lifetime (D-12: one day). Read-only first: it grants the least. */
export function emptyInviteForm(): InviteForm {
  return { name: '', role: 'read', tabs: 'all', selected: [], lifetime: DEFAULT_GUEST_LIFETIME }
}

/** The lifetime choices' labels (D-12). */
export const LIFETIME_LABEL: Readonly<Record<GuestLifetime, string>> = Object.freeze({
  '1d': '1 day',
  '7d': '7 days',
  forever: 'Until removed'
})

/** The role choices' labels. */
export const ROLE_LABEL: Readonly<Record<GuestRole, string>> = Object.freeze({
  read: 'Read-only',
  write: 'Write'
})

/**
 * The write warning (design §10), verbatim: the first sentence bold, then the rest. Shown whenever the
 * role is write, in the invite dialog and in the confirm of an upgrade to write.
 */
export function writeWarning(name: string): { headline: string; body: string } {
  const who = name.trim() === '' ? 'This guest' : name.trim()
  return {
    headline: `${who} can run anything as you.`,
    body:
      'Typing in a shared tab runs commands here as you: they can read your files, mail and plugin data from a shell ' +
      'and give themselves lasting access (a new device, an SSH key). Kicking ends their session, not what they ran. ' +
      'Invite only someone you would hand your unlocked laptop.'
  }
}

/** D-13: always shown, whatever the role. */
export const SCROLLBACK_LINE = 'Scrollback from before now is visible in shared tabs.'

/** Under the link, once it is shown (INVITE_UNUSED_MS: an unused invite expires a day after it was made). */
export const LINK_ONCE_TEXT = `This link works once. It expires in ${Math.round(INVITE_UNUSED_MS / 3600_000)} hours if unused.`

/** D-5, D-35: the invite was made, but the gateway listens on loopback only. */
export const LOOPBACK_WARNING_TEXT =
  'Web access listens on this computer only, so nobody else can open this link yet. In Settings › General › Web access, ' +
  'listen on the network with TLS (or confirm plain http), or run a tunnel (Tailscale Funnel, cloudflared, ngrok) and ' +
  'set the external address.'

/** Shown when no plugin is shown to guests. */
export const NO_SHARED_PLUGINS_TEXT = 'No plugin panels are shown to guests.'

/** Why main refused the invite, in plain words (D-1 for `none-mode`). */
export function inviteErrorText(error: GuestInviteError, name: string): string {
  switch (error) {
    case 'none-mode':
      return 'Guests need a sign-in mode: Access link, Password or Desktop confirm. Web access sign-in is None.'
    case 'name-taken':
      return `A guest named ${name.trim()} is already here. Pick another name.`
    case 'cap':
      return `There are ${MAX_GUESTS} guests and invites already. Remove one first.`
    case 'full':
      return 'The list of devices is full. Revoke a device in Settings › General › Web access first.'
  }
}

/**
 * Why the dialog cannot invite at all, shown as it opens with Create disabled: sign-in None (D-1; main
 * refuses `none-mode` anyway). Undefined while the mode is unknown (the read failed or is pending).
 */
export function inviteBlockedText(mode: WebAccessMode | undefined): string | undefined {
  return mode === 'none' ? inviteErrorText('none-mode', '') : undefined
}

/**
 * What may close the dialog now. While the invite is being made, nothing (closing would lose the one-time
 * link main is about to answer with, the invite made all the same); once the link shows, only Done (an Esc
 * meant for a field must not drop a link that is shown once).
 */
export function inviteDismiss(state: { busy: boolean; linkShown: boolean }): { esc: boolean; cancel: boolean } {
  return { esc: !state.busy && !state.linkShown, cancel: !state.busy }
}

/** Control characters (C0, DEL, C1) and the line and paragraph separators: a name is one plain line. */
function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029
}

/**
 * What is wrong with the form, or undefined when it can be sent. The name is counted in code points
 * as the person sees them, never matched by a regex (it is typed text).
 */
export function inviteProblem(form: InviteForm): string | undefined {
  const name = form.name.trim()
  if (name === '') return 'Give the guest a name: it is what you and others see.'
  if (Array.from(name).length > GUEST_NAME_MAX) return `The name is at most ${GUEST_NAME_MAX} characters.`
  for (const ch of name) {
    if (isControl(ch.codePointAt(0) ?? 0)) return 'The name is one line of plain text.'
  }
  if (form.tabs === 'selected' && form.selected.length === 0) return 'Pick at least one tab, or share all tabs.'
  return undefined
}

/**
 * The request for `guests.invite`, or undefined while the form has a problem. Selected tabs keep only
 * ids of tabs that still exist (`live`: the project's tab ids now), so one closed while the dialog was
 * open is not sent; when none is left the form has a problem again.
 */
export function inviteRequest(form: InviteForm, live: readonly string[]): GuestInviteRequest | undefined {
  const selected = form.selected.filter((id) => live.includes(id))
  const checked: InviteForm = { ...form, selected }
  if (inviteProblem(checked) !== undefined) return undefined
  return {
    name: form.name.trim(),
    role: form.role,
    scope: form.tabs === 'all' ? 'all' : selected,
    lifetime: form.lifetime
  }
}

/** One row of the tab checklist. */
export interface InviteTabRow {
  id: string
  label: string
}

/**
 * The tabs a selected-tabs invite can list (design §7: every terminal and page tab of the project),
 * in the strip's order, each with its label as the strip shows it (without the session's title,
 * which the dialog does not read).
 */
export function inviteTabRows(tabs: readonly TabInfo[]): InviteTabRow[] {
  return tabs
    .filter((t) => t.kind === 'claude' || t.kind === 'shell' || t.kind === 'command' || t.kind === 'page')
    .map((t) => ({ id: t.id, label: tabLabel(t) }))
}

/**
 * The plugins guests see now (`guestAccess.effective === 'shown'`, shared/guest-access.ts), by name, of
 * those that run (a disabled plugin draws nothing for anyone). Absent `guestAccess` reads as hidden.
 */
export function sharedPluginNames(plugins: readonly PluginView[]): string[] {
  return plugins.filter((p) => p.state.ok && p.guestAccess?.effective === 'shown').map((p) => p.name)
}

/** The armed confirm's question for an invite from a server's browser (D-11). */
export function inviteConfirmTitle(name: string, role: GuestRole): string {
  return `Invite ${name.trim()} ${role === 'write' ? 'with write access' : 'read-only'}?`
}
