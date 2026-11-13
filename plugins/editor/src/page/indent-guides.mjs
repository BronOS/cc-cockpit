// Indent guides (design-editor.md §5 "Editing"): a thin vertical line at every indent step inside a line's
// leading whitespace, drawn as a line background (no widgets, so nothing in the text or the cursor moves).
// A blank line has none: its width says nothing about the block it sits in.
//
// The step is the state's indent unit (a tab counts as tabSize), which file.js sets from the file itself
// (detectIndentUnit): with CodeMirror's default of 2 spaces, a tab-indented Go file got two guides per tab.
// The gradient is in `ch`, the width of the font's "0": right for the monospace editor font, off by a little
// per step if only a proportional fallback is installed (CodeMirror's own columns assume monospace too).

import { Decoration, ViewPlugin } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'

/** Columns of the leading whitespace of a line (a tab counts to the next multiple of tabSize), 0 for a blank line. */
export function leadingColumns(text, tabSize) {
  let cols = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 32) cols++
    else if (c === 9) cols += tabSize - (cols % tabSize)
    else return cols
  }
  return 0
}

/** Lines read to guess the indent unit: the top of a file says how it is indented, and a huge file costs nothing. */
const DETECT_LINES = 2000

/**
 * The indent unit a file uses: '\t' when more indented lines start with a tab than with a space, else the
 * most common step (2 to 8 spaces) between a space-indented line and the more indented line after it, or
 * null when the file does not say (no indented lines). A step of 1 is never a unit: it is the ` * ` of a
 * block comment under its opening line.
 */
export function detectIndentUnit(text) {
  let tabs = 0
  let spaces = 0
  const steps = new Map()
  let prev = -1 // the previous non-blank line's leading spaces, -1 when it started with a tab
  let start = 0
  for (let n = 0; n < DETECT_LINES && start <= text.length; n++) {
    let end = text.indexOf('\n', start)
    if (end < 0) end = text.length
    let i = start
    while (i < end && text.charCodeAt(i) === 32) i++
    const first = i < end ? text.charCodeAt(i) : -1
    if (first === 9) {
      if (i === start) tabs++
      prev = -1
    } else if (first !== -1 && first !== 13) {
      const cols = i - start
      if (cols > 0) spaces++
      const step = cols - prev
      if (prev >= 0 && step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1)
      prev = cols
    }
    start = end + 1
  }
  if (tabs > spaces) return '\t'
  let best = 0
  let count = 0
  for (const [step, c] of steps) if (c > count || (c === count && step < best)) [best, count] = [step, c]
  return best > 0 ? ' '.repeat(best) : null
}

/** The inline style of a line indented `cols` columns with a guide every `unit` columns, or null for none. */
export function guideStyle(cols, unit) {
  if (unit < 1 || cols < 1) return null
  const line = 'var(--cc-border)'
  return (
    `background-image:repeating-linear-gradient(to right,${line} 0,${line} 1px,transparent 1px,transparent ${unit}ch);` +
    `background-size:${cols}ch 100%;background-repeat:no-repeat;background-origin:content-box`
  )
}

/** The line decorations for the lines of `ranges` (the view's visible ranges), each line once. */
export function guideDecorations(state, ranges) {
  const out = []
  const unit = getIndentUnit(state)
  const tab = state.tabSize
  let last = -1
  for (const { from, to } of ranges) {
    let pos = Math.max(from, last + 1)
    while (pos <= to) {
      const line = state.doc.lineAt(pos)
      const style = guideStyle(leadingColumns(line.text, tab), unit)
      if (style) out.push(Decoration.line({ attributes: { style } }).range(line.from))
      last = line.to
      pos = line.to + 1
    }
  }
  return Decoration.set(out)
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = guideDecorations(view.state, view.visibleRanges)
    }

    // Only the text and the visible lines change what is drawn: the styles are in `ch`, so a resize or a
    // re-measured line height (geometryChanged, on every scroll that measures) needs nothing new.
    update(u) {
      if (u.docChanged || u.viewportChanged) this.decorations = guideDecorations(u.state, u.view.visibleRanges)
    }
  },
  { decorations: (v) => v.decorations },
)
