'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanDraft, isEmpty, formatReview, buildReview, MAX_MESSAGE, MAX_NOTE_TEXT, MAX_GLOBAL } = require('../dist/lib/review')

const sides = { path: 'src/a.ts', mode: 'diff', head: '0123456789abcdef0123456789abcdef01234567', old: 'a', new: 'b' }

test('cleanDraft drops bad notes and caps fields', () => {
  const d = cleanDraft({ global: 'g', notes: [{ from: 3, to: 2 }, { from: 1, to: 2, side: 'weird', text: 't', quote: 'q'.repeat(900) }, 'x'] })
  assert.equal(d.notes.length, 1)
  assert.equal(d.notes[0].side, 'new')
  assert.equal(d.notes[0].quote.length, 500)
  assert.deepEqual(cleanDraft(null), { global: '', notes: [] })
})

test('isEmpty: notes without text do not count', () => {
  assert.equal(isEmpty(cleanDraft({ notes: [{ from: 1, to: 1, text: '  ' }] })), true)
  assert.equal(isEmpty(cleanDraft({ global: 'x' })), false)
})

test('formatReview: header, global, notes in file order, quotes', () => {
  const text = formatReview(
    {
      global: 'Looks fine overall.',
      notes: [
        { from: 12, to: 14, side: 'new', quote: 'a\nb', text: 'Why this?' },
        { from: 3, to: 3, side: 'old', quote: 'gone()', text: 'Keep this call.' },
        { from: 5, to: 5, side: 'new', quote: 'x', text: '' },
      ],
    },
    sides,
  )
  assert.equal(
    text,
    [
      'Review of src/a.ts (changes since the last commit 0123456789ab)',
      'Looks fine overall.',
      '1. Line 3 (old, removed):\n   > gone()\n   Keep this call.',
      '2. Lines 12-14 (new):\n   > a\n   > b\n   Why this?',
    ].join('\n\n'),
  )
  // The send gate refuses text starting with these; the header never does.
  assert.ok(!/^[/!#&]/.test(text))
})

test('formatReview: plain mode has no sides; long reviews shorten quotes first', () => {
  const plain = formatReview({ notes: [{ from: 1, to: 1, text: 'n', quote: 'q' }] }, { path: 'x', mode: 'plain' })
  assert.match(plain, /^Review of x \(the file as it is now, no git diff\)\n\n1\. Line 1:\n/)
  const notes = Array.from({ length: 60 }, (_, i) => ({ from: i + 1, to: i + 1, text: 'note '.repeat(20), quote: 'code '.repeat(100) }))
  const long = formatReview({ notes }, sides)
  assert.ok(long.length <= MAX_MESSAGE)
  assert.match(long, /60\. Line 60/) // every note survives; quotes gave way
})

test('buildReview: cut only when the review is too long even without quotes', () => {
  const fits = buildReview({ notes: [{ from: 1, to: 1, text: 'n', quote: 'code '.repeat(100) }] }, sides)
  assert.equal(fits.cut, false)
  const notes = Array.from({ length: 10 }, (_, i) => ({ from: i + 1, to: i + 1, text: 'x'.repeat(MAX_NOTE_TEXT), quote: '' }))
  const over = buildReview({ notes }, sides)
  assert.equal(over.cut, true)
  assert.ok(over.text.length <= MAX_MESSAGE)
  assert.match(over.text, /\(review cut: too long\)$/)
})

test('the page inputs carry the same caps as cleanDraft', () => {
  // The page cannot require the host lib (it is a bundled browser script), so its copies are checked.
  const fs = require('node:fs')
  const path = require('node:path')
  const page = fs.readFileSync(path.join(__dirname, '../src/page/review.js'), 'utf8')
  const html = fs.readFileSync(path.join(__dirname, '../overlay/review.html'), 'utf8')
  assert.match(page, new RegExp(`const NOTE_MAX = ${MAX_NOTE_TEXT}\\n`))
  assert.match(page, new RegExp(`const GLOBAL_MAX = ${MAX_GLOBAL}\\n`))
  assert.match(html, new RegExp(`id="global"[^>]*maxlength="${MAX_GLOBAL}"`))
  assert.equal(cleanDraft({ global: 'g'.repeat(MAX_GLOBAL + 1), notes: [{ from: 1, to: 1, text: 't'.repeat(MAX_NOTE_TEXT + 1) }] }).notes[0].text.length, MAX_NOTE_TEXT)
})

test('formatReview: an unchanged file says so and drops side labels', () => {
  const t = formatReview({ notes: [{ from: 2, to: 2, side: 'new', text: 'n', quote: 'q' }] }, { ...sides, old: 'a', new: 'a' })
  assert.match(t, /^Review of src\/a\.ts \(unchanged since the last commit 0123456789ab\)\n\n1\. Line 2:\n/)
})

test('draftKey: plain prefix, hashed when the path would exceed the key limit', () => {
  const { draftKey } = require('../dist/lib/review')
  assert.equal(draftKey('src/a.ts'), 'draft:src/a.ts')
  const long = 'd/'.repeat(150) + 'a.ts'
  const k = draftKey(long)
  assert.ok(k.length <= 200)
  assert.equal(k, draftKey(long))
  assert.notEqual(k, draftKey(long + 'x'))
})
