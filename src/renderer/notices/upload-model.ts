// The text and state behind the upload dialogs and notices (design-upload.md §4.2, §5.3), DOM-free so
// unit tests run them in plain Node (UploadDialog.tsx, UploadClashDialog.tsx and ShellNotices.tsx draw
// them; the controller of Task 10 drives `uploadUi`).
//
// Every name shown here is a file name the person picked, a folder name from main's listing or a reason
// main wrote; none is trusted as markup (React escapes) and control, bidi and invisible characters are
// dropped for display (`stripUnsafe`), so a reversed extension cannot dress a program as a document.
// Nothing here carries a host path: a folder is project-relative (D-33).

import { downloadSizeText } from '../../shared/downloads'
import { UPLOAD_FOLDER_LIST_MAX, type UploadClash, type UploadError, type UploadFoldersReply } from '../../shared/uploads'
import { stripUnsafe } from './download-dialog-model'

/** Result notices name at most this many files; past it the count says it (design §5.3). */
export const MAX_RESULT_NAMES = 3
/** A clean result notice hides itself after this long; a partial result or a held paste stays. */
export const RESULT_NOTICE_MS = 6_000

/** A folder as the notices say it: project-relative, `''` is the project folder. */
export function folderLabel(folder: string): string {
  return folder === '' ? 'the project folder' : stripUnsafe(folder)
}

// ---------------------------------------------------------------------------------------------------
// The chooser's preset (design §4.2): the folder this device last used for this project.

const PRESET_KEY_PREFIX = 'cc-upload-folder:'

/** The `localStorage` slot of a project's last folder. */
export function presetKey(projectId: string): string {
  return `${PRESET_KEY_PREFIX}${projectId}`
}

/** The slice of `Storage` the preset needs (a fake in tests; undefined where the page has none). */
export interface PresetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The stored folder, or `''` (the project folder) when there is none, the value is not a plain
 * project-relative path, or storage throws (a private window, blocked site data). Whether the folder
 * still exists is `startingFolder`'s question: only main can answer it.
 */
export function readPreset(storage: PresetStorage | undefined, projectId: string): string {
  try {
    const value = storage?.getItem(presetKey(projectId))
    if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.split('/').some((s) => s === '' || s === '.' || s === '..')) return ''
    return value
  } catch {
    return ''
  }
}

/** Written after a successful begin; a storage failure is only a missed convenience. */
export function writePreset(storage: PresetStorage | undefined, projectId: string, folder: string): void {
  try {
    storage?.setItem(presetKey(projectId), folder)
  } catch {
    // Nothing to do: the next upload starts at the project folder.
  }
}

/** `['a', 'a/b']` for `a/b/c`: the folders to open on the way to it. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter((p) => p !== '')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** A folder's child: `''` + `src` is `src`. */
export function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`
}

export type FolderLister = (path: string) => Promise<UploadFoldersReply | UploadError>

/** What the chooser opens with: the folder to select and the listings fetched on the way. */
export interface StartingFolder {
  folder: string
  listings: Map<string, UploadFoldersReply>
}

/**
 * The folder the chooser starts on: the preset when it and every folder above it still list, else the
 * project folder (the stored folder was deleted or renamed, or is now refused: `.git`, the data dir).
 * The project folder's own listing is always fetched (the tree's first level); a failure of it leaves
 * the tree empty and the project folder selected, main answering the begin's refusal if it is no good.
 */
export async function startingFolder(preset: string, list: FolderLister): Promise<StartingFolder> {
  const listings = new Map<string, UploadFoldersReply>()
  const fetch = async (path: string): Promise<boolean> => {
    const reply = await list(path).catch((): UploadError => ({ error: 'failed' }))
    if ('error' in reply) return false
    listings.set(path, reply)
    return true
  }
  await fetch('')
  if (preset === '') return { folder: '', listings }
  for (const path of [...ancestorsOf(preset), preset]) {
    if (!(await fetch(path))) return { folder: '', listings }
  }
  return { folder: preset, listings }
}

/** "3 files" with a size: the chooser's heading, "Upload 2 files (3.1 MB) to". */
export function chooserHeading(files: readonly { name: string; size: number }[]): string {
  const bytes = files.reduce((sum, f) => sum + f.size, 0)
  return `Upload ${files.length} ${files.length === 1 ? 'file' : 'files'} (${downloadSizeText(bytes)}) to`
}

/** The listing's own cap said out loud, so a long folder is not mistaken for a complete one. */
export function moreFoldersText(): string {
  return `Only the first ${UPLOAD_FOLDER_LIST_MAX} folders are shown.`
}

// ---------------------------------------------------------------------------------------------------
// The clash dialog (design §2.3, §5.3).

export interface ClashDialogText {
  title: string
  /** Replace is off: a folder or a link sits at one of the names. */
  replaceOff?: string
}

/** "2 files already exist in src/assets: logo.png, README.md", and why Replace is off, if it is. */
export function clashText(folder: string, clashes: readonly UploadClash[]): ClashDialogText {
  const n = clashes.length
  const names = clashes.map((c) => stripUnsafe(c.name)).join(', ')
  const text: ClashDialogText = {
    title: `${n} ${n === 1 ? 'file already exists' : 'files already exist'} in ${folderLabel(folder)}: ${names}`
  }
  const blocker = clashes.find((c) => !c.replaceable)
  if (blocker !== undefined) text.replaceOff = `Replace is off: ${stripUnsafe(blocker.name)} is a folder or a link`
  return text
}

/** Whether Replace may be offered: every clash is a regular file. A hint, main answers `{error}` anyway. */
export function replaceAllowed(clashes: readonly UploadClash[]): boolean {
  return clashes.every((c) => c.replaceable)
}

// ---------------------------------------------------------------------------------------------------
// Notices (design §5.3).

export interface UploadProgressNotice {
  kind: 'progress'
  id: string
  folder: string
  /** The file being sent (1-based) and how many there are. */
  fileNo: number
  fileCount: number
  sent: number
  total: number
  onCancel(): void
}

/** What a finished upload says; the controller fills it from the run's per-file results. */
export interface UploadOutcome {
  folder: string
  /** Files the upload meant to send (after main's refusals): `done.length + failed.length` unless cancelled. */
  fileCount: number
  done: readonly string[]
  /** Skipped or failed files with the reason (main's refusals at begin, the run's failures). */
  failed: readonly { name: string; reason: string }[]
  cancelled?: boolean
  /** Dropped folders, skipped: no folder uploads. */
  folders?: readonly string[]
}

/** A paste main held: the reason it shows and the text Paste path and Copy use. */
export interface HeldPaste {
  reason: string
  text: string
}

export interface UploadResultNotice {
  kind: 'result'
  id: string
  text: string
  /** A partial result, a held paste or skipped folders stay until dismissed; a clean one hides itself. */
  sticky: boolean
  held?: HeldPaste
  /** The held paste's Paste path button: `uploads.paste { manual: true }`, any number of times. */
  onPaste?: () => void
}

export type UploadNotice = UploadProgressNotice | UploadResultNotice

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "Uploading 2 of 3 to src/assets: 42 MB of 120 MB". */
export function progressText(n: Pick<UploadProgressNotice, 'folder' | 'fileNo' | 'fileCount' | 'sent' | 'total'>): string {
  return `Uploading ${n.fileNo} of ${n.fileCount} to ${folderLabel(n.folder)}: ${downloadSizeText(n.sent)} of ${downloadSizeText(n.total)}`
}

/** The bar's fill, 0 to 1 (an empty upload is full). */
export function progressFraction(n: Pick<UploadProgressNotice, 'sent' | 'total'>): number {
  return n.total <= 0 ? 1 : Math.min(1, Math.max(0, n.sent / n.total))
}

/** "folders can't be uploaded: photos, raw". */
export function foldersText(folders: readonly string[]): string {
  return `folders can't be uploaded: ${folders.map(stripUnsafe).join(', ')}`
}

const failedList = (failed: UploadOutcome['failed']): string => {
  const shown = failed.slice(0, MAX_RESULT_NAMES).map((f) => `${stripUnsafe(f.name)} (${stripUnsafe(f.reason)})`)
  const more = failed.length - shown.length
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

/** A refusal of the whole upload at begin: "Nothing uploaded: <reason>". */
export function nothingUploadedText(reason: string): string {
  return `Nothing uploaded: ${stripUnsafe(reason)}`
}

/**
 * The result notice's text and whether it stays. Clean: "Uploaded a.png, b.png to src" (up to
 * MAX_RESULT_NAMES names, then a count). Partial: "Uploaded 2 of 3 to src; not uploaded: x.bin
 * (the server's disk is full)". Nothing sent: "Nothing uploaded: x.bin (reason)". Skipped folders
 * are added in every case and keep the notice, as a partial result does.
 */
export function resultText(o: UploadOutcome): { text: string; sticky: boolean } {
  const where = folderLabel(o.folder)
  const folders = o.folders !== undefined && o.folders.length > 0 ? foldersText(o.folders) : undefined
  const total = o.fileCount
  let head: string
  let sticky = o.failed.length > 0 || o.cancelled === true || folders !== undefined
  if (o.done.length === 0) {
    sticky = true
    if (o.cancelled === true) head = 'Upload cancelled'
    else if (o.failed.length > 0) head = nothingUploadedText(failedList(o.failed))
    else head = folders !== undefined ? 'Nothing uploaded' : `Uploaded nothing to ${where}`
  } else {
    const names =
      o.done.length <= MAX_RESULT_NAMES && o.failed.length === 0 && o.cancelled !== true
        ? o.done.map(stripUnsafe).join(', ')
        : plural(o.done.length, 'file', 'files')
    if (o.failed.length === 0 && o.cancelled !== true) head = `Uploaded ${names} to ${where}`
    else if (o.cancelled === true) head = `Cancelled after ${o.done.length} of ${total} to ${where}`
    else head = `Uploaded ${o.done.length} of ${total} to ${where}; not uploaded: ${failedList(o.failed)}`
  }
  const text = folders !== undefined ? `${head}${o.done.length === 0 && o.failed.length === 0 && o.cancelled !== true ? ': ' : '; '}${folders}` : head
  return { text, sticky }
}

/** The held paste's buttons (design §4.3): Paste path (the person's own click) and Copy. */
export function heldButtons(n: Pick<UploadResultNotice, 'held'>): { paste: string; copy: string } | undefined {
  return n.held === undefined ? undefined : { paste: 'Paste path', copy: 'Copy' }
}

/** "Not pasted: <reason>", under the result's text. */
export function heldText(held: HeldPaste): string {
  return `Not pasted: ${stripUnsafe(held.reason)}`
}

// ---------------------------------------------------------------------------------------------------
// What the controller shows: one chooser and one clash dialog at a time (oldest first), any number
// of notices.

export interface ChooserRequest {
  id: string
  /** The terminal tab the drop or paste landed on: `uploads.folders` lists through it (a panel's upload names its folder and needs no chooser). */
  tab: string
  files: readonly { name: string; size: number }[]
  preset: string
  /** The chosen project-relative folder, or undefined for Cancel. */
  onAnswer(folder: string | undefined): void
}

export interface ClashRequest {
  id: string
  folder: string
  clashes: readonly UploadClash[]
  onAnswer(choice: 'replace' | 'keep-both' | 'cancel'): void
}

export interface UploadUiState {
  choosers: readonly ChooserRequest[]
  clashes: readonly ClashRequest[]
  notices: readonly UploadNotice[]
}

const EMPTY: UploadUiState = { choosers: [], clashes: [], notices: [] }

/**
 * The upload UI's state, module-level like the downloads' `acceptedOffers`: the controller (outside
 * React) pushes, ShellNotices subscribes. Each change is a new state object so `useSyncExternalStore`
 * sees it; a change that alters nothing keeps the old one.
 */
export class UploadUi {
  private state: UploadUiState = EMPTY
  private readonly listeners = new Set<() => void>()

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  readonly get = (): UploadUiState => this.state

  private set(next: UploadUiState): void {
    this.state = next
    for (const fn of [...this.listeners]) fn()
  }

  showChooser(request: ChooserRequest): void {
    this.set({ ...this.state, choosers: [...this.state.choosers, request] })
  }

  endChooser(id: string): void {
    if (!this.state.choosers.some((c) => c.id === id)) return
    this.set({ ...this.state, choosers: this.state.choosers.filter((c) => c.id !== id) })
  }

  showClash(request: ClashRequest): void {
    this.set({ ...this.state, clashes: [...this.state.clashes, request] })
  }

  endClash(id: string): void {
    if (!this.state.clashes.some((c) => c.id === id)) return
    this.set({ ...this.state, clashes: this.state.clashes.filter((c) => c.id !== id) })
  }

  /** Adds a notice, or replaces the one with its id (a progress notice becomes its result). */
  putNotice(notice: UploadNotice): void {
    const has = this.state.notices.some((n) => n.id === notice.id)
    const notices = has ? this.state.notices.map((n) => (n.id === notice.id ? notice : n)) : [...this.state.notices, notice]
    this.set({ ...this.state, notices })
  }

  dropNotice(id: string): void {
    if (!this.state.notices.some((n) => n.id === id)) return
    this.set({ ...this.state, notices: this.state.notices.filter((n) => n.id !== id) })
  }

  /** Everything gone (the page is leaving or the controller was reset). */
  clear(): void {
    if (this.state !== EMPTY) this.set(EMPTY)
  }
}

/** The one instance of this page. */
export const uploadUi = new UploadUi()
