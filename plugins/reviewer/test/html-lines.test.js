'use strict'
// A rendered HTML file's source lines (src/page/html-lines.mjs): block start tags marked with their
// offset, under the page's key, and a block's lines from its start tag to its end.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const load = () => import(path.join(__dirname, '../src/page/html-lines.mjs'))

const at = (src, needle, from = 0) => src.indexOf(needle, from)

test('markHtmlLines marks block start tags with key:offset, first so the file cannot override it', async () => {
  const { markHtmlLines } = await load()
  const src = '<h1>T</h1>\n<p class="x">one</p>\n\n<P data-src-line="1:99">two</P>\n<span>in</span><ul>\n<li>a</li></ul>'
  const out = markHtmlLines(src, 42)
  const o = (n) => `data-src-line="42:${at(src, n)}"`
  assert.equal(
    out,
    `<h1 ${o('<h1')}>T</h1>\n<p ${o('<p ')} class="x">one</p>\n\n<P ${o('<P')} data-src-line="1:99">two</P>\n<span>in</span><ul ${o('<ul')}>\n<li ${o('<li')}>a</li></ul>`,
  )
})

test('markHtmlLines skips comments and raw-text bodies', async () => {
  const { markHtmlLines } = await load()
  const src = '<!-- <p>no\n</p> -->\n<script>if (a <p) x()\n</script>\n<style>p{}</style><title><p></title>\n<p>yes</p>'
  const out = markHtmlLines(src, 1)
  assert.equal((out.match(/data-src-line/g) || []).length, 1)
  assert.ok(out.endsWith(`<p data-src-line="1:${src.lastIndexOf('<p>')}">yes</p>`))
  // An unclosed comment or script runs to the end: nothing after it is marked.
  assert.equal(markHtmlLines('<!-- <p>x</p>', 1), '<!-- <p>x</p>')
  assert.equal(markHtmlLines('<script><p>', 1), '<script><p>')
  assert.equal(markHtmlLines(null, 1), '')
})

test('markOffset counts only marks with the key', async () => {
  const { markOffset } = await load()
  assert.equal(markOffset('42:7', 42), 7)
  assert.equal(markOffset('42:0', '42'), 0)
  assert.equal(markOffset('1:99', 42), null)
  assert.equal(markOffset('99', 42), null)
  assert.equal(markOffset('42:7x', 42), null)
  assert.equal(markOffset(undefined, 42), null)
})

test('blockLines: to the closing tag, or the line before the next block when that is first', async () => {
  const { blockLines } = await load()
  const src = '<body>\n<p>A paragraph\nover three\nlines.</p>\n\n</body></html>\n'
  const p = at(src, '<p>')
  // The last block: its closing tag, not the end of the file.
  assert.deepEqual(blockLines(src, p, p, null), { from: 2, to: 4 })
  // A <p> closed implicitly by the next one: the line before it, blank lines left out.
  const open = '<p>one\ngoes on\n\n<p>two\n</div>'
  assert.deepEqual(blockLines(open, 0, 0, at(open, '<p>two')), { from: 1, to: 2 })
  // Nested blocks of the same name: the matching close.
  const nest = '<div>\n<div>in\n</div>\nstill\n</div>\n<p>x</p>'
  assert.deepEqual(blockLines(nest, 0, 0, at(nest, '<p>')), { from: 1, to: 5 })
  assert.deepEqual(blockLines(nest, at(nest, '<div>in'), at(nest, '<div>in'), null), { from: 2, to: 3 })
  // From the start block to the end block; several blocks on one line.
  const row = '<tr><td>a</td><td>b</td></tr>\n<tr>\n<td>c</td></tr>'
  assert.deepEqual(blockLines(row, at(row, '<td>a'), at(row, '<td>c'), null), { from: 1, to: 3 })
  assert.deepEqual(blockLines(row, at(row, '<td>a'), at(row, '<td>a'), at(row, '<td>b')), { from: 1, to: 1 })
  // A void block, and one that is never closed.
  assert.deepEqual(blockLines('<hr>\n\n<p>x', 0, 0, 6), { from: 1, to: 1 })
  assert.deepEqual(blockLines('x\n<li>never closed\nmore\n\n', 2, 2, null), { from: 2, to: 3 })
})

test('the repeated paragraphs of test.html get their own lines', async () => {
  const { markHtmlLines, markOffset, blockLines } = await load()
  const src = '<h2>Repeated text</h2>\n<p>The same phrase appears twice: repeat me here.</p>\n<p>And again further down: repeat me here.</p>\n\n<h2>A long section</h2>\n'
  const marks = [...markHtmlLines(src, 5).matchAll(/data-src-line="([^"]+)"/g)].map((m) => markOffset(m[1], 5))
  assert.deepEqual(blockLines(src, marks[2], marks[2], marks[3]), { from: 3, to: 3 })
  assert.deepEqual(blockLines(src, marks[1], marks[1], marks[2]), { from: 2, to: 2 })
})

test('the sanitizer keeps data-src-line as key:line digits only', async () => {
  const { sanitizeTree } = await import(path.join(__dirname, '../src/page/sanitize.mjs'))
  const el = (attrs) => ({ nodeType: 1, nodeName: 'P', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: attrs, childNodes: [] })
  const body = (c) => ({ nodeType: 1, nodeName: 'BODY', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: [], childNodes: [c] })
  const kept = (value) => /data-src-line/.test(JSON.stringify(sanitizeTree(body(el([{ name: 'data-src-line', value }])))))
  assert.equal(kept('123456789:48'), true)
  assert.equal(kept('123456789:123456789'), false)
  assert.equal(kept('48'), false)
  assert.equal(kept('1:2" onclick="x'), false)
  assert.equal(kept('a:1'), false)
})

// ---- the lines of a selection, on a small fake DOM ----
//
// A tree from well-formed HTML (what markdownHtml and markHtmlLines give for simple input), with what
// mdRangeLines / htmlRangeLines use: nodeType, parentElement, dataset, closest and querySelectorAll
// for one attribute, contains.
function fakeDom(html) {
  const make = (tag, parent) => ({ nodeType: 1, tag, parentElement: parent, attrs: {}, children: [] })
  const root = make('body', null)
  let cur = root
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      cur.children.push({ nodeType: 3, textContent: m[4], parentElement: cur })
    } else if (m[1]) {
      cur = cur.parentElement || root
    } else {
      const e = make(m[2].toLowerCase(), cur)
      // The first of two equal attributes wins, as in the HTML parser.
      for (const a of m[3].matchAll(/([a-z-]+)="([^"]*)"/g)) if (!(a[1] in e.attrs)) e.attrs[a[1]] = a[2]
      cur.children.push(e)
      if (!['hr', 'br', 'img'].includes(e.tag)) cur = e
    }
  }
  const camel = (n) => n.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())
  const all = (e) => e.children.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...all(c)])
  const walk = (e) => {
    if (e.nodeType !== 1) return
    e.dataset = Object.fromEntries(Object.entries(e.attrs).map(([k, v]) => [camel(k), v]))
    const attrOf = (sel) => sel.slice(1, -1)
    e.closest = (sel) => {
      for (let x = e; x; x = x.parentElement) if (attrOf(sel) in x.attrs) return x
      return null
    }
    e.querySelectorAll = (sel) => all(e).filter((x) => attrOf(sel) in x.attrs)
    e.contains = (x) => {
      for (let y = x; y; y = y.parentElement) if (y === e) return true
      return false
    }
    e.children.forEach(walk)
  }
  walk(root)
  return root
}
/** A range over the text node of the n-th element holding `text`. */
const rangeIn = (body, text, n, endText) => {
  const texts = []
  const visit = (e) => e.children.forEach((c) => (c.nodeType === 3 ? texts.push(c) : visit(c)))
  visit(body)
  const hits = texts.filter((t) => t.textContent.includes(text))
  const start = hits[n]
  const end = endText ? texts.find((t) => t.textContent.includes(endText)) : start
  return { startContainer: start, endContainer: end }
}

const TEST_HTML = [
  '<h2>Repeated text</h2>',
  '<p>The same phrase appears twice: repeat me here.</p>',
  '<p>And again further down: repeat me here.</p>',
  '',
  '<h2>A long section</h2>',
  '<p>One paragraph',
  'over two lines.</p>',
  '',
].join('\n')

test('htmlRangeLines: a phrase in two paragraphs gets the line of the selected one', async () => {
  const { markHtmlLines, htmlRangeLines } = await load()
  const body = fakeDom(markHtmlLines(TEST_HTML, 7))
  // "repeat me here." alone, in the second paragraph: its line (3), not the first match's (2).
  assert.deepEqual(htmlRangeLines(rangeIn(body, 'repeat me here.', 1), body, TEST_HTML, 7), { from: 3, to: 3 })
  assert.deepEqual(htmlRangeLines(rangeIn(body, 'repeat me here.', 0), body, TEST_HTML, 7), { from: 2, to: 2 })
  // Across blocks: from the first's line to the end of the last.
  assert.deepEqual(htmlRangeLines(rangeIn(body, 'repeat me here.', 1, 'over two'), body, TEST_HTML, 7), { from: 3, to: 7 })
  // Under another key (marks the file wrote itself) nothing is named.
  assert.equal(htmlRangeLines(rangeIn(body, 'repeat me here.', 1), body, TEST_HTML, 8), null)
})

test('mdRangeLines: a phrase in two paragraphs gets the line of the selected one', async () => {
  const { mdRangeLines } = await load()
  const { markdownHtml } = await import(path.join(__dirname, '../src/page/markdown.mjs'))
  const src = '## Repeated text\n\nThe same phrase appears twice: repeat me here.\n\nAnd again further down: repeat me here.\n\nOne paragraph\nover two lines.\n'
  const body = fakeDom(markdownHtml(src))
  assert.deepEqual(mdRangeLines(rangeIn(body, 'repeat me here.', 1), body), { from: 5, to: 5 })
  assert.deepEqual(mdRangeLines(rangeIn(body, 'repeat me here.', 0), body), { from: 3, to: 3 })
  assert.deepEqual(mdRangeLines(rangeIn(body, 'repeat me here.', 1, 'over two'), body), { from: 5, to: 8 })
  // Outside every marked block: no lines.
  assert.equal(mdRangeLines({ startContainer: null, endContainer: null }, body), null)
})
