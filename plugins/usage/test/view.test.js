'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const view = require('../dist/lib/view')
const store = require('../dist/lib/store')

const NOW = Date.now()

function totals(o) {
  const t = store.zero()
  for (const [k, v] of Object.entries(o)) t[store.T[k]] = v
  return t
}

function aggOf(rows, sessions = [], meta = {}) {
  return { v: 1, at: NOW - 120000, days: { [store.localDay(NOW)]: { cube: rows, sessions } }, meta }
}

test('the totals slots are the store\'s', () => {
  assert.deepEqual(view.T, store.T)
  assert.equal(view.T_LEN, store.T_LEN)
})

test('money and counts', () => {
  assert.equal(view.money(0), '$0.00')
  assert.equal(view.money(0.004), '<$0.01')
  assert.equal(view.money(4.2), '$4.20')
  assert.equal(view.money(1234.5), '$1,235')
  assert.equal(view.count(950), '950')
  assert.equal(view.count(12345), '12.3K')
  assert.equal(view.count(4_000_000), '4M')
  assert.equal(view.count(123_456_789), '123M')
  assert.equal(view.costText(totals({ cost: 1 })), '$1.00')
  assert.equal(view.costText(totals({ cost: 1, unpriced: 2 })), '$1.00+')
  assert.equal(view.modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(view.modelLabel('claude-sonnet-4-20250514'), 'Sonnet 4')
  assert.equal(view.modelLabel('<synthetic>'), '<synthetic>')
})

test('inside: the folder itself and below it, not a sibling with the same prefix', () => {
  assert.equal(view.inside('/work/alpha', '/work/alpha'), true)
  assert.equal(view.inside('/work/alpha/sub', '/work/alpha/'), true)
  assert.equal(view.inside('/work/alphabet', '/work/alpha'), false)
  assert.equal(view.inside(undefined, '/work/alpha'), false)
})

test('the meter: today\'s spend, the 5-hour window, the warning from the threshold', () => {
  assert.equal(view.meterView(null, { now: NOW }), null)
  const agg = aggOf([['/work/alpha', 'claude-opus-5-5', totals({ cost: 4.2, input: 10, messages: 1 })]])
  const plain = view.meterView(agg, { now: NOW })
  assert.equal(plain.text, '$4.20 today')
  assert.equal(plain.five, undefined)
  assert.match(plain.tooltip, /API-equivalent/)
  const rl = { fiveHour: { usedPercent: 42.4, resetsAt: NOW + 3600000 }, sevenDay: { usedPercent: 10 }, updatedAt: NOW }
  const m = view.meterView(agg, { now: NOW, rateLimits: rl, warnAt: 80 })
  assert.deepEqual(m.five, { percent: 42, warn: false, text: '5h 42%' })
  assert.equal(view.meterView(agg, { now: NOW, rateLimits: rl, warnAt: 40 }).five.warn, true)
  // Another project's work is not "today" for a window that counts only its own.
  assert.equal(view.meterView(agg, { now: NOW, onlyDir: '/work/beta' }).text, '$0.00 today')
  // Unpriced tokens: marked, and said in the tooltip.
  const u = view.meterView(aggOf([['/w', '<synthetic>', totals({ unpriced: 1, unpricedTokens: 5 })]]), { now: NOW })
  assert.equal(u.text, '$0.00+ today')
  assert.match(u.tooltip, /no known price/)
})

test('rate limits: rows for the windows core reports, nothing for junk', () => {
  assert.equal(view.rateLimitsView(null, NOW, 80), null)
  assert.equal(view.rateLimitsView({ fiveHour: { usedPercent: 'x' } }, NOW, 80), null)
  const r = view.rateLimitsView({ fiveHour: { usedPercent: 150, resetsAt: NOW + 3600e3 }, sevenDay: { usedPercent: 81, resetsAt: NOW + 3 * 864e5 } }, NOW, 80)
  assert.deepEqual(
    r.rows.map((x) => [x.key, x.percent, x.warn]),
    [
      ['fiveHour', 100, true],
      ['sevenDay', 81, true]
    ]
  )
  assert.equal(r.rows[1].resets, 'resets in 3 days')
})

test('rate limits: a window past its reset is stale and left out', () => {
  const r = view.rateLimitsView({ fiveHour: { usedPercent: 40, resetsAt: NOW }, sevenDay: { usedPercent: 11, resetsAt: NOW + 864e5 * 4 } }, NOW, 80)
  assert.deepEqual(r.rows.map((x) => x.key), ['sevenDay'])
  assert.equal(view.rateLimitsView({ fiveHour: { usedPercent: 40, resetsAt: NOW - 1 } }, NOW, 80), null)
})

test('summarize skips malformed rows from the shared store', () => {
  const agg = aggOf([['/w', 'm', totals({ cost: 1 })], ['bad'], 'x', ['/w', 'm', ['NaN', null]]], [['s', totals({ cost: 1 })], ['broken']], { s: ['/w', 'Title'] })
  const s = view.summarize(agg, { days: 1, now: NOW })
  assert.equal(s.totals[store.T.cost], 1)
  assert.deepEqual(
    s.sessions.map((x) => [x.id, x.title, x.name]),
    [['s', 'Title', 'w']]
  )
  assert.equal(view.summarize({}, { days: 30, now: NOW }).totals[store.T.cost], 0)
})

test('settings fall back to their defaults', () => {
  assert.equal(view.intSetting(undefined, view.WARN_AT), 80)
  assert.equal(view.intSetting(0, view.WARN_AT), 80)
  assert.equal(view.intSetting(50, view.WARN_AT), 50)
  assert.equal(view.intSetting(5, view.RESCAN), 60)
})

test('the meter reports its row width to the slot, 0 when empty, repeats dropped', () => {
  const { watchWidth } = require('../dist/lib/meter-width')
  const sent = []
  const row = { childElementCount: 1, getBoundingClientRect: () => ({ width: 120.2 }) }
  let slot
  const w = watchWidth(row, () => slot, undefined)
  w.report()
  assert.deepEqual(sent, [], 'not a slot yet')
  slot = { setWidth: (n) => sent.push(n) }
  w.report()
  w.report()
  row.childElementCount = 0
  w.report()
  assert.deepEqual(sent, [121, 0])
})
