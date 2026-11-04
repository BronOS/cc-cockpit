import { describe, expect, it } from 'vitest'
import { SLOT_HEIGHT_MESSAGE, SLOT_MESSAGE } from '../../src/sdk/panel-core'
import type { SlotFrameInfo } from '../../src/shared/ipc'
import {
  SlotHeightRelay,
  slotColumn,
  slotFrameHeight,
  slotHeightRequest,
  slotIntro
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
