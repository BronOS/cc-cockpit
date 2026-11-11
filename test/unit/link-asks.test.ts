import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseAsk } from '../../src/main/asks/shared-asks'
import { LINK_ASK_MS, LinkAsks, type LinkAskInfo } from '../../src/main/plugins/link-asks'
import type { LinkDialogInfo } from '../../src/main/plugins/link-request'

const INFO: LinkDialogInfo = { id: 'x.p', name: 'P', path: '/home/me/p', caller: 'tab' }
const DESKTOP = { remote: false }
const REMOTE = { remote: true }

function setup(send = true): { asks: LinkAsks; sent: Array<[number, LinkAskInfo]>; settled: Array<[number, string]> } {
  const sent: Array<[number, LinkAskInfo]> = []
  const settled: Array<[number, string]> = []
  const asks = new LinkAsks({
    send: (w, a) => (sent.push([w, a]), send),
    settled: (w, id) => void settled.push([w, id])
  })
  return { asks, sent, settled }
}

afterEach(() => vi.useRealTimers())

describe('LinkAsks (the shared in-page link confirm)', () => {
  it('Allow from any view of the window settles true once, and every view hears it settled', async () => {
    const { asks, sent, settled } = setup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(sent[0]![1]).toMatchObject(INFO)
    expect(asks.pendingFor(1)).toEqual([{ requestId: id, ...INFO }])
    expect(asks.answer(1, id, true, DESKTOP)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(settled).toEqual([[1, id]])
    // The second view's answer finds nothing, whatever it says.
    expect(asks.answer(1, id, false, DESKTOP)).toBe(false)
    expect(asks.pendingFor(1)).toEqual([])
  })

  it('Deny settles false', async () => {
    const { asks, sent } = setup()
    const p = asks.ask(1, INFO)
    asks.answer(1, sent[0]![1].requestId, false, DESKTOP)
    await expect(p).resolves.toBe(false)
  })

  it('another window cannot answer, and a non-boolean-true answer is never Allow', async () => {
    const { asks, sent } = setup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(2, id, true, DESKTOP)).toBe(false)
    expect(asks.pendingFor(1)).toHaveLength(1)
    asks.answer(1, id, 'yes' as unknown as boolean, DESKTOP)
    await expect(p).resolves.toBe(false)
  })

  it('a remote view’s Allow is refused and the ask keeps waiting for the desktop', async () => {
    const { asks, sent, settled } = setup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(1, id, true, REMOTE)).toBe(false)
    // A `remote` that is not exactly false is never the desktop.
    expect(asks.answer(1, id, true, {} as { remote: boolean })).toBe(false)
    expect(asks.pendingFor(1)).toHaveLength(1)
    expect(settled).toEqual([])
    expect(asks.answer(1, id, true, DESKTOP)).toBe(true)
    await expect(p).resolves.toBe(true)
  })

  it('a remote view’s Deny settles false for every view', async () => {
    const { asks, sent, settled } = setup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(1, id, false, REMOTE)).toBe(true)
    await expect(p).resolves.toBe(false)
    expect(settled).toEqual([[1, id]])
    // The desktop's late Allow finds nothing.
    expect(asks.answer(1, id, true, DESKTOP)).toBe(false)
  })

  it('no view took the ask: Deny at once', async () => {
    const { asks } = setup(false)
    await expect(asks.ask(1, INFO)).resolves.toBe(false)
    expect(asks.size).toBe(0)
  })

  it('a closed window, an aborted caller and the timeout are all Deny', async () => {
    vi.useFakeTimers()
    const { asks, settled } = setup()
    const closed = asks.ask(1, INFO)
    asks.windowClosed(1)
    await expect(closed).resolves.toBe(false)
    const controller = new AbortController()
    const gone = asks.ask(1, INFO, controller.signal)
    controller.abort()
    await expect(gone).resolves.toBe(false)
    await expect(asks.ask(1, INFO, AbortSignal.abort())).resolves.toBe(false)
    const slow = asks.ask(1, INFO)
    vi.advanceTimersByTime(LINK_ASK_MS)
    await expect(slow).resolves.toBe(false)
    expect(settled).toHaveLength(3)
    expect(asks.size).toBe(0)
  })

  it('pendingFor lists only the window’s own asks, oldest first', () => {
    const { asks } = setup()
    void asks.ask(1, INFO)
    void asks.ask(2, { ...INFO, id: 'y.q' })
    void asks.ask(1, { ...INFO, id: 'z.r' })
    expect(asks.pendingFor(1).map((a) => a.id)).toEqual(['x.p', 'z.r'])
    expect(asks.pendingFor(2).map((a) => a.id)).toEqual(['y.q'])
  })
})

describe('chooseAsk (link)', () => {
  it('uses the shared ask while a browser view is attached and the native dialog otherwise', async () => {
    let remote = false
    const calls: string[] = []
    const confirm = chooseAsk({
      server: false,
      hasRemoteView: () => remote,
      shared: async () => (calls.push('shared'), true),
      native: async () => (calls.push('native'), false)
    })
    await expect(confirm(1, INFO)).resolves.toBe(false)
    remote = true
    await expect(confirm(1, INFO)).resolves.toBe(true)
    expect(calls).toEqual(['native', 'shared'])
  })
})

// design-web.md §9.6: in server mode every signed-in view is the owner.
describe('LinkAsks in server mode', () => {
  function serverSetup(send = true) {
    const sent: Array<[number, LinkAskInfo]> = []
    const settled: Array<[number, string]> = []
    const asks = new LinkAsks(
      { send: (w, a) => (sent.push([w, a]), send), settled: (w, id) => void settled.push([w, id]) },
      LINK_ASK_MS,
      { server: true }
    )
    return { asks, sent, settled }
  }

  it('a remote view’s Allow is taken', async () => {
    const { asks, sent, settled } = serverSetup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(1, id, true, REMOTE)).toBe(true)
    await expect(p).resolves.toBe(true)
    expect(settled).toEqual([[1, id]])
  })

  it('an answer for another window’s ask is refused, Allow or not', async () => {
    const { asks, sent } = serverSetup()
    const p = asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(2, id, true, REMOTE)).toBe(false)
    expect(asks.answer(2, id, false, DESKTOP)).toBe(false)
    expect(asks.pendingFor(1)).toHaveLength(1)
    expect(asks.answer(1, id, false, REMOTE)).toBe(true)
    await expect(p).resolves.toBe(false)
  })

  it('a non-boolean-true answer is never Allow there either', async () => {
    const { asks, sent } = serverSetup()
    const p = asks.ask(1, INFO)
    asks.answer(1, sent[0]![1].requestId, 1 as unknown as boolean, REMOTE)
    await expect(p).resolves.toBe(false)
  })

  it('with only the hidden page attached the ask waits, a joining view finds it, and 5 min is Deny', async () => {
    vi.useFakeTimers()
    // The hidden page is a view of the window: the send is taken, so nothing settles at once.
    const { asks, sent } = serverSetup(true)
    const p = asks.ask(1, INFO)
    vi.advanceTimersByTime(LINK_ASK_MS - 1)
    expect(asks.pendingFor(1)).toEqual([sent[0]![1]])
    vi.advanceTimersByTime(1)
    await expect(p).resolves.toBe(false)
    expect(asks.pendingFor(1)).toEqual([])
  })

  it('the desktop rule is untouched without the flag: a remote Allow is refused whatever it claims', () => {
    const { asks, sent } = setup()
    void asks.ask(1, INFO)
    const id = sent[0]![1].requestId
    expect(asks.answer(1, id, true, REMOTE)).toBe(false)
    expect(asks.answer(1, id, true, { remote: 'false' } as unknown as { remote: boolean })).toBe(false)
    expect(asks.size).toBe(1)
  })
})

describe('chooseAsk (link) in server mode', () => {
  it('always takes the shared ask, never the native dialog (nor a test run’s queued fake)', async () => {
    const calls: string[] = []
    const confirm = chooseAsk({
      server: true,
      hasRemoteView: () => false,
      shared: async () => (calls.push('shared'), false),
      native: async () => (calls.push('native'), true)
    })
    await expect(confirm(1, INFO)).resolves.toBe(false)
    expect(calls).toEqual(['shared'])
  })
})
