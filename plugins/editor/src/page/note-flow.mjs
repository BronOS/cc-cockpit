// A review note typed in the page: saved first (the Reviewer reads the file on disk, so the lines must
// match it), then sent through `notes.add`. Pure of the DOM, so node:test runs it; file.js owns the box.
//
// The person's text is never dropped here: the box stays open (file.js) until `settle(true)`, and every
// failure comes back as `settle(false, message)` with the text still in the box. The lines were taken
// from the buffer at submit; if that buffer changed before the save was confirmed (typing above them,
// a change merged in from disk) the lines may point elsewhere, so the note is refused, not moved.

/**
 * `deps`:
 *   view()          the file session's view ({ dirty, status, conflict, error, readOnly })
 *   saveNow()       starts a save; false when nothing was sent (a conflict is open, no connection)
 *   getDoc()        the editor's document, compared by identity (immutable: a change makes a new one)
 *   add(note)       notes.add: false while another add is on its way
 *   settle(ok, message?)  the outcome, once per submit
 */
export function createNoteFlow(deps) {
  /** null: idle; else { note, doc, phase: 'saving' | 'sent' } */
  let state = null

  function end(ok, message) {
    state = null
    deps.settle(ok, message)
  }

  function send() {
    state.phase = 'sent'
    if (!deps.add(state.note)) end(false, 'another note is still being saved.')
  }

  return {
    busy: () => state !== null,
    /** The box's Add: a refusal text, or null when the note is on its way (the outcome comes through `settle`). */
    submit(note) {
      if (state) return 'The last note is still being saved.'
      state = { note, doc: deps.getDoc(), phase: 'saving' }
      if (deps.view().dirty) {
        if (!deps.saveNow()) end(false, 'the file could not be saved first.')
      } else {
        send()
      }
      return null
    },
    /** The session rendered: a note waiting for its save goes, or is dropped with the reason. */
    onView(v) {
      if (!state || state.phase !== 'saving') return
      if (deps.getDoc() !== state.doc) end(false, 'the file changed while it was being saved, so the lines may have moved: add the note again.')
      else if (v.conflict || v.error || v.readOnly) end(false, 'the file could not be saved first.')
      else if (v.status === 'saved' && !v.dirty) send()
    },
    /** The answer to the add (or the connection that lost it). */
    added(ok, message) {
      if (state && state.phase === 'sent') end(ok, message)
      else deps.settle(ok, message)
    },
    /** The box's Cancel while the save is pending: the note is dropped (a sent one still reports its outcome). */
    cancel() {
      if (state && state.phase === 'saving') state = null
    },
  }
}
