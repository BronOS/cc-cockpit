'use strict'
// annotate's HTML mode, page side: the allow-list sanitizer (src/page/sanitize.mjs) and the note
// anchors (src/page/anchor.mjs), run under node. The sanitizer works on the DOM node interface, so
// small fake nodes stand in for DOMParser's tree here; the real parser (and the rendered page) is
// covered by test/e2e/reviewer-annotate.spec.ts in the app repo.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const load = (f) => import(path.join(__dirname, '../src/page', f))

// A fake DOM tree: h('p', { class: 'x' }, 'text', h('em', {}, 'y')).
const HTML_NS = 'http://www.w3.org/1999/xhtml'
function h(tag, attrs = {}, ...children) {
  return {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    namespaceURI: attrs.$ns || HTML_NS,
    attributes: Object.entries(attrs)
      .filter(([k]) => k !== '$ns')
      .map(([name, value]) => ({ name, value })),
    childNodes: children.map((c) => (typeof c === 'string' ? { nodeType: 3, nodeValue: c } : c)),
  }
}
const body = (...children) => h('body', {}, ...children)

// A fake document for render(): elements record their attributes and children.
const fakeDoc = {
  createDocumentFragment: () => ({ children: [], appendChild(c) { this.children.push(c) } }),
  createTextNode: (text) => ({ text }),
  createElement: (tag) => ({
    tag,
    attrs: {},
    children: [],
    setAttribute(k, v) { this.attrs[k] = v },
    appendChild(c) { this.children.push(c) },
  }),
}

test('sanitizeTree keeps allowed elements and drops script, style, iframe, forms and SVG with their content', async () => {
  const { sanitizeTree } = await load('sanitize.mjs')
  const tree = sanitizeTree(
    body(
      h('h2', {}, 'Title'),
      h('script', {}, 'alert(1)'),
      h('style', {}, 'body{display:none}'),
      h('iframe', { src: 'https://evil' }, 'x'),
      h('form', {}, h('input', { value: 'v' }), 'label'),
      h('svg', { $ns: 'http://www.w3.org/2000/svg' }, h('a', { href: 'javascript:x' }, 'svg link')),
      h('p', {}, 'one ', h('strong', {}, 'two')),
      { nodeType: 8, nodeValue: 'a comment' },
    ),
  )
  assert.deepEqual(tree, [
    { tag: 'h2', attrs: [], children: [{ text: 'Title' }] },
    { tag: 'p', attrs: [], children: [{ text: 'one ' }, { tag: 'strong', attrs: [], children: [{ text: 'two' }] }] },
  ])
})

test('sanitizeTree unwraps unknown elements, keeping their text', async () => {
  const { sanitizeTree } = await load('sanitize.mjs')
  assert.deepEqual(sanitizeTree(body(h('section', {}, h('font', { color: 'red' }, 'kept'), h('p', {}, 'p')))), [
    { text: 'kept' },
    { tag: 'p', attrs: [], children: [{ text: 'p' }] },
  ])
})

test('sanitizeTree drops every attribute but the allowed ones, and classes off the allow-list', async () => {
  const { sanitizeTree, ALLOWED_CLASSES } = await load('sanitize.mjs')
  const [div] = sanitizeTree(
    body(h('div', { class: 'jira-panel jira-panel-info banner note', onclick: 'x()', style: 'color:red', id: 'global', 'data-x': '1', title: 'T' }, 'p')),
  )
  assert.deepEqual(div.attrs, [['class', 'jira-panel jira-panel-info'], ['title', 'T']])
  // Only a class name the page's UI does not use for itself is on the list.
  for (const ui of ['banner', 'note', 'quote', 'limit', 'primary', 'link', 'doc', 'doc-body', 'asset-box', 'img-missing']) assert.ok(!ALLOWED_CLASSES.has(ui), ui)
  const [none] = sanitizeTree(body(h('span', { class: 'evil other' }, 'x')))
  assert.deepEqual(none.attrs, [])
  // colspan / rowspan on cells only, as small whole numbers.
  const [table] = sanitizeTree(body(h('table', {}, h('tr', {}, h('td', { colspan: '2', rowspan: '0' }, 'a'), h('th', { rowspan: ' 3 ', colspan: '1e9' }, 'b')))))
  const [tr] = table.children
  assert.deepEqual(tr.children.map((c) => c.attrs), [[['colspan', '2']], [['rowspan', '3']]])
  const [p] = sanitizeTree(body(h('p', { colspan: '2' }, 'x')))
  assert.deepEqual(p.attrs, [])
})

test('sanitizeTree: facts lists, lozenge tones and person chips, each on its own element', async () => {
  const { sanitizeTree } = await load('sanitize.mjs')
  const [dl] = sanitizeTree(body(h('dl', { class: 'facts grid' }, h('dt', { class: 'facts' }, 'Status'), h('dd', {}, h('span', { class: 'lozenge lozenge-success' }, 'Done')))))
  assert.equal(dl.tag, 'dl')
  assert.deepEqual(dl.attrs, [['class', 'facts']])
  const [dt, dd] = dl.children
  assert.deepEqual([dt.tag, dt.attrs, dd.tag], ['dt', [], 'dd']) // facts is a dl's class only
  assert.deepEqual(dd.children[0].attrs, [['class', 'lozenge lozenge-success']])
  for (const tone of ['neutral', 'info', 'success', 'warning', 'danger']) {
    const [s] = sanitizeTree(body(h('span', { class: `lozenge lozenge-${tone}` }, 'x')))
    assert.deepEqual(s.attrs, [['class', `lozenge lozenge-${tone}`]], tone)
  }
  // One tone at most: the first named wins; unknown names go, the known ones stay.
  const [mixed] = sanitizeTree(body(h('span', { class: 'lozenge lozenge-danger lozenge-info lozenge-purple banner' }, 'x')))
  assert.deepEqual(mixed.attrs, [['class', 'lozenge lozenge-danger']])
  const [person] = sanitizeTree(body(h('span', { class: 'person avatar' }, 'Ann Lee')))
  assert.deepEqual(person.attrs, [['class', 'person']])
  // The span-only names are dropped elsewhere; the older lozenge names still work on any element.
  const [div] = sanitizeTree(body(h('div', { class: 'person lozenge lozenge-danger lozenge-neutral' }, 'x')))
  assert.deepEqual(div.attrs, [['class', 'lozenge']])
  const [old] = sanitizeTree(body(h('div', { class: 'status lozenge lozenge-error' }, 'x')))
  assert.deepEqual(old.attrs, [['class', 'status lozenge lozenge-error']])
})

test('links keep http(s) and mailto hrefs only', async () => {
  const { sanitizeTree, safeHref } = await load('sanitize.mjs')
  assert.equal(safeHref('https://x.atlassian.net/browse/PROJ-1'), 'https://x.atlassian.net/browse/PROJ-1')
  assert.equal(safeHref(' http://a/b c '), 'http://a/b%20c')
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c')
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '/relative', '#top', 'cc-plugin://x/y', '', 5, null, 'https://' + 'a'.repeat(3000)]) {
    assert.equal(safeHref(bad), null, String(bad))
  }
  const [a] = sanitizeTree(body(h('a', { href: 'javascript:alert(1)', target: '_top', rel: 'opener' }, 'x')))
  assert.deepEqual(a, { tag: 'a', attrs: [], children: [{ text: 'x' }] })
})

test('images keep an asset reference only; any other src is dropped and the alt text shown', async () => {
  const { sanitizeTree } = await load('sanitize.mjs')
  const tree = sanitizeTree(
    body(
      h('img', { src: 'asset:shot-1.png', alt: 'Screenshot', onerror: 'alert(1)', width: '10' }),
      h('img', { 'data-asset': 'a2', src: 'https://evil/x.png' }),
      h('img', { src: 'https://evil/track.gif', alt: 'tracker' }),
      h('img', { src: 'data:image/svg+xml,<svg onload=alert(1)>' }),
      h('img', { src: 'asset:bad id' }),
    ),
  )
  assert.deepEqual(tree, [
    { tag: 'img', attrs: [['data-asset', 'shot-1.png'], ['alt', 'Screenshot']], children: [] },
    { tag: 'img', attrs: [['data-asset', 'a2'], ['alt', '']], children: [] },
    { tag: 'span', attrs: [['class', 'img-missing']], children: [{ text: '[image: tracker]' }] },
    { tag: 'span', attrs: [['class', 'img-missing']], children: [{ text: '[image]' }] },
    { tag: 'span', attrs: [['class', 'img-missing']], children: [{ text: '[image]' }] },
  ])
})

test('very deep nesting is unwrapped past the depth limit, its text kept', async () => {
  const { sanitizeTree } = await load('sanitize.mjs')
  let n = h('span', {}, 'deep')
  for (let i = 0; i < 300; i++) n = h('div', {}, n)
  let depth = 0
  for (let t = sanitizeTree(body(n)); t.length && t[0].tag; t = t[0].children) depth++
  assert.equal(depth, 100)
  assert.match(JSON.stringify(sanitizeTree(body(n))), /"text":"deep"/)
})

test('render builds elements from the sanitized data and boxes every image for its placeholder', async () => {
  const { render } = await load('sanitize.mjs')
  const frag = render(
    [
      { tag: 'p', attrs: [['class', 'new']], children: [{ text: '<b>not markup</b>' }] },
      { tag: 'img', attrs: [['data-asset', 'a1'], ['alt', 'Shot']], children: [] },
    ],
    fakeDoc,
  )
  const [p, box] = frag.children
  assert.deepEqual(p.attrs, { class: 'new' })
  assert.deepEqual(p.children, [{ text: '<b>not markup</b>' }]) // a text node, never parsed
  assert.deepEqual(box.attrs, { class: 'asset-box pending', 'data-alt': 'Shot' })
  assert.deepEqual(box.children[0].attrs, { 'data-asset': 'a1', alt: 'Shot' })
})

test('isImageDataUrl: the four image types as base64, nothing else', async () => {
  const { isImageDataUrl } = await load('sanitize.mjs')
  for (const ok of ['data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,AA==', 'data:image/gif;base64,R0lG', 'data:image/webp;base64,UklG']) assert.ok(isImageDataUrl(ok), ok)
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png,raw', 'data:text/html;base64,AA==', 'https://x/a.png', 'data:image/png;base64,AA==")', null]) assert.ok(!isImageDataUrl(bad), String(bad))
})

test('the page never hands caller HTML to the DOM as markup', () => {
  for (const f of ['review.js', 'sanitize.mjs', 'anchor.mjs']) {
    // Code only: the comments explain why there is none.
    const src = fs
      .readFileSync(path.join(__dirname, '../src/page', f), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n')
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/, f)
  }
})

test('makeAnchor and locate: the quote, its context and which match it was', async () => {
  const { makeAnchor, locate, QUOTE_MAX, CONTEXT } = await load('anchor.mjs')
  const full = 'the cat sat on the cat mat'
  const second = makeAnchor(full, 19, 22)
  assert.deepEqual(second, { quote: 'cat', anchor: { prefix: 'the cat sat on the ', suffix: ' mat', occurrence: 1, length: 3, at: 19 } })
  assert.deepEqual(locate(full, second), { start: 19, end: 22 })
  // Text added before it: the context still finds the right "cat".
  assert.deepEqual(locate('Intro. ' + full, second), { start: 26, end: 29 })
  // Its context changed on both sides: the occurrence number decides.
  assert.deepEqual(locate('a cat, a cat', second), { start: 9, end: 12 })
  // The quote is gone: not located.
  assert.equal(locate('the dog sat', second), null)
  assert.equal(locate(full, { quote: '', anchor: second.anchor }), null)
  assert.equal(locate(full, { quote: 'cat' }), null)
  // A long selection keeps QUOTE_MAX chars as the quote and its whole length.
  const long = 'x'.repeat(40) + 'y'.repeat(QUOTE_MAX + 100) + 'z'.repeat(40)
  const a = makeAnchor(long, 40, 40 + QUOTE_MAX + 100)
  assert.equal(a.quote.length, QUOTE_MAX)
  assert.equal(a.anchor.length, QUOTE_MAX + 100)
  assert.equal(a.anchor.prefix.length, CONTEXT)
  assert.deepEqual(locate(long, a), { start: 40, end: 40 + QUOTE_MAX + 100 })
  // At the very start, a short prefix must not wrap around to the end of the text.
  const first = makeAnchor('ab ab', 0, 2)
  assert.deepEqual(first.anchor.prefix, '')
  assert.deepEqual(locate('ab ab', first), { start: 0, end: 2 })
})

test('the page anchors carry the host caps', () => {
  const { MAX_QUOTE, MAX_ANCHOR_CONTEXT } = require('../dist/lib/review')
  const src = fs.readFileSync(path.join(__dirname, '../src/page/anchor.mjs'), 'utf8')
  assert.match(src, new RegExp(`export const QUOTE_MAX = ${MAX_QUOTE}\\n`))
  const ctx = Number(/export const CONTEXT = (\d+)\n/.exec(src)[1])
  assert.ok(ctx <= MAX_ANCHOR_CONTEXT)
})

test('isPlainClick: a click opens a link; a drag-select, a double click or a moved press does not', async () => {
  const { isPlainClick, selectionKey, CLICK_SLOP } = await load('links.mjs')
  const n1 = {}
  const n2 = {}
  const none = selectionKey({ rangeCount: 0 })
  assert.equal(none, null)
  const caret = selectionKey({ rangeCount: 1, anchorNode: n1, anchorOffset: 2, focusNode: n1, focusOffset: 2 })
  const picked = selectionKey({ rangeCount: 1, anchorNode: n1, anchorOffset: 2, focusNode: n2, focusOffset: 5 })
  const down = { x: 10, y: 10, sel: none }
  assert.equal(isPlainClick(down, { x: 10, y: 10, sel: caret, collapsed: true, detail: 1 }), true)
  assert.equal(isPlainClick(down, { x: 10 + CLICK_SLOP, y: 10, sel: caret, collapsed: true, detail: 1 }), true)
  // A drag-select that ends on the link: moved, and a selection it did not start with.
  assert.equal(isPlainClick(down, { x: 80, y: 10, sel: picked, collapsed: false, detail: 1 }), false)
  // A short drag that still picked a character.
  assert.equal(isPlainClick(down, { x: 12, y: 10, sel: picked, collapsed: false, detail: 1 }), false)
  // An earlier selection the click left as it was (a click inside it).
  assert.equal(isPlainClick({ x: 1, y: 1, sel: picked }, { x: 1, y: 1, sel: [...picked], collapsed: false, detail: 1 }), true)
  assert.equal(isPlainClick(down, { x: 10, y: 10, sel: caret, collapsed: true, detail: 2 }), false)
  assert.equal(isPlainClick(down, { x: 10, y: 10 + CLICK_SLOP + 1, sel: caret, collapsed: true, detail: 1 }), false)
  // No press seen in the content; a keyboard (detail 0) click.
  assert.equal(isPlainClick(null, { x: 0, y: 0, sel: none, collapsed: true, detail: 1 }), false)
  assert.equal(isPlainClick(null, { x: 0, y: 0, sel: picked, collapsed: false, detail: 0 }), true)
})

test('split: the divider stays within the host\'s bounds; a selection belongs to the column it starts in', async () => {
  const { clampSplit, splitAt, splitKey, selectionDoc, SPLIT_MIN, SPLIT_MAX, SPLIT_DEFAULT, SPLIT_STEP } = await load('split.mjs')
  const reviewerHost = require('../dist/host.js')
  assert.equal(SPLIT_MIN, reviewerHost.SPLIT_MIN)
  assert.equal(SPLIT_MAX, reviewerHost.SPLIT_MAX)
  assert.equal(SPLIT_DEFAULT, 0.5)
  for (const [v, want] of [[0.33333, 0.333], [0, SPLIT_MIN], [1, SPLIT_MAX], [NaN, 0.5], ['0.3', 0.5], [null, 0.5], [undefined, 0.5], [Infinity, 0.5]]) assert.equal(clampSplit(v), want, String(v))
  assert.equal(splitAt(300, 100, 800), 0.25)
  assert.equal(splitAt(0, 100, 800), SPLIT_MIN)
  assert.equal(splitAt(5000, 100, 800), SPLIT_MAX)
  assert.equal(splitAt(300, 100, 0), 0.5) // a row not laid out yet
  assert.equal(splitKey(0.5, 'ArrowLeft'), 0.5 - SPLIT_STEP)
  assert.equal(splitKey(0.5, 'ArrowRight'), 0.5 + SPLIT_STEP)
  assert.equal(splitKey(SPLIT_MAX, 'ArrowRight'), SPLIT_MAX)
  assert.equal(splitKey(0.5, 'Home'), SPLIT_MIN)
  assert.equal(splitKey(0.5, 'End'), SPLIT_MAX)
  assert.equal(splitKey(0.5, 'a'), null)
  // The column it starts in, else the first it touches, else none.
  assert.equal(selectionDoc([{ touches: true, starts: false }, { touches: true, starts: true }]), 1)
  assert.equal(selectionDoc([{ touches: true, starts: true }, { touches: true, starts: false }]), 0)
  assert.equal(selectionDoc([{ touches: false, starts: false }, { touches: true, starts: false }]), 1)
  assert.equal(selectionDoc([{ touches: false, starts: false }, { touches: false, starts: false }]), -1)
  assert.equal(selectionDoc([]), -1)
})

test('openLabel: the header button names the site the caller gave, else the browser', async () => {
  const { openLabel } = await load('split.mjs')
  assert.equal(openLabel('Jira'), 'Open in Jira ↗')
  assert.equal(openLabel(null), 'Open in browser ↗')
  assert.equal(openLabel('Example Mail', false), 'Open in Example Mail')
})
