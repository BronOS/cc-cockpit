// Main's side of the headless terminals (design-web.md §5.2 "Terminals", §7a).
//
// While web access is on, every tab's terminal stream is numbered here and posted to a worker
// thread that keeps a headless copy of each tab (mirror-worker.ts). TabManager calls the tap
// methods synchronously, next to the `tabs.data` emit, with the SAME flushed chunks the views get,
// plus the spawn size, every size the pty took, restarts and the tab closing, each a numbered item
// of one stream per tab. Numbering happens here, on main's side, because the views (Task 11/12)
// get their items from main: the seq a view sees and the seq the worker parsed must be the same.
//
// A view joins a tab with `join` (Task 11, design-web.md §5.2 "Snapshot without gaps or
// doubles"): it gets one snapshot the worker took inside the write callback of some item N, then
// every item after N, in order, with nothing lost and nothing twice. Main keeps the items it posted
// and the worker has not reported parsed yet (`inflight`); a joining view is handed a copy of them
// and gets every later item too, held until the snapshot comes. The worker takes the snapshot at a
// callback after it received the request, so N is at least the parsed seq main knew at the join,
// and every item after N is in the view's held list; those up to N are dropped. One request per tab
// serves every view waiting on it: a view that joins while one is out gets the same answer, which
// is still no earlier than the parsed seq it saw (the worker's messages arrive in order, and no
// `parsed` past N was posted before the snapshot).
//
// Off costs nothing: no worker, no xterm package loaded, and every tap call returns at once. The
// worker is started by `start()` (WebAccessService, when the settings mean the gateway listens) and
// ended by `stop()`.
//
// Flow (Task 12, design-web.md §5.2): the mirror is the pty's one flow consumer for every tab it
// holds. TabManager binds a TerminalFlow; the mirror `take`s each tab at its spawn, acks the
// characters the worker reports parsed, and `release`s the tabs (back to the desktop's acks) when it
// stops or gives up. So the pty pauses when the worker is HIGH_WATER behind (pty-service.ts), and
// that is what bounds main's buffers here: `inflight` is at most the unparsed backlog, and a waiting
// view's `held` is pruned to the items after the parsed seq, a subset of `inflight`. A view never
// pauses the pty; each one is flow-controlled on its own and resynced when it falls behind
// (desktop-flow.ts, web/view-terminals.ts). MAX_BACKLOG_CHARS is a backstop for a worker that falls
// that far behind anyway (flow control not bound, a bug): it is treated as a crash.
//
// A worker that dies (a crash, out of memory) is started again with a blank terminal per tab at
// main's current seq ("reset"): the content before is lost with it, the numbering goes on, and the
// restart listeners are told. Views that are live keep their stream and their screen: they hold the
// real content, which a resync from the blank copy would wipe (Claude redraws its screen soon, and
// the copy catches up then). Restarts are bounded: past
// MAX_RESTARTS within RESTART_WINDOW_MS the mirror gives up (logs, mirrors nothing) rather than
// loop on a crash it keeps hitting; the tabs themselves never depend on it.
//
// No Electron here: vitest drives it with an in-process fake worker; the real one is
// `nodeMirrorWorker` (worker_threads, which Electron's main process supports as Node does).
import { Worker } from 'node:worker_threads'
import type { TerminalFlow, TerminalTap } from '../tabs/tab-manager'
import {
  type FromWorker,
  type MirrorItem,
  type MirrorSnapshot,
  type MirrorState,
  type ToWorker,
  WORKER_MARK
} from './mirror-protocol'

export type { MirrorItem, MirrorSnapshot, MirrorState } from './mirror-protocol'

export const MAX_RESTARTS = 3
export const RESTART_WINDOW_MS = 60_000
/** An `inspect` the worker never answers (it hung) fails after this rather than waiting forever. */
export const INSPECT_TIMEOUT_MS = 10_000
/**
 * A snapshot the worker never answers: the waiting views are ended (`closed`) rather than held
 * forever with their held items growing. Far above the worker's own ground wait (300 ms): only a
 * hung or drowning worker gets here.
 */
export const SNAPSHOT_TIMEOUT_MS = 10_000
/**
 * Output characters of one tab posted to the worker and not parsed, past which the worker counts as
 * drowned and is restarted like a crashed one. Flow control pauses the pty at a eighth of this
 * (pty-service.ts HIGH_WATER, 1 MiB), so only a broken flow binding ever reaches it; it keeps
 * `inflight` (and the `held` lists, a subset) bounded even then.
 */
export const MAX_BACKLOG_CHARS = 8 * 1024 * 1024

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
  snapshotTimeoutMs?: number
}

/**
 * One view following one tab (the web connection's terminal stream, Task 12 the desktop too).
 * Called synchronously from the tap and the worker's answers; a throw is logged, never passed on.
 */
export interface MirrorView {
  /** First: the tab's screen as of item `snapshot.seq`. */
  snapshot(snapshot: MirrorSnapshot): void
  /** Then every item after it, in order (`seq` one more each time). Never a `close` item. */
  item(item: MirrorItem): void
  /**
   * The stream ended for this view and it is dropped: the tab closed, the mirror stopped or gave
   * up, or its snapshot never came. Joining again starts over with a snapshot.
   */
  closed(): void
}

interface ViewState {
  /** False until the snapshot was delivered; meanwhile `held` collects the stream. */
  live: boolean
  held: MirrorItem[]
}

interface SnapshotRequest {
  id: number
  timer: ReturnType<typeof setTimeout>
}

interface TabStream {
  /** Last item numbered and posted. */
  seq: number
  /** Last item the worker reported applied. */
  parsed: number
  /** Size as of the last numbered item (what a reset or a joining view starts at). */
  cols: number
  rows: number
  /**
   * Posted items the worker has not reported parsed, oldest first: what a joining view may need
   * after its snapshot. Bounded by the worker's backlog, which flow control bounds (see the header).
   */
  inflight: MirrorItem[]
  /** Characters of the data items in `inflight`. */
  unparsedChars: number
  /** `whenParsed` callers, each waiting for a seq. */
  waiters: Array<{ seq: number; resolve: () => void }>
  views: Map<MirrorView, ViewState>
  /** The snapshot request out for the views still waiting, if any. */
  request: SnapshotRequest | null
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
  private nextSnapshot = 1
  private restarts: number[] = []
  private failed = false
  private readonly restartListeners = new Set<() => void>()
  private flow: TerminalFlow | null = null
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
    this.endAllViews()
    this.releaseAll()
    this.tabs.clear()
    worker?.terminate()
  }

  /** Told after the worker restarted: every tab's copy is blank from its current seq on. */
  onRestart(listener: () => void): () => void {
    this.restartListeners.add(listener)
    return () => this.restartListeners.delete(listener)
  }

  // --- the tap (TabManager, synchronous) ------------------------------------------------------------

  /** TabManager's way to the ptys' flow control (see the header); bound once, at its construction. */
  bindFlow(flow: TerminalFlow): void {
    this.flow = flow
  }

  spawned(tabId: string, cols: number, rows: number): void {
    if (!this.worker || !validSize(cols, rows)) return
    let tab = this.tabs.get(tabId)
    if (!tab) {
      tab = {
        seq: 0,
        parsed: 0,
        cols,
        rows,
        inflight: [],
        unparsedChars: 0,
        waiters: [],
        views: new Map(),
        request: null
      }
      this.tabs.set(tabId, tab)
    }
    tab.cols = cols
    tab.rows = rows
    this.send(tabId, tab, { seq: ++tab.seq, kind: 'spawn', cols, rows })
    // Every spawn, a restart too: the restarted process is a new pty, whose flow starts as the
    // desktop's. Before any output (node-pty reads on a later tick).
    this.flowCall('take', () => this.flow?.take(tabId))
  }

  data(tabId: string, chunk: string): void {
    const tab = this.tabs.get(tabId)
    // A tab spawned before the mirror started is not mirrored (see start()).
    if (!this.worker || !tab || chunk.length === 0) return
    tab.unparsedChars += chunk.length
    this.send(tabId, tab, { seq: ++tab.seq, kind: 'data', data: chunk })
    if (tab.unparsedChars > MAX_BACKLOG_CHARS && this.worker) this.drowned(tabId)
  }

  resized(tabId: string, cols: number, rows: number): void {
    const tab = this.tabs.get(tabId)
    if (!this.worker || !tab || !validSize(cols, rows) || (cols === tab.cols && rows === tab.rows)) return
    tab.cols = cols
    tab.rows = rows
    this.send(tabId, tab, { seq: ++tab.seq, kind: 'resize', cols, rows })
  }

  closed(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!this.worker || !tab) return
    this.tabs.delete(tabId)
    // Posted, not given to the views: they are told with `closed` instead.
    this.worker.post({ t: 'item', tabId, item: { seq: ++tab.seq, kind: 'close' } })
    for (const w of tab.waiters.splice(0)) w.resolve()
    this.endViews(tab)
    // A pty still paused for the copy would hold back the exit's last output: it is the desktop's again.
    this.flowCall('release', () => this.flow?.release(tabId))
  }

  // --- views ------------------------------------------------------------------------------------------

  /**
   * Follow a tab: the view gets one snapshot, then every item after it (see the header). Returns
   * the leave function, or undefined for a tab the mirror does not hold (web access off, the tab
   * gone or started before the mirror). The caller decides which tabs a view may follow and when:
   * this trusts the tab id it is given.
   */
  join(tabId: string, view: MirrorView): (() => void) | undefined {
    const tab = this.tabs.get(tabId)
    if (!this.worker || !tab || tab.views.has(view)) return undefined
    const state: ViewState = { live: false, held: [...tab.inflight] }
    tab.views.set(view, state)
    if (!tab.request) this.requestSnapshot(tabId, tab)
    return () => {
      // A stale leave (the view was ended, then joined again) must not drop the newer registration.
      if (tab.views.get(view) !== state) return
      tab.views.delete(view)
      if (tab.request && !this.hasWaiting(tab)) this.cancelRequest(tab)
    }
  }

  /** Views of the tab still waiting for their snapshot (tests, diagnostics). */
  waitingViews(tabId: string): number {
    const tab = this.tabs.get(tabId)
    return tab ? [...tab.views.values()].filter((v) => !v.live).length : 0
  }

  /** Items held for the tab's waiting views, all of them together (tests, diagnostics: the held bound). */
  heldItems(tabId: string): number {
    const tab = this.tabs.get(tabId)
    let n = 0
    if (tab) for (const state of tab.views.values()) if (!state.live) n += state.held.length
    return n
  }

  /** Items posted and not parsed yet (tests, diagnostics: the inflight bound). */
  inflightItems(tabId: string): number {
    return this.tabs.get(tabId)?.inflight.length ?? 0
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

  /** Post one numbered item and hand it to the tab's views (live ones now, waiting ones held). */
  private send(tabId: string, tab: TabStream, item: MirrorItem): void {
    tab.inflight.push(item)
    this.worker?.post({ t: 'item', tabId, item })
    // Over a copy: a view's callback may leave, or a view may join (its held list, copied from
    // `inflight`, already has this item) while the others are served.
    for (const [view, state] of [...tab.views]) {
      if (tab.views.get(view) !== state) continue
      if (state.live) this.call('item', () => view.item(item))
      else state.held.push(item)
    }
  }

  private requestSnapshot(tabId: string, tab: TabStream): void {
    const worker = this.worker
    if (!worker) return
    const id = this.nextSnapshot++
    const timer = setTimeout(() => {
      if (tab.request?.id !== id) return
      tab.request = null
      this.log(`terminal mirror: no snapshot of tab ${tabId} in ${this.options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS} ms`)
      this.endWaiting(tab)
    }, this.options.snapshotTimeoutMs ?? SNAPSHOT_TIMEOUT_MS)
    timer.unref?.()
    tab.request = { id, timer }
    worker.post({ t: 'snapshot', id, tabId })
  }

  private cancelRequest(tab: TabStream): void {
    if (!tab.request) return
    clearTimeout(tab.request.timer)
    tab.request = null
  }

  /** The worker's answer: every waiting view gets the snapshot, then its held items after it. */
  private snapshotReady(tabId: string, ids: number[], snapshot: MirrorSnapshot | null): void {
    const tab = this.tabs.get(tabId)
    // A stale answer (the request timed out, every waiting view left, or a restart re-asked).
    if (!tab || !tab.request || !ids.includes(tab.request.id)) return
    this.cancelRequest(tab)
    if (!snapshot) {
      // The worker does not hold the tab (a spawn it refused): nothing to start the views from.
      this.log(`terminal mirror: no terminal for tab ${tabId} to snapshot`)
      this.endWaiting(tab)
      return
    }
    for (const [view, state] of [...tab.views]) {
      if (state.live) continue
      const after = state.held.filter((item) => item.seq > snapshot.seq)
      state.held = []
      // The header's argument says this cannot happen; checked anyway, because a view out of step
      // would show a different screen than the desktop with nothing to tell it so.
      const from = after[0]?.seq ?? tab.seq + 1
      if (snapshot.seq > tab.seq || from !== snapshot.seq + 1 || (after.at(-1)?.seq ?? snapshot.seq) !== tab.seq) {
        this.log(`terminal mirror: snapshot of tab ${tabId} at ${snapshot.seq} does not meet the stream at ${from}`)
        tab.views.delete(view)
        this.call('closed', () => view.closed())
        continue
      }
      state.live = true
      this.call('snapshot', () => view.snapshot(snapshot))
      for (const item of after) {
        // A view may leave from inside its own callback (and even join again, afresh).
        if (tab.views.get(view) !== state) break
        this.call('item', () => view.item(item))
      }
    }
  }

  private hasWaiting(tab: TabStream): boolean {
    for (const state of tab.views.values()) if (!state.live) return true
    return false
  }

  /** End the views still waiting for a snapshot (it is not coming). */
  private endWaiting(tab: TabStream): void {
    for (const [view, state] of [...tab.views]) {
      if (state.live) continue
      tab.views.delete(view)
      this.call('closed', () => view.closed())
    }
  }

  /** End every view of the tab (it closed, or the mirror is going). */
  private endViews(tab: TabStream): void {
    this.cancelRequest(tab)
    const views = [...tab.views.keys()]
    tab.views.clear()
    for (const view of views) this.call('closed', () => view.closed())
  }

  private endAllViews(): void {
    for (const tab of this.tabs.values()) this.endViews(tab)
  }

  /** A view's callback: one view's throw must not cost the others (or the tap) their items. */
  private call(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log(`terminal mirror view ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
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
        let drop = 0
        let chars = 0
        while (drop < tab.inflight.length && tab.inflight[drop]!.seq <= message.seq) {
          const item = tab.inflight[drop++]!
          if (item.kind === 'data') chars += item.data.length
        }
        // One splice per message, not a shift per item: a flood parses many items between messages.
        if (drop > 0) tab.inflight.splice(0, drop)
        tab.unparsedChars -= chars
        this.pruneHeld(tab)
        if (chars > 0) this.flowCall('ack', () => this.flow?.ack(message.tabId, chars))
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
      case 'snapshot':
        this.snapshotReady(message.tabId, message.ids, message.snapshot)
        return
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
      this.endAllViews()
      this.releaseAll()
      this.tabs.clear()
      return
    }
    this.restarts.push(now)
    const worker = this.spawnWorker()
    this.worker = worker
    for (const [tabId, tab] of this.tabs) {
      // Nothing posted to the old worker will be parsed now: the copy starts at the current seq,
      // and what the pty was waiting on counts as consumed.
      const unparsed = tab.unparsedChars
      tab.parsed = tab.seq
      tab.inflight = []
      tab.unparsedChars = 0
      this.pruneHeld(tab)
      if (unparsed > 0) this.flowCall('ack', () => this.flow?.ack(tabId, unparsed))
      worker.post({ t: 'reset', tabId, seq: tab.seq, cols: tab.cols, rows: tab.rows })
      // The old worker's snapshot is not coming: views still waiting are asked for again, and start
      // from the blank copy at the current seq (their held items after it follow). Live views keep
      // their stream; resyncing them is the restart listeners' job (Task 12).
      this.cancelRequest(tab)
      if (this.hasWaiting(tab)) this.requestSnapshot(tabId, tab)
    }
    for (const listener of this.restartListeners) {
      try {
        listener()
      } catch (err) {
        this.log(`terminal mirror restart listener failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * A tab's backlog passed MAX_BACKLOG_CHARS: the worker is not keeping up even though the pty
   * should be paused. Ended and handled as a crash (a fresh worker, the copies reset at the current
   * seq, the restart budget spent), which empties every `inflight` and acks the backlog.
   */
  private drowned(tabId: string): void {
    const worker = this.worker
    if (!worker) return
    worker.terminate()
    this.crashed(`tab ${tabId} over ${MAX_BACKLOG_CHARS} characters behind`)
  }

  /**
   * Waiting views need only the items after the snapshot they will get, which is taken no earlier
   * than any parsed seq the worker reported before it (its messages arrive in order, and a snapshot
   * is tagged with the worker's parsed seq when taken). So held items up to `parsed` can go, and a
   * held list is never more than `inflight`.
   */
  private pruneHeld(tab: TabStream): void {
    for (const state of tab.views.values()) {
      if (state.live || state.held.length === 0) continue
      let drop = 0
      while (drop < state.held.length && state.held[drop]!.seq <= tab.parsed) drop++
      if (drop > 0) state.held.splice(0, drop)
    }
  }

  /** Hand every tab's pty back to the desktop's acks (the mirror stops or gave up). */
  private releaseAll(): void {
    for (const tabId of this.tabs.keys()) this.flowCall('release', () => this.flow?.release(tabId))
  }

  /** A flow call into TabManager: one tab's throw must not cost the others (or the tap) theirs. */
  private flowCall(what: string, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      this.log(`terminal mirror flow ${what} failed: ${err instanceof Error ? err.message : String(err)}`)
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
