// The notes channels of a perView overlay copy (shared/design.md §3, spec-review S1-S4): `overlays.notes.read` and
// `overlays.notes.write`, which the shell sends for a page's `ccPanel.notes` calls (shared/overlay-envelope.ts).
//
// Main decides everything from what it bound, never from the payload:
// - the caller's copy must be its own live copy of the overlay (`overlays.copyOwner(windowId, overlayId, copy)` equals
//   the bound view: a released, replaced or another view's copy is refused), and the overlay must have a notes key
//   (`overlays.notesOf`, main's record of the key and the opener). The store is `(ctx.projectId, opener, key)`;
// - a write needs `authorOf(view)` (the owner, or a write guest with its name). A read guest is refused by GUEST_CLASS
//   and again here (a guest whose access is not write, or has none bound, never writes: fail closed);
// - no `notes` service: every call is refused (S2).
// GUEST_CLASS has let a read guest's `read` through only for an overlay it sees (`byOverlay`); its copy being live
// (copyOwner) means main admitted it (mayConnectCopy, via).
import type { NoteAuthor } from '../../shared/overlay-envelope'
import type { NoteInput, NotesApi } from '../notes/notes-api'
import type { OverlayManager } from '../overlays/overlay-manager'
import { isOwner, type CallView, type IpcRouter, type ProjectContext } from './router'

export interface NotesHandlerDeps {
  /** The Notes service (task 03); absent: every call is refused. */
  notes?: NotesApi
  overlays: Pick<OverlayManager, 'copyOwner' | 'notesOf'>
  /** Who a write by this call's view is by (S4): the owner, a write guest with its invite name; undefined refuses. */
  authorOf(view: CallView): NoteAuthor | undefined
}

/** The channels, for the stub and its test. */
export const NOTES_CHANNELS = ['overlays.notes.read', 'overlays.notes.write'] as const

function str(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}

export function registerNotesHandlers(router: IpcRouter, deps: NotesHandlerDeps): void {
  /** The store the caller's own live copy names, or a throw. */
  function storeOf(channel: string, ctx: ProjectContext, payload: unknown, view: CallView): { notes: NotesApi; pluginId: string; key: string } {
    const notes = deps.notes
    if (!notes) throw new Error(`${channel}: refused (notes are not available in this build)`)
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>
    if (!str(p.overlayId) || !str(p.copy)) throw new Error(`${channel}: refused (no overlay copy)`)
    // The copy is the caller's own and live: a page cannot act through another view's copy or a retired one.
    if (deps.overlays.copyOwner(ctx.windowId, p.overlayId, p.copy) !== view.viewId) throw new Error(`${channel}: refused (not your copy)`)
    const of = deps.overlays.notesOf(ctx.windowId, p.overlayId)
    if (!of) throw new Error(`${channel}: refused (this overlay has no notes)`)
    return { notes, pluginId: of.pluginId, key: of.key }
  }

  router.handleProject('overlays.notes.read', (ctx, payload, view) => {
    const { notes, pluginId, key } = storeOf('overlays.notes.read', ctx, payload, view)
    return notes.list(ctx.projectId, pluginId, key)
  })

  router.handleProject('overlays.notes.write', (ctx, payload, view) => {
    const channel = 'overlays.notes.write'
    const { notes, pluginId, key } = storeOf(channel, ctx, payload, view)
    // A write guest only, by the access the router bound for this call (fail closed: none bound refuses); then the
    // author, main's word (S4).
    if (!isOwner(view) && view.access?.role !== 'write') throw new Error(`${channel}: refused (read only)`)
    const author = deps.authorOf(view)
    if (!author) throw new Error(`${channel}: refused (read only)`)
    const p = payload as Record<string, unknown>
    switch (p.op) {
      case 'add': {
        // Only these fields: an `id` or `author` the page put in is never read.
        const input: NoteInput = { quote: p.quote as string, anchor: p.anchor, text: p.text as string }
        return notes.add(ctx.projectId, pluginId, key, input, author)
      }
      case 'change':
        if (typeof p.id !== 'string') throw new Error(`${channel}: refused (no note id)`)
        return notes.change(ctx.projectId, pluginId, key, p.id, p.text as string)
      case 'remove':
        if (typeof p.id !== 'string') throw new Error(`${channel}: refused (no note id)`)
        return notes.remove(ctx.projectId, pluginId, key, p.id)
      case 'setGlobal':
        return notes.setGlobal(ctx.projectId, pluginId, key, p.text as string)
      default:
        throw new Error(`${channel}: refused (unknown op)`)
    }
  })
}
