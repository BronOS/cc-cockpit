// The person's Claude plan usage, app-wide (ctx.sessions.rateLimits, design.md "Status line"): the
// latest rate-limit windows any Claude tab's status line reported (`ccc statusline`, checked by
// shared/rate-limits.ts parseStatusLineReport before it gets here). One account per app, so one
// value: every tab of every window reports the same windows, and the newest report wins.
//
// In memory only: the windows move every few minutes and a stale copy from the last run would be
// shown as current; the first status line after a start fills it again.
//
// Listeners (one per plugin host, HostApi) hear a change at most once per `intervalMs`, leading
// and trailing: the status line runs after every assistant message in every tab, and a host
// should not be woken for each. A report that only refreshes `updatedAt` is no change.
//
// No Electron import.
import { errorText } from '../../shared/error-text'
import { sameRateLimits } from '../../shared/rate-limits'
import type { RateLimits, RateLimitWindow } from '../../sdk/types'

/** At most one change event per this many ms. */
export const RATE_LIMITS_EVENT_INTERVAL_MS = 2_000

export interface RateLimitsStoreOptions {
  intervalMs?: number
  /** The clock (tests). */
  now?: () => number
  log?: (message: string) => void
}

export class RateLimitsStore {
  private latest: RateLimits | null = null
  private readonly listeners = new Set<(rateLimits: RateLimits) => void>()
  private readonly interval: number
  private readonly now: () => number
  private readonly log: (message: string) => void
  private lastSent = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RateLimitsStoreOptions = {}) {
    this.interval = options.intervalMs ?? RATE_LIMITS_EVENT_INTERVAL_MS
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((m) => console.warn(m))
  }

  /** The latest windows, or null before the first report. A copy: callers cannot change the store. */
  get(): RateLimits | null {
    return this.latest === null ? null : copyOf(this.latest)
  }

  /**
   * A tab reported its windows. `updatedAt` is main's clock at arrival, never a time the CLI sent:
   * reports reach main in the order the status lines ran (the server serves them as they come), so
   * the newest is the last one. A window the report lacks keeps its last value (a tab of an older
   * Claude Code that sends only the 5-hour window does not blank the 7-day one), unless its reset
   * has passed: Claude Code stops sending a window then, and its old percent is no longer true. A
   * report with no window at all changes nothing (readers skip an expired window themselves).
   */
  report(windows: { fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow }): void {
    if (!windows.fiveHour && !windows.sevenDay) return
    const prev = this.latest
    const now = this.now()
    const kept = (w: RateLimitWindow | undefined): RateLimitWindow | undefined => (w && w.resetsAt > now ? w : undefined)
    const fiveHour = windows.fiveHour ?? kept(prev?.fiveHour)
    const sevenDay = windows.sevenDay ?? kept(prev?.sevenDay)
    const next: RateLimits = {
      ...(fiveHour ? { fiveHour: { ...fiveHour } } : {}),
      ...(sevenDay ? { sevenDay: { ...sevenDay } } : {}),
      // Never back in time, even when the system clock is set back: `updatedAt` only says "seen at".
      updatedAt: Math.max(now, prev?.updatedAt ?? 0)
    }
    this.latest = next
    if (!sameRateLimits(prev, next)) this.markDirty()
  }

  /** Hear each change (throttled); returns the unsubscribe. */
  onChange(listener: (rateLimits: RateLimits) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Cancel a pending event (app quit). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.listeners.clear()
  }

  private markDirty(): void {
    if (this.timer !== undefined) return
    const wait = this.lastSent + this.interval - this.now()
    if (wait <= 0) {
      this.flush()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, wait)
    this.timer.unref?.()
  }

  /** The value at send time, so a burst inside the interval goes out as its last state. */
  private flush(): void {
    this.lastSent = this.now()
    const value = this.latest
    if (value === null) return
    for (const listener of [...this.listeners]) {
      try {
        listener(copyOf(value))
      } catch (err) {
        this.log(`rate limits: a listener threw: ${errorText(err)}`)
      }
    }
  }
}

function copyOf(r: RateLimits): RateLimits {
  return {
    ...(r.fiveHour ? { fiveHour: { ...r.fiveHour } } : {}),
    ...(r.sevenDay ? { sevenDay: { ...r.sevenDay } } : {}),
    updatedAt: r.updatedAt
  }
}
