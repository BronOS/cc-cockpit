// The terminal entry of uploads (design-upload.md §4.1, §4.3): files dropped on, or pasted into, a
// Claude or shell tab of the web shell become an upload whose folder core's chooser asks for, and the
// uploaded paths are pasted into that tab when it is done.
//
//   - Drop: a drag whose `dataTransfer.types` holds `Files` highlights the pane; the drop counts as a
//     click on that pane (it selects it) and `preventDefault` keeps the browser from opening the file.
//     Dropped folders are told by their entry during the event, skipped and named in the result.
//   - Paste: an upload only when the clipboard holds files and no `text/plain` (named by `pastedName`). A copy
//     from Excel, Word or a browser's Copy image carries text beside the image, and there the text is what
//     the person meant (Task 1: an image alone gives one file and no text/plain; image plus text gives one
//     file with text/plain). Seen on the terminal's container in the capture phase, registered after the
//     session's own-act listener (terminal-session.ts), so the paste still counts as the person's act
//     there (`stopPropagation` stops the event's way down to xterm's textarea, not the other listeners of
//     this element), and xterm's own paste never sees it.
//   - Plugin command tabs, page tabs, the desktop shell and a read guest's view take nothing
//     (`takesUploads`): their drops fall to the shell's window-level cancel (`cancelUnhandledFileDrops`,
//     §3.6), their pastes to xterm.
//
// Module-level seams, as upload-request.ts's for panel frames: the upload controller (web/main.tsx, one
// per page, outside React) registers the sink (`onTerminalUpload`), and TabsPane (inside React, remounted
// on a reconnect) registers what only it knows: whether this view is keys-off and the terminal the paste
// goes into, with its paste mode (`registerTerminalPane`). Unregistered, nothing uploads and every paste is held.
//
// DOM-light: the container is an EventTarget plus `classList`, the events are read by their fields, so
// unit tests run it in plain Node.

import { isFilesDrag, splitTransfer, type UploadTransferLike } from '../../sdk/panel-core'
import type { TabKind } from '../../shared/types'
import { pastedName } from '../../shared/uploads'
import type { ViewAccess } from '../../shared/views'
import type { UploadFile } from '../web/upload-controller'
import { folderNamesForNotice } from '../web/upload-request'

/** The class that highlights a pane while a `Files` drag is over it. */
export const DROP_TARGET_CLASS = 'terminal-drop-target'

/** Whether a terminal of `kind` takes drops and file pastes in this view (§4.1): a Claude or shell tab of the web shell, not a read guest's. */
export function takesUploads(kind: TabKind, webShell: boolean, access: ViewAccess): boolean {
  return webShell && access !== 'read' && (kind === 'claude' || kind === 'shell')
}

/** A `File`, or what the shell needs of one (a fake in tests). */
interface FileLike {
  readonly name: string
  readonly size: number
  readonly type: string
  slice(start: number, end: number): Blob
}

/** The fields of a paste's `clipboardData` read here. */
export interface ClipboardLike {
  readonly types: ArrayLike<string>
  readonly files: ArrayLike<FileLike>
}

/**
 * A paste's files when the paste is an upload (files, and no `text/plain` among the types: any paste with
 * text stays a text paste, unchanged), each named `pasted-YYYYMMDD-HHMMSS.<ext>` from `now` and its type
 * (browsers call every clipboard image `image.png`; main numbers repeats). Undefined otherwise.
 */
export function pastedFiles(data: ClipboardLike | null | undefined, now: Date): UploadFile[] | undefined {
  if (!data || data.files.length === 0) return undefined
  for (let i = 0; i < data.types.length; i++) if (data.types[i] === 'text/plain') return undefined
  const out: UploadFile[] = []
  for (let i = 0; i < data.files.length; i++) {
    const file = data.files[i]
    if (!file) continue
    // The bytes are the clipboard's File's; only the name is the shell's.
    out.push({ name: pastedName(file.type, now), size: file.size, slice: (start, end) => file.slice(start, end) })
  }
  return out.length > 0 ? out : undefined
}

/**
 * A drop's files and its folders' names, read now (inside the `drop` event: after it the items are gone).
 * A folder name lands in core's notice: it passes the file name rules or is left out, as a panel's does.
 */
export function droppedFiles(transfer: UploadTransferLike): { files: UploadFile[]; folders: string[] } {
  const split = splitTransfer(transfer)
  const files = split.files.filter((f): f is File => typeof f === 'object' && f !== null && typeof (f as Partial<FileLike>).slice === 'function')
  const folders = folderNamesForNotice(split.folders)
  return { files, folders }
}

// ---------------------------------------------------------------------------------------------------
// The seams.

/** What the upload controller takes from the terminal entry (UploadController.startForTab). */
export type TerminalUploadHandler = (tabId: string, files: readonly UploadFile[], opts: { folders?: readonly string[] }) => void

let handler: TerminalUploadHandler | undefined

/** The upload controller's entry (one per page); returns the unregister. None: drops and pastes do nothing here. */
export function onTerminalUpload(fn: TerminalUploadHandler): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = undefined
  }
}

/** What TabsPane knows and the controller needs at the paste (design §4.3). */
export interface TerminalPane {
  /** This view is keys-off (state/tabs-store.ts): no command, and no paste, acts on a pane. */
  keysOff(): boolean
  /**
   * The tab's terminal here, about to take the paste main writes (TerminalSession.pasteMode: the person's
   * act, and whether it is in bracketed-paste mode); undefined when there is none, or keys-off.
   */
  pasteMode(tabId: string): { bracketed: boolean } | undefined
}

let pane: TerminalPane | undefined

/**
 * TabsPane's pane over its live tab state (`read`, its state ref, read at each call) and the sessions'
 * paste mode. Only the view's selected tab while its keys are on: the paths must not go into a terminal not
 * shown (keys-off read again here, right before the call). Main checks the view's selection once more, in
 * the step that writes the text.
 */
export function terminalPaneOf(
  read: () => { readonly activeId: string | null; readonly keysOff: boolean },
  pasteMode: (tabId: string) => { bracketed: boolean } | undefined
): TerminalPane {
  return {
    keysOff: () => read().keysOff,
    pasteMode: (tabId) => {
      const s = read()
      return s.activeId === tabId && !s.keysOff ? pasteMode(tabId) : undefined
    }
  }
}

/** TabsPane's mount; returns the unregister (a remount registers its own). */
export function registerTerminalPane(p: TerminalPane): () => void {
  pane = p
  return () => {
    if (pane === p) pane = undefined
  }
}

/**
 * The controller's keys-off check, before either paste call (§4.3: the person's own view guarding its
 * own terminal, not a boundary). Keys-off is view-wide: while it holds, no pane of this view has the
 * keys. No pane mounted counts as keys-off: there is nothing to paste into.
 */
export function terminalKeysOff(): boolean {
  return pane === undefined || pane.keysOff()
}

/** The controller's paste mode, through the mounted pane, which reads keys-off again (`terminalPaneOf`). */
export function terminalPasteMode(tabId: string): { bracketed: boolean } | undefined {
  return pane?.pasteMode(tabId)
}

// ---------------------------------------------------------------------------------------------------
// The container's listeners.

/** The container as this reads it: an element, by its listeners and class list. */
export interface DropContainer extends EventTarget {
  readonly classList: { add(name: string): void; remove(name: string): void }
  contains?(other: unknown): boolean
}

/** A terminal that takes uploads: its tab, and the click a drop counts as (select the pane, take as a press). */
export interface TerminalEntry {
  tabId: string
  select(): void
}

type DragLike = Event & { dataTransfer?: (UploadTransferLike & { types?: ArrayLike<string>; dropEffect?: string }) | null; relatedTarget?: unknown }
type PasteLike = Event & { clipboardData?: ClipboardLike | null }

/**
 * Adds the drop and file-paste listeners to a terminal's container (capture: before xterm's own on its
 * elements); returns their removal. The session calls it after its own-act listener (the order is the
 * point, see the header). Each listener checks for the controller's sink at the event: with none (the
 * page not wired yet) a drop is still cancelled, so the browser never opens the file over the shell.
 */
export function attachTerminalEntry(container: DropContainer, entry: TerminalEntry, now: () => Date = () => new Date()): () => void {
  const highlight = (on: boolean): void => {
    if (on) container.classList.add(DROP_TARGET_CLASS)
    else container.classList.remove(DROP_TARGET_CLASS)
  }
  const onDragOver = (event: Event): void => {
    const e = event as DragLike
    if (!isFilesDrag(e.dataTransfer?.types)) return
    // Cancelled `dragover` is what lets the drop land here (and nothing else takes it).
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    highlight(true)
  }
  const onDragLeave = (event: Event): void => {
    const e = event as DragLike
    // Moving onto a child of the pane (xterm's rows) leaves the container too: only leaving it counts.
    const into = e.relatedTarget
    if (into !== null && into !== undefined && typeof container.contains === 'function' && container.contains(into)) return
    highlight(false)
  }
  const onDrop = (event: Event): void => {
    const e = event as DragLike
    highlight(false)
    if (!e.dataTransfer || !isFilesDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    const { files, folders } = droppedFiles(e.dataTransfer)
    if (!handler || (files.length === 0 && folders.length === 0)) return
    entry.select()
    handler(entry.tabId, files, folders.length > 0 ? { folders } : {})
  }
  const onPaste = (event: Event): void => {
    const e = event as PasteLike
    const files = pastedFiles(e.clipboardData, now())
    if (!files || !handler) return
    e.preventDefault()
    e.stopPropagation()
    handler(entry.tabId, files, {})
  }
  const onDragEnd = (): void => highlight(false)
  container.addEventListener('dragenter', onDragOver, true)
  container.addEventListener('dragover', onDragOver, true)
  container.addEventListener('dragleave', onDragLeave, true)
  container.addEventListener('drop', onDrop, true)
  container.addEventListener('dragend', onDragEnd, true)
  container.addEventListener('paste', onPaste, true)
  return () => {
    highlight(false)
    container.removeEventListener('dragenter', onDragOver, true)
    container.removeEventListener('dragover', onDragOver, true)
    container.removeEventListener('dragleave', onDragLeave, true)
    container.removeEventListener('drop', onDrop, true)
    container.removeEventListener('dragend', onDragEnd, true)
    container.removeEventListener('paste', onPaste, true)
  }
}

/**
 * The web shell's default for a `Files` drag nobody took (§3.6): in a plain browser a file dropped where
 * no handler takes it opens in the tab, which replaces the shell and kills its running uploads. Bubble
 * phase on the window, so a terminal's own handling comes first (a drag it cancelled is left alone).
 * Every other `Files` drag, whatever its target: the SDK's rule (`cancelsFilesDrag`) spares a file input,
 * a text field and a contenteditable, which suits a panel page with its own file input, but the shell
 * has no file input, and a file dropped on one of its text fields (settings, the palette, xterm's
 * helper textarea in a tab that takes no uploads) would open in the tab too. Returns the removal.
 */
export function cancelUnhandledFileDrops(target: EventTarget): () => void {
  const cancel = (event: Event): void => {
    const e = event as DragLike
    if (e.defaultPrevented || !isFilesDrag(e.dataTransfer?.types)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  }
  target.addEventListener('dragover', cancel)
  target.addEventListener('drop', cancel)
  return () => {
    target.removeEventListener('dragover', cancel)
    target.removeEventListener('drop', cancel)
  }
}
