// The paused-PTY exit drain (exit-drain.ts). The real node-pty wiring cannot load under vitest
// (it is built for the Electron ABI); this pins the timing logic, and pidAlive against a real
// child process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { POLL_MS, exitDrain, pidAlive } from '../../src/main/pty/exit-drain'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('exitDrain', () => {
  it('resumes a paused PTY once its child is gone, and stops polling', () => {
    let alive = true
    const resume = vi.fn()
    const isAlive = vi.fn(() => alive)
    const drain = exitDrain({ alive: isAlive, resume })
    drain.paused()
    vi.advanceTimersByTime(POLL_MS * 3)
    expect(resume).not.toHaveBeenCalled()
    alive = false
    vi.advanceTimersByTime(POLL_MS)
    expect(resume).toHaveBeenCalledTimes(1)
    const polls = isAlive.mock.calls.length
    vi.advanceTimersByTime(POLL_MS * 5)
    expect(isAlive.mock.calls.length).toBe(polls)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('polls only while paused: resume and exit stop it, a second pause adds no second timer', () => {
    const isAlive = vi.fn(() => true)
    const drain = exitDrain({ alive: isAlive, resume: () => {} })
    vi.advanceTimersByTime(POLL_MS * 2)
    expect(isAlive).not.toHaveBeenCalled()
    drain.paused()
    drain.paused()
    vi.advanceTimersByTime(POLL_MS)
    expect(isAlive).toHaveBeenCalledTimes(1)
    drain.resumed()
    vi.advanceTimersByTime(POLL_MS * 2)
    expect(isAlive).toHaveBeenCalledTimes(1)
    drain.paused()
    drain.exited()
    vi.advanceTimersByTime(POLL_MS * 2)
    expect(isAlive).toHaveBeenCalledTimes(1)
  })

  it("polls well inside node-pty's 200 ms socket-destroy timeout", () => {
    expect(POLL_MS).toBeLessThanOrEqual(100)
  })
})

describe('pidAlive', () => {
  it('is true for a running process and false once it is reaped', async () => {
    vi.useRealTimers()
    expect(pidAlive(process.pid)).toBe(true)
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    const pid = child.pid!
    await new Promise((resolve) => child.on('exit', resolve))
    // Node reaps the child before 'exit'; its pid is gone (reuse in this instant is not a concern).
    expect(pidAlive(pid)).toBe(false)
  })
})
