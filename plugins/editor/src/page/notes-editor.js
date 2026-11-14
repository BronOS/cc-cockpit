// The Reviewer's notes in the gutter, drawn with CodeMirror (the state is notes.mjs's): a small mark beside
// each line a review note covers, the note's text in a popover on hover. The marks ride along with their
// lines (a RangeSet mapped through every change), so a mark never lags behind the line it belongs to while
// the person types; the host's list is the Reviewer's, whose line numbers are the file on disk's, and is
// laid on the buffer again each time it changes.
//
// No Reviewer (or an older one) means no marks. The gutter is always there with a fixed width
// (initialSpacer), as the changes bar is, so the text does not shift when the first mark appears.
//
// The marks are also where Ask Claude reads each note's lines (noteLines): the lines the person sees it on,
// which the selection's line numbers match even in a dirty buffer.

import { RangeSet } from '@codemirror/state'
import { GutterMarker } from '@codemirror/view'
import { createMarkGutter } from './mark-gutter.js'

class NoteMarker extends GutterMarker {
  constructor(notes) {
    super()
    this.notes = notes
  }
  eq(other) {
    return other.notes.length === this.notes.length && other.notes.every((n, i) => n === this.notes[i])
  }
  toDOM() {
    const d = document.createElement('div')
    d.className = `cc-note${this.notes.length > 1 ? ' cc-note-many' : ''}`
    d.setAttribute('aria-label', this.notes.length > 1 ? `${this.notes.length} review notes` : 'Review note')
    return d
  }
}

/** The marks of `list` ([{ id, from, to, text }]) in `doc`: one on each line a note covers, the notes of a line together. A line past the end is dropped. */
export function marksOf(doc, list) {
  const byLine = new Map()
  for (const n of list) {
    for (let line = n.from; line <= n.to && line <= doc.lines; line++) {
      const at = byLine.get(line)
      if (at) at.push(n)
      else byLine.set(line, [n])
    }
  }
  const out = []
  for (const [line, notes] of byLine) out.push(new NoteMarker(notes).range(doc.line(line).from))
  return RangeSet.of(out, true)
}

/**
 * Each note's lines as `marks` (marksOf's set, mapped through the edits since it was laid on) place it in
 * `doc`: Map id -> { from, to }, 1-based. A note with no mark left (all its lines were past the end when
 * the list was laid on) is absent: its own lines are all there is.
 */
export function noteLines(marks, doc) {
  const out = new Map()
  marks.between(0, doc.length, (from, _to, m) => {
    if (from > doc.length) return
    const line = doc.lineAt(from).number
    for (const n of m.notes) {
      const at = out.get(n.id)
      if (!at) out.set(n.id, { from: line, to: line })
      else {
        if (line < at.from) at.from = line
        if (line > at.to) at.to = line
      }
    }
  })
  return out
}

/**
 * `ui`: { getNotes() } the list now. Returns `{ extension, recompute(view), lines(view) }`: add `extension`
 * after the changes gutter; `recompute` lays the list on the buffer now (the list changed, a new state);
 * `lines` is noteLines now.
 */
export function createNotesGutter(ui) {
  const marks = createMarkGutter({
    gutterClass: 'cc-notes-gutter',
    spacerClass: 'cc-note cc-note-spacer',
    popClass: 'cc-note-pop',
    fill(pop, m) {
      for (const n of m.notes) {
        const item = document.createElement('div')
        item.className = 'cc-note-pop-item'
        const head = document.createElement('div')
        head.className = 'cc-note-pop-head'
        head.textContent = n.to > n.from ? `Review note, lines ${n.from}-${n.to}` : `Review note, line ${n.from}`
        const text = document.createElement('div')
        text.className = 'cc-note-pop-text'
        text.textContent = n.text
        item.append(head, text)
        pop.append(item)
      }
    },
  })

  return {
    extension: marks.extension,
    recompute(view) {
      if (!view) return
      marks.set(view, marksOf(view.state.doc, ui.getNotes()))
    },
    lines: (view) => (view ? noteLines(marks.marks(view.state), view.state.doc) : new Map()),
  }
}
