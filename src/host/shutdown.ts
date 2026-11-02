// The plugin host's last act, however it ends: kill the plugins' running `ctx.exec` children and
// write their pending storage (HostContexts.killChildrenAndFlush).
//
// Main does not always get to ask for a deactivate first, and when it does it does not wait for
// it: app quit (HostManager.disposeAll) and a deactivate that outlives its 5 s grace kill the host
// with utilityProcess.kill(), which sends SIGTERM on POSIX; a crash (an uncaught exception) exits
// on its own. The children are `detached` into their own process group, so none of these reach
// them, and their timeout timers die with the host.
//
//  - The cleanup runs in the process 'exit' handler: every way out but SIGKILL passes there,
//    process.exit() and an uncaught exception included. It must be synchronous there, and is.
//  - A SIGTERM / SIGINT / SIGHUP handler REPLACES Node's default "terminate", so each one must
//    end in process.exit(), or utilityProcess.kill() would stop killing the host and leave a
//    worse orphan than the one this avoids. It exits and lets the 'exit' handler do the work, so
//    the cleanup runs once. 128 + signal number is the shell's convention for "killed by signal".
//  - SIGKILL cannot be caught: main's kill sends SIGTERM, and the deactivate RPC already cleaned
//    up before the plugins' deactivate() ran (src/host/index.ts).

import { errorText } from '../shared/error-text'

/** The slice of `process` used here (tests pass a fake). */
export interface ShutdownProcess {
  on(event: 'exit', listener: () => void): unknown
  on(event: NodeJS.Signals, listener: () => void): unknown
  exit(code: number): void
}

const SIGNALS: [NodeJS.Signals, number][] = [
  ['SIGTERM', 15],
  ['SIGINT', 2],
  ['SIGHUP', 1]
]

export function installShutdownHandlers(
  proc: ShutdownProcess,
  cleanup: () => void,
  log: (message: string) => void = (m) => console.error(m)
): void {
  proc.on('exit', () => {
    try {
      cleanup()
    } catch (err) {
      log(`plugin host: cleanup on exit failed: ${errorText(err)}`)
    }
  })
  for (const [signal, number] of SIGNALS) {
    proc.on(signal, () => proc.exit(128 + number))
  }
}
