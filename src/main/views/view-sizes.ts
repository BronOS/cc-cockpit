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
//   key's views: its reports are dropped, so it never sizes a pty, not even as a key's only view;
// - a fallback is not the person's choice, so it is undone: the view the size fell from takes it
//   back when it shows again, or, gone, the next view of the same `lineage` (the same signed-in
//   device: a browser reconnecting gets a fresh view id) when it reports a size for the key, unless
//   a view explicitly took the key (typing, "Fit to this screen") in between;
// - with `reconnectGraceMs`, a sizer of a lineage that leaves keeps the size that long before it
//   falls back: a dropped socket that reconnects within it changes nothing on the pty at all;
// - a guest's view (design-guests §8, D-14) reports `explicitOnly`: it takes the size only by an explicit act
//   (typing, "Fit to this screen"), never by a first report, by showing again, as an heir or as a fallback, so
//   a small guest screen never resizes the owner's terminal by itself.
//
// Kept generic so the two users cannot drift apart (they did: overlays had a copy of this rule).
// View ids come from main (router CallView, never a payload); keys are checked by the caller before
// they get here. No Electron, no timers of its own beyond the injected ones: vitest drives it.

import type { ViewId } from '../../shared/views'

/** How long a view typing in a tab another view sizes waits before it takes the size. */
export const TAKE_DEBOUNCE_MS = 500

/**
 * How long a tab's size stays with a browser view that dropped, for its device to reconnect
 * (`reconnectGraceMs`). Covers the page's first retry (0.5 s, rounded up to a second in a
 * background-throttled page), the new socket's `ready` and the remount's first size report, with
 * room for a slow tunnel; a view that does not come back hands the size on after it.
 */
export const RECONNECT_GRACE_MS = 5000

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
  /**
   * Which views stand for the same screen across a reconnect (the signed-in device behind a browser
   * view); undefined for a view with no such tie (the desktop's, None's anonymous browsers). Asked
   * when a view first reports a size for a key, and kept with that size.
   */
  lineage?: (viewId: ViewId) => string | undefined
  /**
   * How long a sizing view of a lineage that is gone keeps the size before it falls back (0 or
   * absent: at once). Tabs only (TabManager): a tab's queries are answered by main's headless copy,
   * where a terminal overlay's are answered by its sizer, which must be a live view.
   */
  reconnectGraceMs?: number
}

interface ViewSize {
  cols: number
  rows: number
  /** Activity order (a report or a key): the fallback picks the latest. */
  at: number
  /** The view's lineage (ViewSizesDeps.lineage), read on its first report for the key. */
  lineage: string | undefined
  /** A guest's view (D-14): only an explicit act (typing, Fit) makes it the sizer. */
  explicitOnly: boolean
}

interface KeySizes {
  views: Map<ViewId, ViewSize>
  /** The view whose size the pty has (or last took); undefined until one sizes it. */
  sizer: ViewId | undefined
  /** A typing take waiting out the debounce. */
  pending: { viewId: ViewId; timer: unknown } | undefined
  /**
   * The sizer the size fell from (hidden or gone, `fallback`), until it or its lineage takes it
   * back or a view explicitly takes the key. A reconnect is not a choice either: without this, each
   * drop of a browser's socket left the pty at another screen's size for good.
   */
  departed: { viewId: ViewId; lineage: string | undefined } | undefined
  /**
   * The sizer is gone and its lineage may reconnect (`reconnectGraceMs`): `sizer` still names it and
   * the pty keeps its size, with `size` for sizeOf (a restart meanwhile), until this timer falls back.
   */
  grace: { timer: unknown; size: { cols: number; rows: number } } | undefined
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
  report(key: K, viewId: ViewId, cols: number, rows: number, explicitOnly = false): void {
    // Not even remembered: with no entry it can never take (typed, take and visible find nothing).
    if (this.deps.measured && !this.deps.measured(viewId)) return
    const t = this.entry(key)
    const known = t.views.get(viewId)
    const lineage = known ? known.lineage : this.deps.lineage?.(viewId)
    // Sticky per key: a view that once reported as a guest's stays one (its `who` is frozen at hello).
    const guest = explicitOnly || known?.explicitOnly === true
    t.views.set(viewId, { cols, rows, at: ++this.clock, lineage, explicitOnly: guest })
    if (t.sizer === viewId) {
      if (this.canSize(t, viewId)) this.deps.apply(key, cols, rows)
      return
    }
    // D-14: a guest's report is remembered for its explicit take, never taken by itself.
    if (guest) return
    // The view the size fell from (or its device, reconnected) is back and visible: it sizes again.
    if (this.heir(t, viewId) && !this.hidden.has(viewId)) return this.become(key, t, viewId)
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
      this.become(key, t, viewId, true)
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
    this.become(key, t, viewId, true)
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
        if (t.sizer === viewId) this.fallback(key, t, viewId, t.views.get(viewId)?.lineage)
      } else if (t.views.has(viewId) && t.views.get(viewId)?.explicitOnly !== true && (t.sizer === undefined || !this.sizes(t, t.sizer) || this.heir(t, viewId))) {
        // Nobody visible sizes the key, or the size fell from this view when it was hidden and
        // nobody took it since: the view that shows again takes it.
        this.become(key, t, viewId)
      }
    }
  }

  /** The view is gone (its connection closed, its window closed). */
  viewGone(viewId: ViewId): void {
    this.hidden.delete(viewId)
    for (const [key, t] of this.keys) {
      if (t.pending?.viewId === viewId) this.cancel(t)
      const size = t.views.get(viewId)
      if (!size) continue
      t.views.delete(viewId)
      if (t.sizer === viewId && size.lineage !== undefined && (this.deps.reconnectGraceMs ?? 0) > 0) this.hold(key, t, viewId, size)
      else if (t.sizer === viewId) this.fallback(key, t, viewId, size.lineage)
      // Already fallen from while hidden: gone now, only its lineage can take it back.
      else if (t.departed?.viewId === viewId && t.departed.lineage === undefined) t.departed = undefined
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
    this.endGrace(t)
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
    if (size) return { cols: size.cols, rows: size.rows }
    // The sizer is gone and held (`grace`): the pty still has its size.
    return viewId === undefined && t?.grace ? { ...t.grace.size } : undefined
  }

  private entry(key: K): KeySizes {
    let t = this.keys.get(key)
    if (!t) {
      t = { views: new Map(), sizer: undefined, pending: undefined, departed: undefined, grace: undefined }
      this.keys.set(key, t)
    }
    return t
  }

  /** Whether `viewId` sizes the key now: the sizer, still there and allowed to size. */
  private sizes(t: KeySizes, viewId: ViewId): boolean {
    // Held for a reconnect (`grace`): it still sizes, so another view's passive report takes nothing.
    if (t.grace !== undefined && t.sizer === viewId) return true
    return t.views.has(viewId) && this.canSize(t, viewId)
  }

  /** A visible view may size; a hidden one only when it is the key's only view. */
  private canSize(t: KeySizes, viewId: ViewId): boolean {
    return !this.hidden.has(viewId) || (t.views.size === 1 && t.views.has(viewId))
  }

  /**
   * `viewId` sizes the key now. `explicit`: a view took it (typing, "Fit to this screen"), which is
   * the person's choice: a size fallen from another view is not given back to it any more.
   */
  private become(key: K, t: KeySizes, viewId: ViewId, explicit = false): void {
    const size = t.views.get(viewId)
    if (!size) return
    this.cancel(t)
    this.endGrace(t)
    if (explicit || this.heir(t, viewId)) t.departed = undefined
    t.sizer = viewId
    this.deps.apply(key, size.cols, size.rows)
  }

  /** Whether `viewId` is the view the key's size fell from, or one of its lineage (`departed`). */
  private heir(t: KeySizes, viewId: ViewId): boolean {
    const d = t.departed
    if (!d) return false
    if (d.viewId === viewId) return true
    return d.lineage !== undefined && t.views.get(viewId)?.lineage === d.lineage
  }

  /**
   * The sizer (`from`, of `lineage`) left or was hidden: the visible view active last takes over;
   * none, the size stays. `from` is remembered so it can take the size back (`departed`).
   */
  private fallback(key: K, t: KeySizes, from: ViewId, lineage: string | undefined): void {
    t.departed = { viewId: from, lineage }
    let next: ViewId | undefined
    let at = -1
    for (const [viewId, size] of t.views) {
      // A guest's view never takes by a fallback (D-14): the owner's views only; none, the size stays.
      if (this.hidden.has(viewId) || size.explicitOnly || size.at <= at) continue
      next = viewId
      at = size.at
    }
    // A lone hidden view left (the desktop minimized after the browser went): it sizes, as canSize.
    if (next === undefined && t.views.size === 1) {
      const [only, size] = t.views.entries().next().value as [ViewId, ViewSize]
      if (!size.explicitOnly) next = only
    }
    if (next === undefined) {
      t.sizer = undefined
      return
    }
    this.become(key, t, next)
  }

  /**
   * The sizer `from` is gone but may reconnect (a lineage, `reconnectGraceMs`): the pty keeps its
   * size, `departed` names it for its heir, and the size falls back only if the grace runs out with
   * the key still held. Seen live: a remote window's socket dropped for 1 s, the size fell to the
   * desktop's window and the reconnect left it there, so the person's own screen resized by itself.
   */
  private hold(key: K, t: KeySizes, from: ViewId, size: ViewSize): void {
    this.endGrace(t)
    t.departed = { viewId: from, lineage: size.lineage }
    const timer = this.setTimer(() => {
      if (this.keys.get(key) !== t || t.grace?.timer !== timer) return
      t.grace = undefined
      if (t.sizer === from) this.fallback(key, t, from, size.lineage)
    }, this.deps.reconnectGraceMs ?? 0)
    t.grace = { timer, size: { cols: size.cols, rows: size.rows } }
  }

  private endGrace(t: KeySizes): void {
    if (!t.grace) return
    this.clearTimer(t.grace.timer)
    t.grace = undefined
  }

  private cancel(t: KeySizes): void {
    if (!t.pending) return
    this.clearTimer(t.pending.timer)
    t.pending = undefined
  }
}
