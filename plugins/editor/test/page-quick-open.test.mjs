// The page's side of quick open and find in files (src/page/quick-open.mjs): the fuzzy filter, the
// grouping, and the request state (parts joined, stale answers dropped, a reconnect asking again).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSearch, fuzzyFilter, fuzzyMatch, groupMatches, highlightPieces, MAX_ROWS, FILES_TTL_MS } from '../src/page/quick-open.mjs'

test('fuzzyMatch: characters in order, case-insensitive; the file name and word starts win', () => {
  assert.equal(fuzzyMatch('xyz', 'src/a.ts'), null)
  assert.deepEqual(fuzzyMatch('AT', 'src/a.ts').positions, [4, 6])
  const paths = ['src/session.mjs', 'docs/design-editor.md', 'src/page/file.js', 'scripts/build-editor.mjs']
  assert.equal(fuzzyFilter('file', paths)[0].path, 'src/page/file.js')
  assert.equal(fuzzyFilter('de', paths)[0].path, 'docs/design-editor.md')
  // Spaces in the query are ignored.
  assert.equal(fuzzyFilter('page file', paths)[0].path, 'src/page/file.js')
  // An empty query keeps rg's order, capped.
  const many = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `f${i}`)
  assert.equal(fuzzyFilter('', many).length, MAX_ROWS)
  assert.equal(fuzzyFilter('  ', many)[0].path, 'f0')
})

test('fuzzyMatch: positions index the path itself when lower-casing changes a length', () => {
  // 'İ'.toLowerCase() is 'i̇' (two units): folding the whole path would shift every later position.
  const path = 'İstanbul/MapView.ts'
  const m = fuzzyMatch('mv', path)
  assert.deepEqual(m.positions.map((i) => path[i]), ['M', 'V'])
  // The camel-case bonus reads the right character: 'V' after 'p' is a word start.
  assert.ok(fuzzyMatch('v', path).score > fuzzyMatch('e', path).score)
  assert.deepEqual(fuzzyMatch('ist', path).positions.map((i) => path[i]), ['İ', 's', 't'])
})

test('groupMatches keeps rg order; highlightPieces splits by ranges', () => {
  const g = groupMatches([{ path: 'a', line: 1 }, { path: 'b', line: 2 }, { path: 'a', line: 3 }])
  assert.deepEqual(g.map((x) => [x.path, x.matches.map((m) => m.line)]), [['a', [1, 3]], ['b', [2]]])
  assert.deepEqual(highlightPieces('one two', [[4, 7], [0, 3]]), [
    { text: 'one', hit: true },
    { text: ' ', hit: false },
    { text: 'two', hit: true },
  ])
  // Overlapping or out-of-range ranges never repeat or overrun the text.
  assert.deepEqual(highlightPieces('abc', [[0, 2], [1, 9]]).map((p) => p.text).join(''), 'abc')
})

function harness() {
  const posted = []
  const files = []
  const greps = []
  const opens = []
  let now = 1000
  const s = createSearch({
    post: (m) => posted.push(m),
    now: () => now,
    onFiles: (st) => files.push(st),
    onGrep: (st) => greps.push(st),
    onOpenError: (m) => opens.push(m),
  })
  return { s, posted, files, greps, opens, advance: (ms) => (now += ms) }
}

test('files: parts joined, cached for a while, asked again when stale or after an error', () => {
  const h = harness()
  h.s.loadFiles()
  assert.deepEqual(h.posted, [{ t: 'files', req: 1 }])
  assert.equal(h.files.at(-1).loading, true)
  assert.equal(h.s.receive({ t: 'files', req: 1, paths: ['a', 'b'], part: 0, parts: 2 }), true)
  assert.equal(h.files.length, 1)
  h.s.receive({ t: 'files', req: 1, paths: ['c'], part: 1, parts: 2, truncated: true })
  assert.deepEqual(h.files.at(-1), { loading: false, paths: ['a', 'b', 'c'], truncated: true, error: null, missing: false })
  // Fresh: no new request.
  h.s.loadFiles()
  assert.equal(h.posted.length, 1)
  h.advance(FILES_TTL_MS + 1)
  h.s.loadFiles()
  assert.deepEqual(h.posted.at(-1), { t: 'files', req: 2 })
  // A stale answer (req 1) is taken but ignored.
  assert.equal(h.s.receive({ t: 'files', req: 1, paths: ['old'], part: 0, parts: 1 }), true)
  assert.equal(h.files.at(-1).loading, true)
  h.s.receive({ t: 'search-error', kind: 'files', req: 2, message: 'rg missing', missing: true })
  assert.deepEqual(h.files.at(-1), { loading: false, paths: ['a', 'b', 'c'], truncated: true, error: 'rg missing', missing: true })
  h.s.loadFiles()
  assert.deepEqual(h.posted.at(-1), { t: 'files', req: 3 })
  // Not a search message: left for the session.
  assert.equal(h.s.receive({ t: 'file', req: 3 }), false)
})

test('grep: debounced, only the newest answer counts, empty clears, cancel on close, reconnect asks again', async () => {
  const h = harness()
  h.s.setGrep('ne', { regex: 'yes' })
  h.s.setGrep('needle', { caseSensitive: true })
  assert.equal(h.posted.length, 0)
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(h.posted, [{ t: 'grep', req: 1, query: 'needle', regex: false, caseSensitive: true, word: false }])
  h.s.setGrep('needles', {}, true)
  assert.equal(h.posted.at(-1).req, 2)
  // The answer to req 1 arrives late: dropped.
  h.s.receive({ t: 'grep', req: 1, matches: [{ path: 'x', line: 1 }], part: 0, parts: 1, files: 1 })
  assert.equal(h.greps.at(-1).loading, true)
  h.s.receive({ t: 'grep', req: 2, matches: [{ path: 'a', line: 1 }], part: 0, parts: 2, files: 2 })
  h.s.receive({ t: 'grep', req: 2, matches: [{ path: 'b', line: 5 }], part: 1, parts: 2, files: 2, truncated: true })
  const st = h.greps.at(-1)
  assert.equal(st.count, 2)
  assert.equal(st.files, 2)
  assert.equal(st.truncated, true)
  assert.deepEqual(st.groups.map((g) => g.path), ['a', 'b'])
  // A reconnect while a search waits asks it again under a new req.
  h.s.setGrep('q', {}, true)
  h.s.connect()
  assert.deepEqual(h.posted.slice(-2).map((m) => [m.t, m.req, m.query]), [['grep', 3, 'q'], ['grep', 4, 'q']])
  // Closing the panel stops it on the host.
  h.s.stopGrep()
  assert.deepEqual(h.posted.at(-1), { t: 'grep-cancel' })
  h.s.receive({ t: 'grep', req: 4, matches: [{ path: 'late', line: 1 }], part: 0, parts: 1 })
  assert.notEqual(h.greps.at(-1).groups[0]?.path, 'late')
  // An empty query clears the results.
  h.s.setGrep('', {})
  assert.deepEqual(h.greps.at(-1).groups, [])
  // An open the host refused is told.
  h.s.receive({ t: 'search-error', kind: 'open', message: 'gone.ts: no such file' })
  assert.deepEqual(h.opens, ['gone.ts: no such file'])
})
