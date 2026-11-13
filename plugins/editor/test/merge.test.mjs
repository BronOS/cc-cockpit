// The file tab page's line diff and three-way merge (src/page/merge.mjs): what a reload applies as
// line edits, and how a dirty buffer takes a change made on disk (design-editor.md §2).
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitLines, diffLines, lineChanges, merge3, mergedText, conflictLayout, keepBothText, MAX_EDITS } from '../src/page/merge.mjs'

/** Applies lineChanges' edits (in offsets of the old text) the way CodeMirror does. */
function apply(text, changes) {
  let out = ''
  let at = 0
  for (const c of changes) {
    assert.ok(c.from >= at, 'changes are in order and do not overlap')
    out += text.slice(at, c.from) + c.insert
    at = c.to
  }
  return out + text.slice(at)
}

test('splitLines keeps each line its newline, and the last one without', () => {
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('a'), ['a'])
  assert.deepEqual(splitLines('a\n'), ['a\n'])
  assert.deepEqual(splitLines('a\n\nb'), ['a\n', '\n', 'b'])
})

test('diffLines: the changed regions only, with insertions and deletions', () => {
  const a = splitLines('1\n2\n3\n4\n5\n')
  assert.deepEqual(diffLines(a, a), [])
  assert.deepEqual(diffLines(a, splitLines('1\n2\nX\n4\n5\n')), [{ aS: 2, aE: 3, bS: 2, bE: 3 }])
  assert.deepEqual(diffLines(a, splitLines('1\n2\n3\nnew\n4\n5\n')), [{ aS: 3, aE: 3, bS: 3, bE: 4 }])
  assert.deepEqual(diffLines(a, splitLines('1\n4\n5\n')), [{ aS: 1, aE: 3, bS: 1, bE: 1 }])
  assert.deepEqual(diffLines(a, splitLines('0\n1\n2\n3\n4\n5\n6\n')), [
    { aS: 0, aE: 0, bS: 0, bE: 1 },
    { aS: 5, aE: 5, bS: 6, bE: 7 },
  ])
  assert.deepEqual(diffLines([], splitLines('x\n')), [{ aS: 0, aE: 0, bS: 0, bE: 1 }])
})

test('lineChanges turns one text into the other, touching only the changed lines', () => {
  const pairs = [
    ['', 'a\n'],
    ['a\n', ''],
    ['a\nb\nc\n', 'a\nB\nc\n'],
    ['a\nb\nc', 'a\nb\nc\n'],
    ['x\ny\nz\n', 'z\ny\nx\n'],
    ['one\ntwo\nthree\nfour\n', 'zero\none\nthree\nfour\nfive\n'],
  ]
  for (const [from, to] of pairs) assert.equal(apply(from, lineChanges(from, to)), to, `${JSON.stringify(from)} -> ${JSON.stringify(to)}`)
  assert.deepEqual(lineChanges('a\nb\nc\n', 'a\nB\nc\n'), [{ from: 2, to: 4, insert: 'B\n' }])
  assert.deepEqual(lineChanges('same', 'same'), [])
})

test('a diff past MAX_EDITS gives up as one change and stays right', () => {
  const n = MAX_EDITS + 50
  const from = Array.from({ length: n }, (_, i) => `a${i}\n`).join('')
  const to = Array.from({ length: n }, (_, i) => `b${i}\n`).join('')
  const changes = lineChanges(`head\n${from}tail\n`, `head\n${to}tail\n`)
  assert.equal(changes.length, 1)
  assert.equal(apply(`head\n${from}tail\n`, changes), `head\n${to}tail\n`)
})

test('clean merge: changes on different lines of both sides are both kept', () => {
  const base = 'a\nb\nc\nd\ne\n'
  const r = merge3(base, 'a\nB\nc\nd\ne\n', 'a\nb\nc\nd\nE\n')
  assert.equal(r.conflicts, 0)
  assert.equal(mergedText(r.chunks), 'a\nB\nc\nd\nE\n')
  // One side only: that side.
  assert.equal(mergedText(merge3(base, base, 'x\n' + base).chunks), 'x\n' + base)
  assert.equal(mergedText(merge3(base, base + 'mine\n', base).chunks), base + 'mine\n')
  // Insertions at both ends by different sides.
  const both = merge3(base, 'top\n' + base, base + 'bottom\n')
  assert.equal(both.conflicts, 0)
  assert.equal(mergedText(both.chunks), 'top\n' + base + 'bottom\n')
})

test('identical change on both sides is not a conflict', () => {
  const r = merge3('a\nb\nc\n', 'a\nB\nc\nmine\n', 'a\nB\nc\n')
  assert.equal(r.conflicts, 0)
  assert.equal(mergedText(r.chunks), 'a\nB\nc\nmine\n')
  const same = merge3('a\n', 'b\n', 'b\n')
  assert.equal(same.conflicts, 0)
  assert.equal(mergedText(same.chunks), 'b\n')
})

test('overlapping changes conflict, with each side and the base text of the region', () => {
  const r = merge3('a\nb\nc\n', 'a\nmine\nc\n', 'a\ntheirs\nc\n')
  assert.equal(r.conflicts, 1)
  assert.deepEqual(r.chunks, [{ ok: 'a\n' }, { base: 'b\n', mine: 'mine\n', theirs: 'theirs\n' }, { ok: 'c\n' }])
  // Touching changes (adjacent lines) conflict too: rarely independent in code.
  const touch = merge3('a\nb\nc\nd\n', 'a\nB\nc\nd\n', 'a\nb\nC\nd\n')
  assert.equal(touch.conflicts, 1)
  assert.deepEqual(touch.chunks[1], { base: 'b\nc\n', mine: 'B\nc\n', theirs: 'b\nC\n' })
  // Both inserting different lines at the same place.
  const ins = merge3('a\nz\n', 'a\nmine\nz\n', 'a\ntheirs\nz\n')
  assert.deepEqual(ins.chunks, [{ ok: 'a\n' }, { base: '', mine: 'mine\n', theirs: 'theirs\n' }, { ok: 'z\n' }])
  // Mine deleted a line theirs changed.
  const del = merge3('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n')
  assert.deepEqual(del.chunks[1], { base: 'b\n', mine: '', theirs: 'B\n' })
})

test('a last line with no newline: adding one is a change, merged like any other', () => {
  assert.equal(mergedText(merge3('a\nx\nb', 'A\nx\nb', 'a\nx\nb\n').chunks), 'A\nx\nb\n')
  // Both extending the last line: the same line changed on both sides.
  assert.equal(merge3('a', 'a\nmine', 'a\ntheirs').conflicts, 1)
})

test('conflictLayout: my version in the text, where each region is, and theirs beside it', () => {
  const r = merge3('a\nb\nc\nd\ne\n', 'a\nB1\nc\nd\nE1\n', 'a\nB2\nc\nd\nE2\n')
  const l = conflictLayout(r.chunks)
  assert.equal(l.text, 'a\nB1\nc\nd\nE1\n')
  assert.deepEqual(
    l.conflicts.map((c) => [l.text.slice(c.from, c.to), c.theirs]),
    [
      ['B1\n', 'B2\n'],
      ['E1\n', 'E2\n'],
    ]
  )
  // An empty mine is a point.
  const del = conflictLayout(merge3('a\nb\nc\n', 'a\nc\n', 'a\nB\nc\n').chunks)
  assert.equal(del.text, 'a\nc\n')
  assert.deepEqual(del.conflicts, [{ from: 2, to: 2, mine: '', theirs: 'B\n' }])
})

test('keepBothText: mine then theirs, a line break between when mine has none at the end', () => {
  assert.equal(keepBothText('m\n', 't\n'), 'm\nt\n')
  assert.equal(keepBothText('m', 't'), 'm\nt')
  assert.equal(keepBothText('', 't\n'), 't\n')
  assert.equal(keepBothText('m', ''), 'm')
})

test('a merge never drops a line of either side when it is clean (random edits)', () => {
  // Deterministic pseudo-random edits on separate lines of a 40-line base.
  let seed = 7
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
  for (let round = 0; round < 50; round++) {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`)
    const mine = [...base]
    const theirs = [...base]
    // Mine edits even lines in the first half, theirs odd lines in the second: never touching.
    const mi = 2 * rnd(8)
    const ti = 25 + 2 * rnd(7)
    mine[mi] = `mine ${round}\n`
    theirs[ti] = `theirs ${round}\n`
    const r = merge3(base.join(''), mine.join(''), theirs.join(''))
    assert.equal(r.conflicts, 0)
    const out = mergedText(r.chunks)
    assert.ok(out.includes(`mine ${round}\n`) && out.includes(`theirs ${round}\n`))
    assert.equal(splitLines(out).length, 40)
  }
})

test('lines both sides carry at a conflict edge stay out of it, so Keep both writes them once', () => {
  const r = merge3('a\nb\nc', 'a\nb\nc\nd', 'a\nb\nc\n')
  assert.equal(r.conflicts, 1)
  const joined = r.chunks.map((x) => ('ok' in x ? x.ok : keepBothText(x.mine, x.theirs))).join('')
  assert.equal(joined.split('c\n').length - 1, 1)
})

test('both sides insert at the very start of the file: one conflict, shared lines outside it', () => {
  const r = merge3('x\n', 'm\nx\n', 't\nx\n')
  assert.equal(r.conflicts, 1)
  const layout = conflictLayout(r.chunks)
  assert.equal(layout.text, 'm\nx\n')
  assert.equal(layout.conflicts[0].theirs, 't\n')
})

test('a conflict at EOF without a final newline, then Keep both', () => {
  const r = merge3('x\ny', 'x\nY1', 'x\nY2')
  const c = r.chunks.find((x) => !('ok' in x))
  assert.equal(keepBothText(c.mine, c.theirs), 'Y1\nY2')
})
