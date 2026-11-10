// Which view sizes a tab's pty (design-web.md §5.2 "Size", plan Task 15).
//
// A tab can be shown by several views at once (the desktop window and browsers, a phone among
// them), each with its own pane size. One pty has one size, and every resize redraws Claude's whole
// screen, so the pty does not follow every view's resize observer: main remembers each view's size
// and the pty takes a view's size only when that view explicitly takes the terminal:
//
// - typing after another view typed: the take waits TAKE_DEBOUNCE_MS, and the sizing view typing
//   meanwhile cancels it, so a phone and a desktop typing in turn do not redraw Claude per keystroke;
// - "Fit to this screen" (`tabs.fit`), at once.
//
// The sizing view's own resizes apply at once (dragging the desktop window still reflows Claude,
// as today). A view that is not the sizer is only remembered; it draws at the pty's size (scaled or
// letterboxed, terminal-session.ts) until it takes. With only the desktop (web access off), it is
// always the sizer: today's behaviour.
//
// Hidden views (a minimized window, a browser tab in the background: `tabs.visibility`) never take:
// a size nobody looks at must not shrink Claude for the person who does. When the sizing view
// leaves (its connection closed) or is hidden, the size falls back to the remaining visible view that
// was active last (typed or reported a size); with none, the pty keeps its size, and the first view
// that shows again takes it. A hidden view that is the tab's only view still sizes it (nobody else
// can: a restarted tab in a minimized window must not stay at 80 x 24).
//
// View ids come from main (router CallView, never a payload); tab ids are checked by TabManager
// before they get here. No Electron, no timers of its own beyond the injected ones: vitest drives it.

import type { ViewId } from '../../shared/views'

/** How long a view typing in a tab another view sizes waits before it takes the size. */
export const TAKE_DEBOUNCE_MS = 500

export interface TerminalSizesDeps {
  /** Resize the tab's pty (TabManager: PtyService.resize, the tap and the desktop's size item). */
  apply(tabId: string, cols: number, rows: number): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  debounceMs?: number
}

interface ViewSize {
  cols: number
  rows: number
  /** Activity order (a report or a key): the fallback picks the latest. */
  at: number
}

interface TabSizes {
  views: Map<ViewId, ViewSize>
  /** The view whose size the pty has (or last took); undefined until one sizes it. */
  sizer: ViewId | undefined
  /** A typing take waiting out the debounce. */
  pending: { viewId: ViewId; timer: unknown } | undefined
}

export class TerminalSizes {
  private readonly tabs = new Map<string, TabSizes>()
  private readonly hidden = new Set<ViewId>()
  private clock = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly debounceMs: number

  constructor(private readonly deps: TerminalSizesDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.debounceMs = deps.debounceMs ?? TAKE_DEBOUNCE_MS
  }

  /**
   * A view measured the tab's pane (its resize observer). Remembered; applied when the view sizes
   * the tab, or becomes the sizer because nobody does yet.
   */
  report(tabId: string, viewId: ViewId, cols: number, rows: number): void {
    const t = this.tab(tabId)
    t.views.set(viewId, { cols, rows, at: ++this.clock })
    if (t.sizer === viewId) {
      if (this.canSize(t, viewId)) this.deps.apply(tabId, cols, rows)
      return
    }
    // Nobody sizes the tab (a new tab, or the sizer left with no visible view to fall back to).
    if ((t.sizer === undefined || !this.sizes(t, t.sizer)) && this.canSize(t, viewId)) this.become(tabId, t, viewId)
  }

  /** The view sent input to the tab: a view that does not size it takes it after the debounce. */
  typed(tabId: string, viewId: ViewId): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    const own = t.views.get(viewId)
    if (own) own.at = ++this.clock
    if (t.sizer === viewId) {
      // The sizing view typed again: whoever was about to take waits for its next key.
      this.cancel(t)
      return
    }
    if (!own || this.hidden.has(viewId)) return
    if (t.pending?.viewId === viewId) return
    this.cancel(t)
    const timer = this.setTimer(() => {
      if (this.tabs.get(tabId) !== t || t.pending?.timer !== timer) return
      t.pending = undefined
      this.take(tabId, viewId)
    }, this.debounceMs)
    t.pending = { viewId, timer }
  }

  /**
   * The view takes the tab's size now ("Fit to this screen", or a typing take). False when it has
   * no size for the tab yet or is hidden.
   */
  take(tabId: string, viewId: ViewId): boolean {
    const t = this.tabs.get(tabId)
    if (!t || !t.views.has(viewId) || this.hidden.has(viewId)) return false
    this.become(tabId, t, viewId)
    return true
  }

  /** The view was hidden or shown (every tab of it). */
  visible(viewId: ViewId, visible: boolean): void {
    if (visible === !this.hidden.has(viewId)) return
    if (visible) this.hidden.delete(viewId)
    else this.hidden.add(viewId)
    for (const [tabId, t] of this.tabs) {
      if (!visible) {
        if (t.pending?.viewId === viewId) this.cancel(t)
        if (t.sizer === viewId) this.fallback(tabId, t)
      } else if (t.views.has(viewId) && (t.sizer === undefined || !this.sizes(t, t.sizer))) {
        // Nobody visible sizes the tab: the view that shows again takes it.
        this.become(tabId, t, viewId)
      }
    }
  }

  /** The view is gone (its connection closed, its window closed). */
  viewGone(viewId: ViewId): void {
    this.hidden.delete(viewId)
    for (const [tabId, t] of this.tabs) {
      if (t.pending?.viewId === viewId) this.cancel(t)
      if (!t.views.delete(viewId)) continue
      if (t.sizer === viewId) this.fallback(tabId, t)
    }
  }

  /** The tab is gone. */
  tabGone(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.cancel(t)
    this.tabs.delete(tabId)
  }

  /** The view that sizes the tab (tests, diagnostics). */
  sizerOf(tabId: string): ViewId | undefined {
    return this.tabs.get(tabId)?.sizer
  }

  /** The size the view last reported for the tab (TabManager: a restart spawns at the sizer's). */
  sizeOf(tabId: string, viewId?: ViewId): { cols: number; rows: number } | undefined {
    const t = this.tabs.get(tabId)
    const id = viewId ?? t?.sizer
    const size = id === undefined ? undefined : t?.views.get(id)
    return size ? { cols: size.cols, rows: size.rows } : undefined
  }

  private tab(tabId: string): TabSizes {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { views: new Map(), sizer: undefined, pending: undefined }
      this.tabs.set(tabId, t)
    }
    return t
  }

  /** Whether `viewId` sizes the tab now: the sizer, still there and allowed to size. */
  private sizes(t: TabSizes, viewId: ViewId): boolean {
    return t.views.has(viewId) && this.canSize(t, viewId)
  }

  /** A visible view may size; a hidden one only when it is the tab's only view. */
  private canSize(t: TabSizes, viewId: ViewId): boolean {
    return !this.hidden.has(viewId) || (t.views.size === 1 && t.views.has(viewId))
  }

  private become(tabId: string, t: TabSizes, viewId: ViewId): void {
    const size = t.views.get(viewId)
    if (!size) return
    this.cancel(t)
    t.sizer = viewId
    this.deps.apply(tabId, size.cols, size.rows)
  }

  /** The sizer left or was hidden: the visible view active last takes over; none, the size stays. */
  private fallback(tabId: string, t: TabSizes): void {
    let next: ViewId | undefined
    let at = -1
    for (const [viewId, size] of t.views) {
      if (this.hidden.has(viewId) || size.at <= at) continue
      next = viewId
      at = size.at
    }
    // A lone hidden view left (the desktop minimized after the browser went): it sizes, as canSize.
    if (next === undefined && t.views.size === 1) next = t.views.keys().next().value
    if (next === undefined) {
      t.sizer = undefined
      return
    }
    this.become(tabId, t, next)
  }

  private cancel(t: TabSizes): void {
    if (!t.pending) return
    this.clearTimer(t.pending.timer)
    t.pending = undefined
  }
}
