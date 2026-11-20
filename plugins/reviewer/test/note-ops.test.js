'use strict'
// The page's side of the shared notes (src/page/note-ops.mjs): its ops, the host's answer to an add, and the
// other copies' changes on its notes array.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const load = () => import(path.join(__dirname, '../src/page/note-ops.mjs'))

test('a new note is sent by its tag, its changes and delete by the tag until the host\'s id comes, then by the id', async () => {
  const { tagOf, isPending, addOp, changeOp, deleteOp, ackAdd } = await load()
  const note = { side: 'new', from: 1, to: 1, quote: 'q', text: '' }
  note.tag = tagOf(0)
  note.id = note.tag
  assert.ok(isPending(note))
  // No id, tag or author leaves the page in an add.
  assert.deepEqual(addOp({ ...note, author: 'forged' }), { type: 'note-add', tag: '~0', note: { side: 'new', from: 1, to: 1, quote: 'q', text: '' } })
  note.text = 'typed fast'
  assert.deepEqual(changeOp(note), { type: 'note-change', tag: '~0', text: 'typed fast' })
  const notes = [note]
  const r = ackAdd(notes, '~0', { id: 'n1', text: '', author: 'Ann' })
  assert.deepEqual(r, { note, oldId: '~0' })
  assert.deepEqual([note.id, note.tag, note.author, note.text], ['n1', undefined, 'Ann', 'typed fast'], 'the page keeps its own newer text')
  assert.ok(!isPending(note))
  assert.deepEqual(changeOp(note), { type: 'note-change', id: 'n1', text: 'typed fast' })
  assert.deepEqual(deleteOp(note), { type: 'note-delete', id: 'n1' })
  // An answer for a note deleted meanwhile (or another tag) finds nothing.
  assert.equal(ackAdd(notes, '~0', { id: 'n2' }), null)
  assert.equal(ackAdd([], '~5', { id: 'n3' }), null)
})

test('another copy\'s notes: added, changed by id, deleted; a refused add drops the page\'s note', async () => {
  const { upsertNote, removeNote, dropTagged, tagOf } = await load()
  const notes = [{ id: 'n1', text: 'a' }]
  assert.equal(upsertNote(notes, { id: 'n2', text: 'b', author: 'Ann' }), 'added')
  assert.equal(upsertNote(notes, { id: 'n1', text: 'a' }), null)
  assert.equal(upsertNote(notes, { id: 'n1', text: 'a!' }), 'changed')
  assert.equal(upsertNote(notes, null), null)
  assert.deepEqual(notes, [{ id: 'n1', text: 'a!' }, { id: 'n2', text: 'b', author: 'Ann' }])
  assert.equal(removeNote(notes, 'n1'), true)
  assert.equal(removeNote(notes, 'n1'), false)
  const mine = { id: tagOf(3), tag: tagOf(3), text: '' }
  notes.push(mine)
  assert.equal(dropTagged(notes, '~3'), true)
  assert.deepEqual(notes.map((n) => n.id), ['n2'])
})
