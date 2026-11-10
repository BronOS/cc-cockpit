// Main's side of the headless terminals (design-web.md §5.2 "Terminals", §7a).
//
// While web access is on, every tab's terminal stream is numbered here and posted to a worker
// thread that keeps a headless copy of each tab (mirror-worker.ts). TabManager calls the tap
// methods synchronously, next to the `tabs.data` emit, with the SAME flushed chunks the views get,
// plus the spawn size, every size the pty took, restarts and the tab closing, each a numbered item
// of one stream per tab. Numbering happens here, on main's side, because the views (Task 11/12)
// get their items from main: the seq a view sees and the seq the worker parsed must be the same.
//
// Off costs nothing: no worker, no xterm package loaded, and every tap call returns at once. The
// worker is started by `start()` (WebAccessService, when the settings mean the gateway listens) and
// ended by `stop()`.
//
// A worker that dies (a crash, out of memory) is started again with a blank terminal per tab at
// main's current seq ("reset"): the content before is lost with it, the numbering goes on, and the
// restart listeners are told so the views resync (Task 12). Restarts are bounded: past
// MAX_RESTARTS within RESTART_WINDOW_MS the mirror gives up (logs, mirrors nothing) rather than
// loop on a crash it keeps hitting; the tabs themselves never depend on it.
//
// No Electron here: vitest drives it with an in-process fake worker; the real one is
// `nodeMirrorWorker` (worker_threads, which Electron's main process supports as Node does).
import { Worker } from 'node:worker_threads'
import type { TerminalTap } from '../tabs/tab-manager'
import { type FromWorker, type MirrorItem, type MirrorState, type ToWorker, WORKER_MARK } from './mirror-protocol'

export type { MirrorItem, MirrorState } from './mirror-protocol'

export const MAX_RESTARTS = 3
export const RESTART_WINDOW_MS = 60_000
/** An `inspect` the worker never answers (it hung) fails after this rather than waiting forever. */
export const INSPECT_TIMEOUT_MS = 10_000

/** Same bounds as PtyService (validSize). */
const MAX_DIM = 1000

/** The worker as main sees it (worker_threads in the app, an in-process fake in tests). */
export interface MirrorWorkerLike {
  post(message: ToWorker): void
  onMessage(listener: (message: FromWorker) => void): void
  /** The worker ended without being asked (`terminate` does not report here). */
  onExit(listener: (reason: string) => void): void
  terminate(): void
}

export type MirrorWorkerFactory = () => MirrorWorkerLike

/** The real worker: `entry` is the built mirror-worker.js (out/main, inside app.asar when packaged). */
export function nodeMirrorWorker(entry: string, scrollback?: number): MirrorWorkerFactory {
  return () => {
    const worker = new Worker(entry, { workerData: { mark: WORKER_MARK, scrollback } })
    // The app's quit ends it (mirror.stop); it must never be what keeps the process alive.
    worker.unref()
    let terminated = false
    let errorText = ''
    const exitListeners: Array<(reason: string) => void> = []
    worker.on('error', (err) => {
      errorText = err instanceof Error ? err.message : String(err)
    })
    worker.on('exit', (code) => {
      if (terminated) return
      const reason = errorText ? `error: ${errorText}` : `exit code ${code}`
      for (const listener of exitListeners) listener(reason)
    })
    return {
      post: (message) => worker.postMessage(message),
      onMessage: (listener) => worker.on('message', listener),
      onExit: (listener) => exitListeners.push(listener),
      terminate: () => {
        terminated = true
        void worker.terminate()
      }
    }
  }
}

export interface TerminalMirrorOptions {
  createWorker: MirrorWorkerFactory
  log?: (message: string) => void
  /** Clock for the restart budget; tests inject one. */
  now?: () => number
  inspectTimeoutMs?: number
}

interface TabStream {
  /** Last item numbered and posted. */
  seq: number
  /** Last item the worker reported applied. */
  parsed: number
  /** Size as of the last numbered item (what a reset or a joining view starts at). */
  cols: number
  rows: number
  /** Posted data items not parsed yet, oldest first: [seq, characters]. */
  unparsed: Array<[number, number]>
  unparsedChars: number
  /** `whenParsed` callers, each waiting for a seq. */
  waiters: Array<{ seq: number; resolve: () => void }>
}

interface PendingInspect {
  resolve: (state: MirrorState | null) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function validSize(cols: number, rows: number): boolean {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1 && cols <= MAX_DIM && rows <= MAX_DIM
}

export class TerminalMirror implements TerminalTap {
  private worker: MirrorWorkerLike | null = null
  private readonly tabs = new Map<string, TabStream>()
  private readonly inspects = new Map<number, PendingInspect>()
  private nextInspect = 1
  private restarts: number[] = []
  private failed = false
  private readonly restartListeners = new Set<() => void>()
  private readonly log: (message: string) => void
  private readonly now: () => number

  constructor(private readonly options: TerminalMirrorOptions) {
    this.log = options.log ?? ((m) => console.warn(m))
    this.now = options.now ?? Date.now
  }

  /** Whether the worker is up (web access on, and the restart budget not spent). */
  get running(): boolean {
    return this.worker !== null
  }

  /**
   * Start the worker; nothing is mirrored before. Tabs already running are not picked up here:
   * their earlier output never passed through the mirror (Task 13 starts them from a baseline).
   */
  start(): void {
    if (this.worker) return
    this.failed = false
    this.restarts = []
    this.worker = this.spawnWorker()
  }

  /** End the worker and forget every tab (web access off, app quit). */
  stop(): void {
    const worker = this.worker
    this.worker = null
    this.failed = false
    this.drop(new Error('terminal mirror stopped'))
    this.tabs.clear()
    worker?.terminate()
  }

  /** Told after the worker restarted: every tab's copy is blank from its current seq on. */
  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener)
    return () => this.restartListeners.delete(listener)
  }

  // --- the tap (TabManager, synchronous) ------------------------------------------------------------

  spawned(tabId: string, cols: number, rows: number): void {
    if (!this.worker || !validSize(cols, rows)) return
    let tab = this.tabs.get(tabId)
    if (!tab) {
      tab = { seq: 0, parsed: 0, cols, rows, unparsed: [], unparsedChars: 0, waiters: [] }
      this.tabs.set(tabId, tab)
    }
    tab.cols = cols
    tab.rows = rows
    this.send(tabId, { seq: ++tab.seq, kind: 'spawn', cols, rows })
  }

  data(tabId: string, chunk: string): void {
    const tab = this.tabs.get(tabId)
    // A tab spawned before the mirror started is not mirrored (see start()).
    if (!this.worker || !tab || chunk.length === 0) return
    const seq = ++tab.seq
    tab.unparsed.push([seq, chunk.length])
    tab.unparsedChars += chunk.length
    this.send(tabId, { seq, kind: 'data', data: chunk })
  }

  resized(tabId: string, cols: number, rows: number): void {
    const tab = this.tabs.get(tabId)
    if (!this.worker || !tab || !validSize(cols, rows) || (cols === tab.cols && rows === tab.rows)) return
    tab.cols = cols
    tab.rows = rows
    this.send(tabId, { seq: ++tab.seq, kind: 'resize', cols, rows })
  }

  closed(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!this.worker || !tab) return
    this.tabs.delete(tabId)
    this.send(tabId, { seq: ++tab.seq, kind: 'close' })
    for (const w of tab.waiters.splice(0)) w.resolve()
  }

  // --- reads ------------------------------------------------------------------------------------------

  /** Last item numbered for the tab, or undefined for a tab the mirror does not hold. */
  seq(tabId: string): number | undefined {
    return this.tabs.get(tabId)?.seq
  }

  /** Last item the worker applied. */
  parsed(tabId: string): number | undefined {
    return this.tabs.get(tabId)?.parsed
  }

  /** Size as of the last numbered item. */
  size(tabId: string): { cols: number; rows: number } | undefined {
    const tab = this.tabs.get(tabId)
    return tab ? { cols: tab.cols, rows: tab.rows } : undefined
  }

  /** Output characters posted to the worker and not parsed yet (how far behind the copy is). */
  backlog(tabId: string): number {
    return this.tabs.get(tabId)?.unparsedChars ?? 0
  }

  /**
   * Resolves once every item numbered so far for the tab is parsed, or the tab, the worker or the
   * mirror goes away (nothing is left to wait for then; never rejects).
   */
  whenParsed(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.parsed >= tab.seq) return Promise.resolve()
    return new Promise((resolve) => tab.waiters.push({ seq: tab.seq, resolve }))
  }

  /** The tab's headless terminal once everything posted so far is parsed; null for an unknown tab. */
  inspect(tabId: string): Promise<MirrorState | null> {
    const worker = this.worker
    if (!worker || !this.tabs.has(tabId)) return Promise.resolve(null)
    const id = this.nextInspect++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inspects.delete(id)
        reject(new Error('terminal mirror did not answer'))
      }, this.options.inspectTimeoutMs ?? INSPECT_TIMEOUT_MS)
      timer.unref?.()
      this.inspects.set(id, { resolve, reject, timer })
      worker.post({ t: 'inspect', id, tabId })
    })
  }

  // --- the worker --------------------------------------------------------------------------------------

  private send(tabId: string, item: MirrorItem): void {
    this.worker?.post({ t: 'item', tabId, item })
  }

  private spawnWorker(): MirrorWorkerLike {
    const worker = this.options.createWorker()
    worker.onMessage((message) => {
      // A message from a worker that was replaced or stopped describes terminals nobody holds.
      if (this.worker === worker) this.received(message)
    })
    worker.onExit((reason) => {
      if (this.worker === worker) this.crashed(reason)
    })
    return worker
  }

  private received(message: FromWorker): void {
    switch (message.t) {
      case 'parsed': {
        const tab = this.tabs.get(message.tabId)
        if (!tab || message.seq <= tab.parsed) return
        tab.parsed = message.seq
        for (let head = tab.unparsed[0]; head && head[0] <= message.seq; head = tab.unparsed[0]) {
          tab.unparsed.shift()
          tab.unparsedChars -= head[1]
        }
        if (tab.waiters.length > 0) {
          const done = tab.waiters.filter((w) => w.seq <= tab.parsed)
          tab.waiters = tab.waiters.filter((w) => w.seq > tab.parsed)
          for (const w of done) w.resolve()
        }
        return
      }
      case 'inspected': {
        const pending = this.inspects.get(message.id)
        if (!pending) return
        this.inspects.delete(message.id)
        clearTimeout(pending.timer)
        pending.resolve(message.state)
        return
      }
      case 'log':
        this.log(message.message)
        return
      case 'ready':
        this.log('terminal mirror: worker ready')
        return
    }
  }

  private crashed(reason: string): void {
    this.log(`terminal mirror worker ended (${reason})`)
    this.drop(new Error('terminal mirror worker restarted'))
    const now = this.now()
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS)
    if (this.restarts.length >= MAX_RESTARTS) {
      // Crashing on every start: stop trying. The tabs run as before; only the copies are gone.
      this.log(`terminal mirror: ${MAX_RESTARTS} restarts within ${RESTART_WINDOW_MS / 1000} s, giving up until web access is turned on again`)
      this.worker = null
      this.failed = true
      this.tabs.clear()
      return
    }
    this.restarts.push(now)
    const worker = this.spawnWorker()
    this.worker = worker
    for (const [tabId, tab] of this.tabs) {
      // Nothing posted to the old worker will be parsed now: the copy starts at the current seq.
      tab.parsed = tab.seq
      tab.unparsed = []
      tab.unparsedChars = 0
      worker.post({ t: 'reset', tabId, seq: tab.seq, cols: tab.cols, rows: tab.rows })
    }
    for (const listener of this.restartListeners) {
      try {
        listener()
      } catch (err) {
        this.log(`terminal mirror restart listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /** Whether the restart budget ran out (tests, diagnostics). */
  get gaveUp(): boolean {
    return this.failed
  }

  /** Fail every pending inspect and release every waiter (the worker they asked is gone). */
  private drop(err: Error): void {
    for (const pending of this.inspects.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.inspects.clear()
    for (const tab of this.tabs.values()) for (const w of tab.waiters.splice(0)) w.resolve()
  }
}
