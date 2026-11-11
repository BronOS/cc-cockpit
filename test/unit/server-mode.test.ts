import { describe, expect, it } from 'vitest'
import {
  armParentWatch,
  chooseStartPath,
  decideServerMode,
  DETECTED_LINE,
  LINUX_ONLY,
  parentMarker,
  serverStart,
  type ServerDecision,
  type ServerStartDeps,
  type SpawnResult
} from '../../src/main/server-mode'

const EXE = '/opt/cc-cockpit/cc-cockpit'
const SWITCHES = ['--server', '--ozone-platform=headless', '--disable-gpu', '--password-store=basic']

function decide(over: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; argv?: string[] } = {}) {
  return decideServerMode({
    platform: over.platform ?? 'linux',
    env: over.env ?? {},
    argv: over.argv ?? [EXE],
    execPath: EXE
  })
}

describe('decideServerMode', () => {
  it('detects a Linux start with neither DISPLAY nor WAYLAND_DISPLAY, and re-executes with the switches', () => {
    expect(decide({ argv: [EXE, '/repo'] })).toEqual({
      server: true,
      detected: true,
      exec: { exe: EXE, args: ['/repo', ...SWITCHES] }
    })
    // An empty value is no display either.
    expect(decide({ env: { DISPLAY: '', WAYLAND_DISPLAY: '' } })).toMatchObject({ server: true, detected: true })
  })

  it('stays desktop with a display: X11, Wayland, and an `ssh -X` session', () => {
    expect(decide({ env: { DISPLAY: ':0' } })).toEqual({ server: false })
    expect(decide({ env: { WAYLAND_DISPLAY: 'wayland-1' } })).toEqual({ server: false })
    // ssh -X forwards X11: DISPLAY is set (localhost:10.0), so the forwarded session gets the desktop.
    expect(decide({ env: { DISPLAY: 'localhost:10.0', SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' } })).toEqual({
      server: false
    })
  })

  it('`--server` forces server mode on a machine with a display, not counted as detected', () => {
    expect(decide({ env: { DISPLAY: ':0' }, argv: [EXE, '--server'] })).toEqual({
      server: true,
      detected: false,
      exec: { exe: EXE, args: SWITCHES }
    })
  })

  it('does not repeat a switch already on argv, and keeps the app path under `electron .`', () => {
    const electron = '/repo/node_modules/electron/dist/electron'
    const d = decideServerMode({ platform: 'linux', env: {}, argv: [electron, '/repo', '--server'], execPath: electron })
    expect(d).toEqual({ server: true, detected: false, exec: { exe: electron, args: ['/repo', ...SWITCHES] } })
  })

  it('always asks for the basic password store (no keyring on a server)', () => {
    const d = decide() as { exec: { args: string[] } }
    expect(d.exec.args).toContain('--password-store=basic')
  })

  it('no re-exec once the headless switch is on argv: the re-executed image, a unit, the e2e harness', () => {
    expect(decide({ argv: [EXE, ...SWITCHES] })).toEqual({ server: true, detected: false })
    expect(decide({ argv: [EXE, '--server', '--ozone-platform=headless', '--server-parent=12'] })).toEqual({
      server: true,
      detected: false
    })
    // Detected and already headless (a unit that passes the switch without `--server`).
    expect(decide({ argv: [EXE, '--ozone-platform=headless'] })).toEqual({ server: true, detected: true })
  })

  it('a desktop with the headless switch alone is not a server', () => {
    expect(decide({ env: { DISPLAY: ':0' }, argv: [EXE, '--ozone-platform=headless'] })).toEqual({ server: false })
  })

  it('executes execPath in an AppImage too, never APPIMAGE (that would nest a second runtime and mount)', () => {
    const d = decide({ env: { APPIMAGE: '/home/me/cc-cockpit.AppImage', APPDIR: '/tmp/.mount_x' } }) as {
      exec: { exe: string }
    }
    expect(d.exec.exe).toBe(EXE)
  })

  it('refuses `--server` off Linux, and detects nothing there', () => {
    expect(decide({ platform: 'darwin', argv: [EXE, '--server'] })).toEqual({ refuse: LINUX_ONLY })
    expect(decide({ platform: 'win32', argv: [EXE, '--server'] })).toEqual({ refuse: LINUX_ONLY })
    // No DISPLAY is normal on macOS and Windows.
    expect(decide({ platform: 'darwin' })).toEqual({ server: false })
    expect(decide({ platform: 'win32' })).toEqual({ server: false })
  })

  it('reads `--server` only after the executable', () => {
    expect(decide({ env: { DISPLAY: ':0' }, argv: ['--server'] })).toEqual({ server: false })
  })
})

describe('chooseStartPath', () => {
  it('execs only when execve exists and the executable passes its check', () => {
    expect(chooseStartPath({ hasExecve: true, executable: true })).toBe('exec')
    expect(chooseStartPath({ hasExecve: false, executable: true })).toBe('watch')
    expect(chooseStartPath({ hasExecve: true, executable: false })).toBe('watch')
    expect(chooseStartPath({ hasExecve: false, executable: false })).toBe('watch')
  })
})

/** Records every effect in order; `exit` and `execve` return, as a fake must. */
function fakes(decision: ServerDecision, over: Partial<ServerStartDeps> = {}) {
  const calls: string[] = []
  const spawned: { exe: string; args: string[] }[] = []
  const execed: { exe: string; argv: string[] }[] = []
  let spawnResult: SpawnResult = { status: 0, signal: null }
  const deps: ServerStartDeps = {
    decision,
    lock: () => {
      calls.push('lock')
      return true
    },
    release: () => calls.push('release'),
    quit: () => calls.push('quit'),
    print: (line) => calls.push(`print ${line}`),
    exit: (code) => calls.push(`exit ${code}`),
    executable: () => true,
    hasExecve: true,
    execve: (exe, argv) => {
      calls.push('execve')
      execed.push({ exe, argv })
    },
    spawnSync: (exe, args) => {
      calls.push('spawnSync')
      spawned.push({ exe, args })
      return spawnResult
    },
    env: { HOME: '/home/me' },
    pid: 4242,
    ...over
  }
  return {
    deps,
    calls,
    spawned,
    execed,
    setSpawn: (r: SpawnResult) => {
      spawnResult = r
    }
  }
}

const detectedExec = decide({ argv: [EXE, '/repo'] })
const flaggedExec = decide({ argv: [EXE, '--server'] })

describe('serverStart', () => {
  it('a refusal prints and exits 1 before the lock is asked for', () => {
    const f = fakes({ refuse: LINUX_ONLY })
    expect(serverStart(f.deps)).toEqual({ run: false })
    expect(f.calls).toEqual([`print ${LINUX_ONLY}`, 'exit 1'])
  })

  it('the desktop is the old single-instance lock: run when held, quit when another instance has it', () => {
    const run = fakes({ server: false })
    expect(serverStart(run.deps)).toEqual({ run: true, server: false })
    expect(run.calls).toEqual(['lock'])
    const lost = fakes({ server: false }, { lock: () => false })
    expect(serverStart(lost.deps)).toEqual({ run: false })
    expect(lost.calls).toEqual(['quit'])
  })

  it('the re-executed image runs as a server under the lock, with nothing re-executed', () => {
    const f = fakes(decide({ argv: [EXE, ...SWITCHES] }))
    expect(serverStart(f.deps)).toEqual({ run: true, server: true })
    expect(f.calls).toEqual(['lock'])
  })

  it('a held lock hands argv over (Electron does it) and exits 0 with nothing started or printed', () => {
    const f = fakes(detectedExec, { lock: () => false })
    expect(serverStart(f.deps)).toEqual({ run: false })
    // process.exit, never app.quit(): with no display a quit fails at platform init with status 1.
    expect(f.calls).toEqual(['exit 0'])
  })

  it('releases the lock, prints the detected line, then execs in place with the switches', () => {
    const f = fakes(detectedExec)
    serverStart(f.deps)
    expect(f.calls).toEqual(['lock', 'release', `print ${DETECTED_LINE}`, 'execve'])
    expect(f.execed).toEqual([{ exe: EXE, argv: [EXE, '/repo', ...SWITCHES] }])
  })

  it('prints nothing with `--server` (the person asked for it)', () => {
    const f = fakes(flaggedExec)
    serverStart(f.deps)
    expect(f.calls).toEqual(['lock', 'release', 'execve'])
  })

  it('takes the watch path when execve is missing, and never calls execve', () => {
    const f = fakes(flaggedExec, { hasExecve: false })
    serverStart(f.deps)
    expect(f.calls).toEqual(['lock', 'release', 'spawnSync', 'exit 0'])
    expect(f.spawned).toEqual([{ exe: EXE, args: [...SWITCHES, '--server-parent=4242'] }])
  })

  it('takes the watch path when the executable fails its check, and never calls execve', () => {
    const f = fakes(detectedExec, { executable: () => false })
    serverStart(f.deps)
    expect(f.calls).toEqual(['lock', 'release', `print ${DETECTED_LINE}`, 'spawnSync', 'exit 0'])
  })

  it("exits with the child's status, 128 + n for a signal", () => {
    const f = fakes(flaggedExec, { hasExecve: false })
    f.setSpawn({ status: 3, signal: null })
    serverStart(f.deps)
    expect(f.calls.at(-1)).toBe('exit 3')
    const s = fakes(flaggedExec, { hasExecve: false })
    s.setSpawn({ status: null, signal: 'SIGTERM' })
    serverStart(s.deps)
    expect(s.calls.at(-1)).toBe('exit 143')
    const k = fakes(flaggedExec, { hasExecve: false })
    k.setSpawn({ status: null, signal: 'SIGKILL' })
    serverStart(k.deps)
    expect(k.calls.at(-1)).toBe('exit 137')
  })

  it('exits 1 with a line when the spawn itself fails', () => {
    const f = fakes(flaggedExec, { executable: () => false })
    f.setSpawn({ status: null, signal: null, error: new Error('spawnSync /x EACCES') })
    serverStart(f.deps)
    expect(f.calls.slice(-2)).toEqual([`print server mode: could not start ${EXE}: spawnSync /x EACCES`, 'exit 1'])
  })
})

describe('parentMarker', () => {
  it('reads the pid on the marker, digits only', () => {
    expect(parentMarker([EXE, '--server', '--server-parent=4242'])).toBe(4242)
    expect(parentMarker([EXE, '--server'])).toBeUndefined()
    expect(parentMarker([EXE, '--server-parent='])).toBeUndefined()
    expect(parentMarker([EXE, '--server-parent=0'])).toBeUndefined()
    expect(parentMarker([EXE, '--server-parent=-1'])).toBeUndefined()
    expect(parentMarker([EXE, '--server-parent= 12'])).toBeUndefined()
    expect(parentMarker([EXE, '--server-parent=1e3'])).toBeUndefined()
  })
})

describe('armParentWatch', () => {
  function watch(argv: string[], ppids: number[]) {
    let tick: (() => void) | undefined
    let stopped = false
    let quits = 0
    let ppid = ppids.shift()!
    const armed = armParentWatch({
      argv,
      ppid: () => ppid,
      every: (fn) => {
        tick = fn
        return { stop: () => (stopped = true) }
      },
      quit: () => quits++
    })
    return {
      armed,
      quits: () => quits,
      stopped: () => stopped,
      hasTimer: () => tick !== undefined,
      next: () => {
        if (ppids.length > 0) ppid = ppids.shift()!
        tick?.()
      }
    }
  }

  it('is never armed without the marker: the re-executed image, a unit, the e2e harness', () => {
    const w = watch([EXE, ...SWITCHES], [1])
    expect(w.armed).toBe(false)
    expect(w.hasTimer()).toBe(false)
    expect(w.quits()).toBe(0)
  })

  it('quits once the parent pid changes (the first process was killed alone), and stops its timer', () => {
    const w = watch([EXE, ...SWITCHES, '--server-parent=4242'], [4242, 4242, 1])
    expect(w.armed).toBe(true)
    w.next()
    expect(w.quits()).toBe(0)
    w.next()
    expect(w.quits()).toBe(1)
    expect(w.stopped()).toBe(true)
  })

  it('quits at once when the parent is already gone at start', () => {
    const w = watch([EXE, ...SWITCHES, '--server-parent=4242'], [1])
    expect(w.armed).toBe(true)
    expect(w.quits()).toBe(1)
    expect(w.hasTimer()).toBe(false)
  })
})
