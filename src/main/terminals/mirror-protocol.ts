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

/**
 * What a view joining a tab starts from (Task 11): the headless terminal serialized inside the
 * write callback of item `seq`, at the parser's ground state (or after the ground wait), with the
 * modes the serialize addon drops re-emitted (mirror-worker.ts `extraModes`). The view's live
 * stream starts at `seq + 1`.
 */
export interface MirrorSnapshot extends MirrorState {
  /** The last item the snapshot contains. */
  seq: number
}

/** The colour queries main answers: OSC 10 (foreground), 11 (background), 12 (cursor). */
export type OscColorIdent = 10 | 11 | 12

export type ToWorker =
  | { t: 'item'; tabId: string; item: MirrorItem }
  /** After a worker restart: a blank terminal at this size, whose stream continues after `seq`. */
  | { t: 'reset'; tabId: string; seq: number; cols: number; rows: number }
  /** Answered with `inspected` once everything posted before it is parsed. */
  | { t: 'inspect'; id: number; tabId: string }
  /** Answered with `snapshot` at the first write callback at ground state, or after the ground wait. */
  | { t: 'snapshot'; id: number; tabId: string }

export type FromWorker =
  /** Every item up to `seq` of the tab is applied to its terminal. */
  | { t: 'parsed'; tabId: string; seq: number }
  | { t: 'inspected'; id: number; state: MirrorState | null }
  /** The answer to every `snapshot` request in `ids`; null for a tab the worker does not hold (closed). */
  | { t: 'snapshot'; ids: number[]; tabId: string; snapshot: MirrorSnapshot | null }
  /**
   * The tab's headless terminal answered a query of the program (DSR, DA, DECRQM, XTWINOPS 18 and
   * the like): main writes it to the pty (Task 14, design-web.md §5.2 "Main answers terminal
   * queries"). Posted in stream order with `color`, so a reply never overtakes an earlier one.
   */
  | { t: 'reply'; tabId: string; data: string }
  /**
   * The program asked for a colour (OSC 10 foreground, 11 background, 12 cursor, `?`): the headless
   * terminal has no theme, so main answers it from the app's (mirror.ts `oscColorReply`).
   */
  | { t: 'color'; tabId: string; ident: OscColorIdent }
  | { t: 'log'; message: string }
  /** The worker loaded xterm and listens (logged once per start: a packaged build's proof it runs). */
  | { t: 'ready' }
