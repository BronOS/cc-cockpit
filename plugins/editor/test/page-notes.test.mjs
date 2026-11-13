// The page's notes (src/page/notes.mjs: asks, answers, the one add at a time) and the gutter's marks
// (src/page/notes-editor.js marksOf) on a CodeMirror document, with no DOM.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ChangeSet, Text } from '@codemirror/state'
import { createNotes, POLL_MS, FOCUS_MIN_MS } from '../src/page/notes.mjs'
import { marksOf } from '../src/page/notes-editor.js'

function make() {
  const posts = []
  const events = []
  let now = 0
  const n = createNotes({ post: (m) => posts.push(m), onNotes: () => events.push('notes'), onAdded: (ok, message) => events.push(['added', ok, message]) }, { now: () => now })
  return { n, posts, events, at: (t) => (now = t) }
}

const note = (id, from, to, text = id) => ({ id, from, to, text })

test('a connect asks (and says it is a new line); an answer to the newest ask is taken, an older one is not', () => {
  const { n, posts, events } = make()
  assert.equal(n.available(), false)
  n.connect()
  n.connect()
  assert.deepEqual(posts, [
    { t: 'notes-get', req: 1, connect: true },
    { t: 'notes-get', req: 2, connect: true },
  ])
  assert.equal(n.receive({ t: 'notes', req: 1, has: true, notes: [note('old', 1, 1)] }), true)
  assert.equal(n.available(), false)
  n.receive({ t: 'notes', req: 2, has: true, notes: [note('a', 2, 3)] })
  assert.equal(n.available(), true)
  assert.deepEqual(n.list(), [note('a', 2, 3)])
  assert.deepEqual(events, ['notes'])
})

test('has: false drops the list; an unchanged answer redraws nothing; a push (req 0) always counts', () => {
  const { n, events } = make()
  n.connect()
  n.receive({ t: 'notes', req: 1, has: true, notes: [note('a', 1, 1)] })
  n.receive({ t: 'notes', req: 0, has: true, notes: [note('a', 1, 1)] })
  assert.deepEqual(events, ['notes'])
  n.receive({ t: 'notes', req: 0, has: true, notes: [note('a', 1, 1), note('b', 4, 4)] })
  assert.equal(n.list().length, 2)
  n.receive({ t: 'notes', req: 0, has: false })
  assert.equal(n.available(), false)
  assert.deepEqual(n.list(), [])
  assert.deepEqual(events, ['notes', 'notes', 'notes'])
})

test('malformed notes in an answer are dropped', () => {
  const { n } = make()
  n.receive({ t: 'notes', req: 0, has: true, notes: [null, { from: 0, to: 1, text: 'x' }, { from: 2, to: 1, text: 'x' }, { from: 1, to: 1, text: 5 }, note('ok', 1, 2)] })
  assert.deepEqual(n.list(), [note('ok', 1, 2)])
  assert.equal(n.receive({ t: 'other' }), false)
  assert.equal(n.receive(null), false)
})

test('focus and poll ask again only after their waits', () => {
  const { n, posts, at } = make()
  at(0)
  n.connect()
  at(FOCUS_MIN_MS - 1)
  n.focus()
  assert.equal(posts.length, 1)
  at(FOCUS_MIN_MS)
  n.focus()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].connect, undefined)
  at(FOCUS_MIN_MS + POLL_MS - 1)
  n.poll()
  assert.equal(posts.length, 2)
  at(FOCUS_MIN_MS + POLL_MS)
  n.poll()
  assert.equal(posts.length, 3)
})

test('add: one at a time, the answer reaches the page once; a stale answer is ignored', () => {
  const { n, posts, events } = make()
  assert.equal(n.add({ from: 2, to: 3, text: 'why', quote: 'q' }), true)
  assert.deepEqual(posts[0], { t: 'notes-add', req: 1, from: 2, to: 3, text: 'why', quote: 'q' })
  assert.equal(n.add({ from: 1, to: 1, text: 'again', quote: '' }), false)
  n.receive({ t: 'notes-added', req: 99, ok: true })
  assert.deepEqual(events, [])
  n.receive({ t: 'notes-added', req: 1, ok: false, message: 'refused' })
  assert.deepEqual(events, [['added', false, 'refused']])
  n.receive({ t: 'notes-added', req: 1, ok: true })
  assert.equal(events.length, 1)
  assert.equal(n.add({ from: 1, to: 1, text: 'next', quote: '' }), true)
})

test('a new line ends an add that was on its way, with a message', () => {
  const { n, events } = make()
  n.add({ from: 1, to: 1, text: 'x', quote: '' })
  n.connect()
  assert.equal(events.length, 1)
  assert.equal(events[0][0], 'added')
  assert.equal(events[0][1], false)
  assert.match(events[0][2], /connection was lost/)
  assert.equal(n.add({ from: 1, to: 1, text: 'y', quote: '' }), true)
})

const list = (set) => {
  const out = []
  set.between(0, 1e9, (from, _to, m) => {
    out.push([from, m.notes.map((x) => x.id)])
  })
  return out
}

test('marksOf: a mark on each line a note covers; notes on one line share its mark', () => {
  const doc = Text.of(['a', 'b', 'c', 'd'])
  const marks = list(marksOf(doc, [note('n1', 2, 3), note('n2', 3, 3), note('n3', 1, 1)]))
  assert.deepEqual(marks, [
    [0, ['n3']],
    [2, ['n1']],
    [4, ['n1', 'n2']],
  ])
})

test('marksOf: a note past the end of the document is clipped, an empty document and list do not throw', () => {
  const doc = Text.of(['a', 'b'])
  assert.deepEqual(list(marksOf(doc, [note('far', 5, 9), note('edge', 2, 9)])), [[2, ['edge']]])
  assert.deepEqual(list(marksOf(Text.of(['']), [note('x', 1, 1)])), [[0, ['x']]])
  assert.deepEqual(list(marksOf(doc, [])), [])
})

test('marksOf: marks ride along with an edit before a laying-on again', () => {
  const doc = Text.of(['a', 'b', 'c'])
  const set = marksOf(doc, [note('n', 2, 2)])
  const changes = ChangeSet.of({ from: 0, insert: 'zz\n' }, doc.length)
  assert.deepEqual(list(set.map(changes)), [[5, ['n']]])
})
