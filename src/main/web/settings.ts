// Web access settings (design-web.md §4, `app.json` › `webAccess`), read and checked in main.
//
// `app.json` is user-writable, so `webAccessOf` is tolerant field by field: a damaged field reads
// as its default and a bad host entry is dropped, never costing the rest. What is *refused* is
// decided by `listenPlanOf`, separately: a refused plan means nothing listens, with a reason for
// the log (and later the settings page). It is never rewritten to something safer behind the
// person's back: a bind they typed as 0.0.0.0 silently becoming 127.0.0.1 would look like web
// access working "except from the phone", with no hint why.
//
// No regexes anywhere here (the project rule for anything parsing settings): host names and
// origins go through WHATWG `URL`, addresses through `net.isIP`.
import { isIP } from 'node:net'
import { isPlainObject } from '../../shared/guards'
import type { WebAccessMode, WebAccessSettings } from '../../shared/types'

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
  const bind = typeof s['bind'] === 'string' && s['bind'].trim() !== '' ? s['bind'].trim().toLowerCase() : DEFAULT_WEB_BIND
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
  const tls = s['tls']
  if (isPlainObject(tls) && typeof tls['certPath'] === 'string' && typeof tls['keyPath'] === 'string' && tls['certPath'] && tls['keyPath']) {
    out.tls = { certPath: tls['certPath'], keyPath: tls['keyPath'] }
  }
  return out
}

/** What the gateway listens on and accepts, or why it does not listen. */
export type ListenPlan =
  | { ok: true; bind: string; port: number; externalOrigin?: string; hosts: string[] }
  | { ok: false; reason: string }

/**
 * Whether these settings may listen. Until plan Task 28 adds TLS and the §4.3 confirms, only a
 * loopback bind is allowed (a proxy on this machine, `tailscale serve`, can still publish it), and
 * an external origin over plain http on a network name is refused too: it means the browser's
 * leg travels unencrypted across the network, which needs the same confirm.
 */
export function listenPlanOf(settings: WebAccessSettings): ListenPlan {
  if (!settings.enabled) return { ok: false, reason: 'web access is off' }
  if (!isLoopbackBind(settings.bind)) {
    return { ok: false, reason: `web access listens on loopback only for now; ${JSON.stringify(settings.bind.slice(0, 80))} is a network address` }
  }
  if (settings.externalOrigin !== undefined) {
    const url = new URL(settings.externalOrigin)
    if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      return { ok: false, reason: `the external origin ${settings.externalOrigin} is plain http on a network name; use https` }
    }
  }
  const plan: ListenPlan = { ok: true, bind: settings.bind, port: settings.port, hosts: settings.hosts }
  if (settings.externalOrigin !== undefined) plan.externalOrigin = settings.externalOrigin
  return plan
}
