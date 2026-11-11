// A Sessions panel file click (friction round 1, Task 12): hand it to the plugin the project uses to
// open files (`contributes.openFile` + `ctx.files.onOpen`), or open core's own viewer (open-diff.ts).
//
// Main is the authority for everything the plugin gets:
//   - the tab must belong to the asking window's project and the file must be one main recorded for
//     it (the same checks openDiff makes; a refusal is false, and nothing is shown or sent),
//   - which plugin: the project's pick over the plugins its host runs (selectOpenFile, the shared
//     rule the Plugins page uses too), never anything the renderer or a plugin names,
//   - the path is made relative to the project folder here, and a file outside the project is never
//     sent: the built-in viewer shows it, as before this hook existed,
//   - the tab id is the one just checked against the window; a plugin cannot supply one. The tab,
//     its file and the project's window are checked again right before the delivery, since choosing
//     the plugin awaits the host: a tab closed meanwhile is never handed to a plugin.
// The built-in viewer also opens when the plugin does not take the click within the bound (not
// active, no listener, its listener failed, the host is slow or gone: HostManager.openFile), so a
// click always shows something.
//
// A plugin opens a project file the same way (`ctx.files.open`, routeProjectFile below; the file tree
// plugin's row click): the same pick, the same delivery and the same fallback, so the person's
// "Plugin used to open files" choice holds wherever the open starts. There main checks the path the
// plugin named (resolveProjectFile: relative, no `..`, a regular file inside the project by its real
// path) and the tab id it may pass (one of the host's own project, else dropped): the project is the
// asking host's scope, never a value in the request.
import { realpathSync } from 'node:fs'
import { realpath as realpathAsync } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { errorText } from '../../shared/error-text'
import { resolveInside } from '../plugins/validate'
import type { DiffTab } from './open-diff'
import { warnLog } from '../warn-log'
import type { ViewId } from '../../shared/views'

/** ctx.files.open's path, at most this long: far above any real project path (PATH_MAX is 4096). */
export const MAX_OPEN_PATH_LENGTH = 4096

export interface OpenFileRouteDeps {
  tab(tabId: string): DiffTab | undefined
  /** The project's folder (a real path, as the registry keeps it). */
  projectPath(projectId: string): string | undefined
  /** The id of the window open for the project (WindowManager.windowIdOf), if any. */
  windowOf(projectId: string): number | undefined
  /** The plugin chosen to open files in the project, or null for the built-in viewer. */
  handler(projectId: string): Promise<string | null>
  /**
   * Ask the plugin's host to take the open; true only when it did, within the ack bound. `tabId` is
   * absent for a ctx.files.open without a (valid) tab. `view`: the remote view the open started in
   * (the calling plugin's origin view, HostApi originOf), so the taker's listeners act there.
   */
  deliver(projectId: string, pluginId: string, req: { path: string; tabId?: string; view?: ViewId }): Promise<boolean>
  /** Core's viewer (openDiff); it re-checks the tab and the file itself. */
  builtin(caller: { windowId: number; projectId: string }, tabId: string, file: string): Promise<boolean>
  /**
   * Core's viewer for a checked project-relative file with no tab behind it (openProjectFileDiff:
   * a diff when git has one, else the pager, with the project folder as cwd).
   */
  builtinFile(caller: { windowId: number; projectId: string }, projectDir: string, path: string): Promise<boolean>
  /**
   * Clicks being handed to a plugin right now, by window, tab and file. A double click must not
   * call the plugin twice while the first ack is pending (openDiff's `shown` does this for the
   * viewer). Owned by the caller so it outlives one call.
   */
  delivering: Set<string>
  /** Resolve symlinks (default: fs.realpathSync.native); injected for tests. */
  realpath?: (path: string) => string
  log?: (message: string) => void
}

/**
 * `file` (as recorded for a tab whose cwd is `cwd`) relative to `projectDir`, with `/` separators,
 * or null when it is not inside the project. Both views must agree where they can:
 *  - the real path decides: a lexically internal path through a symlink that leaves the project
 *    (`link/secret.txt`, `link` -> `/etc`) is outside, and the plugin must never get it;
 *  - a lexically outside path whose real path is inside is accepted, since a tool may report a path
 *    through a symlinked prefix (`/tmp` and `/var` are links to `/private/...` on macOS) while the
 *    registry keeps the project's real path.
 * A file that no longer exists (deleted, or a whole deleted folder) is resolved through its nearest
 * existing ancestor; the rest cannot hold a link. When nothing resolves, the answer is null.
 * The lexical path is what is returned when it is inside (what the user saw), else the real one.
 */
export function projectRelativePath(
  projectDir: string,
  cwd: string,
  file: string,
  realpath: (path: string) => string = realpathSync.native
): string | null {
  const abs = resolve(cwd, file)
  const inside = (p: string): string | null => {
    const rel = relative(projectDir, p)
    // '' is the project folder itself, not a file in it.
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return rel.split(sep).join('/')
  }
  const real = realOf(abs, realpath)
  const realRel = real === null ? null : inside(real)
  if (realRel === null) return null
  return inside(abs) ?? realRel
}

/** The real path of `abs`, through its nearest existing ancestor when it does not exist; null when none resolves. */
function realOf(abs: string, realpath: (path: string) => string): string | null {
  let head = abs
  const rest: string[] = []
  for (;;) {
    try {
      // `rest` holds the missing names innermost first.
      return rest.length === 0 ? realpath(head) : join(realpath(head), ...[...rest].reverse())
    } catch {
      const up = dirname(head)
      if (up === head) return null
      rest.push(basename(head))
      head = up
    }
  }
}

/**
 * Route one click. True when the plugin took it or the built-in viewer opened (or is already open);
 * false for the refusals openDiff makes (unknown tab, a tab of another project, a file main never
 * recorded for it). `view`: the remote view the click came from (main checked it), handed on to the
 * plugin that takes it; the built-in viewer is a terminal overlay, shared by every view.
 */
export async function routeOpenFile(
  deps: OpenFileRouteDeps,
  caller: { windowId: number; projectId: string },
  tabId: string,
  file: string,
  view?: ViewId
): Promise<boolean> {
  // The tab must be the caller's project's, record the file, and the caller must still be that
  // project's window. Asked again after every await that comes before a delivery.
  const owned = (): DiffTab | undefined => {
    const t = deps.tab(tabId)
    if (!t || t.projectId !== caller.projectId || !t.files.includes(file)) return undefined
    return deps.windowOf(caller.projectId) === caller.windowId ? t : undefined
  }
  const tab = owned()
  if (!tab) return false
  const log = deps.log ?? warnLog
  let pluginId: string | null = null
  try {
    pluginId = await deps.handler(caller.projectId)
  } catch (err) {
    log(`sessions panel: choosing the plugin that opens files failed: ${errorText(err)}`)
  }
  if (pluginId === null) return deps.builtin(caller, tabId, file)
  // Choosing the plugin awaited the host: the tab may have closed (or the window gone) meanwhile, and
  // a plugin must never get a stale tab id. openDiff checks again for itself.
  if (!owned()) return false
  const projectDir = deps.projectPath(caller.projectId)
  const path = projectDir === undefined ? null : projectRelativePath(projectDir, tab.cwd, file, deps.realpath)
  if (path === null) return deps.builtin(caller, tabId, file)
  // A tab id never holds NUL (main makes them), so the key is unambiguous.
  const key = `${caller.windowId}\0${tabId}\0${file}`
  if (deps.delivering.has(key)) return true
  deps.delivering.add(key)
  let taken = false
  try {
    taken = await deps.deliver(caller.projectId, pluginId, { path, tabId, ...(view !== undefined ? { view } : {}) })
  } catch (err) {
    log(`sessions panel: handing a file to ${pluginId} failed: ${errorText(err)}`)
  } finally {
    deps.delivering.delete(key)
  }
  return taken ? true : deps.builtin(caller, tabId, file)
}

/**
 * The lexical half of a plugin's project path (ctx.files.open, reveal, openWithSystem, trash): the
 * path normalized (`./` and empty segments dropped, `/` separators), '' when it names the project
 * folder itself (`.`, `./`), or a throw whose message the plugin sees. Refused: a non-string or
 * empty path, one over MAX_OPEN_PATH_LENGTH, NUL, an absolute path (POSIX or a Windows drive) and
 * any `..` segment (even one that would stay inside: one rule, no lexical resolving to get wrong).
 * The real-path half (symlinks) is each caller's: this only says what was named.
 */
export function checkRelativePath(path: unknown): string {
  if (typeof path !== 'string' || path === '') throw new Error('path must be a non-empty string')
  if (path.length > MAX_OPEN_PATH_LENGTH) throw new Error(`path is longer than ${MAX_OPEN_PATH_LENGTH} characters`)
  if (path.includes('\0')) throw new Error('path contains a NUL byte')
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new Error('path must be relative to the project folder')
  const segments = path.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.includes('..')) throw new Error('path must not contain ".." segments')
  return segments.join('/')
}

/**
 * ctx.files.open's `path`, checked against the project folder: the path to hand on (normalized:
 * `./` and empty segments dropped, `/` separators), or a throw whose message the plugin sees.
 * Refused: a non-string or empty path, NUL, an absolute path (POSIX or a Windows drive), any `..`
 * segment (even one that would stay inside: one rule, no lexical resolving to get wrong), a path
 * naming the folder itself, and then by the real path (resolveInside, symlinks resolved): one
 * outside the project (`link/x`, `link` -> `/etc`), a missing one, one that is not a regular file
 * (a directory, a FIFO a pager would block on). A backslash is an ordinary file-name character on
 * the platforms the app runs on, so it is allowed; the real-path check is the guard either way.
 * The lexical path is returned, not the real one: what the plugin named (and the tree showed), and
 * known to land inside.
 */
export async function resolveProjectFile(projectDir: string, path: unknown): Promise<string> {
  const rel = checkRelativePath(path)
  if (rel === '') throw new Error('path names the project folder, not a file')
  let root: string
  try {
    // The registry keeps the real path already; resolved again so a containment check against a
    // symlinked spelling can never pass a file it should refuse (resolveInside wants a real root).
    root = await realpathAsync(projectDir)
  } catch {
    throw new Error('the project folder cannot be read')
  }
  const target = await resolveInside(root, rel)
  if (target.ok) return rel
  switch (target.problem) {
    case 'missing':
      throw new Error(`no such file: ${rel}`)
    case 'outside':
      throw new Error(`${rel} resolves outside the project folder`)
    case 'root':
    case 'not-file':
      throw new Error(`${rel} is not a regular file`)
  }
}

/**
 * ctx.files.open from a plugin of the project's host (HostApi `files.open`): `caller` is the
 * host's own scope. Resolves with where the file went; rejects for a refused path (resolveProjectFile)
 * or a project whose window is no longer the caller's. `tabId` is passed on only when it names a tab
 * of the caller's project, checked right before the delivery; anything else is dropped without an
 * error (a tab that closed meanwhile is ordinary, and a foreign id learns nothing either way).
 * The picked plugin may be the caller itself: its own onOpen listener then gets the file, as for a click.
 * `view` as for routeOpenFile: the remote view the caller acted for, handed on to the taker.
 */
export async function routeProjectFile(
  deps: OpenFileRouteDeps,
  caller: { windowId: number; projectId: string },
  path: unknown,
  tabId?: string,
  view?: ViewId
): Promise<'plugin' | 'builtin'> {
  const windowStill = (): void => {
    if (deps.windowOf(caller.projectId) !== caller.windowId) throw new Error('the project window is gone')
  }
  windowStill()
  const projectDir = deps.projectPath(caller.projectId)
  if (projectDir === undefined) throw new Error('the project is gone')
  const rel = await resolveProjectFile(projectDir, path)
  const log = deps.log ?? warnLog
  let pluginId: string | null = null
  try {
    pluginId = await deps.handler(caller.projectId)
  } catch (err) {
    log(`files.open: choosing the plugin that opens files failed: ${errorText(err)}`)
  }
  // Both awaits above may have outlived the window (the host is revoked then too, but its call is
  // already past that check).
  windowStill()
  if (pluginId !== null) {
    const tab = tabId !== undefined && deps.tab(tabId)?.projectId === caller.projectId ? tabId : undefined
    // No tab in the key: the same file handed over twice at once (a double click in a tree) is one
    // delivery whatever tab rides along, and the empty tab field never meets a click's key (main's
    // tab ids are never empty). The second call answers 'plugin' like a second click answers true.
    const key = `${caller.windowId}\0\0${rel}`
    if (deps.delivering.has(key)) return 'plugin'
    deps.delivering.add(key)
    let taken = false
    try {
      taken = await deps.deliver(caller.projectId, pluginId, {
        path: rel,
        ...(tab !== undefined ? { tabId: tab } : {}),
        ...(view !== undefined ? { view } : {})
      })
    } catch (err) {
      log(`files.open: handing a file to ${pluginId} failed: ${errorText(err)}`)
    } finally {
      deps.delivering.delete(key)
    }
    if (taken) return 'plugin'
    windowStill()
  }
  if (!(await deps.builtinFile(caller, projectDir, rel))) throw new Error('the built-in viewer could not open it')
  return 'builtin'
}
