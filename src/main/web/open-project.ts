// Opening a project from a browser in server mode (design-web.md §9.8): the PROJECTS_PATH POST's
// body check and what main does with it. With no desktop, the browser picker is the only picker, so
// it may open any folder the server user can read: no more than the shell a device already has.
//
// The body is untrusted: exactly one of `open` / `reopen` / `relink` / `forget`, each a plain string
// (`relink` with its `path`), and nothing else of it is used. `open` must be absolute and name an
// existing directory now (nothing is created: `mkdir` in a terminal); `reopen` is looked up in main's
// own recent list (WindowManager.openRecent), never used to address a record directly. Then
// `windows.openPath` runs as the desktop's Open Folder does. `relink` and `forget` are the desktop
// picker's buttons for a project whose folder is gone, run by main's same code (restore.ts
// relinkMissing / forgetMissing: only a recent project, only one whose folder is really missing, so a
// forged id cannot drop a project that is fine); `relink`'s new folder is checked as `open`'s path.
// No regexes (CLAUDE.md, the gateway's parsing). Pure Node, for unit tests.
//
// The device is checked again right before the open, with no `await` between that check and the
// call (`authorized`): the folder check awaits a `stat` (a slow or hung mount can hold it for long),
// and a device revoked meanwhile must open nothing (external review round 3, after round 2 had
// moved the gateway's check behind the body read but left this await after it).
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { errorText } from '../../shared/error-text'
import type { WebOpenProjectReply, WebOpenProjectRequest } from '../../shared/web-protocol'
import { ProjectRefusal } from '../projects/registry'

/**
 * What main answers the gateway: the wire's reply, or `unauthorized` when the device was no longer
 * signed in at the moment of the open (the gateway answers 401, as for a request with no cookie).
 */
export type OpenProjectOutcome = WebOpenProjectReply | { unauthorized: true }

/** Longer than any path the OS takes (PATH_MAX is 4096 on Linux); the body cap bounds it anyway. */
export const MAX_OPEN_PATH = 4096

/** The request kinds, each the body key that names it. */
const KINDS = ['open', 'reopen', 'relink', 'forget'] as const

/** A non-empty plain string within the path cap and with no NUL, or undefined. */
function plainValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && value.length <= MAX_OPEN_PATH && !value.includes('\0') ? value : undefined
}

/** The body as one request, or the text of what is wrong with it. */
export function parseOpenProjectBody(body: unknown): WebOpenProjectRequest | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected { open } or { reopen }' }
  const fields = body as Record<string, unknown>
  const given = KINDS.filter((k) => Object.hasOwn(fields, k))
  const kind = given[0]
  if (given.length !== 1 || kind === undefined) return { error: 'expected exactly one of open, reopen, relink and forget' }
  const value = plainValue(fields[kind])
  if (value === undefined) return { error: kind === 'open' ? 'open needs a folder path' : `${kind} needs a project id` }
  switch (kind) {
    case 'open':
      return { open: value }
    case 'reopen':
      return { reopen: value }
    case 'forget':
      return { forget: value }
    case 'relink': {
      const path = Object.hasOwn(fields, 'path') ? plainValue(fields.path) : undefined
      if (path === undefined) return { error: 'relink needs the new folder path' }
      return { relink: value, path }
    }
  }
}

export interface OpenProjectDeps {
  /** `windows.openPath`: opens the folder (or finds its open window) and returns its record. */
  openPath(path: string): { id: string }
  /** `windows.openRecent`: the id looked up in the registry's recent list; throws when not there. */
  openRecent(id: string): { id: string }
  /**
   * The desktop picker's relink (restore.ts relinkMissing, then `windows.openPath` of the new folder):
   * throws a ProjectRefusal when the id is not a recent project with its folder missing, or the folder
   * is another project's already. Absent (a caller that only opens): refused.
   */
  relink?(id: string, path: string): { id: string }
  /** The desktop picker's forget (restore.ts forgetMissing): the same checks as `relink`. */
  forget?(id: string): void
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

/**
 * Runs a checked request; a refusal or a failed open is its text, never a throw. `authorized` is
 * asked synchronously right before `openPath` / `openRecent` / `relink` / `forget`, after every
 * await: false changes nothing.
 */
export async function openProjectFromWeb(request: WebOpenProjectRequest, deps: OpenProjectDeps, authorized: () => boolean): Promise<OpenProjectOutcome> {
  if ('reopen' in request) {
    if (!authorized()) return { unauthorized: true }
    try {
      return { id: deps.openRecent(request.reopen).id }
    } catch (err) {
      // A missing folder says so (openView's text); an id not in the list says only that.
      return { error: deviceFacingError(err, deps, 'reopening the project') }
    }
  }
  if ('forget' in request) {
    if (!authorized()) return { unauthorized: true }
    try {
      if (!deps.forget) throw new ProjectRefusal('forget is not available here')
      deps.forget(request.forget)
      return { id: request.forget }
    } catch (err) {
      return { error: deviceFacingError(err, deps, 'forgetting the project') }
    }
  }
  const typed = 'open' in request ? request.open : request.path
  const checked = await folderNow(typed, deps)
  if ('error' in checked) return checked
  // After the stat's await, before the change, nothing awaited in between: see the header.
  if (!authorized()) return { unauthorized: true }
  if ('relink' in request) {
    try {
      if (!deps.relink) throw new ProjectRefusal('relink is not available here')
      return { id: deps.relink(request.relink, checked.path).id }
    } catch (err) {
      return { error: deviceFacingError(err, deps, 'relinking the project') }
    }
  }
  try {
    return { id: deps.openPath(checked.path).id }
  } catch (err) {
    return { error: deviceFacingError(err, deps, 'opening the project') }
  }
}

/** A typed folder path as main uses it: absolute, normalized, an existing directory now; else the text why not. */
async function folderNow(typed: string, deps: OpenProjectDeps): Promise<{ path: string } | { error: string }> {
  // Relative to what? main's cwd means nothing to the browser, so only an absolute path is taken.
  if (!isAbsolute(typed)) return { error: `not an absolute path: ${typed}` }
  const path = resolve(typed)
  // Checked here, not left to the registry: a known project whose folder is gone would come back
  // as `missing` and a new record is never made for a non-folder, but the text should say why.
  if (!(await (deps.isDirectory ?? isDirectoryNow)(path))) return { error: `not a folder: ${path}` }
  return { path }
}
