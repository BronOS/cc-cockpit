'use strict'
// Usage for cc-cockpit: Claude Code spend and tokens, computed from Claude Code's own transcripts
// (~/.claude/projects, or $CLAUDE_CONFIG_DIR), plus core's rate-limit windows. Public plugin API only.
//
// - Slot `usage-meter` (an app slot in the top bar, next to the sessions strip): `$4.20 today` and the
//   5-hour window's percent with a bar, in the warning colour from the warn setting. A click shows
//   the Usage panel.
// - Panel `usage` (right zone): Today / 7 days / 30 days, totals, by project, by model, the top
//   sessions (a session whose tab is open in this window selects it), the rate-limit windows.
//
// Every window runs its own host, so the work is shared (lib/share.js): one host holds a lease in
// ctx.appStorage and scans (lib/scanner.js: incremental, a CPU budget, its offsets saved in
// ctx.appDataDir so a new leader or the next app start carries on); it publishes the aggregate to
// ctx.appStorage, and the other hosts only read that when its version moves. Cost per follower: one
// small appStorage read every TICK_S. Money is "API-equivalent" (lib/prices.js): a subscription is
// not billed per token.
const nodeCrypto = require('node:crypto')
const path = require('node:path')
const { Scanner } = require('./lib/scanner')
const { Share } = require('./lib/share')
const transcripts = require('./lib/transcripts')
const view = require('./lib/view')
const prices = require('./lib/prices')

const PANEL = 'usage'
const METER = 'usage-meter'
/** The coordination tick: lease, pokes, a follower's look at the published version. */
const TICK_S = 5
/** During a long first pass, a partial aggregate is published at most this often. */
const PARTIAL_PUBLISH_MS = 5000
/** A turn's end is followed by a scan after this (the transcript's last lines land just after Stop). */
const TURN_DEBOUNCE_MS = 2000
/** Without core's onRateLimits event, rateLimits() is asked this often. */
const RATE_LIMITS_POLL_MS = 30000

let current = null

/**
 * Wire the plugin to `ctx`. `opts` is for tests: `env` (where the transcripts are), `hostId`,
 * `tick` false to drive ticks by hand, `debounceMs` for a turn's end, `budgetBytes` / `pauseMs` for
 * the scanner.
 * Returns a handle with `tick()`, `scanNow()`, `idle()` and `stop()`.
 */
function start(ctx, opts = {}) {
  const env = opts.env || process.env
  const hostId = opts.hostId || nodeCrypto.randomUUID()
  const disposers = []
  let stopped = false

  const app = () => ctx.settings.app || {}
  const warnAt = () => view.intSetting(app().warnAt, view.WARN_AT)
  const rescanMs = () => view.intSetting(app().rescanSeconds, view.RESCAN) * 1000
  const onlyDir = () => (app().projects === 'project' ? ctx.projectDir : null)

  const scanner = new Scanner({
    roots: transcripts.projectRoots(env),
    statePath: path.join(ctx.appDataDir, 'scan-state.json'),
    log: ctx.log,
    ...(opts.budgetBytes ? { budgetBytes: opts.budgetBytes } : {}),
    ...(opts.pauseMs !== undefined ? { pauseMs: opts.pauseMs } : {})
  })
  const share = new Share(ctx.appStorage, { hostId, log: ctx.log })

  /** The latest aggregate (published by whoever leads), null until the first one. */
  let agg = null
  let rateLimits = null
  const rateLimitsAvailable = typeof ctx.sessions.rateLimits === 'function'
  let rateLimitsAt = 0
  let rateLimitsEvents = false
  /** This window's Claude tabs (for a session click) and their last status (for turn ends). */
  let own = []
  const lastStatus = new Map()
  const meters = new Set()
  let scanning = null
  let wantScan = false
  let lastScanAt = 0
  let ticking = false
  let wasLeader = false
  let debounce = null
  let lastPanel = null
  let lastHeader = null
  const lastMeter = new WeakMap()

  // ---- drawing ----

  function panelPayload() {
    const now = Date.now()
    const dir = onlyDir()
    const ranges = {}
    if (agg) for (const r of view.RANGES) ranges[r.id] = view.summarize(agg, { days: r.days, now, onlyDir: dir })
    return {
      type: 'usage',
      ready: !!agg,
      scope: dir ? 'project' : 'all',
      project: view.baseName(ctx.projectDir),
      updated: agg && typeof agg.at === 'number' ? view.ago(agg.at, now) : null,
      ranges,
      rateLimitsAvailable,
      rateLimits: view.rateLimitsView(rateLimits, now, warnAt()),
      open: own.filter((s) => typeof s.sessionId === 'string').map((s) => s.sessionId),
      priceDate: prices.SOURCE_DATE
    }
  }

  function sendPanel(force = false) {
    const payload = panelPayload()
    const text = JSON.stringify(payload)
    if (force || text !== lastPanel) {
      lastPanel = text
      try {
        ctx.panels.post(PANEL, payload)
      } catch (e) {
        ctx.log.warn(`post: ${e.message}`)
      }
    }
    const busy = !!scanning && share.leader
    const meta = agg ? `API-equivalent · updated ${payload.updated}` : 'reading transcripts'
    const header = { meta, actions: [{ id: 'refresh', icon: 'refresh', title: 'Read new transcript lines now', busy }] }
    const h = JSON.stringify(header)
    if (h === lastHeader) return
    lastHeader = h
    try {
      ctx.panels.header(PANEL, header)
    } catch (e) {
      ctx.log.warn(`header: ${e.message}`)
    }
  }

  function sendMeter(slot, force = false) {
    const meter = view.meterView(agg, { now: Date.now(), onlyDir: onlyDir(), rateLimits, warnAt: warnAt() })
    const text = JSON.stringify(meter)
    if (!force && lastMeter.get(slot) === text) return
    lastMeter.set(slot, text)
    try {
      slot.post({ type: 'meter', meter })
    } catch (e) {
      ctx.log.warn(`meter post: ${e.message}`)
    }
  }

  function render() {
    if (stopped) return
    sendPanel()
    for (const slot of meters) sendMeter(slot)
  }

  // ---- scanning (leader only) ----

  function startScan() {
    if (stopped) return
    if (scanning) {
      wantScan = true
      return
    }
    wantScan = false
    lastScanAt = Date.now()
    let lastPartial = Date.now()
    let partial = Promise.resolve()
    const first = !agg
    scanning = (async () => {
      sendPanel()
      try {
        await scanner.scan(() => {
          // A long first pass: show what is counted so far, now and then.
          if (!first || Date.now() - lastPartial < PARTIAL_PUBLISH_MS) return
          lastPartial = Date.now()
          partial = partial.then(() => publish()).catch((e) => ctx.log.warn(`publish: ${e.message}`))
        })
        await partial
        if (!stopped) await publish()
        await scanner.save()
      } catch (e) {
        ctx.log.warn(`scan: ${e.message}`)
      } finally {
        scanning = null
        render()
        if (wantScan && !stopped) startScan()
      }
    })()
    return scanning
  }

  async function publish() {
    const snap = scanner.snapshot()
    if (!snap) {
      ctx.log.warn('aggregate too large to share; showing it in this window only')
      return
    }
    agg = snap
    render()
    await share.publish(snap)
  }

  /** A turn ended or the person pressed refresh: the leader scans soon, a follower asks it to. */
  function requestScan() {
    if (debounce) return
    debounce = setTimeout(() => {
      debounce = null
      if (stopped) return
      if (share.leader) startScan()
      else share.poke().catch((e) => ctx.log.warn(`poke: ${e.message}`))
    }, opts.debounceMs ?? TURN_DEBOUNCE_MS)
  }

  async function refreshRateLimits() {
    rateLimitsAt = Date.now()
    try {
      rateLimits = await ctx.sessions.rateLimits()
    } catch (e) {
      ctx.log.warn(`rateLimits: ${e.message}`)
    }
  }

  async function tick() {
    if (stopped || ticking) return
    ticking = true
    try {
      const leader = await share.tick()
      if (leader && !wasLeader && !scanning) {
        // Taken over (or back) from another window: carry on from what that leader saved last,
        // not from this host's own older pass.
        scanner.reset()
      }
      wasLeader = leader
      if (leader) {
        const poked = await share.poked()
        if (poked || wantScan || Date.now() - lastScanAt >= rescanMs()) startScan()
      } else {
        const fresh = await share.readIfNew()
        if (fresh) agg = fresh
      }
      if (rateLimitsAvailable && !rateLimitsEvents && Date.now() - rateLimitsAt >= RATE_LIMITS_POLL_MS) await refreshRateLimits()
      render()
    } catch (e) {
      ctx.log.warn(`tick: ${e.message}`)
    } finally {
      ticking = false
    }
  }

  // ---- wiring ----

  disposers.push(
    ctx.panels.onMessage(PANEL, async (m) => {
      if (!m || typeof m !== 'object') return
      try {
        if (m.type === 'hello') sendPanel(true)
        else if (m.type === 'focus') {
          // Only a session this window has a tab for; the id comes from the page.
          const tab = typeof m.sessionId === 'string' ? own.find((s) => s.sessionId === m.sessionId) : undefined
          if (tab) await ctx.sessions.focus(tab.tabId)
        }
      } catch (e) {
        ctx.log.warn(`${m.type}: ${e.message}`)
      }
    })
  )
  if (typeof ctx.panels.onAction === 'function') {
    disposers.push(
      ctx.panels.onAction(PANEL, (id) => {
        if (id === 'refresh') requestScan()
      })
    )
  }

  function heardSessions(sessions) {
    own = Array.isArray(sessions) ? sessions : []
    let ended = false
    const ids = new Set()
    for (const s of own) {
      ids.add(s.tabId)
      if (lastStatus.get(s.tabId) === 'working' && s.status !== 'working') ended = true
      lastStatus.set(s.tabId, s.status)
    }
    for (const id of [...lastStatus.keys()]) if (!ids.has(id)) lastStatus.delete(id)
    if (ended) requestScan()
    render()
  }
  disposers.push(ctx.sessions.onChange(heardSessions))
  ctx.sessions
    .list()
    .then(heardSessions)
    .catch((e) => ctx.log.warn(`list: ${e.message}`))

  if (typeof ctx.sessions.onRateLimits === 'function') {
    rateLimitsEvents = true
    disposers.push(
      ctx.sessions.onRateLimits((rl) => {
        rateLimits = rl
        render()
      })
    )
  }
  if (rateLimitsAvailable) refreshRateLimits().then(render)

  if (typeof ctx.slots === 'object' && ctx.slots && typeof ctx.slots.onOpen === 'function') {
    disposers.push(
      ctx.slots.onOpen(METER, (slot) => {
        meters.add(slot)
        slot.onMessage(async (m) => {
          if (!m || typeof m !== 'object') return
          try {
            if (m.type === 'hello') sendMeter(slot, true)
            else if (m.type === 'open') ctx.panels.show(PANEL)
          } catch (e) {
            ctx.log.warn(`meter ${m.type}: ${e.message}`)
          }
        })
        slot.onClose(() => meters.delete(slot))
        sendMeter(slot, true)
      })
    )
  }

  disposers.push(ctx.onSettingsChange(() => render()))

  // What the last leader published (appStorage outlives the app): drawn at once, before any scan.
  const ready = share
    .read()
    .then((a) => {
      if (a && !agg) agg = a
      render()
    })
    .catch((e) => ctx.log.warn(`read: ${e.message}`))
    .then(() => (opts.tick === false ? undefined : tick()))
  if (opts.tick !== false) disposers.push(ctx.schedule(TICK_S, tick))

  return {
    ready,
    tick,
    scanNow: () => startScan(),
    idle: async () => {
      while (scanning) await scanning
    },
    share,
    scanner,
    get agg() {
      return agg
    },
    async stop() {
      if (stopped) return
      stopped = true
      if (debounce) clearTimeout(debounce)
      for (const d of disposers) {
        try {
          if (typeof d === 'function') d()
        } catch {
          // nothing left to clean up in a reloading host
        }
      }
      scanner.stop()
      try {
        if (scanning) await scanning
        await scanner.save()
        await share.release()
      } catch (e) {
        ctx.log.warn(`stop: ${e.message}`)
      }
    }
  }
}

exports.start = start

exports.activate = (ctx) => {
  current = start(ctx)
  ctx.log.info('activated')
}

exports.deactivate = async () => {
  const c = current
  current = null
  if (c) await c.stop()
}
