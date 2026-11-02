// Owns the live PTYs by id. Two jobs besides bookkeeping:
//
// 1. Batching. A busy program (a build, `cat` of a big file) produces thousands of tiny reads;
//    one IPC message each would swamp the renderer. Output is buffered per PTY and flushed every
//    FLUSH_MS or as soon as FLUSH_BYTES are pending, whichever comes first. 8 ms stays under a
//    display frame, so typing echo still feels immediate.
// 2. Flow control. Without it a fast producer outruns xterm.js, the renderer's input queue grows
//    without bound and the window freezes. The service counts characters sent but not yet
//    acknowledged by the renderer; above HIGH_WATER it pauses the PTY (the child then blocks on
//    its own write) and resumes once the renderer has caught up.
//
// Units: everything is counted in UTF-16 code units (`string.length`), and the renderer must ack
// with the `length` of the string it wrote to xterm, so the two sides never disagree about bytes
// vs characters.
//
// Pausing is a socket-level pause in the node-pty backend. A child that exits while the PTY is
// paused would have its last output dropped by node-pty (it destroys the unread socket 200 ms
// after the exit); the backend resumes a paused PTY whose child is gone so that tail is read
// first (exit-drain.ts).
import type { PtyBackend, PtyHandle, PtySpawnOptions } from './pty-backend'

export const FLUSH_MS = 8
export const FLUSH_BYTES = 64 * 1024
export const HIGH_WATER = 1024 * 1024
/**
 * Resume at half the pause threshold, not just under it. Resuming the instant one ack arrives
 * would flip pause/resume on every message while a fast producer keeps the renderer saturated.
 */
export const LOW_WATER = HIGH_WATER / 2

/**
 * How long a closed tab's or dismissed overlay's program has to end after SIGHUP before it gets
 * SIGKILL (`terminate`). A program that traps HUP (or is stuck) would otherwise run on unseen
 * after its tab or overlay is gone, with no UI left to stop it.
 */
export const KILL_GRACE_MS = 3000

/**
 * The same grace at app quit, much shorter: the process exits right after will-quit, so no timer
 * can run and the wait blocks the main thread (disposeAll). Programs that end on SIGHUP are gone
 * within milliseconds and end the wait early; only one that traps HUP costs the whole of it,
 * then gets SIGKILL instead of outliving the app. Tabs and overlays each own a service, so a
 * quit waits at most twice this.
 */
export const QUIT_KILL_GRACE_MS = 500
/** How often the quit wait looks whether the children are gone. */
const QUIT_POLL_MS = 10

/** Block the thread for `ms` without spinning. False when this thread may not block. */
function sleepSync(ms: number): boolean {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    return true
  } catch {
    // A thread where Atomics.wait is disallowed (a browser main thread): no grace, SIGKILL now.
    return false
  }
}

/** Bounds for terminal dimensions; node-pty wraps values into an unsigned short natively. */
const MAX_COLS = 1000
const MAX_ROWS = 1000

function validSize(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    cols <= MAX_COLS &&
    rows >= 1 &&
    rows <= MAX_ROWS
  )
}

/** Where output and exits go; main wires this to the owning window's webContents. */
export interface PtySink {
  data(id: string, chunk: string): void
  exit(id: string, code: number, signal: number | null): void
}

export interface PtyServiceOptions {
  backend: PtyBackend
  sink: PtySink
}

interface Entry {
  handle: PtyHandle
  /** Output read from the PTY and not yet flushed to the sink. */
  pending: string[]
  pendingBytes: number
  timer: ReturnType<typeof setTimeout> | null
  /** Sent to the sink and not yet acknowledged by the renderer. */
  unacked: number
  paused: boolean
}

export class PtyService {
  private readonly ptys = new Map<string, Entry>()

  constructor(private readonly options: PtyServiceOptions) {}

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Start a PTY under `id`. Throws if the id is taken or the backend cannot start the command. */
  spawn(id: string, argv: string[], options: PtySpawnOptions): void {
    if (this.ptys.has(id)) throw new Error(`pty ${id} already exists`)
    if (!validSize(options.cols, options.rows)) throw new Error(`invalid pty size for ${id}`)
    const handle = this.options.backend.spawn(argv, options)
    const entry: Entry = {
      handle,
      pending: [],
      pendingBytes: 0,
      timer: null,
      unacked: 0,
      paused: false
    }
    this.ptys.set(id, entry)
    handle.onData((data) => {
      // A read racing an exit that already removed the entry (or a restart that reused the id)
      // must not touch the wrong entry.
      if (this.ptys.get(id) !== entry) return
      entry.pending.push(data)
      entry.pendingBytes += data.length
      if (entry.pendingBytes >= FLUSH_BYTES) this.flush(id, entry)
      else entry.timer ??= setTimeout(() => this.flush(id, entry), FLUSH_MS)
    })
    handle.onExit((code, signal) => {
      if (this.ptys.get(id) !== entry) return
      // Deliver what the child printed before dying (the last line of an error message), then
      // the exit, then forget the PTY: later writes and acks for this id are ignored.
      // The entry is removed first and the flush wrapped, so a throwing sink (destroyed
      // webContents) can neither keep the id taken nor swallow the exit report.
      this.ptys.delete(id)
      try {
        this.flush(id, entry)
      } finally {
        this.options.sink.exit(id, code, signal)
      }
    })
  }

  /** Forwarded to the child. Ignored for an unknown or exited PTY. */
  write(id: string, data: string): void {
    this.ptys.get(id)?.handle.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    // Renderer-supplied: main validates rather than trusting node-pty's partial checks.
    if (!validSize(cols, rows)) return
    this.ptys.get(id)?.handle.resize(cols, rows)
  }

  /** The renderer wrote `count` characters of this PTY's output into xterm. */
  ack(id: string, count: number): void {
    const entry = this.ptys.get(id)
    if (!entry || !(count > 0)) return
    // Clamp at zero: a buggy or hostile renderer acking more than it received must not drive the
    // counter negative and so disable flow control for later output.
    entry.unacked = Math.max(0, entry.unacked - count)
    if (entry.paused && entry.unacked <= LOW_WATER) {
      entry.paused = false
      entry.handle.resume()
    }
  }

  /**
   * Forget unacknowledged output and resume if paused. For a renderer that went away (reload,
   * crash) and so will never ack what it was sent; call when it re-attaches.
   */
  resetFlow(id: string): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    entry.unacked = 0
    if (entry.paused) {
      entry.paused = false
      entry.handle.resume()
    }
  }

  /**
   * Ask the child to end (SIGHUP to the leader, or `signal`). A child that ignores HUP keeps the
   * id taken until it exits; `kill` never escalates by itself (a caller that must be sure, like
   * a closed tab or a dismissed overlay, uses `terminate`).
   * The exit still arrives through the sink once the process is gone.
   */
  kill(id: string, signal?: 'SIGHUP' | 'SIGKILL'): void {
    this.ptys.get(id)?.handle.kill(signal)
  }

  /**
   * Kill for good: SIGHUP now, SIGKILL after `graceMs` if this same PTY is still running. The
   * entry is compared, not just the id, so a restart that reused the id (a tab keeps its id) is
   * never hit by a late timer. Unref'd so it never holds the app open.
   */
  terminate(id: string, graceMs = KILL_GRACE_MS): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    entry.handle.kill()
    setTimeout(() => {
      if (this.ptys.get(id) === entry) entry.handle.kill('SIGKILL')
    }, graceMs).unref?.()
  }

  /**
   * App quit: SIGHUP everything, wait up to `graceMs` (blocking) for the children to end, SIGKILL
   * the ones still running; timers dropped, no exit events emitted. Not `terminate`: its SIGKILL
   * timer never fires once the process has exited, so a child that ignores HUP (and the master
   * side closing sends nothing more than another HUP) would survive the app, reproduced with real
   * node-pty. Any `terminate` timer still pending finds its entry gone and does nothing.
   */
  disposeAll(graceMs = QUIT_KILL_GRACE_MS): void {
    const entries = [...this.ptys.values()]
    // Cleared first: exits that arrive after the wait (node-pty cannot deliver one during it)
    // find no entry and are dropped, as the "no exit events" contract says.
    this.ptys.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.handle.kill()
    }
    let running = entries.filter((e) => e.handle.alive())
    // Counted in steps, not against the clock: Date is faked in the unit tests, the wait is not.
    for (let waited = 0; running.length > 0 && waited < graceMs; waited += QUIT_POLL_MS) {
      if (!sleepSync(QUIT_POLL_MS)) break
      running = running.filter((e) => e.handle.alive())
    }
    for (const entry of running) entry.handle.kill('SIGKILL')
  }

  private flush(id: string, entry: Entry): void {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.pending.length === 0) return
    const chunk = entry.pending.join('')
    entry.pending = []
    entry.pendingBytes = 0
    entry.unacked += chunk.length
    this.options.sink.data(id, chunk)
    if (!entry.paused && entry.unacked > HIGH_WATER) {
      entry.paused = true
      entry.handle.pause()
    }
  }
}
