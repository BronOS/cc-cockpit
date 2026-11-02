// Login-shell environment capture.
//
// A GUI app launched from Finder/Dock gets launchd's minimal env (PATH=/usr/bin:/bin...), so
// `claude`, `git`, node version managers etc. would not be found. We ask the user's own shell once
// at startup for the environment an interactive login terminal would have.
//
// Pure Node: the process spawner is injected so unit tests never run a real shell.
import { spawn } from 'node:child_process'
import { errorText } from '../../shared/error-text'
import { liveChildren } from '../child-registry'
import { killChild } from '../kill-child'

export interface SpawnResult {
  code: number | null
  stdout: string
}

export interface SpawnOptions {
  timeoutMs: number
  /** stdout cap; more than this kills the child and rejects. */
  maxBytes: number
}

/** Runs `argv` (no shell) and resolves with exit code + stdout; rejects on spawn error, timeout or overflow. */
export type Spawner = (argv: string[], opts: SpawnOptions) => Promise<SpawnResult>

export type Env = Record<string, string | undefined>

export const LOGIN_ENV_TIMEOUT_MS = 5000

/**
 * 1 MiB, the same cap as `ccc hook` stdin. A real environment is far below it (macOS ARG_MAX,
 * which env + argv together must fit in, is 1 MiB); more means an rc file is streaming (`yes`,
 * `tail -f` in .zprofile), which we must not buffer without limit in the main process.
 */
export const LOGIN_ENV_MAX_BYTES = 1024 * 1024

/**
 * After the shell exits we wait at most this long for 'close'. Everything the shell wrote is
 * already in the pipe buffer by then and is read within a tick; 'close' itself may never come
 * when a background job started by an rc file (`ssh-agent &`, `gpg-agent`) inherited stdout.
 */
export const EXIT_DRAIN_MS = 100

export const ENV_BEGIN_MARKER = '__CCC_ENV_BEGIN__'
export const ENV_END_MARKER = '__CCC_ENV_END__'

/**
 * The fixed command string; nothing user controlled reaches the shell. The markers fence the
 * `env -0` output off from whatever rc files print around it:
 * - BEGIN starts with a NUL because output printed before it (p10k instant-prompt escapes,
 *   "Last login", motd, nvm/conda messages) has no trailing NUL and would otherwise glue onto
 *   the first record (`Welcome\nPATH=...`), losing PATH.
 * - END follows env's own trailing NUL; it cuts off `.zlogout` output (`-l` runs it at exit) and
 *   proves the output is complete.
 * `printf '\0'` emits a NUL in the zsh, bash and sh builtins and in /usr/bin/printf.
 */
export const LOGIN_ENV_COMMAND = `printf '\\0${ENV_BEGIN_MARKER}\\0'; env -0; printf '${ENV_END_MARKER}\\0'`

// POSIX portable names. Anything else in an env record is noise (a newline or escape bytes from
// rc output) and must not become a key in a PTY child's environment.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parses `env -0` output. NUL separators (not newlines) because values may contain newlines;
 * split each record on the FIRST `=` only because values may contain `=`. Records without `=`
 * or with an invalid name are skipped (shell noise).
 */
export function parseEnvZ(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const record of output.split('\0')) {
    const eq = record.indexOf('=')
    if (eq <= 0) continue
    const name = record.slice(0, eq)
    if (!ENV_NAME.test(name)) continue
    env[name] = record.slice(eq + 1)
  }
  return env
}

/**
 * Extracts the env records between the BEGIN and END markers of LOGIN_ENV_COMMAND's output.
 * Returns null when either marker is missing: no BEGIN means the command did not run as
 * expected, no END means the output was truncated (a partial env must not replace a full one).
 * A marker cannot be mistaken for an env record: env never prints a record without `=`.
 */
export function parseLoginEnvOutput(stdout: string): Record<string, string> | null {
  const records = stdout.split('\0')
  const begin = records.indexOf(ENV_BEGIN_MARKER)
  if (begin < 0) return null
  const end = records.indexOf(ENV_END_MARKER, begin + 1)
  if (end < 0) return null
  return parseEnvZ(records.slice(begin + 1, end).join('\0'))
}

/**
 * Default spawner: argv-only `spawn`.
 * - `detached: true` (setsid) puts the shell and everything its rc files start in a new process
 *   group with no controlling tty. A timeout can then kill the whole group (a hung version
 *   manager, `ssh-add` waiting for input), and when the app runs from a terminal (`npm run dev`)
 *   the `-i` shell's job control and `/dev/tty` reads cannot touch the developer's terminal.
 * - Resolves on 'close', or EXIT_DRAIN_MS after 'exit' when a background job keeps the pipe open.
 *   That job is the user's (an `ssh-agent` they started), so it is not killed; only our read end
 *   is closed.
 */
export const defaultSpawner: Spawner = (argv, { timeoutMs, maxBytes }) =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv
    if (!file) {
      reject(new Error('empty argv'))
      return
    }
    // stdin ignored: an interactive shell (-i) must not wait on or steal our stdin.
    // Tracked for app quit: a quit during launch (a slow rc file) ends the timeout timer below,
    // not the shell.
    const child = liveChildren.track(spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true }))
    const chunks: Buffer[] = []
    let size = 0
    let exitCode: number | null = null
    let settled = false
    let drainTimer: NodeJS.Timeout | undefined

    const killGroup = (): void => {
      // pid is undefined when the spawn itself failed (ENOENT); nothing to kill then.
      if (child.pid === undefined) return
      killChild(child)
    }

    // Every settle path goes through here. Destroying stdout stops a surviving grandchild that
    // still holds the pipe from appending to `chunks` after we are done.
    const finish = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drainTimer)
      child.stdout.destroy()
      if (err) reject(err)
      else resolve({ code: exitCode, stdout: Buffer.concat(chunks).toString('utf8') })
    }

    const timer = setTimeout(() => {
      killGroup()
      finish(new Error(`timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stdout.on('data', (c: Buffer) => {
      if (settled) return
      size += c.length
      if (size > maxBytes) {
        killGroup()
        finish(new Error(`output exceeded ${maxBytes} bytes`))
        return
      }
      chunks.push(c)
    })
    child.on('error', (err) => finish(err))
    child.on('exit', (code) => {
      exitCode = code
      drainTimer = setTimeout(() => finish(null), EXIT_DRAIN_MS)
    })
    child.on('close', (code) => {
      exitCode = code
      finish(null)
    })
  })

export interface LoginEnvDeps {
  spawner?: Spawner
  log?: (msg: string) => void
  /** Injectable so tests can run the timeout path quickly. */
  timeoutMs?: number
}

/**
 * Runs `[$SHELL, '-l', '-i', '-c', LOGIN_ENV_COMMAND]` once. On any failure (no $SHELL, spawn
 * error, timeout, output cap, non-zero exit, missing markers, empty env) falls back to `base`
 * (process.env) and logs why.
 */
export async function loadLoginEnv(
  base: Env,
  { spawner = defaultSpawner, log = console.warn, timeoutMs = LOGIN_ENV_TIMEOUT_MS }: LoginEnvDeps = {}
): Promise<Env> {
  const shell = base.SHELL
  if (!shell) {
    log('login-env: $SHELL is not set, using process.env')
    return { ...base }
  }
  try {
    const { code, stdout } = await spawner([shell, '-l', '-i', '-c', LOGIN_ENV_COMMAND], {
      timeoutMs,
      maxBytes: LOGIN_ENV_MAX_BYTES
    })
    if (code !== 0) {
      log(`login-env: shell exited with code ${code}, using process.env`)
      return { ...base }
    }
    const parsed = parseLoginEnvOutput(stdout)
    if (parsed === null) {
      log('login-env: shell output is missing the env markers (incomplete), using process.env')
      return { ...base }
    }
    if (Object.keys(parsed).length === 0) {
      log('login-env: shell printed no environment, using process.env')
      return { ...base }
    }
    return parsed
  } catch (err) {
    log(`login-env: ${errorText(err)}, using process.env`)
    return { ...base }
  }
}
