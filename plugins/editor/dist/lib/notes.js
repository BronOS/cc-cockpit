'use strict'
// The Reviewer's notes in the gutter, the host's half (design-editor.md §4 "Review notes in place"):
// the public `reviewer` service (v1, feature 'notes'): `notes(path)` and `addNote(path, note)`, and the
// service event `notesChange` { path }. The service is the project's own pick, resolved on every call
// (never a handle kept across calls), and its store is the one the Reviewer's overlay uses: nothing
// here keeps a note.
//
// Only the tab's own path (its params, put there by this plugin) is ever asked about; the page names no
// path. What the page names for `notes-add` (lines, text, quote) is capped here once more and checked
// again by the Reviewer, which is the one that stores it.
//
// No Reviewer (not installed, disabled, an app without services, an older one with no `notes`): the page
// gets `has: false`, draws no marks and offers no "Add review note". Not an error the person must see.
//
// Protocol (page <-> host, beside lib/files.js's):
//   page -> host  { t: 'notes-get', req, connect? }       the file's notes (`connect`: the page's new line, subscribe again)
//   host -> page  { t: 'notes', req, has, notes? }        has: false: no marks and no add; else [{ id, from, to, text }]
//                                                          (req 0: pushed on the event `notesChange`)
//   page -> host  { t: 'notes-add', req, from, to, text, quote }
//   host -> page  { t: 'notes-added', req, ok, message? } the answer; on success a fresh `notes` follows

/** A note's text is cut to this many characters for the hover: the page shows it, it never edits it. */
const MAX_SHOWN_CHARS = 2000
/** What the page may send as a note: the Reviewer's own caps (its MAX_NOTE_TEXT and MAX_QUOTE), checked here before the call. */
const MAX_NOTE_TEXT = 4000
const MAX_QUOTE = 500
const MAX_LINE = 10000000
/** The Reviewer's answer is bounded by its draft cap (200 notes); more than this is never passed on. */
const MAX_SHOWN_NOTES = 200
/**
 * How long a Reviewer call may take: a plain service call has no deadline of its own
 * (src/host/services.ts), and a hung Reviewer must not leave the page waiting (no `has: false`) nor
 * pile up one pending call per poll for the tab's life.
 */
const NOTES_TIMEOUT_MS = 5 * 1000
const REVIEWER_CALL_TIMEOUT_MS = 10 * 1000

/**
 * `p` (a service call's promise) bounded by `ms`: rejects with `message` when it has not settled by
 * then, calling `onLate()` first. The call itself cannot be taken back; it settles (or not) unseen.
 */
function within(p, ms, message, onLate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (onLate) onLate()
      reject(new Error(message))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** The notes as the page needs them: id, lines, text (cut), in a bounded list; malformed entries dropped. */
function shownNotes(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const n of list) {
    if (out.length >= MAX_SHOWN_NOTES) break
    if (!n || typeof n !== 'object') continue
    const { from, to, text } = n
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < from || typeof text !== 'string' || !text.trim()) continue
    out.push({ id: typeof n.id === 'string' ? n.id.slice(0, 40) : String(out.length), from, to, text: text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS - 1)}…` : text })
  }
  return out
}

/** The page's `notes-add` as the Reviewer's note, or an Error with a sentence for the person. */
function noteOf(m) {
  const line = (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_LINE
  if (!line(m.from)) throw new Error('the note has no valid line')
  const to = m.to === undefined ? m.from : m.to
  if (!line(to) || to < m.from) throw new Error('the note has no valid line range')
  if (typeof m.text !== 'string' || !m.text.trim()) throw new Error('the note is empty')
  if (m.text.length > MAX_NOTE_TEXT) throw new Error(`the note is over ${MAX_NOTE_TEXT} characters`)
  const quote = typeof m.quote === 'string' ? m.quote.slice(0, MAX_QUOTE) : ''
  return { from: m.from, to, text: m.text, quote }
}

/**
 * Serves `notes-get` and `notes-add` for one tab instance and pushes `notes` when the Reviewer says
 * `notesChange` for this file. `rel` is the tab's own project-relative path (undefined: a tab with none, a
 * file outside the project: no notes). `reviewer()` returns the service handle now or null (called on every
 * use: the provider can come and go). Returns `handle(m)`: true when it took the message.
 */
function serveNotes(tab, { rel, reviewer, log, timeoutMs = NOTES_TIMEOUT_MS, addTimeoutMs = REVIEWER_CALL_TIMEOUT_MS }) {
  let closed = false
  let unsubscribe = null
  /** A `notes` call that outlived its deadline and has not settled: no new one is made while it hangs. */
  let stuck = null
  const post = (m) => {
    if (!closed) tab.post(m)
  }
  const stopListening = () => {
    if (!unsubscribe) return
    try {
      unsubscribe()
    } catch {
      // The registry already dropped it (a reload of the Reviewer).
    }
    unsubscribe = null
  }
  tab.onClose(() => {
    closed = true
    stopListening()
  })

  /** The file's notes now: `{ has: false }` for every way of "there is no Reviewer to ask". */
  async function read() {
    if (typeof rel !== 'string') return { has: false }
    // A hung Reviewer is asked again only once its last call settled: at most one call left behind.
    if (stuck) return { has: false }
    const svc = reviewer()
    if (!svc) return { has: false }
    try {
      const call = Promise.resolve(svc.notes(rel))
      const unstick = () => {
        if (stuck === call) stuck = null
      }
      const list = await within(call, timeoutMs, 'the Reviewer did not answer in time', () => {
        stuck = call
        call.then(unstick, unstick)
      })
      return { has: true, notes: shownNotes(list) }
    } catch (e) {
      // An older Reviewer ("has no method"), one that failed to activate, a path it refuses: no marks.
      // Logged at debug level only: this is asked every few seconds.
      if (log && typeof log.debug === 'function') log.debug(`notes ${rel}: ${e && e.message ? e.message : e}`)
      return { has: false }
    }
  }

  /** Listens for `notesChange` of this file (once per line; a reconnect listens again, since a reload of the Reviewer drops listeners). */
  function listen() {
    stopListening()
    const svc = reviewer()
    if (!svc || typeof svc.on !== 'function') return
    try {
      unsubscribe = svc.on('notesChange', (data) => {
        if (closed || !data || typeof data !== 'object' || data.path !== rel) return
        read().then((r) => post({ t: 'notes', req: 0, ...r }))
      })
    } catch (e) {
      if (log) log.warn(`notes: cannot listen: ${e.message}`)
    }
  }

  return function handle(m) {
    if (!m || typeof m !== 'object') return false
    if (m.t === 'notes-get') {
      const req = m.req
      if (m.connect === true || unsubscribe === null) listen()
      read().then((r) => post({ t: 'notes', req, ...r }))
      return true
    }
    if (m.t === 'notes-add') {
      const req = m.req
      const fail = (message) => post({ t: 'notes-added', req, ok: false, message })
      if (typeof rel !== 'string') return fail('this file is not in the project'), true
      let note
      try {
        note = noteOf(m)
      } catch (e) {
        return fail(e.message), true
      }
      const svc = reviewer()
      if (!svc) return fail('no Reviewer plugin is available'), true
      let call
      try {
        call = svc.addNote(rel, note)
      } catch (e) {
        call = Promise.reject(e)
      }
      within(call, addTimeoutMs, 'the Reviewer did not answer in time (the note may still be added)').then(
        () => {
          post({ t: 'notes-added', req, ok: true })
          read().then((r) => post({ t: 'notes', req: 0, ...r }))
        },
        (e) => {
          const text = e && e.message ? String(e.message) : String(e)
          // An older Reviewer has no addNote: the person is told so, not shown the service's own wording.
          fail(/has no method/.test(text) ? 'this Reviewer is too old to take notes from the editor' : text.replace(/^reviewer: /, ''))
        },
      )
      return true
    }
    return false
  }
}

module.exports = { MAX_SHOWN_CHARS, MAX_SHOWN_NOTES, REVIEWER_CALL_TIMEOUT_MS, serveNotes, shownNotes, within }
