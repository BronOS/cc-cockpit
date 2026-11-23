// Uploads from the person's device (design-upload.md revision 2): begin, resolve, cancel, the per-file
// tokens the `/u/` route takes, the limits and the folder chooser's listing. The bytes on disk are the
// writer's (`upload-writer.ts`, behind UploadWriterPort); the gateway routes `/u/` to it and tells this
// about revokes, disconnects, leaving None mode and its stop (`dropDevice`, `dropAll`), and index.ts
// about a window closing (`dropWindow`).
//
// Main is the authority (CLAUDE.md): the caller's device and window are main's (the connection the
// router bound; `none` for every None-mode view, as downloads.ts keys it), and the source (a panel of
// the view's layout, a Claude or shell tab) is resolved by the router before it gets here. The folder
// and the names come from a page and are checked here (design §2: a panel page can build a `File`
// nobody picked, §6):
//   - the folder through `resolveProjectEntry` (lexical, then its real path inside the project), a
//     folder, never `.git` or below (named or real path, case-insensitive on darwin) and never the
//     app's data dir (§2.1);
//   - each name through `checkUploadName`, never `.git` (a gitfile would send git to a gitdir the
//     uploader names), repeats within the upload numbered (`dedupeNames`); a refused name skips that file
//     with its reason, never a quiet rename (§2.2);
//   - the caps (2 GiB a file, 100 files) and the folder's free space (the whole upload plus 1 GiB, less
//     what running uploads have yet to write; again at `resolve`, which may come 10 min later);
//   - every target name `lstat`ed: a clash makes the upload wait for the person's answer (`resolve`),
//     Replace only when every clashing entry is a regular file (§2.3).
//
// States: `pending` (clashes asked, no tokens), `resolving` (an answer's `lstat`s and `statfs` in
// flight), `running` (tokens minted, bytes may come), `finished` (every file committed or failed; kept
// for the terminal entry's paste, §4.3). Only `resolving` and `running` hold one of the device's 2 and the app's 6 places,
// plus a begin still in its checks (counted before its first await, so parallel begins cannot all pass
// the check): an unanswered clash dialog holds none, and `resolve` takes one again or refuses.
//
// Ends (§3.4): the idle clock (UPLOAD_IDLE_MS with no body bytes for the whole upload, one clock per
// upload, `touch` from the writer on bytes read), a cancel, the device's or window's drop and `dropAll`.
// Each aborts through the writer (every temp of the upload deleted, a write in flight ended). A pending
// upload nobody answers ends after UPLOAD_PENDING_MS. A cancel or the idle clock of a running upload with
// files already settled finishes it rather than removing it (the rest settle as cancelled), so its partial
// result still pastes.
//
// The paste (§4.3, `paste`): main writes the text into the tab as the calling view's own input (the path
// its keys take: `typed`, the room draft bit), in the same synchronous step as the checks below, and
// answers it; or holds it with a reason and writes nothing. Checked and written in one step: a check
// answered to the page, which then typed through `tabs.input`, left the reply's way back and the input's
// way in open, and Claude could reach `needs-permission` meanwhile (external review). The page reports
// only whether its terminal is in bracketed-paste mode, so the text is wrapped as xterm's own `paste`
// would wrap it. Only for an upload whose source was a tab, begun by
// the caller's device in the caller's window, finished. The automatic call is taken at most once per
// upload, whatever it answers; Paste path (`manual`) any number of times. Both need the tab alive and
// selected in the calling view (typing would go nowhere else); the automatic one needs a Claude tab
// `waiting` (at the prompt: `idle` is not established, `working` lags a dialog), Paste path any status
// but `needs-permission` (a keystroke could answer the dialog) and `ended`.
//
// Refusal texts reach the view (a guest's too, D-33): project-relative names and fixed reasons only,
// never a host path and never an fs error's own message (ENOENT and EACCES texts carry the absolute
// path). No Electron (the plan's rule).
import { randomBytes } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath, stat, statfs } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { downloadSizeText } from '../../shared/downloads'
import type { TabStatus } from '../../shared/ipc'
import type { TabKind } from '../../shared/types'
import { MAX_NAME_NUMBER } from '../../shared/numbered-name'
import { dataDirRefused } from '../../shared/outside-paths'
import {
  checkUploadName,
  dedupeNames,
  insideGit,
  nameKey,
  numberedUploadName,
  pasteText,
  UPLOAD_BEGINS_MAX,
  UPLOAD_BEGINS_WINDOW_MS,
  UPLOAD_FOLDER_LIST_MAX,
  UPLOAD_FREE_MARGIN_BYTES,
  UPLOAD_IDLE_MS,
  UPLOAD_MAX_APP,
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_MAX_PER_DEVICE,
  UPLOAD_NAME_MAX_BYTES,
  type UploadBeginReply,
  type UploadClash,
  type UploadError,
  type UploadFileToken,
  type UploadFoldersReply,
  type UploadPasteReply,
  type UploadRefusedFile,
  type UploadResolveReply,
  type UploadSource,
} from '../../shared/uploads'
import { displayPath, displayText } from '../plugins/link-request'
import { RateWindow } from '../rate-window'
import { resolveProjectEntry } from './system-files'

/** An upload whose clashes nobody answers ends after this (the dialog is armed and may be read slowly). */
export const UPLOAD_PENDING_MS = 10 * 60_000
/** Finished uploads kept per device for the terminal entry's paste (§4.3: Paste path while the notice lives). */
export const UPLOAD_FINISHED_KEPT = 20

/** Why a file named `.git` is refused (a gitfile, `checkBegin`). */
export const UPLOAD_GIT_NAME_TEXT = 'a file cannot be named .git: git would read it as a pointer to another repository'

/** The same answer for an unknown id, another device's and one already over (§3.1). */
export const UPLOAD_UNKNOWN_TEXT = 'no such upload'

/** A file still live when a partly settled upload is cancelled (`cancel`, §3.4): its outcome. */
export const UPLOAD_CANCELLED_TEXT = 'cancelled'
/** A file's reason when its upload's idle clock ran out after another file had settled (kept for the paste). */
export const UPLOAD_IDLE_TEXT = `no bytes for ${UPLOAD_IDLE_MS / 1000} s`

/** The paste's holds (§4.3): fixed words, shown in the held notice beside Paste path. */
export const UPLOAD_PASTE_AGAIN_TEXT = 'the paths were offered once already: use Paste path'
export const UPLOAD_PASTE_ENDED_TEXT = 'the tab has ended'
export const UPLOAD_PASTE_NOT_SELECTED_TEXT = 'the tab is not the one selected here'
export const UPLOAD_PASTE_NOT_WAITING_TEXT = 'Claude is not waiting for input'
export const UPLOAD_PASTE_PERMISSION_TEXT = 'Claude is asking for a permission'
export const UPLOAD_PASTE_UNSAFE_TEXT = 'the path holds a character that cannot be pasted safely'
export const UPLOAD_PASTE_NO_PATH_TEXT = "the path cannot be given from the tab's folder"
export const UPLOAD_PASTE_NO_INPUT_TEXT = 'the tab takes no input from this view'

/** Bracketed paste's markers, as xterm's own `paste` wraps a paste while the program asked for the mode. */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** The source tab as main's tables have it at the paste (index.ts reads TabManager and the session registry). */
export interface UploadPasteTab {
  kind: TabKind
  /** The tab's starting folder (TabInfo.cwd: absolute, real, inside the project). */
  cwd: string
  /** Its process ended (or a restored tab never started): nothing takes input. */
  exited: boolean
  /** A Claude tab's status (the session registry); undefined for a shell tab, or a Claude tab with no entry. */
  status?: TabStatus
}

/**
 * What the paste rule reads of main's tables at the moment of the call, never of the payload, and the
 * calling view's input path it writes through. `bracketed` alone is the page's word, about its own terminal.
 */
export interface UploadPasteFacts {
  /** The tab now, by id; undefined once it is closed. */
  tab(tabId: string): UploadPasteTab | undefined
  /** The calling view's selected tab (ViewSelections.selectionOf). */
  selected: string | undefined
  /** A guest's text is relative to the tab's starting folder, never a host path (D-33). */
  guest: boolean
  /**
   * The view's terminal is in bracketed-paste mode (`UploadPasteRequest.bracketed`). A wrong word only
   * changes how text this view could type anyway arrives.
   */
  bracketed: boolean
  /**
   * Writes `data` into the tab as the calling view's own keys (the router's `tabs.input` path: the owner's
   * `viewInputHandler`, a write guest's `guestViewInputHandler`), synchronously. False, and nothing
   * written, when this view may not type there now (a guest whose access or scope changed).
   */
  input(tabId: string, data: string): boolean
}

/** Who calls: main's own tables (the router's bound view), never a payload. */
export interface UploadCaller {
  /** The view's signed-in device; `none` for every None-mode view. */
  deviceId: string
  windowId: number
}

/**
 * How a file is committed: `new` (an exclusive link, numbered on a name that appeared since begin),
 * `keep-both` (the same, under the numbered name resolve chose), `replace` (a rename over the regular
 * file that was there).
 */
export type UploadFileChoice = 'new' | 'keep-both' | 'replace'

/** What a token is bound to (design Technical Details): the route and the writer read it, never a request. */
export interface UploadGrant {
  token: string
  uploadId: string
  deviceId: string
  windowId: number
  /** The file's index in the begin request. */
  index: number
  /** The target folder's real path at begin; the commit resolves the folder again and compares. */
  folderReal: string
  /** The folder as named, project-relative (`''` the project folder): the done answer's `path`. */
  folderRel: string
  /** The planned name (after dedupe or Keep both). */
  name: string
  choice: UploadFileChoice
  /** The declared size: no byte past it is written. */
  size: number
}

/** A file's end, from the writer (or the route): committed under `name` at `path`, or failed. */
export type UploadFileOutcome = { ok: true; name: string; path: string } | { ok: false; reason: string }

/** What this needs of the writer (`upload-writer.ts`, whose `UploadWriter` implements it). */
export interface UploadWriterPort {
  /** Every temp of the upload closed and deleted, a write in flight ended; resolves once done. */
  abortUpload(uploadId: string): Promise<void>
}

/** The fields of `fs.statfs` the free-space check reads. */
export interface UploadStatFs {
  bavail: number | bigint
  bsize: number | bigint
}

export interface UploadsDeps {
  /** The project folder of the window's project (the registry's path); undefined when none is open there. */
  projectRoot(windowId: number): string | undefined
  /** The app's data dir (CC_COCKPIT_DATA_DIR or `userData`); realpath'd at each check. */
  dataDir: string
  writer: UploadWriterPort
  /** Default process.platform: darwin compares `.git` case-insensitively. */
  platform?: NodeJS.Platform
  /** Default `fs.statfs`. */
  statfs?: (path: string) => Promise<UploadStatFs>
  /** Default Date.now. */
  now?: () => number
  /** Default crypto.randomBytes. */
  random?: (size: number) => Buffer
  log?: (line: string) => void
}

/** A file of the upload that was not refused at begin. */
interface PlannedFile {
  index: number
  name: string
  size: number
  /** Set when the folder holds an entry by that name at begin. */
  clash?: { replaceable: boolean }
}

interface UploadRecord {
  uploadId: string
  deviceId: string
  windowId: number
  source: UploadSource
  folderRel: string
  folderReal: string
  state: 'pending' | 'resolving' | 'running' | 'finished'
  files: PlannedFile[]
  /** The live tokens (running): removed as each file settles. */
  tokens: Set<string>
  /** Each settled file's outcome, by index. */
  results: Map<number, UploadFileOutcome>
  /** When body bytes were last read (or the tokens minted): the idle clock's start. */
  lastBytes: number
  /** The automatic paste was asked once (§4.3: at most once per upload, whatever it answered). */
  autoPasted?: true
  timer?: ReturnType<typeof setTimeout>
}

/** A begin past its synchronous checks and not answered yet: holds a place; a drop marks it. */
interface BeginInFlight {
  deviceId: string
  windowId: number
  dropped: boolean
}

/** A refusal whose text is safe to show (fixed words and display-safe project-relative names). */
class UploadRefusal extends Error {}

export class Uploads {
  private readonly records = new Map<string, UploadRecord>()
  private readonly grants = new Map<string, UploadGrant>()
  private readonly beginsInFlight = new Set<BeginInFlight>()
  private readonly begins = new RateWindow(UPLOAD_BEGINS_MAX, UPLOAD_BEGINS_WINDOW_MS)
  private readonly platform: NodeJS.Platform
  private readonly now: () => number
  private readonly random: (size: number) => Buffer

  constructor(private readonly deps: UploadsDeps) {
    this.platform = deps.platform ?? process.platform
    this.now = deps.now ?? Date.now
    this.random = deps.random ?? randomBytes
  }

  /**
   * `uploads.begin`: the folder, the names, the caps and the disk checked, the clashes found. Answers
   * the tokens when nothing clashes (the upload runs), the clashes otherwise (it waits for `resolve`),
   * or a refusal of the whole upload. `source` is the router's, already resolved for this view.
   */
  async begin(caller: UploadCaller, source: UploadSource, folder: unknown, files: unknown): Promise<UploadBeginReply> {
    // Counted before any await: a flood of begins is bounded even while each one still checks.
    if (!this.begins.take(caller.deviceId, this.now())) {
      return { error: `at most ${UPLOAD_BEGINS_MAX} uploads may start in ${UPLOAD_BEGINS_WINDOW_MS / 60_000} minutes; try again later` }
    }
    const full = this.limitProblem(caller.deviceId)
    if (full) {
      // Refused before it did anything: a person retrying a drop while two long uploads run must not
      // spend the device's begins and lock it out for the window.
      this.begins.refund(caller.deviceId)
      return { error: full }
    }
    const flight: BeginInFlight = { deviceId: caller.deviceId, windowId: caller.windowId, dropped: false }
    this.beginsInFlight.add(flight)
    try {
      return await this.checkBegin(caller, source, folder, files, flight)
    } catch (err) {
      return { error: err instanceof UploadRefusal ? err.message : 'the upload could not be started' }
    } finally {
      this.beginsInFlight.delete(flight)
    }
  }

  /**
   * `uploads.resolve`: the person's one answer for every clash of a pending upload. `cancel` ends it;
   * `replace` only when every clash is a regular file; `keep-both` numbers each clashing name past what
   * the folder and the upload hold. A refusal (Replace not offered, the limits) leaves it pending.
   */
  async resolve(caller: UploadCaller, uploadId: unknown, choice: unknown): Promise<UploadResolveReply> {
    const record = this.owned(caller, uploadId)
    if (!record || record.state !== 'pending') return { error: UPLOAD_UNKNOWN_TEXT }
    if (choice !== 'replace' && choice !== 'keep-both' && choice !== 'cancel') return { error: 'the answer is not valid' }
    if (choice === 'cancel') {
      await this.end(record, 'cancelled')
      return { tokens: [], refused: [] }
    }
    const clashing = record.files.filter((f) => f.clash)
    if (choice === 'replace' && clashing.some((f) => !f.clash?.replaceable)) {
      return { error: 'Replace is offered only when every name taken is a regular file' }
    }
    const full = this.limitProblem(caller.deviceId)
    if (full) return { error: full }
    // Holds a place from here, and a second answer finds it not pending. The pending timer runs on: a
    // refusal below puts the upload back to pending with its deadline, and `run` replaces the timer.
    record.state = 'resolving'
    // A drop (or the pending deadline) while an await ran ended it (the record is gone): nothing is minted.
    const live = (): boolean => this.records.get(record.uploadId) === record
    const refused: UploadRefusedFile[] = []
    // Keep both's names, applied only when the upload runs: a refusal below leaves the record as the
    // clash dialog showed it (a later Replace must target the names that were asked about).
    const numbered = new Map<number, string>()
    if (choice === 'keep-both') {
      const taken = new Set(record.files.filter((f) => !f.clash).map((f) => nameKey(f.name)))
      for (const file of clashing) {
        const name = await this.freeNumberedName(record.folderReal, file.name, taken)
        if (!live()) return { error: UPLOAD_UNKNOWN_TEXT }
        if (name === null) {
          refused.push({ index: file.index, reason: numberingRefusal(file.name, 'in this folder') })
          continue
        }
        taken.add(nameKey(name))
        numbered.set(file.index, name)
      }
    }
    const refusedIdx = new Set(refused.map((r) => r.index))
    const go = record.files.filter((f) => !refusedIdx.has(f.index))
    if (go.length > 0) {
      // The disk again (§2.5): the answer may come 10 min after begin, and other uploads ran meanwhile.
      // The last await, so the check and the mint below are one synchronous step.
      let free: number
      try {
        free = await this.readFree(record.folderReal)
      } catch (err) {
        if (!live()) return { error: UPLOAD_UNKNOWN_TEXT }
        record.state = 'pending'
        return { error: err instanceof UploadRefusal ? err.message : 'the upload could not be started' }
      }
      if (!live()) return { error: UPLOAD_UNKNOWN_TEXT }
      const problem = this.spaceProblem(free, go.reduce((sum, f) => sum + f.size, 0))
      if (problem) {
        record.state = 'pending'
        return { error: problem }
      }
    }
    const tokens = this.run(
      record,
      go.map((f) => ({
        ...f,
        name: numbered.get(f.index) ?? f.name,
        choice: f.clash ? (choice === 'replace' ? 'replace' : 'keep-both') : 'new',
      }))
    )
    return { tokens, refused }
  }

  /**
   * `uploads.cancel`: ends it and deletes its temps. An unknown or foreign id does nothing, the same answer.
   * A running upload with files already settled is finished instead of removed: its live tokens settle as
   * cancelled and the record keeps its outcomes, so a partial result still pastes (§3.4, §5.3: the shell
   * cancels a run whose client gave up on some files, a dropped link above all, before it asks to paste).
   */
  async cancel(caller: UploadCaller, uploadId: unknown): Promise<void> {
    const record = this.owned(caller, uploadId)
    if (!record || record.state === 'finished') return
    if (record.state === 'running' && record.results.size > 0) return this.finishCancelled(record)
    await this.end(record, 'cancelled')
  }

  /** The route's lookup: the binding of a live token, or undefined (unknown, settled, ended). */
  grant(token: string): UploadGrant | undefined {
    return this.grants.get(token)
  }

  /** The writer, on body bytes read off the socket: the upload's idle clock starts again. A stamp only. */
  touch(uploadId: string): void {
    const record = this.records.get(uploadId)
    if (record?.state === 'running') record.lastBytes = this.now()
  }

  /**
   * A file's end (the writer's commit or failure): its token dies, and once every file of the upload is
   * settled the upload is finished (its place freed, its clock stopped, its outcomes kept for the paste).
   */
  settle(token: string, outcome: UploadFileOutcome): void {
    const grant = this.grants.get(token)
    if (!grant) return
    this.grants.delete(token)
    const record = this.records.get(grant.uploadId)
    if (!record || record.state !== 'running') return
    record.tokens.delete(token)
    record.results.set(grant.index, outcome)
    if (record.tokens.size === 0) this.finish(record)
  }

  /** Test hook: the upload's state and outcomes, when it is the caller's. No production caller (the paste reads the record itself). */
  outcome(caller: UploadCaller, uploadId: unknown): { state: UploadRecord['state']; source: UploadSource; results: ReadonlyMap<number, UploadFileOutcome> } | undefined {
    const record = this.owned(caller, uploadId)
    return record && { state: record.state, source: record.source, results: record.results }
  }

  /**
   * `uploads.paste` (§4.3, the rule in this file's header): `{text}` once it is written into the tab
   * (`facts.input`), or `{held, text}` with the reason and the text the notice keeps (its Paste path and
   * Copy; the shell offers no Copy for unsafe text), nothing written. Synchronous from the lookup to the
   * write, so two calls cannot both take the automatic one and the status checked is the status written to.
   * Throws one answer (UPLOAD_UNKNOWN_TEXT) for an id that is unknown, another device's or window's, from a
   * panel, not finished, or with no file uploaded: nothing to paste, and no way to tell them apart.
   */
  paste(caller: UploadCaller, uploadId: unknown, manual: boolean, facts: UploadPasteFacts): UploadPasteReply {
    const record = this.owned(caller, uploadId)
    if (!record || record.windowId !== caller.windowId || !('tab' in record.source) || record.state !== 'finished') {
      throw new Error(UPLOAD_UNKNOWN_TEXT)
    }
    const tabId = record.source.tab
    // Index order, as the person picked them; the real folder resolved at begin (each commit compared
    // the folder's real path with it again), so the path is where the file is.
    const placed = record.files.flatMap((f) => {
      const out = record.results.get(f.index)
      return out?.ok === true ? [join(record.folderReal, out.name)] : []
    })
    if (placed.length === 0) throw new Error(UPLOAD_UNKNOWN_TEXT)
    const tab = facts.tab(tabId)
    let paths = placed
    if (facts.guest) {
      // Relative to the tab's starting folder, so it is right whichever folder of the project the tab
      // began in (`./x`, `../other/x`). A tab gone has no folder: nothing is said then (no host path).
      if (!tab) return this.held(record, manual, UPLOAD_PASTE_ENDED_TEXT, '')
      const rel = placed.map((path) => relative(tab.cwd, path))
      if (rel.some((r) => r === '' || isAbsolute(r))) return this.held(record, manual, UPLOAD_PASTE_NO_PATH_TEXT, '')
      paths = rel.map((r) => (r === '..' || r.startsWith(`..${sep}`) ? r : `.${sep}${r}`))
    }
    const text = pasteText(paths)
    // A path holding a control, bidi or invisible character is never pasted (§4.3: an ESC [201~ in a
    // folder name would end the bracketed paste early). The plain paths go with the hold for the notice;
    // the shell offers no Copy for them, and Paste path comes back here and is held again.
    if (text === null) return this.held(record, manual, UPLOAD_PASTE_UNSAFE_TEXT, `${paths.join(' ')} `)
    if (!tab || (tab.kind !== 'claude' && tab.kind !== 'shell') || tab.exited || tab.status === 'ended') {
      return this.held(record, manual, UPLOAD_PASTE_ENDED_TEXT, text)
    }
    if (facts.selected !== tabId) return this.held(record, manual, UPLOAD_PASTE_NOT_SELECTED_TEXT, text)
    if (tab.kind === 'claude') {
      // A keystroke could answer a permission prompt: never then, not even on the person's click.
      if (tab.status === 'needs-permission') return this.held(record, manual, UPLOAD_PASTE_PERMISSION_TEXT, text)
      // No entry is no status, so not at the prompt. Paste path takes any other status (the person's own
      // click, as typing would be); the automatic paste only `waiting`.
      if (tab.status === undefined || (!manual && tab.status !== 'waiting')) return this.held(record, manual, UPLOAD_PASTE_NOT_WAITING_TEXT, text)
    }
    if (!manual && record.autoPasted) return { held: UPLOAD_PASTE_AGAIN_TEXT, text }
    // Written now, in this step: nothing can change the status between the check above and the input.
    if (!facts.input(tabId, facts.bracketed ? `${PASTE_START}${text}${PASTE_END}` : text)) {
      return this.held(record, manual, UPLOAD_PASTE_NO_INPUT_TEXT, text)
    }
    if (!manual) record.autoPasted = true
    return { text }
  }

  /**
   * A hold. An automatic one takes the automatic call too (at most once per upload, whatever it answered),
   * and a repeat says so rather than the reason again: after a hold only Paste path pastes.
   */
  private held(record: UploadRecord, manual: boolean, reason: string, text: string): UploadPasteReply {
    if (manual) return { held: reason, text }
    if (record.autoPasted) return { held: UPLOAD_PASTE_AGAIN_TEXT, text }
    record.autoPasted = true
    return { held: reason, text }
  }

  /** The device's revoke or disconnect, a guest's end, leaving None mode (`none`): its uploads end. */
  async dropDevice(deviceId: string): Promise<void> {
    await this.dropWhere((r) => r.deviceId === deviceId)
  }

  /** The window (and so its project) closed: its uploads end. */
  async dropWindow(windowId: number): Promise<void> {
    await this.dropWhere((r) => r.windowId === windowId)
  }

  /** The gateway's stop. */
  async dropAll(): Promise<void> {
    await this.dropWhere(() => true)
  }

  /**
   * The folder chooser's listing (§4.2): the subfolders of `path` (resolved as begin's folder), names only,
   * sorted, at most UPLOAD_FOLDER_LIST_MAX with `more`; `.git` and the data dir left out (they are refused
   * as targets anyway), and links too (a listed link would show a folder twice, or one that is not where
   * it looks; begin still takes a link inside the project by name).
   */
  async folders(windowId: number, path: unknown): Promise<UploadFoldersReply | UploadError> {
    try {
      const root = this.root(windowId)
      const folder = await this.resolveFolder(root, path)
      let entries: Dirent[]
      try {
        entries = await readdir(folder.real, { withFileTypes: true })
      } catch {
        throw new UploadRefusal(`${folder.shown} cannot be read`)
      }
      const dataDir = await this.dataDirReal()
      const darwin = this.platform === 'darwin'
      const names = entries
        .filter((e) => e.isDirectory() && !insideGit(e.name, e.name, darwin))
        .map((e) => e.name)
        .filter((name) => !dataDirRefused(join(folder.real, name), dataDir, this.platform))
        // Code-unit order: the same on every server, whatever its locale (the page may sort for show).
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return { folders: names.slice(0, UPLOAD_FOLDER_LIST_MAX), more: names.length > UPLOAD_FOLDER_LIST_MAX }
    } catch (err) {
      return { error: err instanceof UploadRefusal ? err.message : 'the folder cannot be listed' }
    }
  }

  // -------------------------------------------------------------------------------------------------

  private async checkBegin(
    caller: UploadCaller,
    source: UploadSource,
    folderArg: unknown,
    filesArg: unknown,
    flight: BeginInFlight
  ): Promise<UploadBeginReply> {
    const specs = this.checkSpecs(filesArg)
    const root = this.root(caller.windowId)
    const folder = await this.resolveFolder(root, folderArg)

    const refused: UploadRefusedFile[] = []
    const okSpecs: Array<{ index: number; name: string; size: number }> = []
    const darwin = this.platform === 'darwin'
    specs.forEach((spec, index) => {
      const check = checkUploadName(spec.name)
      if (!check.ok) {
        refused.push({ index, reason: check.reason })
        return
      }
      // checkUploadName is ok only for a string.
      const name = spec.name as string
      // A file named `.git` (`.GIT` too on darwin, whose disk ignores case) is a gitfile: `gitdir: <path>`
      // sends every git command in that folder and below to a gitdir the uploader names, whose `config`
      // (`core.fsmonitor`, `core.hooksPath`) runs code: the reason `.git` is refused as a folder (§2.1).
      if (insideGit(name, name, darwin)) refused.push({ index, reason: UPLOAD_GIT_NAME_TEXT })
      else okSpecs.push({ index, name, size: spec.size })
    })
    const deduped = dedupeNames(okSpecs.map((s) => s.name))
    const planned: PlannedFile[] = []
    okSpecs.forEach((spec, i) => {
      const name = deduped[i]
      if (name === null || name === undefined) {
        refused.push({ index: spec.index, reason: numberingRefusal(spec.name, 'in this upload') })
      } else {
        planned.push({ index: spec.index, name, size: spec.size })
      }
    })

    const files: PlannedFile[] = []
    for (const file of planned) {
      try {
        // lstat: a link at the name is a clash that is not replaceable (Replace never follows one).
        const st = await lstat(join(folder.real, file.name))
        file.clash = { replaceable: st.isFile() }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          refused.push({ index: file.index, reason: `${displayText(file.name)} cannot be checked in ${folder.shown}` })
          continue
        }
      }
      files.push(file)
    }
    // The disk last: its check and the mint below are one synchronous step, so parallel begins cannot
    // both pass against the same free space (each sees what the other's tokens have yet to write).
    const free = files.length > 0 ? await this.readFree(folder.real) : 0
    refused.sort((a, b) => a.index - b.index)
    // A revoke, a disconnect or the window's close while the checks ran: nothing is kept for it.
    if (flight.dropped) throw new UploadRefusal('the upload was ended')
    if (files.length > 0) {
      const problem = this.spaceProblem(free, files.reduce((sum, f) => sum + f.size, 0))
      if (problem) throw new UploadRefusal(problem)
    }

    const uploadId = this.random(16).toString('base64url')
    if (files.length === 0) return { uploadId, refused, clashes: [], tokens: [] }
    const record: UploadRecord = {
      uploadId,
      deviceId: caller.deviceId,
      windowId: caller.windowId,
      source,
      folderRel: folder.rel,
      folderReal: folder.real,
      state: 'pending',
      files,
      tokens: new Set(),
      results: new Map(),
      lastBytes: this.now(),
    }
    this.records.set(uploadId, record)
    const clashes: UploadClash[] = files.filter((f) => f.clash).map((f) => ({ index: f.index, name: f.name, replaceable: f.clash?.replaceable === true }))
    if (clashes.length > 0) {
      record.timer = setTimeout(() => void this.end(record, 'unanswered'), UPLOAD_PENDING_MS)
      record.timer.unref?.()
      return { uploadId, refused, clashes }
    }
    return { uploadId, refused, clashes, tokens: this.run(record, files.map((f) => ({ ...f, choice: 'new' as const }))) }
  }

  /** The request's file list: 1 to UPLOAD_MAX_FILES of `{name, size}`, each size within the cap. */
  private checkSpecs(files: unknown): Array<{ name: unknown; size: number }> {
    if (!Array.isArray(files)) throw new UploadRefusal('the request is not valid')
    if (files.length === 0) throw new UploadRefusal('no files to upload')
    if (files.length > UPLOAD_MAX_FILES) throw new UploadRefusal(`at most ${UPLOAD_MAX_FILES} files per upload`)
    return files.map((f: unknown) => {
      if (typeof f !== 'object' || f === null) throw new UploadRefusal('the request is not valid')
      const { name, size } = f as { name?: unknown; size?: unknown }
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new UploadRefusal('the request is not valid')
      // The whole upload (design §3.1 lists the caps there): the person picks again without it.
      if (size > UPLOAD_MAX_FILE_BYTES) {
        throw new UploadRefusal(`${typeof name === 'string' ? displayText(name) : 'a file'} is larger than ${downloadSizeText(UPLOAD_MAX_FILE_BYTES)}`)
      }
      return { name, size }
    })
  }

  /** A begin, or a resolve's mint, would pass the device's or the app's places: why, or null. */
  private limitProblem(deviceId: string): string | null {
    let device = 0
    let app = 0
    for (const r of this.records.values()) {
      if (r.state !== 'resolving' && r.state !== 'running') continue
      app++
      if (r.deviceId === deviceId) device++
    }
    for (const b of this.beginsInFlight) {
      app++
      if (b.deviceId === deviceId) device++
    }
    if (device >= UPLOAD_MAX_PER_DEVICE) return `${UPLOAD_MAX_PER_DEVICE} uploads are already running from this device; wait for one to finish`
    if (app >= UPLOAD_MAX_APP) return `the server is already running ${UPLOAD_MAX_APP} uploads; try again shortly`
    return null
  }

  private root(windowId: number): string {
    const root = this.deps.projectRoot(windowId)
    if (!root) throw new UploadRefusal('the project is not open')
    return root
  }

  /**
   * A page's folder resolved inside the project (§2.1): a folder, not `.git` or below (the named and the
   * real path, case-insensitive on darwin), not the data dir. `shown` is display-safe and project-relative.
   */
  private async resolveFolder(root: string, path: unknown): Promise<{ rel: string; real: string; shown: string }> {
    let entry: Awaited<ReturnType<typeof resolveProjectEntry>>
    try {
      entry = await resolveProjectEntry(root, path, true)
    } catch (err) {
      // resolveProjectEntry's own texts name the relative path only (it catches the fs errors itself).
      throw new UploadRefusal(displayText(err instanceof Error ? err.message : 'the folder cannot be used'))
    }
    const shown = entry.rel === '' ? 'the project folder' : displayPath(entry.rel)
    let isDir: boolean
    try {
      isDir = (await stat(entry.real)).isDirectory()
    } catch {
      throw new UploadRefusal(`no such folder: ${shown}`)
    }
    if (!isDir) throw new UploadRefusal(`${shown} is not a folder`)
    const realRel = relative(entry.root, entry.real).split(sep).join('/')
    if (insideGit(entry.rel, realRel, this.platform === 'darwin')) {
      throw new UploadRefusal(`${shown} is in .git: files there can run code on the next git command`)
    }
    const dataDir = await this.dataDirReal()
    if (dataDirRefused(entry.real, dataDir, this.platform) || dataDirRefused(entry.target, dataDir, this.platform)) {
      throw new UploadRefusal(`${shown} is in the app's data folder`)
    }
    return { rel: entry.rel, real: entry.real, shown }
  }

  /** The data dir's realpath; its spelling as given when it cannot be resolved (as downloads.ts). */
  private async dataDirReal(): Promise<string> {
    try {
      return await realpath(this.deps.dataDir)
    } catch {
      return resolve(this.deps.dataDir)
    }
  }

  /** The folder's free bytes (`statfs`); a fixed refusal when they cannot be read (its error names the path). */
  private async readFree(folderReal: string): Promise<number> {
    try {
      const st = await (this.deps.statfs ?? statfs)(folderReal)
      return Number(st.bavail) * Number(st.bsize)
    } catch {
      throw new UploadRefusal("the server's free disk space cannot be read")
    }
  }

  /**
   * Why `total` more bytes would take the disk under the margin, or null. The declared sizes of the
   * running uploads' live files count as written already (§2.5: "disk fill is bounded" must hold for 6
   * at once, not for each alone); the bytes such a file has written count twice (once in `free`), an
   * overestimate, never an under. Every running upload counts, whatever disk it writes to: a project
   * spread over two devices is rare, and erring this way only refuses early. A pending upload holds no
   * bytes, as it holds no place: `resolve` checks again.
   */
  private spaceProblem(free: number, total: number): string | null {
    let unwritten = 0
    for (const r of this.records.values()) {
      if (r.state !== 'running') continue
      for (const token of r.tokens) unwritten += this.grants.get(token)?.size ?? 0
    }
    const available = Math.max(0, free - unwritten)
    if (available >= total + UPLOAD_FREE_MARGIN_BYTES) return null
    const beside = unwritten > 0 ? ' beside the uploads running' : ''
    return `the server's disk has ${downloadSizeText(available)} free${beside}; this upload needs ${downloadSizeText(total)} plus ${downloadSizeText(UPLOAD_FREE_MARGIN_BYTES)} to spare`
  }

  /**
   * Keep both's name for `name`: the first ` (n)` the folder has no entry for (`lstat`, so a dangling
   * link counts as taken) and no other file of the upload takes; null past 99 or the name limit.
   */
  private async freeNumberedName(folderReal: string, name: string, taken: ReadonlySet<string>): Promise<string | null> {
    for (let n = 1; n <= MAX_NAME_NUMBER; n++) {
      const candidate = numberedUploadName(name, n)
      if (candidate === null) return null
      if (taken.has(nameKey(candidate))) continue
      try {
        await lstat(join(folderReal, candidate))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return candidate
      }
    }
    return null
  }

  /** Tokens minted for `files` (32 random bytes each, bound as UploadGrant); the upload runs, its clock starts. */
  private run(record: UploadRecord, files: Array<PlannedFile & { choice: UploadFileChoice }>): UploadFileToken[] {
    const tokens = files.map((f) => {
      const token = this.random(32).toString('base64url')
      this.grants.set(token, {
        token,
        uploadId: record.uploadId,
        deviceId: record.deviceId,
        windowId: record.windowId,
        index: f.index,
        folderReal: record.folderReal,
        folderRel: record.folderRel,
        name: f.name,
        choice: f.choice,
        size: f.size,
      })
      record.tokens.add(token)
      return { index: f.index, token, name: f.name }
    })
    if (tokens.length === 0) {
      this.finish(record)
      return tokens
    }
    record.state = 'running'
    record.lastBytes = this.now()
    this.armIdle(record, UPLOAD_IDLE_MS)
    return tokens
  }

  /**
   * One lazy timer per upload: `touch` only stamps `lastBytes`, and the timer, when it fires, re-arms for
   * what is left of the window or ends the upload. So a 100-file upload whose later tokens wait while
   * earlier files stream is never expired, and silence is.
   */
  private armIdle(record: UploadRecord, ms: number): void {
    this.clearTimer(record)
    record.timer = setTimeout(() => {
      record.timer = undefined
      if (this.records.get(record.uploadId) !== record || record.state !== 'running') return
      const left = record.lastBytes + UPLOAD_IDLE_MS - this.now()
      if (left > 0) this.armIdle(record, left)
      // A file already settled (a link that dropped for good after it: the client's own cancel and paste could
      // not reach main) is finished like a cancel, so its path still pastes; nothing settled: the record goes.
      else if (record.results.size > 0) {
        this.deps.log?.(`upload ${record.uploadId.slice(0, 8)}: no bytes for ${UPLOAD_IDLE_MS / 1000} s, ended`)
        void this.finishCancelled(record, UPLOAD_IDLE_TEXT)
      } else void this.end(record, 'idle')
    }, ms)
    record.timer.unref?.()
  }

  private clearTimer(record: UploadRecord): void {
    if (record.timer !== undefined) clearTimeout(record.timer)
    record.timer = undefined
  }

  private finish(record: UploadRecord): void {
    this.clearTimer(record)
    record.state = 'finished'
    record.tokens.clear()
    // The oldest finished uploads of the device go once past UPLOAD_FINISHED_KEPT (Map order is insertion).
    const finished = [...this.records.values()].filter((r) => r.deviceId === record.deviceId && r.state === 'finished')
    for (const old of finished.slice(0, Math.max(0, finished.length - UPLOAD_FINISHED_KEPT))) this.records.delete(old.uploadId)
  }

  /** Ends a live upload: its tokens die at once (no chunk is taken after this), then the writer deletes its temps. */
  private async end(record: UploadRecord, why: 'cancelled' | 'idle' | 'unanswered' | 'dropped'): Promise<void> {
    if (this.records.get(record.uploadId) !== record) return
    this.records.delete(record.uploadId)
    this.clearTimer(record)
    for (const token of record.tokens) this.grants.delete(token)
    record.tokens.clear()
    // Only a running upload has tokens, and so temps: a pending or finished one has nothing on disk.
    const hadTokens = record.state === 'running'
    record.state = 'finished'
    if (why === 'idle') this.deps.log?.(`upload ${record.uploadId.slice(0, 8)}: no bytes for ${UPLOAD_IDLE_MS / 1000} s, ended`)
    if (!hadTokens) return
    await this.abortTemps(record)
  }

  /**
   * A cancel (or the idle clock) of a running upload with some files settled: every live token dies and its
   * file settles as cancelled (`reason`), and the upload is finished (place freed, clock stopped, outcomes kept), all in this one
   * synchronous step, so a paste that follows finds it finished; then the writer deletes the live temps.
   * A commit the abort comes too late for still places its file (the writer's rule), but its settle finds
   * no grant, so its outcome stays cancelled, as the person's own view says.
   */
  private async finishCancelled(record: UploadRecord, reason = UPLOAD_CANCELLED_TEXT): Promise<void> {
    for (const token of record.tokens) {
      const grant = this.grants.get(token)
      this.grants.delete(token)
      if (grant) record.results.set(grant.index, { ok: false, reason })
    }
    this.finish(record)
    await this.abortTemps(record)
  }

  /** The writer deletes the upload's temps (`end`, `finishCancelled`). */
  private async abortTemps(record: UploadRecord): Promise<void> {
    // Never rejects: the idle and pending timers reach this with `void` (main has no unhandledRejection
    // handler), and one failed abort must not reject a drop's Promise.all (the gateway's revoke or stop).
    // The record is already gone or finished, so a log line is all that is left to do.
    try {
      await this.deps.writer.abortUpload(record.uploadId)
    } catch (err) {
      this.deps.log?.(`upload ${record.uploadId.slice(0, 8)}: its temps could not all be deleted: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async dropWhere(match: (r: { deviceId: string; windowId: number }) => boolean): Promise<void> {
    for (const b of this.beginsInFlight) if (match(b)) b.dropped = true
    const ends = [...this.records.values()].filter(match).map((r) => this.end(r, 'dropped'))
    await Promise.all(ends)
  }

  /** The record when it exists and the caller's device began it; otherwise undefined, the same for both. */
  private owned(caller: UploadCaller, uploadId: unknown): UploadRecord | undefined {
    if (typeof uploadId !== 'string') return undefined
    const record = this.records.get(uploadId)
    return record && record.deviceId === caller.deviceId ? record : undefined
  }
}

/**
 * Why a name got no number (a `null` from `dedupeNames`, Keep both or the commit's numbering, which all
 * stop at the first candidate `numberedUploadName` refuses): the name limit when ` (99)` does not fit
 * (a 251-byte name fits ` (1)` to ` (9)`, not ` (10)`), else every number to 99 is taken `where`.
 */
export function numberingRefusal(name: string, where: string): string {
  return numberedUploadName(name, MAX_NAME_NUMBER) === null
    ? `${displayText(name)} is too long to number (a name is at most ${UPLOAD_NAME_MAX_BYTES} bytes)`
    : `no free name for ${displayText(name)} ${where} (up to (${MAX_NAME_NUMBER}))`
}

