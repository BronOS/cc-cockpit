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
//
// The host keeps the last list it read in full (`handle.current()`: texts uncut, quotes), for Ask Claude
// (lib/ask.js): the page names notes by id with the lines it shows them on, and the words Claude gets
// are the Reviewer's, never the page's hover copy.
//
// "Discuss review notes" hands the file's notes to Claude, as the Reviewer's Discuss hands over a review,
// and like that review they go once they reached Claude (createSentWatch below, the Reviewer's
// `removeNotes`). Ask Claude's notes are context for a question, not a review handed over: they stay.

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

/**
 * The Reviewer's answer as the host keeps it: id, lines, text and quote within the Reviewer's own caps, in a
 * bounded list; malformed entries dropped. The Reviewer never hands out a longer text, so its text is the
 * one `removeNotes` matches; another provider's longer one is cut here, then matches nothing and stays.
 */
function fullNotes(list) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const n of list) {
    if (out.length >= MAX_SHOWN_NOTES) break
    if (!n || typeof n !== 'object') continue
    const { from, to, text } = n
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < from || typeof text !== 'string' || !text.trim()) continue
    out.push({ id: typeof n.id === 'string' ? n.id.slice(0, 40) : String(out.length), from, to, text: text.slice(0, MAX_NOTE_TEXT), quote: typeof n.quote === 'string' ? n.quote.slice(0, MAX_QUOTE) : '' })
  }
  return out
}

/** The notes as the page needs them: id, lines, text (cut), in a bounded list; malformed entries dropped. */
function shownNotes(list) {
  return fullNotes(list).map(({ id, from, to, text }) => ({ id, from, to, text: text.length > MAX_SHOWN_CHARS ? `${text.slice(0, MAX_SHOWN_CHARS - 1)}…` : text }))
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
  /** The last list read in full (fullNotes), or null while there is no Reviewer to ask: Ask Claude's source. */
  let latest = null
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
    const r = await readNow()
    // Kept as the page will have them: the answer is posted right after, and a later read replaces both.
    latest = r.has ? r.full : null
    return r.has ? { has: true, notes: r.notes } : { has: false }
  }

  async function readNow() {
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
      return { has: true, notes: shownNotes(list), full: fullNotes(list) }
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

  function handle(m) {
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
  /** The last list read, in full ([{ id, from, to, text, quote }], lines the file on disk's), or null: no Reviewer answered. */
  handle.current = () => latest
  return handle
}

// ---- "Discuss review notes" delivered: the notes go (the Reviewer's rule for a sent review) ----

/** How much of the sent text's start must be in a tab's next prompt to count as delivered (the Reviewer's MATCH_CHARS). */
const MATCH_CHARS = 120
/**
 * How long a send is watched for. Core's Discuss for a page tab tells the plugin neither the tab it
 * went to nor whether it was queued (a busy tab takes it at the turn's end), so the watch looks at every
 * Claude tab's next prompt until this runs out; past it the notes simply stay, as for a send that never
 * happened (a refused target, a New session over its budget).
 */
const SENT_WATCH_MS = 60 * 60 * 1000
/** At most this many sends watched at once: the oldest gives way (its notes stay). */
const MAX_SENT_WATCHES = 10

/** A prompt with control characters and runs of whitespace made one space (the send gate strips controls; the Reviewer's promptText). */
const promptText = (s) =>
  String(s || '')
    .replace(/[\x00-\x1f\x7f\s]+/g, ' ')
    .trim()

/**
 * Watches the project's Claude tabs for the notes a Discuss sent, and asks the Reviewer to remove them
 * once one tab's prompt has the sent text's start in it: the Reviewer deletes a review's notes only when
 * all of it reached Claude (a queued one when the tab took it), so a send that failed or was lost keeps
 * them. A prompt counts only when it changed since the send (`watch` reads every tab's prompt first, before
 * Discuss sends), so the same notes sent earlier are not taken for this delivery. No match within
 * SENT_WATCH_MS: the notes stay. `removeNotes` keeps a note edited since (id and text must still match).
 *
 * `sessions` is ctx.sessions (list, onChange), `reviewer()` the service handle now or null. Returns
 * `{ watch({ rel, text, notes }), dispose() }`; `watch` resolves once the prompts were read.
 */
function createSentWatch({ sessions, reviewer, log, maxMs = SENT_WATCH_MS, max = MAX_SENT_WATCHES }) {
  const live = new Set()
  const usable = !!sessions && typeof sessions.list === 'function' && typeof sessions.onChange === 'function'

  async function remove(rel, notes) {
    const svc = reviewer()
    if (!svc) return
    try {
      const r = await within(svc.removeNotes(rel, notes), REVIEWER_CALL_TIMEOUT_MS, 'the Reviewer did not answer in time')
      if (log && typeof log.info === 'function') log.info(`notes ${rel}: ${r && Number.isSafeInteger(r.removed) ? r.removed : 0} sent to Claude, removed`)
    } catch (e) {
      // An older Reviewer (no removeNotes), its review open now: the notes stay, as they would have.
      if (log) log.warn(`notes ${rel}: not removed after the send: ${e && e.message ? e.message : e}`)
    }
  }

  async function watch({ rel, text, notes }) {
    if (!usable || typeof rel !== 'string' || typeof text !== 'string' || !Array.isArray(notes) || notes.length === 0) return
    const want = promptText(text).slice(0, MATCH_CHARS)
    if (!want) return
    const before = new Map()
    try {
      for (const s of await sessions.list()) if (s && typeof s.tabId === 'string') before.set(s.tabId, s.lastPrompt)
    } catch (e) {
      // Without the prompts as they were, an earlier send of the same notes would count: nothing is watched.
      if (log) log.warn(`sessions.list: ${e && e.message ? e.message : e}`)
      return
    }
    const refs = notes.map((n) => ({ id: n.id, text: n.text }))
    const w = { stop: null, timer: null }
    const end = () => {
      if (!live.delete(w)) return false
      clearTimeout(w.timer)
      try {
        if (w.stop) w.stop()
      } catch {}
      return true
    }
    w.end = end
    const check = (list) => {
      if (!Array.isArray(list)) return
      for (const s of list) {
        if (!s || typeof s.lastPrompt !== 'string' || s.lastPrompt === before.get(s.tabId)) continue
        if (!promptText(s.lastPrompt).includes(want)) continue
        if (end()) remove(rel, refs)
        return
      }
    }
    while (live.size >= max) [...live][0].end()
    live.add(w)
    w.timer = setTimeout(end, maxMs)
    if (typeof w.timer.unref === 'function') w.timer.unref()
    try {
      w.stop = sessions.onChange(check)
      // A listener that matched while it was being added (called at once) ended before it had its disposer.
      if (!live.has(w) && typeof w.stop === 'function') w.stop()
    } catch (e) {
      end()
      if (log) log.warn(`sessions.onChange: ${e && e.message ? e.message : e}`)
    }
  }

  return {
    watch,
    /** The sends still watched (tests). */
    size: () => live.size,
    dispose() {
      for (const w of [...live]) w.end()
    },
  }
}

module.exports = { MAX_SHOWN_CHARS, MAX_SHOWN_NOTES, REVIEWER_CALL_TIMEOUT_MS, SENT_WATCH_MS, createSentWatch, fullNotes, promptText, serveNotes, shownNotes, within }
