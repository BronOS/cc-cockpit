// main's helper processes (cli checks, login-env shell, git, the diff probe) are tracked so app
// quit can kill them: their own timeouts are timers that die with main. Real children here.
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { ChildRegistry } from '../../src/main/child-registry'

const node = process.execPath
const started: ChildProcess[] = []
afterEach(() => {
  for (const c of started.splice(0)) {
    try {
      c.kill('SIGKILL')
    } catch {
      /* gone */
    }
  }
})

const sleeper = (detached: boolean): ChildProcess => {
  const c = spawn(node, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached })
  started.push(c)
  return c
}

const exited = (c: ChildProcess): Promise<NodeJS.Signals | null> =>
  c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve(c.signalCode)
    : new Promise((resolve) => c.once('exit', (_code, signal) => resolve(signal)))

describe('ChildRegistry', () => {
  it('forgets a child when it exits', async () => {
    const reg = new ChildRegistry()
    const c = reg.track(spawn(node, ['-e', ''], { stdio: 'ignore' }))
    expect(reg.size).toBe(1)
    await exited(c)
    expect(reg.size).toBe(0)
  })

  it('does not keep a child whose spawn failed (no pid)', () => {
    const reg = new ChildRegistry()
    const fake = Object.assign(new EventEmitter(), { pid: undefined, exitCode: null, signalCode: null }) as unknown as ChildProcess
    expect(reg.track(fake)).toBe(fake)
    expect(reg.size).toBe(0)
  })

  it('killAll SIGKILLs every live child, detached (its group) or not, synchronously', async () => {
    const reg = new ChildRegistry()
    const a = reg.track(sleeper(true))
    const b = reg.track(sleeper(false))
    expect(reg.size).toBe(2)
    reg.killAll()
    expect(reg.size).toBe(0)
    expect(await exited(a)).toBe('SIGKILL')
    expect(await exited(b)).toBe('SIGKILL')
  })

  it('a child tracked after killAll (spawned during quit) is killed at once', async () => {
    const reg = new ChildRegistry()
    reg.killAll()
    const c = reg.track(sleeper(true))
    expect(reg.size).toBe(0)
    expect(await exited(c)).toBe('SIGKILL')
  })
})
