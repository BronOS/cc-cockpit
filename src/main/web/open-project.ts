// Opening a project from a browser in server mode (design-web.md §9.8): the PROJECTS_PATH POST's
// body check and what main does with it. With no desktop, the browser picker is the only picker, so
// it may open any folder the server user can read: no more than the shell a device already has.
//
// The body is untrusted: exactly one of `open` / `reopen`, each a plain string, and nothing else of
// it is used. `open` must be absolute and name an existing directory now (nothing is created:
// `mkdir` in a terminal); `reopen` is looked up in main's own recent list (WindowManager.openRecent),
// never used to address a record directly. Then `windows.openPath` runs as the desktop's Open Folder
// does. No regexes (CLAUDE.md, the gateway's parsing). Pure Node, for unit tests.
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { WebOpenProjectReply, WebOpenProjectRequest } from '../../shared/web-protocol'

/** Longer than any path the OS takes (PATH_MAX is 4096 on Linux); the body cap bounds it anyway. */
export const MAX_OPEN_PATH = 4096

/** The body as one request, or the text of what is wrong with it. */
export function parseOpenProjectBody(body: unknown): WebOpenProjectRequest | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected { open } or { reopen }' }
  const fields = body as Record<string, unknown>
  const hasOpen = Object.hasOwn(fields, 'open')
  const hasReopen = Object.hasOwn(fields, 'reopen')
  if (hasOpen === hasReopen) return { error: 'expected exactly one of open and reopen' }
  const value = hasOpen ? fields.open : fields.reopen
  if (typeof value !== 'string' || value === '' || value.length > MAX_OPEN_PATH || value.includes('\0')) {
    return { error: hasOpen ? 'open needs a folder path' : 'reopen needs a project id' }
  }
  return hasOpen ? { open: value } : { reopen: value }
}

export interface OpenProjectDeps {
  /** `windows.openPath`: opens the folder (or finds its open window) and returns its record. */
  openPath(path: string): { id: string }
  /** `windows.openRecent`: the id looked up in the registry's recent list; throws when not there. */
  openRecent(id: string): { id: string }
  /** Injected for tests; default a `stat` that follows links (a link to a folder is a folder). */
  isDirectory?(path: string): boolean
}

function isDirectoryNow(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Runs a checked request; a refusal or a failed open is its text, never a throw. */
export function openProjectFromWeb(request: WebOpenProjectRequest, deps: OpenProjectDeps): WebOpenProjectReply {
  if ('reopen' in request) {
    try {
      return { id: deps.openRecent(request.reopen).id }
    } catch (err) {
      // A missing folder says so (openView's text); an id not in the list says only that.
      return { error: errorText(err) }
    }
  }
  // Relative to what? main's cwd means nothing to the browser, so only an absolute path is taken.
  if (!isAbsolute(request.open)) return { error: `not an absolute path: ${request.open}` }
  const path = resolve(request.open)
  // Checked here, not left to the registry: a known project whose folder is gone would come back
  // as `missing` and a new record is never made for a non-folder, but the text should say why.
  if (!(deps.isDirectory ?? isDirectoryNow)(path)) return { error: `not a folder: ${path}` }
  try {
    return { id: deps.openPath(path).id }
  } catch (err) {
    return { error: errorText(err) }
  }
}
