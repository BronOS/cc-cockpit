// A merge's open conflicts in the editor (design-editor.md §2), with no DOM: the state field that tracks
// each region through edits and the transaction that resolves one or all of them. file.js gives the
// field its decorations (Claude's version as a block widget with the buttons, mine marked below), so
// the rules that decide whether the person's typing survives a resolve are tested on a bare
// EditorState (test/page-conflicts.test.mjs): this is the surface where a wrong mapping loses text.
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration } from '@codemirror/view'
import { keepBothText } from './merge.mjs'

/** The merge's conflicts, [{ id, from, to, theirs }], replaced as a whole. */
export const setConflicts = StateEffect.define()
/** One conflict resolved (its id). */
export const dropConflict = StateEffect.define()

/**
 * Each region mapped through a change: text typed at either edge joins it (from maps backward, to
 * forward), so a region never loses the person's typing. A region ending at a line start (its text ends
 * with a newline) must not take in what is typed at the start of the next line: Take Claude's would
 * delete it (an earlier bug), so that end maps backward.
 */
export function mapConflicts(list, changes, oldDoc) {
  return list.map((c) => ({
    ...c,
    from: changes.mapPos(c.from, -1),
    to: changes.mapPos(c.to, c.to > c.from && oldDoc.sliceString(c.to - 1, c.to) === '\n' ? -1 : 1),
  }))
}

/**
 * The conflict field: `{ list, deco }`, with `decorate(list, doc)` building the DecorationSet (file.js
 * passes its widgets; a test passes `() => Decoration.none`). `provide` hands `deco` to the view.
 */
export function conflictField(decorate, provide) {
  return StateField.define({
    create: () => ({ list: [], deco: Decoration.none }),
    update(value, tr) {
      let list = value.list
      if (tr.docChanged && list.length) list = mapConflicts(list, tr.changes, tr.startState.doc)
      for (const e of tr.effects) {
        if (e.is(setConflicts)) list = e.value
        else if (e.is(dropConflict)) list = list.filter((c) => c.id !== e.value)
      }
      if (list === value.list) return value
      return { list, deco: decorate(list, tr.state.doc) }
    },
    provide,
  })
}

/**
 * The transaction spec that resolves conflict `id` (or every one, id null) as 'mine', 'theirs' or
 * 'both', or null when there is no such conflict. Mine keeps the text and drops the region; theirs
 * replaces my region with Claude's; both appends Claude's after mine (keepBothText).
 * The person's own choice: an edit like typing (dirty, undoable), never a replace the page makes.
 */
export function resolveSpec(state, field, id, how) {
  const list = state.field(field).list
  const targets = id === null ? list : list.filter((c) => c.id === id)
  if (!targets.length) return null
  const changes = []
  for (const c of targets) {
    const mine = state.doc.sliceString(c.from, c.to)
    if (how === 'theirs') changes.push({ from: c.from, to: c.to, insert: c.theirs })
    else if (how === 'both') changes.push({ from: c.to, insert: keepBothText(mine, c.theirs).slice(mine.length) })
  }
  const effects = id === null ? setConflicts.of([]) : dropConflict.of(id)
  return { changes, effects, userEvent: 'input.resolve' }
}
