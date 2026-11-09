'use strict'
// The usage aggregate: what every scanned message adds up to, bucketed by local day. Pure data, no
// I/O (scanner.js reads and saves it), so the sums, the dedupe and the trimming run under node:test.
//
// Shape (plain JSON, saved as is in the scan state file):
//   days[YYYY-MM-DD]  { cube: { "<cwd>\u0000<model>": T }, sessions: { <sessionId>: T } }
//   keys[YYYY-MM-DD]  message keys seen that day (Set in memory, array on disk)
//   meta[sessionId]   { cwd, title? }
// where T is a totals array (TOTALS below). The cube is project x model, so totals, the by-project and
// the by-model lists all come from it, with or without a "this project only" filter.
//
// A message's key is kept under its own day: a session forked or copied into a new file repeats old
// messages with their old timestamps, so they land on the day that already has the key. Days older
// than RETAIN_DAYS are dropped with their keys; a rescan of an old file then adds nothing, because
// a message that old is dropped before it is counted.
const nodeCrypto = require('node:crypto')
const { tokensOf, costOf } = require('./prices')

/** Days kept: 30 for the longest range, plus today and one for a clock or timezone wobble. */
const RETAIN_DAYS = 32

/** Totals array slots. */
const T = { cost: 0, input: 1, output: 2, cacheRead: 3, cache5m: 4, cache1h: 5, messages: 6, unpriced: 7, unpricedTokens: 8 }
const T_LEN = 9

function zero() {
  return new Array(T_LEN).fill(0)
}

/** `into += add`, slot by slot. */
function addTotals(into, add) {
  for (let i = 0; i < T_LEN; i++) into[i] += add[i] || 0
  return into
}

/** The local calendar day of `ms` as YYYY-MM-DD (the host's timezone: every window shares it). */
function localDay(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The local day `n` days before the day of `ms`. Calendar arithmetic, so a DST change is no hour off. */
function dayBefore(ms, n) {
  const d = new Date(ms)
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12).getTime())
}

function emptyState() {
  return { v: 1, days: {}, keys: {}, meta: {} }
}

/** Short and fixed-length: 100k message keys of ~60 characters would be 6 MB in the state file. */
function hashKey(key) {
  return nodeCrypto.createHash('sha1').update(key).digest('base64').slice(0, 14)
}

/**
 * Count one parsed message (transcripts.parseUsageLine) for `sessionId`. Returns false when it was
 * already counted or is older than the kept days. `cwd` falls back to `fallbackCwd` (the encoded
 * folder) when the line has none.
 */
function addMessage(state, msg, sessionId, now, fallbackCwd) {
  const day = localDay(msg.ts)
  if (day < dayBefore(now, RETAIN_DAYS - 1)) return false
  if (msg.key) {
    let seen = state.keys[day]
    if (!seen) seen = state.keys[day] = new Set()
    const h = hashKey(msg.key)
    if (seen.has(h)) return false
    seen.add(h)
  }
  const t = tokensOf(msg.usage)
  const cost = costOf(msg.model, t)
  const row = zero()
  row[T.input] = t.input
  row[T.output] = t.output
  row[T.cacheRead] = t.cacheRead
  row[T.cache5m] = t.cache5m
  row[T.cache1h] = t.cache1h
  row[T.messages] = 1
  if (cost === null) {
    row[T.unpriced] = 1
    row[T.unpricedTokens] = t.input + t.output + t.cacheRead + t.cache5m + t.cache1h
  } else row[T.cost] = cost
  const cwd = msg.cwd || fallbackCwd || ''
  let bucket = state.days[day]
  if (!bucket) bucket = state.days[day] = { cube: {}, sessions: {} }
  const cell = `${cwd}\u0000${msg.model}`
  addTotals(bucket.cube[cell] || (bucket.cube[cell] = zero()), row)
  addTotals(bucket.sessions[sessionId] || (bucket.sessions[sessionId] = zero()), row)
  if (!state.meta[sessionId]) state.meta[sessionId] = { cwd }
  else if (!state.meta[sessionId].cwd && cwd) state.meta[sessionId].cwd = cwd
  return true
}

function setTitle(state, sessionId, title) {
  if (!title) return
  const m = state.meta[sessionId] || (state.meta[sessionId] = { cwd: '' })
  if (!m.title) m.title = title
}

/** Drop days (and their keys) before the kept window, and the meta of sessions no day mentions. */
function prune(state, now) {
  const cutoff = dayBefore(now, RETAIN_DAYS - 1)
  for (const d of Object.keys(state.days)) if (d < cutoff) delete state.days[d]
  for (const d of Object.keys(state.keys)) if (d < cutoff) delete state.keys[d]
  const used = new Set()
  for (const b of Object.values(state.days)) for (const s of Object.keys(b.sessions)) used.add(s)
  for (const s of Object.keys(state.meta)) if (!used.has(s)) delete state.meta[s]
}

/** The state as JSON-ready data (Sets as arrays), and back. A malformed file gives an empty state. */
function toJSON(state) {
  const keys = {}
  for (const [d, set] of Object.entries(state.keys)) keys[d] = [...set]
  return { v: 1, days: state.days, keys, meta: state.meta }
}

function fromJSON(raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return state
  const okTotals = (t) => Array.isArray(t) && t.length === T_LEN && t.every((n) => typeof n === 'number' && Number.isFinite(n))
  for (const [d, b] of Object.entries(raw.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !b || typeof b !== 'object') continue
    const bucket = { cube: {}, sessions: {} }
    for (const [k, t] of Object.entries(b.cube || {})) if (okTotals(t)) bucket.cube[k] = t
    for (const [k, t] of Object.entries(b.sessions || {})) if (okTotals(t)) bucket.sessions[k] = t
    state.days[d] = bucket
  }
  for (const [d, list] of Object.entries(raw.keys || {})) {
    if (Array.isArray(list)) state.keys[d] = new Set(list.filter((k) => typeof k === 'string'))
  }
  for (const [s, m] of Object.entries(raw.meta || {})) {
    if (!m || typeof m !== 'object') continue
    state.meta[s] = { cwd: typeof m.cwd === 'string' ? m.cwd : '' }
    if (typeof m.title === 'string' && m.title) state.meta[s].title = m.title.slice(0, 200)
  }
  return state
}

/**
 * The aggregate other windows read (through ctx.appStorage, one value of at most 1 MiB less 8 KiB):
 * the days without the keys, sessions per day cut to the most expensive `perDay` (the totals and the
 * lists by project and model come from the cube, which is never cut, so only "top sessions" can miss
 * a session's cheapest days). Costs rounded to a millionth of a dollar.
 *
 *   { v: 1, at, days: { D: { cube: [[cwd, model, T]], sessions: [[sessionId, T]] } }, meta: { sid: [cwd, title?] } }
 */
function snapshot(state, at, perDay) {
  const round = (t) => t.map((n, i) => (i === T.cost ? Math.round(n * 1e6) / 1e6 : n))
  const days = {}
  const metaUsed = new Set()
  for (const [d, b] of Object.entries(state.days)) {
    const cube = Object.entries(b.cube).map(([k, t]) => {
      const i = k.indexOf('\u0000')
      return [k.slice(0, i), k.slice(i + 1), round(t)]
    })
    const sessions = Object.entries(b.sessions)
      .sort((a, b2) => b2[1][T.cost] - a[1][T.cost] || tokens(b2[1]) - tokens(a[1]))
      .slice(0, perDay)
      .map(([s, t]) => {
        metaUsed.add(s)
        return [s, round(t)]
      })
    days[d] = { cube, sessions }
  }
  const meta = {}
  for (const s of metaUsed) {
    const m = state.meta[s] || { cwd: '' }
    meta[s] = m.title ? [m.cwd, m.title] : [m.cwd]
  }
  return { v: 1, at, days, meta }
}

function tokens(t) {
  return t[T.input] + t[T.output] + t[T.cacheRead] + t[T.cache5m] + t[T.cache1h]
}

/** appStorage's value cap (1 MiB less 8 KiB) with room to spare for the JSON framing around it. */
const SHARE_MAX_BYTES = 1024 * 1024 - 8 * 1024 - 16 * 1024

/** `snapshot` cut down until it fits SHARE_MAX_BYTES, or null when even a bare one does not. */
function fittedSnapshot(state, at, max = SHARE_MAX_BYTES) {
  for (const perDay of [60, 30, 15, 5, 0]) {
    const snap = snapshot(state, at, perDay)
    if (Buffer.byteLength(JSON.stringify(snap)) <= max) return snap
  }
  return null
}

module.exports = {
  RETAIN_DAYS,
  T,
  T_LEN,
  SHARE_MAX_BYTES,
  zero,
  addTotals,
  localDay,
  dayBefore,
  emptyState,
  hashKey,
  addMessage,
  setTitle,
  prune,
  toJSON,
  fromJSON,
  snapshot,
  fittedSnapshot,
  tokens
}
