// The native web views behind `"kind": "webview"` panels (plan B: Technical Details › Web view
// panel; Task 7). One view per webview panel per window, created on the panel's first
// `ctx.webview.navigate` and destroyed with the window or when the plugin's ctx ends. Only main can
// create a WebContentsView safely (design rule 2), so the plugin drives it through main and never
// touches it; the renderer only reports where the panel's placeholder is (Task 8).
//
// Showing (Task 8): a native view paints above the whole shell page, so it may only show where the
// page says its placeholder is and while nothing of the shell lies over it. The window's renderer
// reports the placeholder's bounds and `visible` (false while the panel is closed, hidden, in a
// collapsed zone, a splitter is dragged, or a menu, the palette, a dialog or settings is up; the
// renderer is the only one that sees those). main adds what it knows itself: while the window has
// an overlay open (setWindowCovered) every view of it hides, whatever the last report said, since
// an overlay opened by the CLI or a plugin is on the stack before the page has drawn it, and a url
// overlay is a native view of its own that a webview must not paint over. A report only ever moves
// a view in the window that sent it (the caller passes main's window id, never the page's).
//
// This file holds the decisions and no Electron import, so unit tests drive it with a fake view
// factory; electron-webview.ts is the thin adapter (the only other WebContentsView code next to
// electron-url-view.ts):
//   navigate target   an http(s) URL as is; an absolute file path through `cc-preview://<token>/`
//                     (a token per view and folder, preview-protocol.ts serves it); anything else
//                     (a relative path, file:, javascript:, data:, ...) is refused; the folder
//                     rules are webview-target.ts's
//   page navigation   a link, a script or a redirect in the main frame may go to http(s) or to one
//                     of THIS view's own tokens; anything else (file:, another view's token, a
//                     custom scheme) is dropped. Sub-frames are a page's own business, except that
//                     they get no file: and no token but the view's own.
//   window.open       to the system browser, http(s) only (overlayUrlOf), MAX_OPENS_PER_VIEW per
//                     OPEN_WINDOW_MS; never a second view
//   onNavigate        coalesced (NAVIGATED_COALESCE_MS), url and title capped: the page drives it
//   a failed load     Electron commits an empty page at the failed URL (no error page of its own,
//                     no did-navigate): the record keeps the error until the next page commits,
//                     current() and the toolbar carry it, and a navigate that fails within
//                     LOAD_WAIT_MS rejects with it (WebviewLoadError)
//   bounds/visibility inputs (setPlacement): zero bounds and hidden until a report says otherwise
//   tokens            die with the view; a page's folder rules are preview-protocol.ts's
//
// Who may drive a view is decided by the caller (host-api.ts): the panel must be one of the asking
// host's plugin's declared webview panels, in the host's own window. Here the owner names the view.
//
// Server mode (design-web-browser.md §3.1, §5): main picks the off-screen factory by the same
// `server` flag (index.ts, decided once at start), and every decision above stays here unchanged;
// what differs is decided here too, by `deps.server`, never by a payload:
//   limits            at most MAX_SERVER_VIEWS_PER_WINDOW views per project window and
//                     MAX_SERVER_VIEWS in the app: each is a whole Chromium page on the server; a
//                     navigate that would make one more is refused with the reason (not a load
//                     error, so host-api.ts refunds its navigate charge)
//   deferred loads    a navigate for a panel that has no view yet and that no browser shows (the
//                     browser plugin's `home` at activation, in every open project) only records
//                     the target: it is loaded when a browser first shows the panel (setViewed), so
//                     an idle project holds no page and cannot use up the app's views. A navigate
//                     the caller needs the outcome of (`now`: one made while a `ccc` command of the
//                     plugin runs, `ccc browser open` above all) loads at once, viewer or not.
//   placements        the window's own page is the hidden page, which has the panels the browsers
//                     open in the shared layout and reports them like a desktop page: its reports
//                     mean nothing for a page on no screen and are ignored. The browsers' reports
//                     drive the view instead, through webview-viewers.ts: setViewed (a panel's
//                     first viewer shows the view, so it paints; its last one leaving hides it) and
//                     setViewSize (the size owner's size). They are the browsers' state, not the
//                     plugin's: a plugin reload keeps them, so its next `home` loads for the browser
//                     that still shows the panel. An overlay does not hide the views: in a browser
//                     it is a page layer over the panel's canvas, not a native view under it.
//   keyboard          never handed back: the hidden page is never focused (WindowManager {server})
import { randomBytes } from 'node:crypto'
import { errorText } from '../../shared/error-text'
import { splitChord } from '../../shared/keys'
import { MAX_URL_LENGTH, overlayUrlOf, type ViewBounds } from '../overlays/overlay-manager'
import { PREVIEW_SCHEME, PREVIEW_TOKEN_PATTERN } from './preview-protocol'
import { defaultTempRoots, resolveWebviewTarget, type WebviewTarget } from './webview-target'
import type { ElectronInputEvent, InputTarget } from './webview-input'
import { warnLog } from '../warn-log'

/**
 * Folders one view keeps a token for. A browser plugin showing file after file adds one per new
 * folder; past this the least recently navigated one goes (its pages 404 on reload, the user
 * navigates again).
 */
export const MAX_TOKENS_PER_VIEW = 32
/** Longest page title reported (current, onNavigate): a page sets its own title, of any length. */
export const MAX_PAGE_TITLE_LENGTH = 1024
/**
 * `onNavigate` reports are coalesced to one per this many ms per view: a hostile page looping
 * `history.pushState` or `document.title` must not drive the main-to-host event rate. The first
 * change of a burst is reported at once, the state at its end once the window is over.
 */
export const NAVIGATED_COALESCE_MS = 100
/**
 * `window.open` budget per view (MAX_OPENS_PER_VIEW per OPEN_WINDOW_MS): a page calling it in a
 * loop must not flood the system browser with tabs. Calls past it are dropped and logged.
 */
export const MAX_OPENS_PER_VIEW = 3
export const OPEN_WINDOW_MS = 10_000
/**
 * How long `navigate` waits for the load's outcome: a dev server that is down fails at once, so
 * `ccc browser open` can say so instead of `ok` (review finding). A page slower than this resolves
 * as started; a failure after it shows in current() and the toolbar. Well under the 30 s a plugin
 * CLI call gets, so `ccc` never hangs on a slow page.
 */
export const LOAD_WAIT_MS = 10_000
/** Longest load error reported (Chromium's own `ERR_…` name and code; capped all the same). */
export const MAX_LOAD_ERROR_LENGTH = 200

/**
 * A navigate whose page then failed to load (no server, a refused connection, a bad certificate).
 * Its own class: the load did happen, so host-api.ts does not refund the navigate budget for it as
 * it does for a refused target.
 */
export class WebviewLoadError extends Error {}

/** Which panel a view belongs to; `windowId` and `projectId` are main's, never a plugin's. */
export interface WebviewOwner {
  windowId: number
  projectId: string
  pluginId: string
  panelId: string
}

/** What `ctx.webview.current` and `onNavigate` report. */
export interface WebviewPage {
  url: string
  title: string
  /**
   * Why the page shown failed to load (Chromium's `ERR_…` name and code), absent for a page that
   * loaded. The view shows an empty page at `url` then; reload tries again.
   */
  error?: string
}

/** Where the panel's placeholder is and whether it may show (the renderer's report, Task 8). */
export interface WebviewPlacement {
  bounds: ViewBounds
  visible: boolean
}

/** What the adapter asks the manager about, and tells it. */
export interface WebviewEvents {
  /** A navigation the page started (link, script, redirect): may it go ahead? */
  allowNavigation(url: string, isMainFrame: boolean): boolean
  /** `window.open` / target=_blank: never a view of ours (the manager may hand it to the system browser). */
  openWindow(url: string): void
  /**
   * A page committed (also in-page; `commit` true: a load error before it is over) or its title
   * changed (`commit` false: an error page's title must not clear its error): read `current()` again.
   */
  navigated(commit: boolean): void
  /**
   * The main frame's load failed (not a navigation superseded by a newer one, ERR_ABORTED): the
   * view committed an empty page at `url`.
   */
  loadFailed(url: string, error: string): void
  /** A key chord typed into the page (the shell never sees those); true: consumed. */
  chord(chord: string): boolean
  /** The page went away by itself (renderer crash or kill); the view is to be dropped. */
  gone(): void
}

/** A webview panel's native view (a WebContentsView in the real app). */
export interface WebviewView {
  /**
   * Start loading `url`. Resolves when it loaded or was superseded by a newer navigation; rejects
   * with the load error (its message is the error text) when it failed.
   */
  load(url: string): Promise<void>
  back(): void
  forward(): void
  reload(): void
  current(): WebviewPage
  /** Whether the page has the keyboard (false once it is gone); see WebviewManager.mayHaveKeyboard. */
  isFocused(): boolean
  setBounds(bounds: ViewBounds): void
  setVisible(visible: boolean): void
  /** Remove it from the window and close its page. Safe once the window is gone. */
  destroy(): void
  /** Server mode's off-screen view only: the page's size, CSS px (webview-input.ts checks points against it). */
  size?(): { width: number; height: number }
  /** Server mode's off-screen view only: trusted input for the page (`sendInputEvent`), checked by webview-input.ts. */
  sendInput?(events: readonly ElectronInputEvent[]): void
  /** Server mode's off-screen view only: committed text for the page (`webContents.insertText`). */
  insertText?(text: string): void
  /** Server mode's off-screen view only: the page's selection (webview-input.ts SELECTION_SCRIPT, isolated world). */
  readSelection?(): Promise<unknown>
}

export interface WebviewViewFactory {
  /**
   * A hardened view in `windowId` on the in-memory session `partition`, hidden behind zero bounds,
   * no page loaded yet. Throws when the window is gone. `owner` is the panel it is for (server mode:
   * index.ts streams the view's frames to that panel's viewers, frame-stream.ts).
   */
  create(windowId: number, partition: string, events: WebviewEvents, owner: WebviewOwner): WebviewView
}

export interface WebviewManagerDeps {
  views: WebviewViewFactory
  /**
   * Hand an http(s) URL a view's page asked to open in a new window to the openExternal adapter
   * (external/open-external.ts) for that view's window: the system browser on the desktop, a link
   * notice in the window's browsers in server mode.
   */
  openExternal(url: string, windowId: number): void
  /** A chord typed into a view (overlay and app keys); true when it was acted on. Default: none. */
  chord?(windowId: number, chord: string): boolean
  /**
   * The page a view shows changed (coalesced like onNavigate), or the view went (empty page): the
   * window's toolbar follows it. Not called for views of a window that is closing.
   */
  pageChanged?(owner: WebviewOwner, page: WebviewPage): void
  /** Whether the project window is still open (a navigate awaits the file system first). */
  isWindowOpen(windowId: number): boolean
  /**
   * A view that was showing got hidden (overlay, palette, panel closed) or went: hand the keyboard
   * back to the shell page, since a hidden WebContentsView otherwise stays the focused contents and
   * keeps receiving keystrokes nobody can see. Not called while another view of the window has the
   * keyboard: the panel the user is typing into keeps it. Default: none.
   */
  focusShell?(windowId: number): void
  /**
   * Whether the window is the focused one. focusShell is only for a focused window: on macOS
   * `webContents.focus()` also brings its window to the front, so a view hidden in a background
   * project window (a dev reload, a host restart, an overlay opened by the CLI) would pull it
   * over the window the user is typing in (review finding). A background window's hand-back
   * waits for windowFocused. Default: always focused.
   */
  isWindowFocused?(windowId: number): boolean
  /**
   * The last view of `partition` went (destroyPlugin, closeWindow, a crash): its session serves no
   * token any more, so what it charged against its cc-preview budget can go too (index.ts forgets
   * the budget). Default: none.
   */
  partitionClosed?(partition: string): void
  /** The user's home folder (os.homedir() in the app, a temp dir in tests). */
  homeDir(): string
  /** A fresh token (tests pin it); default `t` + 128 random bits in hex. */
  newToken?(): string
  /** Folders every program shares, refused as a preview root (default: defaultTempRoots()). */
  tempRoots?(): readonly string[]
  /** Clock of the window.open budget (tests pin it); default Date.now. */
  now?(): number
  log?: (message: string) => void
  /**
   * main's server flag (server-mode.ts): the views are off-screen ones, so the limits, the deferred
   * loads, the ignored page placements and the keyboard rule of the top of the file apply.
   */
  server?: boolean
}

/** Largest side, CSS px, setViewSize gives a view (design-web-browser.md §5; webview-viewers.ts clamps there first). */
const MAX_VIEW_SIDE = 4096

/** Off-screen views at once in one project window, in server mode (design-web-browser.md §5). */
export const MAX_SERVER_VIEWS_PER_WINDOW = 4
/** Off-screen views at once in the whole app, in server mode (design-web-browser.md §5). */
export const MAX_SERVER_VIEWS = 12

/** What a navigate past the server-mode limits gets (the browser plugin's `ccc browser open` prints it). */
export const WEBVIEW_LIMIT_REFUSAL =
  `webview.navigate: too many web views open (server mode allows ${MAX_SERVER_VIEWS_PER_WINDOW} per project window ` +
  `and ${MAX_SERVER_VIEWS} in all); turn off a plugin that shows one, or close a project`

/** How a navigate is to load (host-api.ts decides it from main's own state, never the plugin's payload). */
export interface NavigateOptions {
  /**
   * The caller waits for the outcome (a `ccc` command of the plugin is running): load at once even
   * in server mode with no browser showing the panel. Ignored on the desktop, which always does.
   */
  now?: boolean
}

/** The session partition of a plugin's webviews in a project: in memory, shared with nothing else. */
export function webviewPartition(projectId: string, pluginId: string): string {
  return `webview-${projectId}-${pluginId}`
}

interface ViewRecord {
  owner: WebviewOwner
  partition: string
  view: WebviewView
  /** token -> folder (realpath'd); insertion order is last use, oldest first (MAX_TOKENS_PER_VIEW). */
  tokens: Map<string, string>
  /** Who hears `onNavigate` (the HostApi of the host that drives the view). */
  onNavigate?: (page: WebviewPage) => void
  /** The coalescing window of `onNavigate` reports (NAVIGATED_COALESCE_MS) is open. */
  navTimer?: ReturnType<typeof setTimeout>
  /** A change came in while the window was open: report it when it closes. */
  navPending: boolean
  /** When the page's last window.open calls went through (MAX_OPENS_PER_VIEW). */
  opens: number[]
  /** What the last apply() set, to notice a showing view being hidden (focusShell). */
  appliedVisible?: boolean
  /** The main frame's last load failed (see WebviewPage.error); cleared when a page commits. */
  loadError?: { url: string; error: string }
}

/** A navigate recorded for a panel nobody shows yet (server mode, see the top of the file). */
interface DeferredLoad {
  owner: WebviewOwner
  resolved: WebviewTarget
  onNavigate?: (page: WebviewPage) => void
}

function keyOf(windowId: number, pluginId: string, panelId: string): string {
  return `${windowId}\0${pluginId}\0${panelId}`
}

function pluginKeyOf(windowId: number, pluginId: string): string {
  return `${windowId}\0${pluginId}`
}

export class WebviewManager {
  private readonly records = new Map<string, ViewRecord>()
  /** Last report per panel, kept without a view too: the view created later starts there. */
  private readonly placements = new Map<string, WebviewPlacement>()
  /** Windows with an overlay open: every view in them hides (see the top of the file). */
  private readonly covered = new Set<number>()
  /**
   * Bumped whenever a plugin's views in a window are torn down: a navigate that was awaiting the
   * file system when the plugin's ctx ended must not create a view for a copy that is gone.
   */
  private readonly generations = new Map<string, number>()
  /**
   * Navigations started per panel: resolving a file target awaits the file system, so two
   * overlapping navigates can finish out of order; the newest started among the valid ones wins.
   */
  private readonly navSeq = new Map<string, number>()
  /**
   * Per panel, the newest navigate (its navSeq number) that resolved and loaded. Kept apart from
   * navSeq so a navigate that is refused (a missing file, a dot-folder) cancels nothing: an older
   * valid one still loads (review finding: a refused `open missing.html` made an overlapping
   * `open a.html` that had already said `ok` load nothing). An older one finishing after a newer
   * one loaded is dropped, so the newer page stays.
   */
  private readonly navLoaded = new Map<string, number>()
  /**
   * Windows whose shell page is due the keyboard (a showing view was hidden or went) but were not
   * focused then: handed back on windowFocused, unless the user is in a showing view by then.
   */
  private readonly focusDue = new Set<number>()
  /**
   * Server mode: per panel with no view yet, the last navigate nobody could see load (the browser
   * plugin's `home`); loaded by setViewed. Newest wins (navSeq/navLoaded order them as loads).
   */
  private readonly deferred = new Map<string, DeferredLoad>()
  /** Server mode: the panels at least one browser view shows now (setViewed, from webview-viewers.ts). */
  private readonly viewed = new Set<string>()
  private readonly log: (message: string) => void

  constructor(private readonly deps: WebviewManagerDeps) {
    this.log = deps.log ?? warnLog
  }

  /**
   * Show `target` in the panel's view (created on first use). Resolves once the page loaded, was
   * superseded by a newer navigation, or LOAD_WAIT_MS went by (a slow page); rejects with a
   * WebviewLoadError when it failed to load first. A failed page is an empty one at its URL
   * (Electron has no error page): current() carries the error, the toolbar shows it.
   *
   * Server mode: past the view limits it rejects with WEBVIEW_LIMIT_REFUSAL; for a panel with no
   * view that no browser shows it records the target and resolves (the load waits for setViewed),
   * unless `options.now`. The target is resolved first either way, so a refused one says so now.
   */
  async navigate(
    owner: WebviewOwner,
    target: unknown,
    onNavigate?: (page: WebviewPage) => void,
    options: NavigateOptions = {}
  ): Promise<void> {
    const gen = this.generation(owner.windowId, owner.pluginId)
    const seqKey = keyOf(owner.windowId, owner.pluginId, owner.panelId)
    const seq = (this.navSeq.get(seqKey) ?? 0) + 1
    this.navSeq.set(seqKey, seq)
    const resolved = await resolveWebviewTarget(target, this.deps.homeDir(), this.deps.tempRoots?.() ?? defaultTempRoots())
    if (gen !== this.generation(owner.windowId, owner.pluginId)) throw new Error('webview.navigate: the plugin was stopped')
    if (!this.deps.isWindowOpen(owner.windowId)) throw new Error('webview.navigate: the window is gone')
    // A newer navigate of this panel already loaded while this one resolved: it wins, this one must
    // not overwrite it (a slow realpath of a file target finishing after a later URL's load). One
    // started later but not loaded yet will load over this one if it resolves, or leave this one
    // in place if it is refused.
    if (seq < (this.navLoaded.get(seqKey) ?? 0)) return
    if (this.defers(seqKey, options)) {
      // Nothing is made: the newest such navigate is what the first browser to show the panel
      // loads. Ordered like a load, so an older navigate still resolving cannot replace it.
      this.navLoaded.set(seqKey, seq)
      this.deferred.set(seqKey, { owner: { ...owner }, resolved, ...(onNavigate ? { onNavigate } : {}) })
      return
    }
    // Made (or refused by the limits) before the order is taken: a refused one cancels nothing.
    const rec = this.recordFor(owner)
    this.navLoaded.set(seqKey, seq)
    // A load now supersedes whatever an earlier navigate left for the first viewer.
    this.deferred.delete(seqKey)
    if (onNavigate) rec.onNavigate = onNavigate
    const url = this.urlOf(rec, resolved)
    const error = await settled(rec.view.load(url), LOAD_WAIT_MS)
    if (error !== undefined) {
      const shown = resolved.kind === 'url' ? resolved.url : `${resolved.folder}/${resolved.name}`
      throw new WebviewLoadError(`webview.navigate: ${shown.slice(0, MAX_URL_LENGTH)} did not load: ${cleanError(error)}`)
    }
  }

  back(owner: WebviewOwner): void {
    this.find(owner)?.view.back()
  }

  forward(owner: WebviewOwner): void {
    this.find(owner)?.view.forward()
  }

  reload(owner: WebviewOwner): void {
    this.find(owner)?.view.reload()
  }

  /** The page the view shows; empty before the first navigate (no view yet). */
  current(owner: WebviewOwner): WebviewPage {
    const rec = this.find(owner)
    if (!rec) return { url: '', title: '' }
    return this.pageOf(rec)
  }

  /**
   * The window gained focus: the shell page gets the keyboard a view hidden or dropped while the
   * window was in the background still owed it (focusDue), unless the user is in a showing view.
   */
  windowFocused(windowId: number): void {
    if (!this.focusDue.delete(windowId)) return
    // A window under an overlay: the overlay owns the keyboard. A url overlay opened in a
    // background window focuses its view, which focuses the window on macOS, so this event
    // arrives right after and would take the keyboard back (round-8 bug, background case); the
    // same when the user returns to the window with the overlay still up. OverlayManager hands
    // the keyboard back (focusWindow) when the stack empties.
    if (this.covered.has(windowId)) return
    for (const rec of this.records.values()) {
      if (rec.owner.windowId === windowId && this.shown(rec) && this.focusedView(rec)) return
    }
    this.deps.focusShell?.(windowId)
  }

  /**
   * Server mode: whether any browser view shows the panel now (webview-viewers.ts drives it from
   * the browsers' `webviews.place` reports). A viewed panel's view shows, so the off-screen page
   * paints; one nobody views is hidden and stops painting. The first viewer of a panel that has a
   * deferred navigate loads it (its outcome goes to current(), onNavigate and the toolbar: nobody
   * awaits it). Ignored on the desktop, where the window's page places its views.
   */
  setViewed(windowId: number, pluginId: string, panelId: string, viewed: boolean): void {
    if (this.deps.server !== true) return
    const key = keyOf(windowId, pluginId, panelId)
    if (!viewed) {
      this.viewed.delete(key)
      this.placeServerView(key, { visible: false })
      return
    }
    if (this.viewed.has(key) || !this.deps.isWindowOpen(windowId)) return
    this.viewed.add(key)
    this.placeServerView(key, { visible: true })
    const pending = this.deferred.get(key)
    if (!pending) return
    this.deferred.delete(key)
    let rec: ViewRecord
    try {
      rec = this.recordFor(pending.owner)
    } catch (err) {
      // Past the limits (or the window went under it): the toolbar says why, and the target stays
      // for the next time a browser shows the panel, unless a newer navigate took its place.
      this.log(`webview: a deferred load did not start: ${errorText(err)}`)
      if (!this.deferred.has(key)) this.deferred.set(key, pending)
      this.tellWindow(pending.owner, { url: '', title: '', error: cleanError(errorText(err)) })
      return
    }
    if (pending.onNavigate) rec.onNavigate = pending.onNavigate
    let url: string
    try {
      url = this.urlOf(rec, pending.resolved)
    } catch (err) {
      this.log(`webview: a deferred load did not start: ${errorText(err)}`)
      return
    }
    // A failure is recorded by loadFailed (current(), the toolbar); nothing waits on the promise.
    rec.view.load(url).catch(() => undefined)
  }

  /**
   * Server mode: the size the panel's page is to have, CSS px (the size owner's report, clamped and
   * throttled by webview-viewers.ts; clamped here again, as main's last line before Electron). Kept
   * without a view too: a view made later starts at it. Ignored on the desktop.
   */
  setViewSize(windowId: number, pluginId: string, panelId: string, size: { width: number; height: number }): void {
    if (this.deps.server !== true) return
    const side = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(MAX_VIEW_SIDE, Math.round(v)) : 0
    const width = side(size?.width)
    const height = side(size?.height)
    if (width === 0 || height === 0) return
    this.placeServerView(keyOf(windowId, pluginId, panelId), { bounds: { x: 0, y: 0, width, height } })
  }

  /**
   * Server mode: where a browser's input for the panel goes (`webviews.input`, webview-input.ts has
   * checked it): the live off-screen page's size and its sendInputEvent. Undefined on the desktop
   * (a native view gets the keyboard and mouse itself), with no view yet, and once its page is gone.
   */
  inputTarget(windowId: number, pluginId: string, panelId: string): InputTarget | undefined {
    if (this.deps.server !== true) return undefined
    const rec = this.records.get(keyOf(windowId, pluginId, panelId))
    if (!rec) return undefined
    const { view } = rec
    const size = view.size
    const sendInput = view.sendInput
    if (!size || !sendInput) return undefined
    const insertText = view.insertText
    const readSelection = view.readSelection
    return {
      size: () => size(),
      // Looked up again per call: the record may have gone in between (a crash, the plugin off).
      send: (events) => {
        if (this.isLive(rec)) sendInput(events)
      },
      ...(insertText
        ? {
            insertText: (text: string) => {
              if (this.isLive(rec)) insertText(text)
            }
          }
        : {}),
      ...(readSelection
        ? { readSelection: () => (this.isLive(rec) ? readSelection() : Promise.resolve(undefined)) }
        : {})
    }
  }

  /** Whether a navigate is waiting for the panel's first viewer (server mode; tests). */
  hasDeferred(windowId: number, pluginId: string, panelId: string): boolean {
    return this.deferred.has(keyOf(windowId, pluginId, panelId))
  }

  /** Whether the panel has a view now (tests, Task 8's toolbar state). */
  has(windowId: number, pluginId: string, panelId: string): boolean {
    return this.records.has(keyOf(windowId, pluginId, panelId))
  }

  /**
   * Where the panel's placeholder is and whether the view may show (the renderer's report, checked
   * by the caller to come from `windowId`). Applied now when the view exists, kept for it otherwise.
   */
  setPlacement(windowId: number, pluginId: string, panelId: string, placement: WebviewPlacement): void {
    // Server mode: the window's page is the hidden page (see the top of the file); an off-screen
    // view would otherwise paint, at the hidden page's size, for nobody.
    if (this.deps.server === true) return
    const key = keyOf(windowId, pluginId, panelId)
    const clean: WebviewPlacement = { bounds: cleanBounds(placement.bounds), visible: placement.visible === true }
    this.placements.set(key, clean)
    const rec = this.records.get(key)
    if (rec) this.apply(rec)
  }

  /**
   * The window's overlay stack became non-empty (true) or empty (false): its views hide while it
   * has one and come back where their last reports put them after.
   */
  setWindowCovered(windowId: number, covered: boolean): void {
    if (covered === this.covered.has(windowId)) return
    if (covered) this.covered.add(windowId)
    else this.covered.delete(windowId)
    for (const rec of this.records.values()) if (rec.owner.windowId === windowId) this.apply(rec)
  }

  /**
   * The window's page (re)loaded: the placeholders the old page reported are gone, so its views
   * hide until the new page reports again (else they would float over a page that is not there).
   */
  resetWindow(windowId: number): void {
    // Server mode: the window's page is the hidden page, and the placements are the browsers'
    // (index.ts does not call this then; a call must still not hide what browsers show).
    if (this.deps.server === true) return
    const prefix = `${windowId}\0`
    for (const [key, p] of [...this.placements]) {
      if (key.startsWith(prefix)) this.placements.set(key, { ...p, visible: false })
    }
    for (const rec of this.records.values()) if (rec.owner.windowId === windowId) this.apply(rec)
  }

  /** Whether a view would show now (its last report, the window's overlays). For tests. */
  isShown(windowId: number, pluginId: string, panelId: string): boolean {
    const rec = this.records.get(keyOf(windowId, pluginId, panelId))
    return rec !== undefined && this.shown(rec)
  }

  /** The plugin's ctx ended in this window (deactivate, reload, its host gone): its views go. */
  destroyPlugin(windowId: number, pluginId: string): void {
    this.bump(windowId, pluginId)
    for (const [key, rec] of [...this.records]) {
      if (rec.owner.windowId === windowId && rec.owner.pluginId === pluginId) this.drop(key, rec)
    }
    const prefix = `${windowId}\0${pluginId}\0`
    for (const map of [this.navSeq, this.navLoaded, this.deferred]) for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key)
    // Server mode: the viewers and their placements are the browsers' (webview-viewers.ts), not the
    // plugin's: a browser that still shows the panel reports nothing new when the plugin reloads,
    // so forgetting them here would defer the reloaded plugin's `home` for good. A browser whose
    // panel left with the plugin still leaves (its unmount report is taken for that, router.ts).
    if (this.deps.server === true) return
    // The placements too: the panel's unmount report (visible:false) is refused once the panel left
    // the layout, so a stale visible:true would show the next view at the old bounds, panel closed.
    for (const key of [...this.placements.keys()]) if (key.startsWith(prefix)) this.placements.delete(key)
  }

  /** The window closed: every view in it goes, with its tokens and placements. */
  closeWindow(windowId: number): void {
    for (const [key, rec] of [...this.records]) {
      if (rec.owner.windowId === windowId) {
        this.bump(windowId, rec.owner.pluginId)
        this.drop(key, rec)
      }
    }
    const prefix = `${windowId}\0`
    for (const key of [...this.placements.keys()]) if (key.startsWith(prefix)) this.placements.delete(key)
    for (const key of [...this.generations.keys()]) if (key.startsWith(prefix)) this.generations.delete(key)
    for (const map of [this.navSeq, this.navLoaded, this.deferred]) for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key)
    for (const key of [...this.viewed]) if (key.startsWith(prefix)) this.viewed.delete(key)
    this.covered.delete(windowId)
    this.focusDue.delete(windowId)
  }

  /**
   * The folder a `cc-preview` token maps to, for a request from `partition`'s session. Scoped to
   * that session's views: another project's or plugin's token reads like one that does not exist.
   */
  previewFolder(partition: string, token: string): string | undefined {
    if (!PREVIEW_TOKEN_PATTERN.test(token)) return undefined
    for (const rec of this.records.values()) {
      if (rec.partition !== partition) continue
      const folder = rec.tokens.get(token)
      if (folder !== undefined) return folder
    }
    return undefined
  }

  // -------------------------------------------------------------------------------------------

  private find(owner: WebviewOwner): ViewRecord | undefined {
    const rec = this.records.get(keyOf(owner.windowId, owner.pluginId, owner.panelId))
    // The project is part of the owner: a record from another project's host in a reused window id
    // is not this one (window ids are not reused by Electron, but the check costs nothing).
    return rec && rec.owner.projectId === owner.projectId ? rec : undefined
  }

  /**
   * Server mode: a navigate for `key` only records its target (see the top of the file): the
   * panel has no view yet, no browser shows it, and the caller does not wait for the outcome.
   */
  private defers(key: string, options: NavigateOptions): boolean {
    return this.deps.server === true && options.now !== true && !this.records.has(key) && !this.viewed.has(key)
  }

  private urlOf(rec: ViewRecord, resolved: WebviewTarget): string {
    return resolved.kind === 'url' ? resolved.url : this.fileUrl(rec, resolved.folder, resolved.name)
  }

  private recordFor(owner: WebviewOwner): ViewRecord {
    const key = keyOf(owner.windowId, owner.pluginId, owner.panelId)
    const existing = this.records.get(key)
    if (existing && existing.owner.projectId === owner.projectId) return existing
    if (existing) this.drop(key, existing)
    // The one place a view is made, so no path skips the limits. Counted from the records, which
    // a view leaves however it goes (destroyPlugin, closeWindow, its page gone: the off-screen
    // adapter also destroys its window when the project window closes, and `gone` drops it).
    if (this.deps.server === true) {
      let inWindow = 0
      for (const r of this.records.values()) if (r.owner.windowId === owner.windowId) inWindow++
      if (inWindow >= MAX_SERVER_VIEWS_PER_WINDOW || this.records.size >= MAX_SERVER_VIEWS) throw new Error(WEBVIEW_LIMIT_REFUSAL)
    }
    const partition = webviewPartition(owner.projectId, owner.pluginId)
    // The events close over a holder filled once the view exists: an event during `create` (none
    // is expected) finds no record and is refused or ignored.
    const holder: { rec?: ViewRecord } = {}
    const current = (): ViewRecord | undefined => (holder.rec && this.records.get(key) === holder.rec ? holder.rec : undefined)
    const events: WebviewEvents = {
      allowNavigation: (url, isMainFrame) => {
        const rec = current()
        return rec ? this.allowNavigation(rec, url, isMainFrame) : false
      },
      openWindow: (url) => {
        const rec = current()
        if (rec) this.openWindow(rec, url)
      },
      navigated: (commit) => {
        const rec = current()
        if (!rec) return
        // A page committed: whatever failed before it is over. A title change is not a commit.
        if (commit) rec.loadError = undefined
        this.navigated(rec)
      },
      loadFailed: (url, error) => {
        const rec = current()
        if (!rec) return
        rec.loadError = { url: String(url), error: cleanError(error) }
        // No did-navigate for a failed load: without this the toolbar kept the old page (or "No
        // page", Reload disabled).
        this.navigated(rec)
      },
      chord: (chord) => this.deps.chord?.(owner.windowId, chord) ?? false,
      gone: () => {
        // The page crashed or was killed (also fires after our own destroy: then it is no longer
        // the record). The next navigate makes a new view.
        const rec = current()
        if (rec) this.drop(key, rec)
      }
    }
    const view = this.deps.views.create(owner.windowId, partition, events, { ...owner })
    const rec: ViewRecord = { owner: { ...owner }, partition, view, tokens: new Map(), navPending: false, opens: [] }
    holder.rec = rec
    this.records.set(key, rec)
    this.apply(rec)
    return rec
  }

  /** The last report for the view's panel (hidden at zero bounds before the first one). */
  private placementOf(rec: ViewRecord): WebviewPlacement {
    const { windowId, pluginId, panelId } = rec.owner
    return this.placements.get(keyOf(windowId, pluginId, panelId)) ?? { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }
  }

  /**
   * The cover/hide rule: the renderer says it may show, no overlay is open, it has an area. Server
   * mode has no cover rule (see the top of the file): a browser's overlay is a layer over the canvas.
   */
  private shown(rec: ViewRecord): boolean {
    const p = this.placementOf(rec)
    const covered = this.deps.server !== true && this.covered.has(rec.owner.windowId)
    return p.visible && !covered && p.bounds.width > 0 && p.bounds.height > 0
  }

  /** Server mode: merge what webview-viewers.ts decided into the panel's placement, applied now when it has a view. */
  private placeServerView(key: string, patch: Partial<WebviewPlacement>): void {
    const prev = this.placements.get(key) ?? { bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false }
    this.placements.set(key, { ...prev, ...patch })
    const rec = this.records.get(key)
    if (rec) this.apply(rec)
  }

  private apply(rec: ViewRecord): void {
    const visible = this.shown(rec)
    try {
      // Asked before the hide: a hidden view may no longer say it has the keyboard.
      const hadKeyboard = rec.appliedVisible === true && !visible && this.mayHaveKeyboard(rec)
      // Bounds first, so a view coming back shows at its new place, not for a frame at the old one.
      rec.view.setBounds(this.placementOf(rec).bounds)
      rec.view.setVisible(visible)
      if (hadKeyboard) this.handBack(rec.owner.windowId)
      rec.appliedVisible = visible
    } catch (err) {
      this.log(`webview: placing a view failed: ${errorText(err)}`)
    }
  }

  /** The view's token for `folder` (a new one the first time), and the URL of `name` under it. */
  private fileUrl(rec: ViewRecord, folder: string, name: string): string {
    let token: string | undefined
    for (const [t, f] of rec.tokens) if (f === folder) token = t
    if (token !== undefined) {
      // Most recently used goes last: the folder being looked at is the one to keep.
      rec.tokens.delete(token)
      rec.tokens.set(token, folder)
    } else {
      token = this.deps.newToken?.() ?? `t${randomBytes(16).toString('hex')}`
      if (!PREVIEW_TOKEN_PATTERN.test(token)) throw new Error('webview: bad preview token')
      rec.tokens.set(token, folder)
      while (rec.tokens.size > MAX_TOKENS_PER_VIEW) {
        const oldest = rec.tokens.keys().next().value as string
        rec.tokens.delete(oldest)
      }
    }
    return `${PREVIEW_SCHEME}://${token}/${encodeURIComponent(name)}`
  }

  private allowNavigation(rec: ViewRecord, url: string, isMainFrame: boolean): boolean {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }
    if (parsed.protocol === `${PREVIEW_SCHEME}:`) {
      if (rec.tokens.has(parsed.hostname)) return true
      // Another view's token, or one of this view's that was evicted (MAX_TOKENS_PER_VIEW): back
      // to an old page then does nothing, so say why here.
      this.log('webview: refused a cc-preview page whose token is not this view\'s (another view\'s, or evicted)')
      return false
    }
    if (parsed.protocol === 'file:') return false
    if (!isMainFrame) return true
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && url.length <= MAX_URL_LENGTH
  }

  private openWindow(rec: ViewRecord, url: string): void {
    let href: string
    try {
      href = overlayUrlOf(url)
    } catch {
      return
    }
    const now = this.deps.now?.() ?? Date.now()
    rec.opens = rec.opens.filter((t) => now - t < OPEN_WINDOW_MS)
    if (rec.opens.length >= MAX_OPENS_PER_VIEW) {
      this.log(`webview: dropped a window.open past ${MAX_OPENS_PER_VIEW} in ${OPEN_WINDOW_MS / 1000} s`)
      return
    }
    rec.opens.push(now)
    try {
      this.deps.openExternal(href, rec.owner.windowId)
    } catch (err) {
      this.log(`webview: open external failed: ${errorText(err)}`)
    }
  }

  /** Report the page now, or once the coalescing window closes (NAVIGATED_COALESCE_MS). */
  private navigated(rec: ViewRecord): void {
    if (rec.navTimer !== undefined) {
      rec.navPending = true
      return
    }
    this.reportPage(rec)
    rec.navTimer = setTimeout(() => {
      rec.navTimer = undefined
      if (!rec.navPending || !this.isLive(rec)) return
      rec.navPending = false
      // Reports the state at the end of the burst and opens the next window.
      this.navigated(rec)
    }, NAVIGATED_COALESCE_MS)
  }

  private reportPage(rec: ViewRecord): void {
    if (!rec.onNavigate && !this.deps.pageChanged) return
    let page: WebviewPage
    try {
      page = this.pageOf(rec)
    } catch (err) {
      this.log(`webview: reading the page failed: ${errorText(err)}`)
      return
    }
    try {
      rec.onNavigate?.(page)
    } catch (err) {
      this.log(`webview: navigate listener failed: ${errorText(err)}`)
    }
    this.tellWindow(rec.owner, page)
  }

  private tellWindow(owner: WebviewOwner, page: WebviewPage): void {
    if (!this.deps.pageChanged || !this.deps.isWindowOpen(owner.windowId)) return
    try {
      this.deps.pageChanged(owner, page)
    } catch (err) {
      this.log(`webview: telling the window failed: ${errorText(err)}`)
    }
  }

  private drop(key: string, rec: ViewRecord): void {
    // Tokens go with the record: a request for one of them from now on is a 404.
    this.records.delete(key)
    rec.tokens.clear()
    if (rec.navTimer !== undefined) clearTimeout(rec.navTimer)
    rec.navTimer = undefined
    rec.navPending = false
    // Asked before destroy (a closed page has no keyboard to report).
    const hadKeyboard = rec.appliedVisible === true && this.mayHaveKeyboard(rec)
    try {
      rec.view.destroy()
    } catch (err) {
      this.log(`webview: destroying a view failed: ${errorText(err)}`)
    }
    // A showing view that had the keyboard (its page crashed, its plugin was turned off or
    // reloaded): like a hide in apply, hand it to the shell page, or keystrokes go to a closed
    // WebContents until the user clicks (as OverlayManager.changed does for url views). Another
    // view the user is typing into keeps it. Not for a window that is closing (closeWindow drops
    // every view of it).
    if (hadKeyboard && this.deps.isWindowOpen(rec.owner.windowId)) this.handBack(rec.owner.windowId)
    // The toolbar shows no page any more (a closing window is skipped by tellWindow).
    this.tellWindow(rec.owner, { url: '', title: '' })
    if (![...this.records.values()].some((r) => r.partition === rec.partition)) {
      try {
        this.deps.partitionClosed?.(rec.partition)
      } catch (err) {
        this.log(`webview: closing the partition failed: ${errorText(err)}`)
      }
    }
  }

  /**
   * Whether a showing view going away may take the keyboard with it, so focusShell is due: it says
   * it has the keyboard, or no other view of its window does (a crashed page cannot say it had
   * it). Review finding: hiding or dropping panel A must not take the keyboard out of panel B,
   * which the user is typing into. An overlay's url view never has it here: a covered window's
   * views are hidden already, and OverlayManager focuses the overlay after the hide.
   */
  private mayHaveKeyboard(rec: ViewRecord): boolean {
    if (this.focusedView(rec)) return true
    for (const other of this.records.values()) {
      if (other !== rec && other.owner.windowId === rec.owner.windowId && this.focusedView(other)) return false
    }
    return true
  }

  private focusedView(r: ViewRecord): boolean {
    try {
      return r.view.isFocused()
    } catch (err) {
      this.log(`webview: reading the focus failed: ${errorText(err)}`)
      return false
    }
  }

  /** focusShell now in a focused window, else once it is focused again (isWindowFocused). */
  private handBack(windowId: number): void {
    // Server mode: the window's page is the hidden page, which nothing focuses (WindowManager
    // {server}); an off-screen view never has the keyboard to give back anyway.
    if (this.deps.server === true) return
    let focused: boolean
    try {
      focused = this.deps.isWindowFocused?.(windowId) ?? true
    } catch (err) {
      this.log(`webview: reading the window focus failed: ${errorText(err)}`)
      focused = false
    }
    if (focused) this.deps.focusShell?.(windowId)
    else this.focusDue.add(windowId)
  }

  /** The page as reported: the view's, capped, or the failed load's URL and error. */
  private pageOf(rec: ViewRecord): WebviewPage {
    const failed = rec.loadError
    // The empty page Electron commits for a failed load is at that URL, titled with its host: the
    // title says nothing, the error does.
    if (failed) return { url: failed.url.slice(0, MAX_URL_LENGTH), title: '', error: failed.error }
    return cappedPage(rec.view.current())
  }

  private isLive(rec: ViewRecord): boolean {
    return this.records.get(keyOf(rec.owner.windowId, rec.owner.pluginId, rec.owner.panelId)) === rec
  }

  private generation(windowId: number, pluginId: string): number {
    return this.generations.get(pluginKeyOf(windowId, pluginId)) ?? 0
  }

  private bump(windowId: number, pluginId: string): void {
    const key = pluginKeyOf(windowId, pluginId)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
  }
}

/** A page as reported to a plugin: strings, the url cut to MAX_URL_LENGTH, the title to MAX_PAGE_TITLE_LENGTH with no control characters. */
function cappedPage(p: WebviewPage): WebviewPage {
  // The title is the page's own text and is printed on a terminal (`ccc browser url`): control
  // characters (an escape sequence that would recolour, move the cursor or retitle the terminal)
  // become spaces, as plainLine does for manifest text in the CLI. A serialized URL has none.
  // eslint-disable-next-line no-control-regex
  const title = String(p.title).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return { url: String(p.url).slice(0, MAX_URL_LENGTH), title: title.slice(0, MAX_PAGE_TITLE_LENGTH) }
}

/** A load error as reported: one line, no control characters, capped (MAX_LOAD_ERROR_LENGTH). */
function cleanError(error: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(error).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, MAX_LOAD_ERROR_LENGTH)
  return clean === '' ? 'failed to load' : clean
}

/**
 * The outcome of a load, waited for at most `ms`: the error text of a failure, undefined for a
 * load that finished, was superseded or is still going. Never rejects: a failure after the wait
 * is left to loadFailed (an unhandled rejection would be logged as a crash).
 */
function settled(load: Promise<void>, ms: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    load.then(
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
      (err: unknown) => {
        clearTimeout(timer)
        resolve(errorText(err))
      }
    )
  })
}

/** Finite, non-negative, whole DIPs: a renderer report is input, a NaN must not reach Electron. */
function cleanBounds(b: ViewBounds | undefined): ViewBounds {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(Math.min(v, 100_000)) : 0)
  return { x: n(b?.x), y: n(b?.y), width: n(b?.width), height: n(b?.height) }
}

/**
 * The shell command a chord typed into a webview runs, or undefined to leave the key to the page.
 * `lookup` is the window's key table (main's command registry with the user's overrides). Left to
 * the page: a chord no command has; the overlay keys (Esc and Cmd+Shift+W act on an overlay only,
 * and overlays.handleChord already had them: forwarding Esc would eat every Escape a page needs);
 * and a chord without Cmd, Ctrl or Alt, so that typing into a page's text field never fires a
 * command bound to a bare key.
 */
export function forwardedCommand(chord: string, lookup: (chord: string) => string | undefined): string | undefined {
  const mods = splitChord(chord)?.mods ?? []
  if (!mods.some((m) => m === 'meta' || m === 'ctrl' || m === 'alt')) return undefined
  const id = lookup(chord)
  if (id === undefined || id === 'overlay.pop' || id === 'overlay.closeTop') return undefined
  return id
}

/** What `webviewChord` needs from main (index.ts wires the overlay manager, registry and windows). */
export interface WebviewChordDeps {
  /** overlays.handleChord: true when an overlay of the window took the chord. */
  overlayChord(windowId: number, chord: string): boolean
  /** The window's key table: the command bound to `chord`, if any. */
  commandFor(windowId: number, chord: string): string | undefined
  /** The window's shell page, or undefined when the window is gone. */
  shell(windowId: number): { focus(): void; trigger(id: string): void } | undefined
}

/**
 * The WebviewManager `chord` dep: a chord typed into a view of `windowId`. The overlay keys first
 * (an overlay is up), then an app command (forwardedCommand says which chords), sent to that
 * window's own shell page only (`commands.trigger`, which runs it through the page's modal gate,
 * command-gate.ts), with the keyboard handed back to the page first since the command acts on the
 * shell (a new tab's terminal must get the keys that follow). True when the chord was taken.
 */
export function webviewChord(deps: WebviewChordDeps, windowId: number, chord: string): boolean {
  if (deps.overlayChord(windowId, chord)) return true
  const id = forwardedCommand(chord, (c) => deps.commandFor(windowId, c))
  if (id === undefined) return false
  const shell = deps.shell(windowId)
  if (!shell) return false
  shell.focus()
  shell.trigger(id)
  return true
}
