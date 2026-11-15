// The text and checks behind the `ccc download` dialog (design-download.md §2.2), DOM-free so unit
// tests run them in plain Node (DownloadDialog.tsx draws it on ApprovalDialog, which brings the
// guards: no default Allow, Enter and Space blocked, armed after about a second, a backdrop click
// answers nothing).
//
// Everything the dialog shows is main's data about what Claude offered, and the person decides on it,
// so nothing is shortened or reworded away: the path is shown whole (CSS wraps it, never an
// ellipsis) and so is the real path when the named one is a link. A path comes from Claude and may
// hold bidi or control characters; they are dropped for display (`displayPath`) so a reversed
// extension cannot dress a program as a document. The dialog has no tab title: it is not the tab's
// to name, only the project's offer.

import { downloadSizeText, type DownloadOffer, type DownloadSkipped, type DownloadSkipReason, type DownloadTotals } from '../../shared/downloads'
import { CONTROL } from '../../shared/session-name'

const CONTROL_ALL = new RegExp(CONTROL.source, 'g')

/** A path for display: control, bidi and invisible characters dropped (never cut, never shortened). */
export function displayPath(path: string): string {
  return path.replace(CONTROL_ALL, '')
}

/** A `downloads.offer` checked (main's payload, or `ready`'s list); undefined when malformed. */
export function downloadOfferOf(payload: unknown): DownloadOffer | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const v = payload as Record<string, unknown>
  if (typeof v.requestId !== 'string' || v.requestId === '' || typeof v.path !== 'string' || typeof v.name !== 'string') return undefined
  if (typeof v.outside !== 'boolean' || typeof v.runnable !== 'boolean') return undefined
  if (v.real !== undefined && typeof v.real !== 'string') return undefined
  const base = {
    requestId: v.requestId,
    path: v.path,
    name: v.name,
    outside: v.outside,
    runnable: v.runnable,
    ...(typeof v.real === 'string' ? { real: v.real } : {})
  }
  if (v.kind === 'file') return typeof v.size === 'number' && Number.isFinite(v.size) ? { ...base, kind: 'file', size: v.size } : undefined
  if (v.kind !== 'folder') return undefined
  const counts = v.counts as Record<string, unknown> | null | undefined
  const plain = totalsOf(counts?.plain)
  const all = totalsOf(counts?.all)
  if (plain === undefined || all === undefined) return undefined
  if (typeof v.skipped !== 'object' || v.skipped === null) return undefined
  const skipped: DownloadSkipped = {}
  for (const [k, n] of Object.entries(v.skipped as Record<string, unknown>)) {
    if (k in SKIP_TEXT && typeof n === 'number' && Number.isFinite(n) && n > 0) skipped[k as DownloadSkipReason] = n
  }
  return { ...base, kind: 'folder', counts: { plain, all }, ...(v.allTooLarge === true ? { allTooLarge: true as const } : {}), skipped }
}

function totalsOf(value: unknown): DownloadTotals | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { files, folders, bytes } = value as Record<string, unknown>
  return typeof files === 'number' && typeof folders === 'number' && typeof bytes === 'number' ? { files, folders, bytes } : undefined
}

const SKIP_TEXT: Record<DownloadSkipReason, string> = {
  symlink: 'symbolic links',
  special: 'special files',
  excluded: '.git and node_modules folders',
  refused: 'files this app never sends',
  dataDir: 'the app’s data folder',
  unreadable: 'unreadable entries',
  name: 'entries with names that cannot be sent safely',
  deep: 'entries nested too deep'
}

/** "Left out: 3 symbolic links, 2 unreadable entries."; undefined when nothing was left out. */
export function skippedText(skipped: DownloadSkipped): string | undefined {
  const parts: string[] = []
  for (const reason of Object.keys(SKIP_TEXT) as DownloadSkipReason[]) {
    const n = skipped[reason]
    if (n !== undefined && n > 0) parts.push(`${n} ${SKIP_TEXT[reason]}`)
  }
  return parts.length > 0 ? `Left out: ${parts.join(', ')}.` : undefined
}

/** "312 files, 48 MB before compression" (folders counted when there are any). */
export function totalsText(t: DownloadTotals): string {
  const files = `${t.files} ${t.files === 1 ? 'file' : 'files'}`
  const folders = t.folders > 0 ? `, ${t.folders} ${t.folders === 1 ? 'folder' : 'folders'}` : ''
  return `${files}${folders}, ${downloadSizeText(t.bytes)} before compression`
}

export interface DownloadDialogText {
  title: string
  /** `File`, or `Folder, sent as a .zip`. */
  kindLine: string
  path: string
  /** The real path, when the named one is a link elsewhere. */
  real?: string
  /** Shown in the warning colour. */
  outsideLine?: string
  /** A file's size, or a folder's totals without `.git` and `node_modules`. */
  sizeLine: string
  skippedLine?: string
  /** The include checkbox's label with both sizes; folders only. */
  includeLabel?: string
  /** The include choice cannot be taken (a cap would pass); the checkbox is disabled and says why. */
  includeNote?: string
  runnableLine?: string
}

export const DOWNLOAD_DIALOG_TITLE = 'Claude in this project offers a download'

/** Everything the dialog says about an offer, as plain text (React escapes it). */
export function downloadDialogText(offer: DownloadOffer): DownloadDialogText {
  const text: DownloadDialogText = {
    title: DOWNLOAD_DIALOG_TITLE,
    kindLine: offer.kind === 'folder' ? 'Folder, sent as a .zip' : 'File',
    path: displayPath(offer.path),
    sizeLine: offer.kind === 'file' ? downloadSizeText(offer.size) : totalsText(offer.counts.plain)
  }
  if (offer.real !== undefined && offer.real !== offer.path) text.real = displayPath(offer.real)
  if (offer.outside) text.outsideLine = 'This is outside the project.'
  if (offer.runnable) text.runnableLine = 'This file can run programs when opened.'
  if (offer.kind === 'folder') {
    const skipped = skippedText(offer.skipped)
    if (skipped !== undefined) text.skippedLine = skipped
    const all = offer.allTooLarge === true ? `at least ${totalsText(offer.counts.all)}` : totalsText(offer.counts.all)
    text.includeLabel = `Include .git and node_modules (${all}; without them ${totalsText(offer.counts.plain)})`
    if (offer.allTooLarge === true) text.includeNote = 'With them the zip would be too large to send, so they cannot be included.'
  }
  return text
}

/**
 * The `downloads.accept` payload. `all` only when the person checked the box (it starts unchecked,
 * always) and the offer allows it: main refuses `all` past a cap, and the box is disabled then, but a
 * stale state must not ask for it.
 */
export function offerAcceptPayload(offer: DownloadOffer, includeChecked: boolean): { requestId: string; all: boolean } {
  return { requestId: offer.requestId, all: offer.kind === 'folder' && offer.allTooLarge !== true && includeChecked }
}

/**
 * What this view accepted, by request id, for the failure notice's Try again: `downloads.failed` has
 * the id only, and a retry repeats the include choice the person made. Bounded (the oldest go past 32).
 */
export class AcceptedOffers {
  private readonly map = new Map<string, boolean>()

  note(requestId: string, all: boolean): void {
    this.map.delete(requestId)
    this.map.set(requestId, all)
    if (this.map.size > 32) this.map.delete(this.map.keys().next().value!)
  }

  /** The include choice the person made for this request; undefined when this view never accepted it. */
  get(requestId: string): boolean | undefined {
    return this.map.get(requestId)
  }
}
