// Keep awake on Linux (src/main/power/logind-inhibit.ts): one `systemd-inhibit ... cat` per hold over an
// injected spawner, its release, a failure logged once, quit, and the start-time choice of backend.
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_AWAKE_OWNER } from '../../src/main/power/keep-awake'
import {
  combineBackends,
  findSystemdInhibit,
  INHIBIT_KILL_MS,
  LogindInhibitBackend,
  selectPowerBackend
} from '../../src/main/power/logind-inhibit'
import { PowerHolds } from '../../src/main/power/power-holds'
import { FakePowerBackend } from '../fakes/fake-power-backend'

const PATH = '/usr/bin/systemd-inhibit'

/** A child as the backend sees it: stdin's end and the group kill recorded, exit driven by the test. */
class FakeChild extends EventEmitter {
  pid: number | undefined
  ended = false
  killed = false
  readonly stdin = Object.assign(new EventEmitter(), { end: () => { this.ended = true } })
  readonly stderr = new EventEmitter()
  constructor(pid: number | undefined) {
    super()
    this.pid = pid
  }
  /** The process went away (cat saw EOF, a polkit refusal, a SIGKILL). */
  exit(code: number | null, signal: NodeJS.Signals | null = null, stderr = ''): void {
    if (stderr !== '') this.stderr.emit('data', Buffer.from(stderr))
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
}

interface Spawned {
  command: string
  args: string[]
  options: SpawnOptions
  child: FakeChild
}

describe('LogindInhibitBackend', () => {
  let spawned: Spawned[]
  let logs: string[]
  let backend: LogindInhibitBackend
  let pid: number

  beforeEach(() => {
    vi.useFakeTimers()
    spawned = []
    logs = []
    pid = 100
    backend = new LogindInhibitBackend({
      path: PATH,
      log: (line) => logs.push(line),
      spawn: (command, args, options) => {
        const child = new FakeChild(pid++)
        spawned.push({ command, args, options, child })
        return child as unknown as ChildProcess
      },
      killGroup: (child) => {
        ;(child as unknown as FakeChild).killed = true
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns systemd-inhibit argv-only, a sleep block lock held by cat on a pipe from main', () => {
    const holds = new PowerHolds(backend)
    holds.hold(KEEP_AWAKE_OWNER)
    expect(spawned).toHaveLength(1)
    const [s] = spawned
    expect(s!.command).toBe(PATH)
    expect(s!.args).toEqual(['--what=sleep', '--who=cc-cockpit', '--why=Claude is working', '--mode=block', 'cat'])
    expect(s!.options).toEqual({ stdio: ['pipe', 'ignore', 'pipe'], detached: true, shell: false })
  })

  it('one process per hold: overlapping holds never end each other\'s lock', () => {
    const holds = new PowerHolds(backend)
    const a = holds.hold(KEEP_AWAKE_OWNER)
    const b = holds.hold('server-mode')
    expect(spawned.map((s) => s.args[2])).toEqual(['--why=Claude is working', '--why=server-mode'])
    expect(backend.size).toBe(2)
    a.release()
    a.release()
    expect(spawned[0]!.child.ended).toBe(true)
    expect(spawned[1]!.child.ended).toBe(false)
    spawned[0]!.child.exit(0)
    expect(backend.size).toBe(1)
    b.release()
    expect(spawned[1]!.child.ended).toBe(true)
    expect(logs).toEqual([])
  })

  it('a release ends the pipe, and kills the group only when the child is still there a second later', () => {
    const holds = new PowerHolds(backend)
    const quick = holds.hold(KEEP_AWAKE_OWNER)
    quick.release()
    expect(spawned[0]!.child.ended).toBe(true)
    spawned[0]!.child.exit(0)
    vi.advanceTimersByTime(INHIBIT_KILL_MS)
    expect(spawned[0]!.child.killed).toBe(false)

    const stuck = holds.hold(KEEP_AWAKE_OWNER)
    stuck.release()
    vi.advanceTimersByTime(INHIBIT_KILL_MS - 1)
    expect(spawned[1]!.child.killed).toBe(false)
    vi.advanceTimersByTime(1)
    expect(spawned[1]!.child.killed).toBe(true)
    spawned[1]!.child.exit(null, 'SIGKILL')
    expect(backend.size).toBe(0)
    // The release's own exit is no failure.
    expect(logs).toEqual([])
  })

  it('a child that dies while held is logged once, never respawned; the hold still counts', () => {
    const holds = new PowerHolds(backend)
    const a = holds.hold(KEEP_AWAKE_OWNER)
    spawned[0]!.child.exit(1, null, 'Failed to inhibit: Access denied as the requested operation requires interactive authentication.\n')
    vi.advanceTimersByTime(60_000)
    expect(spawned).toHaveLength(1)
    expect(holds.owners()).toEqual([KEEP_AWAKE_OWNER])
    expect(logs).toEqual([
      'keep awake: systemd-inhibit exited before the release (code 1): Failed to inhibit: Access denied as the requested operation requires interactive authentication.; the computer may idle-sleep while Claude works (logged once)'
    ])
    a.release()
    // The next hold tries once more (one spawn per hold, no loop) and a second failure is not logged again.
    const b = holds.hold(KEEP_AWAKE_OWNER)
    expect(spawned).toHaveLength(2)
    spawned[1]!.child.exit(1, null, 'Failed to inhibit: Access denied')
    b.release()
    expect(spawned).toHaveLength(2)
    expect(logs).toHaveLength(1)
  })

  it('a spawn that throws or errors never throws into main, logged once', () => {
    const throwing = new LogindInhibitBackend({
      path: PATH,
      log: (line) => logs.push(line),
      spawn: () => {
        throw new Error('EACCES')
      }
    })
    const holds = new PowerHolds(throwing)
    const h = holds.hold(KEEP_AWAKE_OWNER)
    expect(holds.owners()).toEqual([KEEP_AWAKE_OWNER])
    h.release()
    holds.hold(KEEP_AWAKE_OWNER).release()
    expect(logs).toEqual(['keep awake: could not start systemd-inhibit: EACCES; the computer may idle-sleep while Claude works (logged once)'])

    // An 'error' event (ENOENT after the PATH check, the file removed since) is the same.
    logs.length = 0
    pid = 0
    const erroring = new LogindInhibitBackend({
      path: PATH,
      log: (line) => logs.push(line),
      spawn: () => {
        const child = new FakeChild(undefined)
        queueMicrotask(() => {
          child.emit('error', new Error('spawn /usr/bin/systemd-inhibit ENOENT'))
          child.emit('close', -2, null)
        })
        return child as unknown as ChildProcess
      }
    })
    erroring.start(KEEP_AWAKE_OWNER)
    return Promise.resolve().then(() => {
      expect(logs).toEqual([
        'keep awake: could not start systemd-inhibit: spawn /usr/bin/systemd-inhibit ENOENT; the computer may idle-sleep while Claude works (logged once)'
      ])
      expect(erroring.size).toBe(0)
    })
  })

  it('quit kills every inhibitor still running at once, released or not, and starts no more', () => {
    const holds = new PowerHolds(backend)
    holds.hold(KEEP_AWAKE_OWNER)
    const b = holds.hold('server-mode')
    b.release()
    backend.dispose()
    expect(spawned.map((s) => [s.child.ended, s.child.killed])).toEqual([
      [true, true],
      [true, true]
    ])
    expect(backend.size).toBe(0)
    backend.start(KEEP_AWAKE_OWNER)
    expect(spawned).toHaveLength(2)
  })
})

describe('choosing the backend at start', () => {
  const electron = (): FakePowerBackend => new FakePowerBackend()

  it('finds systemd-inhibit on PATH by an executable check, absolute entries only', () => {
    const seen: string[] = []
    const exec = (p: string): boolean => {
      seen.push(p)
      return p === '/usr/bin/systemd-inhibit'
    }
    expect(findSystemdInhibit('relative/bin:/usr/local/bin::/usr/bin:/bin', exec)).toBe('/usr/bin/systemd-inhibit')
    expect(seen).toEqual(['/usr/local/bin/systemd-inhibit', '/usr/bin/systemd-inhibit'])
    expect(findSystemdInhibit('/bin', exec)).toBeUndefined()
    expect(findSystemdInhibit(undefined, exec)).toBeUndefined()
  })

  it('Linux with systemd-inhibit: Electron\'s blocker and a logind lock per hold', () => {
    const e = electron()
    const spawned: string[][] = []
    const chosen = selectPowerBackend({
      platform: 'linux',
      pathEnv: '/usr/bin',
      electron: e,
      log: () => {},
      isExecutable: () => true,
      spawn: (_command, args) => {
        spawned.push(args)
        return new FakeChild(7) as unknown as ChildProcess
      }
    })
    expect(chosen.logind).toBeInstanceOf(LogindInhibitBackend)
    const holds = new PowerHolds(chosen.backend)
    const h = holds.hold(KEEP_AWAKE_OWNER)
    expect([...e.active]).toEqual([1])
    expect(spawned).toHaveLength(1)
    h.release()
    expect(e.active.size).toBe(0)
  })

  it('Linux without systemd-inhibit, macOS and Windows: Electron\'s blocker alone, no PATH lookup off Linux', () => {
    const exec = vi.fn(() => true)
    for (const platform of ['darwin', 'win32'] as const) {
      const e = electron()
      const chosen = selectPowerBackend({ platform, pathEnv: '/usr/bin', electron: e, log: () => {}, isExecutable: exec })
      expect(chosen.backend).toBe(e)
      expect(chosen.logind).toBeUndefined()
    }
    expect(exec).not.toHaveBeenCalled()
    const e = electron()
    const none = selectPowerBackend({ platform: 'linux', pathEnv: '/usr/bin', electron: e, log: () => {}, isExecutable: () => false })
    expect(none.backend).toBe(e)
    expect(none.logind).toBeUndefined()
  })

  it('combined: one side that throws is logged and the other holds; both throwing throws', () => {
    const logs: string[] = []
    const broken = {
      start: (): number => {
        throw new Error('no session bus')
      },
      stop: (): void => {}
    }
    const good = electron()
    const both = combineBackends(broken, good, (l) => logs.push(l))
    const id = both.start('a')
    expect([...good.active]).toEqual([1])
    expect(logs).toEqual(['keep awake: one power backend could not start for a: no session bus'])
    both.stop(id)
    both.stop(id)
    expect(good.calls).toEqual([
      ['start', 1],
      ['stop', 1]
    ])
    expect(() => combineBackends(broken, broken, () => {}).start('a')).toThrow('no session bus')
  })
})
