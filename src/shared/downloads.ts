// Downloads to the person's device (design-download.md revision 3): the caps, the limits, the payloads
// main and the views exchange, and the three name rules. Shared by main (the gateway's `/d/` route,
// `main/files/downloads.ts`, the remote window's save) and the web client (the dialog, the notices), so
// no runtime import here: the renderer bundles it too.
//
// The name rules exist because a name travels to systems that read it differently from the server's
// filesystem: a browser's download list and save dialog (display), an HTTP header (latin1 only, where
// Node's `writeHead` throws on anything else, and a CR/LF would end the header), and the desktop's own
// Downloads folder, where the remote window saves what an untrusted page named (design §3.3).

import { CONTROL } from './session-name'

// ---------------------------------------------------------------------------------------------------
// Caps and timing.

/** A folder's zip holds at most this many bytes of file data (before compression): far inside zip32's 4 GiB offsets. */
export const DOWNLOAD_ZIP_MAX_BYTES = 2 * 1024 ** 3
/** And at most this many entries, files and folders: far inside zip32's 65,535. */
export const DOWNLOAD_ZIP_MAX_ENTRIES = 20_000
/** The folder walk goes at most this deep below the zip's root (a deeper entry is skipped, never followed). */
export const DOWNLOAD_WALK_MAX_DEPTH = 64
/**
 * The counting walk before a view gets anything is cut after this long ("too many files to count"):
 * a slow disk or a network mount must not keep a `ccc download` or a menu click waiting forever.
 */
export const DOWNLOAD_WALK_MS = 10_000
/** A download token lives this long after it is minted; it is consumed when the 200 headers go out. */
export const DOWNLOAD_TOKEN_MS = 60_000
/** A `ccc download` offer waits this long for an answer (held while no browser shows the project, server mode). */
export const DOWNLOAD_OFFER_MS = 10 * 60_000
/**
 * The remote window saves only within this long of a pointer click in it: Chromium's transient
 * activation span, so the shell's own check (§2.1) and the desktop's agree.
 */
export const DOWNLOAD_CLICK_MS = 5_000
/** The desktop's remote window cancels and deletes a download past this many bytes (declared or received). */
export const DESKTOP_DOWNLOAD_MAX_BYTES = 4 * 1024 ** 3

// ---------------------------------------------------------------------------------------------------
// Limits (design §5 / the plan's "Limits").

/** `ctx.files.download`: at most this many starts per plugin in DOWNLOAD_PLUGIN_WINDOW_MS. */
export const DOWNLOAD_PLUGIN_MAX = 10
export const DOWNLOAD_PLUGIN_WINDOW_MS = 60_000
/** `ccc download`: at most this many offers waiting at once per window. */
export const DOWNLOAD_OFFERS_WAITING_MAX = 3
/** And at most this many offers per window in DOWNLOAD_OFFERS_WINDOW_MS (a window token has no tab id to key on). */
export const DOWNLOAD_OFFERS_MAX = 10
export const DOWNLOAD_OFFERS_WINDOW_MS = 10 * 60_000
/** Live `/d/` responses at once per signed-in device. */
export const DOWNLOAD_STREAMS_PER_DEVICE = 2
/** Zips being written at once, app-wide (each holds a deflate stream and a walk). */
export const DOWNLOAD_ZIPS_MAX = 3
/** The remote window: one active download per server, and at most DESKTOP_DOWNLOAD_BURST per DESKTOP_DOWNLOAD_BURST_MS. */
export const DESKTOP_DOWNLOAD_ACTIVE_MAX = 1
export const DESKTOP_DOWNLOAD_BURST = 3
export const DESKTOP_DOWNLOAD_BURST_MS = 10_000

// ---------------------------------------------------------------------------------------------------
// Payloads.

export type DownloadKind = 'file' | 'folder'

/** Why a walk left an entry out of a zip; the dialog shows the counts by reason (design §1.4). */
export type DownloadSkipReason =
  /** A symbolic link (never followed: cycles and duplicates). */
  | 'symlink'
  /** Neither a regular file nor a folder (FIFO, socket, device). */
  | 'special'
  /** A `.git` or `node_modules` folder below the root, without the include choice. */
  | 'excluded'
  /** Refused by the outside rule (an outside root's entries). */
  | 'refused'
  /** The app's data dir. */
  | 'dataDir'
  /** Could not be read (permissions, gone meanwhile). */
  | 'unreadable'
  /** A name a receiving system would misread (`\`, control or bidi characters, invalid UTF-8). */
  | 'name'
  /** More than DOWNLOAD_WALK_MAX_DEPTH folders below the root (the walk is bounded, never a stack to exhaust). */
  | 'deep'

export type DownloadSkipped = Partial<Record<DownloadSkipReason, number>>

/** What a folder's zip would hold: entries (files and folders) and file bytes before compression. */
export interface DownloadTotals {
  files: number
  folders: number
  bytes: number
}

/** Where a view's download links point (`/d/<token>`): the gateway's route, the shell's check of a `downloads.start`. */
export const DOWNLOAD_PATH_PREFIX = '/d/'

/**
 * A `downloads.start` url as main mints it: the route and a token of 32 random bytes base64url (43
 * characters, no padding), nothing else. The shell clicks or shows only such a url, so a malformed
 * event can never point the `<a download>` anywhere else (another origin, a `javascript:` URL).
 */
export function isDownloadUrl(url: unknown): url is string {
  return typeof url === 'string' && /^\/d\/[A-Za-z0-9_-]{43}$/.test(url)
}

/** main → the one view that gets it: click this same-origin link now (`<a href={url} download={name}>`). */
export interface DownloadStart {
  requestId: string
  /** `/d/<token>`, relative to the view's own origin. */
  url: string
  /** `downloadName` of what is sent. */
  name: string
}

/** main → every browser view of the window (`ccc download`): the dialog's content. */
export type DownloadOffer = {
  requestId: string
  /** The full path as named (project-relative paths already made absolute). */
  path: string
  /** The real path, when the named one is a link to elsewhere. */
  real?: string
  /** `downloadName` of what is sent (a folder's `<name>.zip`): what `runnable` was decided on. */
  name: string
  /** Outside the project (shown in the warning colour). */
  outside: boolean
  /** `runnableByName` matches the name that will be sent ("this file can run programs when opened"). */
  runnable: boolean
} & (
  | { kind: 'file'; size: number }
  | {
      kind: 'folder'
      /** Without and with `.git` / `node_modules`: the dialog shows both sizes beside its checkbox. */
      counts: { plain: DownloadTotals; all: DownloadTotals }
      /**
       * With `.git` / `node_modules` the zip would pass a cap: the counting stopped there, so
       * `counts.all` is a lower bound and an accept with the include choice is refused.
       */
      allTooLarge?: true
      /** What the plain zip leaves out, by reason. */
      skipped: DownloadSkipped
    }
)

/** main → the view a start or a GET failed for (an in-page notice: the browser's own list says only "Failed"). */
export interface DownloadFailed {
  requestId: string
  reason: string
}

/** main → every browser view: the offer was answered or expired; take its dialog down. */
export interface DownloadSettled {
  requestId: string
}

/** A view → main on its own socket: Download in the dialog, with the include choice (the view is the connection's). */
export interface DownloadAccept {
  requestId: string
  all: boolean
}

/** A view → main: Cancel in the dialog (settles the offer for every view). */
export interface DownloadAnswer {
  requestId: string
}

/**
 * A size as the person reads it, in decimal units as browsers' download lists show them: `512 B`,
 * `2.3 MB`, `48 MB` (one decimal below 10, none from there). Shared by main's refusal texts, the CLI's
 * answer and the dialog.
 */
export function downloadSizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${Math.max(0, Math.round(Number.isFinite(bytes) ? bytes : 0))} B`
  const units = ['kB', 'MB', 'GB', 'TB']
  let v = bytes / 1000
  let i = 0
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v < 9.95 ? v.toFixed(1) : Math.round(v).toString()} ${units[i]}`
}

// ---------------------------------------------------------------------------------------------------
// Names.

/** A name is cut past this many UTF-8 bytes (most filesystems allow 255; room for " (99)" and a temp prefix). */
export const DOWNLOAD_NAME_MAX_BYTES = 200
/**
 * An extension longer than this (UTF-8 bytes, dot included) is not one worth keeping over the stem:
 * cutting the stem to keep it would leave almost nothing of the name.
 */
const MAX_KEPT_EXTENSION_BYTES = 32
/** What a name becomes when nothing is left of it. */
export const DOWNLOAD_FALLBACK_NAME = 'download'

// session-name.ts's CONTROL, every match: C0/C1 controls and DEL, line and paragraph separators, bidi
// marks, embeddings, overrides and isolates, invisible format characters. A U+202E in a file name shows
// the rest reversed (`report<U+202E>fdp.exe` reads as `reportexe.pdf`); a CR or LF would end a header.
const CONTROL_ALL = new RegExp(CONTROL.source, 'g')
// A lone surrogate (a name from a page, or a Windows file name) is not text: encodeURIComponent throws
// on it and a filesystem may refuse it. Made U+FFFD, as TextEncoder would.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
}

function utf8Bytes(s: string): number {
  let n = 0
  for (const ch of s) n += utf8Length(ch)
  return n
}

/** `s` cut to at most `max` UTF-8 bytes on a code point (a surrogate pair is never split). */
function cutBytes(s: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    const len = utf8Length(ch)
    if (n + len > max) break
    out += ch
    n += len
  }
  return out
}

/**
 * `name` cut to DOWNLOAD_NAME_MAX_BYTES keeping its last extension: `a.exe<pad>.txt` must end `.txt`,
 * never `.exe` (a cut that kept the front would hand the person a program under a document's name).
 * When the last extension is too long to keep (or the name has none past a leading dot), the cut part
 * has its dots made `_`, so the cut cannot expose an earlier extension either (`x.<pad>.exe<long>`).
 */
function cutName(name: string): string {
  if (utf8Bytes(name) <= DOWNLOAD_NAME_MAX_BYTES) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  if (ext && utf8Bytes(ext) <= MAX_KEPT_EXTENSION_BYTES) {
    return cutBytes(name.slice(0, dot), DOWNLOAD_NAME_MAX_BYTES - utf8Bytes(ext)) + ext
  }
  // trimEnd: the cleaned name was trimmed, so a cut ending in a space would not be idempotent.
  const cut = cutBytes(name, DOWNLOAD_NAME_MAX_BYTES).trimEnd()
  // Keep a leading dot as it was (a dot file stays one); every later dot could start an extension.
  return cut.startsWith('.') ? `.${cut.slice(1).replaceAll('.', '_')}` : cut.replaceAll('.', '_')
}

/** Controls, bidi and invisible characters dropped, lone surrogates made U+FFFD, trimmed. */
function cleanText(name: string): string {
  return name.replace(LONE_SURROGATE, '\ufffd').replace(CONTROL_ALL, '').trim()
}

/**
 * The name a download is sent under (`downloads.start`, the `<a download>`, `Content-Disposition`,
 * the access log): display-safe (control, bidi and invisible characters dropped), no `/` or `\` (each
 * made `_`: a browser would take what follows as the name, or a folder), cut past 200 bytes keeping
 * the last extension; nothing left, or only dots (`.`, `..`) → `download`. Leading dots are kept (`.env` downloads as `.env`:
 * the browser decides how it saves one). Idempotent, so applying it again changes nothing.
 */
export function downloadName(name: string): string {
  const cleaned = cleanText(String(name)).replace(/[/\\]/g, '_')
  // An all-dots name (`.`, `..`) is a folder reference, not a file: left to each browser's own sanitising otherwise.
  return cleaned === '' || /^\.+$/.test(cleaned) ? DOWNLOAD_FALLBACK_NAME : cutName(cleaned)
}

// RFC 5987 attr-char is ALPHA / DIGIT / "!#$&+-.^_`|~"; encodeURIComponent also leaves "'()*" alone,
// and a `'` would end the charset'lang' part of `filename*`.
function encodeRfc5987(s: string): string {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * `Content-Disposition: attachment` for `name` (passed through `downloadName` first, so a header can
 * never carry a CR or LF). `filename` is the ASCII fallback for old clients: printable ASCII only,
 * every other character `_`, `"` and `\` escaped as a quoted-string wants (Node's `writeHead` throws past
 * latin1, and a raw `"` would end the value). `filename*` carries the real name in UTF-8; every browser
 * that knows it prefers it.
 */
export function contentDisposition(name: string): string {
  const safe = downloadName(name)
  const fallback = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, (c) => `\\${c}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(safe)}`
}

/**
 * The name the desktop's remote window saves an item under, from `item.getFilename()`, which the
 * page decided (an untrusted site: a compromised server runs its own client, design §3.3). Its
 * basename only (after either separator), leading dots and spaces dropped (no `.zshrc`, no hidden
 * file the person cannot see in Downloads), control and bidi characters dropped, `/ \ :` made `_`
 * (`:` is a separator to the macOS Finder), cut as `downloadName` cuts; nothing left → `download`.
 */
export function desktopSaveName(name: string): string {
  const s = String(name)
  const base = s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1)
  // Cleaned before the dots go, so `<U+202E>.zshrc` cannot come out as `.zshrc`.
  const cleaned = cleanText(base).replace(/^[\s.]+/, '').replace(/[/\\:]/g, '_')
  return cleaned === '' ? DOWNLOAD_FALLBACK_NAME : cutName(cleaned)
}
