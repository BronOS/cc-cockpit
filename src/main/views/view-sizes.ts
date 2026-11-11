// Which view sizes a pty shown by several views (design-web.md §5.2 "Size"): the one rule behind
// a tab's pty (tabs/terminal-sizes.ts, TabManager) and a terminal overlay's (OverlayManager). The
// key is opaque to it (a tab id, an overlay id); it only remembers each view's size per key and
// tells `apply` when the pty takes one. The full description of the rule is at the top of
// terminal-sizes.ts; in short:
//
// - each view's measured size is remembered; the pty takes it only when that view sizes the key;
// - the sizing view's own resizes apply at once; nobody sizing yet, the first view to report sizes;
// - typing in a view that does not size the key takes it after `debounceMs` (0: at once, the
//   terminal overlays' rule), and the sizing view typing meanwhile cancels the take;
// - hidden views never take, unless the key has no other view; a hidden or departed sizer hands the
//   size to the visible view active last (a report or a key), and with none the size stays until a
//   view shows again;
// - a view `measured` says no to (server mode's hidden page, design-web.md §9.8) is never one of a
//   key's views: its reports are dropped, so it never sizes a pty, not even as a key's only view.
//
// Kept generic so the two users cannot drift apart (they did: overlays had a copy of this rule).
// View ids come from main (router CallView, never a payload); keys are checked by the caller before
// they get here. No Electron, no timers of its own beyond the injected ones: vitest drives it.

import type { ViewId } from '../../shared/views'

/** How long a view typing in a tab another view sizes waits before it takes the size. */
export const TAKE_DEBOUNCE_MS = 500

export interface ViewSizesDeps<K> {
  /** Resize the key's pty. */
  apply(key: K, cols: number, rows: number): void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** The typing take's wait; 0 takes at once, synchronously. Default TAKE_DEBOUNCE_MS. */
  debounceMs?: number
  /**
   * Whether the view may be a measured view at all. Absent: every view is. Server mode answers no for
   * the hidden page (design-web.md §9.8): nobody looks at it, and as a key's only view it would
   * otherwise size the pty to its 480x320 window whenever no browser is attached.
   */
  measured?: (viewId: ViewId) => boolean
}

interface ViewSize {
  cols: number
  rows: number
  /** Activity order (a report or a key): the fallback picks the latest. */
  at: number
}

interface KeySizes {
  views: Map<ViewId, ViewSize>
  /** The view whose size the pty has (or last took); undefined until one sizes it. */
  sizer: ViewId | undefined
  /** A typing take waiting out the debounce. */
  pending: { viewId: ViewId; timer: unknown } | undefined
}

export class ViewSizes<K = string> {
  private readonly keys = new Map<K, KeySizes>()
  private readonly hidden = new Set<ViewId>()
  private clock = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly debounceMs: number

  constructor(private readonly deps: ViewSizesDeps<K>) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.debounceMs = deps.debounceMs ?? TAKE_DEBOUNCE_MS
  }

  /**
   * A view measured the key's pane (its resize observer). Remembered; applied when the view sizes
   * the key, or becomes the sizer because nobody does yet.
   */
  report(key: K, viewId: ViewId, cols: number, rows: number): void {
    // Not even remembered: with no entry it can never take (typed, take and visible find nothing).
    if (this.deps.measured && !this.deps.measured(viewId)) return
    const t = this.entry(key)
    t.views.set(viewId, { cols, rows, at: ++this.clock })
    if (t.sizer === viewId) {
      if (this.canSize(t, viewId)) this.deps.apply(key, cols, rows)
      return
    }
    // Nobody sizes the key (a new one, or the sizer left with no visible view to fall back to).
    if ((t.sizer === undefined || !this.sizes(t, t.sizer)) && this.canSize(t, viewId)) this.become(key, t, viewId)
  }

  /** The view sent input to the key: a view that does not size it takes it after the debounce. */
  typed(key: K, viewId: ViewId): void {
    const t = this.keys.get(key)
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
    if (this.debounceMs <= 0) {
      this.become(key, t, viewId)
      return
    }
    const timer = this.setTimer(() => {
      if (this.keys.get(key) !== t || t.pending?.timer !== timer) return
      t.pending = undefined
      this.take(key, viewId)
    }, this.debounceMs)
    t.pending = { viewId, timer }
  }

  /**
   * The view takes the key's size now ("Fit to this screen", or a typing take). False when it has
   * no size for the key yet or is hidden.
   */
  take(key: K, viewId: ViewId): boolean {
    const t = this.keys.get(key)
    if (!t || !t.views.has(viewId) || this.hidden.has(viewId)) return false
    this.become(key, t, viewId)
    return true
  }

  /** The view was hidden or shown (every key of it). */
  visible(viewId: ViewId, visible: boolean): void {
    if (visible === !this.hidden.has(viewId)) return
    if (visible) this.hidden.delete(viewId)
    else this.hidden.add(viewId)
    for (const [key, t] of this.keys) {
      if (!visible) {
        if (t.pending?.viewId === viewId) this.cancel(t)
        if (t.sizer === viewId) this.fallback(key, t)
      } else if (t.views.has(viewId) && (t.sizer === undefined || !this.sizes(t, t.sizer))) {
        // Nobody visible sizes the key: the view that shows again takes it.
        this.become(key, t, viewId)
      }
    }
  }

  /** The view is gone (its connection closed, its window closed). */
  viewGone(viewId: ViewId): void {
    this.hidden.delete(viewId)
    for (const [key, t] of this.keys) {
      if (t.pending?.viewId === viewId) this.cancel(t)
      if (!t.views.delete(viewId)) continue
      if (t.sizer === viewId) this.fallback(key, t)
    }
  }

  /**
   * Only the view's hidden mark goes, its sizes stay: a desktop view whose window is closing, whose
   * keys (overlays) end with it right after, so none of them is resized on the way out.
   */
  forgetHidden(viewId: ViewId): void {
    this.hidden.delete(viewId)
  }

  /** The key is gone (its tab or overlay ended). */
  forget(key: K): void {
    const t = this.keys.get(key)
    if (!t) return
    this.cancel(t)
    this.keys.delete(key)
  }

  /** The view that sizes the key. */
  sizerOf(key: K): ViewId | undefined {
    return this.keys.get(key)?.sizer
  }

  /** The size the view (default: the sizer) last reported for the key. */
  sizeOf(key: K, viewId?: ViewId): { cols: number; rows: number } | undefined {
    const t = this.keys.get(key)
    const id = viewId ?? t?.sizer
    const size = id === undefined ? undefined : t?.views.get(id)
    return size ? { cols: size.cols, rows: size.rows } : undefined
  }

  private entry(key: K): KeySizes {
    let t = this.keys.get(key)
    if (!t) {
      t = { views: new Map(), sizer: undefined, pending: undefined }
      this.keys.set(key, t)
    }
    return t
  }

  /** Whether `viewId` sizes the key now: the sizer, still there and allowed to size. */
  private sizes(t: KeySizes, viewId: ViewId): boolean {
    return t.views.has(viewId) && this.canSize(t, viewId)
  }

  /** A visible view may size; a hidden one only when it is the key's only view. */
  private canSize(t: KeySizes, viewId: ViewId): boolean {
    return !this.hidden.has(viewId) || (t.views.size === 1 && t.views.has(viewId))
  }

  private become(key: K, t: KeySizes, viewId: ViewId): void {
    const size = t.views.get(viewId)
    if (!size) return
    this.cancel(t)
    t.sizer = viewId
    this.deps.apply(key, size.cols, size.rows)
  }

  /** The sizer left or was hidden: the visible view active last takes over; none, the size stays. */
  private fallback(key: K, t: KeySizes): void {
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
    this.become(key, t, next)
  }

  private cancel(t: KeySizes): void {
    if (!t.pending) return
    this.clearTimer(t.pending.timer)
    t.pending = undefined
  }
}
