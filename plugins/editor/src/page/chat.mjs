// Quick chat's page logic (design-editor.md §4 "Quick chat"), with no DOM: what the chat is about
// (the target: the selection, or the cursor's line), the lines around it, how the target follows
// later edits, and whether a proposal still fits. chat-editor.js draws it; node:test drives this
// (test/page-chat.test.mjs). The host (dist/lib/quick-chat.js) runs Claude and finds the proposal.
//
// A proposal replaces the target's text as it was when the question was asked (`forText`). The
// target is mapped through every later edit (the person typing, a reload or a merge of Claude's own
// changes), and a proposal whose `forText` is no longer exactly the target's text is dropped: Accept
// would otherwise overwrite something Claude never saw.
import { diffLines, splitLines } from './merge.mjs'

/** A selection over this many characters is refused (the host refuses it too): a proposal replaces all of it. */
export const MAX_TARGET_CHARS = 20000
/** About this many lines before and after the target go with the first question (design: "about 30 lines around it"). */
export const CONTEXT_LINES = 15
/** Each side of that context is cut to this many characters (the far side goes). */
export const MAX_CONTEXT_CHARS = 6000

/**
 * The chat's target in `state`: the main selection, or the cursor's whole line when nothing is
 * selected. `{ from, to, startLine, endLine, text }` (lines 1-based, inclusive), or `{ error }`. A
 * selection that ends at the very start of a line leaves that line (and the newline before it) out,
 * as Ask Claude's does.
 */
export function chatTarget(state, max = MAX_TARGET_CHARS) {
  const sel = state.selection.main
  let from = sel.from
  let to = sel.to
  if (from === to) {
    const line = state.doc.lineAt(from)
    from = line.from
    to = line.to
  } else {
    const last = state.doc.lineAt(to)
    if (to === last.from && last.number > state.doc.lineAt(from).number) to -= 1
  }
  const text = state.sliceDoc(from, to)
  if (text.length > max) return { error: `Select at most ${max.toLocaleString('en-US')} characters for quick chat.` }
  return { from, to, startLine: state.doc.lineAt(from).number, endLine: state.doc.lineAt(to).number, text }
}

/**
 * The text before and after [from, to) in `doc` (a CodeMirror Text): up to `lines` whole lines each
 * side, the target's own partial lines included (the start of its first line, the rest of its last).
 */
export function contextAround(doc, from, to, lines = CONTEXT_LINES, maxChars = MAX_CONTEXT_CHARS) {
  const first = doc.lineAt(from)
  const last = doc.lineAt(to)
  const startLine = Math.max(1, first.number - lines)
  const endLine = Math.min(doc.lines, last.number + lines)
  let before = doc.sliceString(doc.line(startLine).from, first.from)
  let after = doc.sliceString(last.to, doc.line(endLine).to)
  // The target's own partial lines: the part of its first line before it, the part of its last after it.
  const lead = doc.sliceString(first.from, from)
  const tail = doc.sliceString(to, last.to)
  before += lead
  after = tail + after
  if (before.length > maxChars) before = before.slice(before.length - maxChars)
  if (after.length > maxChars) after = after.slice(0, maxChars)
  return { before, after }
}

/**
 * `target` ({ from, to }) through `changes` (a ChangeSet): text inserted at either edge stays outside
 * it; a target whose text was all deleted collapses to where it was.
 */
export function mapTarget(target, changes) {
  const from = changes.mapPos(target.from, 1)
  const to = Math.max(from, changes.mapPos(target.to, -1))
  return { from, to }
}

/** Whether a proposal made for `forText` still fits: the target's text in `doc` is exactly that. */
export function proposalFits(doc, target, forText) {
  return !!target && target.to <= doc.length && doc.sliceString(target.from, target.to) === forText
}

/**
 * The proposal as it goes into the buffer: a fence body has no final newline, so when the text it
 * replaces ended with one, so does the replacement (else Accept would join two lines).
 */
export function fitNewline(original, text) {
  if (original.endsWith('\n') && !text.endsWith('\n')) return text + '\n'
  return text
}

/**
 * The inline diff of a proposal against the text it replaces, by line: `removed` holds the indexes
 * of `original`'s lines that go (or change), `added` those of `proposal`'s lines that are new.
 */
export function proposalLines(original, proposal) {
  const a = splitLines(original.endsWith('\n') ? original : original + '\n')
  const b = splitLines(proposal.endsWith('\n') ? proposal : proposal + '\n')
  const removed = new Set()
  const added = new Set()
  for (const r of diffLines(a, b)) {
    for (let i = r.aS; i < r.aE; i++) removed.add(i)
    for (let i = r.bS; i < r.bE; i++) added.add(i)
  }
  return { removed, added, lines: b.map((l) => (l.endsWith('\n') ? l.slice(0, -1) : l)) }
}
