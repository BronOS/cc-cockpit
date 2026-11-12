// The user agent suffix a remote desktop window adds (design-remote-desktop.md §5.2). The web client
// reads it to pick the desktop key table and to name the device. A UA is page-visible and forgeable,
// so nothing on the server may rest on it: it only decides what the page itself does.

export const DESKTOP_UA_TOKEN = 'cc-cockpit-desktop/'

const MAX_VERSION = 32
const MAX_HOSTNAME = 64

/** Printable ASCII only (no control characters, no DEL, no non-ASCII), parentheses and spaces left out. */
function plain(text: string, max: number): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code >= 0x7f || ch === '(' || ch === ')') continue
    out += ch
    if (out.length >= max) break
  }
  return out
}

/** `cc-cockpit-desktop/<version> (<hostname>)`, made plain and capped so `parseDesktopAgent` reads it back. */
export function desktopAgentSuffix(version: string, hostname: string): string {
  return `${DESKTOP_UA_TOKEN}${plain(version, MAX_VERSION)} (${plain(hostname, MAX_HOSTNAME)})`
}

/**
 * The desktop agent in a user agent string, or undefined. The version runs to the next space and the
 * hostname sits in the parentheses after it; anything oversize, empty, with a control character or
 * non-ASCII text, or with a parenthesis inside the hostname, is no desktop agent. No regexes: this
 * parses text a page was handed.
 */
export function parseDesktopAgent(ua: string): { version: string; hostname: string } | undefined {
  const at = ua.indexOf(DESKTOP_UA_TOKEN)
  if (at < 0) return undefined
  const rest = ua.slice(at + DESKTOP_UA_TOKEN.length)
  const space = rest.indexOf(' ')
  if (space <= 0) return undefined
  const version = rest.slice(0, space)
  if (version.length > MAX_VERSION || !isPlain(version)) return undefined
  const after = rest.slice(space + 1)
  if (!after.startsWith('(')) return undefined
  const close = after.indexOf(')')
  if (close < 0) return undefined
  const hostname = after.slice(1, close)
  if (hostname === '' || hostname.length > MAX_HOSTNAME || hostname.includes('(') || !isPlain(hostname)) return undefined
  return { version, hostname }
}

function isPlain(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x20 || code >= 0x7f) return false
  }
  return true
}
