// The gutter's marks (src/page/changes-editor.js marksOf) on a CodeMirror document, with no DOM.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChangeSet, Text } from '@codemirror/state'
import { marksOf } from '../src/page/changes-editor.js'
import { hunksOf } from '../src/page/changes.mjs'

const list = (set) => {
  const out = []
  set.between(0, 1e9, (from, _to, m) => {
    out.push([from, m.hunk.kind, m.edge])
  })
  return out
}

test('marksOf: a bar per line of an added or modified hunk, the first one marked as the edge', () => {
  const doc = Text.of(['a', 'B', 'C', 'd'])
  const marks = list(marksOf(doc, hunksOf('a\nb\nc\nd', 'a\nB\nC\nd')))
  assert.deepEqual(marks, [
    [2, 'modified', 'first'],
    [4, 'modified', null],
  ])
})

test('marksOf: a removal in the middle notches above the line, at the end below the last line', () => {
  const mid = Text.of(['a', 'c'])
  assert.deepEqual(list(marksOf(mid, hunksOf('a\nb\nc', 'a\nc'))), [[2, 'deleted', 'above']])
  const end = Text.of(['a', 'b'])
  assert.deepEqual(list(marksOf(end, hunksOf('a\nb\nc\n', 'a\nb\n'))).map((m) => m.slice(1)), [['deleted', 'below']])
})

test('marksOf: a hunk past the document and the empty document do not throw', () => {
  const empty = Text.of([''])
  assert.deepEqual(list(marksOf(empty, hunksOf('a\nb\n', ''))), [[0, 'deleted', 'above']])
  assert.deepEqual(list(marksOf(empty, hunksOf('', ''))), [])
  const doc = Text.of(['a'])
  assert.deepEqual(list(marksOf(doc, [{ kind: 'added', line: 5, count: 3, old: [], oldCount: 0 }])), [])
})

test('marksOf: marks ride along with an edit before a recompute', () => {
  const doc = Text.of(['a', 'B', 'c'])
  const set = marksOf(doc, hunksOf('a\nb\nc', 'a\nB\nc'))
  // Insert "zz\n" at the start: the bar that sat at 2 moves to 5.
  const changes = ChangeSet.of({ from: 0, insert: 'zz\n' }, doc.length)
  assert.deepEqual(list(set.map(changes)), [[5, 'modified', 'first']])
})
