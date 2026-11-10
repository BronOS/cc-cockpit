// Headless terminals for web access (design-web.md §5.2 "Terminals", §7a), run in a worker thread.
//
// Main keeps a headless copy of every tab's terminal while web access is on, fed the same flushed
// chunks the views get, so a view joining a tab can be given its screen (Task 11). The copies live
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
import { type FromWorker, type MirrorItem, type ToWorker, WORKER_MARK } from './mirror-protocol'

/** Scrollback of a headless copy. The desktop keeps 10,000; the spike measured about 9 MiB per tab at 5,000. */
export const MIRROR_SCROLLBACK = 5000

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

  constructor(
    private readonly post: (message: FromWorker) => void,
    private readonly scrollback = MIRROR_SCROLLBACK
  ) {}

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
        this.reset(message.tabId, message.seq, message.cols, message.rows)
        return
      case 'inspect':
        this.inspect(message.id, message.tabId)
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
          this.tabs.set(tabId, this.create(item.cols, item.rows))
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
        this.post({ t: 'parsed', tabId, seq: item.seq })
        return
    }
  }

  /**
   * After a worker restart (mirror.ts): the tab's terminal starts blank at main's current seq. The
   * content before is lost with the old worker; Claude redraws its own screen, and every view is
   * resynced from here (Task 12).
   */
  private reset(tabId: string, seq: number, cols: number, rows: number): void {
    const old = this.tabs.get(tabId)
    if (old) this.disposeTab(old)
    this.tabs.delete(tabId)
    if (!validSize(cols, rows)) return
    this.tabs.set(tabId, this.create(cols, rows))
    this.post({ t: 'parsed', tabId, seq })
  }

  private resize(tabId: string, t: TabTerm, seq: number, cols: number, rows: number): void {
    if (!validSize(cols, rows)) return
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

  private parsed(tabId: string, t: TabTerm, seq: number): void {
    if (!t.disposed) this.post({ t: 'parsed', tabId, seq })
  }

  private create(cols: number, rows: number): TabTerm {
    // logLevel off: xterm logs a malformed sequence with console.error, and a worker's console
    // goes to main's stdout; a program printing binary junk must not flood the app's log.
    const term = new Terminal({ cols, rows, scrollback: this.scrollback, allowProposedApi: true, logLevel: 'off' })
    const serializer = new SerializeAddon()
    term.loadAddon(serializer)
    // The desktop uses Unicode 11 widths (terminal-session.ts); a copy with other widths would put
    // wide characters (emoji in Claude's UI) in other cells.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    return { term, serializer, disposed: false }
  }

  private disposeTab(t: TabTerm): void {
    if (t.disposed) return
    t.disposed = true
    t.term.dispose()
  }
}

// The worker's entry: only in the thread mirror.ts started (vitest may itself run tests in worker
// threads, where parentPort is set too).
const data = workerData as { mark?: unknown; scrollback?: unknown } | null
if (parentPort && data?.mark === WORKER_MARK) {
  const port = parentPort
  const scrollback = Number.isInteger(data.scrollback) ? (data.scrollback as number) : MIRROR_SCROLLBACK
  const terms = new HeadlessTerms((message) => port.postMessage(message), scrollback)
  port.on('message', (message: ToWorker) => terms.handle(message))
  port.postMessage({ t: 'ready' } satisfies FromWorker)
}
