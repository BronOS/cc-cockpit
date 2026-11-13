import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EditorState } from '@codemirror/state'
import { keepLineBreaks, pastedText } from '../src/page/line-breaks.mjs'
import { createSession } from '../src/page/session.mjs'

const require = createRequire(import.meta.url)
const files = require('../dist/lib/files.js')

// A mixed file (CRLF and LF lines), a lone CR break and a stray CR inside a line: the host leaves the
// `\r` in (decodeBytes makes CRLF LF only when every line has it).
const MIXED = 'one\r\ntwo\nthree\rfour\nfi\rve\r\n'

test('the host leaves a mixed file its CRs, and puts back exactly those bytes at save', () => {
  const d = files.decodeBytes(Buffer.from(MIXED))
  assert.equal(d.eol, '\n')
  assert.equal(d.text, MIXED)
  assert.equal(files.encodeText(d.text, d).toString(), MIXED)
})

test('with keepLineBreaks the buffer is the file text exactly: lines split on \\n only', () => {
  const state = EditorState.create({ doc: MIXED, extensions: keepLineBreaks })
  assert.equal(state.doc.toString(), MIXED)
  assert.equal(state.doc.lines, 5)
  assert.equal(state.doc.line(1).text, 'one\r')
  assert.equal(state.lineBreak, '\n')
  // CodeMirror's default would split on \r too and give the text back as LF: the buffer that never
  // equalled its base (dirty at load, the first autosave rewriting the line endings).
  assert.notEqual(EditorState.create({ doc: MIXED }).doc.toString(), MIXED)
})

test('pasted text breaks lines on CRLF and CR as before: no CR comes into an LF file', () => {
  assert.equal(pastedText('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  assert.equal(pastedText('plain'), 'plain')
})

test('a mixed-EOL file loads clean: no dirty mark, no autosave on blur', () => {
  let state = null
  const posted = []
  const dirty = []
  const session = createSession({
    post: (m) => posted.push(m),
    getText: () => state.doc.toString(),
    load: (text) => {
      state = EditorState.create({ doc: text, extensions: keepLineBreaks })
    },
    replace: (text) => {
      state = EditorState.create({ doc: text, extensions: keepLineBreaks })
    },
    merge: () => {},
    goto: () => {},
    setDirty: (d) => dirty.push(d),
    render: () => {},
  }, { set: () => 0, clear: () => {} })
  session.connect()
  const open = posted.find((m) => m.t === 'open')
  const d = files.decodeBytes(Buffer.from(MIXED))
  session.receive({ t: 'file', req: open.req, path: 'mixed.txt', exists: true, hash: 'h1', readOnly: false, eol: d.eol, bom: d.bom, size: MIXED.length, part: 0, parts: 1, text: d.text })
  assert.equal(session.view().dirty, false)
  assert.ok(!dirty.includes(true))
  session.blur()
  assert.equal(posted.filter((m) => m.t === 'save').length, 0)
})
