// Indent guides (design-editor.md §5 "Editing"): a thin vertical line at every indent step inside a line's
// leading whitespace, drawn as a line background (no widgets, so nothing in the text or the cursor moves).
// A blank line has none: its width says nothing about the block it sits in.

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

/** The inline style of a line indented `cols` columns with a guide every `unit` columns, or null for none. */
export function guideStyle(cols, unit) {
  if (unit < 1 || cols < 1) return null
  const line = 'var(--cc-border)'
  return (
    `background-image:repeating-linear-gradient(to right,${line} 0,${line} 1px,transparent 1px,transparent ${unit}ch);` +
    `background-size:${cols}ch 100%;background-repeat:no-repeat;background-origin:content-box`
  )
}

function build(view) {
  const ranges = []
  const unit = getIndentUnit(view.state)
  const tab = view.state.tabSize
  let last = -1
  for (const { from, to } of view.visibleRanges) {
    let pos = Math.max(from, last + 1)
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const style = guideStyle(leadingColumns(line.text, tab), unit)
      if (style) ranges.push(Decoration.line({ attributes: { style } }).range(line.from))
      last = line.to
      pos = line.to + 1
    }
  }
  return Decoration.set(ranges)
}

export const indentGuides = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = build(view)
    }

    update(u) {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) this.decorations = build(u.view)
    }
  },
  { decorations: (v) => v.decorations },
)
