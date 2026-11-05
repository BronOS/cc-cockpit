// ctx.sessions.close's wait for the window's answer (close-asks.ts): answered only by the window it
// went to, false when the window cannot be asked, closes, or the wait runs out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_ASK_MS, CloseAsks, closeWillAsk } from '../../src/main/sessions/close-asks'

let sent: { windowId: number; requestId: string; tabId: string }[]
let asks: CloseAsks

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  asks = new CloseAsks((windowId, ask) => {
    if (windowId === 99) return false
    sent.push({ windowId, ...ask })
    return true
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CloseAsks', () => {
  it("settles with the asked window's answer, ignoring other windows and unknown ids", async () => {
    const closed = asks.ask(1, 't1')
    const cancelled = asks.ask(1, 't2')
    expect(sent.map((s) => [s.windowId, s.tabId])).toEqual([
      [1, 't1'],
      [1, 't2']
    ])
    const [first, second] = sent
    expect(first!.requestId).not.toBe(second!.requestId)
    expect(asks.answer(2, first!.requestId, true)).toBe(false)
    expect(asks.answer(1, 'close-nope', true)).toBe(false)
    expect(asks.answer(1, first!.requestId, true)).toBe(true)
    expect(asks.answer(1, second!.requestId, false)).toBe(true)
    await expect(closed).resolves.toBe(true)
    await expect(cancelled).resolves.toBe(false)
    // Settled once: a second answer finds nothing.
    expect(asks.answer(1, first!.requestId, false)).toBe(false)
    expect(asks.size).toBe(0)
  })

  it('answers false at once for a window that cannot be asked, or a send that throws', async () => {
    await expect(asks.ask(99, 't1')).resolves.toBe(false)
    const throwing = new CloseAsks(() => {
      throw new Error('gone')
    })
    await expect(throwing.ask(1, 't1')).resolves.toBe(false)
    expect(asks.size).toBe(0)
  })

  it('answers false when the window closes or the wait runs out', async () => {
    const a = asks.ask(1, 't1')
    const b = asks.ask(2, 't2')
    asks.windowClosed(1)
    await expect(a).resolves.toBe(false)
    expect(asks.size).toBe(1)
    vi.advanceTimersByTime(CLOSE_ASK_MS)
    await expect(b).resolves.toBe(false)
    expect(asks.size).toBe(0)
  })
})

describe('closeWillAsk (when a plugin close raises the window)', () => {
  it('only for a tab whose process is alive, with the setting on', () => {
    expect(closeWillAsk({}, true)).toBe(true)
    expect(closeWillAsk({ exit: undefined }, true)).toBe(true)
    expect(closeWillAsk({ exit: { code: 0 } }, true)).toBe(false)
    expect(closeWillAsk({}, false)).toBe(false)
  })
})
