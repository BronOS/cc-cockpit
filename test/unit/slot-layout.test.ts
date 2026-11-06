import { describe, expect, it } from 'vitest'
import { SLOT_HEIGHT_MESSAGE, SLOT_MESSAGE, SLOT_WIDTH_MESSAGE } from '../../src/sdk/panel-core'
import type { SlotFrameInfo } from '../../src/shared/ipc'
import {
  SlotHeightRelay,
  SlotWidthGate,
  WIDTH_BURST_CHANGES,
  WIDTH_BURST_MS,
  slotColumn,
  slotFrameHeight,
  slotHeightRequest,
  slotIntro,
  slotWidthRequest
} from '../../src/renderer/zones/slot-layout'

// The frames themselves (iframes, ports, the top bar) need a DOM and Electron and are covered end
// to end in test/e2e/slots.spec.ts; this pins the column and height rules.

function frame(over: Partial<SlotFrameInfo> = {}): SlotFrameInfo {
  return {
    id: 's1',
    type: 'agenda',
    pluginId: 'example.calendar',
    src: 'cc-plugin://example.calendar/slots/agenda.html',
    position: 'top',
    height: 120,
    minHeight: 48,
    ...over
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('slotColumn', () => {
  it('splits by position and keeps main\'s order on each side', () => {
    const a = frame({ id: 's1', position: 'bottom' })
    const b = frame({ id: 's2', position: 'top' })
    const c = frame({ id: 's3', position: 'bottom' })
    const d = frame({ id: 's4', position: 'top' })
    expect(slotColumn([a, b, c, d])).toEqual({ top: [b, d], bottom: [a, c] })
  })

  it('is empty for no frames and leaves a stray top-bar frame out', () => {
    expect(slotColumn(undefined)).toEqual({ top: [], bottom: [] })
    expect(slotColumn([frame({ position: 'top-bar' })])).toEqual({ top: [], bottom: [] })
  })
})

describe('slotFrameHeight', () => {
  it('is the placement height until the page asks for one', () => {
    expect(slotFrameHeight(frame())).toBe(120)
  })

  it('keeps the page\'s request within [minHeight, placement height]', () => {
    expect(slotFrameHeight(frame({ pageHeight: 80 }))).toBe(80)
    expect(slotFrameHeight(frame({ pageHeight: 10 }))).toBe(48)
    expect(slotFrameHeight(frame({ pageHeight: 500 }))).toBe(120)
    expect(slotFrameHeight(frame({ pageHeight: 60.6 }))).toBe(61)
  })

  it('lets the placement height win when min and height arrive crossed', () => {
    expect(slotFrameHeight(frame({ height: 40, minHeight: 90 }))).toBe(40)
    expect(slotFrameHeight(frame({ height: 40, minHeight: 90, pageHeight: 30 }))).toBe(40)
  })
})

describe('slotHeightRequest', () => {
  it('reads a setHeight message and clamps it to the frame', () => {
    expect(slotHeightRequest({ type: SLOT_HEIGHT_MESSAGE, height: 90 }, frame())).toBe(90)
    expect(slotHeightRequest({ type: SLOT_HEIGHT_MESSAGE, height: 1 }, frame())).toBe(48)
    expect(slotHeightRequest({ type: SLOT_HEIGHT_MESSAGE, height: 9000 }, frame())).toBe(120)
  })

  it('ignores anything else a page posts', () => {
    for (const data of [
      null,
      'cc-plugin.slot-height',
      { type: 'cc-plugin.port', height: 90 },
      { type: SLOT_HEIGHT_MESSAGE },
      { type: SLOT_HEIGHT_MESSAGE, height: '90' },
      { type: SLOT_HEIGHT_MESSAGE, height: Number.NaN },
      { type: SLOT_HEIGHT_MESSAGE, height: Number.POSITIVE_INFINITY }
    ]) {
      expect(slotHeightRequest(data, frame())).toBeUndefined()
    }
  })
})

describe('slotWidthRequest', () => {
  it('reads a setWidth message, rounded and within 0 and 4096', () => {
    expect(slotWidthRequest({ type: SLOT_WIDTH_MESSAGE, width: 180.4 })).toBe(180)
    expect(slotWidthRequest({ type: SLOT_WIDTH_MESSAGE, width: 0 })).toBe(0)
    expect(slotWidthRequest({ type: SLOT_WIDTH_MESSAGE, width: -50 })).toBe(0)
    expect(slotWidthRequest({ type: SLOT_WIDTH_MESSAGE, width: 1e9 })).toBe(4096)
  })

  it('ignores anything else a page posts, a height included', () => {
    for (const data of [
      null,
      'cc-plugin.slot-width',
      { type: SLOT_HEIGHT_MESSAGE, height: 90 },
      { type: SLOT_HEIGHT_MESSAGE, width: 90 },
      { type: SLOT_WIDTH_MESSAGE },
      { type: SLOT_WIDTH_MESSAGE, width: '90' },
      { type: SLOT_WIDTH_MESSAGE, width: Number.NaN },
      { type: SLOT_WIDTH_MESSAGE, width: Number.NEGATIVE_INFINITY }
    ]) {
      expect(slotWidthRequest(data)).toBeUndefined()
    }
  })
})

describe('SlotWidthGate', () => {
  /** A scheduler the test runs by hand: `frame()` runs what waits for the next frame, `timers` the delayed ones. */
  function harness() {
    let t = 0
    const applied: number[] = []
    let frames: Array<() => void> = []
    const timers: Array<{ run: () => void; at: number; cancelled: boolean }> = []
    const gate = new SlotWidthGate(
      (w) => applied.push(w),
      (run, delayMs) => {
        if (delayMs === undefined) {
          frames.push(run)
          return () => {
            frames = frames.filter((f) => f !== run)
          }
        }
        const timer = { run, at: t + delayMs, cancelled: false }
        timers.push(timer)
        return () => {
          timer.cancelled = true
        }
      },
      () => t
    )
    const frame = (): void => {
      const due = frames
      frames = []
      for (const run of due) run()
    }
    const advance = (ms: number): void => {
      t += ms
      for (const timer of timers.splice(0)) {
        if (timer.cancelled) continue
        if (timer.at <= t) timer.run()
        else timers.push(timer)
      }
    }
    return { gate, applied, frame, advance, pendingFrames: () => frames.length }
  }

  it('applies once per frame, the latest request winning, and never the same width twice', () => {
    const h = harness()
    h.gate.request(100)
    h.gate.request(140)
    h.gate.request(120)
    expect(h.applied).toEqual([])
    expect(h.pendingFrames()).toBe(1)
    h.frame()
    expect(h.applied).toEqual([120])
    h.gate.request(120)
    h.frame()
    expect(h.applied).toEqual([120])
    h.gate.request(0)
    h.frame()
    expect(h.applied).toEqual([120, 0])
  })

  it('holds a page in a loop after a burst of changes, then takes its latest width', () => {
    const h = harness()
    for (let i = 0; i < WIDTH_BURST_CHANGES; i++) {
      h.gate.request(i % 2 === 0 ? 100 : 101)
      h.frame()
      h.advance(10)
    }
    expect(h.applied).toHaveLength(WIDTH_BURST_CHANGES)
    // One more change inside the window: held, and requests meanwhile only replace what waits.
    h.gate.request(300)
    h.frame()
    h.gate.request(310)
    h.frame()
    expect(h.applied).toHaveLength(WIDTH_BURST_CHANGES)
    h.advance(WIDTH_BURST_MS)
    expect(h.applied).toHaveLength(WIDTH_BURST_CHANGES + 1)
    expect(h.applied.at(-1)).toBe(310)
  })

  it('applies nothing once closed', () => {
    const h = harness()
    h.gate.request(100)
    h.gate.close()
    h.frame()
    h.gate.request(200)
    h.frame()
    expect(h.applied).toEqual([])
  })
})

describe('slotIntro', () => {
  it('is the SDK\'s slot message for the type', () => {
    expect(slotIntro('agenda')).toEqual({ type: SLOT_MESSAGE, slot: { type: 'agenda' } })
  })
})

describe('SlotHeightRelay', () => {
  it('sends one call at a time, then only the latest request', async () => {
    const sent: number[] = []
    const answers: Array<() => void> = []
    const relay = new SlotHeightRelay((h) => {
      sent.push(h)
      return new Promise<void>((resolve) => answers.push(resolve))
    })
    relay.request(60)
    relay.request(70)
    relay.request(80)
    expect(sent).toEqual([60])
    answers.shift()!()
    await settle()
    expect(sent).toEqual([60, 80])
    answers.shift()!()
    await settle()
    expect(sent).toEqual([60, 80])
  })

  it('does not send the height it sent last again, unless that call failed', async () => {
    const sent: number[] = []
    let fail = false
    const relay = new SlotHeightRelay((h) => {
      sent.push(h)
      return fail ? Promise.reject(new Error('refused')) : Promise.resolve()
    })
    relay.request(60)
    await settle()
    relay.request(60)
    await settle()
    expect(sent).toEqual([60])
    fail = true
    relay.request(70)
    await settle()
    fail = false
    relay.request(70)
    await settle()
    expect(sent).toEqual([60, 70, 70])
  })

  it('sends nothing after close, not even a waiting request', async () => {
    const sent: number[] = []
    let answer: () => void = () => {}
    const relay = new SlotHeightRelay((h) => {
      sent.push(h)
      return new Promise<void>((resolve) => (answer = resolve))
    })
    relay.request(60)
    relay.request(90)
    relay.close()
    answer()
    await settle()
    relay.request(100)
    expect(sent).toEqual([60])
  })
})
