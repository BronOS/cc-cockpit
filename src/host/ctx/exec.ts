// `ctx.exec(argv, { stdin, cwd, timeoutMs })` (design §5): run a program, never through a shell.
//
// Decisions (plan Task 26):
//  - argv only: `spawn(argv[0], argv.slice(1), { shell: false })`. Untrusted text is one argv
//    element or goes on stdin; a `;`, `$(...)` or quote in an argument is just a character.
//  - argv[0] is looked up on PATH of the env the child gets. That env is the host's own (the
//    allow-listed login-shell env main gave it, src/main/plugins/host-manager.ts hostEnv), and
//    Node searches the PATH of `options.env` when one is given, so `git`, `jira`, `gh` resolve as
//    they do in a terminal. A name with a slash is used as is.
//  - stdin is written, then closed (a program that reads until EOF must not hang). A child that
//    exits without reading it gets EPIPE; that is ignored (its exit code tells the story).
//  - Output is capped at 10 MiB for stdout and stderr TOGETHER (one counter, the smaller memory
//    bound). Going over kills the child and REJECTS: a silently truncated JSON document would be
//    worse than an error. Output is decoded once at the end, so a multi-byte character split
//    across two chunks stays whole.
//  - Timeout (default 60 s, at most 10 min): the child is killed with SIGKILL and the call resolves
//    with whatever was read and `code: null` (the SDK's documented "killed" result), ALWAYS: also
//    when the child itself already exited and a grandchild held the pipes open. Its real exit code
//    there (often 0) next to cut-off output would hide that the call timed out. On POSIX the
//    child leads its own process group (`detached`), and the whole group is killed, so a shell
//    script's grandchildren do not outlive the call. Unlike a plain child, a detached one is not
//    ended with its parent, so the host kills every running child on deactivate.
//  - cwd defaults to the project folder. It may be any existing directory, not only inside the
//    project: the plugin is trusted code that can run any program with any argument anyway, so a
//    cwd restriction would be theatre. (This is NOT the rule for sessions.open, Task 27, where
//    main itself opens the tab.) A relative cwd is relative to the project folder.
//  - The child never gets `DBUS_SESSION_BUS_ADDRESS=disabled:`. Chromium sets that in its own
//    utility processes at run time (so it is not in /proc/<pid>/environ), and the plugin host is
//    one: every child inherited it, so on Linux `gh auth token` could not reach gnome-keyring and
//    answered "no oauth token found" while `gh` worked in a terminal (the GitHub plugin, 2026-11-08).
//    hostEnv never passes a bus address; without one a tool uses its default, `$XDG_RUNTIME_DIR/bus`.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { resolve } from 'node:path'
import type { ExecOptions, ExecResult } from '../../sdk/types'
import { killChild } from '../../main/kill-child'
import { errorText } from '../../shared/error-text'

// Re-exported: the host kills a plugin's running children with it on deactivate (ctx/index.ts).
export { killChild }

export const MAX_EXEC_OUTPUT_BYTES = 10 * 1024 * 1024
export const DEFAULT_EXEC_TIMEOUT_MS = 60_000
export const MAX_EXEC_TIMEOUT_MS = 10 * 60_000
const MAX_ARGV_ITEMS = 1000
const MAX_STDIN_LENGTH = 10 * 1024 * 1024

/** The env a child gets: `env` without Chromium's `disabled:` bus address (see the header). */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.DBUS_SESSION_BUS_ADDRESS !== 'disabled:') return env
  const rest = { ...env }
  delete rest.DBUS_SESSION_BUS_ADDRESS
  return rest
}

export interface ExecContext {
  /** Default cwd (absolute, from main). */
  projectDir: string
  /** The child's environment, PATH included. */
  env: NodeJS.ProcessEnv
  /** Running children, so the host can kill them on deactivate. */
  children?: Set<ChildProcess>
  /**
   * Throws once the plugin's ctx is disposed. Checked again after every await before the spawn:
   * dispose kills the children in `children`, so one spawned after it (the cwd stat was pending
   * when the plugin was deactivated) would be detached, untracked and outlive the host.
   */
  alive?: () => void
  maxOutputBytes?: number
  /** Tests inject a fake; default node:child_process.spawn. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

function checkArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new TypeError('exec: argv must be a non-empty array')
  if (argv.length > MAX_ARGV_ITEMS) throw new RangeError(`exec: argv has more than ${MAX_ARGV_ITEMS} items`)
  for (const a of argv) {
    if (typeof a !== 'string') throw new TypeError('exec: every argv item must be a string')
    // A NUL ends a C string: the program would see a shorter argument than the plugin wrote.
    if (a.includes('\0')) throw new TypeError('exec: argv items must not contain NUL')
  }
  if (argv[0] === '') throw new TypeError('exec: argv[0] must not be empty')
  return argv as string[]
}

export async function runExec(argv: readonly string[], options: ExecOptions | undefined, ctx: ExecContext): Promise<ExecResult> {
  const args = checkArgv(argv)
  const opts = options ?? {}
  if (opts.stdin !== undefined && typeof opts.stdin !== 'string') throw new TypeError('exec: stdin must be a string')
  if (opts.stdin !== undefined && opts.stdin.length > MAX_STDIN_LENGTH) {
    throw new RangeError(`exec: stdin is longer than ${MAX_STDIN_LENGTH} characters`)
  }
  if (opts.cwd !== undefined && (typeof opts.cwd !== 'string' || opts.cwd === '' || opts.cwd.includes('\0'))) {
    throw new TypeError('exec: cwd must be a non-empty path')
  }
  if (opts.timeoutMs !== undefined && (typeof opts.timeoutMs !== 'number' || !(opts.timeoutMs > 0))) {
    throw new TypeError('exec: timeoutMs must be a positive number')
  }
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS)
  const maxOutput = ctx.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES

  const cwd = resolve(ctx.projectDir, opts.cwd ?? '.')
  // Checked here for a clear message: spawn reports a missing cwd as ENOENT for the PROGRAM.
  let isDir = false
  try {
    isDir = (await fs.stat(cwd)).isDirectory()
  } catch {
    /* reported below */
  }
  if (!isDir) throw new Error(`exec: cwd ${cwd} is not an existing directory`)
  ctx.alive?.()

  const spawnFn = ctx.spawnFn ?? spawn
  return new Promise<ExecResult>((resolvePromise, reject) => {
    let child: ChildProcess
    try {
      child = spawnFn(args[0] as string, args.slice(1), {
        cwd,
        env: childEnv(ctx.env),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      })
    } catch (err) {
      reject(new Error(`exec: cannot run ${args[0]}: ${errorText(err)}`))
      return
    }
    ctx.children?.add(child)

    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let settled = false
    const result = (code: number | null): ExecResult => ({
      code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8')
    })
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.children?.delete(child)
      action()
    }

    const timer = setTimeout(() => {
      // Kill the group even when the child already exited: a background grandchild that kept the
      // pipes open is what stopped 'close' from coming. Null even then: the output may be cut off.
      killChild(child)
      settle(() => resolvePromise(result(null)))
    }, timeoutMs)

    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length
      if (size > maxOutput) {
        killChild(child)
        settle(() => reject(new Error(`exec: ${args[0]} wrote more than ${maxOutput} bytes of output`)))
        return
      }
      into.push(chunk)
    }
    child.stdout?.on('data', collect(out))
    child.stderr?.on('data', collect(err))
    // ENOENT (no such program), EACCES, E2BIG.
    child.on('error', (e) => {
      killChild(child)
      settle(() => reject(new Error(`exec: cannot run ${args[0]}: ${e.message}`)))
    })
    child.on('close', (code) => {
      settle(() => resolvePromise(result(code)))
    })

    // The child may exit without reading its stdin: EPIPE is its business, not an error here.
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.stdin ?? '')
  })
}
