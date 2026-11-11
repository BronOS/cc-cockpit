// Opening a project from a browser in server mode (design-web.md §9.8): the PROJECTS_PATH POST's
// body check and what main does with it. With no desktop, the browser picker is the only picker, so
// it may open any folder the server user can read: no more than the shell a device already has.
//
// The body is untrusted: exactly one of `open` / `reopen`, each a plain string, and nothing else of
// it is used. `open` must be absolute and name an existing directory now (nothing is created:
// `mkdir` in a terminal); `reopen` is looked up in main's own recent list (WindowManager.openRecent),
// never used to address a record directly. Then `windows.openPath` runs as the desktop's Open Folder
// does. No regexes (CLAUDE.md, the gateway's parsing). Pure Node, for unit tests.
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { errorText } from '../../shared/error-text'
import type { WebOpenProjectReply, WebOpenProjectRequest } from '../../shared/web-protocol'
import { ProjectRefusal } from '../projects/registry'

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
  isDirectory?(path: string): boolean | Promise<boolean>
  /** The server's log: where the detail of a failure that is not shown to the device goes. */
  log?(line: string): void
}

// Async: a path on a hung network mount would block main's event loop in a sync stat, and the path
// is a remote device's choice.
async function isDirectoryNow(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The text a device is answered with for a failed open. A ProjectRefusal (the registry's and the
 * window manager's own refusals) says what is wrong with the request; any other error (a record
 * write failing, EACCES/EIO) carries fs messages with data-dir paths a device is not otherwise
 * shown, so it is logged and answered generically.
 */
function deviceFacingError(err: unknown, deps: OpenProjectDeps, what: string): string {
  if (err instanceof ProjectRefusal) return err.message
  deps.log?.(`web access: ${what} failed: ${errorText(err)}`)
  return `${what} failed`
}

/** Runs a checked request; a refusal or a failed open is its text, never a throw. */
export async function openProjectFromWeb(request: WebOpenProjectRequest, deps: OpenProjectDeps): Promise<WebOpenProjectReply> {
  if ('reopen' in request) {
    try {
      return { id: deps.openRecent(request.reopen).id }
    } catch (err) {
      // A missing folder says so (openView's text); an id not in the list says only that.
      return { error: deviceFacingError(err, deps, 'reopening the project') }
    }
  }
  // Relative to what? main's cwd means nothing to the browser, so only an absolute path is taken.
  if (!isAbsolute(request.open)) return { error: `not an absolute path: ${request.open}` }
  const path = resolve(request.open)
  // Checked here, not left to the registry: a known project whose folder is gone would come back
  // as `missing` and a new record is never made for a non-folder, but the text should say why.
  if (!(await (deps.isDirectory ?? isDirectoryNow)(path))) return { error: `not a folder: ${path}` }
  try {
    return { id: deps.openPath(path).id }
  } catch (err) {
    return { error: deviceFacingError(err, deps, 'opening the project') }
  }
}
