// Quick chat's page half with no DOM: the target and the lines around it (src/page/chat.mjs), the
// proposal kept, mapped, dropped and accepted in the editor state (chat-editor.js createChatField),
// and answers as a Markdown tree with no HTML (chat-markdown.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState, Text } from '@codemirror/state'
import { chatTarget, contextAround, fitNewline, mapTarget, proposalFits, proposalLines, MAX_TARGET_CHARS } from '../src/page/chat.mjs'
import { createChatField, setTarget, setProposal, accepted } from '../src/page/chat-editor.js'
import { markdownTree } from '../src/page/chat-markdown.mjs'

const state = (doc, anchor, head = anchor, extensions = []) => EditorState.create({ doc, selection: { anchor, head }, extensions })

test('chatTarget: the selection, or the cursor line with none', () => {
  assert.deepEqual(chatTarget(state('one\ntwo\nthree', 4, 13)), { from: 4, to: 13, startLine: 2, endLine: 3, text: 'two\nthree' })
  assert.deepEqual(chatTarget(state('one\ntwo\nthree', 5)), { from: 4, to: 7, startLine: 2, endLine: 2, text: 'two' })
  // Ending at a line start leaves that line out.
  assert.deepEqual(chatTarget(state('one\ntwo\nthree', 4, 8)), { from: 4, to: 7, startLine: 2, endLine: 2, text: 'two' })
  // An empty line is a target too (a proposal inserts there).
  assert.deepEqual(chatTarget(state('a\n\nb', 2)), { from: 2, to: 2, startLine: 2, endLine: 2, text: '' })
  assert.match(chatTarget(state('x'.repeat(MAX_TARGET_CHARS + 1), 0, MAX_TARGET_CHARS + 1)).error, /at most 20,000/)
})

test('contextAround: whole lines each side plus the target\'s own partial lines, capped', () => {
  const doc = Text.of(Array.from({ length: 40 }, (_, i) => `l${i + 1}`))
  const l20 = doc.line(20)
  const got = contextAround(doc, l20.from + 1, l20.to - 1, 3)
  assert.equal(got.before, 'l17\nl18\nl19\nl')
  assert.equal(got.after, '0\nl21\nl22\nl23')
  const edge = contextAround(doc, 0, doc.line(1).to, 3)
  assert.equal(edge.before, '')
  assert.equal(edge.after, '\nl2\nl3\nl4')
  const capped = contextAround(doc, l20.from, l20.to, 15, 10)
  assert.equal(capped.before.length, 10)
  assert.ok(capped.before.endsWith('l19\n'))
  assert.equal(capped.after.length, 10)
})

test('mapTarget: inserts at the edges stay outside; text inside moves the end', () => {
  const s = state('aaa bbb ccc', 0)
  const at = (from, insert, to = from) => s.changes({ from, to, insert })
  assert.deepEqual(mapTarget({ from: 4, to: 7 }, at(4, 'X')), { from: 5, to: 8 })
  assert.deepEqual(mapTarget({ from: 4, to: 7 }, at(7, 'X')), { from: 4, to: 7 })
  assert.deepEqual(mapTarget({ from: 4, to: 7 }, at(5, 'XY')), { from: 4, to: 9 })
  assert.deepEqual(mapTarget({ from: 4, to: 7 }, at(0, '', 8)), { from: 0, to: 0 })
})

test('fitNewline, proposalFits and proposalLines', () => {
  assert.equal(fitNewline('a\n', 'b'), 'b\n')
  assert.equal(fitNewline('a', 'b'), 'b')
  assert.equal(fitNewline('a\n', 'b\n'), 'b\n')
  const doc = Text.of(['one', 'two'])
  assert.equal(proposalFits(doc, { from: 4, to: 7 }, 'two'), true)
  assert.equal(proposalFits(doc, { from: 4, to: 7 }, 'TWO'), false)
  assert.equal(proposalFits(doc, null, 'two'), false)
  assert.equal(proposalFits(doc, { from: 4, to: 70 }, 'two'), false)
  const p = proposalLines('a\nb\nc', 'a\nB\nc\nd')
  assert.deepEqual([...p.removed], [1])
  assert.deepEqual([...p.added].sort(), [1, 3])
  assert.deepEqual(p.lines, ['a', 'B', 'c', 'd'])
})

/** An editor state with the chat field, a target set over `text`'s first occurrence. */
function withTarget(doc, text) {
  const field = createChatField({ accept() {}, reject() {} })
  let s = state(doc, 0, 0, [field])
  const from = doc.indexOf(text)
  s = s.update({ effects: setTarget.of({ from, to: from + text.length }) }).state
  return { field, s, from }
}

const propose = (forText, text) => setProposal.of({ text, forText, info: proposalLines(forText, text) })

test('the field: a proposal is kept and mapped through edits outside its target', () => {
  const { field, s: s0, from } = withTarget('head\nold line\ntail', 'old line')
  let s = s0.update({ effects: propose('old line', 'new line') }).state
  assert.equal(s.field(field).proposal.text, 'new line')
  assert.ok(s.field(field).deco.size > 0)
  // Typing before it moves it; typing after it leaves it.
  s = s.update({ changes: { from: 0, insert: '>> ' } }).state
  assert.deepEqual(s.field(field).target, { from: from + 3, to: from + 3 + 8 })
  s = s.update({ changes: { from: s.doc.length, insert: '!' } }).state
  assert.equal(s.field(field).proposal.text, 'new line')
  assert.equal(s.field(field).dropped, false)
})

test('the field: an edit inside the target drops the proposal, once', () => {
  const { field, s: s0, from } = withTarget('head\nold line\ntail', 'old line')
  let s = s0.update({ effects: propose('old line', 'new line') }).state
  s = s.update({ changes: { from: from + 1, insert: 'X' } }).state
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).dropped, true)
  assert.deepEqual(s.field(field).target, { from, to: from + 9 })
  s = s.update({ changes: { from: 0, insert: 'y' } }).state
  assert.equal(s.field(field).dropped, false)
})

test('the field: a proposal for text that already changed is dropped at once', () => {
  const { field, s: s0 } = withTarget('head\nold line\ntail', 'old line')
  const s = s0.update({ effects: propose('older line', 'new line') }).state
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).dropped, true)
})

test('the field: text typed at an empty target drops its proposal; an edit elsewhere keeps it', () => {
  const { field, s: s0 } = withTarget('a\n\nb', 'a')
  let s = s0.update({ effects: setTarget.of({ from: 2, to: 2 }) }).state
  s = s.update({ effects: propose('', 'new') }).state
  assert.equal(s.field(field).proposal.text, 'new')
  s = s.update({ changes: { from: 0, insert: 'x' } }).state
  assert.equal(s.field(field).proposal.text, 'new')
  s = s.update({ changes: { from: 3, insert: 'typed' } }).state
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).dropped, true)
})

test('the field: a reload that rewrites the target (Claude\'s own write) drops it', () => {
  const { field, s: s0, from } = withTarget('head\nold line\ntail', 'old line')
  let s = s0.update({ effects: propose('old line', 'new line') }).state
  s = s.update({ changes: { from, to: from + 8, insert: 'claude wrote this' } }).state
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).dropped, true)
})

test('the field: accept puts the text in and makes it the target; reject and a new target drop it', () => {
  const { field, s: s0, from } = withTarget('head\nold line\ntail', 'old line')
  let s = s0.update({ effects: propose('old line', 'new\nlines') }).state
  const p = s.field(field)
  s = s.update({ changes: { from: p.target.from, to: p.target.to, insert: p.proposal.text }, effects: accepted.of({ from: p.target.from, to: p.target.from + 9 }) }).state
  assert.equal(s.doc.toString(), 'head\nnew\nlines\ntail')
  assert.deepEqual(s.field(field).target, { from, to: from + 9 })
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).dropped, false)
  s = s.update({ effects: propose('new\nlines', 'x') }).state
  s = s.update({ effects: setProposal.of(null) }).state
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).dropped, false)
  s = s.update({ effects: propose('new\nlines', 'x') }).state
  s = s.update({ effects: setTarget.of(null) }).state
  assert.equal(s.field(field).target, null)
  assert.equal(s.field(field).proposal, null)
  assert.equal(s.field(field).deco.size, 0)
})

test('markdownTree: blocks and inline marks as a tree, raw HTML as text, links not followed', () => {
  const t = markdownTree('# Title\n\nSome **bold** and `code` <img src=x onerror=alert(1)>.\n\n- one\n- [two](http://evil)\n\n```replacement\nnew\n```')
  const [h1, p, ul, pre] = t.children
  assert.deepEqual(h1, { tag: 'h1', children: ['Title'] })
  assert.equal(p.tag, 'p')
  assert.deepEqual(p.children[1], { tag: 'strong', children: ['bold'] })
  assert.deepEqual(p.children[3], { tag: 'code', text: 'code' })
  // The HTML is only ever text.
  assert.ok(p.children.filter((c) => typeof c === 'string').join('').includes('<img src=x onerror=alert(1)>'))
  assert.equal(ul.tag, 'ul')
  // A tight list's items hold their text directly (no paragraph).
  assert.deepEqual(ul.children[0], { tag: 'li', children: ['one'] })
  assert.deepEqual(ul.children[1].children[0], { tag: 'a', children: ['two'], title: 'http://evil' })
  assert.deepEqual(pre, { tag: 'pre', text: 'new', info: 'replacement' })
  // Strikethrough is an allowed tag.
  assert.deepEqual(markdownTree('a~~b~~').children[0].children[1], { tag: 's', children: ['b'] })
})
