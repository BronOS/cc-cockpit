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

const { ReviewError, MAX_SIDE_BYTES } = require('./files')

// annotate (the `reviewer` service): a text another plugin hands over (a Jira issue, a mail), not
// a file. Its inputs come from any plugin of the project, so each is checked and capped here.
const MAX_ANNOTATE_TITLE = 200 // also main's overlay title limit, before the "Notes: " prefix cuts it
const MAX_ANNOTATE_TEXT = MAX_SIDE_BYTES // UTF-8 bytes, the cap of one side of a file review
const MAX_ANNOTATE_URL = 2048
const MAX_ANNOTATE_KEY = 200
// A caller's key names its own thing (`PROJ-123`, `jira:PROJ-123`, a message id): a plain charset
// with no spaces, quotes or controls, so it reads cleanly in a storage key and a log line.
const ANNOTATE_KEY_CHARS = /^[A-Za-z0-9._:@#+=~\/-]+$/
// annotate's HTML mode ({ html, assets? } in place of { text }): the page sanitizes the HTML against
// an allow-list (src/page/sanitize.mjs); the host only bounds what it carries. 2 MiB is more than one
// page message takes (1,040,384 chars of JSON), so the host posts it in parts (htmlParts).
const MAX_ANNOTATE_HTML = 2 * 1024 * 1024 // UTF-8 bytes
// annotate's `aside`: a details column of HTML (key fields), sanitized like `html`. Sent in a message
// of its own after the init (escaped, at most 6 chars per char: within one page message).
const MAX_ANNOTATE_ASIDE = 100000 // characters
// Images only, as data: URLs the page sets as an <img> src (its CSP allows data: images). No SVG:
// an SVG is a document with script and links of its own, so it is not "just an image".
const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_ASSETS = 30
// One asset travels in one page message, so it stays under that message's 1,040,384 chars with
// room for the wrapping ({ type, id, dataUrl }); base64 needs no JSON escaping.
const MAX_ASSET_CHARS = 1000000
const MAX_ASSETS_TOTAL = 8 * 1024 * 1024 // all dataUrls together, in chars
const MAX_ASSET_NAME = 200
// An asset id is what `<img src="asset:<id>">` names in the HTML: a plain charset, so the page's
// sanitizer can match it with no escaping questions.
const ASSET_ID_CHARS = /^[A-Za-z0-9._-]{1,100}$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
// What one `html` part may take as JSON (the part is escaped: a quote or a newline is two chars),
// under the page message limit with room for { type, index, count }.
const MAX_PART_JSON = 900000
// An HTML note's anchor (the page's src/page/anchor.mjs): the context kept on each side of the quote.
const MAX_ANCHOR_CONTEXT = 64

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
      if (isObj(n.anchor)) continue // an HTML note: cleanDraft keeps it whatever its anchor says
      const from = Math.floor(Number(n.from))
      const to = Math.floor(Number(n.to))
      if (text.trim() && !(from >= 1 && to >= from)) return 'a note has no valid line range'
    }
  }
  const size = JSON.stringify(d).length
  if (size > MAX_DRAFT_JSON) return `the draft is too large (${size} of ${MAX_DRAFT_JSON} characters)`
  return null
}

/** A whole number in [min, max], else `dflt`. */
const intIn = (v, min, max, dflt) => (Number.isInteger(v) && v >= min && v <= max ? v : dflt)

/**
 * An HTML note's anchor, cleaned: where the quote sat in the rendered text, so the page can find
 * it again when the draft reopens (src/page/anchor.mjs). `length` is the selection's length, which
 * is more than the quote's when the stored quote was cut at MAX_QUOTE; `at` its offset when it was
 * made, used only to order the notes.
 */
function cleanAnchor(a) {
  const str = (v) => (typeof v === 'string' ? v.slice(0, MAX_ANCHOR_CONTEXT) : '')
  return {
    prefix: str(a.prefix),
    suffix: str(a.suffix),
    occurrence: intIn(a.occurrence, 0, MAX_ANNOTATE_HTML, 0),
    length: intIn(a.length, 0, MAX_ANNOTATE_HTML, 0),
    at: intIn(a.at, 0, MAX_ANNOTATE_HTML, 0),
  }
}

/**
 * A clean draft { global, notes }; drops bad notes. A note is a line note
 * { id, side, from, to, quote, text } (a file, a text), or, with an `anchor` object, an HTML note
 * { id, quote, anchor: { prefix, suffix, occurrence, length, at }, text } (annotate's HTML mode).
 */
function cleanDraft(d) {
  const out = { global: '', notes: [] }
  if (!isObj(d)) return out
  if (typeof d.global === 'string') out.global = d.global.slice(0, MAX_GLOBAL)
  if (Array.isArray(d.notes)) {
    for (const n of d.notes.slice(0, MAX_NOTES)) {
      if (!isObj(n)) continue
      if (isObj(n.anchor)) {
        out.notes.push({
          id: typeof n.id === 'string' ? n.id.slice(0, 40) : String(out.notes.length + 1),
          quote: typeof n.quote === 'string' ? n.quote.slice(0, MAX_QUOTE) : '',
          anchor: cleanAnchor(n.anchor),
          text: typeof n.text === 'string' ? n.text.slice(0, MAX_NOTE_TEXT) : '',
        })
        continue
      }
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
 * An HTML note's quote for `On «quote»: note`: one line (whitespace runs made one space, since the
 * rendered text keeps the HTML source's line breaks), shortened to `max` at a word end, with " …"
 * when it was shortened here or already cut when stored (`full`: the selection's length).
 */
function inlineQuote(quote, full, max) {
  let q = quote.replace(/\s+/g, ' ').trim()
  const stored = q
  if (q.length > max) q = q.slice(0, max).replace(/\s+\S*$/, '')
  return q.length < stored.length || full > quote.length ? `${q} …` : q
}

/** Line notes in line order (old before new at the same line), then HTML notes in text order. */
function noteOrder(a, b) {
  const ah = !!a.anchor
  const bh = !!b.anchor
  if (ah !== bh) return ah ? 1 : -1
  if (ah) return a.anchor.at - b.anchor.at
  return a.from - b.from || (a.side === b.side ? 0 : a.side === 'old' ? -1 : 1)
}

const CUT_MARK = '\n\n(review cut: too long)'

/**
 * The message of one review: `head`, the global comment, then the notes numbered in line order
 * (`sided`: old before new at the same line, each labelled with its side). Quotes are shortened
 * first when it is too long: the person's own words matter more than the text they point at,
 * which Claude can read itself. `cut`: true when even with no quotes it passed MAX_MESSAGE and its
 * tail was dropped; the host keeps the draft then, since what Claude got is not the whole review.
 */
function buildMessage(head, draft, sided) {
  const d = cleanDraft(draft)
  const notes = d.notes.filter((n) => n.text.trim()).sort(noteOrder)

  const build = (quoteMax) => {
    const parts = [head]
    if (d.global.trim()) parts.push(d.global.trim())
    notes.forEach((n, i) => {
      const body = n.text.trim().replace(/\n/g, '\n   ')
      if (n.anchor) {
        // No line numbers in rendered HTML: the quote is what locates the note. It is never dropped
        // whole (at least 40 chars stay), or a note would point at nothing.
        const q = n.quote.trim() ? `On «${inlineQuote(n.quote, n.anchor.length, Math.max(quoteMax, 40))}»` : 'On the text'
        parts.push(`${i + 1}. ${q}: ${body}`)
        return
      }
      const lines = n.from === n.to ? `Line ${n.from}` : `Lines ${n.from}-${n.to}`
      const side = !sided ? '' : n.side === 'old' ? ' (old, removed)' : ' (new)'
      const q = n.quote.trim() && quoteMax > 0 ? `\n${quoteBlock(n.quote, quoteMax)}` : ''
      parts.push(`${i + 1}. ${lines}${side}:${q}\n   ${body}`)
    })
    return parts.join('\n\n')
  }

  for (const quoteMax of [MAX_QUOTE, 200, 80, 0]) {
    const text = build(quoteMax)
    if (text.length <= MAX_MESSAGE) return { text, cut: false }
  }
  return { text: build(0).slice(0, MAX_MESSAGE - CUT_MARK.length) + CUT_MARK, cut: true }
}

/**
 * The text Claude receives. Plain text that never starts with `/`, `!`, `#` or `&` (the send gate
 * refuses those): it always opens with "Review of". Notes in file order, old side before new at the
 * same line. A note without text is left out (a selection the person never wrote anything for).
 */
function formatReview(draft, sides) {
  return buildReview(draft, sides).text
}

/** formatReview, plus `cut` (see buildMessage). */
function buildReview(draft, sides) {
  const commit = sides.head ? ` ${sides.head.slice(0, 12)}` : ''
  const unchanged = sides.mode === 'diff' && !sides.oldMissing && !sides.newMissing && sides.old === sides.new
  // Sides only mean something when there is a diff: an unchanged file is one text.
  const sided = sides.mode === 'diff' && !unchanged
  const base = sides.mode === 'plain' ? 'the file as it is now, no git diff' : unchanged ? `unchanged since the last commit${commit}` : `changes since the last commit${commit}`
  return buildMessage(`Review of ${sides.path} (${base})`, draft, sided)
}

/**
 * The text Claude receives for an annotated text (annotate), with `cut` as buildReview. It opens
 * with "About <title>" (plus " (<url>)"), so it never starts with `/`, `!`, `#` or `&`, which the
 * send gate refuses; notes have no sides (one text), otherwise exactly as a file review's. HTML
 * notes read `N. On «quote»: note`, with no line numbers.
 */
function buildAnnotation(draft, { title, url }) {
  return buildMessage(`About ${title}${url ? ` (${url})` : ''}`, draft, false)
}

const DRAFT_PREFIX = 'draft:'
const MAX_KEY = 200 // ctx.storage key limit (`ccc guide api`)

/** The ctx.storage key of a file's draft; a path too long for a key is replaced by its hash. */
function draftKey(path) {
  const key = DRAFT_PREFIX + path
  if (key.length <= MAX_KEY) return key
  return `${DRAFT_PREFIX}#${require('node:crypto').createHash('sha256').update(path).digest('hex')}`
}

const ANNOTATE_PREFIX = 'annotate:'

/**
 * The ctx.storage key of an annotated text's draft: its own namespace, so a caller's key can never
 * name a file's draft (`draft:<path>`). Hashed past the key limit, like draftKey.
 */
function annotationKey(key) {
  const full = ANNOTATE_PREFIX + key
  if (full.length <= MAX_KEY) return full
  return `${ANNOTATE_PREFIX}#${require('node:crypto').createHash('sha256').update(key).digest('hex')}`
}

/** Runs of whitespace and control characters made one space: a title is one line of the header. */
const oneLine = (s) => s.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim()

/** An http(s) URL of at most MAX_ANNOTATE_URL chars with no whitespace or controls, or a ReviewError. */
function checkUrl(u) {
  if (typeof u !== 'string') throw new ReviewError('url must be a string')
  if (u.length > MAX_ANNOTATE_URL) throw new ReviewError(`url is over ${MAX_ANNOTATE_URL} characters`)
  if (/[\x00-\x20\x7f]/.test(u)) throw new ReviewError('url must not contain whitespace or control characters')
  let parsed
  try {
    parsed = new URL(u)
  } catch {
    throw new ReviewError('url is not a valid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReviewError('url must be http or https')
  return u
}

/**
 * annotate's `assets`, checked: [{ id, name, mime, dataUrl }]. Images only (ASSET_MIMES, no SVG),
 * each a base64 data: URL of its own declared type, at most MAX_ASSET_CHARS, MAX_ASSETS_TOTAL in
 * all, MAX_ASSETS of them, ids unique. Checked here rather than in the page because the host posts
 * each one in a message of its own and must know it fits.
 */
function checkAssets(list) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new ReviewError('assets must be an array')
  if (list.length > MAX_ASSETS) throw new ReviewError(`at most ${MAX_ASSETS} assets`)
  const seen = new Set()
  let total = 0
  return list.map((a, i) => {
    const at = `assets[${i}]`
    if (!isObj(a)) throw new ReviewError(`${at} must be { id, name?, mime, dataUrl }`)
    if (typeof a.id !== 'string' || !ASSET_ID_CHARS.test(a.id)) throw new ReviewError(`${at}.id must be 1-100 characters of A-Z a-z 0-9 . _ -`)
    if (seen.has(a.id)) throw new ReviewError(`${at}.id ${a.id} is used twice`)
    seen.add(a.id)
    let name = null
    if (a.name !== undefined && a.name !== null) {
      if (typeof a.name !== 'string') throw new ReviewError(`${at}.name must be a string`)
      name = oneLine(a.name).slice(0, MAX_ASSET_NAME) || null
    }
    if (!ASSET_MIMES.includes(a.mime)) throw new ReviewError(`${at}.mime must be one of ${ASSET_MIMES.join(', ')}`)
    if (typeof a.dataUrl !== 'string') throw new ReviewError(`${at}.dataUrl must be a string`)
    if (a.dataUrl.length > MAX_ASSET_CHARS) throw new ReviewError(`${at}.dataUrl is over ${MAX_ASSET_CHARS} characters`)
    const head = `data:${a.mime};base64,`
    if (!a.dataUrl.startsWith(head) || !BASE64.test(a.dataUrl.slice(head.length))) {
      throw new ReviewError(`${at}.dataUrl must be a base64 data: URL of type ${a.mime}`)
    }
    total += a.dataUrl.length
    if (total > MAX_ASSETS_TOTAL) throw new ReviewError(`assets are over ${MAX_ASSETS_TOTAL / 1024 / 1024} MiB in all`)
    return { id: a.id, name, mime: a.mime, dataUrl: a.dataUrl }
  })
}

/**
 * annotate's options, checked: { title, text, html, assets, url, key, tabId } (exactly one of
 * text and html is a string, the other null), or a ReviewError naming the bad field. title: 1-200
 * chars once made one line. text: a string of at most MAX_ANNOTATE_TEXT UTF-8 bytes without NUL
 * (empty is allowed: the comment can still say something). html: the same, at most
 * MAX_ANNOTATE_HTML bytes; the page sanitizes it. aside: absent, or HTML of at most
 * MAX_ANNOTATE_ASIDE chars without NUL, for the details column (sanitized the same way; with text or
 * html; null when absent or empty). assets: with html only (checkAssets). url:
 * absent, or an http(s) URL of at most 2048 chars with no whitespace or controls (it goes into the
 * message as is). key: absent (then `title:` + a hash of the title, so the same title reopens the
 * same draft), or 1-200 chars of ANNOTATE_KEY_CHARS. tabId: absent or a string; the host checks it
 * against the window's tabs.
 */
function annotateInput(o) {
  if (!isObj(o)) throw new ReviewError('annotate takes { title, text | html, aside?, assets?, url?, key?, tabId? }')
  if (typeof o.title !== 'string') throw new ReviewError('title must be a string')
  const title = oneLine(o.title)
  if (!title) throw new ReviewError('title must not be empty')
  if (title.length > MAX_ANNOTATE_TITLE) throw new ReviewError(`title is over ${MAX_ANNOTATE_TITLE} characters`)
  const given = (v) => v !== undefined && v !== null
  if (given(o.text) && given(o.html)) throw new ReviewError('pass text or html, not both')
  let text = null
  let html = null
  if (given(o.html)) {
    if (typeof o.html !== 'string') throw new ReviewError('html must be a string')
    if (o.html.includes('\0')) throw new ReviewError('html contains a NUL byte')
    if (Buffer.byteLength(o.html, 'utf8') > MAX_ANNOTATE_HTML) throw new ReviewError(`html is larger than ${MAX_ANNOTATE_HTML / 1024 / 1024} MiB`)
    html = o.html
  } else {
    if (typeof o.text !== 'string') throw new ReviewError('text must be a string (or pass html)')
    if (o.text.includes('\0')) throw new ReviewError('text contains a NUL byte')
    if (Buffer.byteLength(o.text, 'utf8') > MAX_ANNOTATE_TEXT) throw new ReviewError(`text is larger than ${MAX_ANNOTATE_TEXT / 1024} KiB`)
    text = o.text
  }
  let aside = null
  if (given(o.aside)) {
    if (typeof o.aside !== 'string') throw new ReviewError('aside must be a string of HTML')
    if (o.aside.includes('\0')) throw new ReviewError('aside contains a NUL byte')
    if (o.aside.length > MAX_ANNOTATE_ASIDE) throw new ReviewError(`aside is over ${MAX_ANNOTATE_ASIDE} characters`)
    aside = o.aside || null
  }
  if (html === null && Array.isArray(o.assets) && o.assets.length) throw new ReviewError('assets go with html, not text')
  const assets = html === null ? [] : checkAssets(o.assets)
  const url = given(o.url) ? checkUrl(o.url) : null
  let key
  if (!given(o.key)) {
    key = `title:${require('node:crypto').createHash('sha256').update(title).digest('hex').slice(0, 32)}`
  } else {
    if (typeof o.key !== 'string') throw new ReviewError('key must be a string')
    if (!o.key || o.key.length > MAX_ANNOTATE_KEY) throw new ReviewError(`key must be 1-${MAX_ANNOTATE_KEY} characters`)
    if (!ANNOTATE_KEY_CHARS.test(o.key)) throw new ReviewError('key may only use letters, digits and . _ : @ # + = ~ / -')
    key = o.key
  }
  if (given(o.tabId) && typeof o.tabId !== 'string') throw new ReviewError('tabId must be a string')
  return { title, text, html, aside, assets, url, key, tabId: typeof o.tabId === 'string' ? o.tabId : undefined }
}

/**
 * `s` cut into parts whose JSON (escaping included) is at most `maxJson` chars each, in order; ''
 * gives one empty part. A char costs at most 6 JSON chars (`\u001f`), so a part of maxJson / 6
 * chars always fits, with no measuring. A cut never falls inside a surrogate pair: a lone half
 * would not reach the page as the same character.
 */
function splitParts(s, maxJson = MAX_PART_JSON) {
  const size = Math.max(2, Math.floor((maxJson - 2) / 6))
  const parts = []
  let i = 0
  do {
    let end = Math.min(s.length, i + size)
    const c = s.charCodeAt(end - 1)
    if (end < s.length && c >= 0xd800 && c <= 0xdbff) end--
    parts.push(s.slice(i, end))
    i = end
  } while (i < s.length)
  return parts
}

module.exports = {
  draftKey,
  cleanDraft,
  draftProblem,
  isEmpty,
  formatReview,
  buildReview,
  annotateInput,
  annotationKey,
  buildAnnotation,
  splitParts,
  MAX_MESSAGE,
  MAX_NOTE_TEXT,
  MAX_GLOBAL,
  MAX_NOTES,
  MAX_QUOTE,
  MAX_DRAFT_JSON,
  MAX_ANNOTATE_TITLE,
  MAX_ANNOTATE_TEXT,
  MAX_ANNOTATE_URL,
  MAX_ANNOTATE_KEY,
  MAX_ANNOTATE_HTML,
  MAX_ANNOTATE_ASIDE,
  ASSET_MIMES,
  MAX_ASSETS,
  MAX_ASSET_CHARS,
  MAX_ASSETS_TOTAL,
  MAX_PART_JSON,
  MAX_ANCHOR_CONTEXT,
}
