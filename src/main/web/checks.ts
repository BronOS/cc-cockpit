// The always-on checks of web access (design-web.md §4.1), ported from the spike
// (spike/web-terminal-mirror src/main/web-spike/checks.ts). Pure, so vitest covers them; the
// gateway applies them to every request and upgrade, in every auth mode (None included).
//
// - Host: every HTTP request and the WebSocket upgrade must name one of the gateway's own names
//   with its port. Blocks DNS rebinding: a page on evil.example whose name resolves to 127.0.0.1
//   (or a LAN IP) still sends `Host: evil.example:<port>`.
// - Origin: the upgrade and every state-changing request must come from the gateway's own page.
//   On loopback, cookies ignore ports and every `localhost:*` page is same-site, so this check,
//   not `SameSite`, is the control that stops another local page (a dev server on :3000, anything
//   the person browses that reaches localhost) from opening the socket or posting a sign-in.
// - Secrets: compared in constant time over hashes, so neither content nor length leaks through an
//   early return.
//
// No regexes (the spike had two): names go through settings.ts (URL, net.isIP).
import { createHash, timingSafeEqual } from 'node:crypto'
import type { NetworkInterfaceInfo } from 'node:os'
import { isLoopbackBind, isWildcardBind } from './settings'
import { OVERLAY_PAGES_PATH, PLUGIN_PAGES_PATH } from '../../shared/web-protocol'

export interface HostListInput {
  bind: string
  port: number
  /** The person's extra names, already `host:port` (settings.ts hostEntryOf). */
  hosts: readonly string[]
  /** A proxy's origin (settings.ts externalOriginOf): its host is allowed as the proxy sends it. */
  externalOrigin?: string
  /** os.networkInterfaces(); read only for a network bind. */
  interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>
  /** os.hostname(); read only for a network bind. */
  hostname?: string
}

/** Lowercased `host:port` strings (or a bare host, for a proxy on a default port) a Host header must equal. */
export function allowedHosts({ bind, port, hosts, externalOrigin, interfaces, hostname }: HostListInput): Set<string> {
  // `localhost` and `[::1]` too: whatever loopback name the person types reaches the same socket
  // (a 127.0.0.1 bind does not answer on ::1, so that one is only ever a refused connection).
  const out = new Set<string>([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`])
  const b = bind.toLowerCase()
  // A wildcard (0.0.0.0, ::) is not a name a browser should use: a page reaching `0.0.0.0` lands on
  // this machine from any site ("0.0.0.0 day"), so it stays out of the list; the machine's own
  // addresses below are what a browser on the LAN types. An IPv6 address is bracketed, as in a Host.
  if (b !== 'localhost' && b !== '::1' && !isWildcardBind(b)) out.add(b.includes(':') ? `[${b}]:${port}` : `${b}:${port}`)
  if (!isLoopbackBind(bind)) {
    // A network bind: the machine's own addresses and mDNS name, as the spike proved on the LAN.
    // IPv4 only: an IPv6 Host needs brackets and zone ids; the person can list one.
    for (const list of Object.values(interfaces ?? {})) {
      for (const addr of list ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) out.add(`${addr.address}:${port}`)
      }
    }
    const name = (hostname ?? '').trim().toLowerCase()
    if (name) {
      out.add(`${name}:${port}`)
      if (!name.endsWith('.local')) out.add(`${name}.local:${port}`)
    }
  }
  for (const entry of hosts) out.add(entry.toLowerCase())
  // `URL.host` drops a default port, exactly as a browser's Host header through that proxy does.
  if (externalOrigin !== undefined) out.add(new URL(externalOrigin).host)
  return out
}

export interface HostRule {
  /**
   * Main's `server` flag for the run (server-mode.ts), passed in by the gateway's owner and never
   * derived from a request: also accept the loopback literals on any port (`isLoopbackAnyPort`).
   */
  anyLoopbackPort?: boolean
}

/**
 * The Host header, lowercased, if it is one of `allowed` (or, with `rule.anyLoopbackPort`, a
 * loopback literal on any port); undefined otherwise.
 *
 * Why the loopback literals on any port are safe in server mode (design-remote-desktop.md §5.3):
 * the desktop app reaches a server through an SSH tunnel, `127.0.0.1:<L>` on its own machine
 * forwarded to the gateway's `<P>`, so Chromium sends `Host: 127.0.0.1:<L>` with a port the
 * gateway cannot know. The Host check is the DNS-rebinding defence, and a rebound name is never a
 * loopback literal (`127.0.0.1.evil:80` and `localhost.evil.com:80` are names, refused below), so
 * that defence is whole. A loopback Host on a foreign port reaches the gateway only through
 * something forwarding to it that the person set up (a tunnel, a proxy). A page on another loopback
 * port of either machine (a dev server on `127.0.0.1:3000`) still sends its own
 * `Origin: http://127.0.0.1:3000` with `Host: 127.0.0.1:<P>`, and `checkOrigin`, unchanged, wants
 * the Origin of the very Host the request came in on, so it is refused as before. Cookies were
 * never port-scoped, so nothing about them changes. A check-time rule, not 65535 entries in the
 * set: what reuses the request's Host (the CSP's frame origins) builds from that one Host only.
 * The desktop (no `server`) keeps the exact list: nothing tunnels to it.
 */
export function checkHost(hostHeader: string | undefined, allowed: ReadonlySet<string>, rule: HostRule = {}): string | undefined {
  if (typeof hostHeader !== 'string') return undefined
  const host = hostHeader.trim().toLowerCase()
  if (host === '') return undefined
  if (allowed.has(host)) return host
  return rule.anyLoopbackPort === true && isLoopbackAnyPort(host) ? host : undefined
}

/** The three loopback literals `allowedHosts` always lists, before their port. */
const LOOPBACK_HOST_PREFIXES = ['127.0.0.1:', 'localhost:', '[::1]:'] as const

/**
 * A lowercased Host that is exactly one loopback literal, a colon and a port 1-65535 written as a
 * browser writes it: decimal digits only (no `+`, sign, space or suffix), no leading zero. No
 * regex (repo rule); a prefix and a digit walk.
 */
export function isLoopbackAnyPort(host: string): boolean {
  for (const prefix of LOOPBACK_HOST_PREFIXES) {
    if (host.startsWith(prefix)) return isPortText(host.slice(prefix.length))
  }
  return false
}

function isPortText(text: string): boolean {
  if (text.length === 0 || text.length > 5 || text.startsWith('0')) return false
  for (const c of text) if (c < '0' || c > '9') return false
  const port = Number(text)
  return port >= 1 && port <= 65535
}

export interface OriginRule {
  /** The scheme the gateway itself serves: `https` with TLS settings, else `http`. */
  scheme: 'http' | 'https'
  /** The proxy's origin when one is in front (settings.ts externalOriginOf). */
  externalOrigin?: string
}

/**
 * Whether a request's `Origin` is the cockpit's own page: the external origin (a proxy in front:
 * the browser saw `https://box.ts.net` while the peer and Host may be 127.0.0.1), or the gateway's
 * own `<scheme>://<host>` for the request's already allowed Host. A missing Origin is refused:
 * browsers always send one on a WebSocket upgrade and on a POST, and a non-browser client gets a
 * handshake of its own later (design §10), never a relaxed check. `null` (a sandboxed frame, a
 * file: page) is refused like any other foreign origin.
 */
export function checkOrigin(origin: string | undefined, host: string, rule: OriginRule): boolean {
  if (typeof origin !== 'string') return false
  const o = origin.trim().toLowerCase()
  if (o === '') return false
  if (rule.externalOrigin !== undefined) {
    if (o === rule.externalOrigin) return true
    // A request under the proxy's own name came through the proxy: only its origin is the page's
    // (the same name over the other scheme is another origin, a page the person never opened).
    if (host === new URL(rule.externalOrigin).host) return false
  }
  return o === `${rule.scheme}://${host}`
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** Constant-time comparison of a secret the client gave with the one main holds. */
export function secretMatches(given: unknown, secret: string): boolean {
  if (typeof given !== 'string' || given.length === 0 || secret.length === 0) return false
  return timingSafeEqual(digest(given), digest(secret))
}

/**
 * The web shell's CSP (design-web.md §4.1): its own scripts and socket only, never framed, and
 * frames only from the plugin paths (`/p/…`, and inline overlays' `/o/…`, each served with a CSP
 * and sandbox of their own, §5.5, plugin-pages.ts).
 * A path-limited source needs a full origin, so `frameOrigins` lists every origin the page may be
 * loaded under (the request's own and the external one). `style-src 'unsafe-inline'`: xterm's DOM
 * renderer writes `<style>` elements of its own. `connect-src 'self'` covers the page's own
 * ws:/wss: (CSP3).
 */
export function webShellCsp(frameOrigins: readonly string[]): string {
  const frames = [...new Set(frameOrigins)].flatMap((o) => [`${o}${PLUGIN_PAGES_PATH}`, `${o}${OVERLAY_PAGES_PATH}`]).join(' ')
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `frame-src ${frames || "'none'"}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
}
