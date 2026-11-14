// Ask Claude's page half (design-editor.md §4 "Ask Claude"): what the person has selected, as the host
// needs it for core's Discuss. Core draws the question box (ccPanel.tab.discuss()) and then asks the
// host's onDiscuss, which asks this page for the selection (lib/ask.js turns it into the text Claude
// gets). Pure over a CodeMirror state, so node:test runs it with no DOM.
//
// The Reviewer's notes go with it (design-editor.md §4): every note of the file, by id with the lines the
// gutter shows it on (notes-editor.js noteLines: the Reviewer's lines of the file on disk, mapped through
// the edits since), so a dirty buffer still matches the selection. The words are the host's to add, and
// it marks the ones on the asked lines; the page sends ids and lines only.

/**
 * The selection's text is cut to this many characters here (the host cuts again): the whole Discuss
 * message is capped at 20,000 and core cuts the plugin's context, which would take the closing fence
 * with it, so the selection stays well inside.
 */
export const MAX_ASK_CHARS = 8000

/**
 * The main selection as `{ startLine, endLine, text, cut }`, lines 1-based and inclusive, or with
 * `text: ''` (and both lines the cursor's) when nothing is selected. A selection that ends at the very
 * start of a line (a triple click, Shift+Down from a line start) does not include that line, so it is
 * not counted in the range, and its last newline is not in the text. `cut` says the text was shortened
 * to `max` characters; the range then ends where the text does.
 */
export function selectionContext(state, max = MAX_ASK_CHARS) {
  const { from, to } = state.selection.main
  const first = state.doc.lineAt(from)
  if (from === to) return { startLine: first.number, endLine: first.number, text: '', cut: false }
  let end = to
  const last = state.doc.lineAt(end)
  // `to` at a line's start, past the first line: the newline before it is the selection's last character.
  if (end === last.from && last.number > first.number) end -= 1
  let text = state.sliceDoc(from, end)
  let cut = false
  if (text.length > max) {
    let keep = max
    // Never between the two halves of a surrogate pair.
    const code = text.charCodeAt(keep - 1)
    if (code >= 0xd800 && code <= 0xdbff) keep -= 1
    text = text.slice(0, keep)
    end = from + keep
    cut = true
  }
  return { startLine: first.number, endLine: state.doc.lineAt(end).number, text, cut }
}

/**
 * The notes (`list`: [{ id, from, to }], the Reviewer's lines) on the lines the gutter shows them:
 * `lines` (Map id -> { from, to }) wins where it has the note. [{ id, from, to }].
 */
export function placedNotes(list, lines) {
  return list.map((n) => {
    const at = lines && lines.get(n.id)
    return at ? { id: n.id, from: at.from, to: at.to } : { id: n.id, from: n.from, to: n.to }
  })
}

/**
 * The page's answer to the host's `ask-context` (without `t` and `req`): the selection, and the file's
 * notes when there are any. `notes` is the Reviewer's list, or null while no Reviewer answered (then no
 * notes at all: the text is Ask Claude's own); `lines` the gutter's (noteLines).
 */
export function askContext(state, { notes = null, lines = null, max = MAX_ASK_CHARS } = {}) {
  const sel = selectionContext(state, max)
  const placed = Array.isArray(notes) ? placedNotes(notes, lines) : []
  return placed.length > 0 ? { ...sel, notes: placed } : sel
}
