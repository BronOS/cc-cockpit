// A desktop launch meets a server (design-web.md §9.1). Both sides of a second launch while another
// process holds the single-instance lock:
//
//  - the primary (`second-instance`): a server ignores the argv of a launch that has a display (a
//    person typing `cc-cockpit` on their own desktop while a server run holds the data dir must not
//    get a project opened on a page nobody sees), and opens the path of one that has none
//    (`cc-cockpit <path>` from a server shell), as any second launch does; the window manager shows
//    and focuses nothing in server mode. A desktop primary is unchanged.
//  - the losing launch, when it has a display: it asks the socket for `web.status` (2 s, no token)
//    and, when the answer says server mode, shows a native box (it has a screen) offering Stop
//    (`web.stop`) or Cancel, then exits. Without it, that launch would seem to do nothing. Any other
//    answer, or none, exits as before. Only on Linux: server mode runs nowhere else, so a desktop
//    launch elsewhere never waits on the socket.
//
// The losing launch is an Electron process speaking the CLI protocol, and main may not import the
// CLI (shared/manifest.ts): this file uses shared/protocol.ts's request and reply types and
// paths.ts's `socketPath()`, never src/cli/client.ts. Pure Node (no Electron value import): the box
// and the exit are passed in, so unit tests load this file in plain Node.
import type { MessageBoxOptions } from 'electron'
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { encodeRequest, LineFramer, parseReply, PROTOCOL_VERSION, type Reply } from '../shared/protocol'
import { isPlainObject } from '../shared/guards'
import { fallbackSocketDir, socketPath } from './paths'
import type { ServerDecision } from './server-mode'

/** The losing launch's deadline for each socket ask (`web.status`, then `web.stop`). */
export const SECOND_LAUNCH_ASK_MS = 2000

/**
 * The box's answer in a test run (`stop` or `cancel`), read only when `isTestRun`: a queue filled
 * through a test hook cannot reach a process that shows its box right after start and then exits.
 */
export const SECOND_LAUNCH_ANSWER_ENV = 'CC_COCKPIT_TEST_SERVER_BOX'

/** What the primary logs when a server ignores a launch from a screen. */
export const IGNORED_LINE = 'server mode: a launch from a desktop asked to open something; ignored (open projects from a browser)'

export type BoxAnswer = 'stop' | 'cancel'

/**
 * Whether this launch has a display, as `SecondInstanceData.display` carries it: it would run as a
 * desktop. A launch that would itself be a server (no display, or `--server` from an `ssh -X` shell)
 * counts as none, so a server primary opens its path: `cc-cockpit --server <path>` typed on the
 * server is a request from the server's own shell. A refused decision never reaches the lock.
 */
export function launchHasDisplay(decision: ServerDecision): boolean {
  return !('refuse' in decision) && !decision.server
}

/**
 * The primary's choice for a second launch. `display` undefined is data from another build holding
 * the same lock (or none at all): it reads as before server mode, so the path is opened.
 */
export function secondInstanceAction(input: { server: boolean; display: boolean | undefined }): 'open' | 'ignore' {
  return input.server && input.display === true ? 'ignore' : 'open'
}

export interface SecondInstanceDeps {
  /** Opens the folder argv names; false when it names none. */
  open: (argv: readonly string[], cwd: string) => boolean
  /** Surfaces a window (a bare relaunch); a no-op in server mode (window-manager.ts). */
  focusAny: () => void
  log: (line: string) => void
}

/** `second-instance` in the primary: ignore (a server, a launch with a display), else open as always. */
export function handleSecondInstance(
  input: { server: boolean; display: boolean | undefined; argv: readonly string[]; cwd: string },
  deps: SecondInstanceDeps
): void {
  if (secondInstanceAction(input) === 'ignore') {
    deps.log(IGNORED_LINE)
    return
  }
  // A bare re-launch (no folder) must still surface the app rather than do nothing (the desktop).
  if (!deps.open(input.argv, input.cwd)) deps.focusAny()
}

/** Whether a losing launch asks the socket at all: one with a display, on Linux only. */
export function losingLaunchAsks(input: { platform: string; display: boolean }): boolean {
  return input.display && input.platform === 'linux'
}

/** The losing launch's private profile dir name, before mkdtemp's suffix: `<prefix><pid>-`. */
export const LAUNCH_PROFILE_PREFIX = 'cc-cockpit-launch-'

export interface LaunchProfileDeps {
  /** Creates the private dir (mkdtemp, 0700) and returns its path; may throw. */
  makeDir: () => string
  setPath: (name: 'userData' | 'sessionData', path: string) => void
  /** Runs `fn` when the process exits (after `app.quit()`). */
  onExit: (fn: () => void) => void
  /** Removes the dir and everything in it; may throw. */
  remove: (dir: string) => void
}

/**
 * Moves a losing launch off the holder's profile before it awaits anything (so still before `ready`):
 * `userData` and `sessionData` go to a private temp dir, removed again at exit. Until the lock was
 * lost the loser quit at once and never started Chromium on the holder's dir; now it waits on the
 * socket ask, and against a server it reaches `ready` and keeps its box open. Chromium's disk caches,
 * `Local State` and the network state files are not made for two processes, and a loser's shutdown
 * would write its stale copy over the holder's. The socket path is computed from the data dir main
 * resolved at start (`launchSocketPath`), never from `userData`, so the ask still reaches the holder.
 * Returns the dir, or undefined when it could not be made: the caller then quits at once, as before.
 * Chromium makes `userData` again (empty) while it shuts down, after Node's `exit`: the removal there
 * takes every profile file, and the next losing launch sweeps the empty dir (`sweepLaunchProfiles`).
 */
export function privateLaunchProfile(deps: LaunchProfileDeps): string | undefined {
  let dir: string
  try {
    dir = deps.makeDir()
  } catch {
    return undefined
  }
  deps.onExit(() => {
    try {
      deps.remove(dir)
    } catch {
      // A temp dir left behind is harmless; an exit handler must not throw.
    }
  })
  deps.setPath('userData', dir)
  deps.setPath('sessionData', dir)
  return dir
}

/** Whether a pid names a live process (EPERM: alive, someone else's). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes the private profile dirs (`privateLaunchProfile`) earlier losing launches left in `dir`: only
 * ours (a real directory, our uid) and only when the pid in the name is gone, so a launch still
 * showing its box keeps its profile. What is left is mostly the empty dir Chromium makes again after
 * the exit removal. Never throws: a sweep that fails costs a dir in the temp dir, nothing more.
 */
export function sweepLaunchProfiles(input: { dir: string; uid: number | undefined; alive: (pid: number) => boolean }): void {
  let names: string[]
  try {
    names = readdirSync(input.dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(LAUNCH_PROFILE_PREFIX)) continue
    const rest = name.slice(LAUNCH_PROFILE_PREFIX.length)
    const dash = rest.indexOf('-')
    const pidText = dash > 0 ? rest.slice(0, dash) : ''
    const pid = Number(pidText)
    if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== pidText || input.alive(pid)) continue
    const path = join(input.dir, name)
    try {
      const st = lstatSync(path)
      if (!st.isDirectory() || (input.uid !== undefined && st.uid !== input.uid)) continue
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** The test run's box answer from the env; anything outside a test run, or any other value, is ignored. */
export function testBoxAnswer(env: Record<string, string | undefined>, testRun: boolean): BoxAnswer | undefined {
  if (!testRun) return undefined
  const value = env[SECOND_LAUNCH_ANSWER_ENV]
  return value === 'stop' || value === 'cancel' ? value : undefined
}

/** Longest address text shown in the box: the answer comes from another process. */
const MAX_ADDRESS = 200

/** Printable text only, capped (a status answer is another process's data, shown as plain text). */
function plain(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0
      return code > 0x1f && (code < 0x7f || code > 0x9f)
    })
    .join('')
    .slice(0, MAX_ADDRESS)
}

/**
 * The address of a `web.status` result that says server mode, or undefined for any other answer
 * (a desktop run, an older build, garbage). Listening: the origin links point at, what a browser
 * opens; otherwise the configured bind and port, an IPv6 address bracketed.
 */
export function serverAddress(result: unknown): string | undefined {
  if (!isPlainObject(result) || result.server !== true) return undefined
  const gateway = result.gateway
  if (isPlainObject(gateway) && gateway.state === 'listening' && typeof gateway.origin === 'string' && gateway.origin !== '') {
    return plain(gateway.origin)
  }
  const { bind, port } = result
  if (typeof bind === 'string' && bind !== '' && Number.isInteger(port)) {
    return plain(bind.includes(':') ? `[${bind}]:${String(port)}` : `${bind}:${String(port)}`)
  }
  return 'an unknown address'
}

/** The box's text. */
export function serverBoxMessage(address: string): string {
  return `cc-cockpit runs in server mode on this machine (web access at ${address})`
}

/** The box's buttons, in order: Stop is 0. */
export const SERVER_BOX_BUTTONS = ['Stop', 'Cancel'] as const

/** The native box: Cancel is the default and what Esc or closing it answers; Stop ends a running server. */
export function serverBoxOptions(message: string): MessageBoxOptions {
  return {
    type: 'info',
    title: 'cc-cockpit',
    message,
    detail: 'Stop ends it; the browsers that have it open come back after its next start.',
    buttons: [...SERVER_BOX_BUTTONS],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
}

/** The box's response index as an answer: only Stop's index stops. */
export function boxAnswerOf(response: number): BoxAnswer {
  return response === 0 ? 'stop' : 'cancel'
}

/**
 * The socket a losing launch asks, computed as main computes its own (`socketPath`), or undefined
 * when it lies in the shared fallback dir and that dir is not ours alone (a real directory, our uid,
 * no group or other access): on a shared /tmp another user could listen there and answer "server",
 * and Stop would then go to them. The same check the CLI and the socket server make.
 */
export function launchSocketPath(input: {
  dataDir: string
  env: Record<string, string | undefined>
  uid: number | undefined
  tmpdir: string
}): string | undefined {
  const uid = input.uid ?? 'nouid'
  const path = socketPath(input.dataDir, input.env, uid, input.tmpdir)
  const fallback = fallbackSocketDir(input.tmpdir, uid)
  if (dirname(path) !== fallback) return path
  try {
    const st = lstatSync(fallback)
    if (!st.isDirectory()) return undefined
    if (input.uid !== undefined && st.uid !== input.uid) return undefined
    return (st.mode & 0o077) === 0 ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * One tokenless, projectless request on the CLI socket; the reply, or undefined when there is none
 * within `timeoutMs` (no socket, nothing listening, a hung or garbled peer). Never rejects.
 */
export function socketAsk(
  path: string,
  cmd: string,
  timeoutMs: number,
  connect: (path: string) => Socket = (p) => createConnection(p)
): Promise<Reply | undefined> {
  return new Promise((resolve) => {
    let done = false
    let socket: Socket | undefined
    const finish = (reply?: Reply): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket?.destroy()
      resolve(reply)
    }
    const timer = setTimeout(() => finish(), timeoutMs)
    try {
      socket = connect(path)
    } catch {
      finish()
      return
    }
    const framer = new LineFramer()
    // No token, no project: `web.*` is served only to such a caller (protocol.ts HOST_ONLY_COMMANDS).
    socket.on('connect', () => socket?.end(encodeRequest({ v: PROTOCOL_VERSION, id: 1, cmd, args: {} })))
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const line of framer.push(chunk)) {
          const reply = parseReply(line)
          if (reply.id === 1) finish(reply)
        }
      } catch {
        finish()
      }
    })
    socket.on('error', () => finish())
    socket.on('close', () => finish())
  })
}

export interface SecondLaunchDeps {
  /** One socket request with the deadline (`socketAsk`); undefined: no answer. */
  ask: (cmd: 'web.status' | 'web.stop') => Promise<Reply | undefined>
  /** The answer a test run set (`testBoxAnswer`); when set, no box is shown. */
  testAnswer: BoxAnswer | undefined
  /** The native box through the dialog adapter; a failing box counts as Cancel. */
  box: (message: string) => Promise<BoxAnswer>
  log: (line: string) => void
}

/**
 * The losing launch with a display: what it did. `none` when the holder is not a server (or did not
 * answer): the launch exits as before. Otherwise the box's answer, with Stop sent as `web.stop`.
 */
export async function runSecondLaunch(deps: SecondLaunchDeps): Promise<'none' | BoxAnswer> {
  const status = await deps.ask('web.status')
  const address = status?.ok === true ? serverAddress(status.result) : undefined
  if (address === undefined) return 'none'
  const answer = deps.testAnswer ?? (await deps.box(serverBoxMessage(address)).catch(() => 'cancel' as const))
  if (answer === 'stop') {
    const reply = await deps.ask('web.stop')
    if (reply?.ok !== true) deps.log(`cc-cockpit: could not stop the server: ${reply?.ok === false ? reply.error : 'no answer'}`)
  }
  return answer
}
