// Claude's changes in the gutter, the page's side with no DOM (src/page/changes.mjs): the hunks of a
// buffer against HEAD's text, and the base's asks: parts joined, a stale answer ignored, no base
// clears the marks, focus asks at most once in a while, the click and its error.
import test from 'node:test'
import assert from 'node:assert/strict'
import { hunksOf, createChanges, FOCUS_MIN_MS, MAX_OLD_LINES, MAX_OLD_CHARS } from '../src/page/changes.mjs'

test('hunksOf: added, modified and deleted lines with their old text', () => {
  const base = 'a\nb\nc\nd\ne\n'
  assert.deepEqual(hunksOf(base, base), [])
  assert.deepEqual(hunksOf(base, 'a\nb\nNEW\nc\nd\ne\n'), [{ kind: 'added', line: 3, count: 1, old: [], oldCount: 0 }])
  assert.deepEqual(hunksOf(base, 'a\nB\nc\nd\ne\n'), [{ kind: 'modified', line: 2, count: 1, old: ['b'], oldCount: 1 }])
  assert.deepEqual(hunksOf(base, 'a\nb\nd\ne\n'), [{ kind: 'deleted', line: 3, count: 0, old: ['c'], oldCount: 1 }])
  // Several in one go, in order of the new text.
  const h = hunksOf(base, 'A\nb\nc\ne\nf\n')
  assert.deepEqual(h.map((x) => [x.kind, x.line, x.count]), [
    ['modified', 1, 1],
    ['deleted', 4, 0],
    ['added', 5, 1],
  ])
})

test('hunksOf: lines removed at the end point past the last line; an emptied or new text', () => {
  assert.deepEqual(hunksOf('a\nb\nc\n', 'a\n'), [{ kind: 'deleted', line: 2, count: 0, old: ['b', 'c'], oldCount: 2 }])
  assert.deepEqual(hunksOf('a\nb\n', ''), [{ kind: 'deleted', line: 1, count: 0, old: ['a', 'b'], oldCount: 2 }])
  assert.deepEqual(hunksOf('', 'a\nb\n'), [{ kind: 'added', line: 1, count: 2, old: [], oldCount: 0 }])
  // A final newline added or dropped changes the last line, as git sees it.
  assert.deepEqual(hunksOf('a\nb', 'a\nb\n'), [{ kind: 'modified', line: 2, count: 1, old: ['b'], oldCount: 1 }])
})

test('hunksOf: the old lines kept for the hover are capped', () => {
  const base = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n'
  const [h] = hunksOf(base, 'only\n')
  assert.equal(h.kind, 'modified')
  assert.equal(h.old.length, MAX_OLD_LINES)
  assert.equal(h.oldCount, 100)
  const [long] = hunksOf('x'.repeat(5000) + '\n', 'y\n')
  assert.equal(long.old[0].length, MAX_OLD_CHARS + 1)
  assert.ok(long.old[0].endsWith('…'))
})

function makeChanges() {
  const posted = []
  const events = []
  const clock = { t: 100000 }
  const c = createChanges({ post: (m) => posted.push(m), onBase: () => events.push('base'), onError: (m) => events.push(['error', m]) }, { now: () => clock.t })
  return { c, posted, events, clock }
}

test('the base arrives in parts under the req it asked; a stale answer is ignored', () => {
  const { c, posted, events } = makeChanges()
  assert.equal(c.base(), null)
  c.connect()
  assert.deepEqual(posted, [{ t: 'git-base', req: 1 }])
  c.refresh()
  assert.deepEqual(posted[1], { t: 'git-base', req: 2 })
  // The answer to req 1 is ours but old.
  assert.equal(c.receive({ t: 'git-base', req: 1, has: true, part: 0, parts: 1, text: 'old\n' }), true)
  assert.equal(c.base(), null)
  // Parts out of order are joined in order.
  c.receive({ t: 'git-base', req: 2, has: true, part: 1, parts: 2, text: 'tail\n' })
  assert.equal(c.base(), null)
  c.receive({ t: 'git-base', req: 2, has: true, part: 0, parts: 2, text: 'head\n' })
  assert.equal(c.base(), 'head\ntail\n')
  assert.deepEqual(events, ['base'])
  // The same text again redraws nothing.
  c.refresh()
  c.receive({ t: 'git-base', req: 3, has: true, part: 0, parts: 1, text: 'head\ntail\n' })
  assert.deepEqual(events, ['base'])
})

test('has:false clears the base (a checkout made the file untracked); other messages are not ours', () => {
  const { c, events } = makeChanges()
  c.refresh()
  c.receive({ t: 'git-base', req: 1, has: true, part: 0, parts: 1, text: 'x\n' })
  c.refresh()
  c.receive({ t: 'git-base', req: 2, has: false })
  assert.equal(c.base(), null)
  assert.deepEqual(events, ['base', 'base'])
  // None from the start: nothing to redraw.
  c.refresh()
  c.receive({ t: 'git-base', req: 3, has: false })
  assert.deepEqual(events, ['base', 'base'])
  for (const m of [{ t: 'file' }, null, 'x', { t: 'lsp-status' }]) assert.equal(c.receive(m), false)
  // Malformed: a base with no text is dropped, never taken as empty.
  c.refresh()
  c.receive({ t: 'git-base', req: 4, has: true, part: 0, parts: 1 })
  assert.equal(c.base(), null)
})

test('focus asks again at most once per FOCUS_MIN_MS', () => {
  const { c, posted, clock } = makeChanges()
  c.focus()
  assert.equal(posted.length, 1)
  clock.t += FOCUS_MIN_MS - 1
  c.focus()
  assert.equal(posted.length, 1)
  clock.t += 1
  c.focus()
  assert.equal(posted.length, 2)
})

test('a click posts git-review; the host\'s error is shown', () => {
  const { c, posted, events } = makeChanges()
  c.review()
  assert.deepEqual(posted, [{ t: 'git-review' }])
  assert.equal(c.receive({ t: 'git-review-error', message: 'Could not open the diff: x' }), true)
  assert.deepEqual(events, [['error', 'Could not open the diff: x']])
})
