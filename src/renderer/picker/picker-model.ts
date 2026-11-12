// The project pickers' pure logic (the desktop window's and server mode's browser picker): how a path
// is shown, what the filter keeps, where the keyboard highlight goes, how old a row is. DOM-free so
// the unit tests (plain Node) cover it. The desktop picker's Servers section (remote servers,
// design-remote-desktop.md §3) takes its labels, order and grouping from here too.
import type { ProjectSummary, RemoteConnectRequest, RemoteServerInfo } from '../../shared/ipc'
import type { RemoteRecent, RemoteVia } from '../../shared/remote-servers'

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

/** How a server is reached, as its row's small label: `ssh devbox`, `ssh me@devbox`, `tunnel :7331`, or the Direct origin. */
export function viaLabel(via: RemoteVia): string {
  if (via.kind === 'ssh') return via.user === undefined ? `ssh ${via.host}` : `ssh ${via.user}@${via.host}`
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
 * restarts by itself says so, and a stopped one with an error shows ssh's words.
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

/** The Connect to server form's two ways in (connect-form.tsx). */
export type ConnectKind = 'ssh' | 'link'

/**
 * The request the Connect form's fields make: trimmed, with an empty name or `ccc` path left out
 * (the path is SSH's only). Main checks every field again.
 */
export function connectRequest(kind: ConnectKind, fields: { host: string; link: string; name: string; ccc: string }): RemoteConnectRequest {
  const name = fields.name.trim()
  const named = name === '' ? {} : { name }
  if (kind === 'link') return { kind: 'direct', link: fields.link.trim(), ...named }
  const ccc = fields.ccc.trim()
  return { kind: 'ssh', host: fields.host.trim(), ...(ccc === '' ? {} : { ccc }), ...named }
}
