// The project pickers' pure logic (the desktop window's and server mode's browser picker): how a path
// is shown, what the filter keeps, where the keyboard highlight goes, how old a row is. DOM-free so
// the unit tests (plain Node) cover it. The desktop picker's Servers section (remote servers,
// design-remote-desktop.md §3) takes its labels, order and grouping from here too.
import type { ProjectSummary, RemoteServerInfo, RemoteServerSettings } from '../../shared/ipc'
import { checkSshHost, parseRemoteLink, tunnelCommand, type RemoteAnswers, type RemoteNeed, type RemoteRecent, type RemoteVia, type SshAuth } from '../../shared/remote-servers'

/**
 * `path` with the home folder written as `~` (`/Users/me/src/app` -> `~/src/app`). Only a whole
 * leading folder counts: `/Users/meg` is not under `/Users/me`. A home of `/` (or none) shortens
 * nothing, since every path would turn into `~...`.
 */
export function tildePath(path: string, home: string | undefined): string {
  if (!home) return path
  const base = home.replace(/[/\\]+$/, '')
  if (base === '') return path
  if (path === base) return '~'
  const next = path.charAt(base.length)
  if (path.startsWith(base) && (next === '/' || next === '\\')) return '~' + path.slice(base.length)
  return path
}

/**
 * The recent projects whose name or path contains `query`, ignoring case and the surrounding
 * spaces, in their recent order. The `~` form of the path matches too, since that is what the row
 * shows: typing `~/src` finds what is listed as `~/src/...`.
 */
export function filterProjects<T extends Pick<ProjectSummary, 'name' | 'path'>>(projects: readonly T[], query: string, home: string | undefined): T[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...projects]
  return projects.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      tildePath(p.path, home).toLowerCase().includes(q)
  )
}

/** The first row Enter can open (a missing folder cannot be opened), or -1. */
export function firstOpenable(rows: readonly Pick<ProjectSummary, 'missing'>[]): number {
  return rows.findIndex((r) => !r.missing)
}

/**
 * Where ↑ (`step` -1) or ↓ (+1) moves the highlight from `from`: the next openable row that way,
 * skipping missing ones (Enter could not open them; their Relink/Forget buttons are reached with
 * Tab). It stops at the ends rather than wrapping, so holding ↓ settles on the last row. With
 * nothing highlighted (-1) either key lands on the first openable row.
 */
export function moveHighlight(rows: readonly Pick<ProjectSummary, 'missing'>[], from: number, step: 1 | -1): number {
  if (from < 0 || from >= rows.length) return firstOpenable(rows)
  for (let i = from + step; i >= 0 && i < rows.length; i += step) {
    if (!rows[i]!.missing) return i
  }
  return from
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * When a project was last opened, as a row's short note: "just now", "5 min ago", "3 h ago",
 * "yesterday", "4 days ago", "3 weeks ago", then the date (`2026-03-14`, the same on every browser,
 * unlike a locale's format). A time in the future (another clock) reads as "just now".
 */
export function openedAgo(at: number, now: number): string {
  const age = now - at
  if (age < MINUTE) return 'just now'
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`
  const days = Math.floor(age / DAY)
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------------------------------------------------------------------------------------
// Remote servers (the desktop picker's Servers section). Every string a server or the person's
// ssh produced (a project name, an error) stays plain text: React renders it as text, and nothing
// here builds markup.

/**
 * How a server is reached, as its row's small label: `ssh devbox`, `ssh me@devbox:2222` (a port
 * only when one is set; an IPv6 literal in brackets then, as in a URL), `tunnel :7331`, or the
 * Direct origin.
 */
export function viaLabel(via: RemoteVia): string {
  if (via.kind === 'ssh') {
    const target = via.user === undefined ? via.host : `${via.user}@${via.host}`
    if (via.port === undefined) return `ssh ${target}`
    const bare = via.host.includes(':') && !via.host.startsWith('[')
    return `ssh ${via.user === undefined ? '' : `${via.user}@`}${bare ? `[${via.host}]` : via.host}:${via.port}`
  }
  if (via.kind === 'tunnel') return `tunnel :${via.localPort}`
  return via.origin
}

/**
 * Whether a Direct origin's host is this machine: `localhost` (and `*.localhost`), 127.0.0.0/8 or
 * `[::1]`. Read with `URL` (no regexes; the origin was parsed by main already).
 */
export function isLoopbackOrigin(origin: string): boolean {
  let host: string
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') return true
  const parts = host.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => p !== '' && p.length <= 3 && [...p].every((c) => c >= '0' && c <= '9'))
}

/** The Link tab's confirm before a plain-http link to another machine is first connected (`plainHttpToConfirm`). */
export const PLAIN_HTTP_WARNING =
  'This link is not encrypted: the sign-in and everything you type travel in clear over the network. Connect anyway?'

/**
 * The origin the person must confirm before the Link tab connects, or undefined when there is nothing
 * to confirm: a link over plain http to a host that is not this machine (design §7, §8: the token,
 * the device cookie and every keystroke would cross the network in clear). A link that does not
 * parse is main's to refuse; an Edit that keeps the saved origin was confirmed when it was first
 * connected (the row's "not encrypted" note says so since).
 */
export function plainHttpToConfirm(tab: ConnectTab, fields: Pick<ConnectFields, 'link'>, saved?: RemoteVia): string | undefined {
  if (tab !== 'link') return undefined
  const link = parseRemoteLink(fields.link)
  if ('error' in link || !link.origin.startsWith('http:') || isLoopbackOrigin(link.origin)) return undefined
  if (saved?.kind === 'direct' && saved.origin === link.origin) return undefined
  return link.origin
}

/**
 * A server's notes under its name (design-remote-desktop.md §2, §6): the secret store cannot keep
 * the device cookie (each launch pairs again), and a Direct link over plain http to another machine
 * (the server's own confirm already allowed it; the row says so).
 */
export function serverNotes(server: Pick<RemoteServerInfo, 'via' | 'cookieKept'>): string[] {
  const notes: string[] = []
  if (!server.cookieKept) notes.push('not remembered: no keyring')
  if (server.via.kind === 'direct' && server.via.origin.startsWith('http:') && !isLoopbackOrigin(server.via.origin)) {
    notes.push('not encrypted')
  }
  return notes
}

/** A server's state as its row shows it: the text and how it reads (a spinner tone, an error, fine). */
export interface ServerStateLabel {
  text: string
  tone: 'busy' | 'error' | 'ok'
}

function windowsText(n: number): string {
  return n === 1 ? '1 window open' : `${n} windows open`
}

/**
 * The connection state (SSH: the tunnel's) and the open windows, as one short label; undefined when
 * there is nothing to say (a closed server, or a Direct one with no window). A dropped tunnel that
 * restarts by itself says so, and a stopped one with an error shows the link's words.
 */
export function serverStateLabel(server: Pick<RemoteServerInfo, 'connection' | 'windows'>): ServerStateLabel | undefined {
  const c = server.connection
  if (c?.state === 'connecting') return { text: 'connecting…', tone: 'busy' }
  if (c?.state === 'down') {
    return c.retrying ? { text: `connection lost: ${c.error} · retrying`, tone: 'error' } : { text: `cannot connect: ${c.error}`, tone: 'error' }
  }
  if (c?.state === 'up') return { text: server.windows > 0 ? `connected · ${windowsText(server.windows)}` : 'connected', tone: 'ok' }
  return server.windows > 0 ? { text: windowsText(server.windows), tone: 'ok' } : undefined
}

/** A server's recent projects, newest first (main keeps them so; sorted again for a hand-edited file). */
export function remoteRecentRows(recent: readonly RemoteRecent[]): RemoteRecent[] {
  return [...recent].sort((a, b) => b.at - a.at)
}

/** When a server was last used from this app: its newest recent project, or -1 for none. */
function lastUsed(server: Pick<RemoteServerInfo, 'recent'>): number {
  return server.recent.reduce((max, r) => Math.max(max, r.at), -1)
}

/**
 * The servers in the picker's order: the most recently used first (by their newest recent
 * project), then the never-used ones by name (case-insensitive), so a new server lands where the
 * person looks for it. Stable for equal keys.
 */
export function sortServers<T extends Pick<RemoteServerInfo, 'name' | 'recent'>>(servers: readonly T[]): T[] {
  return [...servers].sort((a, b) => {
    const diff = lastUsed(b) - lastUsed(a)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** One server as the Servers section draws it. */
export interface ServerGroup {
  server: RemoteServerInfo
  via: string
  state: ServerStateLabel | undefined
  notes: string[]
  /** Its recent remote projects, newest first. */
  projects: RemoteRecent[]
}

/** The Servers section's model: the servers in order, each with its labels and its projects. Empty: the section's empty text. */
export function groupServers(servers: readonly RemoteServerInfo[]): ServerGroup[] {
  return sortServers(servers).map((server) => ({
    server,
    via: viaLabel(server.via),
    state: serverStateLabel(server),
    notes: serverNotes(server),
    projects: remoteRecentRows(server.recent)
  }))
}

/** The Connect to server form's tabs (connect-form.tsx, design-remote-desktop.md §3). */
export type ConnectTab = 'ssh' | 'tunnel' | 'link'

/** The tab that edits a saved server: its own kind, locked (Edit cannot change how a server is reached). */
export function tabOf(via: RemoteVia): ConnectTab {
  return via.kind === 'direct' ? 'link' : via.kind
}

/** How the SSH tab signs in: the radio's value (`auto` is "Agent and my keys"). */
export type ConnectAuth = 'auto' | 'password' | 'key'

/** Every field of the form as typed (text, so a half-typed port is kept as is); one set for all tabs. */
export interface ConnectFields {
  host: string
  user: string
  port: string
  auth: ConnectAuth
  keyPath: string
  ccc: string
  sshHost: string
  localPort: string
  remotePort: string
  /** My own tunnel's add-device link (the Link tab has its own, `link`). */
  tunnelLink: string
  link: string
  name: string
}

/** My own tunnel's defaults (design §3): the server's gateway port, and the local port beside it. */
export const DEFAULT_REMOTE_PORT = 7330
export const DEFAULT_LOCAL_PORT = 7331

export function emptyConnectFields(): ConnectFields {
  return {
    host: '',
    user: '',
    port: '',
    auth: 'auto',
    keyPath: '',
    ccc: '',
    sshHost: '',
    localPort: String(DEFAULT_LOCAL_PORT),
    remotePort: String(DEFAULT_REMOTE_PORT),
    tunnelLink: '',
    link: '',
    name: ''
  }
}

/**
 * The form prefilled for Edit (design §3): the saved settings of that kind. A Direct server keeps
 * only its origin (an access link is never stored), so its Link field starts with the origin; a
 * new link with a token signs in again. The name is the current one.
 */
export function editFields(server: Pick<RemoteServerInfo, 'via' | 'name'>): ConnectFields {
  const f = { ...emptyConnectFields(), name: server.name }
  const via = server.via
  if (via.kind === 'ssh') {
    const auth = via.auth ?? { kind: 'auto' }
    return {
      ...f,
      host: via.host,
      user: via.user ?? '',
      port: via.port === undefined ? '' : String(via.port),
      auth: auth.kind,
      keyPath: auth.kind === 'key' ? auth.path : '',
      ccc: via.ccc ?? ''
    }
  }
  if (via.kind === 'tunnel') return { ...f, sshHost: via.sshHost ?? '', localPort: String(via.localPort), remotePort: String(via.remotePort) }
  return { ...f, link: via.origin }
}

/** A port as typed: a whole number 1..65535 (digits only, no sign, no exponent), or undefined. */
export function parsePort(text: string): number | undefined {
  const t = text.trim()
  if (t === '' || t.length > 5) return undefined
  for (const c of t) if (c < '0' || c > '9') return undefined
  const n = Number(t)
  return n >= 1 && n <= 65535 ? n : undefined
}

const PORT_ERROR = 'a port is a number from 1 to 65535'

/** Whether the tab has what Connect needs at all (main checks the rest and says what is wrong). */
export function canConnect(tab: ConnectTab, f: ConnectFields): boolean {
  if (tab === 'ssh') return f.host.trim() !== '' && (f.auth !== 'key' || f.keyPath.trim() !== '')
  if (tab === 'tunnel') return f.localPort.trim() !== '' && f.remotePort.trim() !== ''
  return f.link.trim() !== ''
}

/**
 * The settings the tab's fields make (`remote.connect`, `remote.edit`): trimmed, empty optional
 * fields left out, ports read as numbers. Only what the form itself can tell (a port that is not a
 * number, a key file with no path) is refused here; main checks every field again.
 */
export function connectSettings(tab: ConnectTab, f: ConnectFields): RemoteServerSettings | { error: string } {
  const name = f.name.trim()
  const named = name === '' ? {} : { name }
  if (tab === 'link') return { kind: 'direct', link: f.link.trim(), ...named }
  if (tab === 'tunnel') {
    const localPort = parsePort(f.localPort)
    const remotePort = parsePort(f.remotePort)
    if (localPort === undefined || remotePort === undefined) return { error: PORT_ERROR }
    const sshHost = f.sshHost.trim()
    const link = f.tunnelLink.trim()
    return { kind: 'tunnel', localPort, remotePort, ...(sshHost === '' ? {} : { sshHost }), ...(link === '' ? {} : { link }), ...named }
  }
  const user = f.user.trim()
  const ccc = f.ccc.trim()
  let port: number | undefined
  if (f.port.trim() !== '') {
    port = parsePort(f.port)
    if (port === undefined) return { error: PORT_ERROR }
  }
  let auth: SshAuth | undefined
  if (f.auth === 'password') auth = { kind: 'password' }
  else if (f.auth === 'key') {
    const path = f.keyPath.trim()
    if (path === '') return { error: 'choose the key file' }
    auth = { kind: 'key', path }
  }
  return {
    kind: 'ssh',
    host: f.host.trim(),
    ...(user === '' ? {} : { user }),
    ...(port === undefined ? {} : { port }),
    ...(auth === undefined ? {} : { auth }),
    ...(ccc === '' ? {} : { ccc }),
    ...named
  }
}

/**
 * My own tunnel's two commands (design §3), live from the fields: the tunnel (`tunnelCommand`, the
 * line main's waiting page shows too) and the add-device one whose link goes in the form. An SSH
 * host that is empty or would not pass main's allowlist stands as `<host>`, so a printed command
 * never carries what the person could not save. Undefined while a port is not a number yet.
 */
export function tunnelCommands(f: Pick<ConnectFields, 'sshHost' | 'localPort' | 'remotePort'>): { tunnel: string; addDevice: string } | undefined {
  const localPort = parsePort(f.localPort)
  const remotePort = parsePort(f.remotePort)
  if (localPort === undefined || remotePort === undefined) return undefined
  const host = f.sshHost.trim()
  const sshHost = host !== '' && checkSshHost(host) === undefined ? host : undefined
  return {
    tunnel: tunnelCommand({ localPort, remotePort, ...(sshHost === undefined ? {} : { sshHost }) }),
    addDevice: `ssh ${sshHost ?? '<host>'} ccc web add-device`
  }
}

// ---------------------------------------------------------------------------------------------
// Asking the person (design §5.4). A connect, open or edit that needs a host key, a password or a
// passphrase answers `{ ok: false, need }`; the picker shows the prompt and calls again with every
// answer of that connect so far (main keeps nothing between calls). Main is stateless about wrong
// tries too: every wrong secret comes back as `again: true`, so counting them is the picker's.

/** One connect's (or open's) answers so far, and how many times each secret came back wrong. */
export interface PromptFlow {
  answers: RemoteAnswers
  wrong: { password: number; passphrase: number }
}

export function newPromptFlow(): PromptFlow {
  return { answers: {}, wrong: { password: 0, passphrase: 0 } }
}

/** What the person answered a prompt: the fingerprint they trusted, or a secret and Remember. */
export type PromptAnswer = { need: 'hostKey'; sha256: string } | { need: 'password' | 'passphrase'; secret: string; remember: boolean }

/** The prompt to show (`retry`: the last one was wrong, say so), or the error that ends the connect. */
export type PromptStep = { ask: RemoteNeed; retry: boolean } | { error: string }

/**
 * What to do with a `need` (design §3: "a wrong one asks again once, then the error"): the first
 * `again` for a secret asks once more, saying it was wrong; a second shows "Wrong password" /
 * "Wrong passphrase" instead of a third prompt. A `need` for something already answered and not
 * called wrong (main ignored it), or for the very host key just trusted, is an error too: asking
 * again would loop.
 */
export function promptStep(flow: PromptFlow, need: RemoteNeed): { flow: PromptFlow; step: PromptStep } {
  if (need.need === 'hostKey') {
    if (flow.answers.hostKey === need.sha256) return { flow, step: { error: `the host key of ${need.address} could not be confirmed` } }
    return { flow, step: { ask: need, retry: false } }
  }
  const name = need.need
  if (need.again === true) {
    const wrong = { ...flow.wrong, [name]: flow.wrong[name] + 1 }
    const next = { ...flow, wrong }
    if (wrong[name] >= 2) return { flow: next, step: { error: name === 'password' ? 'Wrong password' : 'Wrong passphrase' } }
    return { flow: next, step: { ask: need, retry: true } }
  }
  if (flow.answers[name] !== undefined) {
    return { flow, step: { error: name === 'password' ? 'the server did not take the password' : `the passphrase did not open ${need.path}` } }
  }
  return { flow, step: { ask: need, retry: false } }
}

/** The flow with one more answer: a new answer for the same thing replaces the old one, the others stay. */
export function withAnswer(flow: PromptFlow, answer: PromptAnswer): PromptFlow {
  if (answer.need === 'hostKey') return { ...flow, answers: { ...flow.answers, hostKey: answer.sha256 } }
  return { ...flow, answers: { ...flow.answers, [answer.need]: answer.secret, remember: answer.remember } }
}
