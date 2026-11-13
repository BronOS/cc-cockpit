// A gutter of line marks with a popover on hover, the skeleton the changes gutter (changes-editor.js)
// and the notes gutter (notes-editor.js) share. The marks are a RangeSet in a state field, mapped
// through every change, so a mark rides along with its line while the person types; the owner lays a
// new set with `set`. The gutter always has its width (initialSpacer), so the text does not shift
// sideways when the first mark appears. Scrolling or typing hides the popover, which would otherwise be
// left behind, away from its line.

import { StateEffect, StateField, RangeSet } from '@codemirror/state'
import { EditorView, gutter, GutterMarker } from '@codemirror/view'

/** A blank element of the mark's width (class `cls`). */
class Spacer extends GutterMarker {
  constructor(cls) {
    super()
    this.cls = cls
  }
  toDOM() {
    const d = document.createElement('div')
    d.className = this.cls
    return d
  }
}

/**
 * `opts`:
 *   gutterClass      the gutter's class
 *   spacerClass      the spacer's class (the mark's width)
 *   popClass         the popover's class
 *   fill(pop, mark)  the popover's content for `mark` (the GutterMarker on the hovered line)
 *   click?(view)     a primary click on a marked line (the editor would only move the cursor there)
 * Returns `{ extension, set(view, marks), hide() }`.
 */
export function createMarkGutter(opts) {
  const setMarks = StateEffect.define()
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
    pop.className = opts.popClass
    pop.setAttribute('role', 'tooltip')
    opts.fill(pop, m)
    document.body.append(pop)
    // Right of the gutter, at the pointer's height; kept inside the window.
    const g = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : { right: event.clientX }
    const r = pop.getBoundingClientRect()
    pop.style.left = `${Math.max(4, Math.min(g.right + 4, window.innerWidth - r.width - 4))}px`
    pop.style.top = `${Math.max(4, Math.min(event.clientY - 8, window.innerHeight - r.height - 4))}px`
  }

  const domEventHandlers = {
    mouseover: (view, line, event) => {
      show(view, line, event)
      return false
    },
    mouseleave: () => {
      hide()
      return false
    },
  }
  if (opts.click) {
    domEventHandlers.mousedown = (view, line, event) => {
      if (event.button !== 0 || !markerAt(view.state, line)) return false
      event.preventDefault()
      hide()
      opts.click(view)
      return true
    }
  }

  const extension = [
    marksField,
    gutter({
      class: opts.gutterClass,
      markers: (view) => view.state.field(marksField),
      initialSpacer: () => new Spacer(opts.spacerClass),
      domEventHandlers,
    }),
    EditorView.domEventHandlers({ scroll: () => (hide(), false), keydown: () => (hide(), false) }),
  ]

  return {
    extension,
    /** Lays `marks` (a RangeSet of the owner's markers) on the buffer now; the popover goes. */
    set(view, marks) {
      hide()
      view.dispatch({ effects: setMarks.of(marks) })
    },
    hide,
  }
}
