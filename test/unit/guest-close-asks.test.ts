// D-9 (design-guests §7, spec-review 6): a write guest closing a tab it did not open asks the owner. createGuestCloseAsks is
// a shared ask on the window's views (tabs.guestCloseAsk out, tabs.guestCloseSettled when over): the first answer wins,
// nobody answering keeps the tab (false), and settleGoneCloseAsks ends the asks of tabs that ended another way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloseAsks } from '../../src/main/sessions/close-asks'
import { createGuestCloseAsks, GUEST_CLOSE_ASK_MS, settleGoneCloseAsks, type GuestCloseAsk } from '../../src/main/tabs/guest-close-asks'

type Sent = { windowId: number; channel: string; payload: unknown }
let sent: Sent[]

const ASK: GuestCloseAsk = { tabId: 't1', guestId: 'g1', guestName: 'Ann', title: 'build' }

function setup(timeoutMs?: number, toWindow = true) {
  const views = {
    toWindow: (windowId: number, channel: 'tabs.guestCloseAsk' | 'tabs.guestCloseSettled', payload: unknown) => {
      sent.push({ windowId, channel, payload })
      return toWindow
    }
  }
  return createGuestCloseAsks(views, timeoutMs)
}

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createGuestCloseAsks', () => {
  it('sends tabs.guestCloseAsk to the window with a guest-close request id', () => {
    const asks = setup()
    void asks.ask(4, ASK)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ windowId: 4, channel: 'tabs.guestCloseAsk' })
    const payload = sent[0]!.payload as { requestId: string }
    expect(payload).toEqual({ requestId: payload.requestId, ...ASK })
    expect(payload.requestId).toMatch(/^guest-close-/)
  })

  it('the first answer wins, the settled event goes to the window, a later answer finds nothing', async () => {
    const asks = setup()
    const p = asks.ask(4, ASK)
    const { requestId } = sent[0]!.payload as { requestId: string }
    expect(asks.answer(4, requestId, true)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(sent[1]).toEqual({ windowId: 4, channel: 'tabs.guestCloseSettled', payload: { requestId } })
    expect(asks.answer(4, requestId, false)).toBe(false)
    expect(sent).toHaveLength(2)
    expect(asks.size).toBe(0)
  })

  it('an answer from another window is ignored', async () => {
    const asks = setup()
    const p = asks.ask(4, ASK)
    const { requestId } = sent[0]!.payload as { requestId: string }
    expect(asks.answer(5, requestId, true)).toBe(false)
    expect(asks.size).toBe(1)
    asks.answer(4, requestId, false)
    await expect(p).resolves.toBe(false)
  })

  it('nobody answering within GUEST_CLOSE_ASK_MS keeps the tab (false) and tells the views', async () => {
    const asks = setup()
    const p = asks.ask(4, ASK)
    vi.advanceTimersByTime(GUEST_CLOSE_ASK_MS - 1)
    expect(asks.size).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(p).resolves.toBe(false)
    expect(sent.map((s) => s.channel)).toEqual(['tabs.guestCloseAsk', 'tabs.guestCloseSettled'])
  })

  it('a custom timeout is honoured', async () => {
    const asks = setup(1000)
    const p = asks.ask(4, ASK)
    vi.advanceTimersByTime(1000)
    await expect(p).resolves.toBe(false)
  })

  it('no view took the ask: refused at once', async () => {
    const asks = setup(undefined, false)
    await expect(asks.ask(4, ASK)).resolves.toBe(false)
  })
})

describe('settleGoneCloseAsks', () => {
  it('settles (false) the asks whose tab is no longer live and leaves the others', async () => {
    const asks = setup()
    const gone = asks.ask(4, { ...ASK, tabId: 'gone' })
    const live = asks.ask(4, { ...ASK, tabId: 'live' })
    settleGoneCloseAsks(asks, (tabId) => tabId === 'live')
    await expect(gone).resolves.toBe(false)
    expect(asks.size).toBe(1)
    const settled = sent.filter((s) => s.channel === 'tabs.guestCloseSettled')
    expect(settled).toHaveLength(1)
    const liveId = (sent[1]!.payload as { requestId: string }).requestId
    expect(asks.answer(4, liveId, true)).toBe(true)
    await expect(live).resolves.toBe(true)
  })

  it('does nothing with no pending ask', () => {
    const asks = setup()
    const isLive = vi.fn(() => false)
    settleGoneCloseAsks(asks, isLive)
    expect(isLive).not.toHaveBeenCalled()
  })
})

describe('CloseAsks ownerView: a guest view does not block "every live view declined"', () => {
  function closeAsks(views: string[], ownerView?: (viewId: string) => boolean) {
    const settled: string[] = []
    const asks = new CloseAsks({
      send: () => true,
      settled: (_w, id) => void settled.push(id),
      close: () => true,
      viewsOf: () => views,
      ...(ownerView ? { ownerView } : {})
    })
    return { asks, settled }
  }
  const decline = { closed: false, declined: true }

  it('every owner view declining ends the ask although a guest view never answered', async () => {
    const { asks } = closeAsks(['desktop:1', 'web:1', 'web:9'], (v) => v !== 'web:9')
    const p = asks.ask(1, 't1')
    const id = asks.pendingFor(1)[0]!.requestId
    asks.answer(1, 'desktop:1', id, decline)
    expect(asks.size).toBe(1)
    asks.answer(1, 'web:1', id, decline)
    await expect(p).resolves.toBe(false)
  })

  it('without ownerView the guest view still has to decline (unchanged)', async () => {
    const { asks } = closeAsks(['desktop:1', 'web:9'])
    const p = asks.ask(1, 't1')
    const id = asks.pendingFor(1)[0]!.requestId
    asks.answer(1, 'desktop:1', id, decline)
    expect(asks.size).toBe(1)
    asks.answer(1, 'web:9', id, decline)
    await expect(p).resolves.toBe(false)
  })

  it('an owner view that has not declined still keeps the ask open', () => {
    const { asks } = closeAsks(['desktop:1', 'web:1', 'web:9'], (v) => v !== 'web:9')
    void asks.ask(1, 't1')
    const id = asks.pendingFor(1)[0]!.requestId
    asks.answer(1, 'web:9', id, decline)
    asks.answer(1, 'desktop:1', id, decline)
    expect(asks.size).toBe(1)
  })
})
