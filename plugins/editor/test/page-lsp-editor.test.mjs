// src/page/lsp/editor.js's two buffer-facing calls with no DOM: applyEditsTo (the host's rename, format
// and code-action edits on the buffer, one undoable change) and showDiagnostics (the server's list as
// CodeMirror lint diagnostics). A view is only `state` and `dispatch` to them, so a real EditorState
// with a dispatch that applies the transaction stands in for one.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { forEachDiagnostic } from '@codemirror/lint'
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
    client: { ready: () => true, features: () => ({ definition: true, symbols: true }), ask: async (what) => answers[what] },
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
