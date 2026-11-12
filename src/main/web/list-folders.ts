// Server mode's folder browser (design-web.md §9.8): the subfolders of one folder on the server, for
// the browser picker's Open folder and Relink (FOLDERS_PATH, gateway.ts). With no desktop there is no
// native folder dialog, and a typed server path was the only way in; this lists what that path field
// could already reach, so it gives no new access: any folder the server user can read, as a terminal
// tab of a signed-in device can (§9.12). Read-only: nothing is created, opened or changed here.
//
// The body is untrusted: `path` a plain string, absolute, at most MAX_OPEN_PATH, no NUL, and
// normalized by `resolve` (`/a/b/../c` is `/a/c`, a trailing slash goes) before any fs call; `hidden`
// a boolean. No regexes (CLAUDE.md, the gateway's parsing).
//
// Only folders are listed, never files: the picker opens folders, and a file name list is more than
// the picker needs to show. Bounded twice: at most MAX_FOLDER_ENTRIES folders in the answer, and at
// most MAX_SCANNED_ENTRIES directory entries read (a folder of a million files and three subfolders
// must not hold main for long or build a million-entry list); either bound sets `truncated`, and the
// person can still type a path.
//
// Symbolic links: the entry type comes from readdir (lstat's view), so a link is never taken for a
// folder by its name alone. A link is listed when it points at a folder (one `stat`, which follows it)
// and can be entered, as `cd` would; it gets no marks. Marking it would mean resolving where it points
// (a `realpath` per link, plus a `.git` check there), on a target that may be another mount, a slow
// network one included, for a hint; once entered, the folder itself is listed with its own marks
// (`here`). Real folders get `git` from an `lstat` of `<folder>/.git` (a file in a worktree or a
// submodule, a folder in a clone: both count) and `project` from main's own record paths, compared
// against the folder's real path (the listed folder's realpath joined with an entry name that is not
// a link is that entry's real path, so no realpath per entry).
//
// Pure Node, the fs injectable for tests; the gateway re-checks the device before calling it.
import type { Stats } from 'node:fs'
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { errorText } from '../../shared/error-text'
import { MAX_FOLDER_ENTRIES, type WebFolderEntry, type WebFoldersReply, type WebFoldersRequest } from '../../shared/web-protocol'
import { MAX_OPEN_PATH } from './open-project'

/** Directory entries read from one folder at most, folders or not (see the header). */
export const MAX_SCANNED_ENTRIES = 20_000

/** How many `lstat` / `stat` calls run at once for the marks and the links: enough to be quick, few enough not to flood a slow disk. */
const STAT_CONCURRENCY = 32

/** The fs calls the listing makes; tests pass failing ones. */
export interface FolderFs {
  opendir(path: string): Promise<AsyncIterable<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>>
  lstat(path: string): Promise<unknown>
  stat(path: string): Promise<Pick<Stats, 'isDirectory'>>
  realpath(path: string): Promise<string>
}

const nodeFs: FolderFs = {
  // A small buffer: the listing stops early on a huge folder, so reading ahead 32 entries is plenty.
  opendir: (path) => opendir(path, { bufferSize: 64 }),
  lstat: (path) => lstat(path),
  stat: (path) => stat(path),
  realpath: (path) => realpath(path)
}

export interface ListFoldersDeps {
  /** The server user's home folder (its real path): the start when no start folder is set or usable. */
  home(): string
  /** `ccc web set --start-folder` (app.json › webAccess.startFolder), already checked absolute; undefined = home. */
  startFolder(): string | undefined
  /** The real paths of every project record's folder (missing ones included: harmless, they do not exist). */
  projectPaths(): ReadonlySet<string>
  fs?: FolderFs
  /** The server's log: the detail of a failure the device is answered generically for. */
  log?(line: string): void
}

/** The body as a request, or the text of what is wrong with it. Nothing else of the body is used. */
export function parseFoldersBody(body: unknown): WebFoldersRequest | { error: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected { path?, hidden? }' }
  const fields = body as Record<string, unknown>
  const out: WebFoldersRequest = {}
  if (Object.hasOwn(fields, 'hidden')) {
    if (typeof fields.hidden !== 'boolean') return { error: 'hidden is true or false' }
    if (fields.hidden) out.hidden = true
  }
  if (Object.hasOwn(fields, 'path') && fields.path !== '') {
    const path = fields.path
    if (typeof path !== 'string' || path.length > MAX_OPEN_PATH || path.includes('\0')) return { error: 'path needs a folder path' }
    // Relative to what? main's cwd means nothing to the browser (as open-project.ts's open).
    if (!isAbsolute(path)) return { error: `not an absolute path: ${path}` }
    out.path = resolve(path)
  }
  return out
}

/**
 * What a device is told about a folder it cannot list. The common causes in the person's words; any
 * other error code is logged and answered generically (an fs message could carry more than the path
 * the device itself asked for).
 */
function unreadableText(err: unknown, path: string, log: ((line: string) => void) | undefined): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied: the server user cannot read this folder'
  if (code === 'ENOENT') return 'this folder does not exist (any more)'
  if (code === 'ENOTDIR') return 'not a folder'
  if (code === 'ELOOP') return 'too many symbolic links'
  log?.(`web access: listing a folder failed: ${errorText(err)}`)
  // The code alone (EIO, ESTALE): a constant name, never data.
  return typeof code === 'string' && code.length <= 16 ? `cannot read this folder (${code})` : 'cannot read this folder'
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Whether `path` exists as anything (no link followed): a `.git` file or folder. */
async function exists(fs: FolderFs, path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

async function isFolder(fs: FolderFs, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Names sorted as a person reads them: case ignored, `v2` before `v10`. */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Where a listing with no `path` starts: the start folder when it is a folder now, else the home
 * folder, with a note saying why the start folder was passed over.
 */
async function startOf(deps: ListFoldersDeps, fs: FolderFs): Promise<{ path: string; note?: string }> {
  const home = deps.home()
  const start = deps.startFolder()
  if (start === undefined || start === home) return { path: home }
  if (await isFolder(fs, start)) return { path: start }
  return { path: home, note: `The start folder ${start} is not a folder on this server now; showing the home folder.` }
}

/** Lists one folder (see the header); never throws for anything the fs does. */
export async function listFolders(request: WebFoldersRequest, deps: ListFoldersDeps): Promise<WebFoldersReply> {
  const fs = deps.fs ?? nodeFs
  const home = deps.home()
  const start = request.path === undefined ? await startOf(deps, fs) : { path: request.path }
  const path = start.path
  const parent = path === dirname(path) ? null : dirname(path)
  const showHidden = request.hidden === true

  // The entries, by readdir's type (lstat's view: a link is a link here, never a folder).
  const real: string[] = []
  const links: string[] = []
  let hiddenCount = 0
  let truncated = false
  try {
    const dir = await fs.opendir(path)
    let scanned = 0
    // `break` out of `for await` closes the Dir (its return()), so an early stop leaks no handle.
    for await (const entry of dir) {
      if (++scanned > MAX_SCANNED_ENTRIES || real.length + links.length >= MAX_FOLDER_ENTRIES) {
        truncated = true
        break
      }
      const folder = entry.isDirectory()
      const link = !folder && entry.isSymbolicLink()
      if (!folder && !link) continue
      if (!showHidden && entry.name.startsWith('.')) {
        // A dot link may not even point at a folder; counted all the same, the count is a hint.
        hiddenCount++
        continue
      }
      ;(folder ? real : links).push(entry.name)
    }
  } catch (err) {
    return { path, parent, home, error: unreadableText(err, path, deps.log) }
  }

  // Links that point at a folder (stat follows them); a dangling or file link is left out.
  const linkIsFolder = await mapLimit(links, STAT_CONCURRENCY, (name) => isFolder(fs, join(path, name)))
  // The folder's real path, for the project marks; unreadable, nothing is marked a project.
  let realDir: string | undefined
  try {
    realDir = await fs.realpath(path)
  } catch {
    realDir = undefined
  }
  const projects = deps.projectPaths()
  const marked = await mapLimit(real, STAT_CONCURRENCY, async (name): Promise<WebFolderEntry> => {
    const entry: WebFolderEntry = { name }
    if (await exists(fs, join(path, name, '.git'))) entry.git = true
    if (realDir !== undefined && projects.has(join(realDir, name))) entry.project = true
    return entry
  })
  const folders: WebFolderEntry[] = [...marked, ...links.flatMap((name, i): WebFolderEntry[] => (linkIsFolder[i] ? [{ name, link: true }] : []))]
  folders.sort((a, b) => collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const here = {
    git: await exists(fs, join(path, '.git')),
    project: realDir !== undefined && projects.has(realDir)
  }
  return {
    path,
    parent,
    home,
    folders,
    hiddenCount,
    truncated,
    here,
    ...(start.note !== undefined ? { note: start.note } : {})
  }
}
