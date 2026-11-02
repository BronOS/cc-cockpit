// The Electron side of a plugin host: the ONLY file that imports `utilityProcess` (index.ts' rule:
// Electron-only modules sit behind interfaces; host-manager.ts takes a HostProcessFactory and the
// unit tests pass a fake). Covered by the e2e suite only.
import { utilityProcess, type MessagePortMain } from 'electron'
import { join } from 'node:path'
import type { HostProcess, HostProcessFactory, HostSpawnOptions } from './host-manager'

/**
 * How long a host has to exit after SIGTERM before it gets SIGKILL. Under HostManager's
 * KILL_WAIT_MS (2 s), after which it stops waiting and forgets the process.
 */
export const HOST_KILL_GRACE_MS = 1_500

/** out/host/index.js, next to this bundle's out/main/index.js (electron.vite.config.ts). */
export function hostEntry(): string {
  return join(__dirname, '../host/index.js')
}

export class ElectronHostProcessFactory implements HostProcessFactory {
  constructor(private readonly entry: string = hostEntry()) {}

  spawn(options: HostSpawnOptions): HostProcess {
    const child = utilityProcess.fork(this.entry, [], {
      // Replaces process.env entirely: the host sees only what host-manager's hostEnv() kept.
      env: options.env,
      cwd: options.cwd,
      // Piped, then prefixed: with several windows open, "inherit" would interleave every host's
      // output with main's and nobody could tell which project a plugin error came from.
      stdio: 'pipe',
      serviceName: options.name
    })
    const prefix = `[${options.name}]`
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (line.trim() !== '') console.error(prefix, line)
        }
      })
    }
    // Messages posted before the child is up wait here, so a caller can talk to it right after
    // spawn without depending on Electron's own queueing before the `spawn` event.
    let spawned = false
    let exited = false
    const early: Array<{ message: string; transfer?: MessagePortMain[] }> = []
    child.once('spawn', () => {
      spawned = true
      for (const m of early.splice(0)) child.postMessage(m.message, m.transfer)
    })
    const exitListeners: Array<(code: number) => void> = []
    child.once('exit', (code) => {
      exited = true
      for (const l of exitListeners) l(code)
    })
    return {
      port: {
        postMessage: (message) => {
          if (exited) throw new Error('plugin host has exited')
          if (spawned) child.postMessage(message)
          else early.push({ message })
        },
        onMessage: (listener) => {
          child.on('message', listener)
          return () => child.off('message', listener)
        }
      },
      onExit: (listener) => {
        exitListeners.push(listener)
      },
      kill: () => {
        if (exited) return
        // SIGTERM first: the host's handler kills its `ctx.exec` children (each detached into its
        // own process group, so nothing else reaches them) and flushes storage (src/host/shutdown.ts).
        // But that handler replaces Node's default, and it runs on the event loop: a host stuck in
        // a synchronous loop (the very case an unanswered activate kills it for) never runs it and
        // would live on unseen. So SIGKILL follows if it has not exited in time; its exec children
        // then outlive it, the lesser evil. Unref'd: it never holds the app open.
        const pid = child.pid
        child.kill()
        if (pid === undefined) return
        setTimeout(() => {
          if (exited) return
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }, HOST_KILL_GRACE_MS).unref()
      },
      // A panel's end of its channel (panel-ports.ts). Queued with its message like any other
      // until the child is up, so it can never overtake the RPC that came before it.
      transferPort: (message, port) => {
        if (exited) throw new Error('plugin host has exited')
        const transfer = [port as MessagePortMain]
        if (spawned) child.postMessage(message, transfer)
        else early.push({ message, transfer })
      }
    }
  }
}
