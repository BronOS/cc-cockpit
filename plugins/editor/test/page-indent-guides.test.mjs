import { test } from 'node:test'
import assert from 'node:assert/strict'
import { leadingColumns, guideStyle } from '../src/page/indent-guides.mjs'

test('leadingColumns counts spaces and tabs to the next tab stop', () => {
  assert.equal(leadingColumns('    x', 4), 4)
  assert.equal(leadingColumns('\tx', 4), 4)
  assert.equal(leadingColumns('  \tx', 4), 4)
  assert.equal(leadingColumns('x', 4), 0)
})

test('a blank or whitespace-only line has no columns, so no guide', () => {
  assert.equal(leadingColumns('', 4), 0)
  assert.equal(leadingColumns('      ', 4), 0)
  assert.equal(guideStyle(0, 2), null)
})

test('guideStyle repeats a line every indent unit over the indent width', () => {
  const s = guideStyle(8, 4)
  assert.match(s, /transparent 1px,transparent 4ch/)
  assert.match(s, /background-size:8ch 100%/)
  assert.equal(guideStyle(4, 0), null)
})
