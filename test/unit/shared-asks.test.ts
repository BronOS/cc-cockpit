import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedAsks } from '../../src/main/asks/shared-asks'

type Info = { name: string }
type Answer = 'yes' | 'no' | 'nobody'

function setup(send: boolean | (() => boolean) = true, timeoutMs = 1000, hold?: boolean) {
  const sent: Array<[number, Info & { requestId: string }]> = []
  const settled: Array<[number, string]> = []
  const asks = new SharedAsks<Info, Answer>({
    hooks: {
      send: (w, a) => {
        sent.push([w, a])
        return typeof send === 'function' ? send() : send
      },
      settled: (w, id) => void settled.push([w, id])
    },
    prefix: 'thing',
    refused: 'nobody',
    timeoutMs,
    ...(hold === undefined ? {} : { hold })
  })
  return { asks, sent, settled }
}

afterEach(() => vi.useRealTimers())

describe('SharedAsks (the shared-ask core)', () => {
  it("tells the settled hook how each ask ended: answered, timed out, or gone", async () => {
    vi.useFakeTimers()
    const hows: Array<{ id: string; answer: unknown; why: string; name: string }> = []
    const asks = new SharedAsks<Info, Answer>({
      hooks: { send: () => true, settled: (_w, id, how) => void hows.push({ id, answer: how.answer, why: how.why, name: how.info.name }) },
      prefix: 'thing',
      refused: 'nobody',
      timeoutMs: 1000
    })
    void asks.ask(1, { name: 'a' })
    void asks.ask(1, { name: 'b' })
    void asks.ask(2, { name: 'c' })
    void asks.ask(3, { name: 'd' })
    asks.answer(1, 'thing-1', 'yes')
    asks.windowClosed(2)
    asks.settleWhere((i) => i.name === 'd')
    vi.advanceTimersByTime(1000)
    expect(hows).toEqual([
      { id: 'thing-1', answer: 'yes', why: 'answered', name: 'a' },
      { id: 'thing-3', answer: 'nobody', why: 'gone', name: 'c' },
      { id: 'thing-4', answer: 'nobody', why: 'gone', name: 'd' },
      { id: 'thing-2', answer: 'nobody', why: 'timeout', name: 'b' }
    ])
  })

  it('posts the ask with a prefixed id; the first answer wins and every view hears it settled', async () => {
    const { asks, sent, settled } = setup()
    const p = asks.ask(1, { name: 'a' })
    expect(sent).toEqual([[1, { name: 'a', requestId: 'thing-1' }]])
    expect(asks.isPending(1, 'thing-1')).toBe(true)
    expect(asks.answer(1, 'thing-1', 'yes')).toBe(true)
    await expect(p).resolves.toBe('yes')
    expect(settled).toEqual([[1, 'thing-1']])
    // A second answer, of any kind, finds nothing.
    expect(asks.answer(1, 'thing-1', 'no')).toBe(false)
    expect(asks.isPending(1, 'thing-1')).toBe(false)
    expect(asks.size).toBe(0)
  })

  it('an answer from another window, or for an unknown id, is refused and the ask keeps waiting', () => {
    const { asks, settled } = setup()
    void asks.ask(1, { name: 'a' })
    expect(asks.isPending(2, 'thing-1')).toBe(false)
    expect(asks.answer(2, 'thing-1', 'yes')).toBe(false)
    expect(asks.answer(1, 'thing-9', 'yes')).toBe(false)
    expect(asks.size).toBe(1)
    expect(settled).toEqual([])
  })

  it('the info cannot carry its own request id', () => {
    const { asks, sent } = setup()
    void asks.ask(1, { name: 'a', requestId: 'forged' } as Info)
    expect(sent[0]![1].requestId).toBe('thing-1')
  })

  it('no view took it, or the send threw: refused at once', async () => {
    await expect(setup(false).asks.ask(1, { name: 'a' })).resolves.toBe('nobody')
    const throwing = setup(() => {
      throw new Error('gone')
    })
    await expect(throwing.asks.ask(1, { name: 'a' })).resolves.toBe('nobody')
    expect(throwing.asks.size).toBe(0)
  })

  it('the timeout, an aborted caller and a closed window settle refused', async () => {
    vi.useFakeTimers()
    const { asks, settled } = setup(true, 5000)
    const slow = asks.ask(1, { name: 'slow' })
    vi.advanceTimersByTime(4999)
    expect(asks.size).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(slow).resolves.toBe('nobody')
    const controller = new AbortController()
    const gone = asks.ask(1, { name: 'gone' }, controller.signal)
    controller.abort()
    await expect(gone).resolves.toBe('nobody')
    await expect(asks.ask(1, { name: 'early' }, AbortSignal.abort())).resolves.toBe('nobody')
    const closed = asks.ask(1, { name: 'closed' })
    const other = asks.ask(2, { name: 'other' })
    asks.windowClosed(1)
    await expect(closed).resolves.toBe('nobody')
    expect(asks.pendingFor(2)).toHaveLength(1)
    asks.answer(2, asks.pendingFor(2)[0]!.requestId, 'no')
    await expect(other).resolves.toBe('no')
    // The aborted-before-asking call never posted, so it never settles anything either.
    expect(settled.map(([w]) => w)).toEqual([1, 1, 1, 2])
  })

  it('a settled hook that throws still resolves the ask', async () => {
    const asks = new SharedAsks<Info, Answer>({
      hooks: {
        send: () => true,
        settled: () => {
          throw new Error('view gone')
        }
      },
      prefix: 'thing',
      refused: 'nobody',
      timeoutMs: 1000
    })
    const p = asks.ask(1, { name: 'a' })
    asks.answer(1, 'thing-1', 'yes')
    await expect(p).resolves.toBe('yes')
  })

  it('pendingFor lists the window’s own asks, oldest first, as copies (a joining view)', () => {
    const { asks } = setup()
    void asks.ask(1, { name: 'a' })
    void asks.ask(2, { name: 'b' })
    void asks.ask(1, { name: 'c' })
    const list = asks.pendingFor(1)
    expect(list).toEqual([
      { name: 'a', requestId: 'thing-1' },
      { name: 'c', requestId: 'thing-3' }
    ])
    list[0]!.name = 'changed'
    expect(asks.pendingFor(1)[0]!.name).toBe('a')
  })

  it('hold: no view now keeps the ask for a view that joins; the timeout still ends it', async () => {
    vi.useFakeTimers()
    const { asks, settled } = setup(false, 5000, true)
    const p = asks.ask(1, { name: 'held' })
    expect(asks.size).toBe(1)
    expect(asks.pendingFor(1)).toEqual([{ name: 'held', requestId: 'thing-1' }])
    expect(settled).toEqual([])
    // A view that joined (ready's replay) answers it.
    expect(asks.answer(1, 'thing-1', 'yes')).toBe(true)
    await expect(p).resolves.toBe('yes')
    const late = asks.ask(1, { name: 'late' })
    vi.advanceTimersByTime(5000)
    await expect(late).resolves.toBe('nobody')
  })

  it('hold does not keep an ask whose send threw (a broken hook, not an absent view)', async () => {
    const asks = new SharedAsks<Info, Answer>({
      hooks: {
        send: () => {
          throw new Error('broken')
        }
      },
      prefix: 'thing',
      refused: 'nobody',
      timeoutMs: 1000,
      hold: true
    })
    await expect(asks.ask(1, { name: 'a' })).resolves.toBe('nobody')
    expect(asks.size).toBe(0)
  })

  it('without hold, no view settles at once (every ask but the server-mode download offer)', async () => {
    const { asks } = setup(false, 5000, false)
    await expect(asks.ask(1, { name: 'a' })).resolves.toBe('nobody')
    expect(asks.size).toBe(0)
  })
})
