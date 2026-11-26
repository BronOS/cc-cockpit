// The kit's page side on a fake document (fake-dom.mjs): the rules every component keeps (README "Rules").
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FakeDocument, all, byTag, button, el, fakePanel, flush, parsed } from './fake-dom.mjs'
import * as kit from '../src/index.mjs'

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVIL = '<img src=x onerror="alert(1)"><script>alert(2)</script>'

/** Every component mounted at once, fed hostile text everywhere text can come from. */
async function mountAll({ doc = new FakeDocument(), panel = fakePanel(), access = 'owner' } = {}) {
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const html = parsed(doc, el(doc, 'p', {}, `Hello ${EVIL} `, el(doc, 'a', { href: 'https://example.com/a?b=1&c=2' }, 'a link')), el(doc, 'script', {}, 'alert(3)'))
  const rendered = kit.renderDocument(root, { html: 'ignored' }, { doc, panel, parse: () => html })
  const plain = kit.renderDocument(root, { text: EVIL }, { doc, panel })
  const menu = kit.mountSelectionMenu(rendered, { doc, actions: [{ id: 'note', label: 'Note', run: () => {} }] })
  const canWrite = access !== 'read'
  const notes = kit.mountNotes(root, { doc, panel, canWrite, rendered })
  const global = kit.mountGlobalNote(root, { doc, panel, canWrite, saveMs: 0 })
  const ask = kit.mountAsk(root, { doc, panel, about: `About: ${EVIL}`, canContinue: access === 'owner' })
  const details = doc.createElement('div')
  const askPane = doc.createElement('div')
  const tabs = kit.mountSideTabs(root, { doc, panel, tabs: [{ id: 'details', label: 'Details', panel: details }, { id: 'ask', label: 'Ask', panel: askPane }] })
  const original = kit.mountOriginal(root, { doc, html: 'ignored', parse: () => parsed(doc, el(doc, 'p', {}, EVIL)) })
  const discuss = kit.mountDiscussButton(root, { doc, panel })
  const error = kit.mountError(root, { doc, panel, message: EVIL, retry: true })
  await flush()
  return { doc, panel, root, rendered, plain, menu, notes, global, ask, tabs, original, discuss, error }
}

const evilNote = { id: 'n1', quote: EVIL, anchor: { prefix: '', suffix: '', occurrence: 0, length: 5, at: 0 }, text: EVIL, rev: 1, author: { access: 'write', person: EVIL } }

test('no component writes document, answer or note text through innerHTML', async () => {
  const m = await mountAll()
  m.panel.pushNotes({ global: EVIL, notes: [evilNote], rev: 2 })
  m.panel.pushAsk({ type: 'history', turns: [{ question: EVIL, quote: EVIL, answer: `**b** ${EVIL}`, error: EVIL }], pick: { models: [EVIL], efforts: [] } })
  m.panel.pushAsk({ type: 'state', phase: 'thinking' })
  m.panel.pushAsk({ type: 'delta', text: EVIL })
  m.panel.pushAsk({ type: 'tool', name: EVIL, detail: EVIL })
  m.panel.pushAsk({ type: 'answer', text: `[x](${EVIL}) ${EVIL}` })
  m.panel.pushAsk({ type: 'end', message: EVIL, error: true })
  await flush()
  assert.deepEqual(m.doc.markupWrites, [])
  // The hostile text is there, as text: no element of it was made.
  const tags = new Set([...all(m.doc.body)].map((e) => e.nodeName))
  assert.ok(!tags.has('SCRIPT'), 'no script element')
  for (const img of byTag(m.doc.body, 'img')) assert.equal(img.getAttribute('onerror'), null)
  assert.ok(m.doc.body.textContent.includes('<img src=x onerror="alert(1)">'), 'the markup shows as text')
  // The grep: no source file and not the bundle sets markup.
  const write = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write(ln)?\s*\(|createContextualFragment/
  for (const f of readdirSync(join(KIT, 'src')).filter((n) => n.endsWith('.mjs'))) {
    const code = readFileSync(join(KIT, 'src', f), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    assert.doesNotMatch(code, write, f)
  }
  assert.doesNotMatch(readFileSync(join(KIT, 'dist', 'cc-kit.js'), 'utf8'), write, 'dist/cc-kit.js')
})

test('no component sends, posts or opens without a click', async () => {
  const opened = []
  globalThis.open = (...a) => opened.push(a)
  try {
    const m = await mountAll()
    // Everything that is not a click: pushes, typing, a selection change, keys other than Enter.
    m.panel.pushNotes({ global: 'g', notes: [evilNote], rev: 2 })
    m.panel.pushAsk({ type: 'history', turns: [], pick: { models: ['sonnet'], efforts: ['low'] } })
    m.panel.pushAsk({ type: 'state', phase: 'ready' })
    m.panel.pushAsk({ type: 'answer', text: 'see https://example.com' })
    const [askInput] = byTag(m.ask.el, 'textarea')
    askInput.value = 'a question'
    askInput.dispatch('input')
    askInput.dispatch('keydown', { key: 'a' })
    askInput.dispatch('keydown', { key: 'Enter', shiftKey: true })
    const globalInput = byTag(m.global.el, 'textarea')[0]
    globalInput.value = 'for Claude'
    globalInput.dispatch('input')
    m.doc.dispatch('selectionchange')
    m.rendered.root.dispatch('mouseup')
    m.tabs.select('ask')
    await flush()
    await flush()
    const sends = ['post', 'ask.start', 'ask.say', 'ask.close', 'ask.continue', 'overlay.discuss', 'notes.add', 'notes.change', 'notes.remove']
    const made = m.panel.calls.map((c) => c[0])
    for (const s of sends) assert.ok(!made.includes(s), `${s} without a click: ${JSON.stringify(m.panel.calls)}`)
    // What did happen: reads, and the note for Claude saved as typed (a write, not a send).
    assert.deepEqual([...new Set(made)].sort(), ['ask.pick', 'notes.list', 'notes.setGlobal'])
    assert.ok(m.panel.calls.filter((c) => c[0] === 'ask.pick').every((c) => JSON.stringify(c[1]) === '{}'), 'pick only read')
    assert.deepEqual(opened, [])

    // Now the clicks, each doing its one thing.
    const count = (name) => m.panel.calls.filter((c) => c[0] === name).length
    byTag(m.rendered.root, 'a')[0].click()
    assert.deepEqual(m.panel.calls.at(-1), ['post', { type: 'cc-kit.link', url: 'https://example.com/a?b=1&c=2' }])
    button(m.ask.el, 'Ask').click()
    assert.equal(count('ask.say'), 1, 'a running chat is continued')
    askInput.value = 'again'
    askInput.dispatch('keydown', { key: 'Enter' })
    assert.equal(count('ask.say'), 2, 'Enter asks too')
    button(m.ask.el, 'Close chat').click()
    assert.equal(count('ask.close'), 1)
    button(m.ask.el, 'Continue in a tab').click()
    assert.equal(count('ask.continue'), 1)
    m.discuss.el.click()
    assert.equal(count('overlay.discuss'), 1)
    button(m.tabs.el, 'Ask').click()
    assert.deepEqual(m.panel.calls.at(-1), ['post', { type: 'cc-kit.tab', tab: 'ask' }])
    button(m.error.el, 'Try again').click()
    assert.deepEqual(m.panel.calls.at(-1), ['post', { type: 'cc-kit.retry' }])
    button(m.notes.el, '✕').click()
    assert.deepEqual(m.panel.calls.at(-1), ['notes.remove', 'n1'])
    assert.deepEqual(opened, [])
  } finally {
    delete globalThis.open
  }
})

test('Markdown answers render no raw HTML', () => {
  const doc = new FakeDocument()
  const box = doc.createElement('div')
  box.appendChild(kit.renderMarkdown(`# Title\n\n**bold** <b>raw</b> ${EVIL}\n\n<div onclick="x()">block</div>\n\n[site](https://evil.example/?a=1) ![pic](https://evil.example/p.png)\n\n\`\`\`\n<script>code</script>\n\`\`\``, doc))
  const tags = new Set([...all(box)].map((e) => e.nodeName))
  for (const bad of ['B', 'IMG', 'SCRIPT', 'A', 'IFRAME']) assert.ok(!tags.has(bad), `no ${bad}`)
  assert.ok(tags.has('H1') && tags.has('STRONG') && tags.has('PRE'))
  assert.ok(box.textContent.includes('<b>raw</b>'))
  assert.ok(box.textContent.includes('<div onclick="x()">block</div>'))
  // A link is its text and its full address, not a link.
  assert.ok(box.textContent.includes('site <https://evil.example/?a=1>'))
  assert.deepEqual(doc.markupWrites, [])
})

test('a read guest gets the notes without controls, and nothing for Ask (no ccPanel.ask)', async () => {
  const m = await mountAll({ access: 'read', panel: fakePanel({ ask: false }) })
  m.panel.pushNotes({ global: 'for Claude', notes: [evilNote], rev: 2 })
  assert.equal(m.ask.el, null)
  assert.equal(button(m.notes.el, 'Edit'), undefined)
  assert.equal(button(m.notes.el, '✕'), undefined)
  assert.equal(byTag(m.global.el, 'textarea').length, 0)
  assert.ok(m.global.el.textContent.includes('for Claude'))
  // An older app: nothing at all.
  const bare = await mountAll({ panel: fakePanel({ notes: false, ask: false, discuss: false }) })
  assert.equal(bare.notes.el, null)
  assert.equal(bare.global.el, null)
  assert.equal(bare.discuss.el, null)
})

test('the renderer keeps the allow-listed classes, drops the rest, and drops all with classes: none', () => {
  const doc = new FakeDocument()
  const input = () => parsed(doc, el(doc, 'span', { class: 'lozenge lozenge-success x-evil' }, 'Done'), el(doc, 'dl', { class: 'facts' }, el(doc, 'dt', {}, 'k')))
  const kept = kit.renderDocument(doc.body, { html: '' }, { doc, parse: input })
  const span = byTag(kept.root, 'span')[0]
  assert.equal(span.getAttribute('class'), 'lozenge lozenge-success')
  assert.equal(byTag(kept.root, 'dl')[0].getAttribute('class'), 'facts')
  const none = kit.renderDocument(doc.body, { html: '' }, { doc, parse: input, classes: 'none' })
  assert.equal(byTag(none.root, 'span')[0].getAttribute('class'), null)
})

test('notes are marked where their quote is, and a selection gives a note anchor', () => {
  const doc = new FakeDocument()
  const r = kit.renderDocument(doc.body, { html: '' }, { doc, parse: () => parsed(doc, el(doc, 'p', {}, 'The quick ', el(doc, 'em', {}, 'brown'), ' fox.')) })
  assert.equal(r.text(), 'The quick brown fox.')
  const { quote, anchor } = kit.makeAnchor(r.text(), 4, 15)
  const where = kit.markNotes(r, [{ id: 'a', quote, anchor }, { id: 'gone', quote: 'nowhere', anchor }])
  assert.deepEqual(where.get('a'), { start: 4, end: 15 })
  assert.equal(where.get('gone'), null)
  const marks = byTag(r.root, 'mark')
  assert.equal(marks.map((m) => m.textContent).join(''), 'quick brown')
  assert.equal(r.text(), 'The quick brown fox.', 'marks keep the text')
  // Marked again: the old marks go first.
  kit.markNotes(r, [{ id: 'a', quote, anchor }])
  assert.equal(byTag(r.root, 'mark').length, marks.length)
  // A selection inside the document.
  const em = byTag(r.root, 'em')[0]
  const sel = r.selection({ rangeCount: 1, isCollapsed: false, getRangeAt: () => ({ startContainer: em.firstChild, startOffset: 0, endContainer: em.firstChild, endOffset: 5 }) })
  assert.equal(sel.text, 'brown')
  assert.equal(sel.quote, 'brown')
})

test('connect joins a chunked state and passes other messages on', () => {
  const panel = fakePanel()
  const got = []
  kit.connect({ init: (i) => got.push(['init', i.access, i.tab, i.features]), state: (s) => got.push(['state', s]), message: (m) => got.push(['message', m]), failed: (f) => got.push(['failed', f]) }, { panel })
  const text = JSON.stringify({ big: 'x'.repeat(50) })
  panel.pushMessage({ type: 'cc-kit.init', access: 'write', tab: 'ask' })
  panel.pushMessage({ type: 'cc-kit.chunk', id: 1, i: 0, n: 2, text: text.slice(0, 20) })
  panel.pushMessage({ type: 'cc-kit.chunk', id: 1, i: 1, n: 2, text: text.slice(20) })
  // A broken stream is dropped whole.
  panel.pushMessage({ type: 'cc-kit.chunk', id: 2, i: 1, n: 2, text: 'x' })
  panel.pushMessage({ type: 'cc-kit.init', access: 'admin' })
  panel.pushMessage({ hello: 1 })
  panel.pushMessage({ type: 'cc-kit.failed', message: 'no', retry: true })
  assert.deepEqual(got, [
    ['init', 'write', 'ask', { notes: true, ask: true, discuss: true }],
    ['state', { big: 'x'.repeat(50) }],
    ['message', { hello: 1 }],
    ['failed', { message: 'no', retry: true }],
  ])
  // It says hello once, on connect (holder mode's greeting on an app before overlays.perView).
  assert.deepEqual(panel.calls.filter((c) => c[0] === 'post'), [['post', { type: 'cc-kit.hello' }]])
})

test('postLink posts http(s) only', () => {
  const panel = fakePanel()
  assert.equal(kit.postLink('javascript:alert(1)', panel), false)
  assert.equal(kit.postLink('mailto:a@b.c', panel), false)
  assert.equal(kit.postLink('https://x.test', panel), true)
  assert.deepEqual(panel.calls, [['post', { type: 'cc-kit.link', url: 'https://x.test/' }]])
})

test('Continue in a tab calls ccPanel.ask.continue(); a throw or a refusal shows its error, never silent', async () => {
  for (const fail of ['throws', 'rejects']) {
    const doc = new FakeDocument()
    const panel = fakePanel()
    const root = doc.createElement('div')
    doc.body.appendChild(root)
    const ask = kit.mountAsk(root, { doc, panel, canContinue: true })
    await flush()
    button(ask.el, 'Continue in a tab').click()
    await flush()
    assert.deepEqual(panel.calls.filter((c) => c[0] === 'ask.continue'), [['ask.continue']])
    const alert = [...all(ask.el)].find((e) => e.getAttribute && e.getAttribute('role') === 'alert')
    assert.equal(alert.hidden, true, 'no error when it went')
    panel.ask.continue =
      fail === 'throws'
        ? () => {
            throw new TypeError('ask.continue is not available')
          }
        : () => Promise.reject(new Error('only the owner may continue'))
    button(ask.el, 'Continue in a tab').click()
    await flush()
    assert.equal(alert.hidden, false, fail)
    assert.match(alert.textContent, fail === 'throws' ? /not available/ : /only the owner/)
    ask.destroy()
  }
})
