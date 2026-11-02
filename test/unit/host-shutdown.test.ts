// The plugin host's exit and signal handlers (src/host/shutdown.ts), against a fake process.
import { describe, expect, it, vi } from 'vitest'
import { installShutdownHandlers, type ShutdownProcess } from '../../src/host/shutdown'

function fakeProcess() {
  const listeners = new Map<string, () => void>()
  const exit = vi.fn<(code: number) => void>()
  const proc: ShutdownProcess = {
    on: (event: string, listener: () => void) => void listeners.set(event, listener),
    exit
  }
  const fire = (event: string): void => {
    const l = listeners.get(event)
    if (!l) throw new Error(`no ${event} listener`)
    l()
  }
  return { proc, exit, fire }
}

describe('installShutdownHandlers', () => {
  it('cleans up on exit (crash, process.exit), once per exit', () => {
    const { proc, fire } = fakeProcess()
    const cleanup = vi.fn()
    installShutdownHandlers(proc, cleanup)
    expect(cleanup).not.toHaveBeenCalled()
    fire('exit')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('a signal still ends the process (a handler replaces the default terminate), cleanup left to exit', () => {
    const { proc, exit, fire } = fakeProcess()
    const cleanup = vi.fn()
    installShutdownHandlers(proc, cleanup)
    fire('SIGTERM')
    expect(exit).toHaveBeenCalledWith(143)
    fire('SIGINT')
    expect(exit).toHaveBeenLastCalledWith(130)
    fire('SIGHUP')
    expect(exit).toHaveBeenLastCalledWith(129)
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('a cleanup that throws is logged, not rethrown from the exit handler', () => {
    const { proc, fire } = fakeProcess()
    const log = vi.fn()
    installShutdownHandlers(
      proc,
      () => {
        throw new Error('boom')
      },
      log
    )
    expect(() => fire('exit')).not.toThrow()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
