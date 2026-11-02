// The only file that imports node-pty. It is built for the Electron ABI, so it cannot load under
// vitest directly; test/unit/node-pty-backend.test.ts runs it under Electron's Node, and the
// Playwright e2e run exercises it in the app.
import { spawn } from 'node-pty'
import { exitDrain, pidAlive } from './exit-drain'
import type { PtyBackend, PtyHandle, PtySpawnOptions } from './pty-backend'

export class NodePtyBackend implements PtyBackend {
  spawn(argv: string[], options: PtySpawnOptions): PtyHandle {
    const [file, ...args] = argv
    if (!file) throw new Error('pty spawn needs a command')
    // node-pty execs `file` with `args` directly, no shell involved, so an argument like a Claude
    // prompt travels as exactly one argv element.
    const pty = spawn(file, args, {
      name: 'xterm-256color',
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows
    })
    // A child that exits while paused would lose its unread tail (exit-drain.ts).
    const drain = exitDrain({ alive: () => pidAlive(pty.pid), resume: () => pty.resume() })
    pty.onExit(() => drain.exited())
    return {
      write: (data) => pty.write(data),
      resize: (cols, rows) => {
        // node-pty throws when resizing a PTY whose child already exited (a late resize from the
        // renderer racing the exit); that is harmless, so swallow it.
        try {
          pty.resize(cols, rows)
        } catch {
          /* already exited */
        }
      },
      kill: (signal) => {
        try {
          // No signal: node-pty's default (SIGHUP).
          pty.kill(signal)
        } catch {
          /* already exited */
        }
      },
      // node-pty reaps the child on its own thread (pty.cc), so a child that ended during a
      // blocking wait on the JS thread is already gone here, not a zombie that answers signal 0.
      alive: () => pidAlive(pty.pid),
      pause: () => {
        pty.pause()
        drain.paused()
      },
      resume: () => {
        drain.resumed()
        pty.resume()
      },
      onData: (cb) => {
        pty.onData(cb)
      },
      onExit: (cb) => {
        // node-pty reports signal 0 for a normal exit; surface that as "no signal".
        pty.onExit(({ exitCode, signal }) => cb(exitCode, signal ? signal : null))
      }
    }
  }
}
