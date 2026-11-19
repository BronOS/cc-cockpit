// Keep awake on Linux through logind (design.md §3 "Keep awake"): the only file that spawns
// `systemd-inhibit` (no-direct-systemd-inhibit.test.ts). Plain TypeScript over an injected spawner, so
// vitest runs it; PowerHolds (power-holds.ts) owns the holds, this is one more backend behind it.
//
// Why: Electron's `powerSaveBlocker` on Linux only asks `org.gnome.SessionManager` or
// `org.freedesktop.PowerManagement` on the session bus and sends nothing when neither is there, which is
// the case on Hyprland (Omarchy) and on a headless server with no session bus at all; it never asks
// logind (measured on the owner's machines, 2026-11-19: the hold was taken and released, the OS saw
// nothing). logind is on the system bus, so a server with no session bus gets it too.
//
// Decisions:
//  - One `systemd-inhibit ... cat` per hold, never one shared process and a count: each hold owns its
//    process, so releasing one hold can only end its own lock (keep-awake and any other owner never
//    release each other's), the same rule as one Electron blocker per hold.
//  - `cat` with stdin a pipe from main: `cat` exits on EOF, so when main dies in any way (crash,
//    SIGKILL) the pipe closes, `cat` exits, `systemd-inhibit` exits and the lock goes with it. A release
//    ends the pipe; the process group is SIGKILLed if it has not exited within INHIBIT_KILL_MS, and at
//    quit at once (dispose). Spawned `detached` so there is a group to kill (`systemd-inhibit` and its
//    `cat`). Argv only, no shell: the reason is one argv element.
//  - `--mode=block`, never `block-weak`: logind ignores a weak lock for a request from the lock's own
//    user (logind-inhibit.c, `manager_is_inhibited`), and the idle suspend on a desktop such as Hyprland
//    is the person's own `systemctl suspend` (hypridle), so a weak lock would block nothing. A `block`
//    lock refuses that request outright, so a Sleep the person picks from a menu is refused too while
//    Claude works (the lid still sleeps the computer: logind's LidSwitchIgnoreInhibited defaults to yes).
//  - A failure (spawn error, polkit refusal, an exit before the release) is logged once per run, never
//    thrown into main and never respawned: the hold still counts in PowerHolds and the next hold tries
//    once more (one spawn per hold, so no loop). polkit refuses a process outside any login session
//    (`su` or `runuser` from ssh, a system service) by default; a desktop session or a user unit is allowed.
//  - `--what=sleep` only: the display may sleep (Electron's `prevent-app-suspension` is the same), and
//    idle (the screen lock) is the person's business.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { killChild } from '../kill-child'
import { KEEP_AWAKE_OWNER } from './keep-awake'
import type { PowerSaveBackend } from './power-holds'

/** The program's name, looked up on PATH at start (findSystemdInhibit). */
export const SYSTEMD_INHIBIT = 'systemd-inhibit'

/** How long a released inhibitor may take to exit before its process group is SIGKILLed. */
export const INHIBIT_KILL_MS = 1000

/** The stderr kept for the failure log line (a polkit refusal is one line). */
const STDERR_CAP = 2048

/** The short reason logind shows (`systemd-inhibit --list`, a desktop's "why not sleeping"). */
export function inhibitWhy(owner: string): string {
  if (owner === KEEP_AWAKE_OWNER) return 'Claude is working'
  return owner
}

/** The argv after the program: a sleep block lock held while `cat` runs. */
export function inhibitArgs(owner: string): string[] {
  return ['--what=sleep', '--who=cc-cockpit', `--why=${inhibitWhy(owner)}`, '--mode=block', 'cat']
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The absolute path of `systemd-inhibit` on `pathEnv`, or undefined. Only absolute PATH entries count
 * (a relative one would resolve against main's working directory); an executable check, no shell.
 */
export function findSystemdInhibit(
  pathEnv: string | undefined,
  isExecutable: (path: string) => boolean = isExecutableFile
): string | undefined {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue
    const candidate = join(dir, SYSTEMD_INHIBIT)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** The part of `child_process.spawn` this needs (tests inject a fake). */
export type InhibitSpawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess

export interface LogindInhibitOptions {
  /** The absolute path findSystemdInhibit gave. */
  path: string
  log: (line: string) => void
  spawn?: InhibitSpawn
  /** SIGKILL the child's process group (tests record it instead). */
  killGroup?: (child: ChildProcess) => void
  killAfterMs?: number
}

interface Inhibitor {
  child: ChildProcess | undefined
  /** stop() was called: an exit from now on is the release, not a failure. */
  released: boolean
  killTimer: ReturnType<typeof setTimeout> | undefined
}

/** One logind sleep inhibitor process per start (see the header). */
export class LogindInhibitBackend implements PowerSaveBackend {
  private readonly live = new Map<number, Inhibitor>()
  /** Every child not yet exited, released or not (dispose kills them all). */
  private readonly running = new Set<ChildProcess>()
  private next = 1
  private failed = false
  private disposed = false
  private readonly spawn: InhibitSpawn
  private readonly killGroup: (child: ChildProcess) => void

  constructor(private readonly options: LogindInhibitOptions) {
    this.spawn = options.spawn ?? nodeSpawn
    this.killGroup = options.killGroup ?? killChild
  }

  /** Never throws: a failure is logged and the id still stands for a hold that does nothing. */
  start(owner: string): number {
    const id = this.next++
    const inhibitor: Inhibitor = { child: undefined, released: false, killTimer: undefined }
    this.live.set(id, inhibitor)
    if (this.disposed) return id
    let child: ChildProcess
    try {
      child = this.spawn(this.options.path, inhibitArgs(owner), {
        stdio: ['pipe', 'ignore', 'pipe'],
        detached: true,
        shell: false
      })
    } catch (err) {
      this.fail(`could not start ${SYSTEMD_INHIBIT}: ${err instanceof Error ? err.message : String(err)}`)
      return id
    }
    inhibitor.child = child
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < STDERR_CAP) stderr += String(chunk).slice(0, STDERR_CAP - stderr.length)
    })
    child.stderr?.on('error', () => {})
    // EPIPE when the child died before the release ended the pipe: the exit below reports it.
    child.stdin?.on('error', () => {})
    child.on('error', (err) => {
      this.running.delete(child)
      if (!inhibitor.released) this.fail(`could not start ${SYSTEMD_INHIBIT}: ${err.message}`)
    })
    if (child.pid !== undefined) this.running.add(child)
    child.once('exit', () => {
      this.running.delete(child)
      if (inhibitor.killTimer !== undefined) clearTimeout(inhibitor.killTimer)
      inhibitor.killTimer = undefined
    })
    // 'close', not 'exit', for the log: by then stderr (a polkit refusal) has been read.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (inhibitor.released) return
      const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`
      const said = stderr.trim().split('\n').at(-1) ?? ''
      this.fail(`${SYSTEMD_INHIBIT} exited before the release (${how})${said === '' ? '' : `: ${said}`}`)
    })
    return id
  }

  /** End the lock: close the pipe (`cat` exits), SIGKILL the group if it is still there a second later. */
  stop(id: number): void {
    const inhibitor = this.live.get(id)
    if (inhibitor === undefined) return
    this.live.delete(id)
    inhibitor.released = true
    const child = inhibitor.child
    if (child === undefined || !this.running.has(child)) return
    child.stdin?.end()
    const timer = setTimeout(() => {
      inhibitor.killTimer = undefined
      if (this.running.has(child)) this.killGroup(child)
    }, this.options.killAfterMs ?? INHIBIT_KILL_MS)
    timer.unref?.()
    inhibitor.killTimer = timer
  }

  /** App quit: SIGKILL every inhibitor still running, at once (no timer fires after this). */
  dispose(): void {
    this.disposed = true
    for (const inhibitor of this.live.values()) inhibitor.released = true
    this.live.clear()
    for (const child of this.running) {
      try {
        child.stdin?.end()
      } catch {
        /* already closed */
      }
      this.killGroup(child)
    }
    this.running.clear()
  }

  /** Live inhibitor processes (tests). */
  get size(): number {
    return this.running.size
  }

  private fail(message: string): void {
    if (this.failed) return
    this.failed = true
    this.options.log(`keep awake: ${message}; the computer may idle-sleep while Claude works (logged once)`)
  }
}

/**
 * The backend for this run, chosen once at start: on Linux with `systemd-inhibit` on PATH, Electron's
 * blocker and a logind inhibitor per hold (Electron's still helps GNOME, whose own idle timer asks the
 * session manager; it costs nothing where nobody answers); everywhere else Electron's alone. `logind` is
 * returned so quit can dispose it.
 */
export function selectPowerBackend(options: {
  platform: NodeJS.Platform
  pathEnv: string | undefined
  electron: PowerSaveBackend
  log: (line: string) => void
  isExecutable?: (path: string) => boolean
  spawn?: InhibitSpawn
}): { backend: PowerSaveBackend; logind: LogindInhibitBackend | undefined } {
  if (options.platform !== 'linux') return { backend: options.electron, logind: undefined }
  const path = findSystemdInhibit(options.pathEnv, options.isExecutable)
  if (path === undefined) return { backend: options.electron, logind: undefined }
  const logind = new LogindInhibitBackend({ path, log: options.log, ...(options.spawn ? { spawn: options.spawn } : {}) })
  return { backend: combineBackends(options.electron, logind, options.log), logind }
}

/**
 * Two backends as one: each start starts both, each stop stops both. One that throws is logged and the
 * other still holds; only both throwing throws (PowerHolds logs that).
 */
export function combineBackends(first: PowerSaveBackend, second: PowerSaveBackend, log: (line: string) => void): PowerSaveBackend {
  const pairs = new Map<number, [number | undefined, number | undefined]>()
  let next = 1
  const attempt = (backend: PowerSaveBackend, owner: string): { id?: number; err?: unknown } => {
    try {
      return { id: backend.start(owner) }
    } catch (err) {
      return { err }
    }
  }
  return {
    start(owner) {
      const a = attempt(first, owner)
      const b = attempt(second, owner)
      if (a.id === undefined && b.id === undefined) throw a.err
      for (const r of [a, b]) {
        if (r.err !== undefined) log(`keep awake: one power backend could not start for ${owner}: ${r.err instanceof Error ? r.err.message : String(r.err)}`)
      }
      const id = next++
      pairs.set(id, [a.id, b.id])
      return id
    },
    stop(id) {
      const pair = pairs.get(id)
      if (pair === undefined) return
      pairs.delete(id)
      let error: unknown
      if (pair[0] !== undefined) {
        try {
          first.stop(pair[0])
        } catch (err) {
          error = err
        }
      }
      if (pair[1] !== undefined) {
        try {
          second.stop(pair[1])
        } catch (err) {
          error ??= err
        }
      }
      if (error !== undefined) throw error
    }
  }
}
