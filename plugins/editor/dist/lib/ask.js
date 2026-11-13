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
// Protocol (page <-> host, beside lib/files.js's):
//   host -> page  { t: 'ask-context', req }                          onDiscuss wants the selection
//   page -> host  { t: 'ask-context', req, startLine, endLine, text, cut }   the main selection
// The path is the tab's own (its params, put there by this plugin); the page names no path. A page that
// does not answer within ANSWER_MS fails the ask, so the person sees an error rather than a question
// sent with no context.

/** The page's selection is cut to this many characters here, whatever it sent (src/page/ask.mjs cuts to the same first). */
const MAX_ASK_CHARS = 8000
/** The page must answer within this long: core waits 5 s for the whole onDiscuss. */
const ANSWER_MS = 3000

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

/**
 * The text Discuss gets for `file` and the page's selection `sel` ({ startLine, endLine, text, cut }),
 * or null when the page sent nothing usable. Throws nothing: a malformed answer is "no context".
 */
function contextText(file, sel) {
  if (typeof file !== 'string' || file === '' || !sel || typeof sel !== 'object') return null
  const startLine = lineNumber(sel.startLine)
  if (startLine === undefined) return null
  let endLine = lineNumber(sel.endLine)
  if (endLine === undefined || endLine < startLine) endLine = startLine
  const name = oneLine(file)
  const headerFor = (end) => (end === startLine ? `${name}:${startLine}` : `${name}:${startLine}-${end}`)
  let text = typeof sel.text === 'string' ? sel.text : ''
  if (text === '') return headerFor(endLine)
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
  return lines.join('\n')
}

/**
 * Serves Ask Claude for one tab instance: registers its `onDiscuss` (an app without it, or a tab with
 * no file, has no Ask Claude) and returns the message handler `handle(m)` (true: it was ours).
 * `file` is the path shown to Claude (the tab's own).
 */
function serveAsk(tab, { file, answerMs = ANSWER_MS }) {
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
      return answer.then((sel) => {
        const text = contextText(file, sel)
        return text === null ? null : { text }
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

module.exports = { MAX_ASK_CHARS, contextText, cutText, fenced, fenceFor, oneLine, serveAsk }
