// Plan 20261111-streamed-webviews.md Task 6: the DOM-free halves of a server's streamed webview
// panel (web/webview-stream.ts): the letterbox and its inverse, the placement reports (debounce,
// hidden, unmount) and the latest-only decode. The toolbar's channel classes and refusals are in
// ipc-router.test.ts (registerWebviewHandlers) and ipc-remote-class.test.ts; repeated here briefly.
import { describe, expect, it } from 'vitest'
import { REMOTE_CLASS } from '../../src/shared/ipc'
import type { WebviewFrame } from '../../src/shared/web-protocol'
import {
  boxToFrame,
  FrameDecoder,
  framePageSize,
  letterbox,
  PLACE_DEBOUNCE_MS,
  PlaceReporter,
  sizeDiffers,
  type PlaceReport
} from '../../src/renderer/web/webview-stream'

describe('letterbox', () => {
  it('draws the owner 1:1 at the top left', () => {
    expect(letterbox(800, 600, { width: 800, height: 600, scale: 1 })).toEqual({ x: 0, y: 0, width: 800, height: 600, scale: 1 })
  })

  it('fits a wider page centred vertically, a taller one centred horizontally', () => {
    expect(letterbox(400, 400, { width: 800, height: 400, scale: 1 })).toEqual({ x: 0, y: 100, width: 400, height: 200, scale: 0.5 })
    expect(letterbox(400, 400, { width: 200, height: 400, scale: 1 })).toEqual({ x: 100, y: 0, width: 200, height: 400, scale: 1 })
  })

  it("sizes by the page's CSS size (encoded ÷ scale), the scale per encoded px", () => {
    // A 2560x1440 page encoded at 0.75: 1920x1080 frame px.
    const frame = { width: 1920, height: 1080, scale: 0.75 }
    expect(framePageSize(frame)).toEqual({ width: 2560, height: 1440 })
    const lb = letterbox(1280, 720, frame)
    expect(lb).toEqual({ x: 0, y: 0, width: 1280, height: 720, scale: 1280 / 1920 })
  })

  it('draws nothing for an empty box or frame, and treats a bad scale as 1', () => {
    expect(letterbox(0, 600, { width: 800, height: 600, scale: 1 }).width).toBe(0)
    expect(letterbox(800, 600, { width: 0, height: 600, scale: 1 }).width).toBe(0)
    expect(letterbox(Number.NaN, 600, { width: 800, height: 600, scale: 1 }).width).toBe(0)
    expect(framePageSize({ width: 800, height: 600, scale: 0 })).toEqual({ width: 800, height: 600 })
  })

  it('maps box px back to frame px, undefined in the letterbox', () => {
    const frame = { width: 800, height: 400, scale: 1 }
    const lb = letterbox(400, 400, frame)
    expect(boxToFrame(lb, frame, 0, 100)).toEqual({ x: 0, y: 0 })
    expect(boxToFrame(lb, frame, 200, 200)).toEqual({ x: 400, y: 200 })
    // The far edge clamps onto the last pixel.
    expect(boxToFrame(lb, frame, 400, 300)).toEqual({ x: 799, y: 399 })
    expect(boxToFrame(lb, frame, 200, 50)).toBeUndefined()
    expect(boxToFrame(lb, frame, 200, 350)).toBeUndefined()
    expect(boxToFrame(lb, frame, Number.NaN, 200)).toBeUndefined()
    expect(boxToFrame(letterbox(0, 0, frame), frame, 0, 0)).toBeUndefined()
  })

  it('offers Fit only when the page has another size', () => {
    expect(sizeDiffers(800, 600, { width: 800, height: 600, scale: 1 })).toBe(false)
    expect(sizeDiffers(800.4, 601, { width: 800, height: 600, scale: 1 })).toBe(false)
    expect(sizeDiffers(800, 500, { width: 800, height: 600, scale: 1 })).toBe(true)
    expect(sizeDiffers(2560, 1440, { width: 1920, height: 1080, scale: 0.75 })).toBe(false)
  })
})

function fakeTimers(): { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void; advance: (ms: number) => void } {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    set: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clear: (h) => void timers.delete(h as number),
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    }
  }
}

describe('PlaceReporter', () => {
  it('debounces to the latest report, rounded, and skips what main has', () => {
    const timers = fakeTimers()
    const sent: PlaceReport[] = []
    const r = new PlaceReporter((p) => sent.push(p), timers)
    r.update(100.4, 200.6, false)
    r.update(300, 200, false)
    timers.advance(PLACE_DEBOUNCE_MS - 1)
    expect(sent).toEqual([])
    r.update(320.2, 240, false)
    timers.advance(PLACE_DEBOUNCE_MS - 1)
    expect(sent).toEqual([])
    timers.advance(1)
    expect(sent).toEqual([{ width: 320, height: 240, visible: true, hidden: false }])
    r.update(320, 240.3, false)
    timers.advance(PLACE_DEBOUNCE_MS)
    expect(sent).toHaveLength(1)
  })

  it('reports hidden, and no area as not visible', () => {
    const timers = fakeTimers()
    const sent: PlaceReport[] = []
    const r = new PlaceReporter((p) => sent.push(p), timers)
    r.update(300, 200, false)
    timers.advance(PLACE_DEBOUNCE_MS)
    r.update(300, 200, true)
    timers.advance(PLACE_DEBOUNCE_MS)
    r.update(0, 200, true)
    timers.advance(PLACE_DEBOUNCE_MS)
    r.update(Number.NaN, 200, false)
    timers.advance(PLACE_DEBOUNCE_MS)
    expect(sent).toEqual([
      { width: 300, height: 200, visible: true, hidden: false },
      { width: 300, height: 200, visible: true, hidden: true },
      { width: 0, height: 200, visible: false, hidden: true },
      { width: 0, height: 200, visible: false, hidden: false }
    ])
  })

  it('says visible: false at once on unmount, drops the pending one, and nothing after', () => {
    const timers = fakeTimers()
    const sent: PlaceReport[] = []
    const r = new PlaceReporter((p) => sent.push(p), timers)
    r.update(300, 200, false)
    timers.advance(PLACE_DEBOUNCE_MS)
    r.update(500, 400, false)
    r.dispose()
    expect(sent).toEqual([
      { width: 300, height: 200, visible: true, hidden: false },
      { width: 300, height: 200, visible: false, hidden: false }
    ])
    timers.advance(PLACE_DEBOUNCE_MS)
    r.update(1, 1, false)
    r.dispose()
    timers.advance(PLACE_DEBOUNCE_MS)
    expect(sent).toHaveLength(2)
  })

  it('unmounted before the first report still says not visible (a report may be in flight)', () => {
    const timers = fakeTimers()
    const sent: PlaceReport[] = []
    const r = new PlaceReporter((p) => sent.push(p), timers)
    r.update(300, 200, false)
    r.dispose()
    timers.advance(PLACE_DEBOUNCE_MS)
    expect(sent).toEqual([{ width: 0, height: 0, visible: false, hidden: false }])
  })
})

function frame(seq: number, width = 8): WebviewFrame {
  return { key: 'a/b', seq, width, height: 4, scale: 1, jpeg: new Uint8Array([seq]) }
}

describe('FrameDecoder', () => {
  it('decodes latest-only while one decode runs, in socket order, closing what is not drawn', async () => {
    const resolvers: (() => void)[] = []
    const closed: number[] = []
    const drawn: number[] = []
    const decoder = new FrameDecoder<number>(
      (jpeg) => new Promise((resolve) => resolvers.push(() => resolve(jpeg[0] ?? -1))),
      (b) => closed.push(b),
      (d) => drawn.push(d.bitmap)
    )
    decoder.push(frame(1))
    decoder.push(frame(2))
    decoder.push(frame(3))
    expect(resolvers).toHaveLength(1)
    resolvers[0]!()
    await new Promise((r) => setTimeout(r, 0))
    // 1 finished with 3 waiting: closed, never drawn; 2 was replaced before it was decoded.
    expect(closed).toEqual([1])
    expect(resolvers).toHaveLength(2)
    resolvers[1]!()
    await new Promise((r) => setTimeout(r, 0))
    expect(drawn).toEqual([3])
  })

  it('never drops a frame for a lower seq (a new page restarts at 1)', async () => {
    const drawn: number[] = []
    const decoder = new FrameDecoder<number>(
      async (jpeg) => jpeg[0] ?? -1,
      () => {},
      (d) => drawn.push(d.frame.seq)
    )
    decoder.push(frame(9))
    await new Promise((r) => setTimeout(r, 0))
    decoder.push(frame(1))
    await new Promise((r) => setTimeout(r, 0))
    expect(drawn).toEqual([9, 1])
  })

  it('skips a frame that fails to decode, and closes what lands after dispose', async () => {
    const closed: number[] = []
    const drawn: number[] = []
    let release: (() => void) | undefined
    const decoder = new FrameDecoder<number>(
      (jpeg) => {
        if (jpeg[0] === 1) return Promise.reject(new Error('bad jpeg'))
        return new Promise((resolve) => (release = () => resolve(jpeg[0] ?? -1)))
      },
      (b) => closed.push(b),
      (d) => drawn.push(d.bitmap)
    )
    decoder.push(frame(1))
    await new Promise((r) => setTimeout(r, 0))
    decoder.push(frame(2))
    decoder.dispose()
    release?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(drawn).toEqual([])
    expect(closed).toEqual([2])
    decoder.push(frame(3))
    await new Promise((r) => setTimeout(r, 0))
    expect(drawn).toEqual([])
  })
})

describe('toolbar channels', () => {
  it('are adapted (main refuses a remote view outside server mode, ipc-router.test.ts)', () => {
    for (const c of ['webviews.step', 'webviews.current', 'webviews.navigated', 'webviews.place', 'webviews.fit'] as const) {
      expect(REMOTE_CLASS[c], c).toBe('adapted')
    }
    expect(REMOTE_CLASS['webviews.placement']).toBe('no')
  })
})
