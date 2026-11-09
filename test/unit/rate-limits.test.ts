// The usage a Claude tab's status line reports (design.md "Status line"): main's check and
// normalisation of what `ccc statusline` forwarded (shared/rate-limits.ts), the CLI's pick of the
// fields it forwards, the app-wide store and its event throttle (RateLimitsStore), and the
// `statusline` socket handler (a Claude tab only, dropped while the setting is off).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RATE_LIMITS_EVENT_INTERVAL_MS, RateLimitsStore } from '../../src/main/sessions/rate-limits-store'
import { statusLineHandler } from '../../src/main/sessions/statusline-handler'
import type { Caller } from '../../src/main/socket/socket-server'
import { MAX_COST_USD, parseStatusLineReport, percentOf, pickStatusLineFields, resetsAtOf, sameRateLimits } from '../../src/shared/rate-limits'
import type { RateLimits } from '../../src/sdk/types'

const SECONDS = 1_762_600_000
const MS = SECONDS * 1000

describe('percentOf', () => {
  it('keeps a finite number, clamped to 0-100', () => {
    expect(percentOf(12.5)).toBe(12.5)
    expect(percentOf(0)).toBe(0)
    expect(percentOf(140)).toBe(100)
    expect(percentOf(-3)).toBe(0)
  })

  it('drops anything else', () => {
    for (const bad of [NaN, Infinity, -Infinity, '50', null, undefined, {}, [50], true]) expect(percentOf(bad), String(bad)).toBeUndefined()
  })
})

describe('resetsAtOf', () => {
  it('reads epoch seconds (what Claude Code sends) as milliseconds', () => {
    expect(resetsAtOf(SECONDS)).toBe(MS)
    expect(resetsAtOf(SECONDS + 0.4)).toBe(MS + 400)
  })

  it('keeps epoch milliseconds as they are, rounded to a whole number', () => {
    expect(resetsAtOf(MS)).toBe(MS)
    expect(resetsAtOf(MS + 0.6)).toBe(MS + 1)
  })

  it('reads an ISO 8601 date-time', () => {
    expect(resetsAtOf('2026-11-08T17:00:00Z')).toBe(Date.parse('2026-11-08T17:00:00Z'))
    expect(resetsAtOf('2026-11-08T17:00:00.250+01:00')).toBe(Date.parse('2026-11-08T17:00:00.250+01:00'))
    expect(resetsAtOf('2026-11-08T17:00Z')).toBe(Date.parse('2026-11-08T17:00Z'))
  })

  it('drops anything else: not finite, not positive, out of range, not an ISO date, too long', () => {
    for (const bad of [NaN, Infinity, 0, -5, 9e15, '1762600000', 'tomorrow', '2026-11-08', '2026-13-45T99:99:99Z', `2026-11-08T17:00:00Z${' '.repeat(80)}`, null, {}, true]) {
      expect(resetsAtOf(bad), String(bad)).toBeUndefined()
    }
  })
})

describe('parseStatusLineReport', () => {
  it('keeps both windows, the cost and the context fill', () => {
    expect(
      parseStatusLineReport({
        rate_limits: { five_hour: { used_percentage: 12.5, resets_at: SECONDS }, seven_day: { used_percentage: 61, resets_at: '2026-11-12T00:00:00Z' } },
        cost: { total_cost_usd: 1.25 },
        context_window: { used_percentage: 42 }
      })
    ).toEqual({
      rateLimits: { fiveHour: { usedPercent: 12.5, resetsAt: MS }, sevenDay: { usedPercent: 61, resetsAt: Date.parse('2026-11-12T00:00:00Z') } },
      costUsd: 1.25,
      contextPercent: 42
    })
  })

  it('clamps the percentages', () => {
    const r = parseStatusLineReport({ rate_limits: { five_hour: { used_percentage: 250, resets_at: SECONDS } }, context_window: { used_percentage: -1 } })
    expect(r).toEqual({ rateLimits: { fiveHour: { usedPercent: 100, resetsAt: MS } }, contextPercent: 0 })
  })

  it('drops a window that lacks either field, or has a bad one', () => {
    expect(parseStatusLineReport({ rate_limits: { five_hour: { used_percentage: 10 }, seven_day: { resets_at: SECONDS } } })).toEqual({})
    expect(parseStatusLineReport({ rate_limits: { five_hour: { used_percentage: '10', resets_at: SECONDS }, seven_day: { used_percentage: 5, resets_at: SECONDS } } })).toEqual({
      rateLimits: { sevenDay: { usedPercent: 5, resetsAt: MS } }
    })
  })

  it('drops a cost that is negative, not finite or absurd', () => {
    for (const bad of [-1, NaN, Infinity, MAX_COST_USD + 1, '3']) expect(parseStatusLineReport({ cost: { total_cost_usd: bad } }), String(bad)).toEqual({})
    expect(parseStatusLineReport({ cost: { total_cost_usd: 0 } })).toEqual({ costUsd: 0 })
  })

  it('never throws, whatever it is given', () => {
    for (const junk of [null, undefined, 5, 'x', [], { rate_limits: [] }, { rate_limits: { five_hour: 'x' } }, { cost: null }, { context_window: 7 }]) {
      expect(parseStatusLineReport(junk)).toEqual({})
    }
  })
})

describe('pickStatusLineFields (what the CLI forwards)', () => {
  it('keeps only the usage fields', () => {
    expect(
      pickStatusLineFields({
        session_id: 'abc',
        cwd: '/secret/path',
        transcript_path: '/x.jsonl',
        model: { id: 'claude' },
        rate_limits: { five_hour: { used_percentage: 1, resets_at: 2, extra: 'no' }, seven_day: { used_percentage: 3, resets_at: '2026-11-08T00:00:00Z' }, spend_limit: {} },
        cost: { total_cost_usd: 0.5, total_duration_ms: 9 },
        context_window: { used_percentage: 7, total_input_tokens: 100 }
      })
    ).toEqual({
      rate_limits: { five_hour: { used_percentage: 1, resets_at: 2 }, seven_day: { used_percentage: 3, resets_at: '2026-11-08T00:00:00Z' } },
      cost: { total_cost_usd: 0.5 },
      context_window: { used_percentage: 7 }
    })
  })

  it('drops values that are objects, or strings too long to be a date', () => {
    expect(pickStatusLineFields({ cost: { total_cost_usd: { a: 1 } }, context_window: { used_percentage: 'x'.repeat(100) } })).toEqual({})
    expect(pickStatusLineFields(null)).toEqual({})
    expect(pickStatusLineFields([1])).toEqual({})
  })
})

describe('sameRateLimits', () => {
  it('compares the windows and ignores updatedAt', () => {
    const a: RateLimits = { fiveHour: { usedPercent: 1, resetsAt: 2 }, updatedAt: 1 }
    expect(sameRateLimits(a, { ...a, updatedAt: 99 })).toBe(true)
    expect(sameRateLimits(a, { fiveHour: { usedPercent: 2, resetsAt: 2 }, updatedAt: 1 })).toBe(false)
    expect(sameRateLimits(a, { ...a, sevenDay: { usedPercent: 1, resetsAt: 2 } })).toBe(false)
    expect(sameRateLimits(null, null)).toBe(true)
    expect(sameRateLimits(a, null)).toBe(false)
  })
})

describe('RateLimitsStore', () => {
  let now: number
  beforeEach(() => {
    vi.useFakeTimers()
    now = 1_000_000
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const store = (): RateLimitsStore => new RateLimitsStore({ now: () => now, log: () => {} })
  const five = (usedPercent: number) => ({ usedPercent, resetsAt: MS })

  it('is null before the first report and keeps the latest, stamped with main\'s clock', () => {
    const s = store()
    expect(s.get()).toBeNull()
    s.report({ fiveHour: five(10) })
    expect(s.get()).toEqual({ fiveHour: five(10), updatedAt: now })
    now += 500
    s.report({ fiveHour: five(11), sevenDay: { usedPercent: 50, resetsAt: MS + 1 } })
    expect(s.get()).toEqual({ fiveHour: five(11), sevenDay: { usedPercent: 50, resetsAt: MS + 1 }, updatedAt: now })
  })

  it('keeps a window the report lacks, and ignores a report with none', () => {
    const s = store()
    s.report({ fiveHour: five(10), sevenDay: { usedPercent: 50, resetsAt: MS } })
    s.report({ fiveHour: five(12) })
    expect(s.get()?.sevenDay).toEqual({ usedPercent: 50, resetsAt: MS })
    const before = s.get()
    now += 1000
    s.report({})
    expect(s.get()).toEqual(before)
  })

  it('never moves updatedAt back when the clock is set back', () => {
    const s = store()
    s.report({ fiveHour: five(10) })
    now -= 60_000
    s.report({ fiveHour: five(11) })
    expect(s.get()?.updatedAt).toBe(1_000_000)
  })

  it('hands out copies: a caller cannot change the stored value', () => {
    const s = store()
    s.report({ fiveHour: five(10) })
    const got = s.get() as { fiveHour: { usedPercent: number } }
    got.fiveHour.usedPercent = 99
    expect(s.get()?.fiveHour?.usedPercent).toBe(10)
  })

  it('tells listeners at once, then at most once per interval with the latest value', () => {
    const s = store()
    const heard: RateLimits[] = []
    s.onChange((r) => heard.push(r))
    s.report({ fiveHour: five(10) })
    expect(heard.map((r) => r.fiveHour?.usedPercent)).toEqual([10])
    now += 100
    s.report({ fiveHour: five(11) })
    now += 100
    s.report({ fiveHour: five(12) })
    expect(heard).toHaveLength(1)
    now += RATE_LIMITS_EVENT_INTERVAL_MS
    vi.advanceTimersByTime(RATE_LIMITS_EVENT_INTERVAL_MS)
    expect(heard.map((r) => r.fiveHour?.usedPercent)).toEqual([10, 12])
    expect(RATE_LIMITS_EVENT_INTERVAL_MS).toBe(2000)
  })

  it('sends no event for a report with the same numbers (a refresh only)', () => {
    const s = store()
    const heard: RateLimits[] = []
    s.onChange((r) => heard.push(r))
    s.report({ fiveHour: five(10) })
    now += 5000
    s.report({ fiveHour: five(10) })
    vi.advanceTimersByTime(10_000)
    expect(heard).toHaveLength(1)
    // The value itself is refreshed.
    expect(s.get()?.updatedAt).toBe(now)
  })

  it('keeps going when a listener throws, and stops after unsubscribe and dispose', () => {
    const s = store()
    const heard: number[] = []
    s.onChange(() => {
      throw new Error('boom')
    })
    const off = s.onChange((r) => heard.push(r.fiveHour?.usedPercent ?? -1))
    s.report({ fiveHour: five(10) })
    expect(heard).toEqual([10])
    off()
    now += 5000
    s.report({ fiveHour: five(20) })
    expect(heard).toEqual([10])
    s.onChange((r) => heard.push(r.fiveHour?.usedPercent ?? -1))
    now += 100
    s.report({ fiveHour: five(30) })
    s.dispose()
    vi.advanceTimersByTime(10_000)
    expect(heard).toEqual([10])
  })
})

describe('the statusline socket handler', () => {
  const session: Caller = { kind: 'session', tabId: 't1', projectId: 'p' }
  function rig(enabled = true) {
    const usage: { tabId: string; usage: unknown }[] = []
    const reports: unknown[] = []
    const handler = statusLineHandler({
      registry: {
        setUsage: (tabId, u) => {
          usage.push({ tabId, usage: u })
          return true
        }
      },
      rateLimits: { report: (r) => void reports.push(r) },
      enabled: () => enabled
    })
    return { handler, usage, reports }
  }
  const args = {
    rate_limits: { five_hour: { used_percentage: 10, resets_at: SECONDS } },
    cost: { total_cost_usd: 2 },
    context_window: { used_percentage: 30 },
    // A tab id in the payload is ignored: main resolved the caller's tab from the token.
    tabId: 'someone-else'
  }

  it("stores the windows app-wide and the cost and context on the caller's own tab", () => {
    const r = rig()
    expect(r.handler(args, session)).toBeNull()
    expect(r.reports).toEqual([{ fiveHour: { usedPercent: 10, resetsAt: MS } }])
    expect(r.usage).toEqual([{ tabId: 't1', usage: { costUsd: 2, contextPercent: 30 } }])
  })

  it('sets nothing for a report with nothing valid', () => {
    const r = rig()
    r.handler({ rate_limits: { five_hour: { used_percentage: 'x' } }, cost: { total_cost_usd: -1 } }, session)
    expect(r.reports).toEqual([])
    expect(r.usage).toEqual([])
  })

  it('refuses every caller but a Claude tab', () => {
    const r = rig()
    for (const caller of [{ kind: 'window', projectId: 'p' }, { kind: 'project', path: '/p', projectId: 'p' }, { kind: 'anonymous' }] as Caller[]) {
      expect(() => r.handler(args, caller)).toThrow('Claude session')
    }
    expect(r.reports).toEqual([])
  })

  it('drops the report while the setting is off', () => {
    const r = rig(false)
    expect(r.handler(args, session)).toBeNull()
    expect(r.reports).toEqual([])
    expect(r.usage).toEqual([])
  })
})
