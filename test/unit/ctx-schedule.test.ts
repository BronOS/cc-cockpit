import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { createScheduler, MAX_SCHEDULE_SECONDS } from '../../src/host/ctx/schedule'
import { hostSpec } from '../fakes/host-spec'

describe('ctx.schedule', () => {
  let report: ReturnType<typeof vi.fn<(error: string | undefined) => void>>
  let log: ReturnType<typeof vi.fn<(message: string) => void>>
  beforeEach(() => {
    vi.useFakeTimers()
    report = vi.fn<(error: string | undefined) => void>()
    log = vi.fn<(message: string) => void>()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = (runTimeoutMs = 60_000) => createScheduler({ runTimeoutMs, log, report })

  it('runs the function every interval, the first time one interval after the call', async () => {
    const fn = vi.fn()
    make().schedule(5, fn)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('skips a tick while the previous run is still in progress (no overlap)', async () => {
    let finish: () => void = () => {}
    let started = 0
    make().schedule(1, () => {
      started++
      return new Promise<void>((r) => (finish = r))
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(started).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(started).toBe(1)
    finish()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(started).toBe(2)
  })

  it('abandons a run after the timeout, reports it, and lets the next tick start a new run', async () => {
    let started = 0
    make(10_000).schedule(5, () => {
      started++
      return new Promise(() => {})
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(started).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(report).toHaveBeenCalledWith('run did not finish within 10 s (abandoned)')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not finish within 10 s'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(started).toBe(2)
  })

  it('reports an error once when a job starts failing and clears it when it works again', async () => {
    let fail = true
    make().schedule(1, async () => {
      if (fail) throw new Error('boom')
    })
    await vi.advanceTimersByTimeAsync(3_000)
    // Three failed runs, one report (transitions only), every failure logged.
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith('run failed: boom')
    expect(log).toHaveBeenCalledTimes(3)
    fail = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(report).toHaveBeenLastCalledWith(undefined)
    expect(report).toHaveBeenCalledTimes(2)
  })

  it('treats a synchronous throw like a failed run', async () => {
    make().schedule(1, () => {
      throw new Error('sync boom')
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(report).toHaveBeenCalledWith('run failed: sync boom')
  })

  it('keeps the error showing while any job still fails', async () => {
    const s = make()
    s.schedule(1, () => {
      throw new Error('a')
    })
    const stopB = s.schedule(1, () => {
      throw new Error('b')
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(report).toHaveBeenCalledTimes(1)
    stopB()
    expect(report).toHaveBeenCalledTimes(1)
  })

  it('the disposer stops the job, twice is harmless, and a stopped failing job no longer shows the error', async () => {
    const fn = vi.fn(() => {
      throw new Error('x')
    })
    const stop = make().schedule(1, fn)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(report).toHaveBeenCalledTimes(1)
    stop()
    stop()
    expect(report).toHaveBeenLastCalledWith(undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('dispose clears every schedule, ignores in-flight results and refuses new schedules', async () => {
    const s = make()
    const fn = vi.fn()
    s.schedule(1, fn)
    let finish: () => void = () => {}
    s.schedule(2, () => new Promise<void>((r) => (finish = r)))
    await vi.advanceTimersByTimeAsync(2_000)
    s.dispose()
    finish()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
    expect(() => s.schedule(1, fn)).toThrow('deactivated')
  })

  it('a disposer called after dispose reports nothing (a failed plugin must not turn active again)', async () => {
    const s = make()
    const stop = s.schedule(1, () => {
      throw new Error('x')
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(report).toHaveBeenCalledTimes(1)
    s.dispose()
    stop()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).not.toHaveBeenCalledWith(undefined)
  })

  it('validates its arguments and clamps the interval', async () => {
    const s = make()
    expect(() => s.schedule('5' as unknown as number, () => {})).toThrow('seconds must be a number')
    expect(() => s.schedule(Number.NaN, () => {})).toThrow('seconds must be a number')
    expect(() => s.schedule(5, 'no' as unknown as () => void)).toThrow('needs a function')
    // Below 1 s runs every second; above a day runs every day (setInterval overflows past 24.8 days).
    const fast = vi.fn()
    s.schedule(0.01, fast)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fast).toHaveBeenCalledTimes(2)
    const slow = vi.fn()
    s.schedule(10 * MAX_SCHEDULE_SECONDS, slow)
    await vi.advanceTimersByTimeAsync(MAX_SCHEDULE_SECONDS * 1000)
    expect(slow).toHaveBeenCalledTimes(1)
  })

  it('through a context: errors reach main as a status event, deactivate clears the schedules', async () => {
    const emitted: [string, unknown][] = []
    const contexts = new HostContexts({ log: () => {}, emit: (e, p) => void emitted.push([e, p]) })
    const ctx = contexts.create(hostSpec({ id: 'a.one', dir: '/d', main: 'm.js' }))
    const fn = vi.fn(() => {
      throw new Error('bad')
    })
    ctx.schedule(1, fn)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(emitted).toEqual([['status', { pluginId: 'a.one', error: 'run failed: bad' }]])
    contexts.dispose('a.one')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(() => ctx.schedule(1, fn)).toThrow('deactivated')
  })
})
