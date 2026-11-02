'use strict'
// Drafts (what the overlay page posts as the person types) and the text Claude receives.
//
// A draft comes from our own page, but it is still checked and capped here: the host is the one
// that types it into a Claude session, and a page bug must not turn into a 5 MB paste.

const MAX_NOTES = 200
const MAX_GLOBAL = 20000
const MAX_NOTE_TEXT = 4000
const MAX_QUOTE = 500 // per note, as stored; the message may shorten it further
const MAX_MESSAGE = 20000 // what one Discuss / New session sends; quotes are shortened first

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

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

/**
 * The text Claude receives. Plain text that never starts with `/`, `!`, `#` or `&` (the send gate
 * refuses those): it always opens with "Review of". Notes in file order, old side before new at the
 * same line. A note without text is left out (a selection the person never wrote anything for).
 */
function formatReview(draft, sides) {
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
    if (text.length <= MAX_MESSAGE) return text
  }
  return build(0).slice(0, MAX_MESSAGE - 40) + '\n\n(review cut: too long)'
}

module.exports = { cleanDraft, isEmpty, formatReview, MAX_MESSAGE }
