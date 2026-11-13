// The file tab page's language server side with no DOM: src/page/lsp/convert.mjs (positions,
// content changes, the host's edits, LSP snippets, hover blocks, symbols, signature help) and
// src/page/lsp/client.mjs (the protocol to the host: the text with its seq, owner-only changes,
// asks with deadlines and aborts that never wait on a server, edits taken only when they fit).
import test from 'node:test'
import assert from 'node:assert/strict'
import { offsetOf, positionOf, contentChanges, editsToChanges, snippetToTemplate, docBlocks, flattenSymbols, signatureParts, severityOf, completionType } from '../src/page/lsp/convert.mjs'
import { createLspClient, COMPLETE_TIMEOUT_MS } from '../src/page/lsp/client.mjs'
import { EditorState } from '@codemirror/state'
import { createRequire } from 'node:module'

const { applyTextEdits } = createRequire(import.meta.url)('../dist/lib/lsp/edits.js')

/** A document of CodeMirror Text's shape (1-based lines, from/to offsets) over a string. */
function doc(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
  const line = (n) => {
    const from = starts[n - 1]
    const to = n < starts.length ? starts[n] - 1 : text.length
    return { number: n, from, to, text: text.slice(from, to) }
  }
  return {
    lines: starts.length,
    length: text.length,
    line,
    lineAt: (pos) => {
      let n = 1
      while (n < starts.length && starts[n] <= pos) n++
      return line(n)
    },
    toString: () => text,
    sliceString: (from, to) => text.slice(from, to),
  }
}

/** A real CodeMirror document split as the file tab splits it: on `\n` alone (line-breaks.mjs). */
const cmDoc = (text) => EditorState.create({ doc: text, extensions: EditorState.lineSeparator.of('\n') }).doc

/** The host's offset of an LSP position (edits.js offsetAt, through applyTextEdits), or -1 past the last line. */
function hostOffset(text, pos) {
  try {
    return applyTextEdits(text, [{ range: { start: pos, end: pos }, newText: '\0' }]).indexOf('\0')
  } catch {
    return -1
  }
}

/** A ChangeSet's iterChanges over [fromA, toA, insert] triples (ascending, as CodeMirror gives them). */
const changeSet = (list) => ({ iterChanges: (fn) => list.forEach(([a, b, ins]) => fn(a, b, 0, 0, { toString: () => ins })) })

/** Applies LSP content changes in order (what the host does), to check contentChanges' order. */
function applyLsp(text, changes) {
  for (const c of changes) {
    const d = doc(text)
    const from = offsetOf(d, c.range.start)
    const to = offsetOf(d, c.range.end)
    text = text.slice(0, from) + c.text + text.slice(to)
  }
  return text
}

test('offsetOf / positionOf: UTF-16 units; a character past the line end is its end; a line past the last is the end', () => {
  const d = doc('ab😀c\nxy\n')
  assert.equal(offsetOf(d, { line: 0, character: 4 }), 4)
  assert.equal(offsetOf(d, { line: 0, character: 99 }), 5)
  assert.equal(offsetOf(d, { line: 1, character: 1 }), 7)
  assert.equal(offsetOf(d, { line: 9, character: 0 }), d.length)
  assert.deepEqual(positionOf(d, 7), { line: 1, character: 1 })
  assert.deepEqual(positionOf(d, 4), { line: 0, character: 4 })
})

test('contentChanges: a multi-range edit as LSP changes from the end backwards, which the host applies in order', () => {
  const before = 'one\ntwo\nthree\n'
  const d = doc(before)
  // Two cursors typed: "X" at 1 (o|ne) and "Y" replacing "thr" (8..11).
  const changes = contentChanges(d, changeSet([[1, 1, 'X'], [8, 11, 'Y']]))
  assert.deepEqual(changes[0].range, { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } })
  assert.equal(applyLsp(before, changes), 'oXne\ntwo\nYee\n')
})

test('offsetOf / positionOf: a lone \r and a CRLF break LSP lines as the host counts them, though the page splits on \n only', () => {
  const text = 'a\rbb\ncc'
  const d = cmDoc(text)
  assert.equal(d.lines, 2, 'the page keeps the \r inside its first line')
  assert.deepEqual(positionOf(d, 2), { line: 1, character: 0 })
  assert.deepEqual(positionOf(d, 4), { line: 1, character: 2 })
  assert.deepEqual(positionOf(d, 5), { line: 2, character: 0 })
  assert.equal(offsetOf(d, { line: 1, character: 0 }), 2)
  assert.equal(offsetOf(d, { line: 2, character: 1 }), 6)
  assert.equal(offsetOf(d, { line: 0, character: 9 }), 1, 'a line ends before its lone \r')
  assert.equal(offsetOf(d, { line: 3, character: 0 }), d.length)
  // The reported case: an edit meant for "bb" replaces "bb", not "cc".
  const e = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: 'BB' }
  assert.deepEqual(editsToChanges(d, [e]), [{ from: 2, to: 4, insert: 'BB' }])
  assert.equal(applyTextEdits(text, [e]), 'a\rBB\ncc')
})

test('offsetOf / positionOf agree with the host offsetAt at every position of mixed line breaks', () => {
  for (const text of ['a\rbb\ncc', 'x\r\ny\rz\n\r\r\nw\r', '\r\r', 'one\r\ntwo\r\n', '\n\r\n\r', 'plain\ntext\n']) {
    const d = cmDoc(text)
    for (let line = 0; line < 8; line++) {
      for (let character = 0; character < 6; character++) {
        const host = hostOffset(text, { line, character })
        const page = offsetOf(d, { line, character })
        assert.equal(page, host === -1 ? d.length : host, `${JSON.stringify(text)} ${line}:${character}`)
        // And back: the position of that offset names it again (a CRLF's inside is never produced).
        if (host !== -1) assert.equal(hostOffset(text, positionOf(d, page)), page, `${JSON.stringify(text)} back from ${page}`)
      }
    }
  }
})

test('contentChanges: across lone \r breaks the host applies them to the same text; a change inside a CRLF is not nameable (null)', () => {
  const before = 'a\rbb\ncc\r\ndd'
  const d = cmDoc(before)
  const tr = EditorState.create({ doc: before, extensions: EditorState.lineSeparator.of('\n') }).update({
    changes: [{ from: 3, to: 4, insert: 'X' }, { from: 6, to: 7, insert: 'Y' }, { from: 10, insert: 'Z' }],
  })
  const changes = contentChanges(d, tr.changes)
  const viaHost = changes.reduce((t, c) => applyTextEdits(t, [{ range: c.range, newText: c.text }]), before)
  assert.equal(viaHost, tr.state.doc.toString())
  // Typed between the \r and the \n of a CRLF (offset 8 in "cc\r|\n"): LSP has no position there.
  const inside = EditorState.create({ doc: before, extensions: EditorState.lineSeparator.of('\n') }).update({ changes: { from: 8, insert: 'Q' } })
  assert.equal(contentChanges(d, inside.changes), null)
  const deleting = EditorState.create({ doc: before, extensions: EditorState.lineSeparator.of('\n') }).update({ changes: { from: 7, to: 8 } })
  assert.equal(contentChanges(d, deleting.changes), null, 'a range ending inside a CRLF')
  // Removing the whole CRLF is nameable.
  const whole = EditorState.create({ doc: before, extensions: EditorState.lineSeparator.of('\n') }).update({ changes: { from: 7, to: 9 } })
  assert.deepEqual(contentChanges(d, whole.changes), [{ range: { start: { line: 2, character: 2 }, end: { line: 3, character: 0 } }, text: '' }])
})

test('editsToChanges: sorted CodeMirror changes; an overlap or a malformed edit is refused with a reason', () => {
  const d = doc('const a = 1\n')
  const e = (l1, c1, l2, c2, newText) => ({ range: { start: { line: l1, character: c1 }, end: { line: l2, character: c2 } }, newText })
  assert.deepEqual(editsToChanges(d, [e(0, 10, 0, 11, '2'), e(0, 6, 0, 7, 'b')]), [
    { from: 6, to: 7, insert: 'b' },
    { from: 10, to: 11, insert: '2' },
  ])
  assert.equal(editsToChanges(d, [e(0, 0, 0, 5, ''), e(0, 3, 0, 6, '')]), 'the edits overlap')
  assert.equal(editsToChanges(d, [{ range: e(0, 0, 0, 0).range }]), 'a malformed edit')
  assert.equal(editsToChanges(d, [e(0, 5, 0, 1, '')]), 'an edit ends before it starts')
  assert.equal(editsToChanges(d, 'x'), 'not a list of edits')
  // The host's order: an insert at P listed after a replace starting at P is not an overlap.
  assert.deepEqual(editsToChanges(d, [e(0, 6, 0, 7, 'b'), e(0, 6, 0, 6, 'x')]), [
    { from: 6, to: 6, insert: 'x' },
    { from: 6, to: 7, insert: 'b' },
  ])
})

test('snippetToTemplate: tab stops, placeholders (nested flattened), choices, variables, escapes and literal braces', () => {
  assert.equal(snippetToTemplate('foo($1, ${2:bar})$0'), 'foo(${1}, ${2:bar})${0}')
  assert.equal(snippetToTemplate('${1:outer ${2:inner}}'), '${1:outer inner}')
  assert.equal(snippetToTemplate('${1|a,b,c|}'), '${1:a}')
  assert.equal(snippetToTemplate('$TM_FILENAME ${TM_SELECTED_TEXT:sel}'), ' sel')
  assert.equal(snippetToTemplate('cost \\$5 and \\}'), 'cost $5 and \\}')
  // A literal ${ in code (a template string) must not become a field.
  assert.equal(snippetToTemplate('`\\${x}`'), '`$\\{x\\}`')
  assert.equal(snippetToTemplate('if (x) {\n\t$0\n}'), 'if (x) \\{\n\t${0}\n\\}')
  // A placeholder with a brace cannot be a field name: plain text, then an empty field. (LSP ends a
  // placeholder at its first unescaped `}`, so the second one here is plain text after it.)
  assert.equal(snippetToTemplate('${1:{a}}'), '\\{a${1}\\}')
  assert.equal(snippetToTemplate('${1:{a\\}}'), '\\{a\\}${1}')
  assert.equal(snippetToTemplate('price: $'), 'price: $')
})

test('docBlocks: markdown fences are code, the rest text (never markup); MarkedString and lists read', () => {
  assert.deepEqual(docBlocks({ kind: 'markdown', value: '```ts\nconst a: number\n```\nThe **a** constant.' }), [
    { code: true, text: 'const a: number' },
    { code: false, text: 'The **a** constant.' },
  ])
  assert.deepEqual(docBlocks([{ language: 'go', value: 'func F()' }, 'doc']), [
    { code: true, text: 'func F()' },
    { code: false, text: 'doc' },
  ])
  assert.deepEqual(docBlocks({ kind: 'plaintext', value: '<b>x</b>' }), [{ code: false, text: '<b>x</b>' }])
  assert.deepEqual(docBlocks(''), [])
})

test('flattenSymbols: DocumentSymbol trees in order with depth; SymbolInformation sorted by position', () => {
  const r = (l, c) => ({ start: { line: l, character: c }, end: { line: l, character: c + 1 } })
  const tree = [{ name: 'A', kind: 5, range: r(0, 0), selectionRange: r(0, 6), children: [{ name: 'm', kind: 6, detail: '(): void', range: r(1, 2), selectionRange: r(1, 2) }] }]
  assert.deepEqual(flattenSymbols(tree), [
    { name: 'A', detail: '', kind: 'class', depth: 0, line: 0, character: 6 },
    { name: 'm', detail: '(): void', kind: 'method', depth: 1, line: 1, character: 2 },
  ])
  const flat = [
    { name: 'b', kind: 12, location: { uri: 'file:///x', range: r(5, 0) }, containerName: 'mod' },
    { name: 'a', kind: 13, location: { uri: 'file:///x', range: r(1, 0) } },
  ]
  assert.deepEqual(flattenSymbols(flat).map((s) => [s.name, s.kind, s.detail]), [
    ['a', 'variable', ''],
    ['b', 'function', 'mod'],
  ])
  assert.deepEqual(flattenSymbols(null), [])
})

test('signatureParts: the active parameter by label offsets or by its string; none: the whole label', () => {
  const help = { signatures: [{ label: 'f(a: number, b: string)', parameters: [{ label: [2, 11] }, { label: 'b: string', documentation: 'the b' }] }], activeSignature: 0, activeParameter: 1 }
  assert.deepEqual(signatureParts(help), { before: 'f(a: number, ', param: 'b: string', after: ')', doc: [{ code: false, text: 'the b' }], count: 1, index: 0 })
  help.activeParameter = 0
  assert.equal(signatureParts(help).param, 'a: number')
  assert.equal(signatureParts({ signatures: [{ label: 'g()' }] }).before, 'g()')
  assert.equal(signatureParts({ signatures: [] }), null)
  assert.equal(signatureParts(null), null)
})

test('severity and completion kinds map to CodeMirror names', () => {
  assert.deepEqual([1, 2, 3, 4, undefined].map(severityOf), ['error', 'warning', 'info', 'hint', 'error'])
  assert.deepEqual([3, 6, 7, 14, 999].map(completionType), ['function', 'variable', 'class', 'keyword', 'text'])
})

// ---- the client ----

function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    set: (fn, ms) => (pending.set(next, { fn, ms }), next++),
    clear: (h) => pending.delete(h),
    fire: (ms) => {
      for (const [h, t] of [...pending]) {
        if (t.ms === ms) {
          pending.delete(h)
          t.fn()
        }
      }
    },
    pending,
  }
}

function client(text = 'const a = 1\n') {
  const posts = []
  const ui = {
    text,
    applied: [],
    statuses: [],
    diagnostics: null,
    refuse: null,
    post: (m) => posts.push(m),
    getText: () => ui.text,
    applyEdits: (edits) => (ui.refuse ? ui.refuse : (ui.applied.push(edits), true)),
    onStatus: (s) => ui.statuses.push(s),
    onDiagnostics: (d) => (ui.diagnostics = d),
  }
  const timers = fakeTimers()
  const c = createLspClient(ui, timers)
  const last = (t) => [...posts].reverse().find((p) => p.t === t)
  return { c, ui, posts, timers, last }
}

/** Connected, opened and answered by the host as the owner with a ready server. */
function readyClient() {
  const k = client()
  k.c.connect()
  k.c.open('src/a.ts', true)
  k.c.receive({ t: 'lsp-status', language: 'typescript', name: 'TypeScript', state: 'ready', features: { hover: true, complete: true } })
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', name: 'TypeScript', owner: true, state: 'ready' })
  return k
}

test('client: the text goes in parts with a seq; only the owner sends changes; an outside or textless file is never sent', () => {
  const k = client('x'.repeat(300 * 1024))
  k.c.open('src/a.ts', true)
  assert.equal(k.posts.length, 0, 'nothing before a line to the host')
  k.c.connect()
  k.c.open('/usr/lib/node_modules/x/index.d.ts', true)
  k.c.open('src/a.ts', false)
  assert.equal(k.posts.length, 0)
  k.c.open('src/a.ts', true)
  const opens = k.posts.filter((p) => p.t === 'lsp-open')
  assert.deepEqual(opens.map((p) => [p.part, p.parts, p.seq]), [
    [0, 3, 1],
    [1, 3, 1],
    [2, 3, 1],
  ])
  // Not the owner yet (no lsp-doc): a change is not sent.
  k.c.changed([{ text: 'y' }])
  assert.equal(k.last('lsp-change'), undefined)
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: false, state: 'starting' })
  k.c.changed([{ text: 'y' }])
  assert.equal(k.last('lsp-change'), undefined)
  // Becoming the owner (the old owner left): the whole text again, then changes with the next seqs.
  k.c.receive({ t: 'lsp-resync', path: 'src/a.ts', owner: true })
  assert.equal(k.last('lsp-open').seq, 2)
  k.c.changed([{ text: 'z' }])
  assert.deepEqual(k.last('lsp-change'), { t: 'lsp-change', path: 'src/a.ts', changes: [{ text: 'z' }], seq: 3 })
})

test('client: an ask resolves with the host answer; a deadline or an abort cancels at the host; a new line fails what waited; never a wait without a server', async () => {
  const k = readyClient()
  const p = k.c.ask('hover', { position: { line: 0, character: 1 } })
  const sent = k.last('lsp-ask')
  assert.deepEqual({ ...sent, req: 0 }, { t: 'lsp-ask', req: 0, what: 'hover', path: 'src/a.ts', position: { line: 0, character: 1 } })
  k.c.receive({ t: 'lsp-answer', req: sent.req, result: { contents: 'x' } })
  assert.deepEqual((await p).result, { contents: 'x' })
  // An error answer rejects.
  const e = k.c.ask('definition', { position: { line: 0, character: 0 } })
  k.c.receive({ t: 'lsp-answer', req: k.last('lsp-ask').req, error: 'boom' })
  await assert.rejects(e, /boom/)
  // The deadline: lsp-cancel to the host, rejected here (typing never waits on it).
  const slow = k.c.ask('complete', { position: { line: 0, character: 0 } })
  const req = k.last('lsp-ask').req
  k.timers.fire(COMPLETE_TIMEOUT_MS)
  await assert.rejects(slow, /did not answer in time/)
  assert.deepEqual(k.last('lsp-cancel'), { t: 'lsp-cancel', req })
  // An abort (CodeMirror dropped the completion).
  const ctl = new AbortController()
  const aborted = k.c.ask('complete', { position: { line: 0, character: 0 } }, { signal: ctl.signal })
  ctl.abort()
  await assert.rejects(aborted, /cancelled/)
  assert.equal(k.last('lsp-cancel').req, k.last('lsp-ask').req)
  // A late answer for it is ignored.
  k.c.receive({ t: 'lsp-answer', req: k.last('lsp-ask').req, result: [] })
  // A new line: what waited is failed at once.
  const lost = k.c.ask('symbols')
  k.c.connect()
  await assert.rejects(lost, /renewed/)
  // No server for the file: refused here, nothing sent.
  const before = k.posts.length
  await assert.rejects(k.c.ask('hover', {}), /no language server/)
  assert.equal(k.posts.length, before)
  assert.equal(k.timers.pending.size, 0)
})

test('client: no server for this file (lsp-doc language null) is highlighting only; asks refused at once', async () => {
  const k = client()
  k.c.connect()
  k.c.open('notes.md', true)
  k.c.receive({ t: 'lsp-doc', path: 'notes.md', language: null })
  assert.equal(k.c.ready(), false)
  await assert.rejects(k.c.ask('hover', {}), /no language server/)
  k.c.changed([{ text: 'x' }])
  assert.equal(k.last('lsp-change'), undefined)
})

test('client: status and features; diagnostics for this file only; Restart names the language', () => {
  const k = readyClient()
  assert.equal(k.c.ready(), true)
  assert.equal(k.c.features().hover, true)
  k.c.receive({ t: 'lsp-diagnostics', path: 'src/b.ts', diagnostics: [{ message: 'other' }] })
  assert.equal(k.ui.diagnostics, null)
  k.c.receive({ t: 'lsp-diagnostics', path: 'src/a.ts', diagnostics: [{ message: 'mine' }] })
  assert.deepEqual(k.ui.diagnostics, [{ message: 'mine' }])
  // Ready but held by a stopped command (the bar offers Restart): still ready for asks; a non-string is dropped.
  k.c.receive({ t: 'lsp-status', language: 'typescript', name: 'TypeScript', state: 'ready', held: 'it has not answered', features: { hover: true } })
  assert.equal(k.ui.statuses.at(-1).held, 'it has not answered')
  assert.equal(k.c.ready(), true)
  k.c.receive({ t: 'lsp-status', language: 'typescript', name: 'TypeScript', state: 'ready', held: 5 })
  assert.equal(k.ui.statuses.at(-1).held, undefined)
  k.c.receive({ t: 'lsp-status', language: 'typescript', name: 'TypeScript', state: 'failed', message: 'crashed' })
  assert.equal(k.c.ready(), false)
  assert.deepEqual(k.c.features(), {})
  k.c.restart()
  assert.deepEqual(k.last('lsp-restart'), { t: 'lsp-restart', language: 'typescript' })
  // Another language's status (not this file's) is not taken.
  k.c.receive({ t: 'lsp-status', language: 'go', name: 'Go', state: 'ready' })
  assert.equal(k.ui.statuses.at(-1).language, 'typescript')
})

test('client: an lsp-edit is applied only when its seq is the last one this page sent and it is the owner; the answer goes back', () => {
  const k = readyClient()
  const edits = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'x' }]
  k.c.receive({ t: 'lsp-edit', id: 1, path: 'src/a.ts', seq: 1, edits })
  assert.deepEqual(k.last('lsp-edit-done'), { t: 'lsp-edit-done', id: 1, applied: true })
  assert.deepEqual(k.ui.applied, [edits])
  // Typed since: seq 2 sent, the host's edit names 1.
  k.c.changed([{ text: 'y' }])
  k.c.receive({ t: 'lsp-edit', id: 2, path: 'src/a.ts', seq: 1, edits })
  assert.equal(k.last('lsp-edit-done').applied, false)
  assert.match(k.last('lsp-edit-done').reason, /changed while/)
  // The buffer refuses (read-only).
  k.ui.refuse = 'the file is read-only here'
  k.c.receive({ t: 'lsp-edit', id: 3, path: 'src/a.ts', seq: 2, edits })
  assert.deepEqual(k.last('lsp-edit-done'), { t: 'lsp-edit-done', id: 3, applied: false, reason: 'the file is read-only here' })
  // Another file's, or a view that does not sync it.
  k.c.receive({ t: 'lsp-edit', id: 4, path: 'src/b.ts', seq: 2, edits })
  assert.equal(k.last('lsp-edit-done').applied, false)
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: false, state: 'ready' })
  k.ui.refuse = null
  k.c.receive({ t: 'lsp-edit', id: 5, path: 'src/a.ts', seq: 2, edits })
  assert.match(k.last('lsp-edit-done').reason, /does not sync/)
  assert.equal(k.ui.applied.length, 1)
})

test('client: typing before the host confirms ownership is sent as the whole text once it does; an edit for the old text is refused', () => {
  const k = client('abc')
  k.c.connect()
  k.c.open('src/a.ts', true)
  assert.equal(k.last('lsp-open').seq, 1)
  // Typed before lsp-doc: not sent (not the owner yet), so the host still holds "abc" at seq 1.
  k.ui.text = 'Xabc'
  k.c.changed([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'X' }])
  assert.equal(k.last('lsp-change'), undefined)
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: true, state: 'ready' })
  // Confirmed the owner: all of the text again with the next seq, never a change on top of "abc".
  assert.deepEqual(k.last('lsp-open'), { t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 1, text: 'Xabc', seq: 2 })
  assert.equal(k.last('lsp-change'), undefined)
  // A format the host computed on "abc" (seq 1) is refused here.
  k.c.receive({ t: 'lsp-edit', id: 1, path: 'src/a.ts', seq: 1, edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'ABC' }] })
  assert.equal(k.last('lsp-edit-done').applied, false)
  assert.equal(k.ui.applied.length, 0)
  // The host's lsp-doc for the resync: nothing unsent, no second open; changes go on from seq 2.
  const opens = k.posts.filter((p) => p.t === 'lsp-open').length
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: true, state: 'ready' })
  assert.equal(k.posts.filter((p) => p.t === 'lsp-open').length, opens)
  k.c.changed([{ text: 'Xabcd' }])
  assert.equal(k.last('lsp-change').seq, 3)
  // A view that is not the owner types, then becomes it by lsp-doc: the whole text again too.
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: false, state: 'ready' })
  k.ui.text = 'Xabcde'
  k.c.changed([{ text: 'Xabcde' }])
  assert.equal(k.last('lsp-change').seq, 3)
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: true, state: 'ready' })
  assert.deepEqual([k.last('lsp-open').text, k.last('lsp-open').seq], ['Xabcde', 4])
})

test('client: a change no LSP range names (null, one inside a CRLF) sends the whole text with a new seq; not yet the owner, it waits', () => {
  const k = readyClient()
  const seq = k.last('lsp-open').seq
  k.ui.text = 'a\rQ\nb'
  k.c.changed(null)
  assert.deepEqual(k.last('lsp-open'), { t: 'lsp-open', path: 'src/a.ts', part: 0, parts: 1, text: 'a\rQ\nb', seq: seq + 1 })
  assert.equal(k.last('lsp-change'), undefined)
  // Not the owner: marked unsent, sent whole once ownership comes.
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: false, state: 'ready' })
  const opens = k.posts.filter((p) => p.t === 'lsp-open').length
  k.c.changed(null)
  assert.equal(k.posts.filter((p) => p.t === 'lsp-open').length, opens)
  k.c.receive({ t: 'lsp-doc', path: 'src/a.ts', language: 'typescript', owner: true, state: 'ready' })
  assert.equal(k.last('lsp-open').seq, seq + 2)
})

test('client: close tells the host, clears the diagnostics and fails what waited', async () => {
  const k = readyClient()
  k.c.receive({ t: 'lsp-diagnostics', path: 'src/a.ts', diagnostics: [{ message: 'x' }] })
  const p = k.c.ask('hover', {})
  k.c.close()
  await assert.rejects(p, /no longer open/)
  assert.deepEqual(k.last('lsp-close'), { t: 'lsp-close', path: 'src/a.ts' })
  assert.deepEqual(k.ui.diagnostics, [])
  // Open again: all of the text with a new seq.
  k.c.open('src/a.ts', true)
  assert.equal(k.last('lsp-open').seq, 2)
})
