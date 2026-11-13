// The Reviewer's notes in the gutter, drawn with CodeMirror (the state is notes.mjs's): a small mark beside
// each line a review note covers, the note's text in a popover on hover. The marks ride along with their
// lines (a RangeSet mapped through every change), so a mark never lags behind the line it belongs to while
// the person types; the host's list is the Reviewer's, whose line numbers are the file on disk's, and is
// laid on the buffer again each time it changes.
//
// No Reviewer (or an older one) means no marks. The gutter is always there with a fixed width
// (initialSpacer), as the changes bar is, so the text does not shift when the first mark appears.

import { StateEffect, StateField, RangeSet } from '@codemirror/state'
import { EditorView, gutter, GutterMarker } from '@codemirror/view'

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

/** A blank element of the mark's width, so the gutter has its width before the first mark. */
class Spacer extends GutterMarker {
  toDOM() {
    const d = document.createElement('div')
    d.className = 'cc-note cc-note-spacer'
    return d
  }
}

const setMarks = StateEffect.define()

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

const marksField = StateField.define({
  create: () => RangeSet.empty,
  update(marks, tr) {
    marks = marks.map(tr.changes)
    for (const e of tr.effects) if (e.is(setMarks)) marks = e.value
    return marks
  },
})

/** The marker on `line` (a BlockInfo), or null. */
function markerAt(state, line) {
  let found = null
  state.field(marksField).between(line.from, line.from, (_from, _to, m) => {
    found = m
    return false
  })
  return found
}

/**
 * `ui`: { getNotes() } the list now. Returns `{ extension, recompute(view) }`: add `extension` after the
 * changes gutter; `recompute` lays the list on the buffer now (the list changed, a new state).
 */
export function createNotesGutter(ui) {
  let pop = null

  function hide() {
    if (pop) pop.remove()
    pop = null
  }

  function show(view, line, event) {
    hide()
    const m = markerAt(view.state, line)
    if (!m) return
    pop = document.createElement('div')
    pop.className = 'cc-note-pop'
    pop.setAttribute('role', 'tooltip')
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
    document.body.append(pop)
    // Right of the gutter, at the pointer's height; kept inside the window.
    const g = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : { right: event.clientX }
    const r = pop.getBoundingClientRect()
    pop.style.left = `${Math.max(4, Math.min(g.right + 4, window.innerWidth - r.width - 4))}px`
    pop.style.top = `${Math.max(4, Math.min(event.clientY - 8, window.innerHeight - r.height - 4))}px`
  }

  const extension = [
    marksField,
    gutter({
      class: 'cc-notes-gutter',
      markers: (view) => view.state.field(marksField),
      initialSpacer: () => new Spacer(),
      domEventHandlers: {
        mouseover: (view, line, event) => {
          show(view, line, event)
          return false
        },
        mouseleave: () => {
          hide()
          return false
        },
      },
    }),
    // Scrolling or typing leaves the popover behind, away from its line.
    EditorView.domEventHandlers({ scroll: () => (hide(), false), keydown: () => (hide(), false) }),
  ]

  return {
    extension,
    recompute(view) {
      if (!view) return
      hide()
      view.dispatch({ effects: setMarks.of(marksOf(view.state.doc, ui.getNotes())) })
    },
  }
}
