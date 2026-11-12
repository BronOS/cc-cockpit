// Saved remote servers (design-remote-desktop.md §2, §5.1, §6): the record kept in `app.json` ›
// `remoteServers`, its tolerant validation, the access-link parser Direct and My own tunnel use, and
// the allowlist checks that stand between typed text (a host, a user, a key path, the `ccc` path) and
// a dial, a remote command or a command the picker prints for the person to paste.
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
/** Linux caps a user name at 32; a directory account (`me@corp.example`) runs longer. */
const MAX_USER = 100
const MAX_CCC_PATH = 1024
const MAX_KEY_PATH = 1024
const MAX_ORIGIN = 300
/** An encrypted cookie is a few hundred bytes (base64 of keychain ciphertext); this is far above that. */
const MAX_COOKIE = 4096
/**
 * A password or passphrase as typed (before encryption). Far above any real one; the cap keeps an
 * encrypted value under `MAX_STORED_SECRET` (base64 and the store's own framing add about half).
 */
export const MAX_REMOTE_SECRET = 1024
/** An encrypted password or passphrase as stored in the record (the cookie's cap: same store, same framing). */
const MAX_STORED_SECRET = MAX_COOKIE
/** A host key type (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `sk-ssh-ed25519@openssh.com`); the longest real one is 34. */
const MAX_KEY_TYPE = 64
/** `SHA256:` and the unpadded base64 of 32 bytes: the `ssh-keygen -l` form (main/remote/known-hosts.ts `fingerprint`). */
const SHA256_PREFIX = 'SHA256:'
const SHA256_B64_LENGTH = 43
const MAX_LINK = 2048
/** The same cap the web client puts on the `#t=` token (renderer/web/sign-in.ts `MAX_TOKEN_LENGTH`). */
const MAX_TOKEN = 512

/**
 * How the built-in SSH client signs in (design §2, §5.1). A record with no `auth` (a first-version
 * record, or one saved with the default) reads as `auto`: use `sshAuthOf`, never `via.auth` directly.
 */
export type SshAuth =
  /** The agent, then the config's `IdentityFile`s or the default key files. Uses no stored secret. */
  | { kind: 'auto' }
  /** `secrets.password`, or asked each launch when not remembered. */
  | { kind: 'password' }
  /** That key file only (absolute or `~/`; read when dialling, never stored), with `secrets.passphrase` when it has one. */
  | { kind: 'key'; path: string }

/** How a saved server is reached (design §2). */
export type RemoteVia =
  /**
   * Built-in SSH. `host` is a host name, address or `~/.ssh/config` alias (never `user@`: a typed
   * `user@host` is split into `user` and `host` on save and on read). Empty `user` / `port`: the
   * config's, else the local user name / 22. `ccc` is the path override for the remote `ccc`.
   */
  | { kind: 'ssh'; host: string; user?: string; port?: number; auth?: SshAuth; ccc?: string }
  /**
   * My own tunnel (design §6): the person's `ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort>`.
   * The page's origin is `http://127.0.0.1:<localPort>`; `sshHost` is only printed in the commands
   * the form shows (never dialled by the app), so it holds the same allowlist as an SSH host.
   */
  | { kind: 'tunnel'; localPort: number; remotePort: number; sshHost?: string }
  /** `scheme://host[:port]` of the link, nothing else kept. */
  | { kind: 'direct'; origin: string }

/**
 * What the picker answered so far in one connect or open (design §5.4). The picker keeps every
 * answer of that connect and resends them all on each retry; main uses them for that call only and
 * saves nothing from them until the dial and the pairing succeeded. `hostKey` is the `SHA256:`
 * fingerprint the person trusted (main compares it with the key it sees on the new dial);
 * `remember`: keep the password or passphrase encrypted (else main's memory for the app's life).
 */
export interface RemoteAnswers {
  hostKey?: string
  password?: string
  passphrase?: string
  remember?: boolean
}

/**
 * What a connect or open needs from the person before it can go on (design §5.4): the picker shows
 * the dialog and calls again with the answer added. `again`: the last one tried was wrong. A
 * passphrase's `path` is the key file as the record has it.
 */
export type RemoteNeed =
  | { need: 'hostKey'; type: string; sha256: string; address: string }
  | { need: 'password'; again?: true }
  | { need: 'passphrase'; path: string; again?: true }

/**
 * The command My own tunnel shows (design §3, §6): `ssh -N -L 127.0.0.1:<L>:127.0.0.1:<P> <host>`,
 * `<host>` standing in when the form has no SSH host. `sshHost` is checked by `checkSshHost` on
 * save, so the printed line never carries a shell metacharacter.
 */
export function tunnelCommand(via: { localPort: number; remotePort: number; sshHost?: string }): string {
  return `ssh -N -L 127.0.0.1:${via.localPort}:127.0.0.1:${via.remotePort} ${via.sshHost ?? '<host>'}`
}

/** The secrets a record may keep, by name (design §2): beside the cookie, never inside `via`. */
export type RemoteSecretName = 'password' | 'passphrase'

/** The record's encrypted secrets, each as `SecretStore.encrypt` returned it, never plain. */
export type RemoteSecrets = Partial<Record<RemoteSecretName, string>>

/** The host key the person trusted (or `known_hosts` vouched for) for a built-in SSH server (design §5.3). Not secret. */
export interface RemoteHostKey {
  /** The key's type as the server sent it (`ssh-ed25519`, `ecdsa-sha2-nistp256`, `rsa-sha2-512` keys are `ssh-rsa`). */
  type: string
  /** `SHA256:<43 base64 characters>`, the `ssh-keygen -l` form. */
  sha256: string
}

export interface RemoteRecent {
  projectId: string
  name: string
  at: number
}

export interface RemoteServer {
  /** Random, local only; names the window partition (`remotePartition`, main/remote/electron-remote-window.ts) and nothing a server sees. */
  id: string
  /** Shown in the picker; default is the SSH host or the URL's host. */
  name: string
  via: RemoteVia
  /** The last 8 remote projects opened from this app, newest first (names come from the server: plain text). */
  recent: RemoteRecent[]
  /** The device cookie, encrypted by the `SecretStore` (`encrypt`/`decrypt`), never plain. */
  cookie?: string
  /**
   * Built-in SSH: the remembered password / passphrase, encrypted like the cookie and stripped with
   * it on every path out of the store (`RemoteServerRecord`). Only the one the record's `auth` uses
   * is kept (`password` for password, `passphrase` for key); the validator drops the other.
   */
  secrets?: RemoteSecrets
  /** Built-in SSH: the listener's preferred local port, kept so the page's origin (its `localStorage`) stays the same. */
  localPort?: number
  /** Built-in SSH: the trusted host key (design §5.3). */
  hostKey?: RemoteHostKey
}

/**
 * A saved server as every reader outside the store gets it: never the cookie, never the secrets
 * (encrypted or not). The store's `get` and `add` answer this; nothing else hands out a record.
 */
export type RemoteServerRecord = Omit<RemoteServer, 'cookie' | 'secrets'>

/** How an SSH server signs in: its `auth`, or `auto` when it has none (design §2: a first-version record keeps working). */
export function sshAuthOf(via: Extract<RemoteVia, { kind: 'ssh' }>): SshAuth {
  return via.auth ?? { kind: 'auto' }
}

/** The secret an SSH sign-in uses, or undefined for `auto` (which never asks: a locked key is skipped and named). */
export function secretNameOf(auth: SshAuth): RemoteSecretName | undefined {
  if (auth.kind === 'password') return 'password'
  if (auth.kind === 'key') return 'passphrase'
  return undefined
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
 * `user@host` as `ssh` reads it: split at the LAST `@` (OpenSSH's own rule, so a directory account
 * `me@corp@devbox` is user `me@corp`). No `@`: the host alone. The parts are not checked here.
 */
export function splitSshTarget(text: string): { host: string; user?: string } {
  const at = text.lastIndexOf('@')
  if (at < 0) return { host: text }
  return { user: text.slice(0, at), host: text.slice(at + 1) }
}

/**
 * Why `user` may not be an SSH user name, or undefined when it may. An allowlist (letters, digits,
 * `.`, `-`, `_`, `@` for a directory account), not starting with `-`: the name goes into the SSH
 * protocol, not a shell, but the picker prints it (`ssh user@host`) and a hand-edited `app.json`
 * must not smuggle a control character into either.
 */
export function checkSshUser(user: string): string | undefined {
  if (typeof user !== 'string' || user.length === 0) return 'enter a user name'
  if (user.length > MAX_USER) return 'the user name is too long'
  if (user.startsWith('-')) return 'a user name cannot start with "-"'
  for (let i = 0; i < user.length; i++) {
    const c = user.charCodeAt(i)
    if (!isWord(c) && c !== 0x2e && c !== 0x2d && c !== 0x5f && c !== 0x40) return 'a user name may only hold letters, digits and . - _ @'
  }
  return undefined
}

/**
 * Why `path` may not be a key file path, or undefined when it may: absolute or `~/` (main expands it
 * against the injected home; a relative path would depend on the app's working directory), no
 * control character. Only the path is kept; main reads the file when dialling.
 */
export function checkKeyPath(path: string): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return 'choose a key file'
  if (path.length > MAX_KEY_PATH) return 'the key file path is too long'
  if (hasControl(path)) return 'the key file path may not contain a newline or control character'
  if (!path.startsWith('/') && !path.startsWith('~/')) return 'the key file path must be absolute or start with ~/'
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

/** A saved `auth`, or undefined when absent or damaged (the record then reads as `auto`, as a first-version one does). */
function sshAuthFrom(value: unknown): SshAuth | undefined {
  if (!isPlainObject(value)) return undefined
  if (value['kind'] === 'auto') return { kind: 'auto' }
  if (value['kind'] === 'password') return { kind: 'password' }
  if (value['kind'] === 'key') {
    const path = value['path']
    return typeof path === 'string' && checkKeyPath(path) === undefined ? { kind: 'key', path } : undefined
  }
  return undefined
}

/**
 * An SSH `via` as read: `host` (a typed `user@host` split, so a first-version record's target keeps
 * working), the optional user, port, auth and `ccc`. A damaged host or user drops the record (it
 * cannot be dialled as meant); a `user@host` host beside its own `user` is ambiguous and dropped too.
 * A damaged port, auth or `ccc` is dropped alone: the default (config port, auto, default lookup)
 * still reaches the same server.
 */
function sshViaOf(value: Record<string, unknown>): RemoteVia | undefined {
  const target = splitSshTarget(typeof value['host'] === 'string' ? value['host'] : '')
  const rawUser = value['user']
  if (target.user !== undefined && rawUser !== undefined) return undefined
  const user = target.user ?? rawUser
  if (checkSshHost(target.host) !== undefined) return undefined
  if (user !== undefined && (typeof user !== 'string' || checkSshUser(user) !== undefined)) return undefined
  const via: Extract<RemoteVia, { kind: 'ssh' }> = { kind: 'ssh', host: target.host }
  if (user !== undefined) via.user = user
  if (isLocalPort(value['port'])) via.port = value['port']
  const auth = sshAuthFrom(value['auth'])
  if (auth !== undefined) via.auth = auth
  // A damaged or unsafe override is dropped on its own: the server still works with the default lookup.
  const ccc = value['ccc']
  if (typeof ccc === 'string' && checkCccOverride(ccc) === undefined) via.ccc = ccc
  return via
}

function viaOf(value: unknown): RemoteVia | undefined {
  if (!isPlainObject(value)) return undefined
  if (value['kind'] === 'ssh') return sshViaOf(value)
  if (value['kind'] === 'tunnel') {
    const localPort = value['localPort']
    const remotePort = value['remotePort']
    if (!isLocalPort(localPort) || !isLocalPort(remotePort)) return undefined
    const via: RemoteVia = { kind: 'tunnel', localPort, remotePort }
    // Only printed in the commands: a damaged one is dropped alone (the form shows a placeholder host).
    const sshHost = value['sshHost']
    if (typeof sshHost === 'string' && checkSshHost(sshHost) === undefined) via.sshHost = sshHost
    return via
  }
  if (value['kind'] === 'direct') {
    const origin = originOf(value['origin'])
    return origin === undefined ? undefined : { kind: 'direct', origin }
  }
  return undefined
}

/** A saved host key, or undefined: the type by allowlist, the fingerprint exactly `SHA256:` and 43 base64 characters. */
export function hostKeyOf(value: unknown): RemoteHostKey | undefined {
  if (!isPlainObject(value)) return undefined
  const type = value['type']
  const sha256 = value['sha256']
  if (typeof type !== 'string' || type.length === 0 || type.length > MAX_KEY_TYPE || type.startsWith('-')) return undefined
  for (let i = 0; i < type.length; i++) {
    const c = type.charCodeAt(i)
    if (!isWord(c) && c !== 0x2d && c !== 0x2e && c !== 0x40) return undefined
  }
  if (typeof sha256 !== 'string' || !sha256.startsWith(SHA256_PREFIX)) return undefined
  const b64 = sha256.slice(SHA256_PREFIX.length)
  if (b64.length !== SHA256_B64_LENGTH) return undefined
  for (let i = 0; i < b64.length; i++) {
    const c = b64.charCodeAt(i)
    if (!isWord(c) && c !== 0x2b && c !== 0x2f) return undefined
  }
  return { type, sha256 }
}

/**
 * The stored secrets an SSH record keeps: only the one its `auth` uses (a switch of sign-in leaves
 * no stale credential behind on the next write), each a non-empty string under the cap. Undefined
 * when none is left.
 */
function secretsOf(value: unknown, via: RemoteVia): RemoteSecrets | undefined {
  if (via.kind !== 'ssh' || !isPlainObject(value)) return undefined
  const name = secretNameOf(sshAuthOf(via))
  if (name === undefined) return undefined
  const stored = value[name]
  if (typeof stored !== 'string' || stored.length === 0 || stored.length > MAX_STORED_SECRET) return undefined
  return { [name]: stored }
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

/** The default name of a server with no (usable) name: the SSH host, the tunnel's SSH host (else `tunnel :<port>`), or the link's host. */
export function defaultServerName(via: RemoteVia): string {
  if (via.kind === 'tunnel') return (via.sshHost === undefined ? `tunnel :${via.localPort}` : via.sshHost).slice(0, MAX_NAME)
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

/**
 * The name the person chose for a server, or undefined when they set none (the name is the default
 * one, the SSH host or the link's host: `defaultServerName`). Plugins see a server's name through
 * `ctx.sessions.machines()` (main/remote/machine-status.ts), and a host name is the person's network
 * layout, not something a plugin needs: a server they did not name gets a neutral label there
 * instead. The store keeps an unnamed server's name following its address (Edit), so "equals the
 * default" stays the test of "not named".
 */
export function chosenServerName(server: { name: string; via: RemoteVia }): string | undefined {
  return server.name === defaultServerName(server.via) ? undefined : server.name
}

/** A TCP port: 1..65535 (a local listener's, an SSH server's, a gateway's). */
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
 * deduplicated by project; a secret the record's sign-in does not use, and the built-in client's
 * fields on another kind, are dropped. Never throws.
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
    const secrets = secretsOf(entry['secrets'], via)
    if (secrets !== undefined) server.secrets = secrets
    // The listener's port and the host key are the built-in client's; a tunnel's port is in its `via`.
    if (via.kind === 'ssh' && isLocalPort(entry['localPort'])) server.localPort = entry['localPort']
    const hostKey = via.kind === 'ssh' ? hostKeyOf(entry['hostKey']) : undefined
    if (hostKey !== undefined) server.hostKey = hostKey
    out.push(server)
  }
  return out
}
