// `ctx.schedule(seconds, fn)` (design §5): a repeating job with no overlap and a per-run timeout.
//
//  - No overlap: a tick that finds the previous run still going is skipped (a slow API must not
//    stack up requests).
//  - Timeout (default 60 s): plugin code cannot be cancelled, so a run that exceeds it is
//    ABANDONED, not killed: the error is reported and the next tick may start a new run. The
//    alternative (keep skipping until the old run settles) would let one hung request stop the
//    schedule for good; the price is that a zombie run may still be going when the next one starts.
//  - Errors (a throw, a rejection or the timeout) are logged and reported as an error state that
//    main shows as the ⚠ on the plugin's panel icons; the first success after it clears it. Only
//    transitions are reported, so a job failing every 5 s does not message main every 5 s.
//  - The first run is one interval after the call, not at once: the plugin decides whether it wants
//    an immediate run (call fn itself), and activate() has not finished when `schedule` is called.
//  - Every schedule is cleared on dispose (deactivate, a failed activate).
import type { Disposer } from '../../sdk/types'
import { errorText } from '../../shared/error-text'

export const DEFAULT_RUN_TIMEOUT_MS = 60_000
/** setInterval cannot count past 2^31-1 ms (~24.8 days) and fires at once beyond it. */
export const MAX_SCHEDULE_SECONDS = 24 * 60 * 60
export const MIN_SCHEDULE_SECONDS = 1

export interface SchedulerOptions {
  runTimeoutMs?: number
  log: (message: string) => void
  /** Error text when a job starts failing; undefined when it works again. */
  report: (error: string | undefined) => void
}

export interface Scheduler {
  schedule(seconds: number, fn: () => unknown): Disposer
  /** Clear every schedule; later `schedule` calls throw. */
  dispose(): void
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS
  const timers = new Set<ReturnType<typeof setInterval>>()
  /** Jobs whose last run failed; the panel error clears when this is empty again. */
  const failing = new Set<number>()
  let nextJob = 1
  let disposed = false

  const schedule = (seconds: number, fn: () => unknown): Disposer => {
    if (disposed) throw new Error('the plugin is deactivated')
    if (typeof fn !== 'function') throw new TypeError('schedule needs a function')
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new TypeError('schedule: seconds must be a number')
    const clamped = Math.min(MAX_SCHEDULE_SECONDS, Math.max(MIN_SCHEDULE_SECONDS, seconds))
    const job = nextJob++
    let running = false
    let stopped = false

    const fail = (message: string): void => {
      options.log(`scheduled job ${job}: ${message}`)
      const first = failing.size === 0
      failing.add(job)
      if (first) options.report(message)
    }
    const succeed = (): void => {
      if (failing.delete(job) && failing.size === 0) options.report(undefined)
    }

    const tick = (): void => {
      if (running || stopped) return
      running = true
      // Set by whichever of "settled" and "timed out" comes first; the other is then ignored.
      let done = false
      const finish = (error: string | undefined): void => {
        if (done) return
        done = true
        running = false
        clearTimeout(timer)
        if (stopped || disposed) return
        if (error === undefined) succeed()
        else fail(error)
      }
      const timer = setTimeout(() => {
        finish(`run did not finish within ${Math.round(runTimeoutMs / 1000)} s (abandoned)`)
      }, runTimeoutMs)
      // Through a then: a synchronous throw in fn is a failed run like a rejection.
      Promise.resolve()
        .then(fn)
        .then(
          () => finish(undefined),
          (err: unknown) => finish(`run failed: ${errorText(err)}`)
        )
    }

    const handle = setInterval(tick, clamped * 1000)
    timers.add(handle)
    return () => {
      // After dispose too: the plugin's own deactivate, or an activate that settles after its
      // timeout, may call it. Reporting "recovered" then would have main turn a plugin whose
      // activate failed back into an active one and clear its ⚠.
      if (stopped || disposed) return
      stopped = true
      clearInterval(handle)
      timers.delete(handle)
      // A job that is gone no longer fails; without this the ⚠ would outlive its cause.
      if (failing.delete(job) && failing.size === 0) options.report(undefined)
    }
  }

  return {
    schedule,
    dispose: () => {
      disposed = true
      for (const t of timers) clearInterval(t)
      timers.clear()
      failing.clear()
    }
  }
}
