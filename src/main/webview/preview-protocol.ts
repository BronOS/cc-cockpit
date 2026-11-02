// `cc-preview://<token>/<path>`: local files shown in a webview panel (plan B: Technical Details ›
// Web view panel). `ctx.webview.navigate(panelId, '/abs/file.html')` makes a token for the file's
// folder (webview-manager.ts); the page and whatever it links next to it (css, images, scripts)
// are served from that folder, read only. This file decides what a URL serves, with no Electron
// import, so unit tests call it directly; electron-webview.ts registers it on each webview
// partition's own session (never the default one, where the shell page lives).
//
// Threat model: the page is a local file the caller chose, but it runs in a browser view and can
// read every file its token reaches. So:
// - the folder of `/`, the home folder or any ancestor of it is refused as a root ("move the file
//   into a project folder"): a mock-up saved in ~ must not hand the page ~/.ssh (webview-manager.ts
//   adds the checks that need the disk: alias spellings of home, ~/Library, disk roots, temp roots);
// - a dot-file or a dot-folder anywhere on the real path is never served and never a root (.env,
//   a project's .git, ~/.ssh, a Claude Code worktree under .claude/worktrees): `ccc browser open
//   .git/description` must not make `.git` a root whose `config` (remote credentials) the page
//   could then read (review finding: only home's first level and the names below the root were
//   checked);
// - the containment checks are those of cc-plugin:// (plugin-protocol.ts): an encoded `.`, `/`,
//   `\` or NUL in the raw path is refused, segments are decoded one by one, and the realpath must
//   stay inside the realpath'd root (a symlink pointing out is refused like `..`);
// - the bytes are read through a verified descriptor, never by name again (verified-read.ts): a
//   file or folder swapped for a symlink after the checks does not get a file outside served;
// - every response, 404s included, carries a CSP that lets the page reach its own token only (no
//   fetch, image, frame or form to http(s), so it cannot send what it read anywhere by itself)
//   and `Referrer-Policy: no-referrer` (a link it opens does not carry the token);
// - at most MAX_PREVIEW_FILE_BYTES per response, GET and HEAD only;
// - at most MAX_PREVIEW_INFLIGHT_BYTES held in main per session (PreviewBudget), counted from the
//   read until the page has taken the whole body or dropped the request; past it a 503. The body is
//   a Buffer in main until then, so a page looping `fetch('big.bin')` without reading the bodies
//   would otherwise grow main's memory until the whole app went down (review finding). A request
//   past it is refused, not queued: a page loading more than that at once (hundreds of MiB of
//   local images) gets broken images for the rest and shows them on a reload. The budget starts
//   over when the partition's last view goes (PreviewBudgets.drop), so a charge Electron never gave
//   back (a body it did not cancel) cannot 503 the next view of that project and plugin.
// What the CSP cannot stop: a top-level navigation to an http(s) URL carrying data in its query
// (the plan lets a webview follow http(s) links, it is a browser), dns-prefetch/preconnect hints
// (data in a host name) and WebRTC (STUN/TURN ignore connect-src; electron-webview.ts keeps it off
// non-proxied UDP, which does not stop a TURN server over TCP). The folder rules above are what keep
// secrets out of reach in the first place.
import { realpath } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { within } from '../path-within'
import { contentTypeOf } from '../plugins/plugin-protocol'
import { resolveInside } from '../plugins/validate'
import { readVerified, verifiedProblemText } from '../verified-read'

export const PREVIEW_SCHEME = 'cc-preview'

/** Largest file served (a design export with inlined images stays far below it). */
export const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024

/**
 * What a request takes from the budget for a file of `size` bytes: the stat's size plus the one
 * byte of growth the capped read allows (readVerified reads one past the cap to notice a file that
 * grew), so what the read can hold at most.
 */
export function previewCharge(size: number, maxBytes: number = MAX_PREVIEW_FILE_BYTES): number {
  return Math.min(size + 1, maxBytes + 1)
}

/**
 * Bytes of cc-preview bodies one session may hold in main at once: two of the largest files, each
 * at its full charge (review finding: at 2 x MAX_PREVIEW_FILE_BYTES the second one was refused,
 * one byte short). A mock-up's own files are far below it, a page that piles up requests gets 503s.
 */
export const MAX_PREVIEW_INFLIGHT_BYTES = 2 * previewCharge(MAX_PREVIEW_FILE_BYTES)

/**
 * The bytes of cc-preview bodies a session holds in main (one per webview partition, index.ts).
 * A request takes its file's size before the read and gives it back once the body is drained or
 * cancelled (servePreviewRequest), or right away when it ends without one.
 */
export class PreviewBudget {
  private held = 0

  constructor(readonly maxBytes: number = MAX_PREVIEW_INFLIGHT_BYTES) {}

  /** Room for `bytes` more: taken (true), or none left (false, nothing taken). */
  take(bytes: number): boolean {
    if (this.held + bytes > this.maxBytes) return false
    this.held += bytes
    return true
  }

  release(bytes: number): void {
    this.held = Math.max(0, this.held - bytes)
  }

  /** Bytes held now (tests). */
  get inFlight(): number {
    return this.held
  }
}

/**
 * One PreviewBudget per webview partition (project x plugin), for as long as the partition has a
 * view. `drop` forgets it when the last view goes (WebviewManager's partitionClosed): the next view
 * starts with the whole budget, and a body of the old views still releasing gives back to the
 * forgotten one, which nothing reads any more.
 */
export class PreviewBudgets {
  private readonly byPartition = new Map<string, PreviewBudget>()

  constructor(private readonly maxBytes: number = MAX_PREVIEW_INFLIGHT_BYTES) {}

  of(partition: string): PreviewBudget {
    let budget = this.byPartition.get(partition)
    if (!budget) this.byPartition.set(partition, (budget = new PreviewBudget(this.maxBytes)))
    return budget
  }

  drop(partition: string): void {
    this.byPartition.delete(partition)
  }

  /** Partitions with a budget now (tests). */
  get size(): number {
    return this.byPartition.size
  }
}

/** Chunk size of a cc-preview body stream: what Electron pulls at a time. */
const BODY_CHUNK_BYTES = 1024 * 1024

/** Longest URL path looked at. */
const MAX_PATH_LENGTH = 4096

/**
 * Tokens are `t` + 32 hex digits: a valid host label, lower case (hosts are case-insensitive), and
 * never all digits (a `standard` scheme's parser reads a numeric host as IPv4 and rewrites it).
 */
export const PREVIEW_TOKEN_PATTERN = /^t[0-9a-f]{32}$/

/**
 * The page's own token only (`'self'` is `cc-preview://<token>`), inline styles and scripts allowed
 * (a hand-written mock-up uses them), `data:`/`blob:` for generated images. `form-action`,
 * `base-uri` and `frame-ancestors` do not fall back to default-src, so they are set too.
 */
export const PREVIEW_CSP = [
  "default-src 'self' 'unsafe-inline' data: blob:",
  "form-action 'self'",
  "base-uri 'self'",
  "frame-ancestors 'self'"
].join('; ')

/** The headers of every cc-preview response. */
export function previewHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'content-security-policy': PREVIEW_CSP,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store'
  }
}

/**
 * The macOS data volume's own spelling of every firmlinked folder (`/usr/share/firmlinks`):
 * `/System/Volumes/Data/Users/<me>` is the home folder, but `realpath` leaves it as spelled, so the
 * string checks here would take it for some unrelated folder (review finding: a token for all of
 * home, or for `.../<me>/.ssh`). Nothing a person saves lives under it by that name only, so the
 * whole prefix is refused instead of mapped back to `/`.
 */
export const DARWIN_DATA_VOLUME = '/System/Volumes/Data'

/**
 * Why `folder` (realpath'd) may not be a preview root, or null. `home` is the realpath'd home
 * folder (injected: tests use a temp dir). Refused: the file-system root, the data volume spelling
 * of it (DARWIN_DATA_VOLUME), the home folder and every folder that contains it (`/Users` would
 * reach every home on the machine), and a folder with a dot-folder anywhere on its path (inside
 * home or not). String checks only; resolveWebviewTarget adds identity checks.
 */
export function previewRootProblem(folder: string, home: string): string | null {
  if (dirname(folder) === folder) return 'the file-system root cannot be shown: move the file into a project folder'
  if (within(DARWIN_DATA_VOLUME, folder)) return 'a path under /System/Volumes/Data cannot be shown: use the usual path of the file'
  if (within(folder, home)) return 'a file directly in the home folder (or above it) cannot be shown: move the file into a project folder'
  if (hasDotSegment(folder)) return DOT_FOLDER_PROBLEM
  return null
}

/** The refusal of a folder with a dot-folder on its path (previewRootProblem). */
export const DOT_FOLDER_PROBLEM =
  'files inside a dot-folder (.git, .ssh, .config, .claude/worktrees, ...) are not shown: copy the file into a folder of its own outside it'

/** Some segment of the absolute `path` is a dot name (`/a/.git/b`, `/a/..cache`). */
export function hasDotSegment(path: string): boolean {
  return path.split(sep).some(isDotName)
}

/** A dot-file or dot-folder name (`.env`, `.git`): never served, never a navigate target. */
export function isDotName(name: string): boolean {
  return name.startsWith('.')
}

export interface PreviewDeps {
  /** The folder (absolute, realpath'd when the token was made) a token maps to, else undefined. */
  folderOf(token: string): string | undefined
  /** Largest file served (default MAX_PREVIEW_FILE_BYTES; a test knob). */
  maxBytes?: number
  /** The session's budget of bytes held in main (index.ts keeps one per partition). Default: none. */
  budget?: PreviewBudget
  log?: (message: string) => void
}

/** `dev`/`ino`: the file the checks passed; the read must be that file (readVerified's `expect`). */
export type PreviewResolution = { ok: true; file: string; size: number; dev: number; ino: number } | { ok: false; reason: string }

/** The file a `cc-preview:` URL names, after every check above (exported for the unit tests). */
export async function resolvePreviewFile(url: string, deps: Pick<PreviewDeps, 'folderOf' | 'maxBytes'>): Promise<PreviewResolution> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (parsed.protocol !== `${PREVIEW_SCHEME}:`) return { ok: false, reason: 'another scheme' }
  const token = parsed.hostname
  if (!PREVIEW_TOKEN_PATTERN.test(token)) return { ok: false, reason: 'not a token' }
  const raw = parsed.pathname
  if (raw.length > MAX_PATH_LENGTH) return { ok: false, reason: 'path too long' }
  if (/%(?:2e|2f|5c|00)/i.test(raw) || raw.includes('\\')) return { ok: false, reason: 'encoded separator or dot' }
  const folder = deps.folderOf(token)
  if (folder === undefined) return { ok: false, reason: 'unknown or revoked token' }

  const segments: string[] = []
  for (const part of raw.split('/')) {
    if (part === '') continue
    let decoded: string
    try {
      decoded = decodeURIComponent(part)
    } catch {
      return { ok: false, reason: 'bad escape' }
    }
    if (decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) return { ok: false, reason: 'bad segment' }
    // Covers `.` and `..` too (the parser folds literal ones; an escaped one never gets here).
    if (isDotName(decoded)) return { ok: false, reason: 'dot-file' }
    segments.push(decoded)
  }
  if (segments.length === 0) return { ok: false, reason: 'no file named' }

  let root: string
  try {
    // Again at request time: the folder can have been replaced by a symlink since the token was made.
    root = await realpath(folder)
  } catch {
    return { ok: false, reason: 'no such file' }
  }
  if (root !== folder) return { ok: false, reason: 'the folder moved' }
  // Never minted for such a folder (previewRootProblem), but the served file's whole real path is
  // what the rule is about, so the root's part of it is checked here too.
  if (hasDotSegment(root)) return { ok: false, reason: 'dot-folder' }
  const target = await resolveInside(root, join(...segments))
  if (!target.ok) {
    if (target.problem === 'missing') return { ok: false, reason: 'no such file' }
    if (target.problem === 'not-file' || target.problem === 'root') return { ok: false, reason: 'not a regular file' }
    return { ok: false, reason: 'outside the folder' }
  }
  // A symlink inside the folder to a dot-file inside it (`page.txt -> .env`) is still the dot-file.
  if (relative(root, target.real).split(sep).some(isDotName)) return { ok: false, reason: 'dot-file' }
  if (target.size > (deps.maxBytes ?? MAX_PREVIEW_FILE_BYTES)) return { ok: false, reason: 'file too large' }
  return { ok: true, file: target.real, size: target.size, dev: target.dev, ino: target.ino }
}

/** Answer one `cc-preview:` request (the body of the session's `protocol.handle`). */
export async function servePreviewRequest(url: string, method: string, deps: PreviewDeps): Promise<Response> {
  const notFound = (): Response => new Response('not found', { status: 404, headers: previewHeaders('text/plain; charset=utf-8') })
  const res = method === 'GET' || method === 'HEAD' ? await resolvePreviewFile(url, deps) : { ok: false as const, reason: `method ${method}` }
  if (!res.ok) {
    // The reason stays in main's log; the page sees a bare 404 (no hint of what exists).
    deps.log?.(`cc-preview: 404: ${res.reason}`)
    return notFound()
  }
  const maxBytes = deps.maxBytes ?? MAX_PREVIEW_FILE_BYTES
  const charge = previewCharge(res.size, maxBytes)
  if (deps.budget && !deps.budget.take(charge)) {
    deps.log?.('cc-preview: 503: the session holds too many unread bodies')
    return new Response('busy', { status: 503, headers: previewHeaders('text/plain; charset=utf-8') })
  }
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    deps.budget?.release(charge)
  }
  let body: Buffer
  try {
    // Through one verified descriptor, capped (the file can grow between the stat and the read).
    const read = await readVerified(res.file, maxBytes, res)
    if (!read.ok) {
      release()
      deps.log?.(`cc-preview: 404: the file ${verifiedProblemText(read.problem)}`)
      return notFound()
    }
    body = read.data
  } catch {
    release()
    return notFound()
  }
  const headers = previewHeaders(contentTypeOf(res.file))
  if (method === 'HEAD') {
    release()
    return new Response(null, { status: 200, headers })
  }
  return new Response(drainingStream(body, release), { status: 200, headers })
}

/**
 * `data` as a stream handed out in chunks as the consumer pulls; `done` runs once, when the last
 * chunk went out or the consumer cancelled (Electron cancels the body of a request the page
 * dropped or a view that closed). Until then the budget counts the buffer as held.
 */
function drainingStream(data: Buffer, done: () => void): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close()
        done()
        return
      }
      const end = Math.min(offset + BODY_CHUNK_BYTES, data.length)
      // A copy per chunk: a view into `data` could be transferred (detaching the whole buffer).
      controller.enqueue(new Uint8Array(data.subarray(offset, end)))
      offset = end
    },
    cancel() {
      done()
    }
  })
}
