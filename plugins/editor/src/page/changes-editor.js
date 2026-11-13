// Claude's changes in the gutter, drawn with CodeMirror (the logic is changes.mjs's): a bar beside each
// line that differs from git HEAD (green added, blue modified, a red notch where lines were removed),
// the old lines in a popover on hover, a click on a bar opens the Reviewer's diff. The marks are
// computed from the buffer after a pause in typing and ride along with the lines (a RangeSet mapped
// through every change) in between, so a bar never lags behind the line it belongs to.
//
// No base (not a repository, untracked, a binary file, git missing) means no marks. The gutter is
// always there with a fixed width (initialSpacer), so the text does not shift sideways when the first
// bar appears.

import { RangeSet } from '@codemirror/state'
import { GutterMarker } from '@codemirror/view'
import { hunksOf } from './changes.mjs'
import { createMarkGutter } from './mark-gutter.js'

/** The marks are recomputed this long after the last change to the buffer. */
export const RECOMPUTE_MS = 150
/** A buffer or base over this many characters is not diffed on every pause (the host caps the base too). */
const MAX_DIFF_CHARS = 3 * 1024 * 1024

const KIND_LABEL = {
  added: 'Added since the last commit',
  modified: 'Changed since the last commit',
  deleted: 'Removed since the last commit',
}

class ChangeMarker extends GutterMarker {
  constructor(hunk, edge) {
    super()
    this.hunk = hunk
    this.edge = edge
  }
  eq(other) {
    return other.hunk === this.hunk && other.edge === this.edge
  }
  toDOM() {
    const d = document.createElement('div')
    d.className = `cc-change cc-change-${this.hunk.kind}${this.edge ? ` cc-change-${this.edge}` : ''}`
    return d
  }
}

/** The line marks of `hunks` in `doc`: a bar on each line of an added or modified hunk, a notch on the line after a removal. */
export function marksOf(doc, hunks) {
  const out = []
  for (const h of hunks) {
    if (h.kind === 'deleted') {
      // Past the last line (lines removed at the end): the notch goes under the last line.
      const atEnd = h.line > doc.lines
      const line = doc.line(Math.min(h.line, doc.lines))
      out.push(new ChangeMarker(h, atEnd ? 'below' : 'above').range(line.from))
      continue
    }
    for (let n = h.line; n < h.line + h.count && n <= doc.lines; n++) {
      out.push(new ChangeMarker(h, n === h.line ? 'first' : null).range(doc.line(n).from))
    }
  }
  return RangeSet.of(out, true)
}

/**
 * `ui`:
 *   getBase()     the file's text at HEAD, or null
 *   review()      the click on a bar
 * Returns `{ extension, recompute(view), schedule(view) }`: add `extension` after the line numbers;
 * `recompute` draws the marks now (the base changed, a new state), `schedule` after the pause.
 */
export function createChangesGutter(ui) {
  let timer = null
  const marks = createMarkGutter({
    gutterClass: 'cc-changes-gutter',
    spacerClass: 'cc-change',
    popClass: 'cc-change-pop',
    fill(pop, m) {
      const h = m.hunk
      const head = document.createElement('div')
      head.className = 'cc-change-pop-head'
      head.textContent = KIND_LABEL[h.kind]
      pop.append(head)
      if (h.old.length) {
        const pre = document.createElement('pre')
        pre.className = 'cc-change-pop-old'
        pre.textContent = h.old.join('\n')
        pop.append(pre)
        if (h.oldCount > h.old.length) {
          const more = document.createElement('div')
          more.className = 'cc-change-pop-more'
          more.textContent = `…and ${h.oldCount - h.old.length} more old lines`
          pop.append(more)
        }
      }
      const tip = document.createElement('div')
      tip.className = 'cc-change-pop-tip'
      tip.textContent = 'Click to open the diff'
      pop.append(tip)
    },
    // A click on a bar opens the diff; the editor would only move the cursor to the line.
    click: () => ui.review(),
  })

  function recompute(view) {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!view) return
    const base = ui.getBase()
    let set = RangeSet.empty
    if (base !== null && base.length <= MAX_DIFF_CHARS && view.state.doc.length <= MAX_DIFF_CHARS) {
      set = marksOf(view.state.doc, hunksOf(base, view.state.doc.toString()))
    }
    marks.set(view, set)
  }

  return {
    extension: marks.extension,
    recompute,
    schedule(view) {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        recompute(view)
      }, RECOMPUTE_MS)
    },
  }
}
