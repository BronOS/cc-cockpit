// The machine poller (main/remote/machine-status.ts, design-remote-desktop.md §4.1, plan
// 20261112-machine-chips Task 2): a server is asked its session counts only while it has a remote
// window open, at once and every POLL_MS after each answer; a 404 is an older server (reachable, no
// counts), any other failure is unreachable; listeners hear only a change. Fake timers and a fake
// fetch: nothing here opens a window or a socket.
import { describe, expect, it } from 'vitest'
import { countsOf, MachineStatus, MAX_MACHINE_COUNT, NO_KEY_RETRY_MS, POLL_MS, type MachineInfo } from '../../src/main/remote/machine-status'
import { RemoteHttpError, RemoteNoKeyError } from '../../src/main/remote/remote-windows'
import { SESSIONS_PATH } from '../../src/shared/web-protocol'

class FakeTimers {
  private next = 1
  readonly pending = new Map<number, { fn: () => void; ms: number }>()
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++
    this.pending.set(id, { fn, ms })
    return id
  }
  clearTimeout = (handle: unknown): void => {
    this.pending.delete(handle as number)
  }
  /** Fire every pending timer once (the next poll round). */
  fire(): void {
    const due = [...this.pending]
    this.pending.clear()
    for (const [, t] of due) t.fn()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

function setup() {
  const timers = new FakeTimers()
  let servers: string[] = []
  const names = new Map<string, string | null>([
    ['s1', 'devbox'],
    ['s2', 'build']
  ])
  const asked: Array<[string, string]> = []
  /** What each server answers; a function so a test can change it between polls. */
  const answers = new Map<string, () => Promise<unknown>>()
  const heard: MachineInfo[][] = []
  const logs: string[] = []
  let ids = 0
  const status = new MachineStatus({
    servers: () => servers,
    name: (id) => names.get(id),
    fetch: (serverId, path) => {
      asked.push([serverId, path])
      return (answers.get(serverId) ?? (async () => ({ waiting: 0, working: 0, idle: 0 })))()
    },
    mintId: () => `m${++ids}`,
    timers,
    log: (m) => void logs.push(m)
  })
  status.onChange((m) => void heard.push(m))
  return {
    status,
    timers,
    asked,
    answers,
    heard,
    logs,
    names,
    open: (...ids: string[]) => {
      servers = ids
      status.sync()
    }
  }
}

describe('MachineStatus', () => {
  it('asks nothing while no remote window is open', async () => {
    const t = setup()
    t.status.sync()
    await flush()
    expect(t.asked).toEqual([])
    expect(t.status.machines()).toEqual([])
    expect(t.heard).toEqual([])
    expect(t.timers.pending.size).toBe(0)
  })

  it('asks at once when a server\'s window opens, then every POLL_MS after each answer, through SESSIONS_PATH', async () => {
    const t = setup()
    t.answers.set('s1', async () => ({ waiting: 2, working: 1, idle: 0 }))
    t.open('s1')
    // At once, and listed at once with the name only (reachable, no counts yet).
    expect(t.asked).toEqual([['s1', SESSIONS_PATH]])
    expect(t.heard).toEqual([[{ id: 'm1', name: 'devbox', reachable: true }]])
    // Not scheduled before the answer: never two asks at once.
    expect(t.timers.pending.size).toBe(0)
    await flush()
    expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: true, waiting: 2, working: 1, idle: 0 }])
    expect([...t.timers.pending.values()].map((p) => p.ms)).toEqual([POLL_MS])
    t.timers.fire()
    expect(t.asked).toHaveLength(2)
  })

  it('stops when the server\'s last window closes, and drops an answer that arrives after', async () => {
    const t = setup()
    let resolve: (v: unknown) => void = () => undefined
    t.answers.set('s1', () => new Promise((r) => (resolve = r)))
    t.open('s1')
    t.open()
    expect(t.heard.at(-1)).toEqual([])
    resolve({ waiting: 5, working: 0, idle: 0 })
    await flush()
    expect(t.status.machines()).toEqual([])
    expect(t.timers.pending.size).toBe(0)
    expect(t.asked).toHaveLength(1)
    // A scheduled poll is cancelled too.
    t.answers.set('s1', async () => ({ waiting: 0, working: 0, idle: 0 }))
    t.open('s1')
    await flush()
    expect(t.timers.pending.size).toBe(1)
    t.open()
    expect(t.timers.pending.size).toBe(0)
  })

  it('reads a 404 as an older server: reachable, no counts', async () => {
    const t = setup()
    t.answers.set('s1', async () => Promise.reject(new RemoteHttpError(404)))
    t.open('s1')
    await flush()
    expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: true }])
  })

  it('reads any other failure as unreachable and drops the counts; back when it answers again', async () => {
    const t = setup()
    t.answers.set('s1', async () => ({ waiting: 1, working: 1, idle: 1 }))
    t.open('s1')
    await flush()
    for (const err of [new RemoteHttpError(401), new RemoteHttpError(502), new Error('net::ERR_CONNECTION_REFUSED')]) {
      t.answers.set('s1', async () => Promise.reject(err))
      t.timers.fire()
      await flush()
      expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: false }])
    }
    // Logged once when it went away, not at every poll.
    expect(t.logs.filter((l) => l.includes('did not answer'))).toHaveLength(1)
    t.answers.set('s1', async () => ({ waiting: 0, working: 3, idle: 0 }))
    t.timers.fire()
    await flush()
    expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: true, waiting: 0, working: 3, idle: 0 }])
  })

  it('an ask that could not go for want of an origin key keeps the reading, logs nothing and asks again soon', async () => {
    const t = setup()
    t.answers.set('s1', async () => Promise.reject(new RemoteNoKeyError()))
    t.open('s1')
    await flush()
    // Not answered yet: reachable with the name only, as before the first answer; no "did not answer".
    expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: true }])
    expect(t.heard).toHaveLength(1)
    expect(t.logs).toEqual([])
    expect([...t.timers.pending.values()].map((p) => p.ms)).toEqual([NO_KEY_RETRY_MS])
    t.answers.set('s1', async () => ({ waiting: 1, working: 0, idle: 0 }))
    t.timers.fire()
    await flush()
    expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: true, waiting: 1, working: 0, idle: 0 }])
    expect([...t.timers.pending.values()].map((p) => p.ms)).toEqual([POLL_MS])
    // Counts known, then a sign-in replaced the key: they stay until the next answer.
    t.answers.set('s1', async () => Promise.reject(new RemoteNoKeyError()))
    t.timers.fire()
    await flush()
    expect(t.status.machines()).toEqual([{ id: 'm1', name: 'devbox', reachable: true, waiting: 1, working: 0, idle: 0 }])
  })

  it('takes only three whole counts from the server; anything else is reachable with none', () => {
    expect(countsOf({ waiting: 1, working: 2, idle: 3, title: 'x' })).toEqual({ waiting: 1, working: 2, idle: 3 })
    for (const body of [null, [], 'x', {}, { waiting: 1, working: 2 }, { waiting: -1, working: 0, idle: 0 }, { waiting: 1.5, working: 0, idle: 0 }, { waiting: '1', working: 0, idle: 0 }, { waiting: MAX_MACHINE_COUNT + 1, working: 0, idle: 0 }]) {
      expect(countsOf(body), JSON.stringify(body)).toBeUndefined()
    }
  })

  it('announces only a change', async () => {
    const t = setup()
    t.answers.set('s1', async () => ({ waiting: 1, working: 0, idle: 0 }))
    t.open('s1')
    await flush()
    expect(t.heard).toHaveLength(2)
    t.timers.fire()
    await flush()
    t.timers.fire()
    await flush()
    // The same counts twice: nothing new heard.
    expect(t.heard).toHaveLength(2)
    t.answers.set('s1', async () => ({ waiting: 0, working: 1, idle: 0 }))
    t.timers.fire()
    await flush()
    expect(t.heard).toHaveLength(3)
    // A rename is announced once refresh is called (the picker's edit).
    t.names.set('s1', 'devbox 2')
    t.status.refresh()
    expect(t.heard.at(-1)?.[0]?.name).toBe('devbox 2')
    t.status.refresh()
    expect(t.heard).toHaveLength(4)
  })

  it('mints one opaque id per server for the run; serverOf resolves it only while the server is listed', async () => {
    const t = setup()
    t.open('s1', 's2')
    await flush()
    expect(t.status.machines().map((m) => [m.id, m.name])).toEqual([
      ['m1', 'devbox'],
      ['m2', 'build']
    ])
    expect(t.status.serverOf('m2')).toBe('s2')
    expect(t.status.serverOf('s2')).toBeUndefined()
    expect(t.status.serverOf('nope')).toBeUndefined()
    t.open('s1')
    expect(t.status.serverOf('m2')).toBeUndefined()
    // Reopened: the same id as before.
    t.open('s1', 's2')
    expect(t.status.machines().map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(t.status.serverOf('m2')).toBe('s2')
  })

  it("a server the person did not name is `Server <n>`, numbered by first listing and kept for the run; never its address", async () => {
    const t = setup()
    t.names.set('s1', null)
    t.names.set('s3', null)
    t.open('s3', 's2', 's1')
    await flush()
    expect(t.status.machines().map((m) => m.name)).toEqual(['Server 1', 'build', 'Server 2'])
    // Closed and reopened in another order: the same labels.
    t.open('s1')
    t.open('s1', 's3')
    expect(t.status.machines().map((m) => m.name)).toEqual(['Server 2', 'Server 1'])
    // Named since (the picker's rename): the chosen name.
    t.names.set('s1', 'Work')
    t.status.refresh()
    expect(t.status.machines().map((m) => m.name)).toEqual(['Work', 'Server 1'])
  })

  it('leaves out a server with no record (forgotten) and hears nothing after dispose', async () => {
    const t = setup()
    t.open('s1', 's2')
    await flush()
    t.names.delete('s2')
    expect(t.status.machines().map((m) => m.name)).toEqual(['devbox'])
    const before = t.heard.length
    t.status.dispose()
    expect(t.timers.pending.size).toBe(0)
    t.open('s1')
    await flush()
    expect(t.heard).toHaveLength(before)
  })

  it('a random default id carries nothing of the server', () => {
    const status = new MachineStatus({ servers: () => ['s1'], name: () => 'devbox', fetch: () => new Promise(() => undefined), timers: new FakeTimers() })
    status.sync()
    const [m] = status.machines()
    expect(m?.id).toMatch(/^m-[A-Za-z0-9_-]{12}$/)
    expect(m?.id).not.toContain('s1')
    status.dispose()
  })
})
