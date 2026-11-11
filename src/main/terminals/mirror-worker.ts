// Headless terminals for web access (design-web.md §5.2 "Terminals", §7a), run in a worker thread.
//
// Main keeps a headless copy of every tab's terminal while web access is on, fed the same flushed
// chunks the views get, so a view joining a tab can be given its screen (`snapshot`). The copies live
// here and not in main because xterm parses in slices of up to 12 ms per terminal: the spike
// measured 8 flooded tabs stalling main's event loop for about 97 ms at p50 (§7a), and main serves
// every IPC call. Main numbers the stream (mirror.ts) and posts each item here in order; this
// thread only parses and answers.
//
// Built as its own entry (electron.vite.config.ts: out/main/mirror-worker.js) and started by
// mirror.ts with `worker_threads`. Nothing here imports main code at run time: the bundle holds
// this file and the xterm packages it requires from node_modules (shipped in the package,
// electron-builder.yml); the protocol (mirror-protocol.ts) holds only types and one constant.
import { parentPort, workerData } from 'node:worker_threads'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Terminal } from '@xterm/headless'
import { atGround, extraModes, type TerminalScreen } from '../../shared/terminal-screen'
import {
  type FromWorker,
  MIRROR_SCROLLBACK,
  type MirrorItem,
  type MirrorSnapshot,
  type OscColorIdent,
  type ToWorker,
  WORKER_MARK
} from './mirror-protocol'

// Where they lived before the desktop page needed them too (shared/terminal-screen.ts).
export { extraModes } from '../../shared/terminal-screen'
export { MIRROR_SCROLLBACK } from './mirror-protocol'
/**
 * How long a snapshot request waits for the parser's ground state before it is taken anyway
 * (design-web.md §5.2): a program that stopped mid-sequence, or a stream whose chunk boundaries
 * keep landing inside sequences, must not leave a joining view waiting. The risk of taking it then
 * is a few garbage characters on that view, not a stuck one.
 */
export const GROUND_WAIT_MS = 300

/** Same bounds as PtyService (validSize): a size the pty would refuse is not applied here either. */
const MAX_DIM = 1000

function validSize(cols: unknown, rows: unknown): cols is number {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    (cols as number) >= 1 &&
    (rows as number) >= 1 &&
    (cols as number) <= MAX_DIM &&
    (rows as number) <= MAX_DIM
  )
}

interface TabTerm {
  term: Terminal
  serializer: SerializeAddon
  disposed: boolean
  /** Last item handed to xterm's write queue. */
  received: number
  /** Last item whose write callback ran: the buffer holds exactly items 1..parsed between callbacks. */
  parsed: number
  /** Snapshot requests waiting for the ground state, answered together. */
  snaps: number[]
  /** The ground wait's deadline, armed by the first waiting request. */
  groundTimer: ReturnType<typeof setTimeout> | null
  /**
   * No snapshot below this seq: a seeded terminal (`reset` with a seed) holds its stream from the
   * seed's seq on, so a snapshot taken before the seed is parsed would be a blank screen tagged with
   * the seq before it, and the view would miss the seed (its `spawn` item is only a size to a view).
   */
  floor: number
  /** The ground wait ran out while the seed was still unparsed: the snapshot is taken at the floor. */
  overdue: boolean
  /** Parsing the seed: what the terminal answers is not the program's to get (answerQueries). */
  quiet: boolean
}

export interface HeadlessTermsOptions {
  scrollback?: number
  groundWaitMs?: number
}

/**
 * One headless terminal per tab, driven by main's numbered items. Every item goes through xterm's
 * write queue (a resize too, as an empty write whose callback resizes) so items apply in stream
 * order: a resize applied at once would reflow output the program wrote for the old size, and the
 * copies in the views apply it at the same point of the stream. Each item's write callback reports
 * `parsed` with its seq: main uses it to know how far behind the copy is (flow control, Task 12).
 */
export class HeadlessTerms {
  private readonly tabs = new Map<string, TabTerm>()
  private readonly scrollback: number
  private readonly groundWaitMs: number

  constructor(
    private readonly post: (message: FromWorker) => void,
    options: HeadlessTermsOptions = {}
  ) {
    this.scrollback = options.scrollback ?? MIRROR_SCROLLBACK
    this.groundWaitMs = options.groundWaitMs ?? GROUND_WAIT_MS
  }

  /** Main's messages, in the order main posted them. A bad one is reported, never thrown. */
  handle(message: ToWorker): void {
    try {
      this.dispatch(message)
    } catch (err) {
      this.post({ t: 'log', message: `terminal mirror worker: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  /** Tab count (tests). */
  size(): number {
    return this.tabs.size
  }

  dispose(): void {
    for (const t of this.tabs.values()) this.disposeTab(t)
    this.tabs.clear()
  }

  private dispatch(message: ToWorker): void {
    switch (message.t) {
      case 'item':
        this.item(message.tabId, message.item)
        return
      case 'reset':
        this.reset(message.tabId, message.seq, message.cols, message.rows, message.seed)
        return
      case 'inspect':
        this.inspect(message.id, message.tabId)
        return
      case 'snapshot':
        this.requestSnapshot(message.id, message.tabId)
        return
    }
  }

  private item(tabId: string, item: MirrorItem): void {
    const existing = this.tabs.get(tabId)
    switch (item.kind) {
      case 'spawn':
        if (!existing) {
          // A tab's first process: a new terminal, at the size the pty was spawned with.
          if (!validSize(item.cols, item.rows)) return
          this.tabs.set(tabId, this.create(tabId, item.cols, item.rows, item.seq))
          this.post({ t: 'parsed', tabId, seq: item.seq })
          return
        }
        // A restart keeps the content, but the copy follows the pty's size: it is resized to the
        // spawn size and back when the renderer reports its own. The desktop's xterm never shrinks
        // here, and a shrink-then-grow reflow is not exactly reversible (cursor, scrollback, wrapped
        // lines), so right after a restart the copy can differ slightly from the desktop's screen.
        this.resize(tabId, existing, item.seq, item.cols, item.rows)
        return
      case 'data':
        if (!existing) return
        existing.received = item.seq
        existing.term.write(item.data, () => this.parsed(tabId, existing, item.seq))
        return
      case 'resize':
        if (existing) this.resize(tabId, existing, item.seq, item.cols, item.rows)
        return
      case 'close':
        // The tab is gone: free its terminal now. xterm's dispose() does not clear its write
        // queue, so chunks already queued are still parsed in the background (their callbacks are
        // silenced by `disposed`); nobody can join a closed tab, so nothing waits for them.
        if (!existing) return
        this.tabs.delete(tabId)
        this.disposeTab(existing)
        this.answerSnapshots(tabId, existing, null)
        this.post({ t: 'parsed', tabId, seq: item.seq })
        return
    }
  }

  /**
   * A new terminal for the tab at main's `seq` (mirror.ts): after a worker restart, or for a tab
   * that ran before web access started. Blank without `seed`: the content before is lost (Claude
   * redraws its own screen). With one, the desktop page's screen as of `seq` (mirror.ts "Seeding"):
   * the terminal starts at the page's size, the seed is written, and it takes the pty's size in the
   * seed's write callback, where `seq` is reported parsed; the items after it follow in the queue.
   * The seed is the page's data, not the program's output: what the terminal would answer while
   * parsing it never reaches the pty (`quiet`).
   */
  private reset(tabId: string, seq: number, cols: number, rows: number, seed?: TerminalScreen): void {
    const old = this.tabs.get(tabId)
    if (old) {
      this.disposeTab(old)
      this.answerSnapshots(tabId, old, null)
    }
    this.tabs.delete(tabId)
    if (!validSize(cols, rows)) return
    if (!seed || typeof seed.data !== 'string' || !validSize(seed.cols, seed.rows) || !(seq >= 1)) {
      this.tabs.set(tabId, this.create(tabId, cols, rows, seq))
      this.post({ t: 'parsed', tabId, seq })
      return
    }
    const t = this.create(tabId, seed.cols, seed.rows, seq - 1)
    t.received = seq
    t.floor = seq
    t.quiet = true
    this.tabs.set(tabId, t)
    t.term.write(seed.data, () => {
      t.quiet = false
      if (!t.disposed && (cols !== t.term.cols || rows !== t.term.rows)) t.term.resize(cols, rows)
      this.parsed(tabId, t, seq)
    })
  }

  private resize(tabId: string, t: TabTerm, seq: number, cols: number, rows: number): void {
    if (!validSize(cols, rows)) return
    t.received = seq
    t.term.write('', () => {
      if (!t.disposed && (cols !== t.term.cols || rows !== t.term.rows)) t.term.resize(cols, rows)
      this.parsed(tabId, t, seq)
    })
  }

  /**
   * The terminal's state once everything posted before this request is parsed: an empty write's
   * callback runs after every chunk queued ahead of it. `null` for an unknown or closed tab.
   */
  private inspect(id: number, tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) {
      this.post({ t: 'inspected', id, state: null })
      return
    }
    t.term.write('', () => {
      if (t.disposed) {
        this.post({ t: 'inspected', id, state: null })
        return
      }
      this.post({
        t: 'inspected',
        id,
        state: { cols: t.term.cols, rows: t.term.rows, data: t.serializer.serialize({ scrollback: this.scrollback }) }
      })
    })
  }

  /**
   * A view joins the tab (mirror.ts `join`): answer with a snapshot taken inside the write callback
   * of some item N at the parser's ground state, tagged N. xterm's `write` is asynchronous, and it
   * runs a chunk's callback right after that chunk is parsed and before the next one is, so the
   * buffer there is exactly items 1..N; serializing anywhere else could miss bytes queued but not
   * parsed yet. Main holds the items after the ones the worker had parsed when it asked, so any N
   * from here on leaves no gap (mirror.ts).
   */
  private requestSnapshot(id: number, tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) {
      this.post({ t: 'snapshot', ids: [id], tabId, snapshot: null })
      return
    }
    t.snaps.push(id)
    // Nothing queued: no callback is coming, so take it now if the parser allows. Between
    // callbacks the buffer is items 1..parsed all the same (xterm parses a chunk whole).
    if (t.parsed === t.received && atGround(t.term)) {
      this.takeSnapshot(tabId, t)
      return
    }
    // Otherwise the first callback at ground takes it (parsed), and the deadline caps the wait.
    if (!t.groundTimer) {
      t.groundTimer = setTimeout(() => {
        t.groundTimer = null
        if (t.disposed || t.snaps.length === 0) return
        // A seed still parsing: taken in its callback, at ground or not (`parsed`).
        if (t.parsed < t.floor) t.overdue = true
        else this.takeSnapshot(tabId, t)
      }, this.groundWaitMs)
      t.groundTimer.unref?.()
    }
  }

  private takeSnapshot(tabId: string, t: TabTerm): void {
    const snapshot: MirrorSnapshot = {
      seq: t.parsed,
      cols: t.term.cols,
      rows: t.term.rows,
      data: t.serializer.serialize({ scrollback: this.scrollback }) + extraModes(t.term)
    }
    this.answerSnapshots(tabId, t, snapshot)
  }

  /** Every waiting request gets this answer; the ground wait ends. */
  private answerSnapshots(tabId: string, t: TabTerm, snapshot: MirrorSnapshot | null): void {
    if (t.groundTimer) {
      clearTimeout(t.groundTimer)
      t.groundTimer = null
    }
    t.overdue = false
    if (t.snaps.length === 0) return
    const ids = t.snaps.splice(0)
    this.post({ t: 'snapshot', ids, tabId, snapshot })
  }

  /** Inside the write callback of item `seq`: the buffer is exactly items 1..seq. */
  private parsed(tabId: string, t: TabTerm, seq: number): void {
    if (t.disposed) return
    t.parsed = seq
    this.post({ t: 'parsed', tabId, seq })
    if (t.snaps.length > 0 && (t.overdue || atGround(t.term))) this.takeSnapshot(tabId, t)
  }

  private create(tabId: string, cols: number, rows: number, seq: number): TabTerm {
    // logLevel off: xterm logs a malformed sequence with console.error, and a worker's console
    // goes to main's stdout; a program printing binary junk must not flood the app's log.
    const term = new Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true, logLevel: 'off' })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    // The desktop uses Unicode 11 widths (terminal-session.ts); a copy with other widths would put
    // wide characters (emoji in Claude's UI) in other cells.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    const t: TabTerm = {
      term,
      serializer,
      disposed: false,
      received: seq,
      parsed: seq,
      snaps: [],
      groundTimer: null,
      floor: 0,
      overdue: false,
      quiet: false
    }
    this.answerQueries(tabId, t)
    return t
  }

  /**
   * The copy answers the program's terminal queries (design-web.md §5.2 "Main answers terminal
   * queries"): xterm's own replies (DSR, DA, DECRQM, XTWINOPS 18; everything its common core
   * answers) come out of `onData`, written during the parse of the chunk that asked, and go to main
   * for the pty. So a query is answered with no view awake (Claude's startup queries no longer wait
   * on a desktop page), and once (the views' own replies are stripped, terminal-reports.ts).
   * Colours are the browser terminal's part in xterm (its theme), absent here: OSC 10/11/12 `?` are
   * passed to main, which answers from the app theme. Both are posted from inside the parse, so they
   * reach main in the order the program asked (a program sending OSC 11 then DA1 as a sentinel
   * gets the colour first). The handlers return false: xterm's own handling (a no-op here) runs too.
   * OSC 4 (palette) queries go unanswered while web access is on (docs/features.md).
   */
  private answerQueries(tabId: string, t: TabTerm): void {
    t.term.onData((data) => {
      if (!t.disposed && !t.quiet) this.post({ t: 'reply', tabId, data })
    })
    for (const ident of [10, 11, 12] as const) {
      t.term.parser.registerOscHandler(ident, (data) => {
        if (t.disposed || t.quiet) return false
        // `OSC 10 ; ? ; ? ST` asks for 10 and then 11: each further `;` field is the next ident.
        const fields = data.split(';')
        for (let i = 0; i < fields.length && ident + i <= 12; i++) {
          if (fields[i] === '?') this.post({ t: 'color', tabId, ident: (ident + i) as OscColorIdent })
        }
        return false
      })
    }
  }

  private disposeTab(t: TabTerm): void {
    if (t.disposed) return
    t.disposed = true
    if (t.groundTimer) {
      clearTimeout(t.groundTimer)
      t.groundTimer = null
    }
    t.term.dispose()
  }
}

// The worker's entry: only in the thread mirror.ts started (vitest may itself run tests in worker
// threads, where parentPort is set too).
const data = workerData as { mark?: unknown; scrollback?: unknown } | null
if (parentPort && data?.mark === WORKER_MARK) {
  const port = parentPort
  const scrollback = Number.isInteger(data.scrollback) ? (data.scrollback as number) : MIRROR_SCROLLBACK
  const terms = new HeadlessTerms((message) => port.postMessage(message), { scrollback })
  port.on('message', (message: ToWorker) => terms.handle(message))
  port.postMessage({ t: 'ready' } satisfies FromWorker)
}
