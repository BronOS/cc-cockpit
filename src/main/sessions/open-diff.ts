// "Open the diff for <tab, file>": what a Sessions panel file click asks main for. The renderer
// names only a tab id and a file string; everything that decides what runs comes from main:
//   - the tab must belong to the asking window's project (like every tab-scoped IPC),
//   - the file must be one main itself recorded as changed for that tab (a hook reported it), so
//     a renderer cannot make main show or diff an arbitrary path,
//   - the working directory is the tab's own record, and the argv is built by diff-argv.ts.
// No Electron import: the overlay manager and the git probe come in as options.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { errorText } from '../../shared/error-text'
import { liveChildren } from '../child-registry'
import { MAX_TITLE_LENGTH, type OverlaySpec } from '../overlays/overlay-manager'
import { diffArgv, type LsFiles, type LsFilesResult } from './diff-argv'
import { warnLog } from '../warn-log'

/** The tab fields the check reads (a SessionEntry has them; tests pass plain objects). */
export interface DiffTab {
  projectId: string
  cwd: string
  files: readonly string[]
}

export interface OpenDiffOptions {
  tab(tabId: string): DiffTab | undefined
  lsFiles: LsFiles
  /** Open the overlay; the promise settles when it closes, so this module does not await it. */
  open(windowId: number, spec: OverlaySpec, opener: string): Promise<unknown>
  /**
   * The diffs open right now, by window, tab and file. Owned by the caller so it outlives one
   * call: a double click (a second click while the first probe runs, before the overlay covers
   * the panel) must not stack a second identical overlay with a PTY of its own.
   */
  shown: Set<string>
  log?: (message: string) => void
}

/**
 * Open the diff of `file` for `tabId` in a terminal overlay of `windowId`. True when an overlay
 * was started or that same diff is already open there; false for an unknown tab, a tab of
 * another project, or a file main never recorded for that tab. Resolves once the overlay is
 * asked for, not when the user closes it.
 */
export async function openDiff(
  options: OpenDiffOptions,
  caller: { windowId: number; projectId: string },
  tabId: string,
  file: string
): Promise<boolean> {
  const tab = options.tab(tabId)
  if (!tab || tab.projectId !== caller.projectId || !tab.files.includes(file)) return false
  // A tab id never holds NUL (main makes them), so the key is unambiguous.
  const key = `${caller.windowId}\0${tabId}\0${file}`
  if (options.shown.has(key)) return true
  options.shown.add(key)
  const log = options.log ?? warnLog
  let opened: Promise<unknown>
  try {
    // diffArgv never rejects: a failed probe falls back to less.
    const argv = await diffArgv(file, tab.cwd, options.lsFiles)
    // The title is the file name, but a recorded path may be up to 4096 characters without a
    // slash, and parseOverlaySpec refuses a title over MAX_TITLE_LENGTH: the click would only log
    // and show nothing. Clip it the way the overlay manager clips a title it derives itself.
    const name = basename(file)
    const title = name.length > MAX_TITLE_LENGTH ? `${name.slice(0, MAX_TITLE_LENGTH - 1)}…` : name
    opened = options.open(caller.windowId, { kind: 'terminal', argv, cwd: tab.cwd, title, size: 'large' }, 'sessions-panel')
  } catch (err) {
    // Neither should throw (see above; open reports a refusal by rejecting), but a key left in
    // `shown` would block this diff in this window for good, so release it on any way out.
    options.shown.delete(key)
    throw err
  }
  // Not awaited: it settles at close. A refusal (window gone, bad spec) is only logged.
  opened
    .catch((err: unknown) =>
      log(`sessions panel: opening a diff failed: ${errorText(err)}`)
    )
    .finally(() => options.shown.delete(key))
  return true
}

/**
 * Core's viewer for a project file no tab recorded (`ctx.files.open`, open-file.ts routeProjectFile):
 * openDiff over a synthetic tab `{ projectId, cwd: projectDir, files: [file] }` under the tab id ''.
 * `file` must already be checked (relative to `projectDir`, a regular file inside it by its real
 * path); nothing here checks it again. Main makes every real tab id and none is empty, so the
 * `shown` key (`<window>\0\0<file>`) never meets a click's: a second call for the same file while
 * its viewer is open in that window opens nothing new, a click on the same file from a tab still
 * opens its own.
 */
export function openProjectFileDiff(
  options: OpenDiffOptions,
  caller: { windowId: number; projectId: string },
  projectDir: string,
  file: string
): Promise<boolean> {
  const synthetic: DiffTab = { projectId: caller.projectId, cwd: projectDir, files: [file] }
  return openDiff({ ...options, tab: (id) => (id === '' ? synthetic : undefined) }, caller, '', file)
}

/**
 * Run the probe `git ls-files --error-unmatch` (argv, no shell, short timeout). A numeric exit
 * code is git's answer; a failure to run at all (no git, bad cwd, timeout kill, an argument Node
 * refuses such as one holding NUL) is `spawnFailed`. Never rejects.
 *
 * `env` must be the env the overlay runs with (main passes the login env): an app started from
 * Finder has a minimal PATH, so with main's own env git could be missing for the probe (falling
 * back to `less`) while present in the overlay, and the user got the raw file instead of a diff.
 */
export function execLsFiles(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000
): Promise<LsFilesResult> {
  return new Promise<LsFilesResult>((resolve) => {
    const [command, ...args] = argv
    if (command === undefined) return resolve({ code: null, spawnFailed: true })
    try {
      const child = execFile(command, args, { cwd, env, timeout: timeoutMs, windowsHide: true }, (err) => {
        if (!err) return resolve({ code: 0 })
        // A timeout kill ends with a signal (code null); ENOENT has a string code.
        const code = (err as { code?: unknown }).code
        resolve(typeof code === 'number' ? { code } : { code: null, spawnFailed: true })
      })
      // Tracked for app quit like main's other helpers (execFile's timeout is a timer in main too).
      // Not detached: killChild finds no group for it and kills the child itself.
      liveChildren.track(child)
    } catch {
      // execFile throws synchronously for an argument holding a NUL byte (ERR_INVALID_ARG_VALUE).
      resolve({ code: null, spawnFailed: true })
    }
  })
}
