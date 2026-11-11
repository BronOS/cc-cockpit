// The web project picker's data side (picker.tsx draws it): the open project windows from the
// gateway (PROJECTS_PATH, signed-in devices only) and the link to each. In server mode (design-web.md
// §9.8) also the recent projects and the open: a POST of a server path or a recent id, answered with
// the project's id. DOM-free, for unit tests.
import {
  PROJECTS_PATH,
  type WebOpenProjectRequest,
  type WebProjectEntry,
  type WebRecentProject
} from '../../shared/web-protocol'

export type ProjectsResult =
  /** `server` and `recent` as the gateway said (a UI hint: main decides whether a POST is taken). */
  | { ok: true; projects: WebProjectEntry[]; server: boolean; recent: WebRecentProject[] }
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
  const { id, name, path } = raw as Record<string, unknown>
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof path !== 'string') return undefined
  return { id, name, path }
}

function recentOf(raw: unknown): WebRecentProject | undefined {
  const entry = entryOf(raw)
  return entry && { ...entry, missing: (raw as { missing?: unknown }).missing === true }
}

/** Reads the open projects (and in server mode the recent ones) from the gateway; never throws. */
export async function loadOpenProjects(fetchFn: Fetch): Promise<ProjectsResult> {
  try {
    const res = await fetchFn(PROJECTS_PATH, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return { ok: false, signedOut: true }
    if (!res.ok) return { ok: false, signedOut: false, error: `the host answered ${res.status}` }
    const body = (await res.json()) as { projects?: unknown; server?: unknown; recent?: unknown }
    if (!Array.isArray(body.projects)) return { ok: false, signedOut: false, error: 'the host answered something else' }
    const server = body.server === true
    const recent = server && Array.isArray(body.recent) ? body.recent.flatMap((p) => recentOf(p) ?? []) : []
    return { ok: true, projects: body.projects.flatMap((p) => entryOf(p) ?? []), server, recent }
  } catch {
    return { ok: false, signedOut: false, error: 'the host did not answer' }
  }
}

/**
 * Asks the server to open a folder by its path on the server, or a recent project by id (server mode
 * only; elsewhere the gateway answers 404). The error is the host's own text when it sent one, shown
 * as text in the asking view only; never throws.
 */
export async function openProject(fetchFn: Fetch, request: WebOpenProjectRequest): Promise<OpenResult> {
  try {
    const res = await fetchFn(PROJECTS_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    })
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
