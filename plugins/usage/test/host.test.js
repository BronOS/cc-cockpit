'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const host = require('../dist/host')
const f = require('./fixtures')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** ctx.appStorage as main keeps it: one store shared by every host. */
function fakeAppStorage() {
  const m = new Map()
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    set: async (k, v) => void m.set(k, structuredClone(v)),
    delete: async (k) => void m.delete(k),
    keys: async () => [...m.keys()],
    increment: async (k, by = 1) => {
      const v = (m.get(k) || 0) + by
      m.set(k, v)
      return v
    }
  }
}

/**
 * A fake ctx with only what the host uses, every call recorded. `rateLimits`: give the host core's
 * rate-limit API (absent: an app without it). `own`: this window's Claude tabs.
 */
function fakeCtx({ appStorage, appDataDir, projectDir = '/work/alpha', app = {}, own = [], rateLimits } = {}) {
  const calls = []
  const listeners = { panel: [], action: [], sessions: [], slot: [], rateLimits: [], settings: [] }
  const ctx = {
    projectDir,
    appDataDir,
    appStorage,
    settings: { app },
    log: { info() {}, warn: (m) => calls.push(['warn', m]), error() {} },
    panels: {
      post: (panel, m) => calls.push(['post', panel, m]),
      header: (panel, h) => calls.push(['header', panel, h]),
      show: (panel) => calls.push(['show', panel]),
      onMessage: (panel, fn) => (listeners.panel.push(fn), () => {}),
      onAction: (panel, fn) => (listeners.action.push(fn), () => {})
    },
    sessions: {
      list: async () => own,
      onChange: (fn) => (listeners.sessions.push(fn), () => {}),
      focus: async (tabId) => (calls.push(['focus', tabId]), true)
    },
    slots: {
      onOpen: (type, fn) => {
        assert.equal(type, 'usage-meter')
        listeners.slot.push(fn)
        return () => {}
      }
    },
    schedule: () => () => {},
    onSettingsChange: (fn) => (listeners.settings.push(fn), () => {})
  }
  if (rateLimits !== undefined) {
    ctx.sessions.rateLimits = async () => rateLimits
    ctx.sessions.onRateLimits = (fn) => (listeners.rateLimits.push(fn), () => {})
  }
  return { ctx, calls, listeners }
}

function fakeSlot() {
  const posts = []
  let onMessage = null
  return {
    posts,
    send: (m) => onMessage(m),
    slot: { id: 'm1', type: 'usage-meter', post: (m) => posts.push(m), onMessage: (fn) => (onMessage = fn), onClose: () => {} }
  }
}

const lastPost = (calls) => calls.filter((c) => c[0] === 'post').at(-1)[2]

function world() {
  const config = f.tempConfig()
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-appdata-'))
  const appStorage = fakeAppStorage()
  const now = Date.now()
  f.append(f.transcriptPath(config, '-work-alpha', 's1'), f.userPrompt('Ship it', { sessionId: 's1' }) + f.assistant({ id: 'm1', req: 'r1', ts: now, u: { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0 } }))
  f.append(f.transcriptPath(config, '-work-beta', 's2'), f.assistant({ id: 'm2', req: 'r2', ts: now, sessionId: 's2', cwd: '/work/beta', u: { input_tokens: 0, output_tokens: 1e5, cache_read_input_tokens: 0 } }))
  return { config, appDataDir, appStorage, env: { CLAUDE_CONFIG_DIR: config } }
}

test('one window scans and publishes; a second window reuses it without reading a transcript', async () => {
  const w = world()
  const a = fakeCtx({ appStorage: w.appStorage, appDataDir: w.appDataDir, rateLimits: { fiveHour: { usedPercent: 85, resetsAt: Date.now() + 3600e3 }, updatedAt: Date.now() } })
  const ha = host.start(a.ctx, { env: w.env, hostId: 'a', tick: false, pauseMs: 0 })
  await ha.ready
  await ha.tick()
  await ha.idle()
  assert.equal(ha.share.leader, true)
  assert.ok(ha.scanner.bytesRead > 0)
  assert.ok(fs.existsSync(path.join(w.appDataDir, 'scan-state.json')), 'offsets saved for the next leader')
  const panel = lastPost(a.calls)
  assert.equal(panel.ready, true)
  // Opus 5.5 input $4 + Opus 5.5 output 0.1M x $20 = $2.
  assert.ok(Math.abs(panel.ranges.today.totals[0] - 6) < 1e-9)
  assert.deepEqual(
    panel.ranges.today.sessions.map((s) => [s.id, s.title]),
    [
      ['s1', 'Ship it'],
      ['s2', 's2']
    ]
  )
  assert.equal(panel.rateLimits.rows[0].percent, 85)
  assert.match(a.calls.filter((c) => c[0] === 'header').at(-1)[2].meta, /^API-equivalent · updated/)

  const b = fakeCtx({ appStorage: w.appStorage, appDataDir: w.appDataDir, projectDir: '/work/beta', app: { projects: 'project' } })
  const hb = host.start(b.ctx, { env: w.env, hostId: 'b', tick: false, pauseMs: 0 })
  await hb.ready
  await hb.tick()
  await hb.idle()
  assert.equal(hb.share.leader, false)
  assert.equal(hb.scanner.bytesRead, 0, 'the follower read no transcript')
  assert.equal(hb.scanner.loaded, false)
  const pb = lastPost(b.calls)
  assert.equal(pb.scope, 'project')
  assert.deepEqual(
    pb.ranges.today.projects.map((p) => p.name),
    ['beta']
  )
  assert.equal(pb.rateLimitsAvailable, false)
  assert.equal(pb.rateLimits, null)

  // The meter in B: this project's spend only, no 5-hour part without core's rate limits.
  const s = fakeSlot()
  b.listeners.slot[0](s.slot)
  assert.equal(s.posts.at(-1).meter.text, '$2.00 today')
  s.send({ type: 'open' })
  assert.deepEqual(b.calls.at(-1), ['show', 'usage'])

  // The meter in A: all projects, the 5-hour window over the 80% default.
  const sa = fakeSlot()
  a.listeners.slot[0](sa.slot)
  assert.deepEqual(sa.posts.at(-1).meter.five, { percent: 85, warn: true, text: '5h 85%' })
  a.listeners.rateLimits[0]({ fiveHour: { usedPercent: 20 } })
  assert.deepEqual(sa.posts.at(-1).meter.five, { percent: 20, warn: false, text: '5h 20%' })

  // New lines: the leader's next pass reads only them, and B picks the new aggregate up.
  f.append(f.transcriptPath(w.config, '-work-beta', 's2'), f.assistant({ id: 'm3', req: 'r3', ts: Date.now(), sessionId: 's2', cwd: '/work/beta', u: { input_tokens: 0, output_tokens: 1e5, cache_read_input_tokens: 0 } }))
  ha.scanNow()
  await ha.idle()
  await hb.tick()
  assert.equal(lastPost(b.calls).ranges.today.totals[0], 4)

  // A closes: B takes the lease over and carries on from A's saved offsets.
  await ha.stop()
  await hb.tick()
  await hb.idle()
  assert.equal(hb.share.leader, true)
  assert.equal(hb.scanner.bytesRead, 0, 'nothing new to read: offsets came from the state file')
  await hb.stop()
})

test('a session click selects its tab only when this window has it; a turn end asks for a scan', async () => {
  const w = world()
  const own = [{ tabId: 't1', sessionId: 's1', status: 'working' }]
  const a = fakeCtx({ appStorage: w.appStorage, appDataDir: w.appDataDir })
  const ha = host.start(a.ctx, { env: w.env, hostId: 'a', tick: false, pauseMs: 0 })
  const b = fakeCtx({ appStorage: w.appStorage, appDataDir: w.appDataDir, own })
  const hb = host.start(b.ctx, { env: w.env, hostId: 'b', tick: false, pauseMs: 0, debounceMs: 1 })
  await Promise.all([ha.ready, hb.ready])
  await ha.tick()
  await ha.idle()
  await hb.tick()
  await sleep(5)
  assert.deepEqual(lastPost(b.calls).open, ['s1'])

  const panel = b.listeners.panel[0]
  await panel({ type: 'focus', sessionId: 's1' })
  await panel({ type: 'focus', sessionId: 's2' })
  await panel({ type: 'focus', sessionId: { x: 1 } })
  assert.deepEqual(
    b.calls.filter((c) => c[0] === 'focus'),
    [['focus', 't1']]
  )

  // B's tab ends its turn: B (a follower) pokes, A's next tick scans.
  b.listeners.sessions[0]([{ tabId: 't1', sessionId: 's1', status: 'waiting' }])
  await sleep(20)
  const before = ha.scanner.bytesRead
  f.append(f.transcriptPath(w.config, '-work-alpha', 's1'), f.assistant({ id: 'm9', req: 'r9', ts: Date.now() }))
  await ha.tick()
  await ha.idle()
  assert.ok(ha.scanner.bytesRead > before, 'the poke made the leader scan before its interval')
  await ha.stop()
  await hb.stop()
})

test('activate and deactivate through the plugin entry points', async () => {
  const w = world()
  const a = fakeCtx({ appStorage: w.appStorage, appDataDir: w.appDataDir })
  const saved = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = w.config
  try {
    host.activate(a.ctx)
    await sleep(50)
    await host.deactivate()
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = saved
  }
  assert.equal(a.calls.filter((c) => c[0] === 'warn').length, 0, JSON.stringify(a.calls.filter((c) => c[0] === 'warn')))
  assert.equal(w.appStorage.m.get('lease').owner, null, 'released on deactivate')
})
