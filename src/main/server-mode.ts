// Server mode's start (design-web.md §9.1): whether this run is a server (no display, or `--server`),
// and how a run that needs Chromium's headless platform gets it. Pure functions plus one wired
// function that takes every effect as an argument, so unit tests run each branch in plain Node.
// index.ts calls `serverStart` at its top, before `ready` and in place of the bare single-instance
// lock; nothing else reads argv or the environment for server mode: later modules get `server`.
//
// Why a re-exec at all: the Ozone switch must be on argv. `app.commandLine.appendSwitch` from main is
// too late and `ELECTRON_OZONE_PLATFORM_HINT=headless` is not read (spike). `app.relaunch` puts fd 1
// and 2 on /dev/null and detaches, so a manual run would daemonize silently; an async `spawn` cannot
// forward signals, because this process leaves its top-level script, fails at platform init and exits
// 1 within 3 s. So the image is replaced in place with `process.execve`: one process, the same pid and
// stdio, its exit status its own, and a systemd `Type=simple` unit's main pid is the app.

import { constants } from 'node:os'

/** Forces server mode on a machine that has a display (`ssh -X` sets `DISPLAY`). Not `--headless`: Chromium reads that one. */
export const SERVER_FLAG = '--server'
/** The switch that tells a run already has the headless platform: the re-executed image, a unit or the e2e harness. */
export const OZONE_HEADLESS = '--ozone-platform=headless'
/**
 * What the re-exec appends. `--disable-gpu` only spares the GPU process failing EGL twice before
 * Chromium's software fallback; `--password-store=basic` is §9.5's (no keyring on a server), and
 * `choosePasswordStore` leaves an explicit store alone.
 */
export const SERVER_SWITCHES: readonly string[] = [SERVER_FLAG, OZONE_HEADLESS, '--disable-gpu', '--password-store=basic']
/** The fallback's marker: the pid of the first process, which the second one watches (`armParentWatch`). */
export const PARENT_MARKER = '--server-parent='

export const LINUX_ONLY = 'server mode runs on Linux only'
export const DETECTED_LINE = 'no display: starting cc-cockpit in server mode, web access on; stop with Ctrl-C'

export interface ServerInput {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  argv: readonly string[]
  execPath: string
}

export interface ServerExec {
  exe: string
  /** Everything after the executable: argv[0] of the new image is `exe` itself. */
  args: string[]
}

export type ServerDecision =
  | { server: false }
  | { server: true; detected: boolean; exec?: ServerExec }
  | { refuse: string }

/**
 * Server mode with `--server`, or on Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY` (an empty
 * value counts as unset: Electron cannot open an empty display either). Off Linux `--server` refuses
 * and nothing is detected: macOS would need another mechanism and has no spike (§9.1).
 *
 * `exe` is `execPath` in an AppImage too (`APPIMAGE` set): under `execve` the image's mount lives on
 * with the pid, and executing `APPIMAGE` again would nest a second runtime and mount.
 */
export function decideServerMode(input: ServerInput): ServerDecision {
  const flag = input.argv.slice(1).includes(SERVER_FLAG)
  if (input.platform !== 'linux') return flag ? { refuse: LINUX_ONLY } : { server: false }
  const noDisplay = !input.env.DISPLAY && !input.env.WAYLAND_DISPLAY
  if (!flag && !noDisplay) return { server: false }
  const detected = !flag
  if (input.argv.slice(1).includes(OZONE_HEADLESS)) return { server: true, detected }
  const rest = input.argv.slice(1)
  // A switch already on argv is not repeated (`--server` given by the person).
  const args = [...rest, ...SERVER_SWITCHES.filter((s) => !rest.includes(s))]
  return { server: true, detected, exec: { exe: input.execPath, args } }
}

/**
 * How to start the headless image. A failed `process.execve` does not throw in Electron 45.1.0: it
 * prints a line and aborts (SIGABRT, core dumped), so the fallback is chosen here, before the call,
 * and never by catching. `execve` missing or an `exe` that is not executable: the `spawnSync` child.
 */
export function chooseStartPath(checks: { hasExecve: boolean; executable: boolean }): 'exec' | 'watch' {
  return checks.hasExecve && checks.executable ? 'exec' : 'watch'
}

export interface SpawnResult {
  status: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

export interface ServerStartDeps {
  decision: ServerDecision
  /** `app.requestSingleInstanceLock(launch)`: false hands argv to the holder (Electron does it). */
  lock: () => boolean
  release: () => void
  /** The desktop loser's way out, as before server mode: `app.quit()`. */
  quit: () => void
  print: (line: string) => void
  /** `process.exit`. Typed as returning so a fake can record; callers return right after. */
  exit: (code: number) => void
  /** `accessSync(exe, X_OK)` as a boolean. */
  executable: (exe: string) => boolean
  /** `typeof process.execve === 'function'`, and false under `CC_COCKPIT_NO_EXECVE=1` in a test run. */
  hasExecve: boolean
  execve: (exe: string, argv: string[], env: Record<string, string | undefined>) => void
  spawnSync: (exe: string, args: string[]) => SpawnResult
  env: Record<string, string | undefined>
  pid: number
}

/** What index.ts does next: run the app (this process holds the lock), or nothing (it exits or quits). */
export type ServerStart = { run: true; server: boolean } | { run: false }

/**
 * The top of index.ts. A refusal prints and exits 1 before the lock is asked for. Without a re-exec
 * (desktop, or the headless switch already on argv) it is the old single-instance lock. With one:
 *
 * 1. the lock: held elsewhere, argv went to the holder as any second launch and this process exits 0
 *    with nothing re-executed. `process.exit`, not `app.quit()`: with no display a quit returns to
 *    Electron, which fails at platform init and exits 1;
 * 2. the start path is picked while the lock is still held, then the lock is released for the new
 *    image to take again (a launch that takes it in the gap becomes the primary, and the new image
 *    hands its argv over as a second launch);
 * 3. the detected line, only when detected (not with `--server`);
 * 4. `execve`, which never returns; or the watch path: a `spawnSync` child with the marker, this
 *    process exiting with the child's status (128 + n for a signal, 1 with a line when the spawn
 *    itself fails, which a non-executable `exe` does without aborting).
 */
export function serverStart(deps: ServerStartDeps): ServerStart {
  const { decision } = deps
  if ('refuse' in decision) {
    deps.print(decision.refuse)
    deps.exit(1)
    return { run: false }
  }
  const exec = decision.server ? decision.exec : undefined
  if (!exec) {
    if (!deps.lock()) {
      deps.quit()
      return { run: false }
    }
    return { run: true, server: decision.server }
  }
  if (!deps.lock()) {
    deps.exit(0)
    return { run: false }
  }
  const path = chooseStartPath({ hasExecve: deps.hasExecve, executable: deps.executable(exec.exe) })
  deps.release()
  if (decision.server && decision.detected) deps.print(DETECTED_LINE)
  if (path === 'exec') {
    deps.execve(exec.exe, [exec.exe, ...exec.args], deps.env)
    // Not reached: execve replaces the image or aborts. A fake that returns lands here.
    return { run: false }
  }
  const result = deps.spawnSync(exec.exe, [...exec.args, `${PARENT_MARKER}${deps.pid}`])
  if (result.error) {
    deps.print(`server mode: could not start ${exec.exe}: ${result.error.message}`)
    deps.exit(1)
  } else if (result.signal) {
    deps.exit(128 + (constants.signals[result.signal] ?? 0))
  } else {
    deps.exit(result.status ?? 1)
  }
  return { run: false }
}

/** The pid on `--server-parent=<pid>`, or undefined when the marker is absent or malformed. */
export function parentMarker(argv: readonly string[]): number | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(PARENT_MARKER)) continue
    const text = arg.slice(PARENT_MARKER.length)
    const pid = Number(text)
    // Digits only: `Number('')` is 0 and `Number(' 1')` is 1.
    if (text.length > 0 && [...text].every((c) => c >= '0' && c <= '9') && pid > 0) return pid
  }
  return undefined
}

export const PARENT_WATCH_MS = 1000

export interface ParentWatchDeps {
  argv: readonly string[]
  ppid: () => number
  every: (fn: () => void, ms: number) => { stop: () => void }
  /** Quit as SIGTERM does. */
  quit: () => void
}

/**
 * The fallback's second process: when the first one is gone (SIGTERM sent to it alone kills it and
 * leaves this one reparented), quit too. Armed only by the marker, so a direct start with the switches
 * (the re-executed image, a unit, the e2e harness) never watches. A marker that already differs at
 * start quits at once. Returns whether it armed.
 */
export function armParentWatch(deps: ParentWatchDeps): boolean {
  const parent = parentMarker(deps.argv)
  if (parent === undefined) return false
  if (deps.ppid() !== parent) {
    deps.quit()
    return true
  }
  const timer = deps.every(() => {
    if (deps.ppid() === parent) return
    timer.stop()
    deps.quit()
  }, PARENT_WATCH_MS)
  return true
}
