// Ask Claude's page half (src/page/ask.mjs selectionContext) on a CodeMirror state, with no DOM.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { selectionContext, MAX_SELECTION_CHARS } from '../src/page/ask.mjs'

const state = (doc, anchor, head = anchor) => EditorState.create({ doc, selection: { anchor, head } })

test('selectionContext: lines are 1-based and inclusive', () => {
  const s = state('one\ntwo\nthree\nfour', 4, 13)
  assert.deepEqual(selectionContext(s), { startLine: 2, endLine: 3, text: 'two\nthree', cut: false })
})

test('selectionContext: a backwards selection is the same range', () => {
  const s = state('one\ntwo\nthree', 9, 2)
  assert.deepEqual(selectionContext(s), { startLine: 1, endLine: 3, text: 'e\ntwo\nt', cut: false })
})

test('selectionContext: no selection is the cursor line with no text', () => {
  assert.deepEqual(selectionContext(state('one\ntwo\nthree', 5)), { startLine: 2, endLine: 2, text: '', cut: false })
})

test('selectionContext: a selection that ends at the start of a line leaves that line out', () => {
  const s = state('one\ntwo\nthree', 4, 8)
  assert.deepEqual(selectionContext(s), { startLine: 2, endLine: 2, text: 'two', cut: false })
})

test('selectionContext: a selection inside one line stays one line', () => {
  assert.deepEqual(selectionContext(state('hello world', 6, 11)), { startLine: 1, endLine: 1, text: 'world', cut: false })
})

test('selectionContext: over the cap it is cut, and the range ends where the text does', () => {
  const doc = Array.from({ length: 10 }, () => 'y'.repeat(99)).join('\n')
  const s = state(doc, 0, doc.length)
  const got = selectionContext(s, 250)
  assert.equal(got.text.length, 250)
  assert.equal(got.cut, true)
  assert.equal(got.startLine, 1)
  assert.equal(got.endLine, 3)
  assert.ok(MAX_SELECTION_CHARS >= 1000)
})
