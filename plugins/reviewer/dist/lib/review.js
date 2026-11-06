'use strict'
// Drafts (what the overlay page posts as the person types) and the text Claude receives.
//
// A draft comes from our own page, but it is still checked and capped here: the host is the one
// that types it into a Claude session, and a page bug must not turn into a 5 MB paste.

const MAX_NOTES = 200
const MAX_GLOBAL = 20000
const MAX_NOTE_TEXT = 4000 // the page's note and comment inputs carry the same caps as maxlength
const MAX_QUOTE = 500 // per note, as stored; the message may shorten it further
const MAX_MESSAGE = 20000 // the most one review text may take; quotes are shortened first
// What the reviewer hands the app's Discuss with Claude (its onDiscuss answer). The app sends at most
// 20,000 characters in all: `About: <title>`, the type line (at most 500), this text, then the
// person's note (at most 4,000), and it cuts this text first. Kept under what that leaves, so the
// app never cuts the person's notes (a cut there would lose them silently; a cut here is reported).
const MAX_CONTEXT = 15000
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
// With a companion each column has a header bar: a short label ("Mail", "Jira · PROJ-123") and a
// button "Open in <urlLabel> ↗" ("Gmail", "Jira"; else "Open in browser ↗"). Plain text, one line.
const MAX_ANNOTATE_LABEL = 60
const MAX_ANNOTATE_URL_LABEL = 30
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
 * { id, quote, anchor: { prefix, suffix, occurrence, length, at }, text, doc? } (annotate's HTML
 * mode; `doc: 'companion'` for a note on the companion document, absent for the main one).
 */
function cleanDraft(d) {
  const out = { global: '', notes: [] }
  if (!isObj(d)) return out
  if (typeof d.global === 'string') out.global = d.global.slice(0, MAX_GLOBAL)
  if (Array.isArray(d.notes)) {
    for (const n of d.notes.slice(0, MAX_NOTES)) {
      if (!isObj(n)) continue
      if (isObj(n.anchor)) {
        const note = {
          id: typeof n.id === 'string' ? n.id.slice(0, 40) : String(out.notes.length + 1),
          quote: typeof n.quote === 'string' ? n.quote.slice(0, MAX_QUOTE) : '',
          anchor: cleanAnchor(n.anchor),
          text: typeof n.text === 'string' ? n.text.slice(0, MAX_NOTE_TEXT) : '',
        }
        // A note on annotate's companion (the document beside the main one); absent for the main one,
        // so a draft from before the companion reads the same.
        if (n.doc === 'companion') note.doc = 'companion'
        out.notes.push(note)
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

/**
 * Line notes in line order (old before new at the same line), then HTML notes in text order: the
 * main document's first, then the companion's.
 */
function noteOrder(a, b) {
  const ah = !!a.anchor
  const bh = !!b.anchor
  if (ah !== bh) return ah ? 1 : -1
  if (ah) return (a.doc === 'companion') - (b.doc === 'companion') || a.anchor.at - b.anchor.at
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
function buildMessage(head, draft, sided, companionTitle = null, max = MAX_MESSAGE) {
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
        // A note on the companion says which document it is in; the main one's need not.
        const where = n.doc === 'companion' ? `In ${companionTitle || 'the document beside it'}, ${q[0].toLowerCase()}${q.slice(1)}` : q
        parts.push(`${i + 1}. ${where}: ${body}`)
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
    if (text.length <= max) return { text, cut: false }
  }
  return { text: build(0).slice(0, max - CUT_MARK.length) + CUT_MARK, cut: true }
}

/**
 * The text Claude receives. Plain text that never starts with `/`, `!`, `#` or `&` (the send gate
 * refuses those): it always opens with "Review of". Notes in file order, old side before new at the
 * same line. A note without text is left out (a selection the person never wrote anything for).
 */
function formatReview(draft, sides) {
  return buildReview(draft, sides).text
}

/** formatReview, plus `cut` (see buildMessage); `max` the text's cap (MAX_CONTEXT for Discuss). */
function buildReview(draft, sides, max = MAX_MESSAGE) {
  const commit = sides.head ? ` ${sides.head.slice(0, 12)}` : ''
  const unchanged = sides.mode === 'diff' && !sides.oldMissing && !sides.newMissing && sides.old === sides.new
  // Sides only mean something when there is a diff: an unchanged file is one text.
  const sided = sides.mode === 'diff' && !unchanged
  const base = sides.mode === 'plain' ? 'the file as it is now, no git diff' : unchanged ? `unchanged since the last commit${commit}` : `changes since the last commit${commit}`
  const head = `Review of ${sides.path} (${base})`
  // No comment and no note: Discuss still sends (it used to refuse, real-work feedback 9). Claude
  // can read the file itself, so the message asks it to and to talk the change through.
  if (isEmpty(cleanDraft(draft))) {
    const ask = sided || sides.mode === 'diff' ? DISCUSS_DIFF : DISCUSS_FILE
    return { text: `${head}\n\n${ask}`, cut: false }
  }
  return buildMessage(head, draft, sided, null, max)
}

const DISCUSS_DIFF = 'Discuss these changes with me: read the file and its diff against the last commit, then tell me what you see.'
const DISCUSS_FILE = 'Discuss this file with me: read it, then tell me what you see.'
const DISCUSS_TEXT = 'Discuss this with me: what it is about, what matters in it, and what I should do about it, if anything. Its text follows.'
const TEXT_CUT_MARK = '\n\n(text cut: too long)'
// How much of a caller's HTML htmlText reads: the message holds MAX_MESSAGE chars, so more is never
// needed, and the regexes below then never scan megabytes.
const MAX_HTML_SCAN = 200000

/**
 * A caller's HTML (annotate's html, aside, companion) as plain text for a message: script, style and
 * comments dropped, block ends and `br` made line breaks, list items "- ", the other tags removed,
 * entities decoded, blank runs collapsed. Only for Claude's message: what the person sees is the
 * page's own sanitized rendering.
 */
function htmlText(html) {
  if (typeof html !== 'string' || !html) return ''
  const BLOCK = '(?:p|div|h[1-6]|ul|ol|li|tr|table|thead|tbody|blockquote|pre|section|article|header|footer|dl|dt|dd|figure|figcaption|details|summary|hr)'
  return decodeAttr(
    html
      .slice(0, MAX_HTML_SCAN)
      .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li\s*>/gi, '')
      // A facts list (`dl.facts`) reads "Label: value", one per line.
      .replace(/<\/dt\s*>/gi, ': ')
      .replace(/<dd\b[^>]*>/gi, '')
      .replace(/<\/t[dh]\s*>/gi, ' ')
      .replace(new RegExp(`</?${BLOCK}\\b[^>]*>`, 'gi'), '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The message of a Discuss with no comment and no note on an annotated text: the head, the ask, then
 * the text itself (the aside first, the companion after the main one), since Claude has no other way
 * to read a mail or a ticket handed to the reviewer. The text is cut to fit MAX_MESSAGE; `cut` stays
 * false, as nothing of the person's is lost.
 */
function discussAnnotation(head, a, max = MAX_MESSAGE) {
  const c = a.companion || null
  const doc = (aside, body) => [htmlText(aside), body].filter((s) => s).join('\n\n')
  const main = doc(a.aside, a.html !== null && a.html !== undefined ? htmlText(a.html) : typeof a.text === 'string' ? a.text.trim() : '')
  const beside = c ? doc(c.facts, htmlText(c.html)) : ''
  const parts = [main, beside ? `Beside it, ${c.title}:\n\n${beside}` : ''].filter((s) => s)
  const lead = `${head}\n\n${DISCUSS_TEXT}`
  let body = parts.join('\n\n')
  if (!body) return { text: `${head}\n\nDiscuss this with me.`, cut: false }
  const room = max - lead.length - 2
  if (body.length > room) body = body.slice(0, Math.max(0, room - TEXT_CUT_MARK.length)).replace(/\s+\S*$/, '') + TEXT_CUT_MARK
  return { text: `${lead}\n\n${body}`, cut: false }
}

/**
 * The text Claude receives for an annotated text (annotate), with `cut` as buildReview. It opens
 * with "About <title>" (plus " (<url>)"), so it never starts with `/`, `!`, `#` or `&`, which the
 * send gate refuses; notes have no sides (one text), otherwise exactly as a file review's. HTML
 * notes read `N. On «quote»: note`, with no line numbers. With a companion the head names it too
 * (`, with <title> (<url>) beside it`) and its notes read `N. In <title>, on «quote»: note`.
 */
function buildAnnotation(draft, a, max = MAX_MESSAGE) {
  const { title, url, companion } = a
  const named = (t, u) => `${t}${u ? ` (${u})` : ''}`
  const c = companion || null
  const head = `About ${named(title, url)}${c ? `, with ${named(c.title, c.url)} beside it` : ''}`
  if (isEmpty(cleanDraft(draft))) return discussAnnotation(head, a, max)
  return buildMessage(head, draft, false, c ? c.title : null, max)
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

/** An http(s) URL of at most MAX_ANNOTATE_URL chars with no whitespace or controls, or a ReviewError naming `name`. */
function checkUrl(u, name = 'url') {
  if (typeof u !== 'string') throw new ReviewError(`${name} must be a string`)
  if (u.length > MAX_ANNOTATE_URL) throw new ReviewError(`${name} is over ${MAX_ANNOTATE_URL} characters`)
  if (/[\x00-\x20\x7f]/.test(u)) throw new ReviewError(`${name} must not contain whitespace or control characters`)
  let parsed
  try {
    parsed = new URL(u)
  } catch {
    throw new ReviewError(`${name} is not a valid URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ReviewError(`${name} must be http or https`)
  return u
}

/** A title: 1-MAX_ANNOTATE_TITLE chars once made one line, or a ReviewError naming `name`. */
function checkTitle(v, name) {
  if (typeof v !== 'string') throw new ReviewError(`${name} must be a string`)
  const title = oneLine(v)
  if (!title) throw new ReviewError(`${name} must not be empty`)
  if (title.length > MAX_ANNOTATE_TITLE) throw new ReviewError(`${name} is over ${MAX_ANNOTATE_TITLE} characters`)
  return title
}

// An overlay type (the app's OverlayExtras.type, `ccc guide api`): what the review shows, so other
// plugins add their buttons for it (Gmail's on its own `inbox-item`) and Discuss names it. The same
// rule as main's (src/shared/overlay-buttons.ts), checked here so a bad one is refused with the
// reviewer's own message before any overlay starts, not as a refused overlay.
const TYPE_NAME = /^[a-z][a-z0-9-]{0,63}$/
const MAX_TYPE_DATA = 4096 // characters of JSON

/** An overlay type { name, data }: absent (null), or a clean copy; a ReviewError otherwise. */
function checkType(v) {
  if (v === undefined || v === null) return null
  if (!isObj(v)) throw new ReviewError('type must be { name, data }')
  if (typeof v.name !== 'string' || !TYPE_NAME.test(v.name)) throw new ReviewError('type.name must be a lower-case noun of letters, digits and - (at most 64)')
  let json
  try {
    json = JSON.stringify(v.data === undefined ? null : v.data)
  } catch {
    throw new ReviewError('type.data must be plain JSON')
  }
  if (json === undefined) throw new ReviewError('type.data must be plain JSON')
  if (json.length > MAX_TYPE_DATA) throw new ReviewError(`type.data is over ${MAX_TYPE_DATA} characters of JSON`)
  return { name: v.name, data: JSON.parse(json) }
}

/** A plain-text label: absent (null), or 1-`max` chars once made one line; a ReviewError naming `name` otherwise. */
function checkLabel(v, name, max) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new ReviewError(`${name} must be a string`)
  const label = oneLine(v)
  if (!label) throw new ReviewError(`${name} must not be empty`)
  if (label.length > max) throw new ReviewError(`${name} is over ${max} characters`)
  return label
}

/** `s` cut to `max` chars with a trailing … (a default label from a title). */
const shorten = (s, max) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/** HTML for the page: a string without NUL of at most MAX_ANNOTATE_HTML UTF-8 bytes, or a ReviewError. */
function checkHtml(v, name) {
  if (typeof v !== 'string') throw new ReviewError(`${name} must be a string`)
  if (v.includes('\0')) throw new ReviewError(`${name} contains a NUL byte`)
  if (Buffer.byteLength(v, 'utf8') > MAX_ANNOTATE_HTML) throw new ReviewError(`${name} is larger than ${MAX_ANNOTATE_HTML / 1024 / 1024} MiB`)
  return v
}

/** A details block of HTML (aside, companion.facts): absent, or at most MAX_ANNOTATE_ASIDE chars without NUL; null when absent or empty. */
function checkFacts(v, name) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new ReviewError(`${name} must be a string of HTML`)
  if (v.includes('\0')) throw new ReviewError(`${name} contains a NUL byte`)
  if (v.length > MAX_ANNOTATE_ASIDE) throw new ReviewError(`${name} is over ${MAX_ANNOTATE_ASIDE} characters`)
  return v || null
}

/**
 * annotate's `assets` (or `companion.assets`), checked: [{ id, name, mime, dataUrl }]. Images only
 * (ASSET_MIMES, no SVG), each a base64 data: URL of its own declared type, at most MAX_ASSET_CHARS,
 * MAX_ASSETS_TOTAL in all, MAX_ASSETS of them, ids unique. Checked here rather than in the page
 * because the host posts each one in a message of its own and must know it fits. `budget` carries
 * the count, the total and the ids across calls: the main document's assets and the companion's
 * share one budget and one id namespace (an `asset:<id>` names the same image in either).
 */
function checkAssets(list, where = 'assets', budget = { count: 0, total: 0, seen: new Set() }) {
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) throw new ReviewError(`${where} must be an array`)
  const shared = budget.count > 0 || where !== 'assets'
  // update's assets join the ones the document already has (annotate's and the companion's).
  const together = where === 'update.assets' ? ' (with the assets the document already has)' : shared ? ' (assets and companion.assets together)' : ''
  if (budget.count + list.length > MAX_ASSETS) throw new ReviewError(`at most ${MAX_ASSETS} assets${together}`)
  budget.count += list.length
  return list.map((a, i) => {
    const at = `${where}[${i}]`
    if (!isObj(a)) throw new ReviewError(`${at} must be { id, name?, mime, dataUrl }`)
    if (typeof a.id !== 'string' || !ASSET_ID_CHARS.test(a.id)) throw new ReviewError(`${at}.id must be 1-100 characters of A-Z a-z 0-9 . _ -`)
    if (budget.seen.has(a.id)) throw new ReviewError(`${at}.id ${a.id} is used twice${shared ? ' (the ids of assets and companion.assets are one namespace)' : ''}`)
    budget.seen.add(a.id)
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
    budget.total += a.dataUrl.length
    if (budget.total > MAX_ASSETS_TOTAL) throw new ReviewError(`assets are over ${MAX_ASSETS_TOTAL / 1024 / 1024} MiB in all${together}`)
    return { id: a.id, name, mime: a.mime, dataUrl: a.dataUrl }
  })
}

/**
 * annotate's `companion`: a second document shown beside the main one (a Jira issue beside the mail
 * about it), checked like the main one: { title, html, assets, url, facts }. title as annotate's,
 * html as annotate's html (required: a companion goes with an html main document), facts as aside
 * (the companion column's own details block), url as url, assets within the budget the main
 * document's assets left (`budget`, see checkAssets).
 */
function checkCompanion(c, budget) {
  if (!isObj(c)) throw new ReviewError('companion must be { title, html, assets?, url?, facts?, label?, urlLabel? }')
  const title = checkTitle(c.title, 'companion.title')
  const html = checkHtml(c.html, 'companion.html')
  const facts = checkFacts(c.facts, 'companion.facts')
  const url = c.url !== undefined && c.url !== null ? checkUrl(c.url, 'companion.url') : null
  const assets = checkAssets(c.assets, 'companion.assets', budget)
  // The column's label: the caller's, else the title cut to a header's length.
  const label = checkLabel(c.label, 'companion.label', MAX_ANNOTATE_LABEL) || shorten(title, MAX_ANNOTATE_LABEL)
  const urlLabel = checkLabel(c.urlLabel, 'companion.urlLabel', MAX_ANNOTATE_URL_LABEL)
  return { title, html, assets, url, facts, label, urlLabel }
}

// annotate's `originals` (feature 'original', app 0.13.0): the main document's parts as their sender
// made them (a designed mail's own HTML and CSS), each shown by the page in a sandboxed frame at the
// caller's `div[data-original=<id>]`, in place of `div[data-reader=<id>]` (src/page/original.mjs).
const MAX_ORIGINALS = 50
const ORIGINAL_ID = /^[a-z][a-z0-9-]{0,39}$/ // the shape of sanitize.mjs's data-original values
const VIEWS = ['original', 'reader']

/**
 * annotate's `originals`: absent/null/empty (null), or at most MAX_ORIGINALS { id, html }, ids of
 * ORIGINAL_ID unique, each html a string without NUL, MAX_ANNOTATE_HTML UTF-8 bytes in all (a budget
 * apart from `html`'s: a thread is in both, once per view).
 */
function checkOriginals(list) {
  if (list === undefined || list === null) return null
  if (!Array.isArray(list)) throw new ReviewError('originals must be an array of { id, html }')
  if (list.length > MAX_ORIGINALS) throw new ReviewError(`at most ${MAX_ORIGINALS} originals`)
  const seen = new Set()
  let bytes = 0
  const out = list.map((o, i) => {
    const at = `originals[${i}]`
    if (!isObj(o)) throw new ReviewError(`${at} must be { id, html }`)
    if (typeof o.id !== 'string' || !ORIGINAL_ID.test(o.id)) throw new ReviewError(`${at}.id is 1-40 of a-z 0-9 - starting with a letter`)
    if (seen.has(o.id)) throw new ReviewError(`${at}.id ${o.id} is used twice`)
    seen.add(o.id)
    if (typeof o.html !== 'string') throw new ReviewError(`${at}.html must be a string`)
    if (o.html.includes('\0')) throw new ReviewError(`${at}.html contains a NUL byte`)
    bytes += Buffer.byteLength(o.html, 'utf8')
    if (bytes > MAX_ANNOTATE_HTML) throw new ReviewError(`originals are larger than ${MAX_ANNOTATE_HTML / 1024 / 1024} MiB in all`)
    return { id: o.id, html: o.html }
  })
  return out.length ? out : null
}

/**
 * annotate's options, checked: { title, text, html, aside, assets, url, key, tabId, companion }
 * (exactly one of text and html is a string, the other null), or a ReviewError naming the bad
 * field. title: 1-200 chars once made one line. text: a string of at most MAX_ANNOTATE_TEXT UTF-8
 * bytes without NUL (empty is allowed: the comment can still say something). html: the same, at
 * most MAX_ANNOTATE_HTML bytes; the page sanitizes it. aside: absent, or HTML of at most
 * MAX_ANNOTATE_ASIDE chars without NUL, for the details column (sanitized the same way; with text or
 * html; null when absent or empty). assets: with html only (checkAssets). url: absent, or an http(s)
 * URL of at most 2048 chars with no whitespace or controls (it goes into the message as is). key:
 * absent (then `title:` + a hash of the title, so the same title reopens the same draft), or 1-200
 * chars of ANNOTATE_KEY_CHARS. tabId: absent or a string; the host checks it against the window's
 * tabs. label / urlLabel: the main column's header bar beside a companion (checkLabel; label
 * defaults to the title cut to MAX_ANNOTATE_LABEL). companion: absent (null), or with html only,
 * checkCompanion's answer.
 */
function annotateInput(o) {
  if (!isObj(o)) throw new ReviewError('annotate takes { title, text | html, aside?, assets?, url?, key?, tabId?, label?, urlLabel?, companion?, start?, type?, kind?, originals?, view? }')
  const title = checkTitle(o.title, 'title')
  // The main column's header bar, shown only beside a companion (the title cut, when not given).
  const label = checkLabel(o.label, 'label', MAX_ANNOTATE_LABEL) || shorten(title, MAX_ANNOTATE_LABEL)
  const urlLabel = checkLabel(o.urlLabel, 'urlLabel', MAX_ANNOTATE_URL_LABEL)
  const given = (v) => v !== undefined && v !== null
  if (given(o.text) && given(o.html)) throw new ReviewError('pass text or html, not both')
  let text = null
  let html = null
  if (given(o.html)) {
    html = checkHtml(o.html, 'html')
  } else {
    if (typeof o.text !== 'string') throw new ReviewError('text must be a string (or pass html)')
    if (o.text.includes('\0')) throw new ReviewError('text contains a NUL byte')
    if (Buffer.byteLength(o.text, 'utf8') > MAX_ANNOTATE_TEXT) throw new ReviewError(`text is larger than ${MAX_ANNOTATE_TEXT / 1024} KiB`)
    text = o.text
  }
  const aside = checkFacts(o.aside, 'aside')
  if (html === null && Array.isArray(o.assets) && o.assets.length) throw new ReviewError('assets go with html, not text')
  if (html === null && given(o.companion)) throw new ReviewError('companion goes with html, not text')
  const budget = { count: 0, total: 0, seen: new Set() }
  const assets = html === null ? [] : checkAssets(o.assets, 'assets', budget)
  const companion = given(o.companion) ? checkCompanion(o.companion, budget) : null
  const url = given(o.url) ? checkUrl(o.url) : null
  let key
  if (!given(o.key)) {
    key = `title:${require('node:crypto').createHash('sha256').update(title).digest('hex').slice(0, 32)}`
  } else {
    key = checkKey(o.key)
  }
  if (given(o.tabId) && typeof o.tabId !== 'string') throw new ReviewError('tabId must be a string')
  // Where the main document opens: 'top' (default) or 'end', for a conversation whose newest
  // messages are last (a long Chat thread, a mail thread): the reader wants the end, not the start.
  if (given(o.start) && o.start !== 'top' && o.start !== 'end') throw new ReviewError("start must be 'top' or 'end'")
  const start = o.start === 'end' ? 'end' : 'top'
  // The caller's overlay type (a mail thread as `inbox-item { source, id }`): the overlay gets it, so
  // the caller's buttons for its own items show here too. Absent: no type (Discuss still shows).
  const type = checkType(o.type)
  // The kind of document (feature 'mail', app 0.13.0): 'mail' gives the main document the mail
  // reading layout (a narrow column, larger text, calm links, the `mail-*` classes styled); absent,
  // the generic HTML look. Opt-in, so no other caller's document changes. HTML only: a text pane has
  // no layout to change.
  if (given(o.kind) && o.kind !== 'mail') throw new ReviewError("kind must be 'mail' (or absent)")
  if (given(o.kind) && html === null) throw new ReviewError('kind goes with html, not text')
  const kind = o.kind === 'mail' ? 'mail' : null
  // The Original view (feature 'original'): the main document's originals, and which view opens
  // ('original' by default when there are originals; the person's switch is told as the `view` event).
  if (given(o.originals) && html === null) throw new ReviewError('originals go with html, not text')
  const originals = html === null ? null : checkOriginals(o.originals)
  if (given(o.view) && !VIEWS.includes(o.view)) throw new ReviewError("view must be 'original' or 'reader'")
  const view = originals ? (o.view === 'reader' ? 'reader' : 'original') : null
  return { title, text, html, aside, assets, url, key, tabId: typeof o.tabId === 'string' ? o.tabId : undefined, label, urlLabel, companion, start, type, kind, originals, view }
}

// ---- actions and update (features 'actions' and 'update', app 0.13.0) ----
//
// A caller's document may hold buttons of its own: `<span data-action="<id>">Label</span>`, which
// the page draws as a button (feature 'actions'). A click comes back to the host as `{ type:
// 'action', id }`; the host emits the service event `action` { key, id, caller } only for an id the
// caller's own html, aside or companion has (actionSet, read from the strings it passed, as linkSet
// reads links), so a page that misbehaves cannot make up a click on something the caller never
// offered. The caller answers with `update({ key, assets?, hide?, status? })`: more images for the
// open document (a mail's remote pictures, loaded once the person asked), `data-part` regions to
// hide (the bar that offered them) and a status line. Nothing of the document is re-rendered, so
// the notes' anchors stay where they were.

const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/
const PART_NAME = ACTION_ID // `data-part` names: the same shape
const MAX_HIDE = 20
const MAX_STATUS = 200

/** The ids of the `data-action` attributes in the given HTML strings (entities decoded, shape checked). */
function actionSet(...htmls) {
  const set = new Set()
  const attr = /\sdata-action\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
  for (const html of htmls) {
    if (typeof html !== 'string') continue
    let m
    while ((m = attr.exec(html))) {
      const id = decodeAttr(m[1] ?? m[2] ?? m[3] ?? '').trim()
      if (ACTION_ID.test(id)) set.add(id)
    }
  }
  return set
}

/**
 * update's options, checked: { key, assets, hide, status }. key as annotate's (required); assets an
 * array checked later against what the document already has (checkAssets with its budget); hide at
 * most MAX_HIDE `data-part` names; status a line of at most MAX_STATUS characters ('' clears it, null
 * leaves it). At least one of the three.
 */
function updateInput(o) {
  if (!isObj(o)) throw new ReviewError('update takes { key, assets?, hide?, status? }')
  const key = checkKey(o.key)
  const given = (v) => v !== undefined && v !== null
  if (given(o.assets) && !Array.isArray(o.assets)) throw new ReviewError('assets must be an array')
  let hide = []
  if (given(o.hide)) {
    if (!Array.isArray(o.hide) || o.hide.length > MAX_HIDE) throw new ReviewError(`hide must be an array of at most ${MAX_HIDE} part names`)
    hide = [...new Set(o.hide)]
    for (const h of hide) if (typeof h !== 'string' || !PART_NAME.test(h)) throw new ReviewError('a hide name is 1-40 of a-z 0-9 - starting with a letter')
  }
  let status = null
  if (given(o.status)) {
    if (typeof o.status !== 'string') throw new ReviewError('status must be a string')
    status = shorten(oneLine(o.status), MAX_STATUS)
  }
  const assets = given(o.assets) ? o.assets : []
  if (!assets.length && !hide.length && status === null) throw new ReviewError('update needs assets, hide or status')
  return { key, assets, hide, status }
}

/** The asset budget a document already spent: what checkAssets carries across calls. */
function assetBudget(lists) {
  const budget = { count: 0, total: 0, seen: new Set() }
  for (const list of lists) {
    for (const a of list) {
      budget.count++
      budget.total += a.dataUrl.length
      budget.seen.add(a.id)
    }
  }
  return budget
}

/** An annotate key: 1-MAX_ANNOTATE_KEY chars of ANNOTATE_KEY_CHARS. */
function checkKey(v) {
  if (typeof v !== 'string') throw new ReviewError('key must be a string')
  if (!v || v.length > MAX_ANNOTATE_KEY) throw new ReviewError(`key must be 1-${MAX_ANNOTATE_KEY} characters`)
  if (!ANNOTATE_KEY_CHARS.test(v)) throw new ReviewError('key may only use letters, digits and . _ : @ # + = ~ / -')
  return v
}

/**
 * prepare({ key, title, type?, tabId? }) and cancel({ key }): the overlay of an annotate still to
 * come, opened at once with a loader while the caller fetches. `key` is required (it is how the
 * annotate that fills the overlay finds it) and checked as annotate's; `title`, `type` and `tabId` as
 * annotate's (prepare only). An overlay's type and Discuss tab are fixed when it starts, so a caller
 * that prepares passes them here: the annotate filling it cannot change them.
 */
function prepareInput(o, { title: withTitle = true } = {}) {
  if (!isObj(o)) throw new ReviewError(withTitle ? 'prepare takes { key, title, type?, tabId? }' : 'cancel takes { key }')
  const key = checkKey(o.key)
  if (!withTitle) return { key }
  if (o.tabId !== undefined && o.tabId !== null && typeof o.tabId !== 'string') throw new ReviewError('tabId must be a string')
  return { key, title: checkTitle(o.title, 'title'), type: checkType(o.type), tabId: typeof o.tabId === 'string' ? o.tabId : undefined }
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

// ---- links of an annotated text ----
//
// A click on a link in annotate's document or details column posts { type: 'open-link', href } with
// the href of the page's sanitized DOM. The page renders a caller's HTML, so the host does not take
// that href on trust (a sanitizer bug, a page bug): it opens only a link the caller's own `html` or
// `aside` string has. The set is built here from the strings the caller passed, read the way the
// browser reads an attribute (entity references decoded), and both sides are normalized by `new
// URL()`, as the page's safeHref (src/page/sanitize.mjs) does. A link this reads differently from
// the browser (an exotic named entity) is refused, never opened by mistake: it fails closed.

const MAX_LINK_HREF = 2048 // safeHref's MAX_HREF: a longer href is not rendered as a link

// The named references decoded here: the ones a URL plausibly carries (names are case-sensitive;
// `&AMP;` is a name of its own). All but `apos` are legacy names the browser also takes without the
// `;`, except inside an attribute when a letter, digit or `=` follows: `?a=1&ltx=2` stays as written.
const NAMED_ENTITIES = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", nbsp: '\u00a0' }
const LEGACY_ENTITIES = new Set(['amp', 'AMP', 'lt', 'LT', 'gt', 'GT', 'quot', 'QUOT', 'nbsp'])

const codePoint = (n) => (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '\ufffd' : String.fromCodePoint(n))

/** An attribute value as the HTML parser hands it to the DOM: &amp; &quot; &#39; &#x26; ... decoded. */
function decodeAttr(v) {
  return v.replace(/&(?:#[xX]([0-9a-fA-F]{1,8});?|#([0-9]{1,10});?|([A-Za-z]{2,8})(;?))/g, (m, hex, dec, name, semi, at, s) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16))
    if (dec !== undefined) return codePoint(parseInt(dec, 10))
    if (!Object.hasOwn(NAMED_ENTITIES, name)) return m
    if (semi) return NAMED_ENTITIES[name]
    if (!LEGACY_ENTITIES.has(name)) return m
    const next = s[at + m.length]
    return next !== undefined && /[A-Za-z0-9=]/.test(next) ? m : NAMED_ENTITIES[name]
  })
}

/** An href normalized as the page's safeHref has it (trimmed, `new URL().href`), or null. */
function normalizeHref(raw) {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  if (!v || v.length > MAX_LINK_HREF) return null
  try {
    return new URL(v).href
  } catch {
    return null
  }
}

const SPACE = /[\t\n\f\r ]/

/**
 * The href values of the `<a>` tags in an HTML string, entity-decoded. A linear scan of each tag's
 * attributes as the HTML tokenizer reads them (quoted, unquoted, no value; the first `href` wins, as a
 * duplicate attribute is dropped), so a `>` inside a quoted title does not end the tag early. An `<a`
 * in a comment or a script counts too: the caller wrote it, so that is no URL from elsewhere.
 */
function linkHrefs(html) {
  const out = []
  if (typeof html !== 'string') return out
  const s = html
  const tag = /<a[\t\n\f\r />]/gi
  let m
  while ((m = tag.exec(s))) {
    let i = m.index + 2
    let href = null
    for (;;) {
      while (i < s.length && (SPACE.test(s[i]) || s[i] === '/')) i++
      if (i >= s.length || s[i] === '>') break
      let j = i + 1 // a name may start with `=`
      while (j < s.length && !SPACE.test(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++
      const name = s.slice(i, j).toLowerCase()
      i = j
      while (i < s.length && SPACE.test(s[i])) i++
      let value = null
      if (s[i] === '=') {
        i++
        while (i < s.length && SPACE.test(s[i])) i++
        const q = s[i]
        if (q === '"' || q === "'") {
          const end = s.indexOf(q, i + 1)
          const stop = end === -1 ? s.length : end
          value = s.slice(i + 1, stop)
          i = stop + 1
        } else {
          j = i
          while (j < s.length && !SPACE.test(s[j]) && s[j] !== '>') j++
          value = s.slice(i, j)
          i = j
        }
      }
      if (name === 'href' && href === null) href = value === null ? '' : value
    }
    tag.lastIndex = Math.max(tag.lastIndex, i)
    if (href !== null) out.push(decodeAttr(href))
  }
  return out
}

/** The normalized hrefs of the links in the given HTML strings (null entries skipped). */
function linkSet(...htmls) {
  const set = new Set()
  for (const html of htmls) {
    for (const raw of linkHrefs(html)) {
      const href = normalizeHref(raw)
      if (href) set.add(href)
    }
  }
  return set
}

/**
 * What to do with an `open-link` from the page: { open: url } for an http(s) link of the caller's,
 * else { refuse: why } for the status line. `links` is linkSet() of what the caller sent.
 */
function linkVerdict(links, href) {
  const norm = typeof href === 'string' && href.length <= 4 * MAX_LINK_HREF ? normalizeHref(href) : null
  if (!norm || !links.has(norm)) return { refuse: 'Not opened: not a link of this document' }
  const u = new URL(norm)
  if (u.protocol === 'http:' || u.protocol === 'https:') return { open: norm }
  if (u.protocol === 'mailto:') {
    let address = u.pathname
    try {
      address = decodeURIComponent(address)
    } catch {}
    return { refuse: `mailto links are not opened: ${address}` }
  }
  return { refuse: 'Not opened: not a link of this document' }
}

module.exports = {
  draftKey,
  cleanDraft,
  draftProblem,
  isEmpty,
  formatReview,
  buildReview,
  annotateInput,
  prepareInput,
  checkType,
  annotationKey,
  buildAnnotation,
  htmlText,
  splitParts,
  linkHrefs,
  linkSet,
  linkVerdict,
  actionSet,
  updateInput,
  assetBudget,
  checkAssets,
  checkOriginals,
  MAX_ORIGINALS,
  VIEWS,
  MAX_MESSAGE,
  MAX_CONTEXT,
  MAX_TYPE_DATA,
  MAX_NOTE_TEXT,
  MAX_GLOBAL,
  MAX_NOTES,
  MAX_QUOTE,
  MAX_DRAFT_JSON,
  MAX_ANNOTATE_TITLE,
  MAX_ANNOTATE_TEXT,
  MAX_ANNOTATE_URL,
  MAX_ANNOTATE_KEY,
  MAX_ANNOTATE_LABEL,
  MAX_ANNOTATE_URL_LABEL,
  MAX_ANNOTATE_HTML,
  MAX_ANNOTATE_ASIDE,
  ASSET_MIMES,
  MAX_ASSETS,
  MAX_ASSET_CHARS,
  MAX_ASSETS_TOTAL,
  MAX_PART_JSON,
  MAX_ANCHOR_CONTEXT,
}
