// Ask Claude's page half (src/page/ask.mjs selectionContext, askContext) on a CodeMirror state, with no DOM:
// the selection, and the Reviewer's notes on its lines as the gutter's marks place them after edits.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { selectionContext, askContext, overlapping, placedNotes, MAX_ASK_CHARS } from '../src/page/ask.mjs'
import { marksOf, noteLines } from '../src/page/notes-editor.js'

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
  assert.ok(MAX_ASK_CHARS >= 1000)
})

// ---- the Reviewer's notes ----

const note = (id, from, to) => ({ id, from, to, text: `${id} text` })
const doc5 = 'one\ntwo\nthree\nfour\nfive'

test('askContext: no notes, or no Reviewer, is the selection alone (the text of before)', () => {
  const s = state(doc5, 4, 13)
  assert.deepEqual(askContext(s), selectionContext(s))
  assert.deepEqual(askContext(s, { notes: null }), selectionContext(s))
  // Notes outside the selection's lines: none named.
  assert.deepEqual(askContext(s, { notes: [note('a', 1, 1), note('b', 4, 5)] }), selectionContext(s))
})

test("askContext: the notes overlapping the selection's lines (the cursor's line with none), by id and lines only", () => {
  const notes = [note('before', 1, 1), note('across', 1, 2), note('inside', 3, 3), note('after', 4, 5)]
  const s = state(doc5, 4, 13) // lines 2-3
  assert.deepEqual(askContext(s, { notes }), {
    ...selectionContext(s),
    notes: [
      { id: 'across', from: 1, to: 2 },
      { id: 'inside', from: 3, to: 3 },
    ],
  })
  // The cursor on line 4.
  assert.deepEqual(askContext(state(doc5, 15), { notes }).notes, [{ id: 'after', from: 4, to: 5 }])
})

test("askContext: after edits shifted the lines, the notes are named on the gutter's lines, not the Reviewer's", () => {
  // The Reviewer's note on line 2 ("two"); two lines typed above it in the buffer.
  const before = EditorState.create({ doc: doc5 })
  const list = [note('n', 2, 2), note('far', 9, 9)]
  const marks = marksOf(before.doc, list)
  const tr = before.update({ changes: { from: 0, insert: 'new 1\nnew 2\n' } })
  const after = tr.state.update({ selection: { anchor: tr.state.doc.line(4).from, head: tr.state.doc.line(4).to } }).state
  const lines = noteLines(marks.map(tr.changes), after.doc)
  assert.deepEqual([...lines], [['n', { from: 4, to: 4 }]])
  assert.deepEqual(askContext(after, { notes: list, lines }).notes, [{ id: 'n', from: 4, to: 4 }])
  // Line 2 is now "new 2": the note is not on it any more, so Ask Claude there names none.
  const onTwo = after.update({ selection: { anchor: after.doc.line(2).from } }).state
  assert.equal(askContext(onTwo, { notes: list, lines }).notes, undefined)
})

test('askContext notes mode: every note, on the gutter\'s lines where it has them, else the Reviewer\'s', () => {
  const lines = new Map([['a', { from: 7, to: 8 }]])
  assert.deepEqual(askContext(state(doc5, 0), { mode: 'notes', notes: [note('a', 1, 2), note('b', 40, 41)], lines }), {
    mode: 'notes',
    notes: [
      { id: 'a', from: 7, to: 8 },
      { id: 'b', from: 40, to: 41 },
    ],
  })
  assert.deepEqual(askContext(state(doc5, 0), { mode: 'notes', notes: null }), { mode: 'notes', notes: [] })
})

test('placedNotes and overlapping: lines inclusive at both ends', () => {
  const placed = placedNotes([note('a', 1, 3), note('b', 5, 5)], new Map([['b', { from: 6, to: 6 }]]))
  assert.deepEqual(placed, [
    { id: 'a', from: 1, to: 3 },
    { id: 'b', from: 6, to: 6 },
  ])
  assert.deepEqual(overlapping(placed, 3, 3).map((n) => n.id), ['a'])
  assert.deepEqual(overlapping(placed, 4, 5).map((n) => n.id), [])
  assert.deepEqual(overlapping(placed, 6, 9).map((n) => n.id), ['b'])
})
