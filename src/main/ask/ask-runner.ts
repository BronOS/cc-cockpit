// The one place main spawns an Ask chat's `claude` (shared/design.md §5, D14): argv only (ask-argv.ts), never a shell; its
// own process group, so a kill takes whatever it started with it (killChild: SIGKILL to the group); tracked by
// `liveChildren` so app quit kills it too. Spawned as main/sessions/gist-run.ts does.
//
// stdout is split into lines (the stream-json events) and handed on; stderr is kept as a bounded tail for the log and
// the owner's error text. Nothing here reads a line's meaning: ask-service.ts does.
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { liveChildren } from '../child-registry'
import { killChild } from '../kill-child'

/** A running chat process, as the service sees it (a fake in tests). */
export interface AskProcess {
  /** Write one stdin line (a stream-json user message). A write to a process that is gone is dropped. */
  write(line: string): void
  /** SIGKILL the process group. Idempotent. */
  kill(): void
  /** Settles once the process has exited (or never started). */
  readonly exited: Promise<void>
}

export interface AskProcessHandlers {
  /** One stdout line, without its newline. */
  line(text: string): void
  /** The process is gone: its code or signal, the tail of its stderr, or the spawn error. */
  exit(info: { code: number | null; signal: string | null; stderr: string; error?: string }): void
}

export type AskSpawn = (argv: readonly string[], options: { cwd: string; env: Record<string, string> }, handlers: AskProcessHandlers) => AskProcess

/** stderr is kept up to this many characters (the tail). */
const MAX_STDERR = 8000
/** One stdout line past this many characters is dropped whole (a stream event is far smaller; a runaway is not parsed). */
const MAX_LINE = 4 * 1024 * 1024
/** `claude --help`: killed after this long, and read up to this many characters. */
const HELP_TIMEOUT_MS = 15_000
const MAX_HELP = 1024 * 1024

/** The real spawn. */
export const spawnAsk: AskSpawn = (argv, { cwd, env }, handlers) => {
  let child: ChildProcess | undefined
  let resolveExit: () => void = () => {}
  const exited = new Promise<void>((resolve) => (resolveExit = resolve))
  let done = false
  let stderr = ''
  const finish = (info: { code: number | null; signal: string | null; error?: string }): void => {
    if (done) return
    done = true
    resolveExit()
    handlers.exit({ ...info, stderr })
  }
  try {
    child = spawn(argv[0] as string, argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  } catch (err) {
    queueMicrotask(() => finish({ code: null, signal: null, error: err instanceof Error ? err.message : String(err) }))
    return { write: () => {}, kill: () => {}, exited }
  }
  liveChildren.track(child)
  let buffered = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (d: string) => {
    buffered += d
    let nl = buffered.indexOf('\n')
    while (nl !== -1) {
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      handlers.line(line)
      nl = buffered.indexOf('\n')
    }
    if (buffered.length > MAX_LINE) buffered = ''
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (d: string) => {
    stderr = (stderr + d).slice(-MAX_STDERR)
  })
  child.stdin?.on('error', () => {})
  // `claude` not on PATH arrives here (ENOENT).
  child.on('error', (err) => finish({ code: null, signal: null, error: err.message }))
  child.on('close', (code, signal) => {
    if (buffered.trim() !== '') handlers.line(buffered)
    buffered = ''
    finish({ code, signal })
  })
  const proc = child
  return {
    write(line: string): void {
      if (done || !proc.stdin || proc.stdin.destroyed) return
      proc.stdin.write(line)
    },
    kill(): void {
      if (!done) killChild(proc)
    },
    exited
  }
}

export type ReadHelp = (bin: string, env: Record<string, string>) => Promise<string>

/** `bin --help` from a neutral folder (the flag list does not depend on it), bounded in time and size. */
export const readHelp: ReadHelp = (bin, env) =>
  new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(bin, ['--help'], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    liveChildren.track(child)
    let out = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChild(child)
    }, HELP_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (out.length < MAX_HELP) out += d.slice(0, MAX_HELP - out.length)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${bin} --help did not answer in ${HELP_TIMEOUT_MS / 1000} s`))
      else if (code !== 0) reject(new Error(`${bin} --help exited with code ${String(code)}`))
      else resolve(out)
    })
  })
