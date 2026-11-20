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

test('convergence: an echo older than this page\'s unacked text is not taken; after the acks the next one is', async () => {
  const { NoteSync } = await load()
  const sync = new NoteSync()
  const n = { id: 'n1', text: 'mine, typed twice' }
  const notes = [n]
  sync.sentChange(n)
  sync.sentChange(n)
  // Another copy's text the host applied before this page's two ops: older, dropped.
  assert.equal(sync.remoteNote(notes, { id: 'n1', text: 'theirs' }), null)
  sync.ack(notes, { id: 'n1' })
  assert.equal(sync.remoteNote(notes, { id: 'n1', text: 'theirs' }), null, 'one op still out')
  sync.ack(notes, { id: 'n1' })
  sync.ack(notes, { id: 'n1' }) // a stray ack is harmless
  assert.equal(sync.remoteNote(notes, { id: 'n1', text: 'theirs, later' }), 'changed')
  assert.equal(n.text, 'theirs, later')
  assert.equal(sync.remoteNote(notes, { id: 'n2', text: 'new' }), 'added')
  assert.deepEqual(notes.map((x) => x.id), ['n1', 'n2'])
})

test('convergence: a note deleted here stays gone; one deleted elsewhere leaves `unsent` and `inflight`', async () => {
  const { NoteSync } = await load()
  const sync = new NoteSync()
  const a = { id: 'a', text: 'x' }
  const b = { id: 'b', text: 'y' }
  const notes = [a, b]
  // Deleted here: a late edit from another copy does not bring it back.
  notes.splice(0, 1)
  sync.deleted(a)
  assert.equal(sync.remoteNote(notes, { id: 'a', text: 'edited elsewhere' }), null)
  assert.deepEqual(notes.map((x) => x.id), ['b'])
  // Held back while over the cap, then deleted on another screen: nothing left to send for it.
  sync.unsent.add(b)
  sync.sentChange(b)
  assert.equal(sync.remoteDelete(notes, 'b'), true)
  assert.equal(sync.unsent.size, 0)
  assert.equal(sync.inflight.size, 0)
  assert.equal(sync.remoteDelete(notes, 'b'), false)
})

test('convergence: a note deleted before its add was answered stays gone when another copy\'s edit of it comes', async () => {
  const { NoteSync, tagOf, deleteOp } = await load()
  const sync = new NoteSync()
  const tag = tagOf(7)
  const mine = { id: tag, tag, text: 'oops' }
  const notes = [{ id: 'x', text: 'other' }, mine]
  // Page A adds, then deletes by the tag before the host's answer.
  assert.deepEqual(deleteOp(mine), { type: 'note-delete', tag })
  notes.splice(1, 1)
  sync.deleted(mine)
  // Copy B edited the host's note before A's delete reached the host: A gets the answer, then B's edit.
  assert.equal(sync.added(notes, tag, { id: 'n5', text: 'oops' }), null)
  assert.equal(sync.remoteNote(notes, { id: 'n5', text: 'edited by B' }), null)
  assert.deepEqual(notes.map((n) => n.id), ['x'])
  // The tag is spent; a refused add forgets its tag too and drops the page's note.
  assert.equal(sync.deletedTags.size, 0)
  const other = { id: tagOf(8), tag: tagOf(8), text: '' }
  notes.push(other)
  assert.equal(sync.refused(notes, tagOf(8)), true)
  assert.deepEqual(notes.map((n) => n.id), ['x'])
  const gone = { id: tagOf(9), tag: tagOf(9), text: '' }
  sync.deleted(gone)
  assert.equal(sync.refused(notes, tagOf(9)), false)
  assert.equal(sync.deletedTags.size, 0)
  // A note not deleted is answered as ackAdd does.
  const kept = { id: tagOf(10), tag: tagOf(10), text: 'kept' }
  notes.push(kept)
  assert.deepEqual(sync.added(notes, tagOf(10), { id: 'n6' }), { note: kept, oldId: tagOf(10) })
  assert.equal(sync.remoteNote(notes, { id: 'n6', text: 'kept, edited by B' }), 'changed')
})

test('convergence: the comment from another copy waits for this page\'s acks and clears its held-back text', async () => {
  const { NoteSync } = await load()
  const sync = new NoteSync()
  const draft = { global: 'mine', notes: [] }
  sync.sentGlobal()
  assert.equal(sync.remoteGlobal(draft, 'theirs'), false)
  assert.equal(draft.global, 'mine')
  sync.ack(draft.notes, { global: true })
  sync.unsent.add('global')
  assert.equal(sync.remoteGlobal(draft, 'theirs'), true)
  assert.equal(draft.global, 'theirs')
  assert.equal(sync.unsent.has('global'), false)
  assert.equal(sync.remoteGlobal(draft, 42), false)
  sync.sentGlobal()
  sync.reset()
  assert.equal(sync.remoteGlobal(draft, 'after init'), true)
})

test('convergence: an add acked between an echo and a remote delete moves the located range and the focus to the host id', async () => {
  const { NoteSync, tagOf, ackAdd, remapNoteId } = await load()
  const sync = new NoteSync()
  const tag = tagOf(3)
  const mine = { id: tag, tag, text: 'pending' }
  const notes = [{ id: 'x', text: 'other' }, mine]
  const located = new Map([[tag, { start: 1, end: 4 }]])
  let focused = tag
  // Typed before the id came: the change went out by the tag (counted against the note object).
  sync.sentChange(mine)
  const r = ackAdd(notes, tag, { id: 'n9', author: 'Ann' })
  focused = remapNoteId(located, focused, r.oldId, r.note.id)
  assert.equal(focused, 'n9')
  assert.deepEqual([...located.keys()], ['n9'])
  assert.equal(remapNoteId(located, 'x', 'gone', 'n10'), 'x')
  // The echo of another copy's older text for the now-named note is still behind this page's op.
  assert.equal(sync.remoteNote(notes, { id: 'n9', text: 'old' }), null)
  sync.ack(notes, { id: 'n9' })
  assert.equal(sync.remoteNote(notes, { id: 'n9', text: 'newer' }), 'changed')
  assert.equal(sync.remoteDelete(notes, 'x'), true)
  assert.deepEqual(notes.map((n) => [n.id, n.text]), [['n9', 'newer']])
})

test('the size check: an error over the cap, none once another copy shrank the draft', async () => {
  const { draftSizeError, NoteSync } = await load()
  const sync = new NoteSync()
  const draft = { global: '', notes: [{ id: 'a', text: 'x'.repeat(200) }, { id: 'b', text: 'y' }] }
  assert.match(draftSizeError(draft, 150), /^Draft not saved: it is too large \(\d+ of 150 characters\)/)
  sync.remoteDelete(draft.notes, 'a')
  assert.equal(draftSizeError(draft, 150), '')
})

test('the page runs the size check again on each of the other copies\' changes (a "too large" copy recovers)', () => {
  const page = require('node:fs').readFileSync(path.join(__dirname, '../src/page/review.js'), 'utf8')
  for (const fn of ['onRemoteNote', 'onRemoteDelete', 'onRemoteGlobal']) {
    const body = page.slice(page.indexOf(`function ${fn}(`), page.indexOf('\n}\n', page.indexOf(`function ${fn}(`)))
    assert.match(body, /recheckSize\(\)/, fn)
  }
  assert.match(page, /function answerDraftRequest\(\)[\s\S]*?saveState\.tooLarge \|\| unsent\.size/)
})
