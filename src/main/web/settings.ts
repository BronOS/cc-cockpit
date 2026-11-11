// Web access settings (design-web.md §4, `app.json` › `webAccess`), read and checked in main.
//
// `app.json` is user-writable, so `webAccessOf` is tolerant field by field: a damaged field reads
// as its default and a bad host entry is dropped, never costing the rest. What is *refused* is
// decided by `listenPlanOf`, separately: a refused plan means nothing listens, with a reason for
// the log and the settings page. It is never rewritten to something safer behind the person's
// back: a bind they typed as 0.0.0.0 silently becoming 127.0.0.1 would look like web access
// working "except from the phone", with no hint why.
//
// Network binds (plan Task 28, design §4.3): any address is allowed, but the two dangerous choices
// (no sign-in on a network address, plain http on one) listen only once the person confirmed them
// on the settings page (`confirmed`, set by `applyWebAccessPatch` from a confirmed change). A risky
// setting typed into the file on its own (a hand-edited bind of 0.0.0.0) is refused like any other
// bad setting. The confirm is a guard against a choice made on the page without reading what it
// means, not a seal on the file: whoever can write `app.json` can turn web access on, and can write
// `confirmed` next to the risk just as well (the same trust as the rest of the file).
//
// No regexes in what is new here (the project rule for anything parsing settings): host names and
// origins go through WHATWG `URL`, addresses through `net.isIP`.
import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { isPlainObject } from '../../shared/guards'
import type { WebAccessMode, WebAccessRisk, WebAccessSettings } from '../../shared/types'
import { WEB_RISK_ORDER, WEB_RISK_TEXT } from '../../shared/web-access'

/** Unprivileged ports only: below 1024 needs root on Linux, and port 80 would drop out of Host headers. */
export const WEB_PORT_RANGE = { min: 1024, max: 65535 } as const
/** A port nothing common uses by default (dev servers sit on 3000, 5173, 8080…). */
export const DEFAULT_WEB_PORT = 7330
export const DEFAULT_WEB_BIND = '127.0.0.1'
/** Far above any real list (an IP, an mDNS name, a proxy name); a cap so a hand-edited file stays cheap. */
export const MAX_WEB_HOSTS = 32

const MODES: readonly WebAccessMode[] = ['link', 'password', 'confirm', 'none']

export const DEFAULT_WEB_ACCESS: WebAccessSettings = {
  enabled: false,
  bind: DEFAULT_WEB_BIND,
  port: DEFAULT_WEB_PORT,
  hosts: [],
  mode: 'link'
}

function isWebPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= WEB_PORT_RANGE.min && value <= WEB_PORT_RANGE.max
}

/**
 * A loopback host name or address as `URL.hostname` gives it: `localhost`, 127.0.0.0/8 and `[::1]`
 * (also bare `::1`, the form a bind is written in). Anything else is reachable from the network.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  return isIP(h) === 4 && h.startsWith('127.')
}

/** Whether listening on `bind` keeps the gateway on this machine. */
export function isLoopbackBind(bind: string): boolean {
  return isLoopbackHost(bind)
}

/**
 * A bind the gateway may listen on: an IP address, or `localhost` (listened on as 127.0.0.1,
 * gateway.ts). Never another name: what a name resolves to is the resolver's choice, so the address
 * that listens would not be the one the settings and the Host list say.
 */
export function isBindAddress(bind: string): boolean {
  return bind === 'localhost' || isIP(bind) !== 0
}

/** Every address of the machine (`0.0.0.0`, `::`): the link then names one of its LAN addresses. */
export function isWildcardBind(bind: string): boolean {
  return bind === '0.0.0.0' || bind === '::'
}

/** A bind as stored: trimmed, lowercased, an IPv6 address without the brackets a URL would give it. */
function bindOf(raw: string): string {
  const b = raw.trim().toLowerCase()
  return b.startsWith('[') && b.endsWith(']') ? b.slice(1, -1) : b
}

/** Far above any real path; a cap so a hand-edited file stays cheap. */
const MAX_TLS_PATH = 4096

/** A certificate or key path: absolute (a relative one would follow the app's working folder). */
function tlsPathOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const path = raw.trim()
  if (path === '' || path.length > MAX_TLS_PATH || path.includes('\0') || !isAbsolute(path)) return undefined
  return path
}

function isRisk(value: unknown): value is WebAccessRisk {
  return WEB_RISK_ORDER.includes(value as WebAccessRisk)
}

/** Characters no Host entry can hold; a URL would accept some of them as path, user or query. */
function hasForbiddenChar(text: string): boolean {
  for (const ch of text) {
    if (ch <= ' ' || ch === '/' || ch === '\\' || ch === '?' || ch === '#' || ch === '@' || ch === '\x7f') return true
  }
  return false
}

/**
 * One entry of the person's host list (`name`, `name:port`, an IPv4, `[v6]:port`), lowercased as
 * `host:port`; `port` is the gateway's own when the entry names none. Undefined when it is not a
 * plain host (a path, credentials, a scheme, an empty name).
 */
export function hostEntryOf(raw: unknown, port: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const entry = raw.trim().toLowerCase()
  if (entry === '' || entry.length > 300 || hasForbiddenChar(entry)) return undefined
  let url: URL
  try {
    url = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  if (url.hostname === '' || url.username !== '' || url.password !== '' || url.pathname !== '/') return undefined
  // URL drops a default port (`name:80`): such an entry reads as the gateway's port, which can
  // never be 80 (WEB_PORT_RANGE).
  return url.port === '' ? `${url.host}:${port}` : url.host
}

/**
 * The external origin (a proxy's, design-web.md §4.1): `http(s)://host[:port]` with nothing after
 * it but an optional `/`. Returned as `URL.origin` (lowercased, default port dropped), the exact
 * form a browser puts in its `Origin` header. Undefined when damaged.
 */
export function externalOriginOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (text === '' || text.length > 300) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
  // `new URL('https://x/?')` has an empty search but kept the `?`: compare against the text itself.
  if (text.includes('?') || text.includes('#')) return undefined
  return url.origin
}

/** The stored `webAccess`, each missing or damaged field replaced by its default. */
export function webAccessOf(stored: unknown): WebAccessSettings {
  const s = isPlainObject(stored) ? stored : {}
  const port = isWebPort(s['port']) ? s['port'] : DEFAULT_WEB_PORT
  const bind = typeof s['bind'] === 'string' && s['bind'].trim() !== '' ? bindOf(s['bind']) : DEFAULT_WEB_BIND
  const hosts: string[] = []
  if (Array.isArray(s['hosts'])) {
    for (const raw of s['hosts'].slice(0, MAX_WEB_HOSTS)) {
      const entry = hostEntryOf(raw, port)
      if (entry !== undefined && !hosts.includes(entry)) hosts.push(entry)
    }
  }
  const mode = MODES.find((m) => m === s['mode']) ?? DEFAULT_WEB_ACCESS.mode
  const out: WebAccessSettings = { enabled: s['enabled'] === true, bind, port, hosts, mode }
  const origin = externalOriginOf(s['externalOrigin'])
  if (origin !== undefined) out.externalOrigin = origin
  // A damaged TLS entry (a relative path, one file missing) reads as none: plain http, which on a
  // network bind is a risk never confirmed, so it is refused rather than served unencrypted.
  const tls = s['tls']
  if (isPlainObject(tls)) {
    const certPath = tlsPathOf(tls['certPath'])
    const keyPath = tlsPathOf(tls['keyPath'])
    if (certPath !== undefined && keyPath !== undefined) out.tls = { certPath, keyPath }
  }
  if (Array.isArray(s['confirmed'])) {
    const confirmed = WEB_RISK_ORDER.filter((r) => (s['confirmed'] as unknown[]).includes(r))
    if (confirmed.length > 0) out.confirmed = confirmed
  }
  return out
}

/**
 * The §4.3 risks of these settings, whether or not they are on or confirmed: no sign-in on a
 * network address, and plain http on one (a network bind with no TLS, or a proxy's `http:` origin on
 * a network name, where the browser's leg crosses the network unencrypted). In WEB_RISK_ORDER.
 */
export function webAccessRiskIds(settings: WebAccessSettings): WebAccessRisk[] {
  const out: WebAccessRisk[] = []
  const network = !isLoopbackBind(settings.bind)
  if (settings.mode === 'none' && network) out.push('none-network')
  const origin = settings.externalOrigin !== undefined ? new URL(settings.externalOrigin) : undefined
  const proxyHttp = origin !== undefined && origin.protocol === 'http:' && !isLoopbackHost(origin.hostname)
  if ((network && settings.tls === undefined) || proxyHttp) out.push('plain-http')
  return out
}

/** What the gateway listens on and accepts, or why it does not listen. */
export type ListenPlan =
  | {
      ok: true
      bind: string
      port: number
      externalOrigin?: string
      hosts: string[]
      /** Present: https with these files (read when the listener starts, gateway.ts). */
      tls?: { certPath: string; keyPath: string }
    }
  | { ok: false; reason: string }

/** Why a risk that was never confirmed keeps the gateway from listening. */
const UNCONFIRMED: Record<WebAccessRisk, string> = {
  'none-network': 'no sign-in on a network address needs the confirm in Settings › General › Web access',
  'plain-http': 'plain http on a network address needs a certificate, or the confirm in Settings › General › Web access'
}

/**
 * Whether these settings may listen. Any IP address may be bound; a loopback one keeps the gateway on
 * this machine (a proxy here, `tailscale serve`, can still publish it). The §4.3 risks listen only
 * once confirmed (`confirmed`, from the settings page): plain http on a network address (a network
 * bind with no TLS, or an `http:` external origin on a network name), and no sign-in on one.
 */
export function listenPlanOf(settings: WebAccessSettings): ListenPlan {
  if (!settings.enabled) return { ok: false, reason: 'web access is off' }
  if (!isBindAddress(settings.bind)) {
    return { ok: false, reason: `${JSON.stringify(settings.bind.slice(0, 80))} is not an IP address to listen on` }
  }
  for (const risk of webAccessRiskIds(settings)) {
    if (!settings.confirmed?.includes(risk)) return { ok: false, reason: UNCONFIRMED[risk] }
  }
  const plan: ListenPlan = { ok: true, bind: settings.bind, port: settings.port, hosts: settings.hosts }
  if (settings.externalOrigin !== undefined) plan.externalOrigin = settings.externalOrigin
  if (settings.tls !== undefined) plan.tls = { ...settings.tls }
  return plan
}

/**
 * A change's outcome. `needsConfirm`: the change brings in §4.3 risks the person has not confirmed;
 * nothing changed, and the page asks, then sends the same change again with `confirm`.
 */
export type PatchResult = { ok: true; value: WebAccessSettings } | { ok: false; error: string; needsConfirm?: WebAccessRisk[] }

const PATCH_KEYS = ['enabled', 'bind', 'port', 'externalOrigin', 'hosts', 'mode', 'tls', 'confirm'] as const

/**
 * Whether the confirm `risk` had in `current` still covers it in `next`: the exposure it was given
 * for is unchanged. A confirm is worded for the choice shown at the time, so a wider exposure under
 * the same risk id asks again (review finding: plain http confirmed for an `http:` proxy origin on a
 * loopback bind must not carry over to the gateway itself on 0.0.0.0 over plain http, nor None
 * confirmed on one LAN address to every address). Any change of what the risk depends on counts,
 * narrower or not: asking once more is cheap, judging "narrower" is where a mistake would hide.
 */
function confirmCarries(risk: WebAccessRisk, current: WebAccessSettings, next: WebAccessSettings): boolean {
  if (current.bind !== next.bind) return false
  if (risk === 'none-network') return true
  return current.externalOrigin === next.externalOrigin && (current.tls === undefined) === (next.tls === undefined)
}

/** A host entry as the error message shows it: the person's text, cut short and on one line. */
function shown(raw: unknown): string {
  return JSON.stringify(String(raw).slice(0, 80))
}

/**
 * The settings after a change from the Settings page (`settings.webAccessSet`). Unlike `webAccessOf`
 * (tolerant of a hand-edited file) this is strict: a wrong value is refused with the reason, and
 * nothing changes, so the page can say what to fix instead of quietly saving a default. Only the
 * fields in the patch change, and the hosts follow the port: an entry that named the old port moves
 * to the new one.
 *
 * The §4.3 confirms: a change that leaves web access on with a risk that was not confirmed before
 * (and is not in the patch's `confirm`) is refused with `needsConfirm`, so a cancelled confirm leaves
 * every setting as it was (a loopback bind stays loopback). A risk the change removes loses its
 * confirm, so choosing it again asks again, and so does a change that widens what the risk exposes
 * (`confirmCarries`: another bind, origin or TLS). Turning off never needs one and drops every
 * confirm: confirms exist only while web access is on, so turning it on again, weeks later or a
 * minute later, always asks for the risks it brings (a risk saved while off included).
 */
export function applyWebAccessPatch(current: WebAccessSettings, patch: unknown): PatchResult {
  if (!isPlainObject(patch)) return { ok: false, error: 'the change must be an object' }
  for (const key of Object.keys(patch)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) return { ok: false, error: `unknown field ${shown(key)}` }
  }
  const next: WebAccessSettings = { ...current, hosts: [...current.hosts] }
  if ('enabled' in patch) {
    if (typeof patch['enabled'] !== 'boolean') return { ok: false, error: 'enabled must be true or false' }
    next.enabled = patch['enabled']
  }
  if ('port' in patch) {
    if (!isWebPort(patch['port'])) return { ok: false, error: `the port must be a whole number from ${WEB_PORT_RANGE.min} to ${WEB_PORT_RANGE.max}` }
    if (patch['port'] !== current.port) {
      const old = `:${current.port}`
      next.hosts = next.hosts.map((h) => (h.endsWith(old) ? `${h.slice(0, -old.length)}:${patch['port']}` : h))
    }
    next.port = patch['port']
  }
  if ('externalOrigin' in patch) {
    const raw = patch['externalOrigin']
    if (raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      delete next.externalOrigin
    } else {
      const origin = externalOriginOf(raw)
      if (origin === undefined) return { ok: false, error: `${shown(raw)} is not an origin; use http(s)://name[:port] with no path` }
      next.externalOrigin = origin
    }
  }
  if ('hosts' in patch) {
    const raw = patch['hosts']
    if (!Array.isArray(raw)) return { ok: false, error: 'hosts must be a list' }
    if (raw.length > MAX_WEB_HOSTS) return { ok: false, error: `at most ${MAX_WEB_HOSTS} hosts` }
    const hosts: string[] = []
    for (const entry of raw) {
      const host = hostEntryOf(entry, next.port)
      if (host === undefined) return { ok: false, error: `${shown(entry)} is not a host name; use name or name:port` }
      if (!hosts.includes(host)) hosts.push(host)
    }
    next.hosts = hosts
  }
  if ('mode' in patch) {
    const mode = MODES.find((m) => m === patch['mode'])
    if (mode === undefined) return { ok: false, error: `${shown(patch['mode'])} is not a sign-in mode` }
    // Password needs a password set first: access-service.ts checks that (it has the credentials).
    next.mode = mode
  }
  if ('bind' in patch) {
    const raw = patch['bind']
    const bind = typeof raw === 'string' && raw.length <= 100 ? bindOf(raw) : ''
    if (!isBindAddress(bind)) {
      return { ok: false, error: `${shown(raw)} is not an IP address; use 127.0.0.1 (this computer only), 0.0.0.0 (every network) or one of this computer's addresses` }
    }
    next.bind = bind
  }
  if ('tls' in patch) {
    const raw = patch['tls']
    if (raw === null) {
      delete next.tls
    } else {
      if (!isPlainObject(raw)) return { ok: false, error: 'the certificate must be a certificate file and a key file' }
      const certPath = tlsPathOf(raw['certPath'])
      const keyPath = tlsPathOf(raw['keyPath'])
      if (certPath === undefined || keyPath === undefined) {
        return { ok: false, error: 'give the full path (starting with /) of both the certificate file and its key file' }
      }
      next.tls = { certPath, keyPath }
    }
  }
  let given: WebAccessRisk[] = []
  if ('confirm' in patch) {
    const raw = patch['confirm']
    if (!Array.isArray(raw) || !raw.every(isRisk)) return { ok: false, error: 'confirm must be a list of risks' }
    given = raw
  }
  // Only a confirm of a risk the settings still have, given while on and for the same exposure,
  // carries over (a stale entry in a hand-edited file confirms nothing; nor does one left in a file
  // that is off).
  const before = current.enabled
    ? webAccessRiskIds(current).filter((r) => current.confirmed?.includes(r) === true && confirmCarries(r, current, next))
    : []
  const risks = webAccessRiskIds(next)
  const missing = risks.filter((r) => !before.includes(r) && !given.includes(r))
  if (next.enabled && missing.length > 0) {
    return { ok: false, error: `confirm first: ${missing.map((r) => WEB_RISK_TEXT[r].title).join(' ')}`, needsConfirm: missing }
  }
  const confirmed = next.enabled ? risks.filter((r) => before.includes(r) || given.includes(r)) : []
  if (confirmed.length > 0) next.confirmed = confirmed
  else delete next.confirmed
  return { ok: true, value: next }
}

/**
 * Plain-words risks of these settings (design-web.md §4.3), for the desktop's warning badge and the
 * settings page while they listen: None on an address other than loopback, and any mode over plain
 * http on one. The one rule for the badge (webAccessRiskIds), never a copy.
 */
export function webAccessRisks(settings: WebAccessSettings): string[] {
  return webAccessRiskIds(settings).map((r) => WEB_RISK_TEXT[r].badge)
}

/**
 * `app.json` › `webAccess` after a saved change: every field the page edits, an optional one the
 * change cleared (the external origin, TLS, the confirms) removed from the file, and anything else
 * the file holds kept as it is.
 */
export function storedWebAccess(previous: Partial<WebAccessSettings> | undefined, next: WebAccessSettings): Partial<WebAccessSettings> {
  const stored: Partial<WebAccessSettings> = { ...previous, enabled: next.enabled, bind: next.bind, port: next.port, hosts: next.hosts, mode: next.mode }
  if (next.externalOrigin !== undefined) stored.externalOrigin = next.externalOrigin
  else delete stored.externalOrigin
  if (next.tls !== undefined) stored.tls = { ...next.tls }
  else delete stored.tls
  if (next.confirmed !== undefined) stored.confirmed = [...next.confirmed]
  else delete stored.confirmed
  return stored
}
