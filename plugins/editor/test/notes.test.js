'use strict'
// The Reviewer's notes in the gutter, the host's half (dist/lib/notes.js): the tab's own path is the
// only one asked about, the service is resolved on every use, no Reviewer (or an older one) is
// `has: false`, an add is checked here and refused or accepted by the Reviewer, and the event
// `notesChange` of this file (only) pushes the notes again.
const test = require('node:test')
const assert = require('node:assert/strict')
const notes = require('../dist/lib/notes.js')

const tick = () => new Promise((r) => setTimeout(r, 5))

/** A tab instance: what the host posted, and a way to say a message as the page. */
function fakeTab() {
  const closers = []
  const tab = { posted: [], post: (m) => tab.posted.push(m), onClose: (fn) => closers.push(fn), close: () => closers.forEach((c) => c()) }
  return tab
}

/** A fake `reviewer` handle: `calls` records each call, `emit` fires the event to every listener. */
function fakeReviewer(over = {}) {
  const calls = []
  const listeners = new Set()
  const unsubscribed = []
  const handle = {
    notes: async (p) => (calls.push(['notes', p]), over.list || []),
    addNote: async (p, n) => (calls.push(['addNote', p, n]), { id: 'e1' }),
    on: (event, fn) => {
      const l = { event, fn }
      listeners.add(l)
      return () => (listeners.delete(l), unsubscribed.push(event))
    },
    ...over.methods,
  }
  return { handle, calls, listeners, unsubscribed, emit: (event, data) => [...listeners].filter((l) => l.event === event).forEach((l) => l.fn(data)) }
}

const setup = (rev, rel = 'src/a.ts', extra = {}) => {
  const tab = fakeTab()
  const handle = notes.serveNotes(tab, { rel, reviewer: () => (rev ? rev.handle : null), log: { warn() {} }, ...extra })
  return { tab, handle }
}

test('notes-get: the tab\'s own path is asked, whatever the page names; the answer carries the list', async () => {
  const rev = fakeReviewer({ list: [{ id: 'a', from: 2, to: 3, text: 'why?', quote: 'q' }] })
  const { tab, handle } = setup(rev)
  assert.equal(handle({ t: 'notes-get', req: 4, path: 'other.txt' }), true)
  await tick()
  assert.deepEqual(rev.calls, [['notes', 'src/a.ts']])
  assert.deepEqual(tab.posted, [{ t: 'notes', req: 4, has: true, notes: [{ id: 'a', from: 2, to: 3, text: 'why?' }] }])
})

test('notes-get: no Reviewer, an older one, a failing one and a tab with no path are `has: false`', async () => {
  const none = setup(null)
  none.handle({ t: 'notes-get', req: 1 })
  await tick()
  assert.deepEqual(none.tab.posted, [{ t: 'notes', req: 1, has: false }])
  const old = setup(fakeReviewer({ methods: { notes: async () => Promise.reject(new Error('service "reviewer" (plugin cockpit.reviewer) has no method "notes"')) } }))
  old.handle({ t: 'notes-get', req: 2 })
  await tick()
  assert.deepEqual(old.tab.posted, [{ t: 'notes', req: 2, has: false }])
  const outside = setup(fakeReviewer(), null)
  outside.handle({ t: 'notes-get', req: 3 })
  await tick()
  assert.deepEqual(outside.tab.posted, [{ t: 'notes', req: 3, has: false }])
})

test('the service is resolved on every use: a Reviewer that appears later is followed', async () => {
  let rev = null
  const tab = fakeTab()
  const handle = notes.serveNotes(tab, { rel: 'a.js', reviewer: () => (rev ? rev.handle : null), log: { warn() {} } })
  handle({ t: 'notes-get', req: 1 })
  await tick()
  assert.equal(tab.posted[0].has, false)
  rev = fakeReviewer({ list: [{ id: 'a', from: 1, to: 1, text: 'x', quote: '' }] })
  handle({ t: 'notes-get', req: 2 })
  await tick()
  assert.equal(tab.posted[1].has, true)
  assert.equal(rev.listeners.size, 1)
})

test('shownNotes: malformed entries are dropped, long text is cut, the list is bounded', () => {
  const out = notes.shownNotes([
    null,
    { id: 'ok', from: 1, to: 1, text: 'fine' },
    { id: 'no-text', from: 1, to: 1, text: '  ' },
    { id: 'bad-line', from: 0, to: 1, text: 'x' },
    { id: 'backwards', from: 3, to: 2, text: 'x' },
    { id: 'frac', from: 1.5, to: 2, text: 'x' },
    { id: 'long', from: 1, to: 2, text: 'y'.repeat(5000) },
  ])
  assert.deepEqual(out.map((n) => n.id), ['ok', 'long'])
  assert.equal(out[1].text.length, notes.MAX_SHOWN_CHARS)
  assert.deepEqual(notes.shownNotes('nope'), [])
  const many = notes.shownNotes(Array.from({ length: 500 }, (_, i) => ({ id: String(i), from: 1, to: 1, text: 'x' })))
  assert.equal(many.length, notes.MAX_SHOWN_NOTES)
})

test('notesChange of this file pushes the notes (req 0); another file\'s change does not; closing unsubscribes', async () => {
  const rev = fakeReviewer({ list: [{ id: 'a', from: 1, to: 1, text: 'x', quote: '' }] })
  const { tab, handle } = setup(rev)
  handle({ t: 'notes-get', req: 1, connect: true })
  await tick()
  tab.posted.length = 0
  rev.emit('notesChange', { path: 'other.ts' })
  rev.emit('notesChange', null)
  await tick()
  assert.deepEqual(tab.posted, [])
  rev.emit('notesChange', { path: 'src/a.ts' })
  await tick()
  assert.deepEqual(tab.posted, [{ t: 'notes', req: 0, has: true, notes: [{ id: 'a', from: 1, to: 1, text: 'x' }] }])
  // A page that reconnects listens again, once: the old listener goes.
  handle({ t: 'notes-get', req: 2, connect: true })
  await tick()
  assert.equal(rev.listeners.size, 1)
  assert.deepEqual(rev.unsubscribed, ['notesChange'])
  tab.close()
  assert.equal(rev.listeners.size, 0)
  tab.posted.length = 0
  rev.emit('notesChange', { path: 'src/a.ts' })
  await tick()
  assert.deepEqual(tab.posted, [])
})

test('notes-add: the tab\'s own path, a checked note, the answer, then fresh notes', async () => {
  const rev = fakeReviewer({ list: [{ id: 'e1', from: 2, to: 3, text: 'hello', quote: '' }] })
  const { tab, handle } = setup(rev)
  assert.equal(handle({ t: 'notes-add', req: 7, path: 'other.txt', from: 2, to: 3, text: 'hello', quote: 'q'.repeat(900) }), true)
  await tick()
  assert.deepEqual(rev.calls[0], ['addNote', 'src/a.ts', { from: 2, to: 3, text: 'hello', quote: 'q'.repeat(500) }])
  assert.deepEqual(tab.posted[0], { t: 'notes-added', req: 7, ok: true })
  assert.deepEqual(tab.posted[1], { t: 'notes', req: 0, has: true, notes: [{ id: 'e1', from: 2, to: 3, text: 'hello' }] })
})

test('notes-add: bad input is refused here with a sentence, before any call', async () => {
  const rev = fakeReviewer()
  const { tab, handle } = setup(rev)
  const bad = [
    { from: 0, text: 'x' },
    { from: 1.5, text: 'x' },
    { from: 'a', text: 'x' },
    { from: 3, to: 2, text: 'x' },
    { from: 1, text: '' },
    { from: 1, text: '   ' },
    { from: 1, text: 5 },
    { from: 1, text: 'x'.repeat(4001) },
  ]
  for (const [i, m] of bad.entries()) {
    handle({ t: 'notes-add', req: i, ...m })
    await tick()
    const last = tab.posted.at(-1)
    assert.equal(last.ok, false, JSON.stringify(m))
    assert.equal(last.req, i)
    assert.equal(typeof last.message, 'string')
  }
  assert.deepEqual(rev.calls, [])
  // No `to`: the one line.
  handle({ t: 'notes-add', req: 99, from: 4, text: 'one line' })
  await tick()
  assert.deepEqual(rev.calls[0][2], { from: 4, to: 4, text: 'one line', quote: '' })
})

test('notes-add: no Reviewer, an old one and a refusal are told to the person', async () => {
  const none = setup(null)
  none.handle({ t: 'notes-add', req: 1, from: 1, text: 'x' })
  await tick()
  assert.deepEqual(none.tab.posted, [{ t: 'notes-added', req: 1, ok: false, message: 'no Reviewer plugin is available' }])
  const old = setup(fakeReviewer({ methods: { addNote: async () => Promise.reject(new Error('service "reviewer" has no method "addNote"')) } }))
  old.handle({ t: 'notes-add', req: 2, from: 1, text: 'x' })
  await tick()
  assert.match(old.tab.posted[0].message, /too old/)
  const open = setup(fakeReviewer({ methods: { addNote: async () => Promise.reject(new Error('reviewer: the review of src/a.ts is open: add the note there')) } }))
  open.handle({ t: 'notes-add', req: 3, from: 1, text: 'x' })
  await tick()
  assert.deepEqual(open.tab.posted, [{ t: 'notes-added', req: 3, ok: false, message: 'the review of src/a.ts is open: add the note there' }])
  const outside = setup(fakeReviewer(), null)
  outside.handle({ t: 'notes-add', req: 4, from: 1, text: 'x' })
  await tick()
  assert.equal(outside.tab.posted[0].ok, false)
})

test('other messages are not ours; a message after the tab closed posts nothing', async () => {
  const rev = fakeReviewer()
  const { tab, handle } = setup(rev)
  assert.equal(handle(null), false)
  assert.equal(handle({ t: 'git-base' }), false)
  handle({ t: 'notes-get', req: 1 })
  tab.close()
  await tick()
  assert.deepEqual(tab.posted, [])
})
