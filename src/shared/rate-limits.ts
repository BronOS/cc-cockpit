// Usage from Claude Code's status line (`ccc statusline`, design.md "Status line"): the account's
// rate-limit windows, and the session's cost and context fill. Claude Code hands these to the
// status line command only, as JSON on stdin (hooks and transcripts do not carry them); the CLI
// picks the few fields below out of it and main checks them again here before anything is kept.
//
// Pure, no runtime import: the CLI (which must start fast, and never fail) and main both read it.
// What the CLI sends is untrusted to main: the socket token only proves WHICH tab sent it, so
// every number is checked for being finite, clamped, and anything of another shape is dropped.
import type { RateLimits, RateLimitWindow } from '../sdk/types'

/** The status line's own JSON fields this feature reads, by Claude Code's names. */
export interface StatusLineFields {
  rate_limits?: { five_hour?: { used_percentage?: unknown; resets_at?: unknown }; seven_day?: { used_percentage?: unknown; resets_at?: unknown } }
  cost?: { total_cost_usd?: unknown }
  context_window?: { used_percentage?: unknown }
}

/** A session's cost above this (USD) is not a cost Claude reported: it is dropped, not clamped. */
export const MAX_COST_USD = 1_000_000
/** The longest ISO date text read for `resets_at` (a real one is ~25 characters). */
const MAX_DATE_TEXT = 64
/**
 * `resets_at` below this is epoch SECONDS, at or above it epoch MILLISECONDS. 1e11 s is the year
 * 5138 and 1e11 ms is March 1973, so no real reset time falls in the overlap either way.
 */
const SECONDS_BELOW = 1e11
/** The latest instant a Date can hold (ms): a reset time past it is not one. */
const MAX_EPOCH_MS = 8.64e15
/** An ISO 8601 date-time as Claude writes it (`2026-11-08T17:00:00Z`, `...+01:00`, fractions). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/

function objectOf(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** A finite number clamped to 0-100, or undefined for anything else (a string, NaN, Infinity). */
export function percentOf(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  return Math.min(100, Math.max(0, v))
}

/**
 * A reset time as epoch milliseconds (a whole number), or undefined. Claude Code sends epoch
 * seconds today (claude 2.1.319 multiplies `resets_at` by 1000 for its own timers); epoch
 * milliseconds and an ISO 8601 string are accepted too, so a format change does not blank the meter.
 */
export function resetsAtOf(v: unknown): number | undefined {
  let ms: number
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return undefined
    ms = v < SECONDS_BELOW ? v * 1000 : v
  } else if (typeof v === 'string') {
    if (v.length > MAX_DATE_TEXT || !ISO_DATE.test(v)) return undefined
    ms = Date.parse(v)
    if (!Number.isFinite(ms) || ms <= 0) return undefined
  } else {
    return undefined
  }
  if (ms > MAX_EPOCH_MS) return undefined
  return Math.round(ms)
}

/** One window, both fields valid, or undefined: half a window (a percentage with no reset) is dropped. */
function windowOf(v: unknown): RateLimitWindow | undefined {
  const o = objectOf(v)
  if (!o) return undefined
  const usedPercent = percentOf(o.used_percentage)
  const resetsAt = resetsAtOf(o.resets_at)
  if (usedPercent === undefined || resetsAt === undefined) return undefined
  return { usedPercent, resetsAt }
}

/** What one status line report holds once checked; each field absent when it was missing or bad. */
export interface StatusLineReport {
  rateLimits?: { fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow }
  costUsd?: number
  contextPercent?: number
}

/**
 * The checked report of one `statusline` request's args (Claude's own field names, as the CLI
 * picked them). Never throws: a field that is not what it should be is left out, and a report
 * with nothing usable is `{}`.
 */
export function parseStatusLineReport(args: unknown): StatusLineReport {
  const o = objectOf(args)
  if (!o) return {}
  const out: StatusLineReport = {}
  const limits = objectOf(o.rate_limits)
  if (limits) {
    const fiveHour = windowOf(limits.five_hour)
    const sevenDay = windowOf(limits.seven_day)
    if (fiveHour || sevenDay) out.rateLimits = { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
  }
  const cost = objectOf(o.cost)?.total_cost_usd
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 && cost <= MAX_COST_USD) out.costUsd = cost
  const context = percentOf(objectOf(o.context_window)?.used_percentage)
  if (context !== undefined) out.contextPercent = context
  return out
}

/**
 * Only the fields above out of the status line's JSON, each value kept only when it is a number
 * or a short string (main checks them properly): the rest of the payload (the cwd, the transcript
 * path, the model, the session name) never leaves the CLI. Used by `ccc statusline`.
 */
export function pickStatusLineFields(json: unknown): StatusLineFields {
  const o = objectOf(json)
  if (!o) return {}
  const scalar = (v: unknown): unknown =>
    typeof v === 'number' || (typeof v === 'string' && v.length <= MAX_DATE_TEXT) ? v : undefined
  const win = (v: unknown): { used_percentage?: unknown; resets_at?: unknown } | undefined => {
    const w = objectOf(v)
    if (!w) return undefined
    const out: { used_percentage?: unknown; resets_at?: unknown } = {}
    const used = scalar(w.used_percentage)
    const resets = scalar(w.resets_at)
    if (used !== undefined) out.used_percentage = used
    if (resets !== undefined) out.resets_at = resets
    return out
  }
  const out: StatusLineFields = {}
  const limits = objectOf(o.rate_limits)
  if (limits) {
    const fiveHour = win(limits.five_hour)
    const sevenDay = win(limits.seven_day)
    if (fiveHour || sevenDay) out.rate_limits = { ...(fiveHour ? { five_hour: fiveHour } : {}), ...(sevenDay ? { seven_day: sevenDay } : {}) }
  }
  const cost = scalar(objectOf(o.cost)?.total_cost_usd)
  if (cost !== undefined) out.cost = { total_cost_usd: cost }
  const context = scalar(objectOf(o.context_window)?.used_percentage)
  if (context !== undefined) out.context_window = { used_percentage: context }
  return out
}

/** Two windows hold the same numbers (both absent counts as the same). */
function sameWindow(a: RateLimitWindow | undefined, b: RateLimitWindow | undefined): boolean {
  return a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt
}

/** The windows of `a` and `b` are the same; `updatedAt` is not compared (a refresh alone is no change). */
export function sameRateLimits(a: RateLimits | null, b: RateLimits | null): boolean {
  if (a === null || b === null) return a === b
  return sameWindow(a.fiveHour, b.fiveHour) && sameWindow(a.sevenDay, b.sevenDay)
}
