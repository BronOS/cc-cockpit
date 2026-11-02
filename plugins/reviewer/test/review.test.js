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

test('draftProblem: names what cleanDraft would cut, null when it keeps everything', () => {
  const { draftProblem, MAX_NOTES, MAX_QUOTE, MAX_DRAFT_JSON } = require('../dist/lib/review')
  const note = (i) => ({ id: `n${i}`, from: 1, to: 1, quote: '', text: 't' })
  assert.equal(draftProblem({ global: 'g', notes: [note(1)] }), null)
  assert.equal(draftProblem(null), null)
  assert.equal(draftProblem({ notes: Array.from({ length: MAX_NOTES }, (_, i) => note(i)) }), null)
  assert.match(draftProblem({ notes: Array.from({ length: MAX_NOTES + 1 }, (_, i) => note(i)) }), /more than 200 notes/)
  assert.match(draftProblem({ global: 'g'.repeat(MAX_GLOBAL + 1) }), /comment is over/)
  assert.match(draftProblem({ notes: [{ ...note(1), text: 't'.repeat(MAX_NOTE_TEXT + 1) }] }), /note is over/)
  assert.match(draftProblem({ notes: [{ ...note(1), quote: 'q'.repeat(MAX_QUOTE + 1) }] }), /quote is over/)
  // A note with text but no line range was dropped whole; one without text holds nothing.
  assert.match(draftProblem({ notes: [{ ...note(1), from: 0 }] }), /no valid line range/)
  assert.equal(draftProblem({ notes: [{ ...note(1), from: 0, text: ' ' }] }), null)
  // Every field within its cap, the whole still too large to store or post.
  const big = Array.from({ length: 120 }, (_, i) => ({ ...note(i), text: '"'.repeat(MAX_NOTE_TEXT) }))
  assert.ok(JSON.stringify({ notes: big }).length > MAX_DRAFT_JSON)
  assert.match(draftProblem({ notes: big }), /too large/)
})

test('the page enforces the note count and draft size caps of the host', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const { MAX_NOTES, MAX_DRAFT_JSON } = require('../dist/lib/review')
  const page = fs.readFileSync(path.join(__dirname, '../src/page/review.js'), 'utf8')
  const html = fs.readFileSync(path.join(__dirname, '../overlay/review.html'), 'utf8')
  assert.match(page, new RegExp(`const NOTES_MAX = ${MAX_NOTES}\\n`))
  assert.match(page, new RegExp(`const DRAFT_JSON_MAX = ${MAX_DRAFT_JSON}\\n`))
  assert.match(html, new RegExp(`id="notes-limit"[^>]*>${MAX_NOTES} notes`))
  assert.match(html, /id="draft-error"/)
  // Posted at once on every change: a page debounce lost the last keystrokes to a quick Esc.
  assert.doesNotMatch(page, /setTimeout\(\(\) => ccPanel\.post\(\{ type: 'draft'/)
})
