// Keep the computer awake while Claude works (app setting `keepAwake`, on by default; design.md §3
// "Keep awake"): one power hold (power-holds.ts) while at least one Claude tab of any window is
// `working`, released a while after the last one stops. Plain TypeScript over the session registry and
// the holds, so vitest runs it with a fake backend.
//
// Decisions:
//  - One registry serves every window, so `list()` is every tab of every project: a tab working in
//    another window keeps the computer up as well as one in this window. There is one hold, never one
//    per tab: Electron would stack blockers, and a per-tab release could race the next tab's start.
//  - Recomputed from `list()` on every change, never counted from transitions: the registry also emits
//    changes whose entry did not move (projectChanged, prev === entry) and a closed tab arrives with
//    `entry: undefined`, so a counter would drift and hold the computer up for good.
//  - Only `working` counts. `needs-permission` (a permission prompt or a dialog tool such as
//    AskUserQuestion) does not: the turn is stopped on the person, nothing runs that a sleep would cut
//    off, and the prompt is still there when the computer wakes. Counting it would keep an unattended
//    computer up all night for a prompt nobody answers. The release delay covers a prompt answered
//    within it; a prompt answered from a phone through web access needs the host awake, which is server
//    mode's own whole-run hold (macOS, docs/plans/20261119-server-mode-mac.md decision 4), not this one.
//    `waiting`, `idle`, `starting` and `ended` are not work either.
//  - The release waits KEEP_AWAKE_RELEASE_MS after the last `working` tab leaves it. Between tools a tab
//    stays `working` (status-reducer.ts: PreToolUse and PostToolUse both keep it), so the gaps that would
//    churn the hold are between turns: the send gate delivering a queued text right after a Stop, a
//    room's pointer, a person's quick follow-up, a short permission prompt. A minute is short next to any
//    OS idle-sleep timer, so holding it that long costs nothing. Any change while the timer runs leaves it
//    alone (only a tab working again cancels it), so title or gist changes cannot keep pushing it out.
//  - Known gap: a turn the person interrupts (Esc) fires no Stop hook (Claude Code skips Stop on a user
//    interrupt), so the tab stays `working` until its next prompt, exit or close, and the hold with it.
//    No inactivity cap: a long tool call (a 2-hour test run) is just as silent, and it is the case this
//    exists for. Documented in docs/features.md, Known limitations.
//  - Turning the setting off releases at once; turning it on with a tab working holds at once
//    (settingChanged). Reading `enabled()` at every change means a hand edit of app.json is seen on the
//    next change.
import type { TabStatus } from '../../shared/ipc'
import type { PowerHold } from './power-holds'

/** How long the hold outlives the last working tab (see the header). */
export const KEEP_AWAKE_RELEASE_MS = 60_000

/** The owner name of this module's hold (PowerHolds.owners). */
export const KEEP_AWAKE_OWNER = 'claude-working'

/**
 * The stored `keepAwake`, default applied: only an explicit `false` turns it off. A damaged value (the
 * file is user-writable) reads as on: the person asked for this on by default, and a wrong "on" costs a
 * computer that stays up while Claude works, a wrong "off" a long task cut off by sleep.
 */
export function keepAwakeOf(stored: unknown): boolean {
  return stored !== false
}

export interface KeepAwakeOptions {
  /** The session registry (one for all windows). */
  sessions: {
    list(): ReadonlyArray<{ readonly status: TabStatus }>
    onChange(listener: () => void): () => void
  }
  /** Where the hold comes from (PowerHolds). */
  holds: { hold(owner: string): PowerHold }
  /** The setting, default applied, read at every change. */
  enabled(): boolean
  /** Tests shorten it. */
  releaseMs?: number
}

export class KeepAwake {
  private hold: PowerHold | undefined
  private releaseTimer: ReturnType<typeof setTimeout> | undefined
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly options: KeepAwakeOptions) {
    this.unsubscribe = options.sessions.onChange(() => this.update())
    // Tabs restored before this was made (none today, but the order in main may change) count at once.
    this.update()
  }

  /** The setting changed: off releases at once, on with a tab working holds at once. */
  settingChanged(): void {
    this.update()
  }

  /** Whether the hold is live now (tests, logs). */
  held(): boolean {
    return this.hold !== undefined
  }

  /** At quit: stop listening and release (the process exit would end the blocker anyway). */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.releaseNow()
  }

  private wanted(): boolean {
    return this.options.enabled() && this.options.sessions.list().some((e) => e.status === 'working')
  }

  private update(): void {
    if (this.disposed) return
    if (this.wanted()) {
      this.clearTimer()
      this.hold ??= this.options.holds.hold(KEEP_AWAKE_OWNER)
      return
    }
    if (this.hold === undefined) return
    if (!this.options.enabled()) {
      this.releaseNow()
      return
    }
    // Not reset by later changes: the delay counts from when the last tab stopped working.
    this.releaseTimer ??= setTimeout(() => {
      this.releaseTimer = undefined
      if (!this.disposed && !this.wanted()) this.releaseNow()
    }, this.options.releaseMs ?? KEEP_AWAKE_RELEASE_MS)
  }

  private releaseNow(): void {
    this.clearTimer()
    const hold = this.hold
    this.hold = undefined
    hold?.release()
  }

  private clearTimer(): void {
    if (this.releaseTimer === undefined) return
    clearTimeout(this.releaseTimer)
    this.releaseTimer = undefined
  }
}
