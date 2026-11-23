// Uploads from the person's device (design-upload.md revision 2): the caps, the limits, the payloads
// main and the views exchange, and the rules both sides apply to names, `.git` and the pasted text.
// Shared by main (`main/files/uploads.ts`, the writer, the gateway's `/u/` route) and the web shell
// (the upload client, the dialogs, the notices), so no runtime import here but other shared files:
// the renderer bundles it too.
//
// Main checks every name and folder itself (design §2: a panel page can build a `File` nobody picked,
// §6); the shell uses the same functions only to name a pasted file and to show what main will say.

import { HIDDEN_TEXT } from './session-name'
import { MAX_NAME_NUMBER, numberedName } from './numbered-name'

// ---------------------------------------------------------------------------------------------------
// Caps and timing (design §2.5, §3.3, §3.4).

/** A file's declared size is at most this; bytes past the declared size are refused at the route. */
export const UPLOAD_MAX_FILE_BYTES = 2 * 1024 ** 3
/** Files per upload. */
export const UPLOAD_MAX_FILES = 100
/**
 * The client's slice size moves between these (design §3.3): it doubles after a chunk under
 * UPLOAD_CHUNK_FAST_MS, halves after one over UPLOAD_CHUNK_SLOW_MS or one the gateway's request bound
 * cut (an HTTP 408, plan Task 1: Node cuts somewhere between 30 s and 60 s), so a slow link stays
 * inside the bound and a fast one is not held to tiny requests.
 */
export const UPLOAD_CHUNK_MIN_BYTES = 256 * 1024
export const UPLOAD_CHUNK_START_BYTES = 1024 ** 2
export const UPLOAD_CHUNK_MAX_BYTES = 8 * 1024 ** 2
export const UPLOAD_CHUNK_FAST_MS = 2_500
export const UPLOAD_CHUNK_SLOW_MS = 10_000
/** Begin refuses unless the folder's filesystem keeps this much free beyond the whole upload. */
export const UPLOAD_FREE_MARGIN_BYTES = 1024 ** 3
/** An upload with no body bytes for this long is aborted and its temps deleted. */
export const UPLOAD_IDLE_MS = 60_000
/** Uploads running at once per device (None mode: the device `none`), and app-wide. */
export const UPLOAD_MAX_PER_DEVICE = 2
export const UPLOAD_MAX_APP = 6
/** Begins per device in UPLOAD_BEGINS_WINDOW_MS (a `RateWindow`). */
export const UPLOAD_BEGINS_MAX = 20
export const UPLOAD_BEGINS_WINDOW_MS = 10 * 60_000
/** The folder chooser lists at most this many subfolders of one folder (then `more`). */
export const UPLOAD_FOLDER_LIST_MAX = 500
/** Keep both and the in-upload dedupe number up to `name (99).ext`: the remote window's own limit. */
export const UPLOAD_MAX_NAME_NUMBER = MAX_NAME_NUMBER

/** Where a view's chunk PUTs go: `/u/<token>?offset=<n>`. */
export const UPLOAD_PATH_PREFIX = '/u/'
/** A temp's name in its target folder: hidden, then 16 random hex (the Files tree hides the prefix). */
export const UPLOAD_TEMP_PREFIX = '.cc-upload-'

// ---------------------------------------------------------------------------------------------------
// Payloads (design §3.1).

/** What an upload came from: a panel of the view's layout now (Files), or a Claude or shell tab. */
export type UploadSource = { panel: string } | { tab: string }

/** One file as the page declares it; main checks the name and the size, never trusts them. */
export interface UploadFileSpec {
  name: string
  size: number
  /** A clipboard paste: named by `pastedName` (browsers call every clipboard image `image.png`). */
  pasted?: boolean
}

export interface UploadBeginRequest {
  source: UploadSource
  /** Project-relative, `''` the project folder. */
  folder: string
  files: UploadFileSpec[]
}

/** A file of the upload that is skipped, with the reason the result notice shows. */
export interface UploadRefusedFile {
  index: number
  reason: string
}

/** A name already taken in the folder; Replace is offered only when every clash is `replaceable` (a regular file). */
export interface UploadClash {
  index: number
  name: string
  replaceable: boolean
}

/** A file's token for its chunk PUTs, with the name main will write (after dedupe or Keep both). */
export interface UploadFileToken {
  index: number
  token: string
  name: string
}

export interface UploadBegun {
  uploadId: string
  refused: UploadRefusedFile[]
  clashes: UploadClash[]
  /** Present when nothing clashes; otherwise `uploads.resolve` answers them. */
  tokens?: UploadFileToken[]
}

/** `uploads.begin`'s answer: begun, or the whole upload refused (folder, role, caps, disk, limits). */
export type UploadBeginReply = UploadBegun | { error: string }

export type UploadChoice = 'replace' | 'keep-both' | 'cancel'

export interface UploadResolveRequest {
  uploadId: string
  choice: UploadChoice
}

/** `uploads.resolve`'s answer: the tokens (none for `cancel`). */
export interface UploadResolveReply {
  tokens: UploadFileToken[]
}

export interface UploadCancelRequest {
  uploadId: string
}

/** The terminal entry's paste (design §4.3); `manual` is the held notice's Paste path. */
export interface UploadPasteRequest {
  uploadId: string
  manual?: boolean
}

/** Paste `text` now, or hold it (the reason shown) with the text for the notice's paths and Copy. */
export type UploadPasteReply = { text: string } | { held: string; text: string }

/** The folder chooser's listing, through the terminal tab the drop or paste landed on (design §4.2). */
export interface UploadFoldersRequest {
  tab: string
  /** Project-relative, `''` the project folder. */
  path: string
}

export interface UploadFoldersReply {
  /** Subfolder names only, sorted, at most UPLOAD_FOLDER_LIST_MAX. */
  folders: string[]
  more: boolean
}

/** The `/u/` route's answer to a chunk: `received` so far, or the last chunk's committed file. */
export type UploadChunkReply = { received: number } | { done: true; name: string; path: string }

// ---------------------------------------------------------------------------------------------------
// Names (design §2.2).

/** A name is at most this many bytes of UTF-8 (Files' `checkName`, and most filesystems' limit). */
export const UPLOAD_NAME_MAX_BYTES = 255

// A lone surrogate is not text: a filesystem may refuse it and `encodeURIComponent` throws on it.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

const fitsNameLimit = (name: string): boolean => new TextEncoder().encode(name).length <= UPLOAD_NAME_MAX_BYTES

export type UploadNameCheck = { ok: true } | { ok: false; reason: string }

/**
 * Files' `checkName` rules (`plugins/files/dist/lib/ops.js`: one segment, not empty, not `.` or `..`,
 * no `/`, no NUL, at most 255 bytes) plus `\` on every platform, no lone surrogates and nothing
 * HIDDEN_TEXT holds (control, bidi and invisible format characters): the name lands in a terminal paste,
 * where Claude reads it, and in notices, where the person reads it. A U+202E would show it reversed,
 * an ESC would reach the program, and the tag characters U+E0000-E007F would spell out text Claude reads
 * and the person never sees (a panel page can build a `File` with any name, design §6). The cost: a
 * subdivision flag emoji (its tag characters) or a soft hyphen in a name is refused too. Never a changed
 * name: main skips a refused file with its reason rather than renaming it quietly. Dot names (`.env`) are
 * fine, and so are U+202F (macOS's screenshot names) and ZWJ emoji: HIDDEN_TEXT holds neither.
 */
export function checkUploadName(name: unknown): UploadNameCheck {
  if (typeof name !== 'string' || name.trim() === '') return { ok: false, reason: 'the name is empty' }
  if (name === '.' || name === '..') return { ok: false, reason: `"${name}" cannot be a name` }
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: 'a name cannot contain "/" or "\\"' }
  if (name.includes('\0')) return { ok: false, reason: 'a name cannot contain a NUL character' }
  if (LONE_SURROGATE.test(name)) return { ok: false, reason: 'the name is not valid text' }
  if (HIDDEN_TEXT.test(name)) return { ok: false, reason: 'a name cannot contain control, bidi or invisible characters' }
  if (!fitsNameLimit(name)) return { ok: false, reason: `a name is at most ${UPLOAD_NAME_MAX_BYTES} bytes` }
  return { ok: true }
}

/**
 * `numberedName` within the name limit: `null` when ` (n)` would take a name that passed
 * `checkUploadName` at 251-255 bytes past UPLOAD_NAME_MAX_BYTES (the write would fail later with a raw
 * ENAMETOOLONG instead of a refusal with a reason, §2.2), or when n is past UPLOAD_MAX_NAME_NUMBER. The
 * in-upload dedupe and Keep both both number through it.
 */
export function numberedUploadName(name: string, n: number): string | null {
  if (n > UPLOAD_MAX_NAME_NUMBER) return null
  const candidate = numberedName(name, n)
  return fitsNameLimit(candidate) ? candidate : null
}

const PASTED_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * A pasted file's name, `pasted-YYYYMMDD-HHMMSS.<ext>`, from `date` in its own local time (the
 * device's clock, as a screenshot's name is) and the `File`'s MIME type (parameters and case ignored;
 * anything but the five known types is `bin`, so a type never makes the name).
 */
export function pastedName(type: string, date: Date): string {
  const mime = (type.split(';')[0] ?? '').trim().toLowerCase()
  const ext = PASTED_EXTENSIONS[mime] ?? 'bin'
  const day = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
  const time = `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  return `pasted-${day}-${time}.${ext}`
}

/**
 * The key two names of one upload clash under: case folded (a case-insensitive macOS server takes
 * `Readme.md` and `README.md` as one entry) and NFC (APFS also ignores normalization, so a decomposed
 * `é` from one browser and a composed one from another are one name there too).
 */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * The names of one upload with the repeats numbered (` (1)` and up, the Keep both pattern) without
 * asking: the first keeps its name, a later one takes the first number no earlier name of the
 * upload holds. `null` when every number up to UPLOAD_MAX_NAME_NUMBER is taken, or when numbering
 * would take the name past UPLOAD_NAME_MAX_BYTES (a longer number only makes it longer): main refuses
 * that file. Clashes with the folder are not decided here: that is begin's `lstat` and the dialog.
 */
export function dedupeNames(names: readonly string[]): (string | null)[] {
  const taken = new Set<string>()
  return names.map((name) => {
    for (let n = 0; n <= UPLOAD_MAX_NAME_NUMBER; n++) {
      const candidate = numberedUploadName(name, n)
      if (candidate === null) return null
      const key = nameKey(candidate)
      if (!taken.has(key)) {
        taken.add(key)
        return candidate
      }
    }
    return null
  })
}

// ---------------------------------------------------------------------------------------------------
// The `.git` rule (design §2.1).

/**
 * Whether a project-relative folder is `.git` or anything below it: a file in `.git/hooks` or
 * `.git/config` runs code on the next git command. Checked on the named path and on its real path
 * (a `hooks-link` to `.git/hooks` is refused by its target), and case-insensitively on darwin, where
 * APFS takes `.GIT/hooks` as the same folder. `.github` and `.gitignore` are other names.
 */
export function insideGit(relative: string, real: string, darwin: boolean): boolean {
  const isGit = (segment: string): boolean => (darwin ? segment.toLowerCase() : segment) === '.git'
  return [relative, real].some((path) => path.split('/').some(isGit))
}

// ---------------------------------------------------------------------------------------------------
// The paste (design §4.3).

// What Terminal.app and iTerm escape in a dropped file's path: ASCII space and the ASCII characters a
// shell gives meaning to. Nothing else, non-ASCII included (U+202F in a macOS screenshot name, a
// Cyrillic name): an escape inside it could defeat Claude Code's image detection, and the name stays
// readable. They escape a tab too, but a tab is a control character, so a path with one never gets
// here (outside bracketed-paste mode a shell would take it as completion, escaped or not).
const PASTE_ESCAPED = new Set([' ', ...'\\\'"`$&*()[]{};|<>?!#~'])

/**
 * The paths as one paste: each escaped, separated by a space, one trailing space ('' for none).
 * `null` when a path holds a lone surrogate or anything HIDDEN_TEXT holds: `checkUploadName` covers
 * only the file name, and the path is the whole of it, the project root and every folder segment
 * (a cloned repo's folder can be named anything). xterm's `paste` only normalises newlines and wraps
 * the text in `ESC [200~ ... ESC [201~`, so an `ESC [201~` in a folder would end the bracketed paste
 * early and a later CR would submit a line; a U+202E would show the path reversed. The caller holds
 * the paste then: nothing in such a path is escaped into safety.
 */
export function pasteText(paths: readonly string[]): string | null {
  if (paths.length === 0) return ''
  if (paths.some((path) => LONE_SURROGATE.test(path) || HIDDEN_TEXT.test(path))) return null
  const escape = (path: string): string => [...path].map((ch) => (PASTE_ESCAPED.has(ch) ? `\\${ch}` : ch)).join('')
  return `${paths.map(escape).join(' ')} `
}
