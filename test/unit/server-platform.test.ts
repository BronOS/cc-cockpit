// server-platform.ts (docs/plans/20261119-server-mode-mac.md decisions 1, 4, 5): the table by platform
// and mode, the before-`ready` effects it applies, and the run's power hold through a real PowerHolds
// (the server's one hold, taken once and never released while the run serves).
import { describe, expect, it } from 'vitest'
import { PowerHolds, type PowerSaveBackend } from '../../src/main/power/power-holds'
import {
  applyBeforeReady,
  holdForRun,
  MOCK_KEYCHAIN_SWITCH,
  SERVER_HOLD_OWNER,
  serverPlatform,
  type BeforeReadyEffects
} from '../../src/main/server-platform'

function recorder(): { calls: string[]; effects: BeforeReadyEffects } {
  const calls: string[] = []
  return {
    calls,
    effects: {
      setActivationPolicy: (policy) => calls.push(`policy:${policy}`),
      disableHardwareAcceleration: () => calls.push('gpu-off'),
      appendSwitch: (name) => calls.push(`switch:${name}`)
    }
  }
}

function fakeBackend(): PowerSaveBackend & { started: number; stopped: number[] } {
  let next = 1
  const backend = {
    started: 0,
    stopped: [] as number[],
    start: () => {
      backend.started++
      return next++
    },
    stop: (id: number) => void backend.stopped.push(id)
  }
  return backend
}

describe('serverPlatform: the table', () => {
  it('darwin server: accessory, GPU off, mock keychain, a whole-run hold', () => {
    expect(serverPlatform('darwin', true)).toEqual({ accessory: true, gpuOff: true, mockKeychain: true, holdAwake: true })
  })

  it('darwin desktop: nothing (a mock keychain would break its safeStorage secrets)', () => {
    expect(serverPlatform('darwin', false)).toEqual({ accessory: false, gpuOff: false, mockKeychain: false, holdAwake: false })
  })

  it('Linux server: nothing (the re-exec puts its switches on argv; no hold is planned)', () => {
    expect(serverPlatform('linux', true)).toEqual({ accessory: false, gpuOff: false, mockKeychain: false, holdAwake: false })
  })

  it('Linux desktop: nothing', () => {
    expect(serverPlatform('linux', false)).toEqual({ accessory: false, gpuOff: false, mockKeychain: false, holdAwake: false })
  })
})

describe('applyBeforeReady', () => {
  it('darwin server: the accessory policy, GPU off and use-mock-keychain', () => {
    const { calls, effects } = recorder()
    applyBeforeReady(serverPlatform('darwin', true), effects)
    expect(calls).toEqual(['policy:accessory', 'gpu-off', `switch:${MOCK_KEYCHAIN_SWITCH}`])
    expect(MOCK_KEYCHAIN_SWITCH).toBe('use-mock-keychain')
  })

  it.each([
    ['darwin', false],
    ['linux', true],
    ['linux', false]
  ] as const)('%s server=%s: calls nothing', (platform, server) => {
    const { calls, effects } = recorder()
    applyBeforeReady(serverPlatform(platform, server), effects)
    expect(calls).toEqual([])
  })
})

describe('holdForRun', () => {
  it('darwin server: one server-mode hold, started once, never stopped', () => {
    const backend = fakeBackend()
    const holds = new PowerHolds(backend)
    const hold = holdForRun(serverPlatform('darwin', true), holds)
    expect(hold?.owner).toBe(SERVER_HOLD_OWNER)
    expect(SERVER_HOLD_OWNER).toBe('server-mode')
    expect(backend.started).toBe(1)
    expect(backend.stopped).toEqual([])
    expect(holds.owners()).toEqual(['server-mode'])
  })

  it('the run hold stays through another owner coming and going (keep-awake)', () => {
    const backend = fakeBackend()
    const holds = new PowerHolds(backend)
    holdForRun(serverPlatform('darwin', true), holds)
    const session = holds.hold('keep-awake')
    session.release()
    session.release()
    expect(holds.owners()).toEqual(['server-mode'])
    expect(backend.stopped).toEqual([2])
  })

  it.each([
    ['darwin', false],
    ['linux', true],
    ['linux', false]
  ] as const)('%s server=%s: no hold', (platform, server) => {
    const backend = fakeBackend()
    const holds = new PowerHolds(backend)
    expect(holdForRun(serverPlatform(platform, server), holds)).toBeUndefined()
    expect(backend.started).toBe(0)
    expect(holds.owners()).toEqual([])
  })
})
