// Who looks at a server's off-screen webview, and whose size it has (design-web-browser.md §3.2;
// plan 20261111-streamed-webviews.md Task 4). Server mode only: on the desktop a webview panel is
// a native view the window's own page places (`webviews.placement`), and nothing here runs.
//
// Every browser view that shows a webview panel reports its placeholder (`webviews.place`, router.ts):
// its size in CSS px, whether the panel is mounted and on screen (`visible`) and whether the browser
// tab is in the background (`hidden`, `document.hidden`). From those, per webview panel of a window:
//
//   viewers   the browser views of THAT window that report the panel visible, not hidden, with an
//             area; the router keys a report by the window and view main bound the caller to, and
//             the panel by main's own layout, so a view of another window can never join (its
//             report names a panel of its own window, or is refused). A view leaves when it
//             reports otherwise, when it goes (viewGone: the socket closed) and with its window.
//   owner     the one viewer whose size the page has: the first viewer to report, until another
//             viewer claims it (claimOwner: a press, a key or text from it, Task 7; or its "Fit to
//             this screen", `webviews.fit`). An owner that leaves hands the size to the viewer
//             active last (a report or a claim), the terminal's rule (view-sizes.ts). Other
//             viewers show the frame letterboxed (Task 6).
//   size      the owner's report, clamped to [MIN_PLACE_SIDE, MAX_PLACE_SIDE] CSS px, applied to
//             the view at most once per RESIZE_THROTTLE_MS: the first at once, later ones on the
//             trailing edge, so a dragged splitter does not reflow the page per pixel and its final
//             size still lands. With no viewer left the last applied size stays (the next owner's
//             report replaces it).
//
// What it drives (`deps`, the WebviewManager in the app): the first viewer of a panel `setViewed`
// true (the deferred load of Task 2 runs then, and the view starts painting), the last one leaving
// `setViewed` false (the view stops painting); the size `setSize`. The size of a new first viewer
// goes before its `setViewed`, so a view made for it starts at its size.
//
// For the frame stream (Task 5): `viewers(panel)` (in join order), `isViewer`, `ownerOf`, `sizeOf`,
// and `onChange` (a viewer added or removed, the applied size, the owner). A listener that throws is
// logged, never breaks a report.
//
// Pure: no Electron, timers and clock injected (vitest drives them). View ids are main's (router
// CallView, never a payload), panels are main's (LayoutService.webviewPanel, never a payload).

import { errorText } from '../../shared/error-text'
import type { ViewId } from '../../shared/views'
import { warnLog } from '../warn-log'

/** Smallest side, CSS px, a report is clamped to: a sliver of a panel still gets a usable page. */
export const MIN_PLACE_SIDE = 64
/** Largest side, CSS px (design-web-browser.md §5): the frame's layout size is capped there. */
export const MAX_PLACE_SIDE = 4096
/** At most one resize per this many ms per webview (§3.2: a dragged splitter). */
export const RESIZE_THROTTLE_MS = 100

/** A webview panel of a window, by main's ids (the window's own layout resolved the key). */
export interface WebviewPanelOf {
  windowId: number
  pluginId: string
  panelId: string
}

export interface PlaceSize {
  width: number
  height: number
}

/** One view's placement report, as the router checked it (finite numbers, booleans). */
export interface PlaceReport {
  width: number
  height: number
  /** The panel is mounted and on screen in that view. */
  visible: boolean
  /** The browser tab is in the background (`document.hidden`): it shows nothing. */
  hidden: boolean
}

export type ViewersChange =
  | { kind: 'added'; panel: WebviewPanelOf; viewId: ViewId }
  | { kind: 'removed'; panel: WebviewPanelOf; viewId: ViewId }
  | { kind: 'size'; panel: WebviewPanelOf; size: PlaceSize }
  | { kind: 'owner'; panel: WebviewPanelOf; viewId: ViewId | undefined }

export interface WebviewViewersDeps {
  /** A panel got its first viewer (true) or lost its last (false): WebviewManager.setViewed. */
  setViewed(windowId: number, pluginId: string, panelId: string, viewed: boolean): void
  /** The size the panel's page is to have: WebviewManager.setViewSize. */
  setSize(windowId: number, pluginId: string, panelId: string, size: PlaceSize): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
  log?: (message: string) => void
}

/**
 * A report's side as the page may take it: a whole number in [MIN_PLACE_SIDE, MAX_PLACE_SIDE], or
 * undefined for a value that is no finite number (the router refuses those before this). A zero
 * or negative side is clamped like any other; whether the panel has an area is `hasArea`'s call.
 */
export function clampSide(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(MAX_PLACE_SIDE, Math.max(MIN_PLACE_SIDE, Math.round(value)))
}

/** Whether a report's raw sides make an area at all: a collapsed panel (0 px) shows nothing. */
function hasArea(report: PlaceReport): boolean {
  return report.width >= 1 && report.height >= 1
}

interface ViewerState {
  size: PlaceSize
  /** Activity order (a report or a claim): an owner leaving hands the size to the latest. */
  at: number
}

interface PanelState {
  panel: WebviewPanelOf
  /** Current viewers, in join order. */
  viewers: Map<ViewId, ViewerState>
  owner: ViewId | undefined
  /** The size the owner wants (applied, or waiting for the throttle). */
  want: PlaceSize | undefined
  /** The size last given to deps.setSize. */
  applied: PlaceSize | undefined
  /** When the last setSize ran (deps.now). */
  appliedAt: number | undefined
  timer: unknown
}

function keyOf(windowId: number, pluginId: string, panelId: string): string {
  return `${windowId}\0${pluginId}\0${panelId}`
}

function sameSize(a: PlaceSize | undefined, b: PlaceSize | undefined): boolean {
  return a !== undefined && b !== undefined && a.width === b.width && a.height === b.height
}

export class WebviewViewers {
  private readonly panels = new Map<string, PanelState>()
  private readonly listeners = new Set<(change: ViewersChange) => void>()
  private clock = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(private readonly deps: WebviewViewersDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? warnLog
  }

  /**
   * A browser view's placement report for a panel of its own window. Visible, not hidden and with
   * an area: the view is (or stays) a viewer at the clamped size; otherwise it leaves the panel.
   */
  report(panel: WebviewPanelOf, viewId: ViewId, report: PlaceReport): void {
    const width = clampSide(report.width)
    const height = clampSide(report.height)
    const key = keyOf(panel.windowId, panel.pluginId, panel.panelId)
    if (width === undefined || height === undefined || !report.visible || report.hidden || !hasArea(report)) {
      this.remove(key, viewId)
      return
    }
    const size = { width, height }
    let state = this.panels.get(key)
    if (!state) {
      state = { panel: { ...panel }, viewers: new Map(), owner: undefined, want: undefined, applied: undefined, appliedAt: undefined, timer: undefined }
      this.panels.set(key, state)
    }
    const joined = !state.viewers.has(viewId)
    state.viewers.set(viewId, { size, at: ++this.clock })
    if (joined) {
      const first = state.viewers.size === 1
      // An owner is always a viewer (it is handed on when it leaves), so only a first one sets it.
      if (state.owner === undefined) this.setOwner(state, viewId)
      // The size first, so a view the first viewer makes (a deferred load) starts at that size.
      if (first) this.call(() => this.deps.setViewed(panel.windowId, panel.pluginId, panel.panelId, true))
      this.emit({ kind: 'added', panel: state.panel, viewId })
      return
    }
    if (state.owner === viewId) this.want(state, size)
  }

  /**
   * `viewId` acted on the panel (a press, a key, text: Task 7) or asked "Fit to this screen": it
   * becomes the owner and the page takes its size. Ignored from a view that is not a viewer now.
   */
  claimOwner(panel: WebviewPanelOf, viewId: ViewId): void {
    const state = this.panels.get(keyOf(panel.windowId, panel.pluginId, panel.panelId))
    const viewer = state?.viewers.get(viewId)
    if (!state || !viewer) return
    viewer.at = ++this.clock
    if (state.owner === viewId) return
    this.setOwner(state, viewId)
  }

  /**
   * A panel key the window's layout no longer resolves (its plugin turned off): the view's
   * unmount report still has to take it off the panel, or it would stay a viewer of a panel it
   * no longer shows. Only `viewId`'s own entry in `windowId` is touched: nothing to add, nothing of
   * another view or window to reach.
   */
  leave(windowId: number, viewId: ViewId, panelKey: string): void {
    for (const [key, state] of [...this.panels]) {
      const { panel } = state
      if (panel.windowId === windowId && `${panel.pluginId}/${panel.panelId}` === panelKey) this.remove(key, viewId)
    }
  }

  /** A view went (its socket closed): it leaves every panel it was a viewer of. */
  viewGone(viewId: ViewId): void {
    for (const key of [...this.panels.keys()]) this.remove(key, viewId)
  }

  /** The window closed: its panels go, with no `setViewed` (the manager drops the views itself). */
  closeWindow(windowId: number): void {
    for (const [key, state] of [...this.panels]) {
      if (state.panel.windowId !== windowId) continue
      if (state.timer !== undefined) this.clearTimer(state.timer)
      this.panels.delete(key)
      for (const viewId of state.viewers.keys()) this.emit({ kind: 'removed', panel: state.panel, viewId })
    }
  }

  /** The panel's viewers now, in join order. */
  viewers(panel: WebviewPanelOf): ViewId[] {
    return [...(this.stateOf(panel)?.viewers.keys() ?? [])]
  }

  isViewer(panel: WebviewPanelOf, viewId: ViewId): boolean {
    return this.stateOf(panel)?.viewers.has(viewId) === true
  }

  /** The viewer whose size the page has, undefined with no viewer. */
  ownerOf(panel: WebviewPanelOf): ViewId | undefined {
    return this.stateOf(panel)?.owner
  }

  /** The size last applied to the page (after the throttle), undefined before the first. */
  sizeOf(panel: WebviewPanelOf): PlaceSize | undefined {
    const applied = this.stateOf(panel)?.applied
    return applied ? { ...applied } : undefined
  }

  /** Hear every change; returns the unsubscribe. */
  onChange(listener: (change: ViewersChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // -------------------------------------------------------------------------------------------

  private stateOf(panel: WebviewPanelOf): PanelState | undefined {
    return this.panels.get(keyOf(panel.windowId, panel.pluginId, panel.panelId))
  }

  private remove(key: string, viewId: ViewId): void {
    const state = this.panels.get(key)
    if (!state || !state.viewers.delete(viewId)) return
    const { panel } = state
    if (state.viewers.size === 0) {
      // Nobody shows it: the page stops painting; the applied size stays as the view has it. The
      // entry goes, so a view gone for good leaves nothing behind (and the next first viewer is
      // the owner, applied at once, as the very first).
      if (state.timer !== undefined) this.clearTimer(state.timer)
      this.panels.delete(key)
      this.call(() => this.deps.setViewed(panel.windowId, panel.pluginId, panel.panelId, false))
      this.emit({ kind: 'removed', panel, viewId })
      this.emit({ kind: 'owner', panel, viewId: undefined })
      return
    }
    this.emit({ kind: 'removed', panel, viewId })
    if (state.owner !== viewId) return
    let next: ViewId | undefined
    let at = -1
    for (const [id, v] of state.viewers) {
      if (v.at > at) {
        next = id
        at = v.at
      }
    }
    if (next !== undefined) this.setOwner(state, next)
  }

  private setOwner(state: PanelState, viewId: ViewId): void {
    state.owner = viewId
    this.emit({ kind: 'owner', panel: state.panel, viewId })
    const viewer = state.viewers.get(viewId)
    if (viewer) this.want(state, viewer.size)
  }

  /** The owner's size: at once when the last resize was RESIZE_THROTTLE_MS ago, else trailing. */
  private want(state: PanelState, size: PlaceSize): void {
    state.want = { ...size }
    if (state.timer !== undefined) return
    const since = state.appliedAt === undefined ? Infinity : this.now() - state.appliedAt
    if (since >= RESIZE_THROTTLE_MS) {
      this.applySize(state)
      return
    }
    state.timer = this.setTimer(() => {
      state.timer = undefined
      // The panel may have lost its viewers (then its state left the table) meanwhile.
      if (this.panels.get(keyOf(state.panel.windowId, state.panel.pluginId, state.panel.panelId)) === state) this.applySize(state)
    }, RESIZE_THROTTLE_MS - since)
  }

  private applySize(state: PanelState): void {
    const size = state.want
    if (!size || sameSize(size, state.applied)) return
    state.applied = { ...size }
    state.appliedAt = this.now()
    const { panel } = state
    this.call(() => this.deps.setSize(panel.windowId, panel.pluginId, panel.panelId, { ...size }))
    this.emit({ kind: 'size', panel, size: { ...size } })
  }

  private call(fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log(`webview viewers: applying a change failed: ${errorText(err)}`)
    }
  }

  private emit(change: ViewersChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (err) {
        this.log(`webview viewers: a listener failed: ${errorText(err)}`)
      }
    }
  }
}
