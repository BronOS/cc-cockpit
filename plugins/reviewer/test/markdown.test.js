'use strict'
// The markdown file's Rendered view (src/page/markdown.mjs) and the links it may open (review.textLinks).
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const review = require('../dist/lib/review')

const load = () => import(path.join(__dirname, '../src/page/markdown.mjs'))

test('markdownHtml: headings, lists, tables, code, links', async () => {
  const { markdownHtml } = await load()
  const html = markdownHtml('# Title\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = 1 < 2\n```\n\n[docs](https://example.com/d) and https://bare.example/x.')
  assert.match(html, /<h1[^>]*>Title<\/h1>/)
  assert.match(html, /<ul[^>]*>\n<li[^>]*>a<\/li>/)
  assert.match(html, /<table[^>]*>[\s\S]*<td>1<\/td>/)
  assert.match(html, /<pre><code[^>]* class="language-js">const a = 1 &lt; 2\n<\/code><\/pre>/)
  assert.match(html, /<a href="https:\/\/example.com\/d">docs<\/a>/)
  assert.match(html, /<a href="https:\/\/bare.example\/x">https:\/\/bare.example\/x<\/a>\./)
})

test('markdownHtml: raw HTML is text, never markup; javascript: links are not links', async () => {
  const { markdownHtml } = await load()
  const html = markdownHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))')
  assert.ok(!/<script|<img/i.test(html))
  assert.match(html, /&lt;script&gt;/)
  assert.ok(!/href="javascript/i.test(html))
  assert.equal(markdownHtml(undefined), '')
})

test('markdownHtml: an image keeps its alt (the sanitizer gives it no src)', async () => {
  const { markdownHtml } = await load()
  const { sanitizeTree } = await import(path.join(__dirname, '../src/page/sanitize.mjs'))
  assert.match(markdownHtml('![the logo](img/logo.png)'), /<img src="img\/logo.png" alt="the logo">/)
  // What sanitize.mjs keeps of such an <img>: no src, the alt.
  const img = { nodeType: 1, nodeName: 'IMG', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: [{ name: 'src', value: 'img/logo.png' }, { name: 'alt', value: 'the logo' }], childNodes: [] }
  const out = JSON.stringify(sanitizeTree({ nodeType: 1, nodeName: 'BODY', namespaceURI: img.namespaceURI, attributes: [], childNodes: [img] }))
  assert.ok(!out.includes('logo.png'))
  assert.ok(out.includes('the logo'))
})

test('initialMarkdownView: source only for a real diff', async () => {
  const { initialMarkdownView, markdownText } = await load()
  const base = { mode: 'diff', oldMissing: false, newMissing: false, old: 'a', new: 'b' }
  assert.equal(initialMarkdownView(base), 'source')
  assert.equal(initialMarkdownView({ ...base, new: 'a' }), 'rendered') // unchanged
  assert.equal(initialMarkdownView({ ...base, oldMissing: true, old: '' }), 'rendered') // new file
  assert.equal(initialMarkdownView({ ...base, newMissing: true, new: '' }), 'rendered') // deleted
  assert.equal(initialMarkdownView({ ...base, mode: 'plain' }), 'rendered') // no git
  assert.equal(markdownText({ ...base, newMissing: true }), 'a')
  assert.equal(markdownText(base), 'b')
})

test('textLinks: the http(s) URLs in the text, with and without trailing punctuation', async () => {
  const { markdownHtml } = await load()
  const text = 'See [docs](https://example.com/a_(b)) and <https://x.example/p?q=1&r=2>, or https://bare.example/x.\n\n[ref]: http://ref.example/y "t"\n\n[rel](./other.md) [js](javascript:alert(1))'
  const links = review.textLinks(text)
  // Every href markdown-it renders for an http(s) link is in the set, as the host normalizes it.
  const hrefs = [...markdownHtml(text + '\n\n[ref] here').matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'))
  for (const href of hrefs.filter((h) => /^https?:/.test(h))) assert.deepEqual(review.linkVerdict(links, href), { open: new URL(href).href }, href)
  assert.ok(hrefs.some((h) => h.startsWith('https://example.com/a_(b)')))
  assert.match(review.linkVerdict(links, './other.md').refuse, /not a link of this document/)
  assert.match(review.linkVerdict(links, 'https://evil.example/').refuse, /not a link of this document/)
  assert.equal(review.textLinks(null, 42).size, 0)
})

test('markdownHtml: every block names its source lines (1-based, inclusive), and the sanitizer keeps them', async () => {
  const { markdownHtml } = await load()
  const html = markdownHtml('# Title\n\nPara one\nstill one.\n\n- a\n- b\n\n```\ncode\n```\n')
  assert.match(html, /<h1 data-md-lines="1-1">Title<\/h1>/)
  assert.match(html, /<p data-md-lines="3-4">Para one/)
  assert.match(html, /<ul data-md-lines="6-7">\n<li data-md-lines="6-6">a<\/li>/)
  assert.match(html, /<pre><code data-md-lines="9-11">code/)
  const { sanitizeTree } = await import(path.join(__dirname, '../src/page/sanitize.mjs'))
  const el = (attrs) => ({ nodeType: 1, nodeName: 'P', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: attrs, childNodes: [] })
  const body = (c) => ({ nodeType: 1, nodeName: 'BODY', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: [], childNodes: [c] })
  assert.match(JSON.stringify(sanitizeTree(body(el([{ name: 'data-md-lines', value: '3-4' }])))), /data-md-lines/)
  assert.doesNotMatch(JSON.stringify(sanitizeTree(body(el([{ name: 'data-md-lines', value: '3-4" onclick="x' }])))), /data-md-lines/)
})
