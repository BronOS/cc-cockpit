// ctx.sessions.close's wait for the window's answer (close-asks.ts): a shared ask (design-web.md
// §5.1, plan Task 23) shown on every view of the window it went to, settled by the first answer
// from any of them (a decline waits for the others), refused from another window, false when the
// window cannot be asked, closes, or the wait runs out; every view hears `settled`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_ASK_MS, CloseAsks, closeWillAsk } from '../../src/main/sessions/close-asks'
import { ViewRegistry, type ViewSink } from '../../src/main/views/view-registry'
import type { EventChannel } from '../../src/shared/ipc'
import { desktopViewId } from '../../src/shared/views'

let sent: { windowId: number; requestId: string; tabId: string }[]
let settled: { windowId: number; requestId: string }[]
let views: Map<number, string[]>
let closes: { windowId: number; viewId: string; tabId: string }[]
let asks: CloseAsks
/** What a test's close hook does: closes (true), cannot (false). */
let closeResult: boolean
const close = (windowId: number, viewId: string, tabId: string): boolean => {
  closes.push({ windowId, viewId, tabId })
  return closeResult
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  settled = []
  closes = []
  closeResult = true
  views = new Map([
    [1, ['desktop:1']],
    [2, ['desktop:2']]
  ])
  asks = new CloseAsks({
    send: (windowId, ask) => {
      if (windowId === 99) return false
      sent.push({ windowId, ...ask })
      return true
    },
    settled: (windowId, requestId) => settled.push({ windowId, requestId }),
    close,
    viewsOf: (windowId) => views.get(windowId) ?? []
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
    expect(asks.answer(2, 'desktop:2', first!.requestId, { closed: true })).toBe(false)
    expect(asks.answer(1, 'desktop:1', 'close-nope', { closed: true })).toBe(false)
    expect(asks.answer(1, 'desktop:1', first!.requestId, { closed: true })).toBe(true)
    expect(asks.answer(1, 'desktop:1', second!.requestId, { closed: false })).toBe(true)
    await expect(closed).resolves.toBe(true)
    await expect(cancelled).resolves.toBe(false)
    // Settled once: a second answer finds nothing.
    expect(asks.answer(1, 'desktop:1', first!.requestId, { closed: false })).toBe(false)
    expect(asks.size).toBe(0)
    // Every settle is told to the window's views.
    expect(settled).toEqual([
      { windowId: 1, requestId: first!.requestId },
      { windowId: 1, requestId: second!.requestId }
    ])
  })

  it('the first answer from any view of the window wins; a later one finds nothing', async () => {
    views.set(1, ['desktop:1', 'web:1'])
    const p = asks.ask(1, 't1')
    const id = sent[0]!.requestId
    expect(asks.answer(1, 'web:1', id, { closed: false })).toBe(true)
    expect(asks.answer(1, 'desktop:1', id, { closed: true })).toBe(false)
    await expect(p).resolves.toBe(false)
    expect(settled).toEqual([{ windowId: 1, requestId: id }])
  })

  it('a decline waits for the other views; it ends the ask only once every live view declined', async () => {
    views.set(1, ['desktop:1', 'web:1'])
    const p = asks.ask(1, 't1')
    const id = sent[0]!.requestId
    // The browser was on the settings screen: the desktop's dialog stays the person's to answer.
    expect(asks.answer(1, 'web:1', id, { closed: false, declined: true })).toBe(true)
    expect(asks.size).toBe(1)
    expect(settled).toEqual([])
    expect(asks.answer(1, 'desktop:1', id, { closed: true })).toBe(true)
    await expect(p).resolves.toBe(true)

    const q = asks.ask(1, 't2')
    const id2 = sent[1]!.requestId
    asks.answer(1, 'web:1', id2, { closed: false, declined: true })
    // A view that joined after the ask went out (it got it in `ready`) has not declined.
    views.set(1, ['desktop:1', 'web:1', 'web:2'])
    asks.answer(1, 'desktop:1', id2, { closed: false, declined: true })
    expect(asks.size).toBe(1)
    asks.answer(1, 'web:2', id2, { closed: false, declined: true })
    await expect(q).resolves.toBe(false)
  })

  it('a view leaving ends an ask every remaining view declined', async () => {
    views.set(1, ['desktop:1', 'web:1'])
    const p = asks.ask(1, 't1')
    const untouched = asks.ask(1, 't2')
    asks.answer(1, 'desktop:1', sent[0]!.requestId, { closed: false, declined: true })
    asks.viewGone()
    expect(asks.size).toBe(2)
    views.set(1, ['desktop:1'])
    asks.viewGone()
    await expect(p).resolves.toBe(false)
    // An ask nobody declined still waits for the desktop.
    expect(asks.pendingFor(1)).toEqual([{ requestId: sent[1]!.requestId, tabId: 't2' }])
    asks.windowClosed(1)
    await expect(untouched).resolves.toBe(false)
  })

  it('without a view list a decline is the answer (one view)', async () => {
    const single = new CloseAsks({ send: () => true, close })
    const p = single.ask(1, 't1')
    expect(single.answer(1, 'desktop:1', 'close-1', { closed: false, declined: true })).toBe(true)
    await expect(p).resolves.toBe(false)
  })

  it('pendingFor lists the window’s waiting asks, oldest first, for a joining view', () => {
    void asks.ask(1, 't1')
    void asks.ask(2, 't9')
    void asks.ask(1, 't2')
    expect(asks.pendingFor(1)).toEqual([
      { requestId: sent[0]!.requestId, tabId: 't1' },
      { requestId: sent[2]!.requestId, tabId: 't2' }
    ])
    expect(asks.pendingFor(3)).toEqual([])
  })

  it('answers false at once for a window that cannot be asked, or a send that throws', async () => {
    await expect(asks.ask(99, 't1')).resolves.toBe(false)
    const throwing = new CloseAsks({
      send: () => {
        throw new Error('gone')
      },
      close
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

  it('main closes the tab only on the winning Close, with the tab id it asked about', async () => {
    views.set(1, ['desktop:1', 'web:1'])
    const p = asks.ask(1, 't1')
    const id = sent[0]!.requestId
    expect(asks.answer(1, 'web:1', id, { closed: true })).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(closes).toEqual([{ windowId: 1, viewId: 'web:1', tabId: 't1' }])
  })

  it('a Close arriving after another view’s Cancel won closes nothing (the race)', async () => {
    views.set(1, ['desktop:1', 'web:1'])
    const p = asks.ask(1, 't1')
    const id = sent[0]!.requestId
    // Both views answered at once; the browser's Cancel reached main first.
    expect(asks.answer(1, 'web:1', id, { closed: false })).toBe(true)
    expect(asks.answer(1, 'desktop:1', id, { closed: true })).toBe(false)
    await expect(p).resolves.toBe(false)
    expect(closes).toEqual([])
  })

  it('a decline, a Cancel and an answer from another window never close', async () => {
    views.set(1, ['desktop:1', 'web:1'])
    const p = asks.ask(1, 't1')
    const id = sent[0]!.requestId
    asks.answer(1, 'web:1', id, { closed: true, declined: true })
    asks.answer(2, 'desktop:2', id, { closed: true })
    expect(closes).toEqual([])
    asks.answer(1, 'desktop:1', id, { closed: false })
    await expect(p).resolves.toBe(false)
    expect(closes).toEqual([])
  })

  it('a winning Close whose close fails or throws answers false to the view and the plugin', async () => {
    closeResult = false
    const p = asks.ask(1, 't1')
    expect(asks.answer(1, 'desktop:1', sent[0]!.requestId, { closed: true })).toBe(false)
    await expect(p).resolves.toBe(false)
    expect(asks.size).toBe(0)
    const throwing = new CloseAsks({
      send: () => true,
      close: () => {
        throw new Error('unknown tab')
      }
    })
    const q = throwing.ask(1, 't1')
    expect(throwing.answer(1, 'desktop:1', 'close-1', { closed: true })).toBe(false)
    await expect(q).resolves.toBe(false)
    expect(throwing.size).toBe(0)
  })

  it('a settled hook that throws does not keep the plugin from its answer', async () => {
    const loud = new CloseAsks({
      send: () => true,
      settled: () => {
        throw new Error('view gone')
      },
      close
    })
    const p = loud.ask(1, 't1')
    loud.answer(1, 'desktop:1', 'close-1', { closed: true })
    await expect(p).resolves.toBe(true)
  })
})

describe('CloseAsks through the ViewRegistry (two views of one window)', () => {
  function sink(): ViewSink & { events: Array<{ channel: EventChannel; payload: unknown }> } {
    const events: Array<{ channel: EventChannel; payload: unknown }> = []
    return { events, send: (channel, payload) => void events.push({ channel, payload }), isClosed: () => false }
  }

  it('both views are asked, one answers, the other is told it settled; another window hears nothing', async () => {
    const registry = new ViewRegistry({ windowIdOf: () => undefined })
    const desktop = sink()
    const web = sink()
    const other = sink()
    registry.addDesktop(1, desktop)
    registry.addRemote(1, 'web:1', web)
    registry.addDesktop(2, other)
    const shared = new CloseAsks({
      send: (windowId, ask) => registry.toWindow(windowId, 'sessions.closeAsk', ask),
      settled: (windowId, requestId) => registry.toWindow(windowId, 'sessions.closeSettled', { requestId }),
      close,
      viewsOf: (windowId) => registry.viewsOf(windowId)
    })
    const p = shared.ask(1, 't1')
    const ask = { requestId: 'close-1', tabId: 't1' }
    expect(desktop.events).toEqual([{ channel: 'sessions.closeAsk', payload: ask }])
    expect(web.events).toEqual([{ channel: 'sessions.closeAsk', payload: ask }])
    // Window 2 names the id: refused, the ask still waits.
    expect(shared.answer(2, desktopViewId(2), 'close-1', { closed: true })).toBe(false)
    expect(shared.size).toBe(1)
    // The browser answers first.
    expect(shared.answer(1, 'web:1', 'close-1', { closed: true })).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(desktop.events.at(-1)).toEqual({ channel: 'sessions.closeSettled', payload: { requestId: 'close-1' } })
    expect(web.events.at(-1)).toEqual({ channel: 'sessions.closeSettled', payload: { requestId: 'close-1' } })
    expect(other.events).toEqual([])
    // The desktop's late answer finds nothing.
    expect(shared.answer(1, desktopViewId(1), 'close-1', { closed: false })).toBe(false)
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
