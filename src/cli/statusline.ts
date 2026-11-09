// `ccc statusline`: Claude Code's status line command in a cockpit Claude tab (design.md "Status
// line"). Claude Code gives the account's rate limits, the session's cost and its context fill to
// the status line command only, as JSON on stdin; hooks and transcripts do not carry them. The app's
// `--settings` file (main/hooks/hooks-file.ts) points `statusLine` here, and this:
//
//   1. reads stdin (at most STDIN_CAP_BYTES, within READ_MS),
//   2. forwards only the usage fields (shared/rate-limits.ts pickStatusLineFields) to main over the
//      socket a hook reports to, fire-and-forget within REPORT_BUDGET_MS; main resolves the tab from
//      the token and checks every number again (main/sessions/statusline-handler.ts),
//   3. at the same time runs the person's OWN status line (their user, project or local settings,
//      found the way Claude Code merges them, findUserStatusLine) with the same stdin, through the
//      shell as Claude Code would (it is their own configuration, which Claude would have run
//      anyway), and prints its stdout unchanged, so the line looks exactly as it does without the app.
//
// The invariant is the hook's: this must never fail or hang the person's Claude session. Every
// step is bounded, every failure is silent, and index.ts exits 0 whatever happens (with a backstop
// timer). No status line of their own: nothing is printed. Started often (after every message), so
// this file loads nothing heavy: not client.ts and the guide text it bundles.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Socket } from 'node:net'
import { isAbsolute, join } from 'node:path'
import type { Readable } from 'node:stream'
import { connect } from '../main/socket/transport'
import { encodeRequest, PROTOCOL_VERSION } from '../shared/protocol'
import { pickStatusLineFields } from '../shared/rate-limits'
import { hookSocketPath } from './hook-socket'

type Env = Record<string, string | undefined>

/** Most of the status line JSON read; Claude's is a few KiB. Over it, nothing is forwarded. */
export const STDIN_CAP_BYTES = 256 * 1024
/** How long stdin may take to arrive and close (Claude writes it at once). */
export const READ_MS = 1_000
/** The forward to main, connect and write: then it is abandoned. */
export const REPORT_BUDGET_MS = 500
/** The person's own status line command is killed after this. */
export const USER_COMMAND_TIMEOUT_MS = 5_000
/** Most of the person's command's stdout printed (a status line is one or a few lines). */
export const USER_OUTPUT_CAP_BYTES = 256 * 1024
/**
 * Set in the person's command's environment. A `ccc statusline` that finds it set runs no command:
 * a status line of theirs that is itself `ccc statusline` (a copied settings file) would otherwise
 * start itself again and again until the timeouts caught up.
 */
export const NESTED_ENV = 'CC_COCKPIT_STATUSLINE'
/** The longest time index.ts must wait for runStatusLine (its backstop adds a margin to this). */
export const STATUSLINE_BUDGET_MS = READ_MS + USER_COMMAND_TIMEOUT_MS

/**
 * Read at most `cap` bytes of `stream` within `deadlineMs`. Resolves on end, close, error or the
 * deadline, never rejects. `complete` is false when anything was cut: more than `cap` bytes, an
 * error, or the deadline before the end; such text is not worth parsing.
 */
export function readInput(stream: Readable, cap: number = STDIN_CAP_BYTES, deadlineMs: number = READ_MS): Promise<{ data: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (complete: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      stream.off('data', onData)
      stream.pause()
      resolve({ data: Buffer.concat(chunks).subarray(0, cap), complete })
    }
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      chunks.push(buf)
      size += buf.length
      if (size > cap) finish(false)
    }
    const timer = setTimeout(() => finish(false), deadlineMs)
    stream.on('data', onData)
    stream.once('end', () => finish(true))
    stream.once('close', () => finish(true))
    // An error comes before `close` (stream.destroy(err) emits both, in that order).
    stream.once('error', () => finish(false))
  })
}

function objectOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * The folder whose `.claude/` holds the project's settings: Claude Code reads them from the folder
 * it was started in, which the status line JSON gives as `workspace.project_dir`; then
 * `workspace.current_dir` (where it is now), `cwd`, and last our own cwd (Claude starts the status
 * line in its working folder). Only an absolute path from the JSON counts.
 */
export function projectDirOf(json: unknown, fallback: string): string {
  const o = objectOf(json)
  const workspace = objectOf(o?.workspace)
  for (const v of [workspace?.project_dir, workspace?.current_dir, o?.cwd]) {
    if (typeof v === 'string' && v !== '' && isAbsolute(v) && !v.includes('\0')) return v
  }
  return fallback
}

/** Claude Code's user settings folder: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeConfigDir(env: Env, home: string): string {
  const dir = env.CLAUDE_CONFIG_DIR
  return dir !== undefined && dir !== '' ? dir : join(home, '.claude')
}

/** A settings file's text, or undefined when it cannot be read (missing, a folder, no access). */
export type ReadText = (path: string) => string | undefined

const readText: ReadText = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The person's own status line command, or undefined when they have none. The three settings files
 * Claude Code would use besides ours, lowest first: `<config>/settings.json`, then
 * `<project>/.claude/settings.json`, then `<project>/.claude/settings.local.json`. Claude merges the
 * layers deeply (an object's keys one by one, a higher layer's winning), so the `statusLine`
 * objects are merged the same way: a project file that sets only `padding` keeps the user file's
 * command. Our `--settings` file is not read: it sits above all three and names this command.
 * A file that is missing or not JSON is skipped, as Claude Code skips it. The result counts only
 * with `type: "command"` and a non-blank `command`.
 */
export function findUserStatusLine(dirs: { projectDir: string; configDir: string }, read: ReadText = readText): string | undefined {
  const files = [
    join(dirs.configDir, 'settings.json'),
    join(dirs.projectDir, '.claude', 'settings.json'),
    join(dirs.projectDir, '.claude', 'settings.local.json')
  ]
  let merged: Record<string, unknown> = {}
  for (const file of files) {
    const text = read(file)
    if (text === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const statusLine = objectOf(objectOf(parsed)?.statusLine)
    if (statusLine) merged = { ...merged, ...statusLine }
  }
  const command = merged.command
  if (merged.type !== 'command' || typeof command !== 'string' || command.trim() === '') return undefined
  return command
}

/**
 * Forward the usage fields to main: one request line, written and half-closed without reading the
 * reply, like `ccc hook` (client.ts runHook). Only inside a tab (hookSocketPath: the token and the
 * socket main exported to it), within `budgetMs` in total. Never rejects.
 */
export async function reportUsage(env: Env, json: unknown, budgetMs: number = REPORT_BUDGET_MS): Promise<void> {
  const path = hookSocketPath(env)
  const token = env.APP_TAB_TOKEN
  if (!path || !token) return
  const fields = pickStatusLineFields(json)
  if (Object.keys(fields).length === 0) return
  const line = encodeRequest({ v: PROTOCOL_VERSION, id: 1, token, cmd: 'statusline', args: { ...fields } })
  let socket: Socket | undefined
  let over = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs)
  })
  const work = (async (): Promise<void> => {
    const s = await connect(path, budgetMs)
    if (over) {
      s.destroy()
      return
    }
    socket = s
    await new Promise<void>((resolve) => {
      s.once('error', () => resolve())
      s.end(line, () => resolve())
    })
  })().catch(() => {
    // The app is not there or not listening: the status line still shows.
  })
  try {
    await Promise.race([work, deadline])
  } finally {
    over = true
    clearTimeout(timer)
    socket?.destroy()
  }
}

export interface UserCommandOptions {
  env: Env
  timeoutMs?: number
  outputCap?: number
}

/**
 * Run the person's status line `command` through the shell (`/bin/sh -c` here, what Claude Code
 * runs a command setting with), `input` on its stdin, our environment (Claude's, plus NESTED_ENV)
 * and our working folder, which is Claude's. Resolves with its stdout when it exits 0 (Claude Code
 * shows a status line only then), else with nothing: a failure, a missing program, a signal, or
 * the timeout. Its stderr is dropped. Never rejects.
 *
 * Its own process group (POSIX): on the timeout the whole group is killed, so a `sleep` the shell
 * started cannot keep the pipe open and this process alive past it.
 */
export function runUserCommand(command: string, input: Buffer, options: UserCommandOptions): Promise<Buffer | undefined> {
  const timeoutMs = options.timeoutMs ?? USER_COMMAND_TIMEOUT_MS
  const cap = options.outputCap ?? USER_OUTPUT_CAP_BYTES
  return new Promise((resolve) => {
    let done = false
    const chunks: Buffer[] = []
    let size = 0
    const posix = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    const finish = (out: Buffer | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(out)
    }
    const kill = (): void => {
      try {
        if (posix && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(undefined)
    }, timeoutMs)
    timer.unref?.()
    try {
      child = spawn(command, {
        shell: true,
        env: { ...options.env, [NESTED_ENV]: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: posix,
        windowsHide: true
      })
    } catch {
      finish(undefined)
      return
    }
    child.once('error', () => finish(undefined))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (size >= cap) return
      chunks.push(chunk)
      size += chunk.length
    })
    child.stdout?.once('error', () => {})
    child.once('close', (code) => finish(code === 0 ? Buffer.concat(chunks).subarray(0, cap) : undefined))
    // A command that never reads its stdin (most status lines read it, some do not) closes the
    // pipe early: EPIPE is its business, not a failure of ours.
    child.stdin?.once('error', () => {})
    child.stdin?.end(input)
  })
}

export interface StatusLineDeps {
  env: Env
  stdin: Readable
  /** Our stdout: the person's command's output goes here as bytes, unchanged. */
  write(data: Buffer): void
  /** Our working folder (Claude's): the last fallback for the project folder. */
  cwd: string
  /** The home folder (default os.homedir()), for `~/.claude` when CLAUDE_CONFIG_DIR is not set. */
  home?: string
  read?: ReadText
  readMs?: number
  reportBudgetMs?: number
  userTimeoutMs?: number
}

/**
 * `ccc statusline` end to end. Never rejects; resolves once the forward ended (or was abandoned)
 * and the person's command finished (or was killed). Anything that goes wrong leaves the line as
 * the person's command made it, or empty.
 */
export async function runStatusLine(deps: StatusLineDeps): Promise<void> {
  try {
    const input = await readInput(deps.stdin, STDIN_CAP_BYTES, deps.readMs ?? READ_MS)
    let json: unknown
    if (input.complete) {
      try {
        json = JSON.parse(input.data.toString('utf8'))
      } catch {
        json = undefined
      }
    }
    const report = json === undefined ? Promise.resolve() : reportUsage(deps.env, json, deps.reportBudgetMs ?? REPORT_BUDGET_MS)
    // A nested call (see NESTED_ENV) runs no command: the outer one prints the person's line.
    const command =
      deps.env[NESTED_ENV] === undefined
        ? findUserStatusLine({ projectDir: projectDirOf(json, deps.cwd), configDir: claudeConfigDir(deps.env, deps.home ?? homedir()) }, deps.read)
        : undefined
    // The bytes as they came, even cut short or not JSON: the person's command gets what Claude sent.
    const own = command === undefined ? Promise.resolve(undefined) : runUserCommand(command, input.data, { env: deps.env, timeoutMs: deps.userTimeoutMs })
    const [, out] = await Promise.all([report, own])
    if (out !== undefined && out.length > 0) {
      try {
        deps.write(out)
      } catch {
        // stdout closed: Claude is gone, nothing to show it to.
      }
    }
  } catch {
    // Never fail the status line.
  }
}
