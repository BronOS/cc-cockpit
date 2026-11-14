'use strict'
// Ask Claude, the host's half (design-editor.md §4 "Ask Claude"). Ctrl+L and the context menu make the
// page call ccPanel.tab.discuss(); core draws the question box, then asks this tab's `onDiscuss`
// (within 5 s) for the context and sends `About: <file name>`, the tab's `File: <path>` line, our
// context and the person's question to the Claude tab they pick, as their own text. A plugin's own
// `sessions.send` would be refused on a typed tab, which nearly every tab is; Discuss is not.
//
// The context is `path:start-end` (1-based, inclusive) and the selection in a fence:
//
//   src/x.ts:40-52
//   ```
//   <the selected text>
//   ```
//
// With no selection it is `path:line` for the cursor's line and nothing else. The fence is one backtick
// longer than the longest run in the text (at least three), so a selection holding ``` cannot end the
// block early and pass the rest off as the person's own words. The selection is file text, so data for
// Claude to read, never instructions: it is cut to MAX_ASK_CHARS, with a note when it was.
//
// Every review note of the file follows the selection (design-editor.md §4 "Review notes in place"), in
// line order, numbered and quoted as the Reviewer's own Discuss writes a file review's notes, so Claude
// reads both the same way; a note whose lines overlap the asked ones (the cursor's line with none) says
// so where the Reviewer puts a note's side:
//
//   Review notes on this file:
//
//   1. Lines 40-44 (on the asked lines):
//      > <the quote>
//      <the note>
//
// No notes (or no Reviewer): the text is exactly as before.
//
// Sent notes go: every ask would otherwise send the same notes again, and the Reviewer deletes a review's
// notes once its Discuss reached Claude, so these are removed the same way once this text reached Claude
// (`onNotesSent`, lib/notes.js createSentWatch, the service's `removeNotes`); a cut notes block, a send
// that never arrives or an older Reviewer keeps them.
//
// The notes' lines are the ones the page shows them on: the Reviewer numbers the file on disk, and the
// gutter's marks ride along with the person's edits (notes-editor.js), so a dirty buffer still matches the
// selection's line numbers. The page names each note by id with those lines; the words come from the
// host's own copy of the Reviewer's answer (lib/notes.js `current()`), never from the page.
//
// Protocol (page <-> host, beside lib/files.js's):
//   host -> page  { t: 'ask-context', req }                          onDiscuss wants the selection
//   page -> host  { t: 'ask-context', req, startLine, endLine, text, cut, notes? }   the main selection
//                 (notes: [{ id, from, to }] the file's notes, on the lines the page shows them)
// The path is the tab's own (its params, put there by this plugin); the page names no path. A page that
// does not answer within ANSWER_MS fails the ask, so the person sees an error rather than a question
// sent with no context.

/** The page's selection is cut to this many characters here, whatever it sent (src/page/ask.mjs cuts to the same first). */
const MAX_ASK_CHARS = 8000
/** The page must answer within this long: core waits 5 s for the whole onDiscuss. */
const ANSWER_MS = 3000
/**
 * Reading the tabs' prompts for a sent-notes watch may take this long; past it the text goes anyway
 * (core waits 5 s for the whole onDiscuss, the page up to ANSWER_MS of it).
 */
const SENT_READ_MS = 1000
/**
 * The whole context (the selection and its notes) stays under this. Core's Discuss sends at most 20,000
 * characters and cuts only the context: after `About: <title>` and the type line (at most about 600), the
 * person's question (at most 4,000) and their closing prompt (at most 2,000), each with its blank line, at
 * least 13,394 are left, so this is never cut there (a cut there would take the notes' end with no mark).
 */
const MAX_CONTEXT_CHARS = 13000
/** A note's quote as the Reviewer keeps it (its MAX_QUOTE); shortened first when the notes are too long, as the Reviewer does. */
const MAX_QUOTE = 500
/** At most this many notes from the page: the host's own list is bounded by the same number (lib/notes.js MAX_SHOWN_NOTES). */
const MAX_NOTES = 200
const MAX_LINE = 10000000
const NOTES_HEAD = 'Review notes on this file:'
/** After a note's lines when they overlap the asked ones, where the Reviewer writes a note's side (` (new)`). */
const ASKED_LABEL = ' (on the asked lines)'
/** The Reviewer's mark for a review cut to fit. */
const NOTES_CUT_MARK = '\n\n(review cut: too long)'

/** `text` on one line, for the header: a path may hold anything a file name can (newlines included). */
function oneLine(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .trim()
}

/** A 1-based line number the page sent, or undefined. */
function lineNumber(value) {
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

/** A fence for `text`: backticks, one more than its longest run, at least three. */
function fenceFor(text) {
  let longest = 0
  let run = 0
  for (const ch of text) {
    run = ch === '`' ? run + 1 : 0
    if (run > longest) longest = run
  }
  return '`'.repeat(Math.max(3, longest + 1))
}

/** `text` in a fence one backtick longer than any run in it (it cannot end the block early); one trailing newline dropped. */
function fenced(text) {
  const fence = fenceFor(text)
  return `${fence}\n${text.endsWith('\n') ? text.slice(0, -1) : text}\n${fence}`
}

/**
 * `text` cut to at most `max` UTF-16 units, never between the two halves of a surrogate pair: the
 * head is kept, or the tail (`keep: 'tail'`). A non-string is ''.
 */
function cutText(text, max, keep = 'head') {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  if (keep === 'tail') {
    let start = text.length - max
    const code = text.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start += 1
    return text.slice(start)
  }
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/** The Reviewer's quote block: trailing space dropped, cut at a word past `max` with ` …`, each line `   > `. */
function quoteBlock(quote, max) {
  let q = quote.replace(/\s+$/, '')
  if (q.length > max) q = q.slice(0, max).replace(/\s+\S*$/, '') + ' …'
  return q
    .split('\n')
    .map((l) => `   > ${l}`)
    .join('\n')
}

/**
 * The notes' block: NOTES_HEAD, then `notes` ([{ from, to, text, quote?, asked? }], in line order)
 * numbered as the Reviewer's message numbers a file review's (`1. Lines 2-4:`, ASKED_LABEL before the
 * colon for `asked`, the quote as `   > ` lines, the note indented under it), at most `max` characters:
 * quotes are shortened first (the person's words matter more than the text they point at, which Claude
 * can read), then the end is cut with the Reviewer's mark. Returns `{ text, cut }`.
 */
function notesBlock(notes, max) {
  const build = (quoteMax) => {
    const parts = [NOTES_HEAD]
    notes.forEach((n, i) => {
      const lines = n.from === n.to ? `Line ${n.from}` : `Lines ${n.from}-${n.to}`
      const q = quoteMax > 0 && typeof n.quote === 'string' && n.quote.trim() ? `\n${quoteBlock(n.quote, quoteMax)}` : ''
      parts.push(`${i + 1}. ${lines}${n.asked ? ASKED_LABEL : ''}:${q}\n   ${n.text.trim().replace(/\n/g, '\n   ')}`)
    })
    return parts.join('\n\n')
  }
  // The Reviewer's steps (buildMessage).
  for (const quoteMax of [MAX_QUOTE, 200, 80, 0]) {
    const text = build(quoteMax)
    if (text.length <= max) return { text, cut: false }
  }
  return { text: cutText(build(0), Math.max(0, max - NOTES_CUT_MARK.length)).trimEnd() + NOTES_CUT_MARK, cut: true }
}

/** Notes in line order (then by their end), the Reviewer's order. */
const byLine = (a, b) => a.from - b.from || a.to - b.to

/**
 * The page's note lines (`[{ id, from, to }]`, what it named) as a Map id -> { from, to }; anything
 * malformed is left out (that note keeps the Reviewer's own lines).
 */
function pageLines(list) {
  const out = new Map()
  if (!Array.isArray(list)) return out
  const line = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINE
  for (const n of list.slice(0, MAX_NOTES)) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !line(n.from) || !line(n.to) || n.to < n.from) continue
    out.set(n.id, { from: n.from, to: n.to })
  }
  return out
}

/**
 * The notes Ask Claude adds: every note of the host's list (`list`, the Reviewer's words) on the lines the
 * page shows it (a note the page did not name, or named badly, keeps the Reviewer's), `asked` when those
 * overlap the selection's lines (the page's answer `sel`), in line order.
 */
function askNotes(list, sel) {
  if (!Array.isArray(list) || !sel || typeof sel !== 'object') return []
  const start = lineNumber(sel.startLine)
  if (start === undefined) return []
  let end = lineNumber(sel.endLine)
  if (end === undefined || end < start) end = start
  const lines = pageLines(sel.notes)
  return list
    .map((n) => {
      const at = lines.get(n.id) || { from: n.from, to: n.to }
      return { ...n, ...at, asked: at.from <= end && at.to >= start }
    })
    .sort(byLine)
}

/**
 * The text Discuss gets for `file` and the page's selection `sel` ({ startLine, endLine, text, cut }),
 * or null when the page sent nothing usable. Throws nothing: a malformed answer is "no context".
 * `notes` ([{ from, to, text, quote, asked }], askNotes) follow the selection: at most MAX_ASK_CHARS of
 * them and what the selection left of MAX_CONTEXT_CHARS, cut with the Reviewer's mark past that.
 */
function contextText(file, sel, notes) {
  const r = askText(file, sel, notes)
  return r === null ? null : r.text
}

/**
 * contextText as `{ text, notesCut }`, or null: `notesCut` says not every note reached the text (cut, or
 * no room at all), so none of them may be removed as sent.
 */
function askText(file, sel, notes) {
  if (typeof file !== 'string' || file === '' || !sel || typeof sel !== 'object') return null
  const startLine = lineNumber(sel.startLine)
  if (startLine === undefined) return null
  let endLine = lineNumber(sel.endLine)
  if (endLine === undefined || endLine < startLine) endLine = startLine
  const name = oneLine(file)
  const headerFor = (end) => (end === startLine ? `${name}:${startLine}` : `${name}:${startLine}-${end}`)
  let text = typeof sel.text === 'string' ? sel.text : ''
  if (text === '') return withNotes(headerFor(endLine), notes)
  let cut = sel.cut === true
  if (text.length > MAX_ASK_CHARS) {
    text = cutText(text, MAX_ASK_CHARS)
    cut = true
    // The range follows the text actually sent, not the page's claim for the whole selection.
    let breaks = 0
    for (const ch of text) if (ch === '\n') breaks += 1
    endLine = Math.min(endLine, startLine + breaks)
  }
  const lines = [headerFor(endLine), fenced(text)]
  if (cut) lines.push(`(the selection was cut to its first ${text.length} characters)`)
  return withNotes(lines.join('\n'), notes)
}

/** `base` (the selection's context), then the notes' block in what MAX_CONTEXT_CHARS leaves: `{ text, notesCut }`. */
function withNotes(base, notes) {
  if (!Array.isArray(notes) || notes.length === 0) return { text: base, notesCut: false }
  const room = Math.min(MAX_ASK_CHARS, MAX_CONTEXT_CHARS - base.length - 2)
  // A path so long that no note would fit: the selection alone, and the notes stay (none was sent).
  if (room < NOTES_HEAD.length + NOTES_CUT_MARK.length + 40) return { text: base, notesCut: true }
  const block = notesBlock(notes, room)
  return { text: `${base}\n\n${block.text}`, notesCut: block.cut }
}

/** `p`, or undefined once `ms` passed or it failed (it is left to settle unseen). */
function settleWithin(p, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/**
 * Serves Ask Claude for one tab instance: registers its `onDiscuss` (an app without it, or a tab with
 * no file, has no Ask Claude) and returns the message handler `handle(m)` (true: it was ours).
 * `file` is the path shown to Claude (the tab's own). `notes()` is the Reviewer's list now
 * (lib/notes.js `current()`; null or absent: no notes, the text as before). `onNotesSent({ text, notes })`
 * is called when the text carries every note, before the answer goes back (so it can read the tabs'
 * prompts before Discuss sends); a failing one is ignored and a slow one not waited past SENT_READ_MS.
 */
function serveAsk(tab, { file, notes, onNotesSent, answerMs = ANSWER_MS }) {
  const waiting = new Map()
  let next = 0
  let closed = false
  tab.onClose(() => {
    closed = true
    for (const w of waiting.values()) {
      clearTimeout(w.timer)
      w.reject(new Error('the tab closed'))
    }
    waiting.clear()
  })
  if (typeof tab.onDiscuss === 'function' && typeof file === 'string' && file !== '') {
    tab.onDiscuss(() => {
      if (closed) return null
      const req = ++next
      const answer = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(req)
          reject(new Error('the editor page did not give its selection in time'))
        }, answerMs)
        if (typeof timer.unref === 'function') timer.unref()
        waiting.set(req, { resolve, reject, timer })
      })
      tab.post({ t: 'ask-context', req })
      return answer.then(async (sel) => {
        const list = typeof notes === 'function' ? notes() : null
        const sent = askNotes(list, sel)
        const r = askText(file, sel, sent)
        if (r === null) return null
        // A cut block did not give Claude every note, so none goes (the Reviewer keeps a cut review's draft).
        if (sent.length > 0 && !r.notesCut && typeof onNotesSent === 'function') {
          let call
          try {
            call = onNotesSent({ text: r.text, notes: sent })
          } catch {}
          await settleWithin(call, SENT_READ_MS)
        }
        return { text: r.text }
      })
    })
  }
  return function handle(m) {
    if (!m || typeof m !== 'object' || m.t !== 'ask-context') return false
    const w = waiting.get(m.req)
    if (w) {
      waiting.delete(m.req)
      clearTimeout(w.timer)
      w.resolve(m)
    }
    return true
  }
}

module.exports = { MAX_ASK_CHARS, MAX_CONTEXT_CHARS, askNotes, askText, contextText, cutText, fenced, fenceFor, oneLine, serveAsk }
