'use strict'
// A timezone away from UTC, so "by local day" is really tested (node --test runs each file in its
// own process; set before any Date is made).
process.env.TZ = 'America/New_York'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { Scanner } = require('../dist/lib/scanner')
const store = require('../dist/lib/store')
const view = require('../dist/lib/view')
const f = require('./fixtures')

const NOW = Date.now()
/** Local time `daysAgo` days before today, at `hour`. */
function at(daysAgo, hour = 12, minute = 0) {
  const d = new Date(NOW)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, hour, minute).getTime()
}
const T = store.T

function setup() {
  const config = f.tempConfig()
  const scanner = new Scanner({ roots: [path.join(config, 'projects')], statePath: path.join(config, 'state', 'scan-state.json'), now: () => NOW, pauseMs: 0 })
  return { config, scanner }
}

function day(scanner, daysAgo) {
  return scanner.state.days[store.localDay(at(daysAgo))]
}

function sum(scanner, daysAgo) {
  const b = day(scanner, daysAgo)
  const t = store.zero()
  if (b) for (const v of Object.values(b.cube)) store.addTotals(t, v)
  return t
}

test('a message written as several lines counts once; a copy in another file counts once too', async () => {
  const { config, scanner } = setup()
  const a = f.transcriptPath(config, '-work-alpha', 's1')
  f.append(a, f.assistant({ id: 'm1', req: 'r1', ts: at(0), blocks: 3 }))
  f.append(a, f.assistant({ id: 'm2', req: 'r2', ts: at(0), blocks: 2 }))
  // A forked session repeats m1 with its own timestamp in a new file.
  f.append(f.transcriptPath(config, '-work-alpha', 's2'), f.assistant({ id: 'm1', req: 'r1', ts: at(0), sessionId: 's2' }))
  assert.equal(await scanner.scan(), true)
  const t = sum(scanner, 0)
  assert.equal(t[T.messages], 2)
  assert.equal(t[T.output], 200)
  assert.equal(t[T.cacheRead], 2000)
})

test('later scans read only the appended bytes; an unchanged file is not read', async () => {
  const { config, scanner } = setup()
  const a = f.transcriptPath(config, '-work-alpha', 's1')
  f.append(a, f.assistant({ id: 'm1', req: 'r1', ts: at(0) }))
  await scanner.scan()
  const first = scanner.bytesRead
  assert.equal(first, fs.statSync(a).size)
  assert.equal(await scanner.scan(), false)
  assert.equal(scanner.bytesRead, first, 'unchanged: nothing read')
  const more = f.assistant({ id: 'm2', req: 'r2', ts: at(0) })
  f.append(a, more)
  assert.equal(await scanner.scan(), true)
  assert.equal(scanner.bytesRead - first, Buffer.byteLength(more))
  assert.equal(sum(scanner, 0)[T.messages], 2)
})

test('a partial last line waits for its newline', async () => {
  const { config, scanner } = setup()
  const a = f.transcriptPath(config, '-work-alpha', 's1')
  const line = f.assistant({ id: 'm1', req: 'r1', ts: at(0) })
  f.append(a, line.slice(0, 40))
  assert.equal(await scanner.scan(), false)
  assert.equal(scanner.files[a].offset, 0)
  f.append(a, line.slice(40))
  assert.equal(await scanner.scan(), true)
  assert.equal(sum(scanner, 0)[T.messages], 1)
})

test('a truncated or rewritten file is read again from the start, without double counting', async () => {
  const { config, scanner } = setup()
  const a = f.transcriptPath(config, '-work-alpha', 's1')
  f.append(a, f.assistant({ id: 'm1', req: 'r1', ts: at(0) }) + f.assistant({ id: 'm2', req: 'r2', ts: at(0) }))
  await scanner.scan()
  // Truncated to a shorter file with a new message m3.
  fs.writeFileSync(a, f.assistant({ id: 'm3', req: 'r3', ts: at(0) }))
  assert.equal(await scanner.scan(), true)
  assert.equal(sum(scanner, 0)[T.messages], 3)
  // Rewritten at the same inode, larger, with other head bytes: read from 0 again (m1 not twice).
  const before = scanner.bytesRead
  fs.writeFileSync(a, f.assistant({ id: 'm1', req: 'r1', ts: at(0), model: 'claude-sonnet-4-6' }) + f.assistant({ id: 'm3', req: 'r3', ts: at(0) }) + f.assistant({ id: 'm4', req: 'r4', ts: at(0) }))
  assert.equal(await scanner.scan(), true)
  assert.equal(scanner.bytesRead - before, fs.statSync(a).size)
  assert.equal(sum(scanner, 0)[T.messages], 4)
  // Replaced by another file (another inode) under the same name.
  const tmp = `${a}.new`
  fs.writeFileSync(tmp, f.assistant({ id: 'm5', req: 'r5', ts: at(0) }))
  fs.renameSync(tmp, a)
  assert.equal(await scanner.scan(), true)
  assert.equal(sum(scanner, 0)[T.messages], 5)
})

test('a file last written before the kept days is not read; older messages are dropped', async () => {
  const { config, scanner } = setup()
  const old = f.transcriptPath(config, '-work-alpha', 'old')
  f.append(old, f.assistant({ id: 'o1', req: 'r', ts: at(60) }))
  const t = new Date(at(60))
  fs.utimesSync(old, t, t)
  const mixed = f.transcriptPath(config, '-work-alpha', 'mixed')
  f.append(mixed, f.assistant({ id: 'o2', req: 'r', ts: at(store.RETAIN_DAYS + 3) }) + f.assistant({ id: 'n1', req: 'r', ts: at(1) }))
  await scanner.scan()
  assert.equal(scanner.files[old].offset, fs.statSync(old).size)
  assert.equal(scanner.bytesRead, fs.statSync(mixed).size)
  assert.deepEqual(Object.keys(scanner.state.days), [store.localDay(at(1))])
  // A resumed old session: only the appended part is read.
  const more = f.assistant({ id: 'n2', req: 'r', ts: at(0) })
  f.append(old, more)
  const before = scanner.bytesRead
  await scanner.scan()
  assert.equal(scanner.bytesRead - before, Buffer.byteLength(more))
  assert.equal(sum(scanner, 0)[T.messages], 1)
})

test('the state file lets the next scanner (another window, a restart) carry on', async () => {
  const { config, scanner } = setup()
  const a = f.transcriptPath(config, '-work-alpha', 's1')
  f.append(a, f.userPrompt('Count my tokens') + f.assistant({ id: 'm1', req: 'r1', ts: at(0) }))
  await scanner.scan()
  await scanner.save()
  const more = f.assistant({ id: 'm2', req: 'r2', ts: at(0) })
  f.append(a, more)
  const next = new Scanner({ roots: scanner.roots, statePath: scanner.statePath, now: () => NOW, pauseMs: 0 })
  await next.scan()
  assert.equal(next.bytesRead, Buffer.byteLength(more))
  assert.equal(sum(next, 0)[T.messages], 2)
  assert.equal(next.state.meta.s1.title, 'Count my tokens')
  // A broken state file is a fresh start, not a crash.
  fs.writeFileSync(scanner.statePath, '{"version":1,')
  const fresh = new Scanner({ roots: scanner.roots, statePath: scanner.statePath, now: () => NOW, pauseMs: 0 })
  await fresh.scan()
  assert.equal(sum(fresh, 0)[T.messages], 2)
})

test('aggregates by local day, project, model and session; subagents count under their session', async () => {
  const { config, scanner } = setup()
  const a = f.transcriptPath(config, '-work-alpha', 's1')
  f.append(a, f.userPrompt('Ship the release', { sessionId: 's1' }))
  // 23:30 and 00:30 local: two days, whatever UTC says.
  f.append(a, f.assistant({ id: 'm1', req: 'r', ts: at(1, 23, 30), u: { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0 } }))
  f.append(a, f.assistant({ id: 'm2', req: 'r', ts: at(0, 0, 30), model: 'claude-sonnet-4-6', u: { input_tokens: 0, output_tokens: 1e6, cache_read_input_tokens: 0 } }))
  f.append(f.transcriptPath(config, '-work-alpha', 's1', 'x1'), f.assistant({ id: 'm3', req: 'r', ts: at(0, 9), sidechain: true, model: 'claude-haiku-4-5', u: { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1e6 } } }))
  f.append(f.transcriptPath(config, '-work-beta', 's2'), f.assistant({ id: 'm4', req: 'r', ts: at(0, 10), sessionId: 's2', cwd: '/work/beta', model: '<synthetic>', u: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0 } }))
  await scanner.scan()

  assert.equal(sum(scanner, 1)[T.cost], 4) // Opus 5.5 input
  const today = sum(scanner, 0)
  assert.ok(Math.abs(today[T.cost] - (15 + 1 + 2)) < 1e-9) // Sonnet 4.6 output, Haiku 4.5 input + 1h write
  assert.equal(today[T.unpriced], 1)
  assert.equal(today[T.unpricedTokens], 10)
  assert.equal(today[T.cache1h], 1e6)

  const agg = scanner.snapshot()
  const week = view.summarize(agg, { days: 7, now: NOW })
  assert.deepEqual(
    week.projects.map((p) => [p.name, Math.round(p.t[T.cost])]),
    [
      ['alpha', 22],
      ['beta', 0]
    ]
  )
  assert.deepEqual(
    week.models.map((m) => m.model),
    ['claude-sonnet-4-6', 'claude-opus-5-5', 'claude-haiku-4-5', '<synthetic>']
  )
  assert.deepEqual(
    week.sessions.map((s) => [s.id, s.title, s.t[T.messages]]),
    [
      ['s1', 'Ship the release', 3],
      ['s2', 's2', 1]
    ]
  )
  const todayOnly = view.summarize(agg, { days: 1, now: NOW })
  assert.equal(todayOnly.totals[T.messages], 3)
  // This project only: beta's work is left out of every list.
  const alpha = view.summarize(agg, { days: 7, now: NOW, onlyDir: '/work/alpha' })
  assert.deepEqual(
    alpha.projects.map((p) => p.name),
    ['alpha']
  )
  assert.deepEqual(
    alpha.sessions.map((s) => s.id),
    ['s1']
  )
})

test('the shared snapshot fits appStorage: sessions are cut first, the cube never', () => {
  const state = store.emptyState()
  for (let i = 0; i < 400; i++) {
    store.addMessage(state, { key: `k${i}`, model: 'claude-opus-5-5', ts: at(0), cwd: '/work/alpha', usage: { input_tokens: i + 1 } }, `session-${i}`, NOW)
    store.setTitle(state, `session-${i}`, 'x'.repeat(80))
  }
  const full = store.snapshot(state, NOW, 1000)
  const size = Buffer.byteLength(JSON.stringify(full))
  const fitted = store.fittedSnapshot(state, NOW, Math.floor(size / 2))
  const d = fitted.days[store.localDay(at(0))]
  assert.ok(d.sessions.length < 400 && d.sessions.length > 0)
  assert.equal(d.sessions[0][0], 'session-399', 'the most expensive first')
  assert.equal(d.cube.length, 1)
  assert.equal(d.cube[0][2][T.messages], 400)
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= size / 2)
  assert.equal(Object.keys(fitted.meta).length, d.sessions.length)
})

test('prune drops days and keys past the window and the meta no day uses', () => {
  const state = store.emptyState()
  store.addMessage(state, { key: 'a', model: 'm', ts: at(1), usage: {} }, 'keep', NOW)
  store.addMessage(state, { key: 'b', model: 'm', ts: at(2), usage: {} }, 'gone', NOW)
  // Two days on, the window has moved past day 2 only when RETAIN_DAYS is small: move "now" instead.
  const later = at(-(store.RETAIN_DAYS - 2))
  store.prune(state, later)
  assert.deepEqual(Object.keys(state.days), [store.localDay(at(1))])
  assert.deepEqual(Object.keys(state.keys), [store.localDay(at(1))])
  assert.deepEqual(Object.keys(state.meta), ['keep'])
  // JSON round trip keeps everything.
  const back = store.fromJSON(JSON.parse(JSON.stringify(store.toJSON(state))))
  assert.deepEqual(back.days, state.days)
  assert.ok(back.keys[store.localDay(at(1))].has(store.hashKey('a')))
})
