// The web shell's upload controller (design-upload.md §3.1, §4, §5.3): one per page, it owns every
// upload this view starts, from the request to the result notice.
//
//   request (a panel frame's `ccPanel.upload`, upload-request.ts; or the terminal entry's drop or paste)
//     → for a terminal source, core's folder chooser (the panel names its own folder)
//     → `uploads.begin` → the clash dialog and `uploads.resolve` when a name is taken
//     → `runUpload` (upload-client.ts), with a progress notice and its Cancel
//     → the result notice → for a terminal source, `uploads.paste` and the held notice's Paste path.
//
// Several uploads run at once, each with its own notice and `AbortController`; how many a device may
// run is main's limit (its refusal at begin is one notice). Every call can answer `{error}` and can
// also reject (the socket away, a refusal main throws, `uploads.paste` before the terminal entry is
// wired): both end in a notice, never an unhandled rejection, and a Cancel while the host is away
// still stops the bytes locally.
//
// Created once in `startShell` (web/main.tsx), not inside React: `<App>` remounts on every reconnect
// and a reconnect does not end an upload (design §3.4: the token is bound to the device, not the view).
// Leaving the page (`pagehide`) aborts every run and sends `uploads.cancel` best-effort, with no
// `beforeunload` prompt (design §5.3: in the remote window a held unload silently blocks the close);
// main's idle clock removes whatever a lost cancel leaves.
//
// DOM-free: the invoke, the run, the dialogs and notices (`UploadUi`), the storage and the terminal's
// paste are injected, so unit tests drive it in plain Node.

import { runUpload, type UploadFileResult, type UploadRunOptions, type UploadSource as UploadBytes } from './upload-client'
import type { UploadRequest } from './upload-request'
import {
  foldersText,
  nothingUploadedText,
  readPreset,
  resultText,
  writePreset,
  type HeldPaste,
  type PresetStorage,
  type UploadNotice,
  type UploadOutcome,
  type UploadUi
} from '../notices/upload-model'
import type { CockpitApi } from '../../shared/ipc'
import type { UploadBegun, UploadChoice, UploadFileToken, UploadPasteReply, UploadRefusedFile } from '../../shared/uploads'

/** A file as the controller needs it: its name and size for the begin, its bytes for the run. */
export interface UploadFile extends UploadBytes {
  readonly name: string
}

/**
 * What starts an upload: a panel's request (its folder named) or the terminal entry's (Task 11 of the
 * upload plan: `{ tab }`, no folder, so the chooser asks; `pasted` for a clipboard paste, named by main).
 */
export interface ControllerRequest {
  source: UploadRequest['source']
  /** Project-relative; absent for a terminal source, whose folder the chooser picks. */
  folder?: string
  files: readonly UploadFile[]
  /** Dropped folders, skipped and named in the result. */
  folders?: readonly string[]
  /** Every file came from a clipboard paste (design §4.1). */
  pasted?: boolean
}

type UiPart = Pick<UploadUi, 'showChooser' | 'endChooser' | 'showClash' | 'endClash' | 'putNotice' | 'dropNotice'>

export interface UploadControllerDeps {
  invoke: CockpitApi['invoke']
  ui: UiPart
  /** The project the page shows: the chooser's preset is kept per project. */
  projectId: string
  /** `localStorage` in the page (inside try/catch in the model), absent in tests that do not care. */
  storage?: PresetStorage
  /** Defaults to upload-client's `runUpload`. */
  run?: (files: readonly UploadBytes[], tokens: readonly UploadFileToken[], opts: UploadRunOptions) => Promise<UploadFileResult[]>
  /**
   * The terminal entry's seams (Task 11): whether this view is keys-off for that pane (the renderer's
   * own guard, design §4.3; keys-off counts as held), and the paste with xterm's own `paste` in that
   * view. Unwired, every terminal paste is held: the result keeps the paths with Paste path.
   */
  keysOff?: (tabId: string) => boolean
  pasteInto?: (tabId: string, text: string) => boolean
}

/** The hold the shell itself decides (design §4.3: keys-off is the person's own view guarding its terminal). */
export const KEYS_OFF_HELD = 'the keys are off in this view'
/** A paste the shell could not deliver (no terminal for the tab here, or the call failed). */
export const PASTE_FAILED_HELD = 'the path could not be pasted'
/** A run that rejected (it never should: runUpload settles every file) is said as this. */
const RUN_FAILED = 'the upload stopped unexpectedly'

/** A call's rejection as a notice reason: main's refusal text, or a fixed one. */
function reasonOf(err: unknown): string {
  return err instanceof Error && err.message !== '' ? err.message : 'the host did not answer'
}

/** One upload in flight: what `pagehide` and Cancel act on. */
interface Live {
  noticeId: string
  abort: AbortController
  /** Known once begin answered. */
  uploadId?: string
  /** A dialog of this upload on screen (chooser or clash), ended on leave. */
  dialog?: { kind: 'chooser' | 'clash'; id: string }
}

export class UploadController {
  private readonly live = new Set<Live>()
  private seq = 0
  private left = false

  constructor(private readonly deps: UploadControllerDeps) {}

  /** A request: returns when the upload ended (tests await it; the shell does not). Never rejects. */
  async start(request: ControllerRequest): Promise<void> {
    if (this.left || (request.files.length === 0 && (request.folders ?? []).length === 0)) return
    const n = ++this.seq
    const entry: Live = { noticeId: `upload-${n}`, abort: new AbortController() }
    this.live.add(entry)
    try {
      await this.flow(request, entry, n)
    } catch (err) {
      // Nothing in flow should throw; a bug here still ends in a notice rather than a silent nothing.
      this.notice(entry, { kind: 'result', id: entry.noticeId, text: nothingUploadedText(reasonOf(err)), sticky: true })
    } finally {
      this.live.delete(entry)
    }
  }

  /**
   * The terminal entry's call (Task 11): files dropped on or pasted into a Claude or shell tab. The
   * chooser asks for the folder, and the paths are pasted into that tab when the upload is done.
   */
  startForTab(tabId: string, files: readonly UploadFile[], opts: { folders?: readonly string[]; pasted?: boolean } = {}): Promise<void> {
    return this.start({ source: { tab: tabId }, files, ...(opts.folders ? { folders: opts.folders } : {}), ...(opts.pasted ? { pasted: true } : {}) })
  }

  /**
   * The page is leaving: every run aborted and its upload cancelled on main, best-effort (the socket
   * closes right after, so nothing is awaited); dialogs closed; later answers ignored.
   */
  leave(): void {
    this.left = true
    for (const entry of this.live) {
      entry.abort.abort()
      if (entry.uploadId !== undefined) this.cancelOnMain(entry.uploadId)
      this.endDialog(entry)
    }
    this.live.clear()
  }

  private async flow(request: ControllerRequest, entry: Live, n: number): Promise<void> {
    const { source, files } = request
    const folders = request.folders ?? []
    const tab = 'tab' in source ? source.tab : undefined
    let folder = request.folder
    if (folder === undefined) {
      if (tab === undefined) return
      if (files.length === 0) {
        // A drop of folders only: nothing to choose a folder for.
        this.notice(entry, { kind: 'result', id: entry.noticeId, ...resultText({ folder: '', fileCount: 0, done: [], failed: [], folders }) })
        return
      }
      folder = await this.choose(entry, tab, files, `chooser-${n}`)
      if (folder === undefined || this.left) return
    }
    if (files.length === 0) {
      this.notice(entry, { kind: 'result', id: entry.noticeId, ...resultText({ folder, fileCount: 0, done: [], failed: [], folders }) })
      return
    }

    let begun: UploadBegun
    try {
      const reply = await this.deps.invoke('uploads.begin', {
        source,
        folder,
        files: files.map((f) => ({ name: f.name, size: f.size, ...(request.pasted ? { pasted: true } : {}) }))
      })
      if ('error' in reply) return this.refusedAtBegin(entry, reply.error, folders)
      begun = reply
    } catch (err) {
      return this.refusedAtBegin(entry, reasonOf(err), folders)
    }
    entry.uploadId = begun.uploadId
    // Answered after the page started leaving: leave() saw no id, so cancel it here.
    if (this.left) return this.cancelOnMain(begun.uploadId)
    if (tab !== undefined) writePreset(this.deps.storage, this.deps.projectId, folder)

    const refused: UploadRefusedFile[] = [...begun.refused]
    let tokens = begun.tokens
    if (tokens === undefined) {
      const answered = await this.resolveClashes(entry, folder, begun, `clash-${n}`)
      if (this.left) return
      if ('cancelled' in answered) {
        // The person's own Cancel: a notice only when something else needs saying (refused files, folders).
        if (refused.length > 0 || folders.length > 0) this.result(entry, request, folder, [], refused, true)
        return
      }
      if ('error' in answered) return this.refusedAtBegin(entry, answered.error, folders)
      tokens = answered.tokens
      refused.push(...answered.refused)
    }

    const results = tokens.length === 0 ? [] : await this.runFiles(entry, folder, files, tokens)
    if (this.left) return
    const cancelled = entry.abort.signal.aborted || results.some((r) => r.outcome === 'cancelled')
    const done = results.filter((r) => r.outcome === 'done')
    const notDone = results.length > done.length
    let held: HeldPaste | undefined
    if (tab !== undefined && done.length > 0 && !cancelled) held = await this.paste(entry.uploadId, tab, false)
    // A file the client gave up on leaves its token live on main (no chunk will come): end it now so
    // the device's place frees and the temp goes, rather than after the idle minute. After the paste,
    // which needs the upload's record. A finished upload ignores it.
    if (notDone && !cancelled) this.cancelOnMain(begun.uploadId)
    this.result(entry, request, folder, results, refused, cancelled, held, tab)
  }

  /** Core's folder chooser for a terminal source; the folder, or undefined for Cancel (or leaving). */
  private choose(entry: Live, tab: string, files: readonly UploadFile[], id: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      entry.dialog = { kind: 'chooser', id }
      const preset = readPreset(this.deps.storage, this.deps.projectId)
      const finish = (folder: string | undefined): void => {
        entry.dialog = undefined
        this.deps.ui.endChooser(id)
        resolve(folder)
      }
      // A leave() ends the dialog through endDialog; the promise then answers undefined below.
      entry.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true })
      this.deps.ui.showChooser({ id, tab, files: files.map((f) => ({ name: f.name, size: f.size })), preset, onAnswer: finish })
    })
  }

  /**
   * The clash dialog, then `uploads.resolve`. A resolve that answers `{error}` (Replace refused, the
   * limits) leaves main's upload waiting for another answer; the controller does not ask again but
   * cancels it, and the notice says why (asking again could loop on a refusal that will not change).
   */
  private async resolveClashes(
    entry: Live,
    folder: string,
    begun: UploadBegun,
    id: string
  ): Promise<{ tokens: UploadFileToken[]; refused: UploadRefusedFile[] } | { error: string } | { cancelled: true }> {
    const choice = await new Promise<UploadChoice>((resolve) => {
      entry.dialog = { kind: 'clash', id }
      entry.abort.signal.addEventListener('abort', () => resolve('cancel'), { once: true })
      this.deps.ui.showClash({
        id,
        folder,
        clashes: begun.clashes,
        onAnswer: (c) => {
          entry.dialog = undefined
          this.deps.ui.endClash(id)
          resolve(c)
        }
      })
    })
    if (this.left) return { cancelled: true }
    if (choice === 'cancel') {
      try {
        await this.deps.invoke('uploads.resolve', { uploadId: begun.uploadId, choice: 'cancel' })
      } catch {
        // Main ends an unanswered upload on its own (UPLOAD_PENDING_MS); nothing was written.
      }
      return { cancelled: true }
    }
    try {
      const reply = await this.deps.invoke('uploads.resolve', { uploadId: begun.uploadId, choice })
      if ('error' in reply) {
        this.cancelOnMain(begun.uploadId)
        return reply
      }
      return reply
    } catch (err) {
      this.cancelOnMain(begun.uploadId)
      return { error: reasonOf(err) }
    }
  }

  /** The run, with its progress notice and Cancel. */
  private async runFiles(entry: Live, folder: string, files: readonly UploadFile[], tokens: readonly UploadFileToken[]): Promise<UploadFileResult[]> {
    const fileCount = tokens.length
    const total = tokens.reduce((sum, t) => sum + (files[t.index]?.size ?? 0), 0)
    const onCancel = (): void => {
      if (entry.abort.signal.aborted) return
      entry.abort.abort()
      if (entry.uploadId !== undefined) this.cancelOnMain(entry.uploadId)
    }
    const progress = (fileNo: number, sent: number): void =>
      this.notice(entry, { kind: 'progress', id: entry.noticeId, folder, fileNo, fileCount, sent, total, onCancel })
    progress(1, 0)
    const run = this.deps.run ?? runUpload
    try {
      return await run(files, tokens, {
        signal: entry.abort.signal,
        onProgress: (p) => progress(Math.max(1, tokens.findIndex((t) => t.index === p.index) + 1), p.sent)
      })
    } catch {
      return tokens.map((t) => ({ index: t.index, name: t.name, outcome: 'failed' as const, reason: RUN_FAILED }))
    }
  }

  /**
   * The automatic paste (`manual` false) or the held notice's Paste path. Answers the hold the notice
   * keeps, or undefined when the text went into the terminal.
   */
  private async paste(uploadId: string | undefined, tab: string, manual: boolean): Promise<HeldPaste | undefined> {
    if (uploadId === undefined) return { reason: PASTE_FAILED_HELD, text: '' }
    // Checked before either call (design §4.3): keys-off is held, and main is not asked at all.
    if (this.deps.keysOff?.(tab) === true) return { reason: KEYS_OFF_HELD, text: '' }
    let reply: UploadPasteReply
    try {
      reply = await this.deps.invoke('uploads.paste', { uploadId, ...(manual ? { manual: true } : {}) })
    } catch (err) {
      return { reason: reasonOf(err), text: '' }
    }
    if ('held' in reply) return { reason: reply.held, text: reply.text }
    if (this.deps.pasteInto?.(tab, reply.text) === true) return undefined
    return { reason: PASTE_FAILED_HELD, text: reply.text }
  }

  /** The result notice from the run's per-file results and main's refusals. */
  private result(
    entry: Live,
    request: ControllerRequest,
    folder: string,
    results: readonly UploadFileResult[],
    refused: readonly UploadRefusedFile[],
    cancelled: boolean,
    held?: HeldPaste,
    tab?: string
  ): void {
    const outcome: UploadOutcome = {
      folder,
      fileCount: request.files.length,
      done: results.filter((r) => r.outcome === 'done').map((r) => r.name),
      failed: [
        ...refused.map((r) => ({ name: request.files[r.index]?.name ?? `file ${r.index + 1}`, reason: r.reason })),
        ...results.filter((r) => r.outcome === 'failed').map((r) => ({ name: r.name, reason: r.reason ?? 'failed' }))
      ],
      ...(cancelled ? { cancelled: true } : {}),
      ...(request.folders && request.folders.length > 0 ? { folders: request.folders } : {})
    }
    const { text, sticky } = resultText(outcome)
    const id = entry.noticeId
    const uploadId = entry.uploadId
    const show = (h: HeldPaste | undefined): void => {
      if (h === undefined || tab === undefined) {
        this.deps.ui.putNotice({ kind: 'result', id, text, sticky })
        return
      }
      this.deps.ui.putNotice({
        kind: 'result',
        id,
        text,
        sticky: true,
        held: h,
        // Paste path: the person's own click, any number of times while the notice lives; main checks
        // again and so does keys-off here. A new hold replaces the shown one; a paste keeps the notice.
        onPaste: () => {
          void this.paste(uploadId, tab, true).then((again) => {
            if (again !== undefined) show(again)
          })
        }
      })
    }
    show(held)
  }

  /** "Nothing uploaded: <reason>", with the skipped folders named too. */
  private refusedAtBegin(entry: Live, reason: string, folders: readonly string[]): void {
    const text = nothingUploadedText(reason) + (folders.length > 0 ? `; ${foldersText(folders)}` : '')
    this.notice(entry, { kind: 'result', id: entry.noticeId, text, sticky: true })
  }

  /** A notice of this upload, unless the page is leaving (nobody would see it). */
  private notice(entry: Live, notice: UploadNotice): void {
    if (this.left || !this.live.has(entry)) return
    this.deps.ui.putNotice(notice)
  }

  private endDialog(entry: Live): void {
    const dialog = entry.dialog
    if (dialog === undefined) return
    entry.dialog = undefined
    if (dialog.kind === 'chooser') this.deps.ui.endChooser(dialog.id)
    else this.deps.ui.endClash(dialog.id)
  }

  /** Best-effort: main's idle clock ends what a lost cancel leaves. */
  private cancelOnMain(uploadId: string): void {
    this.deps.invoke('uploads.cancel', { uploadId }).catch(() => undefined)
  }
}
