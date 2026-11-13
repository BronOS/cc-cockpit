// src/page/lsp/editor.js's two buffer-facing calls with no DOM: applyEditsTo (the host's rename, format
// and code-action edits on the buffer, one undoable change) and showDiagnostics (the server's list as
// CodeMirror lint diagnostics). A view is only `state` and `dispatch` to them, so a real EditorState
// with a dispatch that applies the transaction stands in for one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { forEachDiagnostic } from '@codemirror/lint'
import { CompletionContext } from '@codemirror/autocomplete'
import { applyEditsTo, showDiagnostics, lspFeatures } from '../src/page/lsp/editor.js'

function fakeView(text, { readOnly = false } = {}) {
  const v = {
    state: EditorState.create({ doc: text, extensions: readOnly ? [EditorState.readOnly.of(true)] : [] }),
    transactions: [],
    dispatch(...specs) {
      const tr = v.state.update(...specs)
      v.transactions.push(tr)
      v.state = tr.state
    },
  }
  return v
}

const at = (line, character) => ({ line, character })
const edit = (sl, sc, el, ec, newText) => ({ range: { start: at(sl, sc), end: at(el, ec) }, newText })

test('applyEditsTo: the edits as one change the person can undo', () => {
  const v = fakeView('let a = 1\nlet b = a\n')
  assert.equal(applyEditsTo(v, [edit(0, 4, 0, 5, 'x'), edit(1, 8, 1, 9, 'x')]), true)
  assert.equal(v.state.doc.toString(), 'let x = 1\nlet b = x\n')
  assert.equal(v.transactions.length, 1)
  assert.equal(v.transactions[0].isUserEvent('input'), true)
})

test('applyEditsTo: no view, a read-only buffer and bad edits are refused with the reason; nothing changes', () => {
  assert.equal(applyEditsTo(null, [edit(0, 0, 0, 0, 'x')]), 'the file is not shown')
  const ro = fakeView('abc', { readOnly: true })
  assert.equal(applyEditsTo(ro, [edit(0, 0, 0, 0, 'x')]), 'the file is read-only here')
  assert.equal(ro.state.doc.toString(), 'abc')
  const v = fakeView('abc')
  // editsToChanges' own reason passes through.
  assert.equal(applyEditsTo(v, 'nope'), 'not a list of edits')
  assert.equal(applyEditsTo(v, [edit(0, 2, 0, 1, 'x')]), 'an edit ends before it starts')
  assert.equal(v.transactions.length, 0)
  // No edits: nothing dispatched (no empty undo step, no dirty mark), still a success.
  assert.equal(applyEditsTo(v, []), true)
  assert.equal(v.transactions.length, 0)
})

const diagnosticsOf = (state) => {
  const out = []
  forEachDiagnostic(state, (d, from, to) => out.push({ from, to, severity: d.severity, message: d.message, source: d.source }))
  return out
}

test('showDiagnostics: range, severity, the code after the message, the source only when given', () => {
  const v = fakeView('let a = 1\nlet b = a\n')
  showDiagnostics(v, [
    { range: { start: at(0, 4), end: at(0, 5) }, severity: 1, message: 'unused', source: 'ts', code: 6133 },
    { range: { start: at(1, 0), end: at(1, 3) }, severity: 2, message: 'style', source: '' },
  ])
  assert.deepEqual(diagnosticsOf(v.state), [
    { from: 4, to: 5, severity: 'error', message: 'unused (6133)', source: 'ts' },
    { from: 10, to: 13, severity: 'warning', message: 'style', source: undefined },
  ])
})

test('showDiagnostics: a zero-width diagnostic marks the next character, or the one before at a line end', () => {
  const v = fakeView('abc\n\nxyz')
  showDiagnostics(v, [
    { range: { start: at(0, 1), end: at(0, 1) }, message: 'mid' },
    { range: { start: at(0, 3), end: at(0, 3) }, message: 'end' },
    // An empty line: nothing to widen to on either side, it stays empty.
    { range: { start: at(1, 0), end: at(1, 0) }, message: 'empty' },
  ])
  assert.deepEqual(
    diagnosticsOf(v.state).map(({ from, to, message }) => [message, from, to]),
    [
      ['mid', 1, 2],
      ['end', 2, 3],
      ['empty', 4, 4],
    ]
  )
})

test('showDiagnostics: malformed entries are skipped; no view does nothing', () => {
  const v = fakeView('abc')
  showDiagnostics(v, [null, { message: 'no range' }, { range: { start: at(0, 0), end: at(0, 1) } }, { range: { start: at(0, 0), end: at(0, 1) }, message: 'ok' }])
  assert.deepEqual(diagnosticsOf(v.state).map((d) => d.message), ['ok'])
  assert.doesNotThrow(() => showDiagnostics(null, []))
})

test('lspFeatures: a definition or a symbol in this file goes to its LSP position, not to the CodeMirror line of that number (a lone \\r is an LSP break the buffer keeps inside a line)', async () => {
  const range = { start: at(1, 1), end: at(1, 2) } // the second `b` of `a\rbb`: LSP line 1
  const answers = {
    definition: { result: [{ path: 'src/a.ts', range }] },
    symbols: { result: [{ name: 'bb', kind: 13, range, selectionRange: range }] },
  }
  const gone = []
  let list = null
  const ui = lspFeatures({
    client: { ready: () => true, synced: () => true, features: () => ({ definition: true, symbols: true }), ask: async (what) => answers[what] },
    path: () => 'src/a.ts',
    goto: (line, col) => gone.push([line, col]),
    openLocation: (loc) => gone.push(['open', loc.line, loc.col]),
    showList: (spec) => (list = spec),
    prompt() {},
    message() {},
  })
  const view = { state: EditorState.create({ doc: 'a\rbb\ncc', extensions: EditorState.lineSeparator.of('\n') }), dispatch() {} }
  await ui.goToDefinition(view)
  await ui.documentSymbols(view)
  list.onPick(list.items[0].target)
  // Offset 3 is CodeMirror line 1, column 4; line 2 would be `cc`.
  assert.deepEqual(gone, [
    [1, 4],
    [1, 4],
  ])
})

// The completion source as CodeMirror runs it: from the language data the extensions add, with the
// state at the ask; the option is then applied on the state of when the person accepts it.
async function completeWith(doc, pos, result, { synced = true } = {}) {
  const ui = lspFeatures({
    client: { ready: () => true, synced: () => synced, features: () => ({ complete: true }), ask: async () => ({ result }) },
    path: () => 'a.ts',
    goto() {},
    openLocation() {},
    showList() {},
    prompt() {},
    message() {},
  })
  const v = fakeView('')
  v.state = EditorState.create({ doc, extensions: ui.extensions })
  const source = v.state.languageDataAt('autocomplete', pos).find((s) => typeof s === 'function')
  const answer = await source(new CompletionContext(v.state, pos, true))
  return { v, answer }
}

test('completion: a text edit range is resolved on the text at the ask, then carried over what was typed since', async () => {
  // `abZZ` asked after `ab`, the item replacing the whole word; a backspace before accepting.
  const item = { label: 'abc', textEdit: { range: { start: at(0, 0), end: at(0, 4) }, newText: 'abc' } }
  let { v, answer } = await completeWith('abZZ', 2, [item])
  v.dispatch({ changes: { from: 1, to: 2 } })
  answer.options[0].apply(v, answer.options[0], 0, 1)
  assert.equal(v.state.doc.toString(), 'abc')
  // Typing at the end of the word instead: the range grows with it.
  ;({ v, answer } = await completeWith('abZZ', 2, [item]))
  v.dispatch({ changes: { from: 2, insert: 'x' } })
  answer.options[0].apply(v, answer.options[0], 0, 3)
  assert.equal(v.state.doc.toString(), 'abc')
})

test('completion: additional edits are carried over the typing since too', async () => {
  // An extra edit later on the same line: typing before it moves it right.
  const item = { label: 'abc', textEdit: { range: { start: at(0, 0), end: at(0, 2) }, newText: 'abc' }, additionalTextEdits: [edit(0, 4, 0, 7, 'bar')] }
  const { v, answer } = await completeWith('ab; foo', 2, [item])
  v.dispatch({ changes: { from: 2, insert: 'c' } })
  answer.options[0].apply(v, answer.options[0], 0, 3)
  assert.equal(v.state.doc.toString(), 'abc; bar')
})

test("completion in a view that is not the syncing owner: the server answered on the owner's buffer, so no auto-import or range of its lands here; the item replaces the word only", async () => {
  // The owner's buffer has no import line; this view's unsaved first line is `import { b } from 'b'`.
  // The server's auto-import (computed on the owner's text) would overwrite it at line 0.
  const doc = "import { b } from 'b'\nab"
  const item = { label: 'abc', textEdit: { range: { start: at(1, 0), end: at(1, 2) }, newText: 'abc' }, additionalTextEdits: [edit(0, 0, 0, 21, "import { abc } from 'x'")] }
  const { v, answer } = await completeWith(doc, doc.length, [item], { synced: false })
  answer.options[0].apply(v, answer.options[0], doc.length - 2, doc.length)
  assert.equal(v.state.doc.toString(), "import { b } from 'b'\nabc")
  // The owner (synced): the same item lands with its auto-import.
  const owner = await completeWith(doc, doc.length, [item])
  owner.answer.options[0].apply(owner.v, owner.answer.options[0], doc.length - 2, doc.length)
  assert.equal(owner.v.state.doc.toString(), "import { abc } from 'x'\nabc")
})

test('rename and code actions from a view that is not the syncing owner are refused with a message: its cursor names a place in its own buffer, the server reads the owner\'s', async () => {
  const asked = []
  const said = []
  let synced = false
  const ui = lspFeatures({
    client: { ready: () => true, synced: () => synced, features: () => ({ rename: true, codeActions: true }), ask: async (what) => (asked.push(what), { result: [] }) },
    path: () => 'a.ts',
    goto() {},
    openLocation() {},
    showList() {},
    prompt() {},
    message: (text, error) => said.push([text, error === true]),
  })
  const view = fakeView('const a = 1\n')
  await ui.renameSymbol(view)
  await ui.codeActions(view)
  assert.deepEqual(asked, [])
  assert.deepEqual(said, [
    ['Rename: another view of this file syncs it with the language server; use that view.', true],
    ['Code actions: another view of this file syncs it with the language server; use that view.', true],
  ])
  // The owner asks.
  synced = true
  await ui.codeActions(view)
  assert.deepEqual(asked, ['codeActions'])
})
