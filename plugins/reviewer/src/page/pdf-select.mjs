// Where a pointer is in a PDF page's text (pdf.js's text layer), for the drag selection pdf.js
// attachSelection takes over. Pure over span rects, so test/pdf-select.test.js runs it under node.

/**
 * The text position at a point of a page: inside a span, the caret there; elsewhere the start of the
 * first text after the point in reading order (a later line, or later on this line), or the end of
 * the last text when nothing follows. `spans`: [{ s, r }] in reading order (the span element and its client rect); `caretAt(x, y)`: the
 * caret at a point as { node, offset } (document.caretRangeFromPoint), or null.
 */
export function posIn(spans, x, y, caretAt) {
  if (!spans.length) return null
  const inside = spans.find(({ r }) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
  if (inside && caretAt) {
    const c = caretAt(x, y)
    if (c && c.node.parentNode === inside.s) return c
  }
  const next = spans.find(({ r }) => r.top > y || (r.bottom >= y && r.left > x) || (inside && inside.r === r))
  if (next) return { node: next.s.firstChild, offset: 0 }
  const last = spans[spans.length - 1].s.firstChild
  return { node: last, offset: last.data.length }
}
