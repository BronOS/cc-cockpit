// Where an HTML note points. Rendered HTML has no line numbers, so a note keeps the text the person
// selected (the quote) and enough around it to find it again when the draft reopens on the same
// or a changed document: the text just before and after it, which match of the quote it was, and
// its length. Offsets are into `full`, the concatenation of the rendered document's text nodes in
// order (what Range.toString() gives for the whole document body).
//
// Pure string functions, tested under node (test/html.test.js).

// The host's MAX_QUOTE (dist/lib/review.js; test/review.test.js compares them): a longer selection
// keeps its first QUOTE_MAX chars as the quote and its full length in `length`.
export const QUOTE_MAX = 500
// Context kept on each side; the host caps it at MAX_ANCHOR_CONTEXT (64).
export const CONTEXT = 32
// A quote as short as "a" can match tens of thousands of times in 2 MiB: past this many matches
// the rest are not scored (the note may then land on a wrong one, never hang the page).
const MAX_CANDIDATES = 5000

/** The matches of `quote` in `full`, as start offsets, overlapping ones included. */
function matches(full, quote) {
  const out = []
  for (let i = full.indexOf(quote); i !== -1 && out.length < MAX_CANDIDATES; i = full.indexOf(quote, i + 1)) out.push(i)
  return out
}

/**
 * The quote and anchor of the selection [start, end) of `full`:
 * { quote, anchor: { prefix, suffix, occurrence, length, at } }. `occurrence` counts the matches
 * of the quote that start before this one; `at` is `start`, which only orders the notes.
 */
export function makeAnchor(full, start, end) {
  const quote = full.slice(start, Math.min(end, start + QUOTE_MAX))
  let occurrence = 0
  for (const i of matches(full, quote)) {
    if (i >= start) break
    occurrence++
  }
  return {
    quote,
    anchor: {
      prefix: full.slice(Math.max(0, start - CONTEXT), start),
      suffix: full.slice(end, end + CONTEXT),
      occurrence,
      length: end - start,
      at: start,
    },
  }
}

/**
 * Where `note` ({ quote, anchor }) is in `full` now, as { start, end }, or null when its quote is
 * not in the text any more (the note is then listed, not highlighted). Among the matches of the
 * quote, the one whose prefix and suffix both still match wins, then one of them, then the match
 * with the note's occurrence number; a tie goes to the match nearest that number.
 */
export function locate(full, note) {
  const quote = note && typeof note.quote === 'string' ? note.quote : ''
  const a = note && note.anchor
  if (!quote || !a) return null
  const found = matches(full, quote)
  if (!found.length) return null
  const length = Number.isInteger(a.length) && a.length > quote.length ? a.length : quote.length
  const prefix = typeof a.prefix === 'string' ? a.prefix : ''
  const suffix = typeof a.suffix === 'string' ? a.suffix : ''
  const occurrence = Number.isInteger(a.occurrence) ? a.occurrence : 0
  let best = null
  found.forEach((i, k) => {
    // A selection longer than its stored quote: its tail may be gone, then only the quote counts.
    const len = i + length <= full.length ? length : quote.length
    const score =
      (prefix && i >= prefix.length && full.slice(i - prefix.length, i) === prefix ? 2 : 0) +
      (suffix && full.slice(i + len, i + len + suffix.length) === suffix ? 2 : 0) +
      (k === occurrence ? 1 : 0)
    const dist = Math.abs(k - occurrence)
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { score, dist, start: i, end: i + len }
  })
  return { start: best.start, end: best.end }
}
