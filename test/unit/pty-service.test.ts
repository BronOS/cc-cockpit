import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLUSH_BYTES,
  FLUSH_MS,
  HIGH_WATER,
  KILL_GRACE_MS,
  LOW_WATER,
  PtyService
} from '../../src/main/pty/pty-service'
import { FakePtyBackend } from '../fakes/fake-pty-backend'

const OPTS = { cwd: '/tmp', env: { A: '1' }, cols: 80, rows: 24 }

let backend: FakePtyBackend
let data: Array<[string, string]>
let exits: Array<[string, number, number | null]>
let svc: PtyService
let sinkThrows: boolean

beforeEach(() => {
  vi.useFakeTimers()
  backend = new FakePtyBackend()
  data = []
  exits = []
  sinkThrows = false
  svc = new PtyService({
    backend,
    sink: {
      data: (id, chunk) => {
        if (sinkThrows) throw new Error('destroyed')
        data.push([id, chunk])
      },
      exit: (id, code, signal) => exits.push([id, code, signal])
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('PtyService spawn', () => {
  it('passes argv and options to the backend untouched', () => {
    svc.spawn('t1', ['claude', '--', '-x'], OPTS)
    expect(backend.last.argv).toEqual(['claude', '--', '-x'])
    expect(backend.last.options).toEqual(OPTS)
    expect(svc.has('t1')).toBe(true)
  })

  it('refuses a duplicate id without spawning again', () => {
    svc.spawn('t1', ['sh'], OPTS)
    expect(() => svc.spawn('t1', ['sh'], OPTS)).toThrow(/already exists/)
    expect(backend.spawned).toHaveLength(1)
  })

  it('does not register the id when the backend fails to start', () => {
    backend.failWith = new Error('ENOENT')
    expect(() => svc.spawn('t1', ['nope'], OPTS)).toThrow('ENOENT')
    expect(svc.has('t1')).toBe(false)
    svc.spawn('t1', ['sh'], OPTS)
    expect(svc.has('t1')).toBe(true)
  })
})

describe('PtyService batching', () => {
  it('coalesces small reads into one message after the flush interval', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.emit('a')
    backend.last.emit('b')
    backend.last.emit('c')
    expect(data).toEqual([])
    vi.advanceTimersByTime(FLUSH_MS - 1)
    expect(data).toEqual([])
    vi.advanceTimersByTime(1)
    expect(data).toEqual([['t1', 'abc']])
  })

  it('does not restart the timer on every read (the first read sets the deadline)', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.emit('a')
    vi.advanceTimersByTime(FLUSH_MS - 2)
    backend.last.emit('b')
    vi.advanceTimersByTime(2)
    expect(data).toEqual([['t1', 'ab']])
  })

  it('flushes immediately once 64 KiB are pending', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.emit('x'.repeat(FLUSH_BYTES - 1))
    expect(data).toEqual([])
    backend.last.emit('y')
    expect(data).toHaveLength(1)
    expect(data[0]?.[1]).toHaveLength(FLUSH_BYTES)
    // The pending timer was cancelled: nothing more arrives later.
    vi.advanceTimersByTime(100)
    expect(data).toHaveLength(1)
  })

  it('batches each PTY separately', () => {
    svc.spawn('t1', ['sh'], OPTS)
    svc.spawn('t2', ['sh'], OPTS)
    backend.spawned[0]?.emit('one')
    backend.spawned[1]?.emit('two')
    vi.advanceTimersByTime(FLUSH_MS)
    expect(data).toEqual([
      ['t1', 'one'],
      ['t2', 'two']
    ])
  })
})

describe('PtyService flow control', () => {
  // Push `total` characters through in 64 KiB flushes.
  function produce(total: number): void {
    for (let sent = 0; sent < total; sent += FLUSH_BYTES) backend.last.emit('z'.repeat(FLUSH_BYTES))
  }

  it('pauses when more than 1 MiB is unacknowledged', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER) // exactly at the limit: not "more than"
    expect(backend.last.paused).toBe(false)
    produce(FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    expect(backend.last.pauseCalls).toBe(1)
  })

  it('resumes on ack once the backlog is back under the low-water mark', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    // A small ack is not enough: resuming now would thrash against a saturated renderer.
    svc.ack('t1', FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    svc.ack('t1', HIGH_WATER + FLUSH_BYTES - FLUSH_BYTES - LOW_WATER)
    expect(backend.last.paused).toBe(false)
    expect(backend.last.resumeCalls).toBe(1)
  })

  it('resetFlow clears the backlog and resumes a paused PTY', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    svc.resetFlow('t1')
    expect(backend.last.paused).toBe(false)
    produce(HIGH_WATER)
    expect(backend.last.paused).toBe(false)
    expect(() => svc.resetFlow('nope')).not.toThrow()
  })

  it('does not pause twice while already paused', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER + FLUSH_BYTES)
    backend.last.emit('q'.repeat(FLUSH_BYTES)) // data already queued in the kernel before pause
    expect(backend.last.pauseCalls).toBe(1)
  })

  it('pauses again after a resume when the backlog grows back', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER + FLUSH_BYTES)
    svc.ack('t1', HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(false)
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    expect(backend.last.pauseCalls).toBe(2)
  })

  it('over-acking cannot make the counter negative', () => {
    svc.spawn('t1', ['sh'], OPTS)
    svc.ack('t1', 10 * HIGH_WATER)
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
  })

  it('ignores acks that are not positive numbers', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER + FLUSH_BYTES)
    svc.ack('t1', -5)
    svc.ack('t1', NaN)
    svc.ack('t1', 0)
    expect(backend.last.paused).toBe(true)
    expect(backend.last.resumeCalls).toBe(0)
  })

  it('ignores an ack for an unknown id', () => {
    expect(() => svc.ack('nope', 100)).not.toThrow()
  })
})

describe('PtyService flow consumer (web access: main acks, design-web.md §5.2)', () => {
  function produce(total: number): void {
    for (let sent = 0; sent < total; sent += FLUSH_BYTES) backend.last.emit('z'.repeat(FLUSH_BYTES))
  }

  it("counts only the consumer's acks: with main consuming, the renderer cannot pause or resume the pty", () => {
    svc.spawn('t1', ['sh'], OPTS)
    expect(svc.flowOf('t1')).toBe('view')
    expect(svc.setFlow('t1', 'main')).toBe(true)
    expect(svc.flowOf('t1')).toBe('main')
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    // The desktop's acks are its own business now.
    svc.ack('t1', HIGH_WATER + FLUSH_BYTES)
    svc.ack('t1', HIGH_WATER + FLUSH_BYTES, 'view')
    expect(backend.last.paused).toBe(true)
    // Neither is a page re-attaching (resetFlow is the renderer's).
    svc.resetFlow('t1')
    expect(backend.last.paused).toBe(true)
    svc.ack('t1', HIGH_WATER + FLUSH_BYTES, 'main')
    expect(backend.last.paused).toBe(false)
  })

  it('a switch starts the count over and resumes a paused pty; the old side is ignored after it', () => {
    svc.spawn('t1', ['sh'], OPTS)
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    // Main takes over: what the renderer never acked will never be acked by main.
    svc.setFlow('t1', 'main')
    expect(backend.last.paused).toBe(false)
    produce(HIGH_WATER)
    expect(backend.last.paused).toBe(false)
    svc.ack('t1', HIGH_WATER, 'view')
    produce(FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    // And back (the mirror stopped): the renderer's acks count again.
    svc.setFlow('t1', 'view')
    expect(backend.last.paused).toBe(false)
    produce(HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
    svc.ack('t1', HIGH_WATER + FLUSH_BYTES)
    expect(backend.last.paused).toBe(false)
    // Same side again: nothing changes, the count is kept.
    produce(HIGH_WATER)
    svc.setFlow('t1', 'view')
    produce(FLUSH_BYTES)
    expect(backend.last.paused).toBe(true)
  })

  it('an unknown or exited pty has no flow', () => {
    expect(svc.setFlow('nope', 'main')).toBe(false)
    expect(svc.flowOf('nope')).toBeUndefined()
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.exit(0)
    expect(svc.setFlow('t1', 'main')).toBe(false)
  })
})

describe('PtyService exit', () => {
  it('flushes pending output first, then reports the exit code', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.emit('bye\n')
    backend.last.exit(3)
    expect(data).toEqual([['t1', 'bye\n']])
    expect(exits).toEqual([['t1', 3, null]])
    expect(svc.has('t1')).toBe(false)
    // The cancelled flush timer must not send anything later.
    vi.advanceTimersByTime(100)
    expect(data).toHaveLength(1)
  })

  it('propagates the terminating signal', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.exit(0, 9)
    expect(exits).toEqual([['t1', 0, 9]])
  })

  it('reports exit code 0 as 0, not as missing', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.exit(0)
    expect(exits).toEqual([['t1', 0, null]])
  })

  it('ignores write, resize, ack and kill after exit', () => {
    svc.spawn('t1', ['sh'], OPTS)
    const pty = backend.last
    pty.exit(1)
    svc.write('t1', 'hello')
    svc.resize('t1', 100, 30)
    svc.ack('t1', 10)
    svc.kill('t1')
    expect(pty.writes).toEqual([])
    expect(pty.resizes).toEqual([])
    expect(pty.killed).toBe(0)
  })

  it('kill forwards an explicit signal (none means the backend default, SIGHUP)', () => {
    svc.spawn('t1', ['sh'], OPTS)
    const pty = backend.last
    svc.kill('t1')
    svc.kill('t1', 'SIGKILL')
    expect(pty.signals).toEqual([undefined, 'SIGKILL'])
  })

  it('terminate sends SIGHUP, then SIGKILL after the grace period if the child is still there', () => {
    svc.spawn('t1', ['trap-hup'], OPTS)
    const stubborn = backend.last
    svc.spawn('t2', ['cat'], OPTS)
    const polite = backend.last
    svc.terminate('t1')
    svc.terminate('t2')
    expect(stubborn.signals).toEqual([undefined])
    polite.exit(0, 1)
    vi.advanceTimersByTime(KILL_GRACE_MS - 1)
    expect(stubborn.signals).toEqual([undefined])
    vi.advanceTimersByTime(1)
    expect(stubborn.signals).toEqual([undefined, 'SIGKILL'])
    expect(polite.signals).toEqual([undefined])
  })

  it('a late terminate timer never hits a new PTY that reused the id (a restarted tab)', () => {
    svc.spawn('t1', ['sh'], OPTS)
    const old = backend.last
    svc.terminate('t1', 100)
    old.exit(0, 1)
    svc.spawn('t1', ['sh'], OPTS)
    const fresh = backend.last
    vi.advanceTimersByTime(100)
    expect(fresh.signals).toEqual([])
    // An unknown id is a no-op.
    svc.terminate('nope')
  })

  it('ignores late output after exit', () => {
    svc.spawn('t1', ['sh'], OPTS)
    const pty = backend.last
    pty.exit(0)
    pty.emit('ghost')
    vi.advanceTimersByTime(100)
    expect(data).toEqual([])
  })

  it('lets the id be reused after exit (restart)', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.exit(0)
    svc.spawn('t1', ['sh'], OPTS)
    expect(backend.spawned).toHaveLength(2)
    // The first PTY's stale callbacks must not touch the new entry.
    backend.spawned[0]?.emit('stale')
    backend.spawned[0]?.exit(9)
    vi.advanceTimersByTime(FLUSH_MS)
    expect(data).toEqual([])
    expect(svc.has('t1')).toBe(true)
    expect(exits).toHaveLength(1)
  })
})

describe('PtyService input and lifecycle', () => {
  it('forwards write, resize and kill to the right PTY', () => {
    svc.spawn('t1', ['sh'], OPTS)
    svc.spawn('t2', ['sh'], OPTS)
    svc.write('t2', 'ls\r')
    svc.resize('t2', 120, 40)
    svc.kill('t2')
    expect(backend.spawned[1]?.writes).toEqual(['ls\r'])
    expect(backend.spawned[1]?.resizes).toEqual([[120, 40]])
    expect(backend.spawned[1]?.killed).toBe(1)
    expect(backend.spawned[0]?.writes).toEqual([])
  })

  it('ignores invalid sizes and rejects them at spawn', () => {
    svc.spawn('t1', ['sh'], OPTS)
    svc.resize('t1', 0.5, 24)
    svc.resize('t1', 70000, 24)
    svc.resize('t1', 80, 0)
    svc.resize('t1', Number.NaN, 24)
    expect(backend.spawned[0]?.resizes).toEqual([])
    expect(() => svc.spawn('t2', ['sh'], { ...OPTS, cols: 0 })).toThrow()
    expect(svc.has('t2')).toBe(false)
  })

  it('removes the entry and reports the exit even when the sink throws on flush', () => {
    svc.spawn('t1', ['sh'], OPTS)
    backend.last.emit('tail')
    sinkThrows = true
    expect(() => backend.last.exit(1)).toThrow()
    expect(svc.has('t1')).toBe(false)
    expect(exits).toHaveLength(1)
  })

  it('ignores operations on an unknown id', () => {
    expect(() => {
      svc.write('x', 'a')
      svc.resize('x', 1, 1)
      svc.kill('x')
    }).not.toThrow()
  })

  it('disposeAll kills every PTY, drops timers and emits nothing', () => {
    svc.spawn('t1', ['sh'], OPTS)
    svc.spawn('t2', ['sh'], OPTS)
    backend.spawned[0]?.emit('pending')
    svc.disposeAll()
    expect(backend.spawned.map((p) => p.killed)).toEqual([1, 1])
    vi.advanceTimersByTime(100)
    expect(data).toEqual([])
    expect(exits).toEqual([])
    expect(svc.has('t1')).toBe(false)
  })

  it('disposeAll SIGKILLs a child that ignores SIGHUP once the grace is over, and only that one', () => {
    svc.spawn('t1', ['sh'], OPTS)
    svc.spawn('t2', ['sh'], OPTS)
    backend.spawned[1]!.ignoresHup = true
    svc.disposeAll(30)
    expect(backend.spawned[0]!.signals).toEqual([undefined])
    expect(backend.spawned[1]!.signals).toEqual([undefined, 'SIGKILL'])
    expect(backend.spawned.map((p) => p.alive())).toEqual([false, false])
    expect(exits).toEqual([])
    expect(svc.has('t2')).toBe(false)
  })

  it("disposeAll escalates a tab already being terminated: the terminate timer cannot run after quit", () => {
    svc.spawn('t1', ['sh'], OPTS)
    const pty = backend.last
    pty.ignoresHup = true
    // The window closed first (quit closes every window), then will-quit disposes.
    svc.terminate('t1')
    svc.disposeAll(30)
    expect(pty.signals).toEqual([undefined, undefined, 'SIGKILL'])
    // The pending terminate timer finds the entry gone and sends nothing more.
    vi.advanceTimersByTime(KILL_GRACE_MS)
    expect(pty.signals).toHaveLength(3)
  })
})
