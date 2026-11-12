// The logic of Settings › General › Web access and the top bar's indicator, apart from the React that
// draws them (the unit tests run in plain Node, so what is worth testing lives here). DOM-free.
import type { WebAccessMode, WebAccessRisk } from '../../shared/types'
import type {
  WebAccessForm,
  WebAccessIndicator,
  WebAccessPatch,
  WebAccessSetReply,
  WebAccessView,
  WebConfirmAsk,
  WebCredentialState,
  WebDeviceView,
  WebLinkReply,
  WebSecretsStatus
} from '../../shared/web-access'
import { SERVER_NONE_WARNING } from '../../shared/web-access'

/** How long a revealed link stays on screen before it hides again (a forgotten screen share must not keep it). */
export const REVEAL_MS = 60_000

/** The sentinel shown in place of a hidden link; no part of the token is in it. */
export const HIDDEN_LINK = '••••••••••••••••••••••••••••••••'

/**
 * A link on screen: what the Show button reveals. `link` is the text main returned and is NOT put in the
 * DOM while `shown` is false (`displayedLink` is the one place the page reads it from), so a
 * screenshot, a screen share or the accessibility tree of a page that is not revealed holds no token.
 */
export interface LinkReveal {
  link: string | undefined
  shown: boolean
  /** One-time links only: when it stops working. */
  expiresAt?: number
  /** Why there is no link (web access off, a wrong mode). */
  reason?: string
}

/** Nothing fetched, nothing shown. The token is only asked for when the person presses Show. */
export function hiddenReveal(): LinkReveal {
  return { link: undefined, shown: false }
}

/** The state after main answered a Show (or Regenerate, or Add a device) press. */
export function revealFrom(reply: WebLinkReply): LinkReveal {
  if (!reply.ok) return { link: undefined, shown: false, reason: reply.reason }
  const out: LinkReveal = { link: reply.link, shown: true }
  if (reply.expiresAt !== undefined) out.expiresAt = reply.expiresAt
  return out
}

/** Hide again (the Hide button, the timeout): the link is dropped from the page's state altogether. */
export function hide(reveal: LinkReveal): LinkReveal {
  return reveal.reason !== undefined ? { link: undefined, shown: false, reason: reveal.reason } : hiddenReveal()
}

/** What the page prints: the link while shown (and, for a one-time one, still valid), else the mask. */
export function displayedLink(reveal: LinkReveal, now: number): string {
  if (!reveal.shown || reveal.link === undefined) return HIDDEN_LINK
  if (reveal.expiresAt !== undefined && now >= reveal.expiresAt) return HIDDEN_LINK
  return reveal.link
}

/** The text a QR code encodes: only while the link is displayed, never the mask. */
export function qrText(reveal: LinkReveal, now: number): string | undefined {
  const text = displayedLink(reveal, now)
  return text === HIDDEN_LINK ? undefined : text
}

/** A one-time link's remaining time as `m:ss`; '' when it has none or ran out. */
export function expiresIn(reveal: LinkReveal, now: number): string {
  if (reveal.expiresAt === undefined) return ''
  const left = Math.max(0, Math.ceil((reveal.expiresAt - now) / 1000))
  if (left === 0) return ''
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** The host list as the textarea shows it: one per line, the gateway's own port left off. */
export function hostsText(hosts: readonly string[], port: number): string {
  const suffix = `:${port}`
  return hosts.map((h) => (h.endsWith(suffix) ? h.slice(0, -suffix.length) : h)).join('\n')
}

/** The textarea back to a list (lines or commas; blanks dropped). Main validates each entry. */
export function hostsFromText(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    for (const part of line.split(',')) {
      const entry = part.trim()
      if (entry !== '') out.push(entry)
    }
  }
  return out
}

/** What the person has typed, as the fields the page holds as text. */
export interface WebAccessDraft {
  bind: string
  port: string
  externalOrigin: string
  hosts: string
  certPath: string
  keyPath: string
}

export function draftOf(form: WebAccessForm): WebAccessDraft {
  return {
    bind: form.bind,
    port: String(form.port),
    externalOrigin: form.externalOrigin,
    hosts: hostsText(form.hosts, form.port),
    certPath: form.certPath,
    keyPath: form.keyPath
  }
}

/**
 * The change a Save sends: only fields that differ from the saved form. `error` when the port is not a
 * whole number (the rest is main's to judge: it owns the rules, and its message is shown as it is).
 * Empty patch (`{}`): nothing to save. Both certificate fields emptied clears TLS (`tls: null`); one
 * of them changed sends both, and main says when one is missing.
 */
export function patchOf(form: WebAccessForm, draft: WebAccessDraft): { patch: WebAccessPatch } | { error: string } {
  const patch: WebAccessPatch = {}
  const portText = draft.port.trim()
  const port = Number(portText)
  if (portText === '' || !Number.isInteger(port)) return { error: 'The port must be a whole number.' }
  const bind = draft.bind.trim()
  if (bind !== form.bind) patch.bind = bind
  const certPath = draft.certPath.trim()
  const keyPath = draft.keyPath.trim()
  if (certPath !== form.certPath || keyPath !== form.keyPath) {
    patch.tls = certPath === '' && keyPath === '' ? null : { certPath, keyPath }
  }
  // Hosts are compared as the page shows them: the saved list carries the port the person did not type.
  if (port !== form.port) patch.port = port
  const origin = draft.externalOrigin.trim()
  if (origin !== form.externalOrigin) patch.externalOrigin = origin === '' ? null : origin
  const typed = hostsFromText(draft.hosts)
  if (typed.join('\n') !== hostsFromText(hostsText(form.hosts, form.port)).join('\n')) patch.hosts = typed
  return { patch }
}

export function isDirty(form: WebAccessForm, draft: WebAccessDraft): boolean {
  const result = patchOf(form, draft)
  return 'error' in result || Object.keys(result.patch).length > 0
}

export interface ModeOption {
  value: WebAccessMode
  label: string
  help: string
}

const MODE_TEXT: Record<WebAccessMode, { label: string; help: string }> = {
  link: { label: 'Access link', help: 'A secret link opens the cockpit once on each device; the browser is then remembered.' },
  password: {
    label: 'Password',
    help: 'A password you set on this computer; works with nobody at this desk. Wrong guesses are slowed down, never locked out.'
  },
  confirm: {
    label: 'Confirm on this computer',
    help: 'Each new browser shows a code and asks; a request appears at the top of the cockpit window here, and you type that code to allow it. Needs someone at this desk.'
  },
  none: {
    label: 'No sign-in',
    help: 'Whoever reaches the address is in. Meant for a proxy that already signs people in (Tailscale, Cloudflare Access, oauth2-proxy); keep cc-cockpit on this computer behind it.'
  }
}

/**
 * What the None mode's own row says (design-web.md §4.2): what still protects (the Host and Origin
 * checks stop other web pages and foreign names), and what does not: with no sign-in there is nobody
 * to sign out, so Revoke keeps no one out.
 */
export const NONE_MODE_NOTE =
  'Anyone who can reach the address controls this computer. Revoke has no effect in this mode: a browser that is revoked or disconnected comes straight back without signing in. Host and Origin checks still apply, so other web pages and unknown names stay out. Use it only behind a proxy that signs people in.'

/** The devices list's note while None is on: Revoke there does not lock anyone out. */
export const NONE_REVOKE_NOTE = 'Sign-in is off, so Revoke has no effect: anyone who can reach the address comes back in. Pick another sign-in to keep browsers out.'

/** Whether the page has to ask the §4.3 confirms before main takes the change (nothing was saved). */
export function confirmsNeeded(reply: WebAccessSetReply): WebAccessRisk[] | undefined {
  return 'needsConfirm' in reply ? reply.needsConfirm : undefined
}

/** The same change again, now carrying the confirms the person gave (and any it already had). */
export function confirmedPatch(patch: WebAccessPatch, risks: readonly WebAccessRisk[]): WebAccessPatch {
  const confirm = [...(patch.confirm ?? [])]
  for (const r of risks) if (!confirm.includes(r)) confirm.push(r)
  return { ...patch, confirm }
}

/** The mode dropdown's entries, in the design's order. */
export function modeOptions(): ModeOption[] {
  return (['link', 'password', 'confirm', 'none'] as const).map((value) => ({ value, label: MODE_TEXT[value].label, help: MODE_TEXT[value].help }))
}

/** Same as main's minimum (main/web/password.ts), checked here only to say so before a round trip. */
export const MIN_PASSWORD_LENGTH = 8

/**
 * Why the two password fields cannot be saved, or undefined when they can (main checks again).
 * `minLength`: the view's `passwordMinLength` (12 when others can reach the gateway).
 */
export function passwordDraftProblem(password: string, repeat: string, minLength = MIN_PASSWORD_LENGTH): string | undefined {
  const min = Math.max(MIN_PASSWORD_LENGTH, minLength)
  if ([...password.normalize('NFC')].length < min) return `Use at least ${min} characters.`
  if (password !== repeat) return 'The two passwords differ.'
  return undefined
}

/**
 * Whether the mode select's choice is saved at once, or first needs a password (the password mode
 * with none set): main refuses that switch, so the page asks for the password and switches after.
 */
export function modeNeedsPassword(mode: WebAccessMode, passwordSet: boolean): boolean {
  return mode === 'password' && !passwordSet
}

/** The desktop-confirm card's countdown: `m:ss` left, '' once lapsed (the card then hides). */
export function confirmLeft(ask: WebConfirmAsk, now: number): string {
  const left = Math.max(0, Math.ceil((ask.expiresAt - now) / 1000))
  if (left === 0) return ''
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** Allow is enabled once something that could be the code is typed; main does the real compare. */
export function confirmCodeReady(code: string): boolean {
  let digits = 0
  for (const ch of code) {
    if (ch >= '0' && ch <= '9') digits++
    else if (ch !== ' ' && ch !== '-') return false
  }
  return digits === 6
}

/**
 * Said under every mode: a mode change signs no device out (each mode ends in the same device
 * cookie, and main checks only that). Someone who leaves the access link because it leaked would
 * otherwise think the devices it let in are out with it; Revoke all is what signs them out.
 */
export const MODE_CHANGE_KEEPS_DEVICES = 'Changing it signs no browser out: use Revoke all below for that.'

export function modeHelp(mode: WebAccessMode): string {
  return `${MODE_TEXT[mode].help} ${MODE_CHANGE_KEEPS_DEVICES}`
}

/** "just now", "5 min ago", "3 days ago": a device's last use, as a short phrase. */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} days ago`
}

const SIGN_IN_TEXT: Record<string, string> = {
  link: 'access link',
  add: 'one-time link',
  password: 'password',
  confirm: 'confirmed here',
  none: 'no sign-in'
}

/** One device's row text: how it signed in and when it was last used (or that it is connected now). */
export function deviceDetail(device: WebDeviceView, now: number): string {
  const how = SIGN_IN_TEXT[device.mode] ?? device.mode
  return device.connected ? `${how}, connected now` : `${how}, last used ${agoText(device.lastSeenAt, now)}`
}

/** The top bar chip's text, or undefined when there is nothing to show (no device, no warning). */
export function indicatorText(indicator: WebAccessIndicator): string | undefined {
  if (indicator.connected > 0) return indicator.connected === 1 ? '1 device' : `${indicator.connected} devices`
  return indicator.warning !== undefined ? 'Web access' : undefined
}

/**
 * The chip's hover text: who is connected, and the warning in full words. `server`: a server's
 * browser (design-web.md §9.4), whose click opens its own read-only card with the devices.
 */
export function indicatorTitle(indicator: WebAccessIndicator, server = false): string {
  const lead =
    indicator.connected === 0
      ? 'No browser is connected.'
      : indicator.connected === 1
        ? '1 browser is connected to this cockpit.'
        : `${indicator.connected} browsers are connected to this cockpit.`
  const action = server ? 'Click to see the devices.' : 'Click to manage web access.'
  return `${lead}${indicator.warning !== undefined ? ` ${indicator.warning}` : ''} ${action}`
}


// Server mode's card in a browser (design-web.md §9.4, §9.6): read-only. It never holds a link or a
// QR code (main never sends one to it: `settings.webAccessLink` and the rest are `no`-class), and
// every change is made with `ccc web` from a shell on the server.

/** One row of the browser's read-only card: a label, its text, and whether it warns. */
export interface ServerCardRow {
  key: string
  label: string
  text: string
  warn?: boolean
}

/** The card's last line: where its settings are changed. */
export const SERVER_CARD_FOOT = 'Change these with `ccc web` in a shell on the server; `ccc web status` shows them there too.'

/**
 * Why desktop confirm is off in server mode (design-web.md §9.2): the request card it needs is on a
 * desktop nobody looks at, so every browser would wait and fail.
 */
export const SERVER_CONFIRM_OFF =
  'Not available in server mode: each new browser would wait for someone at the server\'s screen to type its code, and there is nobody there.'

const LINK_STATE: Record<WebCredentialState, { text: string; warn?: boolean }> = {
  unset: { text: 'Not made yet: `ccc web link` on the server makes it. A one-time link (`ccc web add-device`) is safer to pass on.' },
  set: { text: 'Made. Only `ccc web link` on the server shows it; it is never shown in a browser.' },
  'other-mode': {
    text: 'Stored by the desktop\'s keychain, so it cannot be shown here: `ccc web link --regenerate` makes a new one (and signs out the devices of the old one).',
    warn: true
  },
  replaced: {
    text: 'Stored under a key file that was replaced, so it cannot be shown: `ccc web link --regenerate` makes a new one (and signs out the devices of the old one).',
    warn: true
  }
}

const PASSWORD_STATE: Record<WebCredentialState, { text: string; warn?: boolean }> = {
  unset: { text: 'Not set: `ccc web password` on the server sets one.' },
  set: { text: 'Set. `ccc web password` on the server changes it.' },
  'other-mode': { text: 'Stored by the desktop\'s keychain, so it cannot be checked here: set it again with `ccc web password`.', warn: true },
  replaced: { text: 'Stored under a key file that was replaced: set it again with `ccc web password`.', warn: true }
}

const STORE_TEXT: Record<WebSecretsStatus['store'], string> = {
  keyfile: 'The key file on the server (secret.key in the data folder): anyone who can read that folder as you, or root, can read the secrets.',
  os: 'The OS keychain.',
  fake: 'In memory only (a test run).'
}

/** "1 stored value was", "3 stored values were". */
function valuesWere(n: number): string {
  return n === 1 ? '1 stored value was' : `${n} stored values were`
}

/** What the secret store row says: the store, why it cannot work, and what it cannot read. */
export function secretsText(secrets: WebSecretsStatus): { text: string; warn: boolean } {
  const parts = [STORE_TEXT[secrets.store]]
  let warn = false
  if (secrets.unavailable !== null) {
    parts.push(`It cannot store or read anything now: ${secrets.unavailable}.`)
    warn = true
  }
  if (secrets.otherMode > 0) {
    parts.push(`${valuesWere(secrets.otherMode)} saved by the desktop's keychain and cannot be read here: enter them again.`)
    warn = true
  }
  if (secrets.replaced > 0) {
    parts.push(`${valuesWere(secrets.replaced)} saved under a key file that was replaced: enter them again.`)
    warn = true
  }
  return { text: parts.join(' '), warn }
}

/** The address row: where browsers reach it, or why nothing listens. */
function addressText(view: WebAccessView): { text: string; warn?: boolean } {
  const { gateway, form } = view
  if (gateway.state === 'listening') {
    const tls = form.certPath !== '' ? ', over https' : ''
    return { text: `${gateway.origin} (listening on ${gateway.bind} port ${gateway.port}${tls})` }
  }
  if (gateway.state === 'off') return { text: 'Not listening: web access is off.', warn: true }
  return { text: `Not listening: ${gateway.reason}.`, warn: true }
}

/**
 * The read-only card's rows, in order: sign-in mode (None with its shared-server warning), address,
 * the access link and password states (§9.5), the secret store, desktop confirm off with its reason,
 * and the live §4.3 risks. Text only, never a link.
 */
export function serverCardRows(view: WebAccessView): ServerCardRow[] {
  const rows: ServerCardRow[] = []
  const mode = view.form.mode
  rows.push({ key: 'mode', label: 'Sign-in', text: `${MODE_TEXT[mode].label}. ${MODE_TEXT[mode].help}` })
  if (mode === 'none') rows.push({ key: 'none', label: 'Warning', text: SERVER_NONE_WARNING, warn: true })
  rows.push({ key: 'address', label: 'Address', ...addressText(view) })
  rows.push({ key: 'link', label: 'Access link', ...LINK_STATE[view.credentials.accessLink] })
  rows.push({ key: 'password', label: 'Password', ...PASSWORD_STATE[view.credentials.password] })
  if (view.secrets) rows.push({ key: 'secrets', label: 'Secrets', ...secretsText(view.secrets) })
  rows.push({ key: 'confirm', label: MODE_TEXT.confirm.label, text: SERVER_CONFIRM_OFF })
  for (const [i, risk] of view.risks.entries()) rows.push({ key: `risk-${i}`, label: 'Warning', text: risk, warn: true })
  return rows
}

/** A Revoke, Revoke all or Disconnect a browser asked for, waiting for its in-page confirm. */
export type DeviceAsk =
  | { kind: 'revoke'; id: string; name: string }
  | { kind: 'disconnect'; id: string; name: string }
  | { kind: 'revoke-all'; count: number }

/**
 * The in-page confirm's text (ApprovalDialog). Revoke says what it does not undo (design-web.md §9.6:
 * a revoke does not undo what an unlocked lost device already did from its shell); every one says
 * it can end this browser too, which the card cannot tell apart from the others.
 */
export function deviceAskText(ask: DeviceAsk): { title: string; body: string; allowLabel: string } {
  if (ask.kind === 'revoke') {
    return {
      title: `Revoke ${ask.name}?`,
      body: 'It is signed out for good and its pages close at once; to come back it signs in again. It does not undo what it already did. If it is this browser, this page closes too.',
      allowLabel: 'Revoke'
    }
  }
  if (ask.kind === 'disconnect') {
    return {
      title: `Disconnect ${ask.name}?`,
      body: 'Its pages close; it stays signed in and reconnects when it opens the cockpit again. If it is this browser, this page reconnects.',
      allowLabel: 'Disconnect'
    }
  }
  return {
    title: ask.count === 1 ? 'Revoke the 1 device?' : `Revoke all ${ask.count} devices?`,
    body: 'Every browser is signed out, this one included, and their pages close at once; each signs in again to come back.',
    allowLabel: 'Revoke all'
  }
}

/**
 * The desktop card's notes for a credential this run's store cannot read (design-web.md §9.5): a
 * desktop start on a data dir a server used. Empty when both are readable or unset, so the desktop's
 * card is as it was.
 */
export function desktopCredentialNotes(credentials: WebAccessView['credentials']): string[] {
  const notes: string[] = []
  const by = (state: WebCredentialState): string => (state === 'other-mode' ? "server mode's key file" : 'a key file that was replaced')
  if (credentials.accessLink === 'other-mode' || credentials.accessLink === 'replaced') {
    notes.push(`The access link was saved by ${by(credentials.accessLink)} and cannot be shown here: Regenerate makes a new one (and signs out the devices of the old one).`)
  }
  if (credentials.password === 'other-mode' || credentials.password === 'replaced') {
    notes.push(`The password was saved by ${by(credentials.password)} and cannot be checked here: set it again.`)
  }
  return notes
}
