// The logic of Settings › General › Web access and the top bar's indicator, apart from the React that
// draws them (the unit tests run in plain Node, so what is worth testing lives here). DOM-free.
import type { WebAccessMode } from '../../shared/types'
import {
  WEB_MODE_AVAILABLE,
  type WebAccessForm,
  type WebAccessIndicator,
  type WebAccessPatch,
  type WebDeviceView,
  type WebLinkReply
} from '../../shared/web-access'

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
  port: string
  externalOrigin: string
  hosts: string
}

export function draftOf(form: WebAccessForm): WebAccessDraft {
  return { port: String(form.port), externalOrigin: form.externalOrigin, hosts: hostsText(form.hosts, form.port) }
}

/**
 * The change a Save sends: only fields that differ from the saved form. `error` when the port is not a
 * whole number (the rest is main's to judge: it owns the rules, and its message is shown as it is).
 * Empty patch (`{}`): nothing to save.
 */
export function patchOf(form: WebAccessForm, draft: WebAccessDraft): { patch: WebAccessPatch } | { error: string } {
  const patch: WebAccessPatch = {}
  const portText = draft.port.trim()
  const port = Number(portText)
  if (portText === '' || !Number.isInteger(port)) return { error: 'The port must be a whole number.' }
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
  /** Why it cannot be picked yet; absent when it can. */
  unavailable?: string
  help: string
}

const MODE_TEXT: Record<WebAccessMode, { label: string; help: string }> = {
  link: { label: 'Access link', help: 'A secret link opens the cockpit once on each device; the browser is then remembered.' },
  password: { label: 'Password', help: 'A password you set on this computer.' },
  confirm: { label: 'Confirm on this computer', help: 'Each new browser asks, and you allow it here.' },
  none: {
    label: 'No sign-in',
    help: 'Whoever reaches the address is in. Meant for a proxy that already signs people in (Tailscale, Cloudflare Access, oauth2-proxy); keep cc-cockpit on this computer behind it.'
  }
}

/** The mode dropdown's entries, in the design's order; the ones built later are listed but cannot be picked. */
export function modeOptions(): ModeOption[] {
  return (['link', 'password', 'confirm', 'none'] as const).map((value) => {
    const option: ModeOption = { value, label: MODE_TEXT[value].label, help: MODE_TEXT[value].help }
    if (!WEB_MODE_AVAILABLE[value]) option.unavailable = 'coming later'
    return option
  })
}

export function modeHelp(mode: WebAccessMode): string {
  return MODE_TEXT[mode].help
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

/** The chip's hover text: who is connected, and the warning in full words. */
export function indicatorTitle(indicator: WebAccessIndicator): string {
  const lead =
    indicator.connected === 0
      ? 'No browser is connected.'
      : indicator.connected === 1
        ? '1 browser is connected to this cockpit.'
        : `${indicator.connected} browsers are connected to this cockpit.`
  return `${lead}${indicator.warning !== undefined ? ` ${indicator.warning}` : ''} Click to manage web access.`
}
