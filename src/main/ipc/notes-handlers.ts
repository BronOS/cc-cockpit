// The notes channels of a perView overlay copy (shared/design.md §3, spec-review S1-S4): `overlays.notes.read` and
// `overlays.notes.write`, which the shell sends for a page's `ccPanel.notes` calls (shared/overlay-envelope.ts).
//
// 00 contract: a stub that refuses every call (S2: no service = refused). Task 03 fills it, on these rules:
// - the caller's copy must be its own live copy of the overlay (`overlays.copyOwner(windowId, overlayId, copy)` equals
//   the bound view), and the overlay must have a notes key (`overlays.notesOf`: main's record of the key and opener);
//   the store is `(ctx.projectId, opener, key)`, never anything from the payload;
// - a write needs `authorOf(view)` (the owner, or a write guest with its name); a read guest is refused by GUEST_CLASS
//   and again here (no author); no `notes` dep: refused.
import type { NoteAuthor } from '../../shared/overlay-envelope'
import type { NotesApi } from '../notes/notes-api'
import type { OverlayManager } from '../overlays/overlay-manager'
import type { CallView, IpcRouter } from './router'

export interface NotesHandlerDeps {
  /** The Notes service (task 03); absent: every call is refused. */
  notes?: NotesApi
  overlays: Pick<OverlayManager, 'copyOwner' | 'notesOf'>
  /** Who a write by this call's view is by (S4): the owner, a write guest with its invite name; undefined refuses. */
  authorOf(view: CallView): NoteAuthor | undefined
}

/** The channels, for the stub and its test. */
export const NOTES_CHANNELS = ['overlays.notes.read', 'overlays.notes.write'] as const

export function registerNotesHandlers(router: IpcRouter, deps: NotesHandlerDeps): void {
  void deps
  for (const channel of NOTES_CHANNELS) {
    router.handleProject(channel, () => {
      throw new Error(`${channel}: refused (notes are not available in this build)`)
    })
  }
}
