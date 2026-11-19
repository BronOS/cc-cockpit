// Keep awake while Claude works (src/main/power/keep-awake.ts) over a real SessionRegistry, and the
// holds it takes (power-holds.ts) over a fake powerSaveBlocker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEEP_AWAKE_OWNER, KEEP_AWAKE_RELEASE_MS, KeepAwake, keepAwakeOf } from '../../src/main/power/keep-awake'
import { PowerHolds } from '../../src/main/power/power-holds'
import { SessionRegistry } from '../../src/main/sessions/session-registry'
import { FakePowerBackend } from '../fakes/fake-power-backend'

describe('KeepAwake', () => {
  let reg: SessionRegistry
  let backend: FakePowerBackend
  let holds: PowerHolds
  let enabled: boolean
  let keep: KeepAwake

  beforeEach(() => {
    vi.useFakeTimers()
    enabled = true
    reg = new SessionRegistry({ projectName: () => 'p', broadcast: () => {}, write: () => {}, log: () => {} })
    backend = new FakePowerBackend()
    holds = new PowerHolds(backend)
    keep = new KeepAwake({ sessions: reg, holds, enabled: () => enabled })
  })

  afterEach(() => {
    keep.dispose()
    reg.dispose()
    vi.useRealTimers()
  })

  const start = (tabId: string, projectId = 'p'): void => reg.tabStarted({ tabId, projectId, kind: 'claude', cwd: '/proj' })
  const work = (tabId: string): void => {
    reg.applyHook(tabId, 'UserPromptSubmit', { prompt: 'go' })
  }
  const stop = (tabId: string): void => {
    reg.applyHook(tabId, 'Stop', {})
  }

  it('holds on the first working tab and releases a while after the last one stops', () => {
    start('c1')
    expect(backend.active.size).toBe(0) // starting is not work
    work('c1')
    expect([...backend.active]).toEqual([1])
    expect(holds.owners()).toEqual([KEEP_AWAKE_OWNER])
    stop('c1')
    // Not yet: a turn's gaps must not churn the blocker.
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS - 1)
    expect(backend.active.size).toBe(1)
    vi.advanceTimersByTime(1)
    expect(backend.active.size).toBe(0)
    expect(backend.calls).toEqual([
      ['start', 1],
      ['stop', 1]
    ])
  })

  it('keeps one blocker for several working tabs, and the same one across a short gap', () => {
    start('c1')
    start('c2')
    work('c1')
    work('c2')
    stop('c1')
    expect(backend.calls).toEqual([['start', 1]])
    stop('c2')
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS / 2)
    work('c1') // the next turn starts within the delay: the hold carries on, no stop and start
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS * 2)
    expect(backend.calls).toEqual([['start', 1]])
    expect(keep.held()).toBe(true)
  })

  it('does not push the release out on changes that are not work', () => {
    start('c1')
    work('c1')
    stop('c1')
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS - 10)
    reg.projectChanged('p') // an unchanged-entry change (a colour), as the registry sends them
    start('c2') // a new tab starting is not work either
    vi.advanceTimersByTime(10)
    expect(backend.active.size).toBe(0)
  })

  it('counts a working tab of another window', () => {
    start('a1', 'project-a')
    start('b1', 'project-b')
    work('b1')
    expect(keep.held()).toBe(true)
    stop('b1')
    work('a1')
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS * 2)
    expect(backend.calls).toEqual([['start', 1]])
  })

  it('does not count a tab waiting on a permission prompt', () => {
    start('c1')
    work('c1')
    reg.applyHook('c1', 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })
    expect(reg.get('c1')?.status).toBe('needs-permission')
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS)
    expect(backend.active.size).toBe(0)
  })

  it('releases when the last working tab closes or exits', () => {
    start('c1')
    start('c2')
    work('c1')
    work('c2')
    reg.tabClosed('c1')
    reg.tabExited('c2', 1)
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS)
    expect(backend.active.size).toBe(0)
  })

  it('setting off releases at once; on with a tab working holds at once', () => {
    start('c1')
    work('c1')
    enabled = false
    keep.settingChanged()
    expect(backend.active.size).toBe(0)
    // While off, work starts nothing.
    stop('c1')
    work('c1')
    expect(backend.active.size).toBe(0)
    enabled = true
    keep.settingChanged()
    expect([...backend.active]).toEqual([2])
  })

  it('holds at once when made with a tab already working, and dispose releases', () => {
    keep.dispose()
    start('c1')
    work('c1')
    keep = new KeepAwake({ sessions: reg, holds, enabled: () => enabled })
    expect(keep.held()).toBe(true)
    keep.dispose()
    expect(backend.active.size).toBe(0)
    // Disposed: no more holds from later work.
    stop('c1')
    work('c1')
    expect(backend.active.size).toBe(0)
  })

  it('never releases another owner\'s hold (server mode\'s whole-run blocker)', () => {
    const server = holds.hold('server-mode')
    start('c1')
    work('c1')
    expect(holds.owners().sort()).toEqual([KEEP_AWAKE_OWNER, 'server-mode'].sort())
    stop('c1')
    vi.advanceTimersByTime(KEEP_AWAKE_RELEASE_MS)
    expect([...backend.active]).toEqual([1])
    expect(holds.owners()).toEqual(['server-mode'])
    enabled = false
    keep.settingChanged()
    keep.dispose()
    expect([...backend.active]).toEqual([1])
    server.release()
    expect(backend.active.size).toBe(0)
  })
})

describe('PowerHolds', () => {
  it('gives each hold its own blocker, and a release is idempotent', () => {
    const backend = new FakePowerBackend()
    const holds = new PowerHolds(backend)
    const a = holds.hold('a')
    const b = holds.hold('b')
    a.release()
    a.release()
    expect(backend.calls).toEqual([
      ['start', 1],
      ['start', 2],
      ['stop', 1]
    ])
    expect([...backend.active]).toEqual([2])
    expect(holds.owners()).toEqual(['b'])
    b.release()
    expect(backend.active.size).toBe(0)
  })

  it('a backend that throws gives a hold that does nothing, logged', () => {
    const logs: string[] = []
    const holds = new PowerHolds(
      {
        start: () => {
          throw new Error('no power service')
        },
        stop: () => {
          throw new Error('never reached')
        }
      },
      (line) => logs.push(line)
    )
    const h = holds.hold('a')
    h.release()
    expect(logs).toEqual(['keep awake: could not start the power save blocker for a: no power service'])
    expect(holds.owners()).toEqual([])
  })
})

describe('keepAwakeOf', () => {
  it('is on unless stored as false', () => {
    expect(keepAwakeOf(undefined)).toBe(true)
    expect(keepAwakeOf(true)).toBe(true)
    expect(keepAwakeOf('no')).toBe(true)
    expect(keepAwakeOf(0)).toBe(true)
    expect(keepAwakeOf(false)).toBe(false)
  })
})
