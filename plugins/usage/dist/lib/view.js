'use strict'
// The pure part of the Usage plugin's UI: what the panel and the top-bar meter show, from the shared
// aggregate (store.snapshot) and core's rate limits. No DOM, no ctx, no require, so it runs under
// node:test, in the host (require) and in both pages (a classic <script src="/dist/lib/view.js">
// that sets the global `ccUsageView`).
//
// Every amount is "API-equivalent": what Anthropic's API would bill for the tokens. A subscription is
// not billed per token; the pages say so next to the money.
;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ccUsageView = api
})(typeof globalThis === 'object' ? globalThis : this, function () {
  /** Totals array slots (store.js T: kept equal by a test). */
  const T = { cost: 0, input: 1, output: 2, cacheRead: 3, cache5m: 4, cache1h: 5, messages: 6, unpriced: 7, unpricedTokens: 8 }
  const T_LEN = 9

  const RANGES = [
    { id: 'today', label: 'Today', days: 1 },
    { id: '7d', label: '7 days', days: 7 },
    { id: '30d', label: '30 days', days: 30 }
  ]

  /** Settings (plugin.json): ranges and defaults. */
  const WARN_AT = { min: 1, max: 100, default: 80 }
  const RESCAN = { min: 15, max: 3600, default: 60 }

  function intSetting(v, spec) {
    return Number.isInteger(v) && v >= spec.min && v <= spec.max ? v : spec.default
  }

  function zero() {
    return new Array(T_LEN).fill(0)
  }
  function add(into, t) {
    for (let i = 0; i < T_LEN; i++) into[i] += typeof t[i] === 'number' && Number.isFinite(t[i]) ? t[i] : 0
    return into
  }
  function tokens(t) {
    return t[T.input] + t[T.output] + t[T.cacheRead] + t[T.cache5m] + t[T.cache1h]
  }

  function localDay(ms) {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  /** The local days of a range ending today: today first. */
  function rangeDays(days, now) {
    const d = new Date(now)
    const out = []
    for (let i = 0; i < days; i++) out.push(localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i, 12).getTime()))
    return out
  }

  /** `cwd` is `dir` or inside it (either separator). */
  function inside(cwd, dir) {
    if (typeof cwd !== 'string' || typeof dir !== 'string' || !dir) return false
    if (cwd === dir) return true
    const base = dir.replace(/[\\/]+$/, '')
    return cwd.startsWith(base + '/') || cwd.startsWith(base + '\\')
  }

  /** The last part of a path, for a project's name. */
  function baseName(p) {
    if (typeof p !== 'string' || !p) return 'unknown'
    const parts = p.split(/[\\/]+/).filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : p
  }

  /** A friendlier model name: `claude-opus-5-5` -> `Opus 5.5`; anything else as is. */
  function modelLabel(model) {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model || '')
    if (!m) return model || 'unknown'
    return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  }

  /**
   * Totals and lists for one range. `agg` is the shared snapshot; `onlyDir` (a project folder) keeps
   * only the work whose cwd is in it; `top` caps the session list.
   * Returns { totals, projects: [{cwd, name, t}], models: [{model, label, t}], sessions: [{id, title, cwd, name, t}] }.
   */
  function summarize(agg, { days, now, onlyDir = null, top = 10 }) {
    const totals = zero()
    const projects = new Map()
    const models = new Map()
    const sessions = new Map()
    const meta = (agg && agg.meta) || {}
    for (const d of rangeDays(days, now)) {
      const b = agg && agg.days && agg.days[d]
      if (!b) continue
      for (const row of Array.isArray(b.cube) ? b.cube : []) {
        if (!Array.isArray(row) || row.length !== 3) continue
        const [cwd, model, t] = row
        if (onlyDir && !inside(cwd, onlyDir)) continue
        add(totals, t)
        add(projects.get(cwd) || (projects.set(cwd, zero()), projects.get(cwd)), t)
        add(models.get(model) || (models.set(model, zero()), models.get(model)), t)
      }
      for (const row of Array.isArray(b.sessions) ? b.sessions : []) {
        if (!Array.isArray(row) || row.length !== 2) continue
        const [id, t] = row
        const m = Array.isArray(meta[id]) ? meta[id] : []
        if (onlyDir && !inside(m[0], onlyDir)) continue
        add(sessions.get(id) || (sessions.set(id, zero()), sessions.get(id)), t)
      }
    }
    const byCost = (a, b) => b.t[T.cost] - a.t[T.cost] || tokens(b.t) - tokens(a.t)
    return {
      totals,
      projects: [...projects].map(([cwd, t]) => ({ cwd, name: baseName(cwd), t })).sort(byCost),
      models: [...models].map(([model, t]) => ({ model, label: modelLabel(model), t })).sort(byCost),
      sessions: [...sessions]
        .map(([id, t]) => {
          const m = Array.isArray(meta[id]) ? meta[id] : []
          return { id, title: typeof m[1] === 'string' && m[1] ? m[1] : id, cwd: m[0] || '', name: baseName(m[0]), t }
        })
        .sort(byCost)
        .slice(0, top)
    }
  }

  /** `$4.20`; under a cent but not zero `<$0.01`; from $1000 no cents. */
  function money(n) {
    if (!(n > 0)) return '$0.00'
    if (n < 0.01) return '<$0.01'
    if (n >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
    return `$${n.toFixed(2)}`
  }

  /** `950`, `12.3K`, `4.5M`, `1.2B`. */
  function count(n) {
    if (!(n > 0)) return '0'
    const units = [
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K']
    ]
    for (const [v, u] of units) {
      if (n >= v) {
        const x = n / v
        return `${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, '')}${u}`
      }
    }
    return String(Math.round(n))
  }

  /** A range's cost as text: `$4.20`, `$4.20 + unpriced` when some messages had no price. */
  function costText(t) {
    return t[T.unpriced] > 0 ? `${money(t[T.cost])}+` : money(t[T.cost])
  }

  function clampPercent(v) {
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined
  }

  /**
   * Core's rate limits (ctx.sessions.rateLimits) as rows, or null when there are none. A window with
   * no number is left out; resetsAt is epoch ms.
   */
  function rateLimitsView(rl, now, warnAt) {
    if (!rl || typeof rl !== 'object') return null
    const rows = []
    for (const [key, label, short] of [
      ['fiveHour', '5-hour window', '5h'],
      ['sevenDay', '7-day window', '7d']
    ]) {
      const w = rl[key]
      if (!w || typeof w !== 'object') continue
      const percent = clampPercent(w.usedPercent)
      if (percent === undefined) continue
      const row = { key, label, short, percent: Math.round(percent), warn: percent >= warnAt }
      if (typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt)) row.resets = resetText(w.resetsAt, now)
      rows.push(row)
    }
    if (rows.length === 0) return null
    const out = { rows }
    if (typeof rl.updatedAt === 'number' && Number.isFinite(rl.updatedAt)) out.updated = ago(rl.updatedAt, now)
    return out
  }

  function hm(ms) {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  /** `resets 14:05` today, `resets in 3 days` later, `resets now` once past. */
  function resetText(at, now) {
    if (at <= now) return 'resets now'
    if (localDay(at) === localDay(now)) return `resets ${hm(at)}`
    const days = Math.round((at - now) / 864e5)
    if (days <= 1) return `resets tomorrow ${hm(at)}`
    return `resets in ${days} days`
  }

  /** `just now`, `3 min ago`, `2 h ago`. */
  function ago(at, now) {
    const s = Math.max(0, Math.round((now - at) / 1000))
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`
    return `${Math.floor(s / 86400)} d ago`
  }

  /**
   * The top-bar meter: `$4.20 today` and, when core knows it, the 5-hour window (`5h 42%`, a bar,
   * `warn` at the setting's threshold). Null until the first aggregate (the meter draws nothing).
   */
  function meterView(agg, { now, onlyDir = null, rateLimits = null, warnAt = WARN_AT.default }) {
    if (!agg) return null
    const today = summarize(agg, { days: 1, now, onlyDir, top: 0 }).totals
    const meter = {
      text: `${costText(today)} today`,
      tooltip: `API-equivalent spend today${onlyDir ? ' in this project' : ''}: ${money(today[T.cost])} for ${count(tokens(today))} tokens`
    }
    if (today[T.unpriced] > 0) meter.tooltip += `\n${count(today[T.unpricedTokens])} tokens of models with no known price are not in it`
    meter.tooltip += '\nSubscriptions are not billed per token. Click for the Usage panel.'
    const rl = rateLimitsView(rateLimits, now, warnAt)
    const five = rl && rl.rows.find((r) => r.key === 'fiveHour')
    if (five) {
      meter.five = { percent: five.percent, warn: five.warn, text: `5h ${five.percent}%` }
      meter.tooltip += `\n5-hour window: ${five.percent}% used${five.resets ? `, ${five.resets}` : ''}`
    }
    return meter
  }

  return { T, T_LEN, RANGES, WARN_AT, RESCAN, intSetting, rangeDays, inside, baseName, modelLabel, summarize, money, count, costText, tokens, rateLimitsView, resetText, ago, meterView }
})
