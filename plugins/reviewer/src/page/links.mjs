// Link clicks in annotate's document and details column: which click is a request to open the link,
// and which is the end of a selection a person makes for a note. Pure functions (a selection is
// reduced to its four anchor/focus fields), so test/html.test.js runs them under node.

/** How far (px, each axis) the pointer may move between press and release for a plain click. */
export const CLICK_SLOP = 4

/** A Selection as [anchorNode, anchorOffset, focusNode, focusOffset], or null when it has no range. */
export function selectionKey(sel) {
  if (!sel || !sel.rangeCount) return null
  return [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset]
}

const sameSelection = (a, b) => (a === null || b === null ? a === b : a.every((v, i) => v === b[i]))

/**
 * Whether a click on a link opens it. `down`: { x, y, sel } at the mousedown (null when none was seen
 * in the content); `up`: { x, y, sel, collapsed, detail } at the click. A keyboard or assistive
 * technology click (detail 0) opens. A double click does not (it selects a word), nor a press that
 * moved, nor one that left a selection it did not find: a drag-select that ends on a link makes a
 * selection for a note, and opening the link then would take the person away from it. A click that
 * leaves an earlier selection as it was, or none, is a plain click.
 */
export function isPlainClick(down, up) {
  if (up.detail === 0) return true
  if (!down || up.detail > 1) return false
  if (Math.abs(up.x - down.x) > CLICK_SLOP || Math.abs(up.y - down.y) > CLICK_SLOP) return false
  return up.collapsed || sameSelection(down.sel, up.sel)
}
