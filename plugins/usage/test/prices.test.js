'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const prices = require('../dist/lib/prices')

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)
const t = (o) => ({ input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0, fast: false, ...o })

test('the table has a source date and every row its three prices', () => {
  assert.match(prices.SOURCE_DATE, /^\d{4}-\d{2}-\d{2}$/)
  for (const [id, row] of Object.entries(prices.MODELS)) {
    for (const r of [row.std, row.fast, row.long].filter(Boolean)) {
      for (const k of ['input', 'output', 'cacheRead']) assert.ok(r[k] > 0, `${id} ${k}`)
    }
  }
})

test('model ids match exactly or with a date suffix taken off, nothing else', () => {
  assert.equal(prices.modelKey('claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(prices.modelKey('claude-sonnet-4-20250514'), 'claude-sonnet-4')
  assert.equal(prices.modelKey('claude-haiku-4-5-20251001'), 'claude-haiku-4-5')
  assert.equal(prices.modelKey('<synthetic>'), undefined)
  assert.equal(prices.modelKey('claude-opus-5-5-preview'), undefined)
  assert.equal(prices.modelKey('claude-opus-9'), undefined)
  assert.equal(prices.modelKey('constructor'), undefined)
  assert.equal(prices.modelKey(undefined), undefined)
})

test('tokensOf splits cache writes into 5m and 1h, and fills a missing split as 5m', () => {
  assert.deepEqual(
    prices.tokensOf({ input_tokens: 2, output_tokens: 6, cache_read_input_tokens: 26992, cache_creation_input_tokens: 20596, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20596 }, speed: 'standard' }),
    { input: 2, output: 6, cacheRead: 26992, cache5m: 0, cache1h: 20596, fast: false }
  )
  // An older Claude Code: no split at all.
  assert.deepEqual(prices.tokensOf({ input_tokens: 1, cache_creation_input_tokens: 500 }), t({ input: 1, cache5m: 500 }))
  // A split that adds up to less than the total: the rest is 5m.
  assert.deepEqual(prices.tokensOf({ cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 300 } }), t({ cache1h: 300, cache5m: 200 }))
  // Garbage counts as 0.
  assert.deepEqual(prices.tokensOf({ input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: NaN }), t({}))
  assert.equal(prices.tokensOf({ speed: 'fast' }).fast, true)
})

test('cost: input, output, cache read, 5m write at 1.25x and 1h write at 2x input', () => {
  // Opus 5.5: in 4, out 20, read 0.20 per MTok.
  close(prices.costOf('claude-opus-5-5', t({ input: 1e6 })), 4)
  close(prices.costOf('claude-opus-5-5', t({ output: 1e6 })), 20)
  close(prices.costOf('claude-opus-5-5', t({ cacheRead: 1e6 })), 0.2)
  close(prices.costOf('claude-opus-5-5', t({ cache5m: 1e6 })), 5)
  close(prices.costOf('claude-opus-5-5', t({ cache1h: 1e6 })), 8)
  // Sonnet 4.6 with everything: 3*1 + 15*2 + 0.3*3 + 3.75*4 + 6*5 (in millions).
  close(prices.costOf('claude-sonnet-4-6-20260101', t({ input: 1e6, output: 2e6, cacheRead: 3e6, cache5m: 4e6, cache1h: 5e6 })), 3 + 30 + 0.9 + 15 + 30)
  // The ones the pricing page corrected or confirmed.
  close(prices.costOf('claude-sonnet-5-5', t({ cacheRead: 1e6 })), 0.1)
  close(prices.costOf('claude-fable-5', t({ cacheRead: 1e6 })), 1)
  close(prices.costOf('claude-fable-5-1', t({ cacheRead: 1e6 })), 0.25)
})

test('fast mode uses the fast row, cache multipliers on top; no fast row means no price', () => {
  close(prices.costOf('claude-opus-5-5', t({ input: 1e6, fast: true })), 8)
  close(prices.costOf('claude-opus-5-5', t({ output: 1e6, fast: true })), 40)
  close(prices.costOf('claude-opus-5-5', t({ cacheRead: 1e6, fast: true })), 0.4)
  close(prices.costOf('claude-opus-5-5', t({ cache1h: 1e6, fast: true })), 16)
  close(prices.costOf('claude-opus-4-8', t({ input: 1e6, fast: true })), 10)
  assert.equal(prices.costOf('claude-sonnet-4-6', t({ input: 1e6, fast: true })), null)
})

test('Haiku 5.5 over 100K prompt tokens (cache included) pays the long prices for the whole request', () => {
  close(prices.costOf('claude-haiku-5-5', t({ input: 1e5, output: 1e6 })), 0.01 + 0.5)
  // 1 + 99,999 read + 1 write = 100,001 prompt tokens: long.
  close(prices.costOf('claude-haiku-5-5', t({ input: 1, cacheRead: 99999, cache5m: 1, output: 1e6 })), (0.5 * 1 + 0.05 * 99999 + 0.625 * 1) / 1e6 + 2.5)
})

test('an unknown model has no price, never a guess', () => {
  assert.equal(prices.costOf('<synthetic>', t({ input: 5 })), null)
  assert.equal(prices.costOf('claude-new-9', t({ input: 5 })), null)
})
