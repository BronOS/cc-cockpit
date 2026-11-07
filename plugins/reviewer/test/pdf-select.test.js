'use strict'
// The PDF view's drag selection (src/page/pdf-select.mjs posIn) and the word-aligned tail of a long
// selection (src/page/anchor.mjs tailOf).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const load = (f) => import(path.join(__dirname, '../src/page', f))

// Three lines: a heading at y 100-130, two paragraph lines at 150-170 and 175-195, all from x 50.
function layer() {
  const span = (text, left, top, width, height) => {
    const s = { textContent: text }
    s.firstChild = { nodeType: 3, data: text, parentNode: s }
    return { s, r: { left, top, right: left + width, bottom: top + height } }
  }
  return [span('Page 3: a long section', 50, 100, 300, 30), span('This page has one long paragraph,', 50, 150, 500, 20), span('The end of the long paragraph is here.', 50, 175, 480, 20)]
}

test('posIn: a margin or a gap snaps to the next text in reading order, never to the middle of the page', async () => {
  const { posIn } = await load('pdf-select.mjs')
  const spans = layer()
  const at = (x, y) => {
    const p = posIn(spans, x, y, null)
    return [p.node.data.slice(0, 12), p.offset]
  }
  assert.deepEqual(at(60, 40), ['Page 3: a lo', 0]) // above the heading
  assert.deepEqual(at(10, 115), ['Page 3: a lo', 0]) // left of it, on its line
  assert.deepEqual(at(600, 115), ['This page ha', 0]) // right of the heading: the next line
  assert.deepEqual(at(300, 140), ['This page ha', 0]) // between the lines
  assert.deepEqual(at(300, 400), ['The end of t', 38]) // below everything: the end of the text
  assert.equal(posIn([], 1, 1, null), null)
})

test('posIn: inside a span, the caret there (only when it is that span\'s text)', async () => {
  const { posIn } = await load('pdf-select.mjs')
  const spans = layer()
  const heading = spans[0].s.firstChild
  assert.deepEqual(posIn(spans, 120, 115, () => ({ node: heading, offset: 7 })), { node: heading, offset: 7 })
  // A caret in some other node: the span's start instead.
  assert.deepEqual(posIn(spans, 120, 115, () => ({ node: spans[2].s.firstChild, offset: 3 })), { node: heading, offset: 0 })
})

test('tailOf: the end of a long selection starts at a word, at most TAIL_MAX chars', async () => {
  const { tailOf, TAIL_MAX } = await load('anchor.mjs')
  const text = 'x'.repeat(600) + ' luctus magna felis sollicitudin mauris. ' + 'word '.repeat(30) + 'The end is here.'
  const t = tailOf(text, 500)
  assert.ok(t.length <= TAIL_MAX)
  assert.ok(text.endsWith(t))
  const before = text[text.length - t.length - 1]
  assert.match(before, /\s/, `starts mid-word: «${t.slice(0, 20)}»`)
  // A cut that would land inside "magna": moved to the next word.
  const s = 'a'.repeat(500) + ' magna felis end.'
  assert.equal(tailOf(s, s.length - 14), 'felis end.')
  // Shorter than the kept part: nothing to add.
  assert.equal(tailOf('short text', 500), '')
  // One long word to the end: no word start, no tail.
  assert.equal(tailOf('a'.repeat(800), 500), '')
})
