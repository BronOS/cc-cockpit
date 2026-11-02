import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RPC_MESSAGE_LENGTH,
  parseRpcMessage,
  RpcAbortedError,
  RpcClosedError,
  RpcEndpoint,
  RpcRemoteError,
  RpcTimeoutError
} from '../../src/host/rpc'
import { memoryPortPair } from '../fakes/memory-port'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseRpcMessage', () => {
  it('recognises requests, responses and events', () => {
    expect(parseRpcMessage('{"id":1,"method":"m","params":{"a":1}}')).toEqual({
      kind: 'request',
      id: 1,
      method: 'm',
      params: { a: 1 }
    })
    expect(parseRpcMessage('{"id":2,"result":5}')).toEqual({ kind: 'response', id: 2, ok: true, result: 5 })
    expect(parseRpcMessage('{"id":2}')).toEqual({ kind: 'response', id: 2, ok: true, result: undefined })
    expect(parseRpcMessage('{"id":3,"error":"no"}')).toEqual({ kind: 'response', id: 3, ok: false, error: 'no' })
    expect(parseRpcMessage('{"event":"log","params":1}')).toEqual({ kind: 'event', event: 'log', params: 1 })
  })

  it('refuses anything else with a reason', () => {
    expect(parseRpcMessage({ id: 1, method: 'm' })).toBe('not a string')
    expect(parseRpcMessage('nope')).toBe('not JSON')
    expect(parseRpcMessage('[1]')).toBe('not an object')
    expect(parseRpcMessage('{"id":0,"method":"m"}')).toBe('bad id')
    expect(parseRpcMessage('{"id":1.5,"method":"m"}')).toBe('bad id')
    expect(parseRpcMessage('{"id":"1","method":"m"}')).toBe('bad id')
    expect(parseRpcMessage('{"id":1,"method":""}')).toBe('bad method name')
    expect(parseRpcMessage(`{"id":1,"method":"${'x'.repeat(101)}"}`)).toBe('bad method name')
    expect(parseRpcMessage('{"id":1,"error":{}}')).toBe('bad error')
    // A response is { id } plus result or error, nothing else.
    expect(parseRpcMessage('{"id":2,"foo":1}')).toBe('bad response')
    expect(parseRpcMessage('{"id":2,"result":1,"extra":true}')).toBe('bad response')
    expect(parseRpcMessage('{"id":2,"result":1,"error":"x"}')).toBe('bad response')
    expect(parseRpcMessage('{"event":5}')).toBe('bad event name')
    expect(parseRpcMessage(`"${'x'.repeat(20)}"`, 10)).toMatch(/exceeds 10/)
  })
})

describe('RpcEndpoint', () => {
  it('round-trips a call and its result', async () => {
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a })
    new RpcEndpoint({ port: b, handlers: { add: (p) => (p as { x: number; y: number }).x + (p as { y: number }).y } })
    await expect(client.call('add', { x: 2, y: 3 })).resolves.toBe(5)
  })

  it('awaits an async handler and passes its rejection back as RpcRemoteError', async () => {
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a })
    new RpcEndpoint({
      port: b,
      handlers: {
        later: async () => 'done',
        boom: () => {
          throw new Error('kaput')
        }
      }
    })
    await expect(client.call('later')).resolves.toBe('done')
    const err = await client.call('boom').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcRemoteError)
    expect((err as Error).message).toBe('kaput')
  })

  it('answers an unknown method with an error, also for prototype names', async () => {
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a })
    new RpcEndpoint({ port: b, handlers: { known: () => 1 } })
    await expect(client.call('nope')).rejects.toThrow('unknown method: nope')
    await expect(client.call('toString')).rejects.toThrow('unknown method: toString')
    await expect(client.call('__proto__')).rejects.toThrow('unknown method: __proto__')
  })

  it('times out a call that gets no answer, and drops the late answer', async () => {
    vi.useFakeTimers()
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a, defaultTimeoutMs: 1000 })
    let release: (v: string) => void = () => {}
    new RpcEndpoint({ port: b, handlers: { slow: () => new Promise((r) => (release = r)) } })
    const call = client.call('slow')
    const caught = call.catch((e: unknown) => e)
    await flush()
    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void call.then(
      () => (settled = true),
      () => (settled = true)
    )
    await flush()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const err = await caught
    expect(err).toBeInstanceOf(RpcTimeoutError)
    expect((err as Error).message).toBe('slow: no answer within 1000 ms')
    // The late answer arrives and is ignored (no throw, nothing pending).
    release('late')
    await flush()
    // A per-call timeout overrides the default.
    const quick = client.call('slow', undefined, { timeoutMs: 10 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(10)
    expect(await quick).toBeInstanceOf(RpcTimeoutError)
  })

  it('waits without a timer for timeoutMs Infinity, until the answer or close', async () => {
    vi.useFakeTimers()
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a, defaultTimeoutMs: 1000 })
    let release: (v: string) => void = () => {}
    new RpcEndpoint({ port: b, handlers: { open: () => new Promise((r) => (release = r)) } })
    const answered = client.call('open', undefined, { timeoutMs: Infinity })
    await flush()
    // A day later still pending (setTimeout(fn, Infinity) would have fired after 1 ms).
    await vi.advanceTimersByTimeAsync(24 * 3600_000)
    expect(vi.getTimerCount()).toBe(0)
    release('closed by the user')
    await expect(answered).resolves.toBe('closed by the user')
    const hanging = client.call('open', undefined, { timeoutMs: Infinity }).catch((e: unknown) => e)
    await flush()
    client.close('plugin host exited')
    expect(await hanging).toBeInstanceOf(RpcClosedError)
  })

  it('an aborted signal drops the pending call, also one with no timer, and ignores its late answer', async () => {
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a })
    let release: (v: string) => void = () => {}
    new RpcEndpoint({ port: b, handlers: { hang: () => new Promise((r) => (release = r)), echo: (p) => p } })
    const drop = new AbortController()
    const hanging = client.call('hang', undefined, { timeoutMs: Infinity, signal: drop.signal }).catch((e: unknown) => e)
    await flush()
    expect(client.pendingCalls).toBe(1)
    drop.abort()
    const err = await hanging
    expect(err).toBeInstanceOf(RpcAbortedError)
    expect((err as Error).message).toBe('hang: abandoned by the caller')
    expect(client.pendingCalls).toBe(0)
    release('late')
    await flush()
    // A signal already aborted never sends; an answered call ignores a later abort.
    await expect(client.call('echo', 1, { signal: drop.signal })).rejects.toBeInstanceOf(RpcAbortedError)
    const later = new AbortController()
    await expect(client.call('echo', 2, { signal: later.signal })).resolves.toBe(2)
    later.abort()
    expect(client.pendingCalls).toBe(0)
  })

  it('rejects pending calls when closed, and every later call at once', async () => {
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a })
    new RpcEndpoint({ port: b, handlers: { hang: () => new Promise(() => {}) } })
    const p = client.call('hang').catch((e: unknown) => e)
    await flush()
    client.close('plugin host exited')
    const err = await p
    expect(err).toBeInstanceOf(RpcClosedError)
    expect((err as Error).message).toBe('hang: plugin host exited')
    expect(client.closed).toBe(true)
    await expect(client.call('hang')).rejects.toBeInstanceOf(RpcClosedError)
    client.close('again') // idempotent
  })

  it('delivers one-way events and ignores a throwing event handler', async () => {
    const [a, b] = memoryPortPair()
    const events: unknown[] = []
    const log = vi.fn()
    const sender = new RpcEndpoint({ port: a })
    new RpcEndpoint({
      port: b,
      onEvent: (event, params) => {
        if (event === 'bad') throw new Error('handler bug')
        events.push([event, params])
      },
      log
    })
    sender.emit('bad')
    sender.emit('log', { text: 'hi' })
    await flush()
    expect(events).toEqual([['log', { text: 'hi' }]])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('handler bug'))
  })

  it('drops malformed and oversized incoming messages without answering', async () => {
    const [, b] = memoryPortPair()
    const log = vi.fn()
    const handler = vi.fn(() => 1)
    new RpcEndpoint({ port: b, handlers: { m: handler }, log, maxMessageLength: 100 })
    b.inject({ id: 1, method: 'm' }) // an object, not a JSON string
    b.inject('garbage')
    b.inject(JSON.stringify({ id: 2, method: 'm', params: 'x'.repeat(200) }))
    await flush()
    expect(handler).not.toHaveBeenCalled()
    expect(b.sent).toEqual([])
    expect(log).toHaveBeenCalledTimes(3)
    expect(log.mock.calls[2]?.[0]).toMatch(/exceeds 100/)
  })

  it('does not settle a pending call with a malformed response', async () => {
    const [a] = memoryPortPair()
    const log = vi.fn()
    const client = new RpcEndpoint({ port: a, log })
    let settled = false
    const call = client.call('m')
    void call.then(
      () => (settled = true),
      () => (settled = true)
    )
    a.inject(JSON.stringify({ id: 1, foo: 1 }))
    await flush()
    expect(settled).toBe(false)
    expect(log).toHaveBeenCalledWith('rpc: dropped a message: bad response')
    a.inject(JSON.stringify({ id: 1, result: 'ok' }))
    expect(await call).toBe('ok')
  })

  it('hands a __proto__ key in params to the handler as plain data', async () => {
    const [, b] = memoryPortPair()
    let got: unknown
    new RpcEndpoint({ port: b, handlers: { m: (p) => ((got = p), 'done') } })
    // JSON.parse makes `__proto__` an own property; nothing may reach Object.prototype.
    b.inject('{"id":1,"method":"m","params":{"__proto__":{"polluted":1}}}')
    await flush()
    expect(Object.prototype.hasOwnProperty.call(got, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(b.sent).toEqual(['{"id":1,"result":"done"}'])
  })

  it('refuses to send an oversized call and answers an oversized result with an error', async () => {
    const [a, b] = memoryPortPair()
    const client = new RpcEndpoint({ port: a, maxMessageLength: 200 })
    new RpcEndpoint({ port: b, handlers: { big: () => 'y'.repeat(500) }, maxMessageLength: 200 })
    await expect(client.call('m', 'x'.repeat(500))).rejects.toThrow(/exceeds 200/)
    expect(a.sent).toEqual([])
    await expect(client.call('big')).rejects.toThrow(/big: result not sent: .*exceeds 200/)
  })

  it('caps messages at 1 MiB by default', () => {
    expect(MAX_RPC_MESSAGE_LENGTH).toBe(1024 * 1024)
  })

  it('keeps calls in both directions apart (ids are per side)', async () => {
    const [a, b] = memoryPortPair()
    const left = new RpcEndpoint({ port: a, handlers: { who: () => 'left' } })
    const right = new RpcEndpoint({ port: b, handlers: { who: () => 'right' } })
    const [r1, r2] = await Promise.all([left.call('who'), right.call('who')])
    expect(r1).toBe('right')
    expect(r2).toBe('left')
  })
})
