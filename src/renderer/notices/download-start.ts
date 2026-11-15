// The web shell's side of a download (design-download.md §2.1, §3.2), DOM-free so unit tests run it in
// plain Node (ShellNotices.tsx draws it): what to do with main's `downloads.start` and how a
// `downloads.failed` reads.
//
// `downloads.start` comes to the one browser view the person clicked in (ctx.files.download from a
// plugin's menu, later an accepted `ccc download`). The shell clicks a same-origin
// `<a href="/d/<token>" download="<name>">` itself: the person's click was in the plugin's frame, and
// User Activation v2 activates the ancestors too, so this page usually still holds transient
// activation (about 5 s in Chromium) when the event arrives. Without it (a slow folder count, a browser
// that does not propagate activation) a programmatic click may be blocked or put behind the browser's
// "multiple downloads" prompt, so the shell shows "<name> is ready — Download" instead: a real link the
// person clicks. Only the web shell acts: the desktop page never gets the event (main sends it to a
// remote view only), and if it did it would do nothing (the file is already on this computer).
//
// The url is checked here as the last place before an `href` (isDownloadUrl: `/d/` and a 43-character
// token, nothing else), so a malformed event can never point the link at another origin or a
// `javascript:` URL. The name is main's `downloadName` and passed through it again (idempotent): the
// `download` attribute is a suggestion the browser sanitises too, but a control or bidi character
// would still show in the notice.

import { downloadName, isDownloadUrl, type DownloadFailed, type DownloadStart } from '../../shared/downloads'

/** A `downloads.start` checked: undefined when malformed (then nothing is clicked or shown). */
export function downloadStartOf(payload: unknown): DownloadStart | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { requestId, url, name } = payload as Record<string, unknown>
  if (typeof requestId !== 'string' || requestId === '' || !isDownloadUrl(url) || typeof name !== 'string') return undefined
  return { requestId, url, name: downloadName(name) }
}

/**
 * What the shell does with a `downloads.start`: click the link now (`click`), show the ready notice
 * (`notice`), or nothing (`none`: malformed, or not the web shell). Activation is read when the event
 * arrives; absent in an older browser it is unknown, so the notice.
 */
export type DownloadStartAction = { kind: 'click'; start: DownloadStart } | { kind: 'notice'; start: DownloadStart } | { kind: 'none' }

export function downloadStartAction(payload: unknown, env: { webShell: boolean; activationActive: boolean }): DownloadStartAction {
  const start = downloadStartOf(payload)
  if (start === undefined || !env.webShell) return { kind: 'none' }
  return env.activationActive ? { kind: 'click', start } : { kind: 'notice', start }
}

/** A `downloads.failed` checked (the reason is main's plain text, shown as text); undefined when malformed. */
export function downloadFailedOf(payload: unknown): DownloadFailed | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { requestId, reason } = payload as Record<string, unknown>
  if (typeof requestId !== 'string' || typeof reason !== 'string') return undefined
  return { requestId, reason }
}

/** One download notice: a link ready to click, or a failure with its reason. */
export type DownloadNotice =
  | { kind: 'ready'; requestId: string; url: string; name: string }
  | { kind: 'failed'; requestId: string; name?: string; reason: string }

/**
 * Notices kept at once: past it the oldest go. Main bounds the starts (10 a minute per plugin) and a
 * failure is one per start, so this only keeps a burst from covering the page.
 */
export const MAX_DOWNLOAD_NOTICES = 4

/** How long a ready link stays: its token lives 60 s (DOWNLOAD_TOKEN_MS), after which the link answers nothing. */
export const READY_NOTICE_MS = 60_000

/**
 * A notice joins the list. One per request id: a failure replaces the ready link of the same request
 * (that link will not work), a second event of the same kind replaces the first. Past the cap the
 * oldest go.
 */
export function addDownloadNotice(list: readonly DownloadNotice[], n: DownloadNotice): readonly DownloadNotice[] {
  const next = [...list.filter((x) => x.requestId !== n.requestId), n]
  return next.length > MAX_DOWNLOAD_NOTICES ? next.slice(next.length - MAX_DOWNLOAD_NOTICES) : next
}

/** A notice clicked, dismissed or expired leaves the list (the same array when it is not there). */
export function dropDownloadNotice(list: readonly DownloadNotice[], requestId: string): readonly DownloadNotice[] {
  return list.some((x) => x.requestId === requestId) ? list.filter((x) => x.requestId !== requestId) : list
}

/**
 * The text of a failure notice. The name is the one the start carried when this view saw it (main's
 * `downloads.failed` has only the request id), else none.
 */
export function downloadFailedText(n: { name?: string; reason: string }): string {
  return n.name !== undefined ? `${n.name} could not be downloaded: ${n.reason}` : `The download failed: ${n.reason}`
}

/** The parts of a document `clickDownload` uses (structural, so a test passes a fake). */
export interface DownloadDocument {
  createElement(tag: 'a'): { href: string; download: string; rel: string; style: { display: string }; click(): void; remove(): void }
  body: { appendChild(node: unknown): unknown }
}

/**
 * Click a same-origin `<a href download>` for `start`, in the page's own document (a detached anchor
 * is not clicked by every browser, so it is attached for the click and removed after). `noreferrer`:
 * the GET carries no Referer (the gateway sends `no-referrer` too).
 */
export function clickDownload(doc: DownloadDocument, start: DownloadStart): void {
  const a = doc.createElement('a')
  a.href = start.url
  a.download = start.name
  a.rel = 'noreferrer'
  a.style.display = 'none'
  doc.body.appendChild(a)
  try {
    a.click()
  } finally {
    a.remove()
  }
}
