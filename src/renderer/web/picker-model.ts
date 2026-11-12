// The web project picker's data side (picker.tsx and folder-browser.tsx draw it): the open project
// windows from the gateway (PROJECTS_PATH, signed-in devices only) and the link to each. In server
// mode (design-web.md §9.8) also the recent projects, which server it is, the open, relink and
// forget (a POST of a server path or a recent id, answered with the project's id), and the folder
// browser's listing (FOLDERS_PATH) with the pure path logic behind its breadcrumbs, filter and
// "Go to path" completion. DOM-free, for unit tests.
//
// Paths here are the server's (Linux only in server mode: `/`-separated), built and split with plain
// string operations: the browser has no `path` module, and main normalizes every path it is sent.
import {
  FOLDERS_PATH,
  MAX_FOLDER_ENTRIES,
  PROJECTS_PATH,
  type WebFolderEntry,
  type WebFoldersRequest,
  type WebOpenProjectRequest,
  type WebProjectEntry,
  type WebRecentProject,
  type WebServerHost
} from '../../shared/web-protocol'
import { projectColorOf } from '../../shared/project-color'

export type ProjectsResult =
  /**
   * `server`, `recent` and `host` as the gateway said (a UI hint: main decides whether a POST is
   * taken); `host` absent when main could not read it (or off server mode).
   */
  | { ok: true; projects: WebProjectEntry[]; server: boolean; recent: WebRecentProject[]; host?: WebServerHost }
  /** 401: the device was revoked or expired since the page signed in. */
  | { ok: false; signedOut: true }
  | { ok: false; signedOut: false; error: string }

export type OpenResult = { ok: true; id: string } | { ok: false; signedOut: true } | { ok: false; signedOut: false; error: string }

export type Fetch = (
  input: string,
  init?: {
    credentials?: 'same-origin'
    cache?: 'no-store'
    method?: 'POST'
    headers?: Record<string, string>
    body?: string
  }
) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

function entryOf(raw: unknown): WebProjectEntry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { id, name, path, color } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof path !== 'string') return undefined
  const entry: WebProjectEntry = { id, name, path }
  // Checked here too: the dot drops it into a style (ProjectDot), and only main's checked forms may get there.
  const checked = projectColorOf(color)
  if (checked !== undefined) entry.color = checked
  return entry
}

function recentOf(raw: unknown): WebRecentProject | undefined {
  const entry = entryOf(raw)
  if (!entry) return undefined
  const fields = raw as { missing?: unknown; lastOpenedAt?: unknown }
  const out: WebRecentProject = { ...entry, missing: fields.missing === true }
  if (typeof fields.lastOpenedAt === 'number' && Number.isFinite(fields.lastOpenedAt)) out.lastOpenedAt = fields.lastOpenedAt
  return out
}

function hostOf(raw: unknown): WebServerHost | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { name, user, home } = raw as Record<string, unknown>
  if (typeof name !== 'string' || typeof user !== 'string' || typeof home !== 'string') return undefined
  return { name, user, home }
}

/** Reads the open projects (and in server mode the recent ones and the host) from the gateway; never throws. */
export async function loadOpenProjects(fetchFn: Fetch): Promise<ProjectsResult> {
  try {
    const res = await fetchFn(PROJECTS_PATH, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return { ok: false, signedOut: true }
    if (!res.ok) return { ok: false, signedOut: false, error: `the host answered ${res.status}` }
    const body = (await res.json()) as { projects?: unknown; server?: unknown; recent?: unknown; host?: unknown }
    if (!Array.isArray(body.projects)) return { ok: false, signedOut: false, error: 'the host answered something else' }
    const server = body.server === true
    const recent = server && Array.isArray(body.recent) ? body.recent.flatMap((p) => recentOf(p) ?? []) : []
    const host = server ? hostOf(body.host) : undefined
    return { ok: true, projects: body.projects.flatMap((p) => entryOf(p) ?? []), server, recent, ...(host ? { host } : {}) }
  } catch {
    return { ok: false, signedOut: false, error: 'the host did not answer' }
  }
}

/** A JSON POST to the gateway, signed in by the page's cookie (the gateway checks its Origin). */
function post(fetchFn: Fetch, path: string, body: unknown): ReturnType<Fetch> {
  return fetchFn(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

/**
 * Asks the server to open a folder by its path on the server, reopen a recent project by id, relink a
 * missing one to a new folder (then open it) or forget one (server mode only; elsewhere the gateway
 * answers 404). The error is the host's own text when it sent one, shown as text in the asking view
 * only; never throws.
 */
export async function openProject(fetchFn: Fetch, request: WebOpenProjectRequest): Promise<OpenResult> {
  try {
    const res = await post(fetchFn, PROJECTS_PATH, request)
    if (res.status === 401) return { ok: false, signedOut: true }
    const body = (await res.json().catch(() => undefined)) as { id?: unknown; error?: unknown } | undefined
    if (res.ok && typeof body?.id === 'string' && body.id !== '') return { ok: true, id: body.id }
    if (typeof body?.error === 'string' && body.error !== '') return { ok: false, signedOut: false, error: body.error }
    return { ok: false, signedOut: false, error: `the host answered ${res.status}` }
  } catch {
    return { ok: false, signedOut: false, error: 'the host did not answer' }
  }
}

/** The shell's address for a project: a relative link, so it stays on whatever origin the page has. */
export function projectHref(id: string): string {
  return `?project=${encodeURIComponent(id)}`
}

// ---------------------------------------------------------------------------------------------
// The folder browser (server mode)
// ---------------------------------------------------------------------------------------------

/** One folder as the browser shows it. `error`: not readable (shown in place of the list, Up still works). */
export interface FolderListing {
  path: string
  parent: string | null
  home: string
  folders: WebFolderEntry[]
  hiddenCount: number
  truncated: boolean
  here: { git: boolean; project: boolean }
  note?: string
  error?: string
}

export type FoldersResult = { ok: true; listing: FolderListing } | { ok: false; signedOut: true } | { ok: false; signedOut: false; error: string }

function folderEntryOf(raw: unknown): WebFolderEntry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const { name, git, project, link } = raw as Record<string, unknown>
  // A name is one path segment: never empty, `.`, `..` or with a slash (it is joined onto the path).
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) return undefined
  const out: WebFolderEntry = { name }
  if (git === true) out.git = true
  if (project === true) out.project = true
  if (link === true) out.link = true
  return out
}

/** The answer's fields, each checked: an absolute `path` is the least a listing must have. */
function listingOf(raw: unknown): FolderListing | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || !r.path.startsWith('/') || typeof r.home !== 'string') return undefined
  const parent = typeof r.parent === 'string' && r.parent.startsWith('/') ? r.parent : null
  const base = { path: r.path, parent, home: r.home }
  if (typeof r.error === 'string') {
    return { ...base, folders: [], hiddenCount: 0, truncated: false, here: { git: false, project: false }, error: r.error }
  }
  if (!Array.isArray(r.folders)) return undefined
  const here = (r.here ?? {}) as Record<string, unknown>
  const listing: FolderListing = {
    ...base,
    folders: r.folders.slice(0, MAX_FOLDER_ENTRIES).flatMap((f) => folderEntryOf(f) ?? []),
    hiddenCount: typeof r.hiddenCount === 'number' && r.hiddenCount >= 0 ? Math.floor(r.hiddenCount) : 0,
    truncated: r.truncated === true,
    here: { git: here.git === true, project: here.project === true }
  }
  if (typeof r.note === 'string' && r.note !== '') listing.note = r.note
  return listing
}

/**
 * One folder's subfolders from the server (`request.path` absent: the start folder). A folder the
 * server cannot read is still a listing (`error` set); a request the gateway refused (a bad path, 400)
 * is `ok: false` with its text. Never throws.
 */
export async function loadFolders(fetchFn: Fetch, request: WebFoldersRequest): Promise<FoldersResult> {
  try {
    const res = await post(fetchFn, FOLDERS_PATH, request)
    if (res.status === 401) return { ok: false, signedOut: true }
    const body = (await res.json().catch(() => undefined)) as unknown
    if (res.ok) {
      const listing = listingOf(body)
      return listing ? { ok: true, listing } : { ok: false, signedOut: false, error: 'the host answered something else' }
    }
    const error = (body as { error?: unknown } | undefined)?.error
    return { ok: false, signedOut: false, error: typeof error === 'string' && error !== '' ? error : `the host answered ${res.status}` }
  } catch {
    return { ok: false, signedOut: false, error: 'the host did not answer' }
  }
}

/** `dir`'s subfolder `name` (`/` + name at the root). */
export function childPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

/** One step of the breadcrumbs: what it shows and the folder it goes to. */
export interface Crumb {
  label: string
  path: string
}

/**
 * The breadcrumbs of `path`: under the home folder from `~` (the person's own folders read short),
 * else from `/`. The last crumb is the folder itself. Above home, Up (the listing's `parent`) goes on.
 */
export function breadcrumbs(path: string, home: string): Crumb[] {
  const base = home.length > 1 && home.endsWith('/') ? home.slice(0, -1) : home
  const underHome = base.length > 1 && (path === base || path.startsWith(`${base}/`))
  const crumbs: Crumb[] = underHome ? [{ label: '~', path: base }] : [{ label: '/', path: '/' }]
  let at = underHome ? base : ''
  const rest = underHome ? path.slice(base.length) : path
  for (const part of rest.split('/')) {
    if (part === '') continue
    at = `${at}/${part}`
    crumbs.push({ label: part, path: at })
  }
  return crumbs
}

/** The folders whose name contains `query`, ignoring case and the surrounding spaces, in listing order. */
export function filterFolders(folders: readonly WebFolderEntry[], query: string): WebFolderEntry[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...folders]
  return folders.filter((f) => f.name.toLowerCase().includes(q))
}

/** `~` and `~/…` as the home folder (a shell's habit, typed into "Go to path"); anything else as typed. */
export function expandHome(typed: string, home: string): string {
  const base = home.endsWith('/') && home.length > 1 ? home.slice(0, -1) : home
  if (typed === '~') return base
  if (typed.startsWith('~/')) return `${base}${typed.slice(1)}`
  return typed
}

/**
 * What "Go to path" completes: the folder whose subfolders are the candidates and the name typed so
 * far (`/srv/ap` -> `/srv`, `ap`; `/srv/` -> `/srv`, ``). Undefined for a path that is not absolute
 * (after `~`): there is nothing to complete it against.
 */
export function completionTarget(typed: string, home: string): { dir: string; prefix: string } | undefined {
  const path = expandHome(typed.trim(), home)
  if (!path.startsWith('/')) return undefined
  const cut = path.lastIndexOf('/')
  const dir = cut === 0 ? '/' : path.slice(0, cut)
  return { dir, prefix: path.slice(cut + 1) }
}

/**
 * The full paths "Go to path" offers from `dir`'s listing: the subfolders whose name starts with
 * `prefix`, ignoring case (a path is case-sensitive on the server, so the folder's own spelling is
 * offered), at most `max`.
 */
export function completions(folders: readonly WebFolderEntry[], target: { dir: string; prefix: string }, max = 50): string[] {
  const p = target.prefix.toLowerCase()
  const out: string[] = []
  for (const f of folders) {
    if (out.length >= max) break
    if (f.name.toLowerCase().startsWith(p)) out.push(childPath(target.dir, f.name))
  }
  return out
}

/** The longest start every string shares ('' for none): Tab in "Go to path" fills in that much. */
export function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0] as string
  for (const v of values) {
    let i = 0
    while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++
    prefix = prefix.slice(0, i)
  }
  return prefix
}
