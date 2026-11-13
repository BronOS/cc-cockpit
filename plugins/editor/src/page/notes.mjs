// The Reviewer's notes, the page's half (design-editor.md §4 "Review notes in place"): the notes of this
// file as the host (lib/notes.js, through the public `reviewer` service) hands them over, and the asks
// the page makes: the file's notes, and one more note. Pure of the DOM and CodeMirror, so node:test runs
// it; notes-editor.js draws the gutter.
//
// `has` is false until the host says the Reviewer answered (no Reviewer, an older one: no marks, and the
// context menu hides "Add review note"). The host also pushes the list when the Reviewer says a file's
// notes changed (a request number 0); the asks below only cover what a push cannot: the page's first
// load and reconnect, the tab getting the keyboard back, and a slow poll for a Reviewer that came or
// went after the page loaded.

/** A timer tick asks again when the last ask is older than this. */
export const POLL_MS = 5000
/** Getting the tab or the window back asks again unless the last ask is this recent. */
export const FOCUS_MIN_MS = 1000

/**
 * `ui`:
 *   post(message)              to the host (ccPanel.post)
 *   onNotes()                  `available()` or `list()` changed: redraw the marks
 *   onAdded(ok, message?)      the answer to `add`
 * `timers` { now() } (tests pass a fake clock).
 */
export function createNotes(ui, timers = { now: () => Date.now() }) {
  let has = false
  /** [{ id, from, to, text }]: lines as the Reviewer holds them (the file on disk). */
  let list = []
  let nextReq = 0
  let waiting = 0
  let adding = 0
  let lastAsk = -Infinity

  function ask(connect) {
    lastAsk = timers.now()
    waiting = ++nextReq
    ui.post({ t: 'notes-get', req: waiting, ...(connect ? { connect: true } : {}) })
  }

  const same = (a, b) => a.length === b.length && a.every((n, i) => n.id === b[i].id && n.from === b[i].from && n.to === b[i].to && n.text === b[i].text)

  return {
    /** The Reviewer answered: a "Add review note" makes sense. */
    available: () => has,
    list: () => list,
    /** A new line to the host: its answer to an older ask never comes, and the event listener is made again. */
    connect() {
      // An add on its way died with the old line: its answer never comes.
      if (adding) {
        adding = 0
        ui.onAdded(false, 'The connection was lost before the note was saved: check the Reviewer, then add it again.')
      }
      ask(true)
    },
    focus() {
      if (timers.now() - lastAsk >= FOCUS_MIN_MS) ask(false)
    },
    poll() {
      if (timers.now() - lastAsk >= POLL_MS) ask(false)
    },
    /**
     * Adds a note: `{ from, to, text, quote }`, lines 1-based. Resolves through `onAdded`; one add at a time
     * (a second while one is on its way is refused: false).
     */
    add(note) {
      if (adding) return false
      adding = ++nextReq
      ui.post({ t: 'notes-add', req: adding, from: note.from, to: note.to, text: note.text, quote: note.quote })
      return true
    },
    /** True when `m` is ours. */
    receive(m) {
      if (!m || typeof m !== 'object') return false
      if (m.t === 'notes-added') {
        // An answer to an add this page no longer waits for (a reconnect dropped it): ignored.
        if (!adding || m.req !== adding) return true
        adding = 0
        ui.onAdded(m.ok === true, typeof m.message === 'string' ? m.message : undefined)
        return true
      }
      if (m.t !== 'notes') return false
      // A pushed list (req 0) always counts; an answer counts only when it is to the newest ask.
      if (m.req !== 0 && m.req !== waiting) return true
      if (m.req !== 0) waiting = 0
      const nextHas = m.has === true
      const next = nextHas && Array.isArray(m.notes) ? m.notes.filter((n) => n && Number.isSafeInteger(n.from) && n.from >= 1 && Number.isSafeInteger(n.to) && n.to >= n.from && typeof n.text === 'string') : []
      if (nextHas === has && same(next, list)) return true
      has = nextHas
      list = next
      ui.onNotes()
      return true
    },
  }
}
