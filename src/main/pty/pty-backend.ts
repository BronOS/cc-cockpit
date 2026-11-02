// The seam between the app and a pseudo-terminal implementation. Everything outside
// node-pty-backend.ts talks to this interface, so unit tests run with a fake (node-pty is built
// for the Electron ABI and will not load in plain Node) and a ConPTY backend can follow for
// Windows without touching PtyService or the tab manager.

export interface PtySpawnOptions {
  cwd: string
  /** The complete child environment; nothing is inherited implicitly. */
  env: Record<string, string>
  cols: number
  rows: number
}

export interface PtyHandle {
  /** Bytes typed by the user (or programmatic text that already passed the send gate). */
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Ask the child to end; `onExit` still fires once it is gone. Safe to call after exit.
   * Sends `signal` (default SIGHUP) to the leader only and never escalates by itself: a child
   * that ignores HUP stays alive until the caller sends SIGKILL. */
  kill(signal?: 'SIGHUP' | 'SIGKILL'): void
  /**
   * Whether the child (the leader) is still running, answered synchronously from the OS, not
   * from `onExit`: app quit polls it in a blocking wait during which no exit event can arrive.
   */
  alive(): boolean
  /**
   * Stop reading from the PTY so the kernel buffer fills and the child blocks (flow control).
   * Output the child wrote before exiting must still arrive before onExit, even when it exits
   * while paused (the node-pty backend resumes for that, exit-drain.ts).
   */
  pause(): void
  resume(): void
  /** Single subscriber per handle; the service is the only consumer. */
  onData(cb: (data: string) => void): void
  /** `signal` is the terminating signal number when the child was killed by one, else null. */
  onExit(cb: (code: number, signal: number | null) => void): void
}

/**
 * One number for an exit, the way a shell reports it: a child killed by signal n reads 128 + n.
 * node-pty can report a signal death as code 0, and a crash must never read as a clean exit (an
 * overlay's result, a Claude tab's `exitCode` in `ccc sessions`). A non-zero code is kept as is.
 */
export function exitStatus(code: number, signal: number | null): number {
  return signal !== null && code === 0 ? 128 + signal : code
}

export interface PtyBackend {
  /**
   * `argv[0]` is the file to execute and the rest are its arguments; never interpreted by a
   * shell. Throws when the file cannot be started (the caller turns that into a failed tab).
   */
  spawn(argv: string[], options: PtySpawnOptions): PtyHandle
}
