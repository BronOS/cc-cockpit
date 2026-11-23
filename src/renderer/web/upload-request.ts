// The shell's side of `ccPanel.upload` (design-upload.md §5.2): a panel page posts
// `{ type: 'cc-plugin.upload', folder, files, folders }` to its parent, and this turns it into an upload
// request naming that panel (`uploads.begin`'s `{ panel: key }`) for the upload controller (Task 10 of
// the upload plan registers with `onUploadRequest`).
//
// Taken only from a panel frame in a zone: PluginPanel is the one caller of `panelUploadMessage` (a
// grep test keeps it so), and it passes its own key and its own frame's window. An html overlay (which
// Claude can author), a slot (another plugin's page placed in a panel), the plugin settings page and a
// page tab mount PluginFrame without it, so their posts never get here. The page is untrusted (it can
// post the message by hand, with no SDK), so every field is checked again here; main then checks the
// panel against the view's layout, the role, the folder and every name, whatever this passes.
// DOM-free (the frame's window and `File` are compared, never touched) so unit tests run it in Node.

import { MAX_UPLOAD_FOLDER_LENGTH, UPLOAD_MESSAGE } from '../../sdk/panel-core'
import type { UploadSource } from '../../shared/uploads'
import { isWebShell, viewAccessHint } from '../shell-kind'

/** What the controller starts an upload from: the source main resolves, the folder, the files. */
export interface UploadRequest {
  source: UploadSource
  /** Project-relative, `''` the project folder (main resolves and checks it). */
  folder: string
  files: File[]
  /** Dropped folders, skipped (no folder uploads) and named in the result notice. */
  folders: string[]
}

/** Folder names kept for the notice: a few are enough to say what was skipped. */
const MAX_FOLDER_NAMES = 100
/** A folder name longer than a file system's name limit is no name (dropped from the notice). */
const MAX_FOLDER_NAME_LENGTH = 255

/** Whether a posted entry is a real `File` (structured clone makes one in this window's realm). */
const isFile = (value: unknown): value is File => typeof File === 'function' && value instanceof File

/**
 * A panel page's message as an upload request, or null: not from that frame's own window (another
 * frame speaking for it), not an upload message, a folder that is not a bounded string, a file list
 * that is not all `File`s, or nothing at all to upload or name. Also null outside the web shell and in
 * a read guest's view, where the SDK offers no `ccPanel.upload` (a UI hint: main refuses by role).
 * A file list over main's cap is passed as it is: main's refusal is the one the person sees.
 */
export function uploadRequestOf(
  panelKey: string,
  event: { source: unknown; data: unknown },
  frameWindow: unknown
): UploadRequest | null {
  if (frameWindow === null || frameWindow === undefined || event.source !== frameWindow) return null
  if (!isWebShell() || viewAccessHint() === 'read') return null
  const data = event.data
  if (typeof data !== 'object' || data === null || (data as { type?: unknown }).type !== UPLOAD_MESSAGE) return null
  const { folder, files, folders } = data as { folder?: unknown; files?: unknown; folders?: unknown }
  if (typeof folder !== 'string' || folder.length > MAX_UPLOAD_FOLDER_LENGTH) return null
  if (!Array.isArray(files) || !files.every(isFile)) return null
  const names: string[] = []
  if (Array.isArray(folders)) {
    for (const name of folders) {
      if (names.length >= MAX_FOLDER_NAMES) break
      if (typeof name === 'string' && name.length > 0 && name.length <= MAX_FOLDER_NAME_LENGTH) names.push(name)
    }
  }
  if (files.length === 0 && names.length === 0) return null
  return { source: { panel: panelKey }, folder, files: [...files], folders: names }
}

let handler: ((request: UploadRequest) => void) | undefined

/**
 * The upload controller's entry (one per page): every request a panel frame makes goes there. Returns
 * the unregister. With none registered (the desktop shell, before the controller is up) a request is
 * dropped: the desktop page never uploads (design-upload.md §1).
 */
export function onUploadRequest(fn: (request: UploadRequest) => void): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = undefined
  }
}

/**
 * PluginPanel's `onPageMessage` for its own frame (`frameWindow`, the frame element's window). True
 * when the message was an upload request and went to the controller.
 */
export function panelUploadMessage(panelKey: string, event: { source: unknown; data: unknown }, frameWindow: unknown): boolean {
  const request = uploadRequestOf(panelKey, event, frameWindow)
  if (!request || !handler) return false
  handler(request)
  return true
}
