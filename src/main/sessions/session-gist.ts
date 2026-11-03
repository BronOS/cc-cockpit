// The session gist (app setting `sessionGist`, off by default): after a Claude tab's turn ends, a
// one-line summary of what the session is about, written by Claude Haiku from the tab's last few
// prompts (status-reducer.ts `recentPrompts`) and stored on the entry as `gist`. The Sessions panel
// shows it under the tab's name in place of the last prompt.
//
// It spends the person's Claude usage without them typing anything, so every run is bounded:
//  - only after a turn ends (the entry moves to `waiting`), and only when the prompts changed since
//    the tab's last run: a turn that answered a permission prompt or a notification costs nothing;
//  - one run per tab at a time (a turn ending meanwhile is coalesced into one rerun after it);
//  - at least `minGapMs` between two runs' starts for a tab (a burst of short turns is one rerun
//    at the end of the gap, with the newest prompts);
//  - at most `maxConcurrent` runs app-wide; the rest wait in arrival order;
//  - each run has its own timeout (gist-run.ts); a failure is logged and nothing else: the panel
//    keeps showing the last prompt (or the last gist), and the same prompts are not tried again.
// Off: every pending and running run is cancelled and every gist removed. On: the tabs waiting for
// input now get one, through the same limits.
//
// main is the only authority: nothing here takes input from a renderer or a plugin; the prompts
// come from main's own entries.
import { errorText } from '../../shared/error-text'
import type { SessionChange, SessionRegistry } from './session-registry'

export const GIST_MIN_GAP_MS = 60_000
export const GIST_MAX_CONCURRENT = 2

export interface SessionGistOptions {
  /** The app setting, read at each decision. */
  enabled(): boolean
  sessions: Pick<SessionRegistry, 'get' | 'list' | 'setGist' | 'onChange'>
  /** Write the gist for these prompts (runGist with main's env); rejects on any failure. */
  run(prompts: readonly string[], signal: AbortSignal): Promise<string>
  minGapMs?: number
  maxConcurrent?: number
  now?: () => number
  log?: (message: string) => void
}

interface TabState {
  /** The prompts (joined) the last run started with; the same prompts are never run twice. */
  lastInput?: string
  lastStart: number
  running?: AbortController
  /** A turn ended while running: look again when it finishes. */
  again: boolean
  /** The rerun at the end of the minimum gap. */
  timer?: ReturnType<typeof setTimeout>
}

export class SessionGist {
  private readonly states = new Map<string, TabState>()
  /** Tabs ready to run but over the app-wide limit, in arrival order. */
  private readonly waiting = new Set<string>()
  private running = 0
  private readonly minGap: number
  private readonly maxConcurrent: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private readonly unsubscribe: () => void

  constructor(private readonly options: SessionGistOptions) {
    this.minGap = options.minGapMs ?? GIST_MIN_GAP_MS
    this.maxConcurrent = options.maxConcurrent ?? GIST_MAX_CONCURRENT
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((m) => console.warn(m))
    this.unsubscribe = options.sessions.onChange((change) => this.onChange(change))
  }

  /** The setting flipped (Settings › Appearance and keys). */
  settingChanged(): void {
    if (this.options.enabled()) {
      for (const entry of this.options.sessions.list()) if (entry.status === 'waiting') this.request(entry.tabId)
      return
    }
    this.cancelAll()
    for (const entry of this.options.sessions.list()) {
      if (entry.gist !== undefined) this.options.sessions.setGist(entry.tabId, undefined)
    }
  }

  /** App quit: cancel everything and stop listening. */
  dispose(): void {
    this.unsubscribe()
    this.cancelAll()
  }

  private onChange(change: SessionChange): void {
    if (change.entry === undefined) {
      this.forget(change.tabId)
      return
    }
    // A turn ended. Only the move INTO waiting: the gist's own setGist (and a title change) keep
    // the status and must not ask for another gist.
    if (change.entry.status === 'waiting' && change.prev?.status !== 'waiting') this.request(change.tabId)
  }

  private request(tabId: string): void {
    if (!this.options.enabled()) return
    const prompts = this.options.sessions.get(tabId)?.recentPrompts ?? []
    if (prompts.length === 0) return
    let state = this.states.get(tabId)
    if (state === undefined) {
      state = { lastStart: -Infinity, again: false }
      this.states.set(tabId, state)
    }
    if (state.running) {
      state.again = true
      return
    }
    if (state.timer !== undefined || this.waiting.has(tabId)) return // already coming
    const input = prompts.join('\n\u0000')
    if (input === state.lastInput) return
    const wait = state.lastStart + this.minGap - this.now()
    if (wait > 0) {
      const timer = setTimeout(() => {
        if (state.timer !== timer) return
        state.timer = undefined
        this.request(tabId)
      }, wait)
      timer.unref?.()
      state.timer = timer
      return
    }
    if (this.running >= this.maxConcurrent) {
      this.waiting.add(tabId)
      return
    }
    this.start(tabId, state, prompts, input)
  }

  private start(tabId: string, state: TabState, prompts: readonly string[], input: string): void {
    const controller = new AbortController()
    state.running = controller
    state.lastStart = this.now()
    state.lastInput = input
    this.running++
    // Copied: the run reads them after this returns, and the entry may move on meanwhile.
    this.options
      .run([...prompts], controller.signal)
      .then((gist) => {
        // Not for a tab that closed, a setting turned off or a run cancelled meanwhile.
        if (controller.signal.aborted || this.states.get(tabId) !== state || !this.options.enabled()) return
        this.options.sessions.setGist(tabId, gist)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) this.log(`session ${tabId}: gist failed: ${errorText(err)}`)
      })
      .finally(() => {
        this.running--
        if (state.running === controller) state.running = undefined
        if (this.states.get(tabId) === state && state.again) {
          state.again = false
          this.request(tabId)
        }
        this.drain()
      })
  }

  /** Start waiting tabs while there is room. */
  private drain(): void {
    for (const tabId of [...this.waiting]) {
      if (this.running >= this.maxConcurrent) return
      this.waiting.delete(tabId)
      this.request(tabId)
    }
  }

  private forget(tabId: string): void {
    const state = this.states.get(tabId)
    this.waiting.delete(tabId)
    if (state === undefined) return
    this.states.delete(tabId)
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.running?.abort()
  }

  private cancelAll(): void {
    for (const tabId of [...this.states.keys()]) this.forget(tabId)
    this.waiting.clear()
  }
}
