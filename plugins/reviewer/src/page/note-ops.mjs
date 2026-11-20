// The page's side of the shared notes (design-overlay-views §6, D-3): the draft is the host's, so the page
// sends note ops and takes the other copies' changes, never a whole draft. A note the page adds has no id
// until the host answers: it carries a page-local `tag` (also its `id` meanwhile, so the page's own maps
// keyed by id work), and a change or delete sent before the answer names the tag, which the host resolves
// within this copy only. The host's answer (`note-added`) gives the note its id and, for a guest, its author.
// Pure functions over the draft's notes array, tested under node (test/note-ops.test.js).

/** A new page-local tag: `~` never starts a host id (n…, e…, or a number), so the two cannot collide. */
export const tagOf = (seq) => `~${seq}`

/** Whether `note` is still waiting for the host's id. */
export const isPending = (note) => typeof note.tag === 'string' && note.id === note.tag

/** The add op of a new local note: its fields without id, tag or author (the host sets those). */
export function addOp(note) {
  const { id, tag, author, ...fields } = note
  return { type: 'note-add', tag, note: fields }
}

/** The op naming `note` for a change or delete: by the host's id, or by its tag while that is pending. */
function ref(note) {
  return isPending(note) ? { tag: note.tag } : { id: note.id }
}

export const changeOp = (note) => ({ type: 'note-change', ...ref(note), text: note.text })
export const deleteOp = (note) => ({ type: 'note-delete', ...ref(note) })

/**
 * The host's answer to this page's add: the note with `tag` takes the host's id (and author). The text
 * stays the page's own (the person may have typed since; those changes went out by the tag). Returns
 * { note, oldId }, or null when the note is gone (deleted before the answer came: the delete went out by
 * its tag too).
 */
export function ackAdd(notes, tag, hostNote) {
  const n = notes.find((x) => x.tag === tag && isPending(x))
  if (!n || !hostNote || typeof hostNote.id !== 'string') return null
  const oldId = n.id
  n.id = hostNote.id
  delete n.tag
  if (typeof hostNote.author === 'string') n.author = hostNote.author
  return { note: n, oldId }
}

/**
 * Another copy's note (added or changed, as the host stores it): put in place by id. Returns 'added' when
 * it is new here, 'changed' when only its text differs, null when nothing changed.
 */
export function upsertNote(notes, note) {
  if (!note || typeof note.id !== 'string') return null
  const at = notes.findIndex((n) => n.id === note.id)
  if (at < 0) {
    notes.push({ ...note })
    return 'added'
  }
  if (notes[at].text === note.text) return null
  notes[at].text = note.text
  return 'changed'
}

/** Another copy deleted note `id`: gone here too. True when it was here. */
export function removeNote(notes, id) {
  const at = notes.findIndex((n) => n.id === id)
  if (at < 0) return false
  notes.splice(at, 1)
  return true
}

/** The host refused this page's add (`draft-error` with its tag): the local note goes. True when it was here. */
export function dropTagged(notes, tag) {
  const at = notes.findIndex((n) => n.tag === tag && isPending(n))
  if (at < 0) return false
  notes.splice(at, 1)
  return true
}

/** The page's size check of its draft: the error text when the draft's JSON is over `max`, else ''. */
export function draftSizeError(draft, max) {
  const size = JSON.stringify(draft).length
  return size > max ? `Draft not saved: it is too large (${size} of ${max} characters). Shorten or delete a note; the last saved draft is kept.` : ''
}

/**
 * How one copy converges with the others (last writer wins at the host). Kept apart from the DOM so the
 * interleavings are tested under node (test/note-ops.test.js); review.js draws what these return.
 * - `inflight` (note object -> count) and `globalInflight`: text ops this page sent that the host has not
 *   acked. While one is out, another copy's text for it is older than this page's (the host applies this
 *   page's after it) and is not taken.
 * - `deletedHere`: ids deleted on this page; another copy's late edit does not bring one back.
 * - `unsent`: texts held back while the draft was over the size cap (note objects; 'global' for the comment).
 */
export class NoteSync {
  constructor() {
    this.inflight = new Map()
    this.globalInflight = 0
    this.deletedHere = new Set()
    this.unsent = new Set()
  }

  /** A fresh init: nothing is out any more (the host's draft is the page's). */
  reset() {
    this.inflight.clear()
    this.globalInflight = 0
  }

  sentChange(n) {
    this.inflight.set(n, (this.inflight.get(n) || 0) + 1)
  }

  sentGlobal() {
    this.globalInflight++
  }

  /** This page deleted note `n`. */
  deleted(n) {
    this.unsent.delete(n)
    this.deletedHere.add(n.id)
  }

  /** The host's ack of one text op: `{ global: true }` or `{ id }`. */
  ack(notes, m) {
    if (m.global === true) {
      this.globalInflight = Math.max(0, this.globalInflight - 1)
      return
    }
    const n = typeof m.id === 'string' ? notes.find((x) => x.id === m.id) : null
    if (!n) return
    if (this.inflight.get(n) > 1) this.inflight.set(n, this.inflight.get(n) - 1)
    else this.inflight.delete(n)
  }

  /** Another copy's note: 'added', 'changed' or null (nothing to draw: unchanged, deleted here, or this page's text is newer). */
  remoteNote(notes, note) {
    if (!note || this.deletedHere.has(note.id)) return null
    const mine = notes.find((x) => x.id === note.id)
    if (mine && this.inflight.get(mine)) return null
    return upsertNote(notes, note)
  }

  /** Another copy deleted note `id`: gone here, and so is any text of it held back. True when it was here. */
  remoteDelete(notes, id) {
    const n = notes.find((x) => x.id === id)
    if (!n) return false
    this.unsent.delete(n)
    this.inflight.delete(n)
    return removeNote(notes, id)
  }

  /** Another copy's comment: taken unless this page's own is on its way. True when taken. */
  remoteGlobal(draft, text) {
    if (typeof text !== 'string' || this.globalInflight) return false
    draft.global = text
    this.unsent.delete('global')
    return true
  }
}

/**
 * After an add's ack moved a note from its tag (`oldId`) to the host's id: the page's located ranges
 * (Map id -> range) follow it, and the focused note id is returned as it now is.
 */
export function remapNoteId(located, focused, oldId, newId) {
  if (located.has(oldId)) {
    located.set(newId, located.get(oldId))
    located.delete(oldId)
  }
  return focused === oldId ? newId : focused
}
