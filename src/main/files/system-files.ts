// ctx.files.reveal / openWithSystem / trash: a project file or folder handed to the operating system
// (the files tree's right-click menu). Kept apart from Electron: `shell` is reached through the
// SystemShell interface (electron-shell.ts is the real one, a recorder stands in for it in tests and
// e2e) and the confirm dialog through ConfirmTrash (trash-dialog.ts), so every rule here is unit
// tested in plain Node.
//
// Main is the authority (CLAUDE.md). The caller is the asking HOST's scope (HostApi passes its own
// project and window, never a value from the request), and the path is the plugin's, checked here:
//   - lexically (checkRelativePath: relative, no `..`, no NUL, bounded), then
//   - by its real path: the whole path realpath'd must be inside the project folder (a symlink out
//     of it is outside), AND its parent folder realpath'd must be too. The second check matters
//     because what the system acts on is `<real parent>/<name>`, not the real target: a trashed or
//     revealed symlink is the link the person right-clicked, never the file it points to, and a
//     link `in` -> `/elsewhere` whose child links back inside (`in/back` -> `./a`) must not make
//     main trash `/elsewhere/back`, a file outside the project.
//   - the project folder itself is refused for trash and openWithSystem (reveal shows it in its parent).
// openWithSystem also refuses what would RUN instead of open (src/shared/runnable-files.ts, plus
// folders, the exec bit and app bundles), checked on the name the person saw and on the real path.
// trash asks the person in the project's window first (the dialog names the path relative to the
// project) and checks the path again after the answer: the dialog may stay up for minutes, long
// enough for a file to be swapped for a link out of the project.
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { runnableByName } from '../../shared/runnable-files'
import { within } from '../path-within'
import { displayPath, displayText } from '../plugins/link-request'
import { checkRelativePath } from '../sessions/open-file'

/** The three `shell` calls, as Electron types them (Electron 45 `shell`). */
export interface SystemShell {
  /** Show the item selected in the file manager (Finder, Explorer, the desktop's file manager). */
  showItemInFolder(fullPath: string): void
  /** Open with the default app; resolves '' on success, else the system's error text. */
  openPath(fullPath: string): Promise<string>
  /** Move to the Trash / Recycle Bin (recoverable); rejects when the system could not. */
  trashItem(fullPath: string): Promise<void>
}

/** What the trash dialog says; the strings are display-safe (control and bidi characters dropped). */
export interface TrashDialogInfo {
  /** The path relative to the project folder, as the plugin named it. */
  path: string
  kind: 'file' | 'folder'
  /** The asking plugin's id. */
  pluginId: string
}

/** True only when the person chose Move to Trash; a dialog that could not be shown is a no. */
export type ConfirmTrash = (windowId: number, info: TrashDialogInfo, signal?: AbortSignal) => Promise<boolean>

export interface SystemFilesDeps {
  /** The project's folder (the registry's real path). */
  projectPath(projectId: string): string | undefined
  /** The id of the window open for the project (WindowManager.windowIdOf), if any. */
  windowOf(projectId: string): number | undefined
  shell: SystemShell
  confirmTrash: ConfirmTrash
  /** Default process.platform; tests pass each one. */
  platform?: NodeJS.Platform
}

/** Who asks: HostApi's own scope, fixed when main spawned the host. */
export interface SystemFilesCaller {
  windowId: number
  projectId: string
}

/** A plugin path resolved inside the project: what was named, and what the system will be handed. */
export interface ProjectEntry {
  /** The normalized relative path ('' for the project folder). */
  rel: string
  /** `<real parent>/<name>`: the entry itself (a symlink stays a symlink), inside the project. */
  target: string
  /** The whole path realpath'd (symlinks followed), inside the project. */
  real: string
  /** The project folder's real path. */
  root: string
}

/**
 * `path` (a plugin's) resolved inside the project folder, or a throw whose message the plugin sees.
 * See the header for the two real-path checks. `allowRoot`: '' (or a path whose real path is the
 * folder) may name the project folder itself.
 */
export async function resolveProjectEntry(projectDir: string, path: unknown, allowRoot: boolean): Promise<ProjectEntry> {
  // '' is how a plugin names the project folder (reveal's ''), which checkRelativePath calls empty.
  const rel = path === '' && allowRoot ? '' : checkRelativePath(path)
  let root: string
  try {
    root = await realpath(projectDir)
  } catch {
    throw new Error('the project folder cannot be read')
  }
  if (rel === '') {
    if (!allowRoot) throw new Error('path names the project folder')
    return { rel, target: root, real: root, root }
  }
  const named = resolve(root, rel)
  let real: string
  let parent: string
  try {
    real = await realpath(named)
    parent = await realpath(dirname(named))
  } catch {
    // A dangling link fails the first realpath too: it points nowhere the check could clear.
    throw new Error(`no such file or folder: ${rel}`)
  }
  if (!within(root, real) || !within(root, parent)) throw new Error(`${rel} resolves outside the project folder`)
  if (real === root && !allowRoot) throw new Error(`${rel} is the project folder`)
  return { rel, target: join(parent, basename(named)), real, root }
}

/**
 * Why `entry` must not go to the system's default app, or null. By name first (the name the person
 * saw and the real target's, so neither a link `notes.txt` -> `run.sh` nor a link `run.sh` -> a
 * text file slips through), then the file: a folder (reveal it instead), anything but a regular file
 * (a FIFO or a device), and on POSIX any exec bit (a +x file without an extension runs in Terminal
 * on macOS). Windows has no exec bit worth reading (Node derives it), so the name list decides there.
 */
export async function runnableProblem(entry: ProjectEntry, platform: NodeJS.Platform): Promise<string | null> {
  const byName = runnableByName(entry.rel) ?? runnableByName(relative(entry.root, entry.real))
  if (byName) return byName
  const stats = await stat(entry.real)
  if (stats.isDirectory()) return 'it is a folder (use reveal to show it)'
  if (!stats.isFile()) return 'it is not a regular file'
  if (platform !== 'win32' && (stats.mode & 0o111) !== 0) return 'it is executable'
  return null
}

export class SystemFiles {
  private readonly platform: NodeJS.Platform

  constructor(private readonly deps: SystemFilesDeps) {
    this.platform = deps.platform ?? process.platform
  }

  /** The caller's project folder while its window is still the caller's; throws otherwise. */
  private projectDir(caller: SystemFilesCaller): string {
    if (this.deps.windowOf(caller.projectId) !== caller.windowId) throw new Error('the project window is gone')
    const dir = this.deps.projectPath(caller.projectId)
    if (dir === undefined) throw new Error('the project is gone')
    return dir
  }

  /** ctx.files.reveal: the entry selected in the file manager; '' shows the project folder in its parent. */
  async reveal(caller: SystemFilesCaller, path: unknown): Promise<void> {
    const entry = await resolveProjectEntry(this.projectDir(caller), path, true)
    this.deps.shell.showItemInFolder(entry.target)
  }

  /** ctx.files.openWithSystem: a project file with its default app, unless that would run it. */
  async openWithSystem(caller: SystemFilesCaller, path: unknown): Promise<void> {
    const entry = await resolveProjectEntry(this.projectDir(caller), path, false)
    const problem = await runnableProblem(entry, this.platform)
    if (problem) throw new Error(`will not open ${entry.rel}: ${problem}`)
    // The real path, checked just now: openPath follows links anyway, and this way the checked file
    // is the one named to the system.
    const failure = await this.deps.shell.openPath(entry.real)
    if (failure) throw new Error(failure)
  }

  /**
   * ctx.files.trash: ask the person, then move the entry to the Trash. False when they said no (or
   * the dialog could not be shown); throws for a refused path or a failed move. `signal` ends the
   * dialog (the host went away).
   */
  async trash(caller: SystemFilesCaller, path: unknown, pluginId: string, signal?: AbortSignal): Promise<boolean> {
    const first = await resolveProjectEntry(this.projectDir(caller), path, false)
    const before = await lstat(first.target)
    const info: TrashDialogInfo = {
      path: displayPath(first.rel),
      kind: before.isDirectory() ? 'folder' : 'file',
      pluginId: displayPath(pluginId)
    }
    if (!(await this.deps.confirmTrash(caller.windowId, info, signal))) return false
    // The answer may come minutes later: the same window, the same path still inside, and the same
    // entry (not one swapped in under its name meanwhile).
    const again = await resolveProjectEntry(this.projectDir(caller), path, false)
    const after = await lstat(again.target).catch(() => undefined)
    if (again.target !== first.target || !after || after.ino !== before.ino || after.dev !== before.dev) {
      throw new Error(`${first.rel} changed while the confirmation was open; nothing was moved`)
    }
    // A system that cannot move it (no `gio` or no session bus on a stock server, a volume with no
    // Trash) rejects: the plugin gets "not moved" with the system's reason, which it shows in the view
    // that asked, and the file stays where it was. The reason is display-safe like the dialog's text.
    try {
      await this.deps.shell.trashItem(again.target)
    } catch (err) {
      const reason = displayText(err instanceof Error ? err.message : String(err)) || 'the system could not move it'
      throw new Error(`${first.rel} was not moved to the Trash: ${reason}`, { cause: err })
    }
    return true
  }
}
