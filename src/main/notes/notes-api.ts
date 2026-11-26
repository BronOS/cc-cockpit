// The Notes API's seam in main (shared/design.md §3, spec-review S2-S4; 00 contract). Frozen here; task 03 implements
// it (notes-store.ts, notes-service.ts) and replaces createNotesApi's body. Until then there is no service, and every
// path that would use it refuses (S2: no dep = refused): the handlers (ipc/notes-handlers.ts), host-api's `notes.*`.
//
// A store is per (project, plugin, key). The key is the overlay spec's `notes.key` as the opener gave it; the plugin is
// main's record of the opener (OverlayManager.notesOf), or the host's own plugin for `ctx.notes(key)`, never a payload.
import type { NoteAuthor, NotesSnapshot, NoteWriteResult } from '../../shared/overlay-envelope'
import type { CopyEvent, OverlayManager } from '../overlays/overlay-manager'

/** A new note as a page or host gives it; main mints the id and reads the author. */
export interface NoteInput {
  quote: string
  /** Opaque JSON only the page reads (MAX_NOTE_ANCHOR_JSON). */
  anchor: unknown
  text: string
}

/** A key's store changed: `seq` is the store-wide push counter after the write (shared/overlay-envelope.ts). */
export interface NotesChange {
  projectId: string
  pluginId: string
  key: string
  seq: number
}

export interface NotesApi {
  list(projectId: string, pluginId: string, key: string): Promise<NotesSnapshot>
  /** Refused past a cap (shared/notes-limits.ts), never cut. `author` is main's word (S4), never the caller's. */
  add(projectId: string, pluginId: string, key: string, input: NoteInput, author: NoteAuthor): Promise<NoteWriteResult>
  /** Any writer may change any note; its author stays the first writer's (S4). Bumps the note's `rev`. */
  change(projectId: string, pluginId: string, key: string, id: string, text: string): Promise<NoteWriteResult>
  remove(projectId: string, pluginId: string, key: string, id: string): Promise<NoteWriteResult>
  /** The note for Claude ('' clears it). */
  setGlobal(projectId: string, pluginId: string, key: string, text: string): Promise<NoteWriteResult>
  /**
   * After every write (a page's, a host's, Discuss's removal of sent notes): the service pushes the new state to each
   * live copy of the key's overlays itself (OverlayManager.overlaysWithNotes, postEnvelope); this is for the host's
   * `notes.changed {pluginId, key}` event (host-api, task 05). Returns the disposer.
   */
  onChange(listener: (change: NotesChange) => void): () => void
  /** Uninstall: every project's stores of the plugin (installer.ts). */
  removePlugin(pluginId: string): void
  /** Project forget: every store of the project (ProjectRegistry onForget, index.ts). */
  dropProject(projectId: string): void
}

/** What the service gets from main (wired once in index.ts). Task 03 may ask the lead for more. */
export interface NotesApiDeps {
  dataDir: string
  log: (message: string) => void
  overlays: Pick<OverlayManager, 'overlaysWithNotes' | 'copiesOf' | 'postEnvelope' | 'onCopyEnd'>
  /** The project's open window (one per project), or undefined when it is closed. Main's own table. */
  windowOfProject(projectId: string): number | undefined
}

/** Re-exported for the service's copy listeners. */
export type { CopyEvent }

/** The Notes service, or undefined while there is none (00: every caller then refuses). Task 03 fills it. */
export function createNotesApi(deps: NotesApiDeps): NotesApi | undefined {
  void deps
  return undefined
}
