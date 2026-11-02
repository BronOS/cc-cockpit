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
// click always shows something. Only this click goes through the hook; plugins that open files for
// other reasons call each other through services.
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { errorText } from '../../shared/error-text'
import type { DiffTab } from './open-diff'

export interface OpenFileRouteDeps {
  tab(tabId: string): DiffTab | undefined
  /** The project's folder (a real path, as the registry keeps it). */
  projectPath(projectId: string): string | undefined
  /** The id of the window open for the project (WindowManager.windowIdOf), if any. */
  windowOf(projectId: string): number | undefined
  /** The plugin chosen to open files in the project, or null for the built-in viewer. */
  handler(projectId: string): Promise<string | null>
  /** Ask the plugin's host to take the click; true only when it did, within the ack bound. */
  deliver(projectId: string, pluginId: string, req: { path: string; tabId: string }): Promise<boolean>
  /** Core's viewer (openDiff); it re-checks the tab and the file itself. */
  builtin(caller: { windowId: number; projectId: string }, tabId: string, file: string): Promise<boolean>
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
 * recorded for it).
 */
export async function routeOpenFile(
  deps: OpenFileRouteDeps,
  caller: { windowId: number; projectId: string },
  tabId: string,
  file: string
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
  const log = deps.log ?? ((m) => console.warn(m))
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
    taken = await deps.deliver(caller.projectId, pluginId, { path, tabId })
  } catch (err) {
    log(`sessions panel: handing a file to ${pluginId} failed: ${errorText(err)}`)
  } finally {
    deps.delivering.delete(key)
  }
  return taken ? true : deps.builtin(caller, tabId, file)
}
