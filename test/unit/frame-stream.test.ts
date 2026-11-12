// design-web-browser.md §3.3, §3.4 (plan 20261111-streamed-webviews.md Task 5): a server's off-screen
// webview paints, encoded under one budget and sent to each viewer with one frame in flight. Pure:
// fake images (an encode advances the fake clock by its cost), fake sockets (drained or not, by hand),
// the real WebviewViewers deciding who views what.
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DRAIN_POLL_MS,
  ENCODE_BUDGET_MS,
  encodedSize,
  FrameStream,
  JPEG_QUALITY,
  MAX_ENCODE_AREA,
  streamView,
  type FrameImage,
  type StreamableView
} from '../../src/main/webview/frame-stream'
import { WebviewViewers, type PlaceReport, type WebviewPanelOf } from '../../src/main/webview/webview-viewers'
import { decodeWebviewFrame, MAX_WEBVIEW_FRAME_BYTES } from '../../src/shared/web-protocol'
import { remoteViewId, type ViewId } from '../../src/shared/views'

const PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'view' }
const OTHER_PANEL: WebviewPanelOf = { windowId: 7, pluginId: 'a.one', panelId: 'other' }
const OTHER_WINDOW: WebviewPanelOf = { windowId: 8, pluginId: 'a.one', panelId: 'view' }
const A = remoteViewId(1)
const B = remoteViewId(2)
const C = remoteViewId(3)

const shown = (width = 800, height = 600): PlaceReport => ({ width, height, visible: true, hidden: false })

/** Timers run by hand; `advance` steps through each due timer at its own time. */
class Clock {
  t = 1000
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private next = 1
  setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.next++
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  now = (): number => this.t
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t !== due)
      this.t = Math.max(this.t, due.at)
      due.fn()
    }
    this.t = Math.max(this.t, end)
  }
  pending(): number {
    return this.timers.length
  }
}

interface Encode {
  image: FakeImage
  quality: number
}

/** A NativeImage stand-in: its JPEG is `jpegBytes(quality)` bytes, and each encode costs `cost` ms. */
class FakeImage implements FrameImage {
  resizedTo: { width: number; height: number } | undefined
  constructor(
    private readonly log: Encode[],
    private readonly clock: Clock,
    readonly width: number,
    readonly height: number,
    readonly cost = 2,
    readonly jpegBytes: (quality: number) => number = () => 5000,
    readonly source?: FakeImage
  ) {}
  isEmpty(): boolean {
    return this.width === 0 || this.height === 0
  }
  getSize(): { width: number; height: number } {
    return { width: this.width, height: this.height }
  }
  resize(options: { width: number; height: number }): FrameImage {
    this.resizedTo = { width: options.width, height: options.height }
    return new FakeImage(this.log, this.clock, options.width, options.height, this.cost, this.jpegBytes, this)
  }
  toJPEG(quality: number): Uint8Array {
    this.clock.t += this.cost
    this.log.push({ image: this.source ?? this, quality })
    return new Uint8Array(this.jpegBytes(quality)).fill(0xab)
  }
}

describe('encodedSize', () => {
  it('keeps a page up to the area cap and scales a larger one by a whole hundredth', () => {
    expect(MAX_ENCODE_AREA).toBe(1920 * 1080)
    expect(encodedSize(1920, 1080)).toEqual({ width: 1920, height: 1080, scale: 1 })
    expect(encodedSize(3840, 2160)).toEqual({ width: 1920, height: 1080, scale: 0.5 })
    const big = encodedSize(4096, 4096)
    expect(big.scale).toBe(0.35)
    expect(big.width * big.height).toBeLessThanOrEqual(MAX_ENCODE_AREA)
    expect(big).toEqual({ width: 1433, height: 1433, scale: 0.35 })
  })
})

describe('FrameStream', () => {
  let clock: Clock
  let viewers: WebviewViewers
  let stream: FrameStream
  let sent: Array<{ viewId: ViewId; bytes: Uint8Array }>
  let encodes: Encode[]
  let logs: string[]
  /** Per view: whether its socket can take a frame now (absent: drained). */
  let busySocket: Set<ViewId>
  let refuse: Set<ViewId>
  let invalidated: number
  let detach: () => void

  const page = { invalidate: () => void invalidated++ }
  const image = (width = 800, height = 600, cost = 2, jpegBytes?: (q: number) => number): FakeImage =>
    new FakeImage(encodes, clock, width, height, cost, jpegBytes)
  const framesTo = (viewId: ViewId) =>
    sent.filter((s) => s.viewId === viewId).map((s) => decodeWebviewFrame(s.bytes)!)

  beforeEach(() => {
    clock = new Clock()
    sent = []
    encodes = []
    logs = []
    busySocket = new Set()
    refuse = new Set()
    invalidated = 0
    viewers = new WebviewViewers({
      setViewed: () => undefined,
      setSize: () => undefined,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      now: clock.now
    })
    stream = new FrameStream({
      viewers,
      sendFrame: (viewId, bytes) => {
        if (refuse.has(viewId)) return false
        sent.push({ viewId, bytes })
        return true
      },
      drained: (viewId) => !busySocket.has(viewId),
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: (m) => void logs.push(m)
    })
    detach = stream.attach(PANEL, page)
  })

  it('skips an empty paint (the first after startPainting can be 0x0)', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image(0, 0))
    stream.paint(PANEL, image(0, 600))
    expect(encodes).toEqual([])
    expect(sent).toEqual([])
  })

  it('encodes a paint at JPEG_QUALITY and sends it to the viewer with the panel key and header', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image(800, 600))
    expect(encodes.map((e) => e.quality)).toEqual([JPEG_QUALITY])
    const [frame] = framesTo(A)
    expect(frame).toMatchObject({ key: 'a.one/view', seq: 1, width: 800, height: 600, scale: 1 })
    expect(frame!.jpeg.length).toBe(5000)
    expect(stream.describe(PANEL)).toEqual({ seq: 1, pending: false, bytes: sent[0]!.bytes.byteLength })
  })

  it('downscales a page over the area cap and puts the scale in the header', () => {
    viewers.report(PANEL, A, shown())
    const big = image(3840, 2160)
    stream.paint(PANEL, big)
    expect(big.resizedTo).toEqual({ width: 1920, height: 1080 })
    expect(framesTo(A)[0]).toMatchObject({ width: 1920, height: 1080, scale: 0.5 })
  })

  it('keeps one frame in flight: nothing more while the socket has not drained, then only the newest', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image())
    expect(sent).toHaveLength(1)
    busySocket.add(A)
    const newest = image()
    stream.paint(PANEL, image())
    stream.paint(PANEL, image())
    stream.paint(PANEL, newest)
    clock.advance(DRAIN_POLL_MS * 5)
    // Lazy: a slow socket costs no encodes, and nothing is queued for it.
    expect(encodes).toHaveLength(1)
    expect(sent).toHaveLength(1)
    expect(stream.describe(PANEL)?.pending).toBe(true)
    busySocket.delete(A)
    clock.advance(DRAIN_POLL_MS)
    expect(encodes).toHaveLength(2)
    expect(encodes[1]!.image).toBe(newest)
    expect(framesTo(A).map((f) => f.seq)).toEqual([1, 2])
    // Caught up: the poll stops.
    expect(clock.pending()).toBe(0)
  })

  it('serves each viewer at its own pace: a slow one gets the latest when it drains', () => {
    viewers.report(PANEL, A, shown())
    viewers.report(PANEL, B, shown())
    busySocket.add(B)
    stream.paint(PANEL, image())
    stream.paint(PANEL, image())
    expect(framesTo(A).map((f) => f.seq)).toEqual([1, 2])
    expect(framesTo(B)).toEqual([])
    busySocket.delete(B)
    clock.advance(DRAIN_POLL_MS)
    // The last frame as encoded for A, not encoded again.
    expect(framesTo(B).map((f) => f.seq)).toEqual([2])
    expect(encodes).toHaveLength(2)
  })

  it('tries a refused frame again when the socket drains', () => {
    viewers.report(PANEL, A, shown())
    refuse.add(A)
    stream.paint(PANEL, image())
    expect(sent).toEqual([])
    refuse.delete(A)
    clock.advance(DRAIN_POLL_MS)
    expect(framesTo(A).map((f) => f.seq)).toEqual([1])
  })

  it('skips paints once the app-wide encode budget is spent, keeping the newest for later', () => {
    viewers.report(PANEL, A, shown())
    const cost = 50
    // Back to back: each encode's own time drains a little of the debt, so one or two more than
    // ENCODE_BUDGET_MS / cost get through, never many.
    for (let i = 0; i < 20; i++) stream.paint(PANEL, image(800, 600, cost))
    const allowed = encodes.length
    expect(allowed).toBeGreaterThanOrEqual(ENCODE_BUDGET_MS / cost)
    expect(allowed).toBeLessThanOrEqual(ENCODE_BUDGET_MS / cost + 2)
    const newest = image(800, 600, cost)
    stream.paint(PANEL, image(800, 600, cost))
    stream.paint(PANEL, newest)
    expect(encodes).toHaveLength(allowed)
    expect(stream.describe(PANEL)?.pending).toBe(true)
    // The budget drains at its share of wall time; the newest paint goes then, once.
    clock.advance(1000)
    expect(encodes).toHaveLength(allowed + 1)
    expect(encodes.at(-1)!.image).toBe(newest)
    expect(framesTo(A)).toHaveLength(allowed + 1)
  })

  it('shares the budget across webviews: one webview spending it holds the other back too', () => {
    stream.attach(OTHER_PANEL, page)
    viewers.report(PANEL, A, shown())
    viewers.report(OTHER_PANEL, A, shown())
    stream.paint(PANEL, image(800, 600, ENCODE_BUDGET_MS))
    stream.paint(OTHER_PANEL, image())
    expect(encodes).toHaveLength(1)
    clock.advance(1000)
    expect(encodes).toHaveLength(2)
    expect(sent.map((s) => decodeWebviewFrame(s.bytes)!.key)).toEqual(['a.one/view', 'a.one/other'])
  })

  it('encodes a frame over the size cap again at a lower quality, and skips it when even that is over', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image(800, 600, 2, (q) => (q === JPEG_QUALITY ? MAX_WEBVIEW_FRAME_BYTES : 1000)))
    expect(encodes.map((e) => e.quality)).toEqual([JPEG_QUALITY, 50])
    expect(framesTo(A)[0]!.jpeg.length).toBe(1000)
    encodes.length = 0
    stream.paint(PANEL, image(800, 600, 2, () => MAX_WEBVIEW_FRAME_BYTES + 1))
    stream.paint(PANEL, image(800, 600, 2, () => MAX_WEBVIEW_FRAME_BYTES + 1))
    expect(encodes.map((e) => e.quality)).toEqual([JPEG_QUALITY, 50, 30, JPEG_QUALITY, 50, 30])
    expect(sent).toHaveLength(1)
    for (const s of sent) expect(s.bytes.byteLength).toBeLessThanOrEqual(MAX_WEBVIEW_FRAME_BYTES)
    // Logged once, by size only.
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/a\.one\/view: a 800x600 frame is over/)
  })

  it('gives a new viewer the last frame at once, with no new encode', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image())
    viewers.report(PANEL, B, shown())
    expect(framesTo(B).map((f) => f.seq)).toEqual([1])
    expect(encodes).toHaveLength(1)
  })

  it('a viewer that got frames before its join (its size made the page paint) gets none of them twice', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image())
    // The last viewer goes (a browser reloading): the panel's state goes with it.
    viewers.viewGone(A)
    // The reloaded browser's first report: its size comes before its join, and the page paints
    // for it at once (the real page's repaint, and its start painting again).
    const real = page.invalidate
    page.invalidate = () => {
      real()
      stream.paint(PANEL, image())
    }
    try {
      viewers.report(PANEL, B, shown())
    } finally {
      page.invalidate = real
    }
    expect(framesTo(B).map((f) => f.seq)).toEqual([2])
    stream.paint(PANEL, image())
    expect(framesTo(B).map((f) => f.seq)).toEqual([2, 3])
  })

  it('asks the page for a full paint when a viewer joins with no frame yet, and on a size change', () => {
    viewers.report(PANEL, A, shown())
    expect(invalidated).toBe(1)
    stream.paint(PANEL, image())
    viewers.report(PANEL, B, shown())
    expect(invalidated).toBe(1)
    // The owner's new size: the last frame is the old size, so the page repaints.
    viewers.report(PANEL, A, shown(900, 700))
    clock.advance(200)
    expect(invalidated).toBe(2)
  })

  it('sends nothing to non-viewers: a hidden view, another panel, another window', () => {
    viewers.report(PANEL, A, shown())
    viewers.report(PANEL, B, { ...shown(), hidden: true })
    viewers.report(OTHER_PANEL, C, shown())
    viewers.report(OTHER_WINDOW, C, shown())
    stream.paint(PANEL, image())
    expect(sent.map((s) => s.viewId)).toEqual([A])
    // A webview with no page attached (another window's) sends nothing either.
    stream.paint(OTHER_WINDOW, image())
    expect(sent.map((s) => s.viewId)).toEqual([A])
  })

  it('a viewer gone mid-send gets nothing after, and the poll stops', () => {
    viewers.report(PANEL, A, shown())
    viewers.report(PANEL, B, shown())
    busySocket.add(B)
    stream.paint(PANEL, image())
    viewers.viewGone(B)
    busySocket.delete(B)
    clock.advance(DRAIN_POLL_MS * 3)
    expect(framesTo(B)).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('drops a pending paint when the last viewer leaves, and the next viewer gets the last frame', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image())
    busySocket.add(A)
    stream.paint(PANEL, image())
    viewers.viewGone(A)
    expect(stream.describe(PANEL)).toMatchObject({ seq: 1, pending: false })
    clock.advance(DRAIN_POLL_MS * 3)
    expect(encodes).toHaveLength(1)
    viewers.report(PANEL, B, shown())
    expect(framesTo(B).map((f) => f.seq)).toEqual([1])
  })

  it('a webview destroyed with a pending frame sends and encodes nothing more, and keeps nothing', () => {
    viewers.report(PANEL, A, shown())
    busySocket.add(A)
    stream.paint(PANEL, image())
    detach()
    busySocket.delete(A)
    clock.advance(DRAIN_POLL_MS * 3)
    expect(encodes).toEqual([])
    expect(sent).toEqual([])
    expect(stream.describe(PANEL)).toBeUndefined()
    expect(clock.pending()).toBe(0)
    // A late paint of the gone page goes nowhere.
    stream.paint(PANEL, image())
    expect(sent).toEqual([])
  })

  it('a new view of the panel replaces the old one; the old one detaching changes nothing', () => {
    viewers.report(PANEL, A, shown())
    stream.paint(PANEL, image())
    const second = { invalidate: () => undefined }
    stream.attach(PANEL, second)
    detach()
    stream.paint(PANEL, image())
    // A fresh stream for the new page: its first frame is seq 1 again.
    expect(framesTo(A).map((f) => f.seq)).toEqual([1, 1])
  })

  it('stops on dispose: no timer, no frames', () => {
    viewers.report(PANEL, A, shown())
    busySocket.add(A)
    stream.paint(PANEL, image())
    stream.dispose()
    expect(clock.pending()).toBe(0)
    busySocket.delete(A)
    viewers.report(PANEL, B, shown())
    expect(sent).toEqual([])
  })
})

describe('streamView', () => {
  it('routes the view paints to the stream, its cursor to the given listener, and detaches on destroy', () => {
    const clock = new Clock()
    const viewers = new WebviewViewers({ setViewed: () => undefined, setSize: () => undefined, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now })
    const sent: Uint8Array[] = []
    const stream = new FrameStream({
      viewers,
      sendFrame: (_v, bytes) => {
        sent.push(bytes)
        return true
      },
      drained: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    let sink: Parameters<StreamableView['setSink']>[0]
    let destroyed = 0
    const view: StreamableView & { extra: string } = {
      extra: 'kept',
      setSink: (next) => {
        sink = next
      },
      invalidate: () => undefined,
      destroy: () => void destroyed++
    }
    const cursors: string[] = []
    const wrapped = streamView(stream, PANEL, view, (type) => void cursors.push(type))
    expect(wrapped.extra).toBe('kept')
    viewers.report(PANEL, A, shown())
    const encodes: Encode[] = []
    sink!.paint({}, new FakeImage(encodes, clock, 640, 480))
    sink!.cursor('hand')
    expect(sent).toHaveLength(1)
    expect(cursors).toEqual(['hand'])
    wrapped.destroy()
    expect(destroyed).toBe(1)
    expect(sink).toBeUndefined()
    expect(stream.describe(PANEL)).toBeUndefined()
  })
})
