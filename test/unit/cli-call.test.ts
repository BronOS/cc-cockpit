// One plugin CLI call with its deadline and cancel (plugins/cli-call.ts), against a fake rpc: the
// answer, the timeout (exit 124), the caller going away and the RPC failing each settle it once,
// tell the host to cancel when main stops waiting, and drop the pending RPC entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callCli, type CliRpc } from '../../src/main/plugins/cli-call'
import { CLI_TIMEOUT_CODE, MAX_CLI_IO_BYTES } from '../../src/shared/plugin-cli'

interface FakeRpc extends CliRpc {
  calls: Array<{ method: string; params: unknown; signal: AbortSignal | undefined }>
  events: Array<{ event: string; params: unknown }>
  answer(value: unknown): void
  fail(err: Error): void
}

function fakeRpc(): FakeRpc {
  let settle: { resolve: (v: unknown) => void; reject: (e: Error) => void } | undefined
  const rpc: FakeRpc = {
    calls: [],
    events: [],
    call: (method, params, options) => {
      rpc.calls.push({ method, params, signal: options.signal })
      return new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
    },
    emit: (event, params) => {
      rpc.events.push({ event, params })
    },
    answer: (value) => settle?.resolve(value),
    fail: (err) => settle?.reject(err)
  }
  return rpc
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const options = { name: 'demo', callId: 7, timeoutMs: 30_000 }

describe('callCli', () => {
  it('sends cli.run with the call id and resolves with the normalized answer', async () => {
    const rpc = fakeRpc()
    const p = callCli(rpc, { pluginId: 'a.b', name: 'demo', argv: ['x'] }, options)
    expect(rpc.calls).toEqual([{ method: 'cli.run', params: { pluginId: 'a.b', name: 'demo', argv: ['x'], callId: 7 }, signal: expect.any(AbortSignal) }])
    rpc.answer({ stdout: 'x'.repeat(MAX_CLI_IO_BYTES + 10), stderr: '', code: 3 })
    const result = await p
    expect(result.code).toBe(3)
    // Re-capped here: the host is not trusted to cap.
    expect(result.stdout.length).toBeLessThan(MAX_CLI_IO_BYTES + 10)
    expect(rpc.events).toEqual([])
    // The pending RPC entry is dropped once the call settled.
    expect(rpc.calls[0]?.signal?.aborted).toBe(true)
  })

  it('answers exit 124 at the deadline, tells the host to cancel and drops the pending entry', async () => {
    const rpc = fakeRpc()
    const p = callCli(rpc, {}, options)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await p).toEqual({ stdout: '', stderr: 'ccc demo: no answer within 30 s\n', code: CLI_TIMEOUT_CODE })
    expect(rpc.events).toEqual([{ event: 'cli.cancel', params: { callId: 7 } }])
    expect(rpc.calls[0]?.signal?.aborted).toBe(true)
    // A late answer changes nothing.
    rpc.answer({ stdout: 'late', stderr: '', code: 0 })
  })

  it('rejects when the caller goes away, and tells the host to cancel', async () => {
    const rpc = fakeRpc()
    const gone = new AbortController()
    const p = callCli(rpc, {}, { ...options, peerGone: gone.signal })
    gone.abort()
    await expect(p).rejects.toThrow('demo: the caller went away')
    expect(rpc.events).toEqual([{ event: 'cli.cancel', params: { callId: 7 } }])
    expect(rpc.calls[0]?.signal?.aborted).toBe(true)
    // No timer is left behind to fire later.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rpc.events).toHaveLength(1)
  })

  it('refuses a caller that is already gone without sending anything', async () => {
    const rpc = fakeRpc()
    const gone = new AbortController()
    gone.abort()
    await expect(callCli(rpc, {}, { ...options, peerGone: gone.signal })).rejects.toThrow(/caller went away/)
    expect(rpc.calls).toEqual([])
  })

  it('rejects with the RPC error (the host exited), without a cancel event', async () => {
    const rpc = fakeRpc()
    const p = callCli(rpc, {}, options)
    rpc.fail(new Error('host exited'))
    await expect(p).rejects.toThrow('host exited')
    expect(rpc.events).toEqual([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(rpc.events).toEqual([])
  })
})
