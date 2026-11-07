'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanDraft, isEmpty, formatReview, buildReview, MAX_MESSAGE, MAX_NOTE_TEXT, MAX_GLOBAL } = require('../dist/lib/review')
const review = require('../dist/lib/review')

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

test('annotateInput: checks and caps every field', () => {
  const { annotateInput, MAX_ANNOTATE_TITLE, MAX_ANNOTATE_TEXT, MAX_ANNOTATE_KEY } = require('../dist/lib/review')
  const ok = annotateInput({ title: '  PROJ-1:\n Fix\tlogin ', text: '', url: 'http://jira.local/browse/PROJ-1', key: 'jira:PROJ-1', tabId: 't1' })
  assert.deepEqual(ok, { title: 'PROJ-1: Fix login', text: '', html: null, aside: null, assets: [], url: 'http://jira.local/browse/PROJ-1', key: 'jira:PROJ-1', tabId: 't1', label: 'PROJ-1: Fix login', urlLabel: null, companion: null, start: 'top', type: null, kind: null, originals: null, view: null })
  // start: where the main document opens; 'top' (default) or 'end'.
  assert.equal(annotateInput({ title: 't', html: '<p>x</p>', start: 'end' }).start, 'end')
  assert.equal(annotateInput({ title: 't', html: '<p>x</p>', start: null }).start, 'top')
  assert.throws(() => annotateInput({ title: 't', html: '<p>x</p>', start: 'middle' }), /start must be 'top' or 'end'/)
  // Title: one line, 1-200 chars.
  assert.equal(annotateInput({ title: 't'.repeat(MAX_ANNOTATE_TITLE), text: '' }).title.length, MAX_ANNOTATE_TITLE)
  assert.throws(() => annotateInput({ title: 't'.repeat(MAX_ANNOTATE_TITLE + 1), text: '' }), /title is over 200/)
  assert.throws(() => annotateInput({ title: ' \n ', text: '' }), /title must not be empty/)
  assert.throws(() => annotateInput({ title: 5, text: '' }), /title must be a string/)
  // Text: at most 400 KiB of UTF-8, no NUL.
  assert.equal(annotateInput({ title: 't', text: 'x'.repeat(MAX_ANNOTATE_TEXT) }).text.length, MAX_ANNOTATE_TEXT)
  assert.throws(() => annotateInput({ title: 't', text: 'é'.repeat(MAX_ANNOTATE_TEXT / 2 + 1) }), /larger than 400 KiB/)
  assert.throws(() => annotateInput({ title: 't', text: 'a\0b' }), /NUL/)
  assert.throws(() => annotateInput({ title: 't' }), /text must be a string \(or pass html\)/)
  // URL: http(s) only, no whitespace (it goes into the message as is).
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://x/y']) {
    assert.throws(() => annotateInput({ title: 't', text: '', url }), /http or https/, url)
  }
  assert.throws(() => annotateInput({ title: 't', text: '', url: 'https://x/a b' }), /whitespace/)
  assert.throws(() => annotateInput({ title: 't', text: '', url: 'https://x/\n# hi' }), /whitespace/)
  assert.throws(() => annotateInput({ title: 't', text: '', url: 'not a url' }), /whitespace|not a valid/)
  assert.throws(() => annotateInput({ title: 't', text: '', url: 'nourl' }), /not a valid URL/)
  assert.equal(annotateInput({ title: 't', text: '', url: null }).url, null)
  // Key: a safe charset, 1-200 chars; absent, it comes from the title (same title, same key).
  assert.equal(annotateInput({ title: 't', text: '', key: 'k'.repeat(MAX_ANNOTATE_KEY) }).key.length, MAX_ANNOTATE_KEY)
  assert.throws(() => annotateInput({ title: 't', text: '', key: 'k'.repeat(MAX_ANNOTATE_KEY + 1) }), /key must be 1-200/)
  assert.throws(() => annotateInput({ title: 't', text: '', key: '' }), /key must be 1-200/)
  for (const key of ['a b', 'a"b', "a'b", 'a\nb', 'ключ']) {
    assert.throws(() => annotateInput({ title: 't', text: '', key }), /key may only use/, key)
  }
  const a = annotateInput({ title: 'Same', text: '' }).key
  assert.match(a, /^title:[0-9a-f]{32}$/)
  assert.equal(annotateInput({ title: 'Same', text: 'other' }).key, a)
  assert.notEqual(annotateInput({ title: 'Other', text: '' }).key, a)
  assert.throws(() => annotateInput({ title: 't', text: '', tabId: 7 }), /tabId must be a string/)
  // type: the caller's overlay type, checked as main checks it, a clean copy.
  const data = { source: 'example.mail', id: 't-1' }
  const typed = annotateInput({ title: 't', text: '', type: { name: 'inbox-item', data } })
  assert.deepEqual(typed.type, { name: 'inbox-item', data })
  assert.notEqual(typed.type.data, data)
  assert.deepEqual(annotateInput({ title: 't', text: '', type: { name: 'x' } }).type, { name: 'x', data: null })
  for (const bad of ['file', [], { name: '' }, { name: '1a' }, { name: 'A' }, { name: 'a'.repeat(65) }]) {
    assert.throws(() => annotateInput({ title: 't', text: '', type: bad }), /type/)
  }
  assert.throws(() => annotateInput({ title: 't', text: '', type: { name: 'a', data: 'x'.repeat(4095) } }), /type\.data is over 4096/)
  assert.equal(annotateInput({ title: 't', text: '', type: { name: 'a', data: 'x'.repeat(4094) } }).type.data.length, 4094)
  assert.throws(() => annotateInput({ title: 't', text: '', type: { name: 'a', data: () => 1 } }), /type\.data must be plain JSON/)
  assert.throws(() => annotateInput('PROJ-1'), /annotate takes/)
})

test('annotateInput: a companion is checked like the main document, with html only, and shares the asset budget', () => {
  const { annotateInput, MAX_ANNOTATE_TITLE, MAX_ANNOTATE_HTML, MAX_ANNOTATE_ASIDE, MAX_ASSETS, MAX_ASSET_CHARS, MAX_ANNOTATE_LABEL, MAX_ANNOTATE_URL_LABEL } = require('../dist/lib/review')
  const png = (n) => 'data:image/png;base64,' + 'A'.repeat(n)
  const asset = (id, n = 4) => ({ id, mime: 'image/png', dataUrl: png(n) })
  const main = { title: 'Mail', html: '<p>m</p>' }
  const ok = annotateInput({ ...main, assets: [asset('a')], companion: { title: '  PROJ-1:\n Fix ', html: '<h1>PROJ-1</h1>', facts: '<dl class="facts"></dl>', url: 'https://x.example/browse/PROJ-1', assets: [{ ...asset('b'), name: 'b.png' }] } })
  assert.deepEqual(ok.companion, {
    title: 'PROJ-1: Fix',
    html: '<h1>PROJ-1</h1>',
    facts: '<dl class="facts"></dl>',
    url: 'https://x.example/browse/PROJ-1',
    assets: [{ id: 'b', name: 'b.png', mime: 'image/png', dataUrl: png(4) }],
    label: 'PROJ-1: Fix',
    urlLabel: null,
  })
  // Optional parts: absent or empty is none.
  assert.deepEqual(annotateInput({ ...main, companion: { title: 'C', html: '', facts: '' } }).companion, { title: 'C', html: '', facts: null, url: null, assets: [], label: 'C', urlLabel: null })
  // The header bars' labels: plain text made one line and bounded; a label defaults to the title, cut.
  const labelled = annotateInput({ ...main, label: ' Mail ', urlLabel: 'Example\nMail', companion: { title: 'C', html: '', label: 'Jira · PROJ-1', urlLabel: 'Jira' } })
  assert.deepEqual([labelled.label, labelled.urlLabel, labelled.companion.label, labelled.companion.urlLabel], ['Mail', 'Example Mail', 'Jira · PROJ-1', 'Jira'])
  const long = annotateInput({ title: 'T'.repeat(100), html: '', companion: { title: 'C'.repeat(100), html: '' } })
  assert.equal(long.label, 'T'.repeat(MAX_ANNOTATE_LABEL - 1) + '…')
  assert.equal(long.companion.label, 'C'.repeat(MAX_ANNOTATE_LABEL - 1) + '…')
  assert.throws(() => annotateInput({ ...main, label: 'x'.repeat(MAX_ANNOTATE_LABEL + 1) }), /label is over 60 characters/)
  assert.throws(() => annotateInput({ ...main, urlLabel: 'x'.repeat(MAX_ANNOTATE_URL_LABEL + 1) }), /urlLabel is over 30 characters/)
  assert.throws(() => annotateInput({ ...main, label: ' ' }), /label must not be empty/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', label: 5 } }), /companion\.label must be a string/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', urlLabel: '' } }), /companion\.urlLabel must not be empty/)
  assert.equal(annotateInput({ ...main, companion: null }).companion, null)
  // With html only, and an object with a title and html.
  assert.throws(() => annotateInput({ title: 't', text: 'x', companion: { title: 'C', html: '' } }), /companion goes with html, not text/)
  assert.throws(() => annotateInput({ ...main, companion: 'PROJ-1' }), /companion must be \{ title, html/)
  assert.throws(() => annotateInput({ ...main, companion: [] }), /companion must be \{ title, html/)
  assert.throws(() => annotateInput({ ...main, companion: { html: '' } }), /companion\.title must be a string/)
  assert.throws(() => annotateInput({ ...main, companion: { title: ' ', html: '' } }), /companion\.title must not be empty/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 't'.repeat(MAX_ANNOTATE_TITLE + 1), html: '' } }), /companion\.title is over 200/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C' } }), /companion\.html must be a string/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: 'a\0' } }), /companion\.html contains a NUL/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: 'x'.repeat(MAX_ANNOTATE_HTML + 1) } }), /companion\.html is larger than 2 MiB/)
  assert.equal(annotateInput({ ...main, companion: { title: 'C', html: 'x'.repeat(MAX_ANNOTATE_HTML) } }).companion.html.length, MAX_ANNOTATE_HTML)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', facts: 'a'.repeat(MAX_ANNOTATE_ASIDE + 1) } }), /companion\.facts is over 100000/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', facts: 5 } }), /companion\.facts must be a string of HTML/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', url: 'javascript:x' } }), /companion\.url must be http or https/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', url: 'https://x/a b' } }), /companion\.url must not contain whitespace/)
  // Assets: one id namespace and one budget (30 and 8 MiB) for both documents.
  assert.throws(() => annotateInput({ ...main, assets: [asset('a')], companion: { title: 'C', html: '', assets: [asset('a')] } }), /companion\.assets\[0\]\.id a is used twice \(the ids of assets and companion\.assets are one namespace\)/)
  const many = (n, p) => Array.from({ length: n }, (_, i) => asset(`${p}${i}`))
  assert.equal(annotateInput({ ...main, assets: many(20, 'm'), companion: { title: 'C', html: '', assets: many(MAX_ASSETS - 20, 'c') } }).companion.assets.length, MAX_ASSETS - 20)
  assert.throws(() => annotateInput({ ...main, assets: many(20, 'm'), companion: { title: 'C', html: '', assets: many(MAX_ASSETS - 19, 'c') } }), /at most 30 assets \(assets and companion\.assets together\)/)
  const big = (id) => ({ id, mime: 'image/png', dataUrl: png(MAX_ASSET_CHARS - 22) })
  const five = ['m1', 'm2', 'm3', 'm4', 'm5'].map(big)
  assert.equal(annotateInput({ ...main, assets: five, companion: { title: 'C', html: '', assets: [big('c1'), big('c2'), big('c3')] } }).companion.assets.length, 3)
  assert.throws(() => annotateInput({ ...main, assets: five, companion: { title: 'C', html: '', assets: [big('c1'), big('c2'), big('c3'), big('c4')] } }), /assets are over 8 MiB in all \(assets and companion\.assets together\)/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', assets: [{ id: 'x', mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AA' }] } }), /companion\.assets\[0\]\.mime must be one of/)
  assert.throws(() => annotateInput({ ...main, companion: { title: 'C', html: '', assets: {} } }), /companion\.assets must be an array/)
  // The main document's own messages are unchanged.
  assert.throws(() => annotateInput({ ...main, assets: many(MAX_ASSETS + 1, 'm') }), /at most 30 assets$/)
})

test('buildAnnotation: with a companion the head names it and its notes say they are in it, after the main ones', () => {
  const { buildAnnotation, cleanDraft } = require('../dist/lib/review')
  const anchor = (at) => ({ prefix: '', suffix: '', occurrence: 0, length: 5, at })
  const draft = {
    global: '',
    notes: [
      { id: 'c', quote: 'issue', anchor: anchor(0), text: 'In the issue.', doc: 'companion' },
      { id: 'm', quote: 'mail.', anchor: anchor(40), text: 'In the mail.' },
      { id: 'e', quote: '', anchor: anchor(9), text: 'Whole issue.', doc: 'companion' },
    ],
  }
  // cleanDraft keeps `doc` only as 'companion'.
  assert.deepEqual(cleanDraft({ notes: [{ ...draft.notes[0], doc: 'other' }] }).notes[0].doc, undefined)
  assert.equal(cleanDraft(draft).notes[0].doc, 'companion')
  const a = { title: 'Re: login', url: 'https://mail.example/1', companion: { title: 'PROJ-1: Fix login', url: 'https://x.example/browse/PROJ-1' } }
  assert.equal(
    buildAnnotation(draft, a).text,
    'About Re: login (https://mail.example/1), with PROJ-1: Fix login (https://x.example/browse/PROJ-1) beside it\n\n' +
      '1. On «mail.»: In the mail.\n\n2. In PROJ-1: Fix login, on «issue»: In the issue.\n\n3. In PROJ-1: Fix login, on the text: Whole issue.',
  )
  // A companion note with no companion this time (the caller sent none): it still says where it was.
  assert.match(buildAnnotation(draft, { title: 'Re: login', url: null }).text, /^About Re: login\n\n1\. On «mail\.»: In the mail\.\n\n2\. In the document beside it, on «issue»/)
})

test('annotateInput: aside is optional HTML of at most 100,000 characters, with text or html', () => {
  const { annotateInput, MAX_ANNOTATE_ASIDE } = require('../dist/lib/review')
  assert.equal(MAX_ANNOTATE_ASIDE, 100000)
  assert.equal(annotateInput({ title: 't', text: '', aside: '<dl class="facts"></dl>' }).aside, '<dl class="facts"></dl>')
  assert.equal(annotateInput({ title: 't', html: '<p>x</p>', aside: 'a'.repeat(MAX_ANNOTATE_ASIDE) }).aside.length, MAX_ANNOTATE_ASIDE)
  assert.equal(annotateInput({ title: 't', text: '', aside: null }).aside, null)
  assert.equal(annotateInput({ title: 't', text: '', aside: '' }).aside, null) // nothing to show: no column
  assert.throws(() => annotateInput({ title: 't', text: '', aside: 'a'.repeat(MAX_ANNOTATE_ASIDE + 1) }), /aside is over 100000 characters/)
  assert.throws(() => annotateInput({ title: 't', text: '', aside: { html: 'x' } }), /aside must be a string of HTML/)
  assert.throws(() => annotateInput({ title: 't', text: '', aside: 5 }), /aside must be a string of HTML/)
  assert.throws(() => annotateInput({ title: 't', text: '', aside: 'a\0b' }), /aside contains a NUL/)
})

test('annotationKey: its own namespace, never a file draft key; hashed past the key limit', () => {
  const { annotationKey, draftKey } = require('../dist/lib/review')
  assert.equal(annotationKey('jira:PROJ-1'), 'annotate:jira:PROJ-1')
  assert.ok(!annotationKey('x').startsWith('draft:'))
  assert.notEqual(annotationKey('a.js'), draftKey('a.js'))
  const long = 'k'.repeat(200)
  const k = annotationKey(long)
  assert.ok(k.length <= 200 && k.startsWith('annotate:#'))
  assert.equal(k, annotationKey(long))
  assert.notEqual(k, annotationKey(long.slice(1)))
})

test('buildAnnotation: "About <title> (<url>)", the comment, numbered notes without sides', () => {
  const { buildAnnotation } = require('../dist/lib/review')
  const draft = {
    global: 'Plan first.',
    notes: [
      { from: 7, to: 7, side: 'old', quote: 'acceptance', text: 'Which ones?' },
      { from: 2, to: 4, side: 'new', quote: 'x\ny', text: 'Too vague.' },
    ],
  }
  const { text, cut } = buildAnnotation(draft, { title: 'PROJ-1 Fix login', url: 'https://x/browse/PROJ-1' })
  assert.equal(cut, false)
  assert.equal(
    text,
    ['About PROJ-1 Fix login (https://x/browse/PROJ-1)', 'Plan first.', '1. Lines 2-4:\n   > x\n   > y\n   Too vague.', '2. Line 7:\n   > acceptance\n   Which ones?'].join('\n\n'),
  )
  assert.equal(buildAnnotation({ global: 'g' }, { title: 'T', url: null }).text, 'About T\n\ng')
  // A title the send gate would refuse at the start cannot get there: "About" always comes first.
  for (const title of ['/clear', '!rm', '# heading', '&bg']) {
    assert.ok(buildAnnotation({ global: 'g' }, { title }).text.startsWith('About '))
  }
})

// ---- HTML mode ----

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

test('annotateInput: exactly one of text and html; html is capped at 2 MiB of UTF-8', () => {
  const { annotateInput, MAX_ANNOTATE_HTML } = require('../dist/lib/review')
  const a = annotateInput({ title: 't', html: '<p>x</p>' })
  assert.equal(a.html, '<p>x</p>')
  assert.equal(a.text, null)
  assert.deepEqual(a.assets, [])
  assert.throws(() => annotateInput({ title: 't', text: 'x', html: '<p>x</p>' }), /text or html, not both/)
  assert.equal(annotateInput({ title: 't', text: null, html: '' }).html, '')
  assert.throws(() => annotateInput({ title: 't', html: 5 }), /html must be a string/)
  assert.throws(() => annotateInput({ title: 't', html: 'a\0b' }), /html contains a NUL/)
  assert.equal(annotateInput({ title: 't', html: 'x'.repeat(MAX_ANNOTATE_HTML) }).html.length, MAX_ANNOTATE_HTML)
  assert.throws(() => annotateInput({ title: 't', html: 'é'.repeat(MAX_ANNOTATE_HTML / 2 + 1) }), /html is larger than 2 MiB/)
  assert.throws(() => annotateInput({ title: 't', text: 'x', assets: [{ id: 'a', mime: 'image/png', dataUrl: PNG }] }), /assets go with html/)
})

test('annotateInput: assets are images only, base64 data: URLs of their own type, capped one by one and in all', () => {
  const { annotateInput, MAX_ASSETS, MAX_ASSET_CHARS, MAX_ASSETS_TOTAL } = require('../dist/lib/review')
  const asset = (o = {}) => ({ id: 'a1', mime: 'image/png', dataUrl: PNG, ...o })
  const one = (o) => annotateInput({ title: 't', html: '<img src="asset:a1">', assets: [asset(o)] })
  assert.deepEqual(one({ name: '  shot\n1.png ', extra: 'x' }).assets, [{ id: 'a1', name: 'shot 1.png', mime: 'image/png', dataUrl: PNG }])
  for (const mime of ['image/jpeg', 'image/gif', 'image/webp']) {
    assert.equal(one({ mime, dataUrl: PNG.replace('image/png', mime) }).assets[0].mime, mime)
  }
  assert.throws(() => one({ mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }), /mime must be one of/)
  assert.throws(() => one({ mime: 'text/html', dataUrl: 'data:text/html;base64,PGI+' }), /mime must be one of/)
  assert.throws(() => one({ mime: 'image/jpeg' }), /base64 data: URL of type image\/jpeg/) // a PNG data URL declared as JPEG
  assert.throws(() => one({ dataUrl: 'data:image/png,raw' }), /base64 data: URL/)
  assert.throws(() => one({ dataUrl: PNG + '"><script>' }), /base64 data: URL/)
  assert.throws(() => one({ dataUrl: 'https://x/a.png' }), /base64 data: URL/)
  assert.throws(() => one({ dataUrl: 5 }), /dataUrl must be a string/)
  assert.throws(() => one({ dataUrl: 'data:image/png;base64,' + 'A'.repeat(MAX_ASSET_CHARS) }), /over 1000000 characters/)
  for (const id of ['', 'a b', 'a"b', 'x'.repeat(101), 5]) assert.throws(() => one({ id }), /id must be 1-100/, String(id))
  assert.throws(() => one({ name: 5 }), /name must be a string/)
  assert.throws(() => annotateInput({ title: 't', html: '', assets: [asset(), asset()] }), /used twice/)
  assert.throws(() => annotateInput({ title: 't', html: '', assets: 'x' }), /assets must be an array/)
  assert.throws(() => annotateInput({ title: 't', html: '', assets: [null] }), /assets\[0\] must be/)
  const many = Array.from({ length: MAX_ASSETS + 1 }, (_, i) => asset({ id: `a${i}` }))
  assert.throws(() => annotateInput({ title: 't', html: '', assets: many }), /at most 30 assets/)
  assert.equal(annotateInput({ title: 't', html: '', assets: many.slice(0, MAX_ASSETS) }).assets.length, MAX_ASSETS)
  // Nine assets just under the one-asset cap pass 8 MiB together.
  const big = 'data:image/png;base64,' + 'A'.repeat(MAX_ASSET_CHARS - 24)
  const nine = Array.from({ length: 9 }, (_, i) => asset({ id: `b${i}`, dataUrl: big }))
  assert.ok(9 * big.length > MAX_ASSETS_TOTAL && 8 * big.length <= MAX_ASSETS_TOTAL)
  assert.throws(() => annotateInput({ title: 't', html: '', assets: nine }), /over 8 MiB in all/)
  assert.equal(annotateInput({ title: 't', html: '', assets: nine.slice(0, 8) }).assets.length, 8)
})

test('splitParts: every part fits its JSON budget, the parts join back, and no surrogate pair is cut', () => {
  const { splitParts, MAX_PART_JSON } = require('../dist/lib/review')
  assert.deepEqual(splitParts(''), [''])
  assert.deepEqual(splitParts('<p>x</p>'), ['<p>x</p>'])
  // The worst case for escaping: control chars are six JSON chars each.
  for (const s of ['\x01'.repeat(400000), '"'.repeat(1000000), '<p>' + 'é😀'.repeat(300000)]) {
    const parts = splitParts(s)
    assert.equal(parts.join(''), s)
    for (const p of parts) assert.ok(JSON.stringify(p).length <= MAX_PART_JSON)
    for (const p of parts) assert.ok(!/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p))
  }
  const small = splitParts('abc😀d', 26) // 4 chars a part: the pair goes whole into the next one
  assert.deepEqual(small, ['abc', '😀d'])
})

test('cleanDraft keeps HTML notes with their anchors, capped; draftProblem accepts them', () => {
  const { draftProblem, MAX_QUOTE } = require('../dist/lib/review')
  const anchor = { prefix: 'p'.repeat(100), suffix: 's', occurrence: 2, length: 900, at: 40, extra: 1 }
  const d = cleanDraft({ notes: [{ id: 'h1', quote: 'q'.repeat(MAX_QUOTE + 5), anchor, text: 'n', side: 'old', from: 1 }, { id: 'h2', anchor: { occurrence: -1, length: 'x' }, text: 'm' }] })
  assert.deepEqual(d.notes[0], { id: 'h1', quote: 'q'.repeat(MAX_QUOTE), anchor: { prefix: 'p'.repeat(64), suffix: 's', occurrence: 2, length: 900, at: 40 }, text: 'n' })
  assert.deepEqual(d.notes[1].anchor, { prefix: '', suffix: '', occurrence: 0, length: 0, at: 0 })
  assert.equal(draftProblem({ notes: [{ id: 'h1', quote: 'q', anchor: {}, text: 'n' }] }), null)
  assert.equal(isEmpty(cleanDraft({ notes: [{ quote: 'q', anchor: {}, text: ' ' }] })), true)
})

test('buildAnnotation: HTML notes read "On «quote»: note" in text order, quotes on one line and shortened', () => {
  const { buildAnnotation } = require('../dist/lib/review')
  const note = (id, at, quote, text, length = quote.length) => ({ id, quote, anchor: { prefix: '', suffix: '', occurrence: 0, length, at }, text })
  const draft = {
    global: 'Overall fine.',
    notes: [note('b', 90, 'the second\n   paragraph', 'Why?\nReally.'), note('a', 10, 'Acceptance criteria', 'Missing one.'), note('c', 95, 'x', '  ')],
  }
  const { text, cut } = buildAnnotation(draft, { title: 'PROJ-1 Fix login', url: 'https://x/browse/PROJ-1' })
  assert.equal(cut, false)
  assert.equal(
    text,
    ['About PROJ-1 Fix login (https://x/browse/PROJ-1)', 'Overall fine.', '1. On «Acceptance criteria»: Missing one.', '2. On «the second paragraph»: Why?\n   Really.'].join('\n\n'),
  )
  // A selection longer than its stored quote says so; a long quote is cut at a word end.
  assert.match(buildAnnotation({ notes: [note('a', 0, 'abc', 'n', 900)] }, { title: 'T' }).text, /1\. On «abc …»: n$/)
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
  const many = { notes: Array.from({ length: 60 }, (_, i) => note(`n${i}`, i, words, 'n'.repeat(100))) }
  const short = buildAnnotation(many, { title: 'T' })
  assert.equal(short.cut, false)
  assert.ok(short.text.length <= MAX_MESSAGE)
  assert.match(short.text, /1\. On «word0 word1 [^»]* …»: n+/)
})

test('linkHrefs reads <a> hrefs as the HTML parser does: quotes, no quotes, entities, the first href', () => {
  const { linkHrefs } = require('../dist/lib/review')
  assert.deepEqual(
    linkHrefs(
      [
        '<a href="https://a/?x=1&amp;y=2">',
        "<A TITLE='q > r' Href='https://b/&quot;&#39;&#x41;&#66;'>",
        '<a href=https://c/x>',
        '<a href="https://d/" href="https://evil/">',
        '<a\nhref = "https://e/?a=1&b=2&ltx=3&lt=4&lt">',
        '<abbr href="https://not-a-link/">',
        '<a title="no href">',
        '<a href="https://f/&copy;&#0;&#x110000;',
      ].join(''),
    ),
    ['https://a/?x=1&y=2', 'https://b/"\'AB', 'https://c/x', 'https://d/', 'https://e/?a=1&b=2&ltx=3&lt=4<', 'https://f/&copy;\ufffd\ufffd'],
  )
  assert.deepEqual(linkHrefs(null), [])
})

test('linkSet and linkVerdict: normalized both ways, http(s) opened, mailto named, the rest refused', () => {
  const { linkSet, linkVerdict } = require('../dist/lib/review')
  const set = linkSet('<a href=" HTTPS://X.example/a b ">x</a><a href="mailto:a%40b@c.d">m</a><a href="javascript:x">j</a>', null, '<a href="/rel">r</a>')
  assert.deepEqual([...set], ['https://x.example/a%20b', 'mailto:a%40b@c.d', 'javascript:x'])
  assert.deepEqual(linkVerdict(set, 'https://x.example/a%20b'), { open: 'https://x.example/a%20b' })
  assert.deepEqual(linkVerdict(set, 'https://x.example/a b'), { open: 'https://x.example/a%20b' })
  assert.deepEqual(linkVerdict(set, 'mailto:a%40b@c.d'), { refuse: 'mailto links are not opened: a@b@c.d' })
  for (const href of ['javascript:x', '/rel', 'https://y.example/', '', null, 'x'.repeat(10000)]) {
    assert.deepEqual(linkVerdict(set, href), { refuse: 'Not opened: not a link of this document' })
  }
})

test('htmlText: tags out, block ends and br as line breaks, list items and facts readable, entities decoded', () => {
  const { htmlText } = require('../dist/lib/review')
  assert.equal(
    htmlText('<h1>A &amp; B</h1><p>one<br>two</p><ul><li>x</li><li>y</li></ul><style>p{}</style><!-- c --><dl class="facts"><dt>From</dt><dd>Sam</dd></dl><table><tr><td>k</td><td>v</td></tr></table>'),
    'A & B\n\none\ntwo\n\n- x\n- y\n\nFrom: Sam\n\nk v',
  )
  assert.equal(htmlText(''), '')
  assert.equal(htmlText(null), '')
  // Unclosed script: dropped to the end, never shown.
  assert.equal(htmlText('<p>ok</p><script>never'), 'ok')
})

test('actionSet: the data-action ids of the caller\'s strings, decoded and shape-checked', () => {
  const { actionSet } = require('../dist/lib/review')
  const set = actionSet('<span data-action="show-images">x</span><span DATA-ACTION=\'always-sender\'>y</span>', null, '<span data-action=open>z</span> <span data-action="Bad Id">', '<i data-action="&#x61;b">')
  assert.deepEqual([...set].sort(), ['ab', 'always-sender', 'open', 'show-images'])
  // Text that only mentions the attribute (no space before it) is no attribute.
  assert.equal(actionSet('xdata-action="nope"').size, 0)
})

test('updateInput: key, assets, hide names and a one-line status; at least one of them', () => {
  const { updateInput } = require('../dist/lib/review')
  assert.deepEqual(updateInput({ key: 'gmail:1', hide: ['images-bar', 'images-bar'], status: ' a\n b ' }), { key: 'gmail:1', assets: [], hide: ['images-bar'], status: 'a b' })
  assert.deepEqual(updateInput({ key: 'k', status: '' }).status, '')
  assert.throws(() => updateInput({ key: 'k' }), /needs assets, hide or status/)
  assert.throws(() => updateInput({ key: 'k', assets: 'x' }), /assets must be an array/)
  assert.throws(() => updateInput({ key: 'k', hide: Array(21).fill('a') }), /at most 20/)
  assert.throws(() => updateInput({ key: 'bad key', status: 'x' }), /key may only use/)
  assert.equal(updateInput({ key: 'k', status: 'x'.repeat(500) }).status.length, 200)
})

test('previewChunks: begin, chunks under the page message limit that join back to the bytes, end', () => {
  const bytes = Buffer.alloc(2 * review.PREVIEW_CHUNK_BYTES + 5, 7)
  const msgs = review.previewChunks('pdf', 'application/pdf', bytes)
  assert.deepEqual(msgs[0], { type: 'bytes-begin', kind: 'pdf', mime: 'application/pdf', size: bytes.length, chunks: 3 })
  assert.deepEqual(msgs.at(-1), { type: 'bytes-end' })
  const mid = msgs.slice(1, -1)
  assert.deepEqual(mid.map((m) => m.seq), [0, 1, 2])
  for (const m of msgs) assert.ok(JSON.stringify(m).length <= 1040384)
  assert.deepEqual(Buffer.concat(mid.map((m) => Buffer.from(m.b64, 'base64'))), bytes)
  // Only the last chunk may carry base64 padding, so the page may join the strings too.
  assert.deepEqual(Buffer.from(mid.map((m) => m.b64).join(''), 'base64'), bytes)
  // An empty file is still one (empty) chunk.
  assert.deepEqual(review.previewChunks('image', 'image/png', Buffer.alloc(0)).map((m) => m.type), ['bytes-begin', 'bytes', 'bytes-end'])
  assert.throws(() => review.previewChunks('image', 'image/png', bytes, 1000), /multiple of 3/)
})

test('buildReview of a preview: the file as it is now', () => {
  const sides = { path: 'doc.pdf', mode: 'preview', head: null, old: '', new: '', oldMissing: true, newMissing: false }
  assert.match(review.buildReview({ comment: '', notes: [] }, sides).text, /^Review of doc\.pdf \(the file as it is now, no git diff\)/)
})

test('page notes (a PDF): kept by cleanDraft, ordered by page, worded as pages', () => {
  const d = review.cleanDraft({ global: '', notes: [
    { id: 'b', page: 3, quote: 'third', text: 'later' },
    { id: 'a', page: 1, quote: 'first words', text: 'fix this' },
    { id: 'x', page: 0, quote: 'q', text: 'dropped' },
    { id: 'y', page: 'nope', quote: 'q', text: 'dropped' },
  ] })
  assert.deepEqual(d.notes.map((n) => [n.id, n.page]), [['b', 3], ['a', 1]])
  const sides = { path: 'doc.pdf', mode: 'preview', head: null, old: '', new: '', oldMissing: true, newMissing: false }
  const text = review.buildReview(d, sides).text
  assert.match(text, /1\. Page 1:\n   > first words\n   fix this/)
  assert.match(text, /2\. Page 3:\n   > third\n   later/)
})
