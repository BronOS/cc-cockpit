// Keeps the last output of a child that exits while its PTY is paused for flow control.
//
// node-pty pauses by pausing its read socket. When the child exits, node-pty waits for that socket
// to close before it reports the exit, and destroys it after 200 ms if it does not
// (DESTROY_SOCKET_TIMEOUT_MS in unixTerminal.js). A paused socket never closes by itself, so the
// output still unread (the kernel PTY buffer, the socket's own buffer) is thrown away: in a
// saturated tab, `cat big.log; echo FAILED` would lose exactly the FAILED line. Measured on macOS
// with node-pty 1.1.0 under Electron's Node: `echo hello; echo TAIL` started paused lost all of
// its output; with this watch it arrived in full, followed by the exit.
//
// So while a PTY is paused, its child is polled every POLL_MS (well inside node-pty's 200 ms) and
// a paused PTY whose child is gone is resumed: the tail is read, the socket closes, the exit
// follows. The tail then goes to a renderer that is already behind; it is at most what the kernel
// and socket buffers held, so flow control is not undone.
//
// No node-pty import: node-pty-backend.ts wires this to the real PTY, vitest drives it with fakes.

/** Poll interval; must stay well under node-pty's 200 ms socket-destroy timeout. */
export const POLL_MS = 50

export interface ExitDrainOptions {
  /** False once the child is gone (reaped). An unknown answer must say true. */
  alive(): boolean
  /** Resume reading the PTY. */
  resume(): void
  pollMs?: number
}

/** The `pause` / `resume` / exit hooks a backend calls; at most one poll timer runs at a time. */
export interface ExitDrain {
  paused(): void
  resumed(): void
  exited(): void
}

export function exitDrain(options: ExitDrainOptions): ExitDrain {
  const pollMs = options.pollMs ?? POLL_MS
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = (): void => {
    if (timer) clearInterval(timer)
    timer = null
  }
  return {
    paused: () => {
      if (timer) return
      timer = setInterval(() => {
        if (options.alive()) return
        stop()
        options.resume()
      }, pollMs)
      // A paused PTY must never keep the app from quitting.
      timer.unref?.()
    },
    resumed: stop,
    exited: stop
  }
}

/**
 * Whether `pid` still exists, by signal 0. ESRCH = gone. Anything else (EPERM: the pid was reused
 * by another user's process) counts as alive, which only falls back to node-pty's own behaviour.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
