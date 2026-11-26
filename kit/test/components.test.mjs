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
    // That turn ends before the next question (Ask waits while a turn runs, S-9).
    m.panel.pushAsk({ type: 'answer', text: 'ok' })
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

test('mountAsk hears the app with ccPanel.ask.on(type, fn), one listener per push type', async () => {
  const doc = new FakeDocument()
  const panel = fakePanel()
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const ask = kit.mountAsk(root, { doc, panel, canContinue: true })
  await flush()
  assert.deepEqual(panel.askListening().sort(), ['answer', 'delta', 'end', 'history', 'state', 'tool'])
  panel.pushAsk({ type: 'history', turns: [{ question: 'first?', answer: 'one' }], pick: { models: [], efforts: [] } })
  panel.pushAsk({ type: 'state', phase: 'thinking' })
  panel.pushAsk({ type: 'delta', text: 'streamed ' })
  panel.pushAsk({ type: 'answer', text: 'streamed answer' })
  await flush()
  assert.match(ask.el.textContent, /first\?/)
  assert.match(ask.el.textContent, /streamed answer/)
  ask.destroy()
  assert.deepEqual(panel.askListening(), [], 'destroy unsubscribes every type')
})


test('S-9: Ask waits while a turn runs: the running question keeps its answer, the new one stays in the box', async () => {
  const doc = new FakeDocument()
  const panel = fakePanel()
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const ask = kit.mountAsk(root, { doc, panel })
  await flush()
  const input = byTag(ask.el, 'textarea')[0]
  const askButton = button(ask.el, 'Ask')
  const enter = () => input.dispatch('keydown', { key: 'Enter' })
  input.value = 'first question'
  askButton.click()
  await flush()
  panel.pushAsk({ type: 'state', phase: 'thinking' })
  panel.pushAsk({ type: 'delta', text: 'part of the first ' })
  assert.equal(askButton.disabled, true, 'Ask is off during the turn')
  input.value = 'second question'
  enter()
  askButton.click()
  await flush()
  assert.deepEqual(panel.calls.filter((c) => c[0] === 'ask.start' || c[0] === 'ask.say').map((c) => c[1].question), ['first question'])
  assert.equal(input.value, 'second question', 'the new question waits in the box')
  panel.pushAsk({ type: 'answer', text: 'the first answer' })
  panel.pushAsk({ type: 'state', phase: 'ready' })
  await flush()
  const turns = [...all(ask.el)].filter((e) => e.getAttribute && /cc-kit-turn( |$)/.test(e.getAttribute('class') || ''))
  assert.equal(turns.length, 1)
  assert.match(turns[0].textContent, /first question/)
  assert.match(turns[0].textContent, /the first answer/)
  assert.equal(askButton.disabled, false, 'Ask is on again')
  enter()
  await flush()
  assert.deepEqual(panel.calls.filter((c) => c[0] === 'ask.say').map((c) => c[1].question), ['second question'])
  ask.destroy()
})

test('S-10: a note being edited keeps what was typed when the notes change anywhere', async () => {
  const doc = new FakeDocument()
  const one = { id: 'n1', quote: 'the fox', anchor: { prefix: '', suffix: '', occurrence: 0, length: 7, at: 0 }, text: 'saved text', rev: 1, author: { access: 'owner' } }
  const panel = fakePanel({ state: { global: '', notes: [one], rev: 1 } })
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const notes = kit.mountNotes(root, { doc, panel, canWrite: true })
  await flush()
  button(notes.el, 'Edit').click()
  const box = byTag(notes.el, 'textarea')[0]
  assert.equal(box.value, 'saved text')
  box.value = 'what the owner is typing'
  box.dispatch('input')
  // A write guest adds a note meanwhile: the list redraws.
  const two = { ...one, id: 'n2', text: "the guest's note", author: { access: 'write', person: 'Ann' } }
  panel.pushNotes({ global: '', notes: [one, two], rev: 2 })
  await flush()
  const after = byTag(notes.el, 'textarea')[0]
  assert.equal(after.value, 'what the owner is typing')
  assert.match(notes.el.textContent, /by guest Ann/)
  button(notes.el, 'Save').click()
  await flush()
  assert.deepEqual(panel.calls.filter((c) => c[0] === 'notes.change'), [['notes.change', 'n1', { text: 'what the owner is typing' }]])
  // The note gone elsewhere ends the edit.
  button(notes.el, 'Edit').click()
  panel.pushNotes({ global: '', notes: [two], rev: 3 })
  await flush()
  assert.equal(byTag(notes.el, 'textarea').length, 0)
  notes.destroy()
})

test('N9: a document\'s span[data-action] stays a plain span: no button the kit never wired', async () => {
  const doc = new FakeDocument()
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const html = parsed(doc, el(doc, 'p', {}, 'Pictures are hidden. ', el(doc, 'span', { 'data-action': 'show-images', title: 'Show' }, 'Show images')))
  const r = kit.renderDocument(root, { html: 'ignored' }, { doc, parse: () => html })
  assert.equal(byTag(r.root, 'button').length, 0)
  const span = byTag(r.root, 'span').find((s) => s.textContent === 'Show images')
  assert.ok(span, 'the label stays as text')
  assert.equal(span.getAttribute('data-action'), null)
})

test("mountAsk shows a state push's notice beside the phase, as text (D15)", async () => {
  const doc = new FakeDocument()
  const panel = fakePanel()
  const root = doc.createElement('div')
  doc.body.appendChild(root)
  const ask = kit.mountAsk(root, { doc, panel, canContinue: true })
  await flush()
  panel.pushAsk({ type: 'state', phase: 'thinking', notice: `Open a Claude tab here once ${EVIL}` })
  await flush()
  assert.match(ask.el.textContent, /Thinking… · Open a Claude tab here once/)
  assert.equal(byTag(ask.el, 'img').length + byTag(ask.el, 'script').length, 0, 'the notice is text, never markup')
  panel.pushAsk({ type: 'state', phase: 'ready' })
  await flush()
  assert.doesNotMatch(ask.el.textContent, /Open a Claude tab/)
  ask.destroy()
})
