// The spawn adapter for the person's `ssh` (design-remote-desktop.md §5.1): the only place the
// remote-server code touches `child_process`, so `ssh-tunnel.ts` stays plain logic that unit tests
// drive with a fake (test/unit/ssh-tunnel.test.ts).
//
// Rules for every `ssh` child:
//  - argv only, never a shell: argv[0] is `ssh`, looked up on the env's PATH by Node's spawn.
//  - stdin is /dev/null: BatchMode already forbids prompts, and nothing the app has ever goes to
//    ssh's stdin (a `-N` tunnel reads none; a remote `ccc` needs none).
//  - Its own process group (POSIX), so a signal reaches what ssh started too: a ProxyCommand or a
//    ProxyJump's second ssh would otherwise outlive a killed tunnel and keep its socket.
//  - Tracked by the child registry (child-registry.ts), so app quit SIGKILLs it even when a stop
//    timer of ours dies with main.
//  - The exit is reported once, on 'close' (every pipe drained: `runRemote` parses stdout's last
//    line), but at most CLOSE_GRACE_MS after 'exit': a ProxyCommand's child that inherited ssh's
//    stderr could hold the pipe open after ssh itself is gone, and a caller waiting on that would
//    wait for good.
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { liveChildren } from '../child-registry'

/** How long after ssh's own exit its pipes may stay open before the exit is reported anyway. */
const CLOSE_GRACE_MS = 1000

export interface SshExit {
  /** The exit code, or null when killed by a signal or never started. */
  code: number | null
  signal: NodeJS.Signals | null
  /** Set when ssh could not be started at all (not on PATH): the text to show. */
  error?: string
}

/** One running `ssh`. Listeners get text (UTF-8); `onExit` fires exactly once. */
export interface SshProcess {
  onStdout(listener: (text: string) => void): void
  onStderr(listener: (text: string) => void): void
  onExit(listener: (exit: SshExit) => void): void
  /** Signal ssh and its process group; a no-op once it has exited. */
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
}

/** Start `argv` (argv[0] is the program). Never throws: a failed start arrives as an `onExit` with `error`. */
export type SshSpawn = (argv: readonly string[]) => SshProcess

export interface SshSpawnOptions {
  /**
   * The env each run gets, read at spawn time: main passes the login env (index.ts), which is the
   * one that carries the person's `SSH_AUTH_SOCK` and a PATH that finds their `ssh`.
   */
  env?: () => NodeJS.ProcessEnv
  /** Default: the app's registry (`liveChildren`), killed in `will-quit`. */
  track?: (child: ChildProcess) => void
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal)
      return
    }
  } catch {
    /* no such group (already gone): fall through to the child itself */
  }
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}

/** The real `SshSpawn` over `child_process.spawn`. */
export function createSshSpawn(options: SshSpawnOptions = {}): SshSpawn {
  const env = options.env ?? (() => process.env)
  const track = options.track ?? ((child: ChildProcess) => void liveChildren.track(child))
  return (argv) => {
    const stdoutListeners: Array<(text: string) => void> = []
    const stderrListeners: Array<(text: string) => void> = []
    const exitListeners: Array<(exit: SshExit) => void> = []
    let result: SshExit | undefined
    let exited = false
    const report = (exit: SshExit): void => {
      if (result !== undefined) return
      result = exit
      for (const l of exitListeners.splice(0)) l(exit)
    }
    const [file, ...args] = argv
    let child: ChildProcess | undefined
    try {
      child = nodeSpawn(file ?? 'ssh', args, {
        env: env(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      // A synchronous spawn failure (a bad env value): reported like ENOENT, asynchronously, so a
      // caller's listeners are attached first.
      const text = err instanceof Error ? err.message : String(err)
      queueMicrotask(() => report({ code: null, signal: null, error: `ssh could not be started: ${text}` }))
    }
    if (child !== undefined) {
      const c = child
      track(c)
      c.stdout?.setEncoding('utf8')
      c.stderr?.setEncoding('utf8')
      c.stdout?.on('data', (d: string) => {
        for (const l of stdoutListeners) l(d)
      })
      c.stderr?.on('data', (d: string) => {
        for (const l of stderrListeners) l(d)
      })
      // ENOENT (no `ssh` on PATH) arrives here, with no 'exit' after it.
      c.on('error', (err: NodeJS.ErrnoException) => {
        if (exited) return
        exited = true
        const text = err.code === 'ENOENT' ? 'ssh was not found on this machine (is OpenSSH installed and on PATH?)' : `ssh could not be started: ${err.message}`
        report({ code: null, signal: null, error: text })
      })
      c.on('exit', (code, signal) => {
        exited = true
        const t = setTimeout(() => report({ code, signal }), CLOSE_GRACE_MS)
        c.once('close', () => {
          clearTimeout(t)
          report({ code, signal })
        })
      })
    }
    return {
      onStdout: (l) => void stdoutListeners.push(l),
      onStderr: (l) => void stderrListeners.push(l),
      onExit: (l) => {
        if (result !== undefined) l(result)
        else exitListeners.push(l)
      },
      kill: (signal) => {
        if (child === undefined || exited) return
        signalGroup(child, signal)
      }
    }
  }
}
