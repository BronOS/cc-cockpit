// Saved remote servers (design-remote-desktop.md §2, §5.1, §6): the record kept in `app.json` ›
// `remoteServers`, its tolerant validation, the access-link parser Direct uses, and the two checks
// that stand between a typed host or `ccc` path and the person's own `ssh`.
//
// No Node, no Electron, no regexes (the link and host come from a text box): the renderer's picker
// and main share this file.
import { isPlainObject } from './guards'

/** At most this many saved servers (an `app.json` the person edited by hand cannot grow without bound). */
export const MAX_REMOTE_SERVERS = 32
/** The last remote projects opened from this app, per server. */
export const MAX_REMOTE_RECENT = 8
const MAX_ID = 64
const MAX_NAME = 100
const MAX_PROJECT_ID = 200
const MAX_PROJECT_NAME = 200
const MAX_HOST = 255
const MAX_CCC_PATH = 1024
const MAX_ORIGIN = 300
/** An encrypted cookie is a few hundred bytes (base64 of keychain ciphertext); this is far above that. */
const MAX_COOKIE = 4096
const MAX_LINK = 2048
/** The same cap the web client puts on the `#t=` token (renderer/web/sign-in.ts `MAX_TOKEN_LENGTH`). */
const MAX_TOKEN = 512

/** How a saved server is reached (design §2). */
export type RemoteVia =
  /** `host` as typed (an `ssh_config` alias works); `ccc` is the path override for the remote `ccc`. */
  | { kind: 'ssh'; host: string; ccc?: string }
  /** `scheme://host[:port]` of the link, nothing else kept. */
  | { kind: 'direct'; origin: string }

export interface RemoteRecent {
  projectId: string
  name: string
  at: number
}

export interface RemoteServer {
  /** Random, local only; names the window partition (`persist:remote-<id>`) and nothing a server sees. */
  id: string
  /** Shown in the picker; default is the SSH host or the URL's host. */
  name: string
  via: RemoteVia
  /** The last 8 remote projects opened from this app, newest first (names come from the server: plain text). */
  recent: RemoteRecent[]
  /** The device cookie, encrypted by the `SecretStore` (`encrypt`/`decrypt`), never plain. */
  cookie?: string
  /** SSH: the tunnel's preferred local port, kept so the page's origin (its `localStorage`) stays the same. */
  localPort?: number
}

function isCodeBetween(code: number, lo: number, hi: number): boolean {
  return code >= lo && code <= hi
}

/** A control character (C0, DEL, C1) or a line/paragraph separator: never in a name, host or path. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || isCodeBetween(c, 0x7f, 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/** Display text: a string of 1..max characters with no control characters, trimmed. */
function textOf(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= max && !hasControl(text) ? text : undefined
}

function isWord(c: number): boolean {
  return isCodeBetween(c, 0x30, 0x39) || isCodeBetween(c, 0x41, 0x5a) || isCodeBetween(c, 0x61, 0x7a)
}

/** The id's alphabet: letters, digits, `-` and `_` (it ends up in a partition name and a record key). */
function idOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID) return undefined
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (!isWord(c) && c !== 0x2d && c !== 0x5f) return undefined
  }
  return value
}

/**
 * Why `host` may not go to `ssh`, or undefined when it may (design §5.1). A character allowlist,
 * not a blacklist: the person's `ssh_config` can expand `%h` into a ProxyCommand, where shell
 * metacharacters in the host would run. Letters, digits, `.`, `-`, `_`, `@` (user), `:` (an IPv6
 * literal or `host:port` alias) and `[` `]`; it may not start with `-` (an option) and `--` ends
 * options anyway.
 */
export function checkSshHost(host: string): string | undefined {
  if (typeof host !== 'string' || host.length === 0) return 'enter a host'
  if (host.length > MAX_HOST) return 'the host is too long'
  if (host.startsWith('-')) return 'a host cannot start with "-"'
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i)
    const ok = isWord(c) || c === 0x2e || c === 0x2d || c === 0x5f || c === 0x40 || c === 0x3a || c === 0x5b || c === 0x5d
    if (!ok) return 'a host may only hold letters, digits and . - _ @ : [ ]'
  }
  return undefined
}

/**
 * The characters a word of the remote command may not hold (see `remoteCommand`): the quote
 * itself, the backslash (fish reads `\'` and `\\` inside single quotes), `!` (csh's history
 * substitution fires inside single quotes), and any control character (a newline needs a
 * backslash in csh).
 */
function unsafeWordReason(word: string): string | undefined {
  if (word.includes("'")) return 'it may not contain a single quote'
  if (word.includes('\\')) return 'it may not contain a backslash'
  if (word.includes('!')) return 'it may not contain "!"'
  if (hasControl(word)) return 'it may not contain a newline or control character'
  return undefined
}

/**
 * Why `path` may not be the remote `ccc` override, or undefined when it may. Absolute paths only:
 * the remote script does not expand `~` or look the name up (a relative one would run whatever sits
 * in the login shell's directory).
 */
export function checkCccOverride(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return 'enter a path'
  if (path.length > MAX_CCC_PATH) return 'the path is too long'
  const unsafe = unsafeWordReason(path)
  if (unsafe !== undefined) return unsafe
  if (!path.startsWith('/')) return 'the path must be absolute'
  return undefined
}

/**
 * The printed line when the remote has no `ccc` (exit 127). One word, no quotes: the fixed script
 * may hold no single quote, and the caller matches the last stdout line against it.
 */
export const REMOTE_CCC_MISSING = 'CC-COCKPIT-CCC-NOT-FOUND'

/**
 * The fixed POSIX script `remoteCommand` runs with `sh -c`. `$1` is the override path (empty: none),
 * the rest are the `ccc` arguments. Order: the override, else `$HOME/.config/cc-cockpit/bin/ccc`
 * (server mode's wrapper in the default data dir) when executable, else `ccc` on PATH, else the
 * marker and 127. `exec` leaves the wrapper's exit code as the command's.
 *
 * Constraints, all from the login shell that reads the line ssh builds (see `remoteCommand`): ONE
 * line (a newline inside single quotes needs a backslash in csh), and no single quote, no backslash
 * and no `!` anywhere (see `unsafeWordReason`).
 */
export const REMOTE_SCRIPT =
  'CCC=$1; shift; ' +
  'if [ -z "$CCC" ]; then ' +
  'if [ -x "$HOME/.config/cc-cockpit/bin/ccc" ]; then CCC=$HOME/.config/cc-cockpit/bin/ccc; ' +
  'elif command -v ccc >/dev/null 2>&1; then CCC=ccc; ' +
  `else echo ${REMOTE_CCC_MISSING}; exit 127; fi; ` +
  'fi; ' +
  'exec "$CCC" "$@"'

/**
 * The one string to pass to `ssh` after `-- <host>` (design §5.1), running `ccc <args>` on the
 * remote with the fixed script. Throws on an override or argument that cannot be quoted safely.
 *
 * Why one string: ssh joins every remote argument with spaces and hands the result to the remote
 * account's LOGIN shell, which may be bash, zsh, fish or csh. A `VAR=value cmd` prefix is not valid
 * in fish or csh, and a script with its own quoting would be parsed by that shell first. So the
 * line is only `sh -c '<script>' sh '<override>' '<arg>'...`: every word wrapped in single quotes
 * with none inside, which all five shells read the same way:
 *  - sh, bash, zsh: `'...'` is literal, no escapes.
 *  - fish: single quotes are literal except `\'` and `\\`, so no word holds a backslash or a quote.
 *  - csh/tcsh: single quotes are literal except a backslash-newline and `!` (history substitution,
 *    which a quote does not stop), so no word holds a newline or `!`.
 * `$`, backticks and `~` stay literal inside single quotes in every one of them. The words are
 * checked, never escaped: an unsafe word is refused, not rewritten.
 */
export function remoteCommand(args: readonly string[], override?: string): string {
  const words: string[] = ['sh', '-c', REMOTE_SCRIPT, 'sh', override ?? '', ...args]
  if (override !== undefined && override !== '') {
    const problem = checkCccOverride(override)
    if (problem !== undefined) throw new RangeError(`the ccc path is not usable: ${problem}`)
  }
  for (const word of words) {
    const problem = unsafeWordReason(word)
    if (problem !== undefined) throw new RangeError(`a remote command word is not usable: ${problem}`)
  }
  return words.map((w) => `'${w}'`).join(' ')
}

export type RemoteLink = { origin: string; token?: string } | { error: string }

/**
 * An access link or add-device link typed into Direct (design §6): `http:` or `https:`, no userinfo,
 * the path `/` and no query, optionally `#t=<token>` (the fragment the web client reads,
 * renderer/web/sign-in.ts `linkTokenOf`). Parsed with `URL` only. The origin is all that is kept;
 * the caller uses the token once and drops it.
 */
export function parseRemoteLink(text: string): RemoteLink {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw === '') return { error: 'paste the link the server shows' }
  if (raw.length > MAX_LINK) return { error: 'the link is too long' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: 'this is not a link' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'only http and https links work' }
  if (url.username !== '' || url.password !== '') return { error: 'a link with a user name or password is not accepted' }
  if (url.pathname !== '/') return { error: 'the link must point at the server itself, with no path' }
  if (url.search !== '') return { error: 'the link may not have a query' }
  const origin = url.origin
  if (origin.length > MAX_ORIGIN) return { error: 'the link is too long' }
  if (url.hash === '') return { origin }
  // URLSearchParams does not throw on a string; same read as the web client's `linkTokenOf`.
  const token = new URLSearchParams(url.hash.slice(1)).get('t')
  if (token === null) return { error: 'the part after # must be t=<token>' }
  if (token === '') return { error: 'the link has an empty token' }
  if (token.length > MAX_TOKEN) return { error: 'the link token is too long' }
  return { origin, token }
}

/** A saved `direct` origin: exactly what `parseRemoteLink` keeps, so an edited one that is not is dropped. */
function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const link = parseRemoteLink(value)
  return 'origin' in link && link.token === undefined && link.origin === value ? link.origin : undefined
}

function viaOf(value: unknown): RemoteVia | undefined {
  if (!isPlainObject(value)) return undefined
  if (value['kind'] === 'ssh') {
    const host = typeof value['host'] === 'string' ? value['host'] : ''
    if (checkSshHost(host) !== undefined) return undefined
    const via: RemoteVia = { kind: 'ssh', host }
    // A damaged or unsafe override is dropped on its own: the server still works with the default lookup.
    const ccc = value['ccc']
    if (typeof ccc === 'string' && checkCccOverride(ccc) === undefined) via.ccc = ccc
    return via
  }
  if (value['kind'] === 'direct') {
    const origin = originOf(value['origin'])
    return origin === undefined ? undefined : { kind: 'direct', origin }
  }
  return undefined
}

function recentOf(value: unknown): RemoteRecent[] {
  const out: RemoteRecent[] = []
  if (!Array.isArray(value)) return out
  for (const raw of value) {
    if (out.length >= MAX_REMOTE_RECENT) break
    if (!isPlainObject(raw)) continue
    const projectId = textOf(raw['projectId'], MAX_PROJECT_ID)
    const name = textOf(raw['name'], MAX_PROJECT_NAME)
    const at = raw['at']
    if (projectId === undefined || name === undefined || typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    if (out.some((r) => r.projectId === projectId)) continue
    out.push({ projectId, name, at })
  }
  return out
}

/** The default name of a server with no (usable) name: the SSH host, or the link's host. */
export function defaultServerName(via: RemoteVia): string {
  let name = via.kind === 'ssh' ? via.host : via.origin
  if (via.kind === 'direct') {
    try {
      name = new URL(via.origin).host
    } catch {
      /* the origin itself is the name */
    }
  }
  return name.slice(0, MAX_NAME)
}

/** A tunnel port the person's machine can bind: 1..65535. */
export function isLocalPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

/** A display name for a server, or undefined when `value` is not one (1..100 characters, no control characters). */
export function serverNameOf(value: unknown): string | undefined {
  return textOf(value, MAX_NAME)
}

/** A recent project's id and name as the store keeps them, or undefined. */
export function recentEntryOf(projectId: unknown, name: unknown, at: unknown): RemoteRecent | undefined {
  const list = recentOf([{ projectId, name, at }])
  return list[0]
}

/**
 * `app.json` › `remoteServers` as read (design §2): `app.json` is user-writable, so every entry is
 * checked field by field. A bad entry, an unknown `via` kind, a duplicate id and anything past the
 * 32nd server are dropped; a damaged optional field is dropped alone; recents are capped at 8 and
 * deduplicated by project. Never throws.
 */
export function validateRemoteServers(raw: unknown): RemoteServer[] {
  const out: RemoteServer[] = []
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (out.length >= MAX_REMOTE_SERVERS) break
    if (!isPlainObject(entry)) continue
    const id = idOf(entry['id'])
    const via = viaOf(entry['via'])
    if (id === undefined || via === undefined || out.some((s) => s.id === id)) continue
    const server: RemoteServer = {
      id,
      name: serverNameOf(entry['name']) ?? defaultServerName(via),
      via,
      recent: recentOf(entry['recent'])
    }
    const cookie = entry['cookie']
    if (typeof cookie === 'string' && cookie.length > 0 && cookie.length <= MAX_COOKIE) server.cookie = cookie
    if (isLocalPort(entry['localPort'])) server.localPort = entry['localPort']
    out.push(server)
  }
  return out
}
