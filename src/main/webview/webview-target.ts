// What a `ctx.webview.navigate` target may name (plan B Task 7), apart from the view manager:
// an http(s) URL as is, or a local file whose folder may become a `cc-preview://` root. The target
// is untrusted plugin input, and a preview root exposes its whole folder to the page, so a file is
// refused when its folder is one a page must never read: `/`, the home folder or above it, any
// folder with a dot-folder on its path (~/.ssh, a project's .git), ~/Library, a shared temp folder
// itself, the top folder of a disk.
//
// The folder checks run twice where an alias could slip past one: by spelling (realpath'd strings,
// preview-protocol.ts's previewRootProblem and homeFolderProblem below) and by identity (device and
// inode), since `realpath` does not undo every alias (a macOS firmlink spelled through
// /System/Volumes/Data, a bind mount). The browser plugin's host turns `ccc browser open` text
// into a target (plugins/browser/src/host.ts) without any of these checks: main is the authority.
//
// No Electron import; unit tests use temp folders and fake the device lookup.
import { realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { overlayUrlOf } from '../overlays/overlay-manager'
import { within } from '../path-within'
import { DOT_FOLDER_PROBLEM, isDotName, previewRootProblem } from './preview-protocol'

/** Longest absolute file path a navigate takes (PATH_MAX on macOS is 1024; generous). */
const MAX_FILE_PATH_LENGTH = 4096

/** What a navigate target names: a URL to load as is, or a local file to serve from its folder. */
export type WebviewTarget = { kind: 'url'; url: string } | { kind: 'file'; folder: string; name: string }

/** The shared temp folders: a page shown from one of them could read every other tool's temp files. */
export function defaultTempRoots(): string[] {
  return ['/tmp', '/var/tmp', tmpdir()]
}

/** A path's device id (`stat().dev`); injectable because no test machine reliably has a mount point. */
export type DeviceOf = (path: string) => Promise<bigint>

const statDevice: DeviceOf = async (p) => (await stat(p, { bigint: true })).dev

/** A refusal, worded for the plugin (the host logs it or the CLI prints it). */
function refuse(why: string): Error {
  return new Error(`webview.navigate: ${why}`)
}

/** Same file or folder: device and inode, as bigints (an APFS inode number can exceed 2^53). */
async function fileId(path: string): Promise<string | undefined> {
  try {
    const st = await stat(path, { bigint: true })
    return `${st.dev}:${st.ino}`
  } catch {
    return undefined
  }
}

/** `p`, its parent, ... up to the file-system root. */
function ancestorsOf(p: string): string[] {
  const out = [p]
  for (let cur = p; dirname(cur) !== cur; cur = dirname(cur)) out.push(dirname(cur))
  return out
}

/**
 * The path segments of `folder` below the home folder, or null when it is not under home. By
 * identity as well as by spelling: an ancestor of `folder` that IS the home folder counts whatever
 * it is called.
 */
async function segmentsUnderHome(folder: string, home: string, homeId: string | undefined): Promise<string[] | null> {
  if (within(home, folder)) return relative(home, folder).split(sep).filter((s) => s !== '')
  if (homeId === undefined) return null
  for (const p of ancestorsOf(folder)) {
    if ((await fileId(p)) === homeId) return relative(p, folder).split(sep).filter((s) => s !== '')
  }
  return null
}

const HOME_PROBLEM = 'a file directly in the home folder (or above it) cannot be shown: move the file into a project folder'

/**
 * Why a folder `segs` below the home folder may not be a preview root, or null:
 * - home itself (no segments);
 * - inside a dot-folder (~/.ssh, ~/.aws, ~/.config/...: key files). The folder's own spelling has
 *   that segment too, so previewRootProblem refuses it already; checked again here because these
 *   segments come from the identity walk, which also finds home under an alias spelling;
 * - inside ~/Library (Keychains, Cookies, Mail, Messages, Application Support), except inside a
 *   cloud drive's own folder (~/Library/CloudStorage/<provider>, ~/Library/Mobile Documents/
 *   <container>): Dropbox, Google Drive and iCloud Drive keep a person's documents there.
 */
function homeFolderProblem(segs: readonly string[]): string | null {
  const [first, second] = segs
  if (first === undefined) return HOME_PROBLEM
  if (segs.some(isDotName)) return DOT_FOLDER_PROBLEM
  if (first === 'Library' && !(segs.length >= 3 && (second === 'CloudStorage' || second === 'Mobile Documents'))) {
    return 'files inside ~/Library are not shown (it holds keychains, cookies and mail): move the file into a project folder'
  }
  return null
}

/**
 * `folder` is the top folder of a disk (a mount point: its device differs from its parent's).
 * Exported for the tests, with `deviceOf` faked.
 */
export async function isMountPoint(folder: string, deviceOf: DeviceOf = statDevice): Promise<boolean> {
  try {
    const [here, up] = await Promise.all([deviceOf(folder), deviceOf(dirname(folder))])
    return here !== up
  } catch {
    // The folder went away meanwhile: its requests 404 later.
    return false
  }
}

/** The real path of an absolute `target` that is a regular, non-dot file; refuses anything else. */
async function realFile(target: string): Promise<string> {
  if (target.length > MAX_FILE_PATH_LENGTH || target.includes('\0')) throw refuse('bad file path')
  if (!isAbsolute(target)) {
    // A URL of another scheme parses as a relative path to `isAbsolute`; name it for what it is.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) throw refuse('only http(s) URLs and absolute file paths are shown')
    throw refuse('a file path must be absolute (resolve it against the caller\'s cwd first)')
  }
  let real: string
  try {
    real = await realpath(target)
  } catch {
    throw refuse('no such file')
  }
  const isFile = await stat(real).then(
    (st) => st.isFile(),
    () => false
  )
  if (!isFile) throw refuse('not a regular file')
  if (isDotName(basename(real))) throw refuse('dot-files are not shown')
  return real
}

/** Why `folder` (realpath'd) may not be a preview root, or null; the rules are this file's header. */
async function previewFolderProblem(folder: string, home: string, tempRoots: readonly string[], deviceOf: DeviceOf): Promise<string | null> {
  let realHome: string
  try {
    realHome = await realpath(home)
  } catch {
    // A home that does not resolve (missing, unreadable): the string checks still apply to its
    // spelling; the identity checks find nothing to compare with.
    realHome = home
  }
  const spelled = previewRootProblem(folder, realHome)
  if (spelled !== null) return spelled
  const folderId = await fileId(folder)
  const homeId = await fileId(realHome)
  // The home folder or one of its ancestors under another name.
  if (folderId !== undefined && homeId !== undefined) {
    for (const p of ancestorsOf(realHome)) if ((await fileId(p)) === folderId) return HOME_PROBLEM
  }
  const segs = await segmentsUnderHome(folder, realHome, homeId)
  const underHome = segs === null ? null : homeFolderProblem(segs)
  if (underHome !== null) return underHome
  if (folderId !== undefined) {
    for (const t of tempRoots) {
      if ((await fileId(t)) === folderId) return 'a file directly in a shared temp folder cannot be shown: put it in a folder of its own'
    }
  }
  // /Volumes/<disk> and the like: the page could read the whole disk.
  if (await isMountPoint(folder, deviceOf)) return 'the top folder of a disk cannot be shown: move the file into a project folder'
  return null
}

/**
 * Check a `ctx.webview.navigate` target (untrusted plugin input). An http(s) URL is returned
 * normalized; an absolute path is realpath'd and must be a regular, non-dot file whose folder may
 * be a preview root (previewFolderProblem). Everything else is refused.
 */
export async function resolveWebviewTarget(
  target: unknown,
  home: string,
  tempRoots: readonly string[] = defaultTempRoots(),
  deviceOf: DeviceOf = statDevice
): Promise<WebviewTarget> {
  if (typeof target !== 'string' || target === '') throw refuse('target must be a URL or an absolute file path')
  if (/^https?:/i.test(target)) {
    try {
      return { kind: 'url', url: overlayUrlOf(target) }
    } catch {
      throw refuse('not a valid http(s) URL')
    }
  }
  const real = await realFile(target)
  const folder = dirname(real)
  const problem = await previewFolderProblem(folder, home, tempRoots, deviceOf)
  if (problem !== null) throw refuse(problem)
  return { kind: 'file', folder, name: basename(real) }
}
