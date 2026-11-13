// The merge's conflict regions (src/page/conflicts.mjs) on a bare EditorState: how each region maps
// through the person's typing and what each resolve leaves in the text. This is where a wrong mapping
// loses typed text (Take Claude's once deleted what was typed on the line after a region).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import { history, undo } from '@codemirror/commands'
import { conflictField, setConflicts, resolveSpec, mapConflicts } from '../src/page/conflicts.mjs'

const field = conflictField(() => Decoration.none)

/** A state with `doc` and the conflicts `list` set, plus the undo history. */
function stateWith(doc, list) {
  const s = EditorState.create({ doc, extensions: [field, history()] })
  return s.update({ effects: setConflicts.of(list) }).state
}

const listOf = (s) => s.field(field).list.map(({ id, from, to }) => ({ id, from, to }))
const type = (s, at, text) => s.update({ changes: { from: at, insert: text }, userEvent: 'input.type' }).state
const resolve = (s, id, how) => s.update(resolveSpec(s, field, id, how)).state

// "a\n" | "mine\n" (2..7) | "z\n": one region over a whole line, Claude's version "theirs\n".
const DOC = 'a\nmine\nz\n'
const ONE = [{ id: 1, from: 2, to: 7, theirs: 'theirs\n' }]

test('typing inside a region grows it', () => {
  const s = type(stateWith(DOC, ONE), 4, 'XY')
  assert.deepEqual(listOf(s), [{ id: 1, from: 2, to: 9 }])
})

test('typing at the region start joins it (from maps backward)', () => {
  const s = type(stateWith(DOC, ONE), 2, '>>')
  assert.deepEqual(listOf(s), [{ id: 1, from: 2, to: 9 }])
  assert.equal(s.doc.sliceString(2, 9), '>>mine\n')
})

test('a region ending at a line start does not take in what is typed at the start of the next line', () => {
  const s = type(stateWith(DOC, ONE), 7, 'typed ')
  assert.deepEqual(listOf(s), [{ id: 1, from: 2, to: 7 }])
  // Take Claude's then replaces only my region: the typing on the next line survives.
  const r = resolve(s, 1, 'theirs')
  assert.equal(r.doc.toString(), 'a\ntheirs\ntyped z\n')
  assert.deepEqual(listOf(r), [])
})

test('a region not ending in a newline grows with typing at its end (to maps forward)', () => {
  // The last line with no newline: "a\nmine" with the region over "mine".
  const s = type(stateWith('a\nmine', [{ id: 1, from: 2, to: 6, theirs: 'theirs' }]), 6, '!')
  assert.deepEqual(listOf(s), [{ id: 1, from: 2, to: 7 }])
  assert.equal(resolve(s, 1, 'theirs').doc.toString(), 'a\ntheirs')
})

test('typing at an empty region (I removed the lines) joins it, and Keep mine keeps it', () => {
  // from maps backward, to forward: typed text at the point lands inside the region.
  const s = type(stateWith('a\nz\n', [{ id: 1, from: 2, to: 2, theirs: 'theirs\n' }]), 2, 'new\n')
  assert.deepEqual(listOf(s), [{ id: 1, from: 2, to: 6 }])
  assert.equal(resolve(s, 1, 'mine').doc.toString(), 'a\nnew\nz\n')
})

test('mapConflicts moves a later region by text inserted before it', () => {
  const s = stateWith(DOC, ONE)
  const tr = s.update({ changes: { from: 0, insert: 'top\n' } })
  assert.deepEqual(
    mapConflicts(ONE, tr.changes, s.doc).map(({ from, to }) => [from, to]),
    [[6, 11]]
  )
})

test("Keep mine leaves the text and drops the region; Take Claude's replaces it; Keep both appends Claude's", () => {
  const s = stateWith(DOC, ONE)
  const mine = resolve(s, 1, 'mine')
  assert.equal(mine.doc.toString(), DOC)
  assert.deepEqual(listOf(mine), [])
  assert.equal(resolve(s, 1, 'theirs').doc.toString(), 'a\ntheirs\nz\n')
  assert.equal(resolve(s, 1, 'both').doc.toString(), 'a\nmine\ntheirs\nz\n')
})

test('Keep both after a region with no final newline puts Claude\'s on its own line', () => {
  const s = stateWith('a\nmine', [{ id: 1, from: 2, to: 6, theirs: 'theirs' }])
  assert.equal(resolve(s, 1, 'both').doc.toString(), 'a\nmine\ntheirs')
})

test("Take Claude's on one region replaces my typing there and leaves the other region, mapped", () => {
  const two = [
    { id: 1, from: 2, to: 7, theirs: 'T1\n' },
    { id: 2, from: 9, to: 9, theirs: 'T2\n' },
  ]
  let s = stateWith(DOC, two)
  s = type(s, 4, 'X')
  // One region resolved: the other stays and is mapped through the change.
  s = resolve(s, 1, 'theirs')
  assert.equal(s.doc.toString(), 'a\nT1\nz\n')
  assert.deepEqual(listOf(s), [{ id: 2, from: 7, to: 7 }])
})

test('Keep all / Take all resolve every region at once (id null)', () => {
  const two = [
    { id: 1, from: 2, to: 7, theirs: 'T1\n' },
    { id: 2, from: 9, to: 9, theirs: 'T2\n' },
  ]
  const s = stateWith(DOC, two)
  const all = resolve(s, null, 'theirs')
  assert.equal(all.doc.toString(), 'a\nT1\nz\nT2\n')
  assert.deepEqual(listOf(all), [])
  const mine = resolve(s, null, 'mine')
  assert.equal(mine.doc.toString(), DOC)
  assert.deepEqual(listOf(mine), [])
})

test('an unknown id or no conflicts resolves nothing', () => {
  assert.equal(resolveSpec(stateWith(DOC, ONE), field, 99, 'theirs'), null)
  assert.equal(resolveSpec(stateWith(DOC, []), field, null, 'mine'), null)
})

test('a resolve is the person\'s edit: undo brings my text back', () => {
  const s = stateWith(DOC, ONE)
  const tr = s.update(resolveSpec(s, field, 1, 'theirs'))
  assert.equal(tr.isUserEvent('input'), true)
  let after = tr.state
  assert.equal(after.doc.toString(), 'a\ntheirs\nz\n')
  // undo is a command over a view-like target; a fake dispatch is enough for a bare state.
  undo({ state: after, dispatch: (t) => (after = t.state) })
  assert.equal(after.doc.toString(), DOC)
  // The region stays resolved: undo restores the text, not the choice (nothing is lost either way).
  assert.deepEqual(listOf(after), [])
})
