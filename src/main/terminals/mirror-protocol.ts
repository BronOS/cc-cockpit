// What main (mirror.ts) and the headless-terminal worker (mirror-worker.ts) post each other
// (design-web.md §5.2). Kept apart from both so neither bundle pulls in the other: main must not
// load the xterm packages, the worker must not load main code.

/** Marks the worker main started (workerData), so importing the worker file anywhere else starts nothing. */
export const WORKER_MARK = 'cc-cockpit.terminal-mirror'

/**
 * One item of a tab's terminal stream. Every item is numbered, output and size changes alike: a
 * resize has to land at the same point of the stream in every copy (the headless one and each
 * view's) or the lines after it wrap differently (§7a).
 * - `spawn`: the tab's process started at this size; the first item of a tab, and again on a
 *   restart (the content stays, as on the desktop);
 * - `data`: one flushed PTY chunk, the same string the views get (`tabs.data`);
 * - `resize`: the pty took this size;
 * - `close`: the tab is gone; the last item.
 */
export type MirrorItem =
  | { seq: number; kind: 'spawn'; cols: number; rows: number }
  | { seq: number; kind: 'data'; data: string }
  | { seq: number; kind: 'resize'; cols: number; rows: number }
  | { seq: number; kind: 'close' }

/** A headless terminal's state as the worker reports it on request. */
export interface MirrorState {
  cols: number
  rows: number
  /** The serialize addon's output (screen and scrollback). */
  data: string
}

export type ToWorker =
  | { t: 'item'; tabId: string; item: MirrorItem }
  /** After a worker restart: a blank terminal at this size, whose stream continues after `seq`. */
  | { t: 'reset'; tabId: string; seq: number; cols: number; rows: number }
  /** Answered with `inspected` once everything posted before it is parsed. */
  | { t: 'inspect'; id: number; tabId: string }

export type FromWorker =
  /** Every item up to `seq` of the tab is applied to its terminal. */
  | { t: 'parsed'; tabId: string; seq: number }
  | { t: 'inspected'; id: number; state: MirrorState | null }
  | { t: 'log'; message: string }
  /** The worker loaded xterm and listens (logged once per start: a packaged build's proof it runs). */
  | { t: 'ready' }
