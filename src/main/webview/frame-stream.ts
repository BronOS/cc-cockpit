// The frames of a server's off-screen webviews, from the page's `paint` to each browser view that
// shows the panel (design-web-browser.md §3.3, §3.4, §5; plan 20261111-streamed-webviews.md Task 5).
// Server mode only: on the desktop a webview is a native view on the window and nothing here runs.
//
// The costs it guards, all on main's thread (where `paint` arrives and `toJPEG` runs, synchronously):
//
//   newest wins   per webview only the newest paint is held, and only until it is encoded: a page
//                 painting faster than it can be encoded or sent never builds a backlog. Encoding is
//                 lazy: a paint is encoded only when a viewer can take a frame now (its socket
//                 drained) and wants one newer than it has, so a slow socket costs no encodes.
//   area cap      the encoded image has at most MAX_ENCODE_AREA pixels (a full-HD page as is; a larger
//                 one downscaled by a scale that is a whole hundredth, so the frame header's scale x 100
//                 is exact and the browser maps input back through it with no drift).
//   budget        one app-wide encode budget, ENCODE_BUDGET_SHARE of main's time measured with the
//                 injected clock (a leaky bucket holding at most ENCODE_BUDGET_MS of debt): once spent,
//                 paints are not encoded (the newest is kept) until it refills, and the webviews that
//                 waited are served in turn. Every encode counts, a quality retry included.
//   kept state    per webview only the last frame's bytes (the header plus JPEG, ready to send again),
//                 never the NativeImage; all of it goes when the view does (detach).
//   frame cap     a frame over MAX_WEBVIEW_FRAME_BYTES is encoded again at a lower quality
//                 (FALLBACK_QUALITIES), and skipped when even the lowest is over: never sent (the
//                 sink would refuse it anyway; a skipped one is logged by size only, once per webview).
//
// Delivery, per viewer (webview-viewers.ts `viewers(panel)`: browser views of the webview's own
// window that show the panel; the ViewRegistry's `frameToView` refuses a desktop or hidden-page view
// besides): ONE frame in flight. A frame goes to a viewer only while its socket is drained
// (`frameDrained`: at most FRAME_DRAINED_BYTES unsent) and when it is newer than the one the viewer
// got last; meanwhile newer paints replace the pending one, so the viewer gets the latest when it
// drains. The socket has no drain signal of its own (`ws` has none, and its net.Socket's `drain`
// only follows a write that filled it), so drain is polled: one app-wide timer every DRAIN_POLL_MS,
// armed only while some viewer waits for its socket or a paint waits for the budget, and idle
// otherwise. What the kernel's socket buffer holds is invisible to `bufferedAmount`; with the frame
// cap that bounds a terminal echo's wait behind frames to the kernel buffer plus one frame.
//
// Join and resync (webview-viewers.ts `onChange`): a new viewer (a browser opening the panel, a
// reconnect, which is a new view) gets the last frame at once, or, when there is none, the page is
// asked for a full paint (`invalidate`); a size change asks for a full paint too (the last frame
// has the old size, and the browser still shows it meanwhile). A viewer that leaves is forgotten
// mid-wait: nothing is sent to it after.
//
// Frames are never logged and never go anywhere but `sendFrame` for a current viewer.
//
// Pure: Electron's NativeImage only through FrameImage (structurally the subset used), the socket
// side through `sendFrame` / `drained` (ViewRegistry), timers and clock injected.

import { errorText } from '../../shared/error-text'
import type { ViewId } from '../../shared/views'
import { encodeWebviewFrame, MAX_WEBVIEW_FRAME_BYTES } from '../../shared/web-protocol'
import { warnLog } from '../warn-log'
import type { ViewersChange, WebviewPanelOf } from './webview-viewers'

/** Largest encoded area, px: a full-HD page goes as is (design-web-browser.md §3.3, "near 2 MP"). */
export const MAX_ENCODE_AREA = 1920 * 1080
/** JPEG quality of a frame (design-web-browser.md §3.3: about 75; PNG never, 10x the size). */
export const JPEG_QUALITY = 75
/** Lower qualities tried, in order, when a frame is over MAX_WEBVIEW_FRAME_BYTES. */
export const FALLBACK_QUALITIES: readonly number[] = [50, 30]
/**
 * Share of main's time JPEG encoding may take, app-wide: 0.2 is 200 ms of each second. Measured by
 * the bench (scripts/web-terminal-bench.mjs, phase 5): a 1280x800 animated page costs a few ms per
 * frame, so one webview at 30 fps stays under it, while several busy ones are slowed together
 * instead of taking main from the terminals.
 */
export const ENCODE_BUDGET_SHARE = 0.2
/** The most encode time, ms, the budget lets through at once (one second's share). */
export const ENCODE_BUDGET_MS = ENCODE_BUDGET_SHARE * 1000
/** How often a viewer's socket is checked for drain while one waits (ms; about one 60 Hz frame). */
export const DRAIN_POLL_MS = 16

/** The part of Electron's NativeImage the stream uses (a fake in tests). */
export interface FrameImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): FrameImage
  toJPEG(quality: number): Uint8Array
}

/** What the stream asks of a webview's page (OffscreenWebviewView): a full repaint. */
export interface FramePage {
  invalidate(): void
}

export interface FrameStreamDeps {
  /** webview-viewers.ts: who shows a panel now, and its changes. */
  viewers: {
    viewers(panel: WebviewPanelOf): ViewId[]
    onChange(listener: (change: ViewersChange) => void): () => void
  }
  /** One binary frame to one view (ViewRegistry.frameToView): true when its socket took it. */
  sendFrame(viewId: ViewId, frame: Uint8Array): boolean
  /** Whether the view's socket can take the next frame now (ViewRegistry.frameDrained). */
  drained(viewId: ViewId): boolean
  /** A monotonic clock, ms (performance.now in the app): the encode budget is measured with it. */
  now(): number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
}

/** The last frame of a webview: its bytes as sent (header and JPEG) and its seq. */
interface LastFrame {
  seq: number
  bytes: Uint8Array
}

interface StreamState {
  panel: WebviewPanelOf
  /** The panel key frames carry (`<pluginId>/<panelId>`, as `webviews.place` names it). */
  key: string
  page: FramePage
  /** The newest paint not encoded yet (dropped once encoded, replaced by a newer one). */
  pending: FrameImage | undefined
  last: LastFrame | undefined
  seq: number
  /** Per viewer, the seq of the last frame it was sent (absent: none yet). */
  sent: Map<ViewId, number>
  /** An over-cap frame was logged for this webview already. */
  warnedSize: boolean
}

function keyOf(panel: WebviewPanelOf): string {
  return `${panel.windowId}\0${panel.pluginId}\0${panel.panelId}`
}

/**
 * The encoded size for a page of `width` x `height` px: as is up to MAX_ENCODE_AREA, else scaled by
 * the largest whole hundredth that fits (so the header's scale x 100 is exact). `scale` is the
 * encoded size over the page's size.
 */
export function encodedSize(width: number, height: number): { width: number; height: number; scale: number } {
  if (width * height <= MAX_ENCODE_AREA) return { width, height, scale: 1 }
  const scale = Math.max(0.01, Math.floor(Math.sqrt(MAX_ENCODE_AREA / (width * height)) * 100) / 100)
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale }
}

export class FrameStream {
  private readonly streams = new Map<string, StreamState>()
  /** Webviews with work left (a viewer waiting to drain, a paint waiting for the budget), served in turn. */
  private readonly busy = new Set<string>()
  private timer: unknown
  private timerAt = Infinity
  /** Encode debt, ms (the leaky bucket), as of `debtAt`. */
  private debt = 0
  private debtAt: number
  private readonly unsubscribe: () => void
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (message: string) => void

  constructor(private readonly deps: FrameStreamDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = deps.log ?? warnLog
    this.debtAt = deps.now()
    this.unsubscribe = deps.viewers.onChange((change) => this.viewersChanged(change))
  }

  /**
   * `page` is the panel's off-screen page from now on (a new view replaces the panel's last one,
   * its frame and its viewers' progress). Returns the detach, for the view's destroy; a detach of a
   * page that was replaced meanwhile changes nothing.
   */
  attach(panel: WebviewPanelOf, page: FramePage): () => void {
    const id = keyOf(panel)
    const state: StreamState = {
      panel: { ...panel },
      key: `${panel.pluginId}/${panel.panelId}`,
      page,
      pending: undefined,
      last: undefined,
      seq: 0,
      sent: new Map(),
      warnedSize: false
    }
    this.streams.set(id, state)
    this.busy.delete(id)
    return () => {
      if (this.streams.get(id) !== state) return
      // Nothing of the page outlives it: its pending paint, its last frame, who got what.
      this.streams.delete(id)
      this.busy.delete(id)
      state.pending = undefined
      state.last = undefined
    }
  }

  /** A paint of the panel's page (the whole page as `image`). An empty one (the first after startPainting can be 0x0) is skipped. */
  paint(panel: WebviewPanelOf, image: FrameImage): void {
    const id = keyOf(panel)
    const state = this.streams.get(id)
    if (!state) return
    let size: { width: number; height: number }
    try {
      if (image.isEmpty()) return
      size = image.getSize()
    } catch {
      return
    }
    if (!(size.width >= 1 && size.height >= 1)) return
    state.pending = image
    this.pump(id, state)
  }

  /** Stop: no timer, no listener (main's quit; tests). */
  dispose(): void {
    this.unsubscribe()
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timer = undefined
    this.timerAt = Infinity
    this.streams.clear()
    this.busy.clear()
  }

  /** The test hook: per webview, the seq of its last frame and whether a paint waits. */
  describe(panel: WebviewPanelOf): { seq: number | undefined; pending: boolean; bytes: number } | undefined {
    const state = this.streams.get(keyOf(panel))
    return state ? { seq: state.last?.seq, pending: state.pending !== undefined, bytes: state.last?.bytes.byteLength ?? 0 } : undefined
  }

  // -------------------------------------------------------------------------------------------

  private viewersChanged(change: ViewersChange): void {
    const id = keyOf(change.panel)
    const state = this.streams.get(id)
    if (!state) return
    switch (change.kind) {
      case 'added':
        // A new viewer (or a reconnect: a new view) has nothing yet; the last frame goes at once
        // when its socket can take it, else the page is asked for one.
        state.sent.delete(change.viewId)
        if (state.last) this.pump(id, state)
        else this.invalidate(state)
        return
      case 'removed':
        state.sent.delete(change.viewId)
        // Nobody shows it: the page stops painting (the manager hides it); a paint held for nobody
        // goes. The last frame stays for the next viewer, until the view goes.
        if (this.deps.viewers.viewers(state.panel).length === 0) {
          state.pending = undefined
          this.busy.delete(id)
        }
        return
      case 'size':
        // The page reflows at the new size and paints; the full repaint makes sure of a whole frame.
        // With no frame yet the join asks for one already (a first viewer's size comes before its
        // `added`).
        if (state.last) this.invalidate(state)
        return
      case 'owner':
        return
    }
  }

  private invalidate(state: StreamState): void {
    try {
      state.page.invalidate()
    } catch (err) {
      this.log(`webview frames: asking for a repaint failed: ${errorText(err)}`)
    }
  }

  /**
   * Serve one webview's viewers: those whose socket drained and that lack the newest frame get it,
   * encoding the pending paint first when the budget allows. Leaves it `busy` (and the timer armed)
   * while a viewer still waits for its socket or the paint for the budget.
   */
  private pump(id: string, state: StreamState): void {
    if (this.streams.get(id) !== state) return
    const viewers = this.deps.viewers.viewers(state.panel)
    if (viewers.length === 0) {
      state.pending = undefined
      this.busy.delete(id)
      return
    }
    let waitDrain = false
    let waitBudget = 0
    const ready: ViewId[] = []
    for (const viewId of viewers) {
      const behind = state.pending !== undefined || (state.last !== undefined && state.sent.get(viewId) !== state.last.seq)
      if (!behind) continue
      if (this.drainedSafe(viewId)) ready.push(viewId)
      else waitDrain = true
    }
    if (ready.length > 0 && state.pending) {
      const wait = this.budgetWait()
      if (wait > 0) waitBudget = wait
      else this.encode(state)
    }
    const last = state.last
    if (last) {
      for (const viewId of ready) {
        if (state.sent.get(viewId) === last.seq) continue
        let sent = false
        try {
          sent = this.deps.sendFrame(viewId, last.bytes)
        } catch (err) {
          this.log(`webview frames: sending to view ${viewId} failed: ${errorText(err)}`)
        }
        // Refused (a closing socket, one past its high water): it is tried again when it drains.
        if (sent) state.sent.set(viewId, last.seq)
        else waitDrain = true
      }
    }
    if (!waitDrain && waitBudget === 0) {
      this.busy.delete(id)
      return
    }
    // Re-added at the end: the webviews that waited are served in turn.
    this.busy.delete(id)
    this.busy.add(id)
    this.arm(waitBudget > 0 && !waitDrain ? waitBudget : DRAIN_POLL_MS)
  }

  private drainedSafe(viewId: ViewId): boolean {
    try {
      return this.deps.drained(viewId)
    } catch {
      return false
    }
  }

  /** Encode the pending paint into the last frame (or skip it), charging the budget. */
  private encode(state: StreamState): void {
    const image = state.pending
    state.pending = undefined
    if (!image) return
    const started = this.deps.now()
    try {
      const page = image.getSize()
      const out = encodedSize(page.width, page.height)
      const scaled = out.scale === 1 ? image : image.resize({ width: out.width, height: out.height, quality: 'good' })
      const header = { key: state.key, width: out.width, height: out.height, scale: out.scale }
      const seq = state.seq === 0xffff_ffff ? 0 : state.seq + 1
      let bytes: Uint8Array | undefined
      for (const quality of [JPEG_QUALITY, ...FALLBACK_QUALITIES]) {
        const jpeg = scaled.toJPEG(quality)
        if (jpeg.byteLength === 0) break
        const frame = encodeWebviewFrame({ ...header, seq, jpeg })
        if (frame.byteLength <= MAX_WEBVIEW_FRAME_BYTES) {
          bytes = frame
          break
        }
      }
      if (!bytes) {
        if (!state.warnedSize) {
          state.warnedSize = true
          this.log(`webview frames: ${state.key}: a ${out.width}x${out.height} frame is over ${MAX_WEBVIEW_FRAME_BYTES} bytes even at quality ${FALLBACK_QUALITIES.at(-1)}, skipped`)
        }
        return
      }
      state.seq = seq
      state.last = { seq, bytes }
    } catch (err) {
      this.log(`webview frames: ${state.key}: encoding failed: ${errorText(err)}`)
    } finally {
      this.charge(this.deps.now() - started)
    }
  }

  /** Bring the budget's debt up to now (it drains at ENCODE_BUDGET_SHARE ms per ms). */
  private settle(): void {
    const t = this.deps.now()
    this.debt = Math.max(0, this.debt - Math.max(0, t - this.debtAt) * ENCODE_BUDGET_SHARE)
    this.debtAt = t
  }

  /** 0 when an encode may run now, else the ms until the budget allows one. */
  private budgetWait(): number {
    this.settle()
    if (this.debt < ENCODE_BUDGET_MS) return 0
    return Math.max(1, Math.ceil((this.debt - ENCODE_BUDGET_MS) / ENCODE_BUDGET_SHARE) + 1)
  }

  private charge(ms: number): void {
    this.settle()
    if (Number.isFinite(ms) && ms > 0) this.debt += ms
  }

  /** Run `tick` within `ms` (the earliest asked wins). */
  private arm(ms: number): void {
    const at = this.deps.now() + ms
    if (this.timer !== undefined && this.timerAt <= at) return
    if (this.timer !== undefined) this.clearTimer(this.timer)
    this.timerAt = at
    this.timer = this.setTimer(() => this.tick(), ms)
  }

  private tick(): void {
    this.timer = undefined
    this.timerAt = Infinity
    // A snapshot: pump re-adds what is still waiting, at the end, and arms the timer again.
    for (const id of [...this.busy]) {
      const state = this.streams.get(id)
      if (state) this.pump(id, state)
      else this.busy.delete(id)
    }
  }
}

/** A view whose paints a FrameStream takes (OffscreenWebviewView's part; its sink also carries the cursor). */
export interface StreamableView extends FramePage {
  setSink(sink: { paint(dirty: unknown, image: FrameImage): void; cursor(type: string): void } | undefined): void
  destroy(): void
}

/**
 * Wire an off-screen view into `stream` for `panel` (index.ts, server mode): its paints go to the
 * stream, its cursor to `cursor` (the browsers', a later task) or nowhere, and its destroy detaches
 * it, so the stream holds nothing of a view that is gone (the manager destroys every view it drops,
 * a crashed or window-closed page included). The view is copied with a spread, which suits the
 * adapter's plain object of closures (no class, no getters).
 */
export function streamView<V extends StreamableView>(stream: FrameStream, panel: WebviewPanelOf, view: V, cursor?: (type: string) => void): V {
  const detach = stream.attach(panel, view)
  view.setSink({
    paint: (_dirty, image) => stream.paint(panel, image),
    cursor: (type) => cursor?.(type)
  })
  return {
    ...view,
    destroy: () => {
      detach()
      view.setSink(undefined)
      view.destroy()
    }
  }
}
