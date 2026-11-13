// `ctx.processes.spawn(argv, { cwd })` (design-editor.md §1 "Core: long-running processes"): a
// child that lives as long as the plugin wants, with byte stdio. The editor's language servers
// speak LSP over it (Content-Length counts bytes, so text would be the wrong unit) and quick chat
// runs a headless `claude -p` through it.
//
// Decisions (code-editor plan Task 5):
//  - The same spawn as ctx.exec (ctx/exec.ts header): argv only with `shell: false`, the same argv
//    check, argv[0] on the PATH of the host's env, `childEnv` dropping Chromium's `disabled:` bus
//    address, cwd defaulting to the project folder. It is not a capability: the host is trusted
//    code that can already start processes, so there is no permission to ask main for.
//  - Synchronous: the handle comes back at once so the plugin can attach its listeners in the same
//    tick (no output event can come before that tick ends). The cwd is checked with a sync stat for
//    a clear message (spawn reports a missing cwd as ENOENT for the PROGRAM). A program that cannot
//    be started leaves `pid` undefined right after spawn (Node emits the error on the next tick), so
//    spawn throws instead of handing out a handle that never runs.
//  - stdout and stderr are always read, with or without a listener: a child writing to a pipe
//    nobody drains blocks forever (a language server logging to stderr would hang mid-request).
//  - stdin: bytes only; writes after exit or `end()` are ignored (the child is gone, an EPIPE is
//    its business). More than 64 MiB waiting unread throws: a child that stopped reading must not
//    grow the host's memory without bound.
//  - Exit is reported on 'close' (every pipe drained, so the last output is delivered before
//    onExit). A child that exited while a grandchild still holds its pipes would never 'close':
//    after a short grace the pipes are destroyed, which closes them.
//  - At most 16 running per plugin (counted in the host, freed on close). Every child leads its own
//    process group (`detached`) and goes into the runtime's `children`, the set ctx.exec uses: the
//    plugin's dispose (stop, reload, failed activate) and the host's stop (killChildrenAndFlush)
//    SIGKILL each group. A child of a crashed host gets EOF on stdin, and LSP servers exit on it.
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Disposer, PluginProcess, ProcessExit, ProcessSpawnOptions } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { checkArgv, childEnv, killChild } from './exec'

export const MAX_PROCESSES_PER_PLUGIN = 16
export const MAX_PENDING_STDIN_BYTES = 64 * 1024 * 1024
/** How long after 'exit' the pipes may stay open (a grandchild holding them) before they are destroyed. */
const CLOSE_GRACE_MS = 2000

export interface ProcessesContext {
  /** Default cwd (absolute, from main). */
  projectDir: string
  /** The child's environment, PATH included. */
  env: NodeJS.ProcessEnv
  /** This plugin's children (shared with ctx.exec), killed at dispose and host stop. */
  children?: Set<ChildProcess>
  /** This plugin's running processes: the cap's count. */
  running: Set<ChildProcess>
  /** Throws once the plugin's ctx is disposed. */
  alive?: () => void
  /** A listener of the plugin threw: logged, never thrown into the stream's event. */
  report: (err: unknown) => void
  max?: number
  /** Tests inject a fake; default node:child_process.spawn. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

export function spawnProcess(argv: readonly string[], options: ProcessSpawnOptions | undefined, ctx: ProcessesContext): PluginProcess {
  ctx.alive?.()
  const args = checkArgv(argv, 'processes')
  const opts = options ?? {}
  if (opts.cwd !== undefined && (typeof opts.cwd !== 'string' || opts.cwd === '' || opts.cwd.includes('\0'))) {
    throw new TypeError('processes: cwd must be a non-empty path')
  }
  const max = ctx.max ?? MAX_PROCESSES_PER_PLUGIN
  if (ctx.running.size >= max) throw new RangeError(`processes: this plugin already runs ${max} processes`)
  const cwd = resolve(ctx.projectDir, opts.cwd ?? '.')
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {
    /* reported below */
  }
  if (!isDir) throw new Error(`processes: cwd ${cwd} is not an existing directory`)

  const program = args[0] as string
  let child: ChildProcess
  try {
    child = (ctx.spawnFn ?? spawn)(program, args.slice(1), {
      cwd,
      env: childEnv(ctx.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    })
  } catch (err) {
    throw new Error(`processes: cannot run ${program}: ${errorText(err)}`, { cause: err })
  }
  // ENOENT and EACCES come as an 'error' on the next tick; without a listener it would be thrown.
  child.on('error', () => {})
  const pid = child.pid
  if (pid === undefined) throw new Error(`processes: cannot run ${program}`)
  ctx.running.add(child)
  ctx.children?.add(child)

  const dataListeners = new Set<(bytes: Uint8Array) => void>()
  const stderrListeners = new Set<(bytes: Uint8Array) => void>()
  const exitListeners = new Set<(exit: ProcessExit) => void>()
  let exit: ProcessExit | null = null
  let ended = false
  let graceTimer: ReturnType<typeof setTimeout> | undefined

  const deliver = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (err) {
        ctx.report(err)
      }
    }
  }
  child.stdout?.on('data', (chunk: Buffer) => deliver(dataListeners, chunk))
  child.stderr?.on('data', (chunk: Buffer) => deliver(stderrListeners, chunk))
  child.stdin?.on('error', () => {})

  child.on('exit', () => {
    graceTimer = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }, CLOSE_GRACE_MS)
    graceTimer.unref?.()
  })
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (exit) return
    clearTimeout(graceTimer)
    exit = { code, signal: signal ?? null }
    ctx.running.delete(child)
    ctx.children?.delete(child)
    child.stdin?.destroy()
    dataListeners.clear()
    stderrListeners.clear()
    const listeners = [...exitListeners]
    exitListeners.clear()
    deliver(new Set(listeners), exit)
  })

  const listen = <T>(set: Set<(value: T) => void>, listener: (value: T) => void, name: string): Disposer => {
    if (typeof listener !== 'function') throw new TypeError(`processes: ${name} needs a function`)
    // After the exit nothing more comes: no listener kept.
    if (exit) return () => {}
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  return Object.freeze({
    pid,
    write(bytes: Uint8Array): void {
      if (!(bytes instanceof Uint8Array)) throw new TypeError('processes: write takes a Uint8Array')
      const stdin = child.stdin
      if (exit || ended || !stdin || stdin.destroyed || !stdin.writable) return
      if (stdin.writableLength + bytes.byteLength > MAX_PENDING_STDIN_BYTES) {
        throw new RangeError(`processes: more than ${MAX_PENDING_STDIN_BYTES} bytes wait unread on stdin`)
      }
      stdin.write(bytes)
    },
    end(): void {
      if (ended) return
      ended = true
      child.stdin?.end()
    },
    onData: (listener: (bytes: Uint8Array) => void) => listen(dataListeners, listener, 'onData'),
    onStderr: (listener: (bytes: Uint8Array) => void) => listen(stderrListeners, listener, 'onStderr'),
    onExit(listener: (exit: ProcessExit) => void): Disposer {
      if (typeof listener !== 'function') throw new TypeError('processes: onExit needs a function')
      const done = exit
      if (done) {
        // Not synchronously inside the call: the plugin's code after onExit(...) runs first, as it
        // would for an exit that came a moment later.
        queueMicrotask(() => deliver(new Set([listener]), done))
        return () => {}
      }
      exitListeners.add(listener)
      return () => {
        exitListeners.delete(listener)
      }
    },
    kill(): void {
      if (exit) return
      killChild(child)
    }
  })
}
