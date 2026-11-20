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
