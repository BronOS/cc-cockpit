// annotate's companion: the divider between the main document (left) and the companion (right).
// Pure functions, so test/html.test.js runs them under node; the page wires them to the pointer.

// The share of the width the main document takes. The host's SPLIT_MIN / SPLIT_MAX (dist/host.js;
// test/html.test.js compares them): the host stores only a value in these bounds, so a column never
// opens too thin to drag back.
export const SPLIT_MIN = 0.2
export const SPLIT_MAX = 0.8
export const SPLIT_DEFAULT = 0.5
// One arrow key press on the focused divider moves it this much.
export const SPLIT_STEP = 0.05

/** `v` within [SPLIT_MIN, SPLIT_MAX], rounded to 3 decimals; anything but a finite number is the default. */
export function clampSplit(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return SPLIT_DEFAULT
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v)) * 1000) / 1000
}

/** The split for a pointer at clientX `x` over a row starting at `left`, `width` px wide (clamped). */
export function splitAt(x, left, width) {
  if (!(width > 0)) return SPLIT_DEFAULT
  return clampSplit((x - left) / width)
}

/** The split after a key on the focused divider, or null for a key it does not take. */
export function splitKey(split, key) {
  if (key === 'ArrowLeft') return clampSplit(split - SPLIT_STEP)
  if (key === 'ArrowRight') return clampSplit(split + SPLIT_STEP)
  if (key === 'Home') return SPLIT_MIN
  if (key === 'End') return SPLIT_MAX
  return null
}

/**
 * Which document a selection belongs to, given per document whether the selection touches it
 * (`touches`) and whether it starts in it (`starts`), in column order: the one it starts in, else
 * the first it touches, else -1. A drag from one column into the other makes a note on the column
 * where it began (the page cuts the range to that document).
 */
export function selectionDoc(docs) {
  const start = docs.findIndex((d) => d.touches && d.starts)
  return start !== -1 ? start : docs.findIndex((d) => d.touches)
}

/** A column header's open button: "Open in <urlLabel> ↗", or "Open in browser ↗" (no arrow for a tooltip). */
export function openLabel(urlLabel, arrow = true) {
  return `Open in ${urlLabel || 'browser'}${arrow ? ' ↗' : ''}`
}
