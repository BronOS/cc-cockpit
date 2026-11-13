import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EditorState } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { leadingColumns, guideStyle, guideDecorations, detectIndentUnit } from '../src/page/indent-guides.mjs'

test('leadingColumns counts spaces and tabs to the next tab stop', () => {
  assert.equal(leadingColumns('    x', 4), 4)
  assert.equal(leadingColumns('\tx', 4), 4)
  assert.equal(leadingColumns('  \tx', 4), 4)
  // Tab then spaces: the tab fills its stop, the spaces count after it.
  assert.equal(leadingColumns('\t  x', 4), 6)
  assert.equal(leadingColumns('x', 4), 0)
})

test('a blank or whitespace-only line has no columns, so no guide', () => {
  assert.equal(leadingColumns('', 4), 0)
  assert.equal(leadingColumns('      ', 4), 0)
  assert.equal(guideStyle(0, 2), null)
})

test('guideStyle repeats a line every indent unit over the indent width', () => {
  const s = guideStyle(8, 4)
  assert.match(s, /transparent 1px,transparent 4ch/)
  assert.match(s, /background-size:8ch 100%/)
  assert.equal(guideStyle(4, 0), null)
})

test('guideStyle draws in --cc-border, a variable both app themes define', () => {
  assert.match(guideStyle(4, 4), /var\(--cc-border\)/)
  for (const theme of ['dark', 'light']) {
    const json = JSON.parse(readFileSync(new URL(`../../../src/themes/${theme}.json`, import.meta.url), 'utf8'))
    assert.ok(JSON.stringify(json).includes('"--cc-border":'), `${theme}.json defines --cc-border`)
  }
})

test('detectIndentUnit: tabs, the space step, block comments ignored, nothing for a flat file', () => {
  // Go: tab-indented, with a block comment's ` * ` lines that must not count as a unit of 1.
  assert.equal(detectIndentUnit('package a\n\n/*\n * doc\n */\nfunc f() {\n\tif x {\n\t\treturn\n\t}\n}\n'), '\t')
  assert.equal(detectIndentUnit('def f():\n    if x:\n        return 1\n    return 2\n'), '    ')
  assert.equal(detectIndentUnit('/**\n * doc\n */\nfunction f() {\n  if (x) {\n    return\n  }\n}\n'), '  ')
  // CRLF and a dedent in between change nothing.
  assert.equal(detectIndentUnit('a:\r\n  b:\r\n    c: 1\r\n  d: 2\r\ne:\r\n  f: 3\r\n'), '  ')
  assert.equal(detectIndentUnit('one\ntwo\n\nthree\n'), null)
  assert.equal(detectIndentUnit(''), null)
})

/** The style of each decorated line, by line number. */
function styles(state, ranges) {
  const got = {}
  guideDecorations(state, ranges).between(0, state.doc.length, (from, _to, deco) => {
    got[state.doc.lineAt(from).number] = deco.spec.attributes.style
  })
  return got
}

test('guideDecorations: a tab-indented file with a tab unit gets one guide per tab, blank lines none', () => {
  const doc = 'func f() {\n\tif x {\n\n\t\treturn\n\t}\n}'
  const state = EditorState.create({ doc, extensions: [indentUnit.of(detectIndentUnit(doc))] })
  const got = styles(state, [{ from: 0, to: state.doc.length }])
  assert.deepEqual(Object.keys(got).map(Number), [2, 4, 5])
  // tabSize 4 and a tab unit: guides every 4ch, over 4ch (one tab) and 8ch (two).
  assert.match(got[2], /transparent 4ch\).*background-size:4ch/)
  assert.match(got[4], /transparent 4ch\).*background-size:8ch/)
})

test('guideDecorations: only the visible ranges, each line once, a tab then spaces counted from the stop', () => {
  const doc = ['a', '  b', '    c', '\t  d', '  e', '  f'].join('\n')
  const state = EditorState.create({ doc, extensions: [indentUnit.of('  ')] })
  const line = (n) => state.doc.line(n)
  // Two ranges touching the same line (as a fold leaves them): line 3 is drawn once; 1 (no indent) and 6 (not visible) not at all.
  const got = styles(state, [
    { from: line(1).from, to: line(3).from + 2 },
    { from: line(3).from + 3, to: line(5).to },
  ])
  assert.deepEqual(Object.keys(got).map(Number), [2, 3, 4, 5])
  assert.match(got[4], /background-size:6ch/)
})

test('guideDecorations after a change: the new text decides', () => {
  let state = EditorState.create({ doc: 'a\n    b', extensions: [indentUnit.of('    ')] })
  state = state.update({ changes: { from: 2, to: 6, insert: '' } }).state
  assert.deepEqual(styles(state, [{ from: 0, to: state.doc.length }]), {})
  state = state.update({ changes: { from: 2, insert: '        ' } }).state
  assert.match(styles(state, [{ from: 0, to: state.doc.length }])[2], /background-size:8ch/)
})
