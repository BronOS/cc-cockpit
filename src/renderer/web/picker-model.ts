// The web project picker's data side (picker.tsx draws it): the open project windows from the
// gateway (PROJECTS_PATH, signed-in devices only) and the link to each. DOM-free, for unit tests.
import { PROJECTS_PATH, type WebProjectEntry } from '../../shared/web-protocol'

export type ProjectsResult =
  | { ok: true; projects: WebProjectEntry[] }
  /** 401: the device was revoked or expired since the page signed in. */
  | { ok: false; signedOut: true }
  | { ok: false; signedOut: false; error: string }

export type Fetch = (input: string, init?: { credentials?: 'same-origin'; cache?: 'no-store' }) => Promise<{
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

/** Reads the open projects from the gateway; never throws. */
export async function loadOpenProjects(fetchFn: Fetch): Promise<ProjectsResult> {
  try {
    const res = await fetchFn(PROJECTS_PATH, { credentials: 'same-origin', cache: 'no-store' })
    if (res.status === 401) return { ok: false, signedOut: true }
    if (!res.ok) return { ok: false, signedOut: false, error: `the host answered ${res.status}` }
    const body = (await res.json()) as { projects?: unknown }
    if (!Array.isArray(body.projects)) return { ok: false, signedOut: false, error: 'the host answered something else' }
    return { ok: true, projects: body.projects.flatMap((p) => entryOf(p) ?? []) }
  } catch {
    return { ok: false, signedOut: false, error: 'the host did not answer' }
  }
}

/** The shell's address for a project: a relative link, so it stays on whatever origin the page has. */
export function projectHref(id: string): string {
  return `?project=${encodeURIComponent(id)}`
}
