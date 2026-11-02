'use strict'
// Drafts (what the overlay page posts as the person types) and the text Claude receives.
//
// A draft comes from our own page, but it is still checked and capped here: the host is the one
// that types it into a Claude session, and a page bug must not turn into a 5 MB paste.

const MAX_NOTES = 200
const MAX_GLOBAL = 20000
const MAX_NOTE_TEXT = 4000 // the page's note and comment inputs carry the same caps as maxlength
const MAX_QUOTE = 500 // per note, as stored; the message may shorten it further
const MAX_MESSAGE = 20000 // what one Discuss / New session sends; quotes are shortened first
// The whole draft as JSON. Under ctx.storage's 1 MiB value and the 1,040,384-char page message
// (a bigger draft message is dropped by core with only a console warning), with room left for the
// file's two sides in the init message that brings the draft back on the next open.
const MAX_DRAFT_JSON = 400000

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Why cleanDraft would lose some of the person's text in `d`, or null when it keeps all of it. The
 * page enforces every cap visibly, so this only fires on a page bug; the host then keeps the last
 * draft that passed and tells the person, rather than storing (or sending and deleting) a cut one.
 */
function draftProblem(d) {
  if (!isObj(d)) return null
  if (typeof d.global === 'string' && d.global.length > MAX_GLOBAL) return `the comment is over ${MAX_GLOBAL} characters`
  if (Array.isArray(d.notes)) {
    if (d.notes.length > MAX_NOTES) return `there are more than ${MAX_NOTES} notes`
    for (const n of d.notes) {
      if (!isObj(n)) continue
      const text = typeof n.text === 'string' ? n.text : ''
      if (text.length > MAX_NOTE_TEXT) return `a note is over ${MAX_NOTE_TEXT} characters`
      if (typeof n.quote === 'string' && n.quote.length > MAX_QUOTE) return `a quote is over ${MAX_QUOTE} characters`
      const from = Math.floor(Number(n.from))
      const to = Math.floor(Number(n.to))
      if (text.trim() && !(from >= 1 && to >= from)) return 'a note has no valid line range'
    }
  }
  const size = JSON.stringify(d).length
  if (size > MAX_DRAFT_JSON) return `the draft is too large (${size} of ${MAX_DRAFT_JSON} characters)`
  return null
}

/** A clean draft { global, notes: [{ id, side, from, to, quote, text }] }; drops bad notes. */
function cleanDraft(d) {
  const out = { global: '', notes: [] }
  if (!isObj(d)) return out
  if (typeof d.global === 'string') out.global = d.global.slice(0, MAX_GLOBAL)
  if (Array.isArray(d.notes)) {
    for (const n of d.notes.slice(0, MAX_NOTES)) {
      if (!isObj(n)) continue
      const from = Math.floor(Number(n.from))
      const to = Math.floor(Number(n.to))
      if (!(from >= 1 && to >= from)) continue
      out.notes.push({
        id: typeof n.id === 'string' ? n.id.slice(0, 40) : String(out.notes.length + 1),
        side: n.side === 'old' ? 'old' : 'new',
        from,
        to,
        quote: typeof n.quote === 'string' ? n.quote.slice(0, MAX_QUOTE) : '',
        text: typeof n.text === 'string' ? n.text.slice(0, MAX_NOTE_TEXT) : '',
      })
    }
  }
  return out
}

const isEmpty = (d) => !d.global.trim() && d.notes.every((n) => !n.text.trim())

function quoteBlock(quote, max) {
  let q = quote.replace(/\s+$/, '')
  if (q.length > max) q = q.slice(0, max).replace(/\s+\S*$/, '') + ' …'
  return q
    .split('\n')
    .map((l) => `   > ${l}`)
    .join('\n')
}

const CUT_MARK = '\n\n(review cut: too long)'

/**
 * The text Claude receives. Plain text that never starts with `/`, `!`, `#` or `&` (the send gate
 * refuses those): it always opens with "Review of". Notes in file order, old side before new at the
 * same line. A note without text is left out (a selection the person never wrote anything for).
 */
function formatReview(draft, sides) {
  return buildReview(draft, sides).text
}

/**
 * formatReview, plus `cut`: true when even with no quotes the text passed MAX_MESSAGE and its tail
 * was dropped. The host keeps the draft then, since what Claude got is not the whole review.
 */
function buildReview(draft, sides) {
  const d = cleanDraft(draft)
  const commit = sides.head ? ` ${sides.head.slice(0, 12)}` : ''
  const unchanged = sides.mode === 'diff' && !sides.oldMissing && !sides.newMissing && sides.old === sides.new
  // Sides only mean something when there is a diff: an unchanged file is one text.
  const sided = sides.mode === 'diff' && !unchanged
  const base = sides.mode === 'plain' ? 'the file as it is now, no git diff' : unchanged ? `unchanged since the last commit${commit}` : `changes since the last commit${commit}`
  const head = `Review of ${sides.path} (${base})`
  const notes = d.notes
    .filter((n) => n.text.trim())
    .sort((a, b) => a.from - b.from || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1))

  const build = (quoteMax) => {
    const parts = [head]
    if (d.global.trim()) parts.push(d.global.trim())
    notes.forEach((n, i) => {
      const lines = n.from === n.to ? `Line ${n.from}` : `Lines ${n.from}-${n.to}`
      const side = !sided ? '' : n.side === 'old' ? ' (old, removed)' : ' (new)'
      const q = n.quote.trim() && quoteMax > 0 ? `\n${quoteBlock(n.quote, quoteMax)}` : ''
      parts.push(`${i + 1}. ${lines}${side}:${q}\n   ${n.text.trim().replace(/\n/g, '\n   ')}`)
    })
    return parts.join('\n\n')
  }

  // Shorten quotes before anything else: the person's own words matter more than the code they
  // point at, which Claude can read itself.
  for (const quoteMax of [MAX_QUOTE, 200, 80, 0]) {
    const text = build(quoteMax)
    if (text.length <= MAX_MESSAGE) return { text, cut: false }
  }
  return { text: build(0).slice(0, MAX_MESSAGE - CUT_MARK.length) + CUT_MARK, cut: true }
}

const DRAFT_PREFIX = 'draft:'
const MAX_KEY = 200 // ctx.storage key limit (`ccc guide api`)

/** The ctx.storage key of a file's draft; a path too long for a key is replaced by its hash. */
function draftKey(path) {
  const key = DRAFT_PREFIX + path
  if (key.length <= MAX_KEY) return key
  return `${DRAFT_PREFIX}#${require('node:crypto').createHash('sha256').update(path).digest('hex')}`
}

module.exports = { draftKey, cleanDraft, draftProblem, isEmpty, formatReview, buildReview, MAX_MESSAGE, MAX_NOTE_TEXT, MAX_GLOBAL, MAX_NOTES, MAX_QUOTE, MAX_DRAFT_JSON }
