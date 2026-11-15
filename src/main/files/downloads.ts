// Downloads to the person's device (design-download.md revision 3): which paths may go, the one-use
// tokens a view's `/d/<token>` link carries, and the live responses. The gateway only routes `/d/` here
// (`serve`) and tells this about revokes, disconnects, leaving None mode and its own stop (`dropDevice`,
// `dropAll`); HostApi (`ctx.files.download`) and the CLI (`ccc download`, through an offer) call `start`.
//
// Main is the authority (CLAUDE.md): the view, its window and its device come from main's own tables
// (HostApi's origin view, the accepting connection), never from a payload, and the path is resolved and
// checked twice, at the start and again at the GET (what is served is what the path holds then):
//   - inside the project through `resolveProjectEntry` (lexical check, then the whole path and its parent
//     realpath'd inside): a link downloads its target's bytes under the link's name; dot files go (`.env`:
//     a download reaches only the owner's signed-in devices, and the person chose it);
//   - outside the project (`ccc download` only; a plugin's relative path can never get there) unless the
//     outside rule (`shared/outside-paths.ts`) refuses the named path or its real path (a `/tmp` link to
//     `~/.ssh/id_ed25519` is refused by its target);
//   - never the app's data dir (`secret.key`, the device records), inside a project as much as outside;
//     never `/` or the home itself as a zip's root; regular files and folders only.
// A folder is counted before a view gets anything (`countFolder`: the caps, 10 s) and zipped while it
// streams (`zipEntries` over `walkFolder`, which enforce the caps again and skip what changed).
//
// Tokens: 32 random bytes base64url, in memory only, DOWNLOAD_TOKEN_MS, bound to the device, view and
// window, the target as named, the kind and the include choice. A refusal at the GET keeps the token
// live for a retry within its life; it is consumed only as the 200 headers go out, and only once (the
// check and the delete sit in one synchronous step after every await, so two GETs racing cannot both
// get it).
//
// Live responses (design §3.1 "Live streams"): device → its responses, destroyed by `dropDevice` (the
// gateway's revoke and `disconnectDevice`; the `none` device when None mode ends) and `dropAll` (the
// gateway's stop). A stream outlives its view (a reconnect mints a new view id, and the bytes are already
// the device's). Limits: DOWNLOAD_STREAMS_PER_DEVICE at once per device, DOWNLOAD_ZIPS_MAX zips app-wide.
//
// Offers (`ccc download`, design §2.2): Claude's tab names the window, not the device the person is
// at, so the offer goes to every browser view of the window through a SharedAsks (one payload per
// window, replayed in `ready`, first answer wins, `downloads.settled` to the others). In server mode it
// is held while no browser is attached (`hold`: a phone's socket drops while it sleeps); on a desktop
// with no browser view it is refused (the file is already where the person is). Download in a view's
// dialog is `accept`: the view, its window and its device are the connection's (the router's caller),
// the offer is settled for every view, the target re-walked with the include choice and the Files
// path's `start` run for that view alone. An accepted offer stays for its remaining life, bound to the
// accepting device, so the failure notice's Try again is `accept` again from that device only. Limits
// per window (a window token has no tab id to key on): DOWNLOAD_OFFERS_WAITING_MAX waiting, and
// DOWNLOAD_OFFERS_MAX per DOWNLOAD_OFFERS_WINDOW_MS. Claude is never told the answer.
//
// No Electron (the plan's rule): the views are reached through hooks (index.ts posts through the
// ViewRegistry), the response is anything with `writeHead` that is Writable (http's ServerResponse).
import { randomBytes } from 'node:crypto'
import { realpathSync, type Stats } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DOWNLOAD_OFFER_MS,
  DOWNLOAD_OFFERS_MAX,
  DOWNLOAD_OFFERS_WAITING_MAX,
  DOWNLOAD_OFFERS_WINDOW_MS,
  DOWNLOAD_STREAMS_PER_DEVICE,
  DOWNLOAD_TOKEN_MS,
  DOWNLOAD_ZIP_MAX_BYTES,
  DOWNLOAD_ZIP_MAX_ENTRIES,
  DOWNLOAD_ZIPS_MAX,
  downloadName,
  downloadSizeText,
  type DownloadFailed,
  type DownloadKind,
  type DownloadOffer,
  type DownloadSkipped,
  type DownloadStart,
} from '../../shared/downloads'
import { errorText } from '../../shared/error-text'
import { runnableByName } from '../../shared/runnable-files'
import { SharedAsks } from '../asks/shared-asks'
import { dataDirRefused, downloadRootRefused, outsideRefused, type OutsideEnv } from '../../shared/outside-paths'
import { isRemoteViewId, type ViewId } from '../../shared/views'
import { within } from '../path-within'
import { displayPath } from '../plugins/link-request'
import { MAX_OPEN_PATH_LENGTH } from '../sessions/open-file'
import { openVerified, verifiedProblemText } from '../verified-read'
import { countFolder, walkFolder, zipRootName, type FolderCount, type WalkFs } from './folder-walk'
import { resolveProjectEntry } from './system-files'
import { zipEntries, ZipCapError, ZIP_CHUNK_BYTES } from './zip-writer'

/** HostApi's answer with no origin view (a timer, a plugin command, the 10 s lapse): the plugin shows it. */
export const DOWNLOAD_NO_ORIGIN_TEXT = 'a download needs a click in a browser view'
/** The local desktop page has no Download (design §3.4): the file is already where the person is. */
export const DOWNLOAD_DESKTOP_TEXT = 'the file is already on this computer'

/** The view a download goes to: all three from main's own tables (the origin view, the accepting connection). */
export interface DownloadView {
  viewId: ViewId
  windowId: number
  /** The view's signed-in device (`none` in None mode): the GET's cookie must name the same one. */
  deviceId: string
}

/**
 * What to download, as named. `rel`: a plugin's project-relative path (`''` the project folder); never
 * outside the project. `abs`: `ccc download`'s path, made absolute against the CLI's cwd; inside the
 * project it is the plugin's rules, outside it the outside rule's.
 */
export type DownloadTarget = { projectId: string; rel: string } | { projectId: string; abs: string }

/** A target resolved and checked: what would be sent, and what an offer's dialog shows. */
export interface ResolvedDownload {
  kind: DownloadKind
  /** The full path as named (`<real parent>/<name>` inside the project, the CLI's path outside it). */
  named: string
  /** The whole path realpath'd: what is read (a file) or walked (a folder's root). */
  real: string
  outside: boolean
  /** `downloadName` of what is sent: the named entry's name (a link's, not its target's), `.zip` added for a folder. */
  name: string
  /** A folder's zip root name (`zipRootName` of the named folder's name). */
  rootName: string
  /** A file's size at the check (fstat on its verified descriptor). */
  size?: number
}

export interface DownloadsHooks {
  /** `downloads.start` to that one view (ViewRegistry.toView); false when it is gone. */
  start(viewId: ViewId, payload: DownloadStart): boolean
  /** `downloads.failed` to that one view: a GET refused, a stream cut (the browser's own list says only "Failed"). */
  failed(viewId: ViewId, payload: DownloadFailed): void
}

/** How an offer reaches the window's browser views (index.ts: ViewRegistry.toBrowserViews). */
export interface DownloadOfferHooks {
  /** `downloads.offer` to every browser view of the window, never the desktop or hidden page; false when none took it. */
  send(windowId: number, offer: DownloadOffer): boolean
  /** `downloads.settled` to every browser view of the window: the offer was answered or ran out. */
  settled(windowId: number, requestId: string): void
}

/** An offer's content without its id (SharedAsks adds it): distributed over the file and folder shapes. */
type OfferInfo = DownloadOffer extends infer T ? (T extends unknown ? Omit<T, 'requestId'> : never) : never

/** What `ccc download` gets back (exit 0): the line it prints. */
export interface OfferResult {
  requestId: string
  text: string
  /** No browser view took it now (server mode only: held for one to join). */
  waiting: boolean
}

interface OfferRecord {
  windowId: number
  target: { projectId: string; abs: string }
  expiresAt: number
  /** The device whose view accepted it: the only one a Try again is taken from. */
  acceptedBy?: string
  /**
   * A failure was told to the accepting view (a start refused, a GET refused, a stream cut): only then
   * is a click a Try again. Two tabs of one browser share a device (a cookie), so the device alone
   * cannot tell the second tab's Download click (first answer wins) from a Try again.
   */
  retryable?: boolean
}

export interface DownloadsDeps {
  hooks: DownloadsHooks
  /** `ccc download`'s offers. Absent: `offer` refuses (tests of the Files path only). */
  offers?: DownloadOfferHooks
  /** Main's server-mode flag: offers are held while no browser is attached, never refused for it. */
  server?: boolean
  /** Whether a browser view shows the window now (the desktop's "this project is on this computer"). */
  hasBrowserView?(windowId: number): boolean
  /** The project's folder (the registry's real path). */
  projectPath(projectId: string): string | undefined
  /** The window open for the project now (WindowManager.windowIdOf). */
  windowOf(projectId: string): number | undefined
  /** The app's data dir (CC_COCKPIT_DATA_DIR or `userData`); realpath'd at each check. */
  dataDir: string
  /** Default: the person's home and process.platform. */
  env?: OutsideEnv
  log?: (line: string) => void
  /** Tests only. */
  now?: () => number
  walkFs?: WalkFs
  walkTimeoutMs?: number
  maxBytes?: number
  maxEntries?: number
  offerTimeoutMs?: number
}

/** A response the download is written to: http's ServerResponse, or a test's Writable. */
export type DownloadResponse = Writable & {
  writeHead(status: number, headers: Record<string, string>): unknown
}

/** What `serve` did, for the gateway's answer and its access log line. */
export type ServeResult =
  /** Nothing was written: the gateway answers 204 with no body (the token's view was told why, when there is one). */
  | { status: 'refused'; reason: string }
  /**
   * The 200 went out. `completed`: every byte was written and the response ended; otherwise it was cut
   * (`cut`: `failed` a read error or a cap, `closed` the browser went away, `dropped` main ended it).
   */
  | { status: 'sent'; deviceId: string; name: string; bytes: number; completed: true }
  | { status: 'sent'; deviceId: string; name: string; bytes: number; completed: false; cut: 'failed' | 'closed' | 'dropped' }

interface Token {
  view: DownloadView
  target: DownloadTarget
  kind: DownloadKind
  includeAll: boolean
  requestId: string
  expiresAt: number
}

interface Live {
  deviceId: string
  kind: DownloadKind
  controller: AbortController
  res: DownloadResponse
  /** Settles once the stream is over and out of `live` (its file closed): what `dropAll` waits for. */
  ended: Promise<void>
}

/** Why main ended a live response itself (a revoke, a disconnect, the gateway's stop). */
class Dropped extends Error {
  constructor() {
    super('the download was ended by the server')
    this.name = 'Dropped'
  }
}

/** The response closed before it finished (the browser's Cancel, a closed tab): the walk is aborted with this. */
class BrowserClosed extends Error {
  constructor() {
    super('the browser went away')
    this.name = 'BrowserClosed'
  }
}

export class Downloads {
  private readonly tokens = new Map<string, Token>()
  private readonly live = new Set<Live>()
  private readonly now: () => number
  private readonly env: OutsideEnv
  private readonly offerMs: number
  private readonly offerAsks: SharedAsks<OfferInfo, 'accepted' | 'declined'>
  /** Every offer not over yet: waiting (in offerAsks) or accepted (until its life ends). */
  private readonly offers = new Map<string, OfferRecord>()
  /** Per window, when its recent offers were made (the 10 per 10 min limit). */
  private readonly offerTimes = new Map<number, number[]>()
  /** The last offerAsks send: its id and whether a view took it (read right after `ask`, which sends synchronously). */
  private lastOfferSend: { requestId: string; sent: boolean; threw?: true } | undefined
  /** Per window, offers past the first limit check and not yet asked (parallel calls must not all pass it). */
  private readonly offersInFlight = new Map<number, number>()

  constructor(private readonly deps: DownloadsDeps) {
    this.now = deps.now ?? Date.now
    this.env = deps.env ?? { home: homedir(), platform: process.platform }
    this.offerMs = deps.offerTimeoutMs ?? DOWNLOAD_OFFER_MS
    this.offerAsks = new SharedAsks<OfferInfo, 'accepted' | 'declined'>({
      hooks: {
        send: (windowId, info) => {
          // SharedAsks adds the id to the content, so the payload is exactly a DownloadOffer.
          try {
            const sent = this.deps.offers?.send(windowId, info as DownloadOffer) === true
            this.lastOfferSend = { requestId: info.requestId, sent }
            return sent
          } catch (err) {
            // SharedAsks settles the ask on a throw; offer() must not call that "on this computer".
            this.lastOfferSend = { requestId: info.requestId, sent: false, threw: true }
            throw err
          }
        },
        settled: (windowId, requestId) => this.deps.offers?.settled(windowId, requestId)
      },
      prefix: 'offer',
      refused: 'declined',
      timeoutMs: this.offerMs,
      // Only in server mode (design §2.2): on a desktop an offer nobody can see now is refused instead.
      hold: deps.server === true
    })
  }

  /**
   * `ccc download <abs>` from a tab of the project (`caller`: the token's project and its open window,
   * main's own tables): the path resolved and checked, a folder counted (both totals), then the offer to
   * every browser view of the window. Answers at once, never waits for the click; throws with the exit-1
   * text for a refused path, too large, the desktop with no browser view, and the limits.
   */
  async offer(caller: { projectId: string; windowId: number }, abs: string, peerGone?: AbortSignal): Promise<OfferResult> {
    if (!this.deps.offers) throw new Error('downloads are not available')
    const windowId = caller.windowId
    this.sweepOffers()
    // Checked before the walk too, so a flood of offers never costs a walk each. In-flight offers count
    // as taken places: N parallel calls would otherwise all pass this check and each walk for up to 10 s.
    const limit = this.offerLimitProblem(windowId, this.offersInFlight.get(windowId) ?? 0)
    if (limit) throw new Error(limit)
    this.offersInFlight.set(windowId, (this.offersInFlight.get(windowId) ?? 0) + 1)
    try {
      return await this.offerChecked(caller, abs, peerGone)
    } finally {
      const left = (this.offersInFlight.get(windowId) ?? 1) - 1
      if (left > 0) this.offersInFlight.set(windowId, left)
      else this.offersInFlight.delete(windowId)
    }
  }

  private async offerChecked(
    caller: { projectId: string; windowId: number },
    abs: string,
    peerGone: AbortSignal | undefined
  ): Promise<OfferResult> {
    const windowId = caller.windowId
    const target = { projectId: caller.projectId, abs }
    const resolved = await this.resolve(target, windowId)
    const server = this.deps.server === true
    const onThisComputer = `this project is on this computer: ${displayPath(resolved.named)}`
    if (!server && this.deps.hasBrowserView?.(windowId) !== true) throw new Error(onThisComputer)
    const common = {
      path: resolved.named,
      ...(resolved.real !== resolved.named ? { real: resolved.real } : {}),
      name: resolved.name,
      outside: resolved.outside,
      runnable: runnableByName(resolved.name) !== null
    }
    let info: OfferInfo
    if (resolved.kind === 'folder') {
      const count = await this.countChecked(resolved, displayPath(resolved.named))
      info = {
        ...common,
        kind: 'folder',
        counts: { plain: { ...count.plain }, all: { ...count.all } },
        ...(count.allOver !== undefined ? { allTooLarge: true as const } : {}),
        skipped: { ...count.skipped.plain }
      }
    } else {
      info = { ...common, kind: 'file', size: resolved.size ?? 0 }
    }
    // Again after the awaits (own place excluded: it is counted in flight): two offers counted at once
    // must not both pass a limit of one left.
    const late = this.offerLimitProblem(windowId, (this.offersInFlight.get(windowId) ?? 1) - 1)
    if (late) throw new Error(late)
    // The caller timed out or left during the walk: Claude was told the app did not answer, so no offer.
    if (peerGone?.aborted) throw new Error('the caller went away')
    // The window may have closed during the awaits (windowClosed has run): an ask now would wait for nobody.
    if (this.deps.windowOf(caller.projectId) !== windowId) throw new Error('the project window is gone')

    this.lastOfferSend = undefined
    const answered = this.offerAsks.ask(windowId, info)
    const send = this.lastOfferSend as { requestId: string; sent: boolean; threw?: true } | undefined
    // Not sent and not held: SharedAsks settled it already. On a desktop that is the last browser view
    // leaving between the check above and the send: the desktop case after all.
    if (send?.threw) throw new Error('the offer could not be sent to the browser views')
    if (send === undefined || !this.offerAsks.isPending(windowId, send.requestId)) throw new Error(onThisComputer)
    const id = send.requestId
    this.offers.set(id, { windowId, target, expiresAt: this.now() + this.offerMs })
    this.offerTimes.set(windowId, [...this.recentOffers(windowId), this.now()])
    void answered.then((answer) => {
      // Declined, run out, window closed: over. Accepted: kept for a Try again until its life ends.
      if (answer === 'declined') this.offers.delete(id)
    })
    const what = `${resolved.name} (${offerSizeText(info)})`
    const text = send.sent
      ? `offered ${what} to the browser views of this project; the person decides`
      : `offered ${what}; no browser shows this project now; the offer waits ${Math.round(this.offerMs / 60_000)} min`
    return { requestId: id, text, waiting: !send.sent }
  }

  /**
   * Download in a view's dialog (`downloads.accept`, `adapted`): `view` is the connection's (the
   * router's caller and main's device table), never the payload's. Taken only from a browser view of
   * the offer's window: a waiting offer is settled for every view and started for this one; an accepted
   * one is a Try again, taken only from the accepting device within the offer's life. A start that
   * fails tells this view (`downloads.failed`, the notice with Try again). False when refused or failed.
   */
  async accept(view: DownloadView, requestId: string, all: boolean): Promise<boolean> {
    if (!isRemoteViewId(view.viewId)) return false
    this.sweepOffers()
    const record = this.offers.get(requestId)
    if (!record || record.windowId !== view.windowId) return false
    if (this.offerAsks.isPending(view.windowId, requestId)) {
      // Recorded before the answer settles it, so the ask's `then` sees an accepted offer.
      record.acceptedBy = view.deviceId
      if (!this.offerAsks.answer(view.windowId, requestId, 'accepted')) return false
    } else if (record.acceptedBy === undefined || record.acceptedBy !== view.deviceId || record.retryable !== true) {
      return false
    }
    record.retryable = false
    try {
      await this.start(view, record.target, all === true, requestId)
      return true
    } catch (err) {
      this.tellFailed(view.viewId, { requestId, reason: errorText(err) })
      return false
    }
  }

  /** `downloads.failed` to the view, and its offer (when it has one) may be tried again. */
  private tellFailed(viewId: ViewId, payload: DownloadFailed): void {
    const record = this.offers.get(payload.requestId)
    if (record) record.retryable = true
    this.deps.hooks.failed(viewId, payload)
  }

  /** Cancel in a view's dialog (`downloads.answer`): settles a waiting offer for every view of the window. */
  decline(windowId: number, requestId: string): boolean {
    return this.offerAsks.answer(windowId, requestId, 'declined')
  }

  /** The offers still waiting in the window, oldest first (`ready`'s `downloadOffers`). Copies. */
  pendingOffers(windowId: number): DownloadOffer[] {
    return this.offerAsks.pendingFor(windowId) as DownloadOffer[]
  }

  /** The window closed: its waiting offers end (settled for every view), its accepted ones with them. */
  windowClosed(windowId: number): void {
    this.offerAsks.windowClosed(windowId)
    for (const [id, record] of this.offers) if (record.windowId === windowId) this.offers.delete(id)
    this.offerTimes.delete(windowId)
  }

  /** Offers not over yet, waiting or accepted (tests). */
  get offerCount(): number {
    this.sweepOffers()
    return this.offers.size
  }

  /**
   * A download for `view`: the target resolved and checked, a folder counted (the caps, 10 s), a token
   * minted for that view and `downloads.start` sent to it alone. Throws with the text the plugin shows
   * and the CLI prints (exit 1) for every refusal; nothing is sent then. `requestId`: an accepted offer's
   * (the failure notice's Try again names it), else a new one.
   */
  async start(
    view: DownloadView,
    target: DownloadTarget,
    includeAll: boolean,
    requestId: string = `download-${randomBytes(8).toString('hex')}`,
  ): Promise<{ requestId: string; name: string; kind: DownloadKind }> {
    // The desktop page and server mode's hidden page never get a link (design §3.4, §4).
    if (!isRemoteViewId(view.viewId)) throw new Error(DOWNLOAD_DESKTOP_TEXT)
    const resolved = await this.resolve(target, view.windowId)
    if (resolved.kind === 'folder') await this.checkCount(resolved, target, includeAll)
    this.sweep()
    const token = randomBytes(32).toString('base64url')
    this.tokens.set(token, {
      view: { ...view },
      target: { ...target },
      kind: resolved.kind,
      includeAll: resolved.kind === 'folder' && includeAll,
      requestId,
      expiresAt: this.now() + DOWNLOAD_TOKEN_MS,
    })
    if (!this.deps.hooks.start(view.viewId, { requestId, url: `/d/${token}`, name: resolved.name })) {
      this.tokens.delete(token)
      throw new Error('the browser view is gone')
    }
    return { requestId, name: resolved.name, kind: resolved.kind }
  }

  /**
   * `target` resolved and checked against every rule (see the header), or a throw with the text to show.
   * `windowId`: the window the caller is bound to; the project must still be open in it.
   */
  async resolve(target: DownloadTarget, windowId: number): Promise<ResolvedDownload> {
    if (this.deps.windowOf(target.projectId) !== windowId) throw new Error('the project window is gone')
    const projectDir = this.deps.projectPath(target.projectId)
    if (projectDir === undefined) throw new Error('the project is gone')
    const where = 'rel' in target ? await this.inside(projectDir, target.rel) : await this.named(projectDir, target.abs)
    const shown = where.shown
    const { named, real, outside } = where
    if (outside && this.outsideRefused(named, real)) {
      throw new Error(`${shown} cannot be downloaded: it is in a protected place (a hidden folder of the home, /proc, /sys, /dev or /run)`)
    }
    if (dataDirRefused(real, await this.dataDirReal(), this.env.platform)) {
      throw new Error(`${shown} cannot be downloaded: it is in the app's data folder`)
    }
    let st: Stats
    try {
      st = await stat(real)
    } catch {
      throw new Error(`no such file or folder: ${shown}`)
    }
    const entryName = basename(named)
    if (st.isDirectory()) {
      if (this.rootRefused(named) || this.rootRefused(real)) {
        throw new Error(`${shown} cannot be downloaded as a zip: name a folder in it`)
      }
      const rootName = zipRootName(entryName)
      return { kind: 'folder', named, real, outside, rootName, name: downloadName(`${rootName}.zip`) }
    }
    if (!st.isFile()) throw new Error(`${shown} is not a file or folder`)
    // Opened as the GET will open it: a FIFO or a device swapped in after the stat, and a file the
    // process cannot read, are refused now rather than as a 204 later.
    const size = await this.probeFile(real, shown)
    return { kind: 'file', named, real, outside, rootName: entryName, name: downloadName(entryName), size }
  }

  /**
   * The GET of `/d/<token>` (the gateway's route, after its Host, method and `Sec-Fetch-Site` checks).
   * `device`: the device the request's cookie names, or the gateway's rule as a predicate over the
   * token's device (the cookie's device, or `none` while None mode is on, where the token alone
   * counts); it must be the token's. Every check runs before anything is consumed; a refusal writes
   * nothing (the gateway answers 204) and tells the token's view. `headers(name)`: the gateway's fixed
   * headers for the name (type, disposition, nosniff, CSP); a file's `Content-Length` is added here.
   * Resolves when the response is over.
   */
  async serve(
    tokenText: string,
    device: string | undefined | ((tokenDeviceId: string) => boolean),
    res: DownloadResponse,
    headers: (name: string) => Record<string, string>,
  ): Promise<ServeResult> {
    const token = this.liveToken(tokenText)
    // An unknown or expired token names no view to tell.
    if (!token) return { status: 'refused', reason: 'unknown or expired link' }
    const refuse = (reason: string): ServeResult => {
      this.tellFailed(token.view.viewId, { requestId: token.requestId, reason })
      return { status: 'refused', reason }
    }
    const matches = typeof device === 'function' ? device(token.view.deviceId) : device !== undefined && device === token.view.deviceId
    if (!matches) return refuse('the link belongs to another browser')
    const limit = this.limitProblem(token)
    if (limit) return refuse(limit)

    let resolved: ResolvedDownload
    try {
      resolved = await this.resolve(token.target, token.view.windowId)
    } catch (err) {
      return refuse(errorText(err))
    }
    if (resolved.kind !== token.kind) return refuse(`${resolved.rootName} changed from a ${token.kind} to a ${resolved.kind}`)

    let handle: FileHandle | undefined
    let size = 0
    if (resolved.kind === 'file') {
      try {
        const opened = await openVerified(resolved.real)
        if (!opened.ok) return refuse(`${resolved.name} ${verifiedProblemText(opened.problem)}`)
        handle = opened.handle
        size = opened.stat.size
      } catch {
        return refuse(`${resolved.name} cannot be read`)
      }
    }

    // One synchronous step from here to the head: the token is still there (a second GET racing this
    // one did not take it), still live, and the limits still hold (another stream may have started
    // during the awaits above).
    const consumed = this.tokens.get(tokenText) !== token
    // A browser that went away during the checks: the link stays for its retry, and nobody is there to tell.
    const gone = res.destroyed || res.writableEnded
    const problem = consumed || gone || this.now() >= token.expiresAt ? 'the link was already used or expired' : this.limitProblem(token)
    if (problem) {
      await handle?.close().catch(() => undefined)
      // Consumed by the other GET: that one's view is the same, and it is downloading; say nothing.
      if (consumed || gone) return { status: 'refused', reason: gone ? 'the browser went away' : problem }
      return refuse(problem)
    }
    let ended!: () => void
    const live: Live = {
      deviceId: token.view.deviceId,
      kind: resolved.kind,
      controller: new AbortController(),
      res,
      ended: new Promise<void>((resolve) => (ended = resolve))
    }
    try {
      res.writeHead(200, resolved.kind === 'file' ? { ...headers(resolved.name), 'Content-Length': String(size) } : headers(resolved.name))
    } catch (err) {
      await handle?.close().catch(() => undefined)
      return refuse(`the download could not start: ${errorText(err)}`)
    }
    this.tokens.delete(tokenText)
    this.live.add(live)
    try {
      return await this.stream(token, resolved, live, handle, size)
    } finally {
      this.live.delete(live)
      ended()
    }
  }

  /**
   * A GET the gateway refused before `serve` (a cross-site `Sec-Fetch-Site`): the token's view is told
   * why, as for a refusal in `serve`, and the token stays live for a retry within its life. An unknown
   * or expired token names no view, so nobody is told.
   */
  refuse(tokenText: string, reason: string): void {
    const token = this.liveToken(tokenText)
    if (token) this.tellFailed(token.view.viewId, { requestId: token.requestId, reason })
  }

  /**
   * Every live response of `deviceId` ended, and its unused links dropped (a revoke, a disconnect, None
   * mode ending); how many responses were ended (the gateway's Disconnect counts them with the sockets).
   */
  dropDevice(deviceId: string): number {
    for (const [text, token] of this.tokens) if (token.view.deviceId === deviceId) this.tokens.delete(text)
    let ended = 0
    for (const live of this.live) {
      if (live.deviceId !== deviceId) continue
      this.drop(live)
      ended++
    }
    return ended
  }

  /**
   * Everything ended and every link dropped (the gateway stopped). The abort is synchronous; the
   * promise settles once every stream is over (its pipeline unwound, its file closed, out of `live`),
   * so a stop that awaits it leaves nothing behind. Awaiting the client's socket close is not that: the
   * browser sees the cut before this side's pipeline has rejected and its `handle.close()` has run (a
   * full test run under load showed `liveCount` still 1 after the client's close).
   */
  dropAll(): Promise<void> {
    this.tokens.clear()
    const ended: Array<Promise<void>> = []
    for (const live of this.live) {
      this.drop(live)
      ended.push(live.ended)
    }
    return Promise.all(ended).then(() => undefined)
  }

  /** Live responses now (tests, a status line). */
  get liveCount(): number {
    return this.live.size
  }

  /** Unused links now (tests). */
  get tokenCount(): number {
    this.sweep()
    return this.tokens.size
  }

  // -------------------------------------------------------------------------------------------------

  /** A plugin's relative path: inside the project or refused, in resolveProjectEntry's own words. */
  private async inside(projectDir: string, rel: string): Promise<{ named: string; real: string; outside: false; shown: string }> {
    const entry = await resolveProjectEntry(projectDir, rel, true)
    return { named: entry.target, real: entry.real, outside: false, shown: entry.rel === '' ? 'the project folder' : displayPath(entry.rel) }
  }

  /**
   * The CLI's absolute path: inside the project when both its real path and its parent's are (the
   * project's rules, through resolveProjectEntry), or it is the project folder itself; otherwise
   * outside (a link inside the project to `/tmp/x` too: it is the outside rule's then, on both paths).
   */
  private async named(projectDir: string, abs: string): Promise<{ named: string; real: string; outside: boolean; shown: string }> {
    if (typeof abs !== 'string' || !isAbsolute(abs) || abs.includes('\0') || abs.length > MAX_OPEN_PATH_LENGTH) {
      throw new Error('the path must be absolute')
    }
    const named = resolve(abs)
    const shown = displayPath(named)
    let root: string
    try {
      root = await realpath(projectDir)
    } catch {
      throw new Error('the project folder cannot be read')
    }
    let real: string
    let parent: string
    try {
      real = await realpath(named)
      parent = await realpath(dirname(named))
    } catch {
      // A dangling link fails the first realpath too: it points nowhere the checks could clear.
      throw new Error(`no such file or folder: ${shown}`)
    }
    if (real === root || (within(root, real) && within(root, parent))) {
      const rel = real === root ? '' : relative(root, join(parent, basename(named)))
      const entry = await resolveProjectEntry(projectDir, rel, true)
      // Named as the CLI named it (the dialog's full path), read where the project's rules put it.
      return { named, real: entry.real, outside: false, shown }
    }
    return { named, real, outside: true, shown }
  }

  /**
   * The outside rule on the named path and the real one, against the home as given and as realpath'd:
   * on a system whose home is a link (`/home` → `/usr/home`) the real path of `~/.ssh/x` is not under
   * the home as given, and a `/tmp` link to it would pass both checks against that spelling alone.
   */
  private outsideRefused(named: string, real: string): boolean {
    const envs = [this.env]
    const realHome = this.realHome()
    if (realHome !== undefined && realHome !== this.env.home) envs.push({ ...this.env, home: realHome })
    return envs.some((env) => outsideRefused(named, env) || outsideRefused(real, env))
  }

  private rootRefused(p: string): boolean {
    const realHome = this.realHome()
    return downloadRootRefused(p, this.env) || (realHome !== undefined && downloadRootRefused(p, { ...this.env, home: realHome }))
  }

  private realHomeCache: { home: string; real: string | undefined } | undefined

  /** The home's realpath (cached per home), undefined when it cannot be resolved (the home rules then use the spelling given). */
  private realHome(): string | undefined {
    const home = this.env.home
    if (!home || !isAbsolute(home)) return undefined
    if (this.realHomeCache?.home !== home) {
      let real: string | undefined
      try {
        // Sync once per home: the checks that use it are synchronous, and the home does not move.
        real = realpathSync(home)
      } catch {
        real = undefined
      }
      this.realHomeCache = { home, real }
    }
    return this.realHomeCache.real
  }

  /** The data dir's realpath; its spelling as given when it cannot be resolved (dataDirRefused then compares that). */
  private async dataDirReal(): Promise<string> {
    try {
      return await realpath(this.deps.dataDir)
    } catch {
      return resolve(this.deps.dataDir)
    }
  }

  /** A file opened through a verified descriptor and closed again: its size, or the refusal's text. */
  private async probeFile(real: string, shown: string): Promise<number> {
    let opened: Awaited<ReturnType<typeof openVerified>>
    try {
      opened = await openVerified(real)
    } catch {
      throw new Error(`${shown} cannot be read`)
    }
    if (!opened.ok) {
      throw new Error(opened.problem === 'not-file' ? `${shown} is not a file or folder` : `${shown} ${verifiedProblemText(opened.problem)}`)
    }
    await opened.handle.close().catch(() => undefined)
    return opened.stat.size
  }

  /** The counting pass before a view gets anything: past a cap or the 10 s bound, refused with the counts. */
  private async checkCount(resolved: ResolvedDownload, target: DownloadTarget, includeAll: boolean): Promise<void> {
    const shown = 'rel' in target ? (target.rel === '' ? 'the project folder' : displayPath(target.rel)) : displayPath(resolved.named)
    const count = await this.countChecked(resolved, shown)
    if (includeAll && count.allOver !== undefined) {
      throw new Error(`${shown} with .git and node_modules is too large to download: ${this.overText(count.all)}`)
    }
  }

  /** Both totals of a folder, or a throw when the plain zip passes a cap or cannot be counted in time. */
  private async countChecked(resolved: ResolvedDownload, shown: string): Promise<Extract<FolderCount, { ok: true }>> {
    let count: FolderCount
    try {
      count = await countFolder({
        ...this.walkOptions(resolved, await this.dataDirReal()),
        fs: this.deps.walkFs,
        timeoutMs: this.deps.walkTimeoutMs,
        maxBytes: this.deps.maxBytes,
        maxEntries: this.deps.maxEntries,
      })
    } catch {
      throw new Error(`${shown} cannot be read`)
    }
    if (!count.ok) {
      if (count.problem === 'timeout') throw new Error(`${shown} has too many files to count`)
      throw new Error(`${shown} is too large to download: ${this.overText(count.plain)}`)
    }
    return count
  }

  /** Why the window may not get another offer now (3 waiting, 10 per 10 min), or null. */
  private offerLimitProblem(windowId: number, inFlight = 0): string | null {
    if (this.offerAsks.pendingFor(windowId).length + inFlight >= DOWNLOAD_OFFERS_WAITING_MAX) {
      return `${DOWNLOAD_OFFERS_WAITING_MAX} download offers are already waiting in this project; wait for the person to answer them`
    }
    if (this.recentOffers(windowId).length + inFlight >= DOWNLOAD_OFFERS_MAX) {
      return `${DOWNLOAD_OFFERS_MAX} downloads were offered in this project in the last ${Math.round(DOWNLOAD_OFFERS_WINDOW_MS / 60_000)} minutes; try again later`
    }
    return null
  }

  /** The window's offer times still inside DOWNLOAD_OFFERS_WINDOW_MS. */
  private recentOffers(windowId: number): number[] {
    const since = this.now() - DOWNLOAD_OFFERS_WINDOW_MS
    return (this.offerTimes.get(windowId) ?? []).filter((t) => t > since)
  }

  /** Accepted offers past their life dropped (a waiting one ends through its ask's own timeout). */
  private sweepOffers(): void {
    const now = this.now()
    for (const [id, record] of this.offers) {
      if (record.acceptedBy !== undefined && now >= record.expiresAt) this.offers.delete(id)
    }
  }

  /** "more than 20,000 files and folders" or "more than 2.1 GB", from the totals the count stopped at. */
  private overText(t: { files: number; folders: number; bytes: number }): string {
    const maxEntries = this.deps.maxEntries ?? DOWNLOAD_ZIP_MAX_ENTRIES
    const maxBytes = this.deps.maxBytes ?? DOWNLOAD_ZIP_MAX_BYTES
    if (t.files + t.folders > maxEntries) return `more than ${maxEntries.toLocaleString('en-US')} files and folders (the limit)`
    return `more than ${downloadSizeText(maxBytes)} of files (the limit)`
  }

  private walkOptions(resolved: ResolvedDownload, dataDir: string): {
    root: string
    rootName: string
    outside: boolean
    env: OutsideEnv
    dataDir: string
  } {
    // The walk's paths are real (below the root's realpath), so its outside checks use the real home.
    const realHome = this.realHome()
    return {
      root: resolved.real,
      rootName: resolved.rootName,
      outside: resolved.outside,
      env: realHome !== undefined ? { ...this.env, home: realHome } : this.env,
      dataDir,
    }
  }

  /** Why another stream cannot start for this token's device now (2 per device, 3 zips app-wide), or null. */
  private limitProblem(token: Token): string | null {
    let device = 0
    let zips = 0
    for (const live of this.live) {
      if (live.deviceId === token.view.deviceId) device++
      if (live.kind === 'folder') zips++
    }
    if (device >= DOWNLOAD_STREAMS_PER_DEVICE) return `this browser already has ${DOWNLOAD_STREAMS_PER_DEVICE} downloads running; wait for one to finish`
    if (token.kind === 'folder' && zips >= DOWNLOAD_ZIPS_MAX) return `${DOWNLOAD_ZIPS_MAX} folders are being zipped already; try again in a moment`
    return null
  }

  /** The token for `text` while it lives; an expired one is dropped. */
  private liveToken(text: string): Token | undefined {
    if (typeof text !== 'string') return undefined
    const token = this.tokens.get(text)
    if (!token) return undefined
    if (this.now() >= token.expiresAt) {
      this.tokens.delete(text)
      return undefined
    }
    return token
  }

  /** Expired tokens dropped: they are bounded by the starts' own limits, so a sweep at each mint is enough. */
  private sweep(): void {
    const now = this.now()
    for (const [text, token] of this.tokens) if (now >= token.expiresAt) this.tokens.delete(text)
  }

  private drop(live: Live): void {
    live.controller.abort(new Dropped())
    // pipeline destroys the response on the abort; destroyed here too in case it is between chunks of
    // a source that has not looked at the signal yet.
    live.res.destroy()
  }

  /** The bytes after the head: a file's exactly `size`, a folder's zip chunked; how it ended. */
  private async stream(token: Token, resolved: ResolvedDownload, live: Live, handle: FileHandle | undefined, size: number): Promise<ServeResult> {
    const signal = live.controller.signal
    const counter = { bytes: 0, failed: false }
    const skipped: DownloadSkipped = {}
    const name = resolved.name
    const deviceId = token.view.deviceId
    let source: AsyncIterable<Buffer>
    // The read in flight when the browser closes: awaited before the close, so it never hits a closed descriptor.
    const reading: { pending?: Promise<unknown> } = {}
    if (handle) {
      source = fileBytes(handle, size, signal, reading)
    } else {
      // The walk's data dir must be real like its paths.
      const walk = walkFolder({ ...this.walkOptions(resolved, await this.dataDirReal()), includeAll: token.includeAll, signal, fs: this.deps.walkFs }, skipped)
      source = zipEntries(walk, { signal, skipped, maxBytes: this.deps.maxBytes, maxEntries: this.deps.maxEntries })
    }
    // A browser that goes away aborts the walk too. pipeline's own cleanup destroys the source, but an
    // async generator's `return` waits for the await it is in: a walk stalled on a hung `lstat` (a dead
    // network mount) would hold the pipeline, and with it a live slot of the device and app-wide zip
    // limits, forever. The walk's fs calls are raced against this signal, so the abort unwinds it. A
    // close that pipeline made itself, for a source that threw (a read error, a cap), is that failure's.
    const onClose = (): void => {
      if (!live.res.writableFinished && !counter.failed) live.controller.abort(new BrowserClosed())
    }
    live.res.once('close', onClose)
    try {
      await pipeline(Readable.from(counted(source, counter), { objectMode: false }), live.res, { signal })
      return { status: 'sent', deviceId, name, bytes: counter.bytes, completed: true }
    } catch (err) {
      if (signal.aborted) {
        const cut = signal.reason instanceof BrowserClosed ? 'closed' : 'dropped'
        return { status: 'sent', deviceId, name, bytes: counter.bytes, completed: false, cut }
      }
      if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
        // The browser went away (its own Cancel, a closed tab): the person knows.
        return { status: 'sent', deviceId, name, bytes: counter.bytes, completed: false, cut: 'closed' }
      }
      const reason = err instanceof ZipCapError ? err.message : `${name} could not be read to the end`
      this.deps.log?.(`download of ${name} cut: ${errorText(err)}`)
      // The headers are out, so the only way to fail is to cut it short: pipeline destroyed the response
      // (a file short of its Content-Length, a zip with no end record), and the browser lists it failed.
      live.res.destroy()
      this.tellFailed(token.view.viewId, { requestId: token.requestId, reason })
      return { status: 'sent', deviceId, name, bytes: counter.bytes, completed: false, cut: 'failed' }
    } finally {
      live.res.removeListener('close', onClose)
      await reading.pending?.catch(() => undefined)
      await handle?.close().catch(() => undefined)
    }
  }
}

/** "2.3 MB", or for a folder "312 files, 48 MB before compression" (the plain zip's totals). */
function offerSizeText(info: OfferInfo): string {
  if (info.kind === 'file') return downloadSizeText(info.size)
  const n = info.counts.plain.files
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}, ${downloadSizeText(info.counts.plain.bytes)} before compression`
}

/**
 * A file's bytes from its verified descriptor, exactly `size` (its fstat size at the open, the
 * `Content-Length`): one that grew is cut there, one that shrank throws (a response short of its
 * length must fail in the browser, never look complete).
 */
async function* fileBytes(handle: FileHandle, size: number, signal: AbortSignal, reading: { pending?: Promise<unknown> }): AsyncGenerator<Buffer> {
  let at = 0
  while (at < size) {
    signal.throwIfAborted()
    // A fresh buffer per chunk: the response may still hold the last one.
    const buf = Buffer.allocUnsafe(Math.min(ZIP_CHUNK_BYTES, size - at))
    const read = handle.read(buf, 0, buf.length, at)
    reading.pending = read
    const { bytesRead } = await read
    if (bytesRead === 0) throw new Error('the file shrank while it was sent')
    at += bytesRead
    yield buf.subarray(0, bytesRead)
  }
}

/**
 * `source` passed through, its bytes added up (the access log's count, a cut stream's too); `failed`
 * set the moment it throws, before pipeline destroys the response for it.
 */
async function* counted(source: AsyncIterable<Buffer>, counter: { bytes: number; failed: boolean }): AsyncGenerator<Buffer> {
  try {
    for await (const chunk of source) {
      counter.bytes += chunk.length
      yield chunk
    }
  } catch (err) {
    counter.failed = true
    throw err
  }
}
