// The Notes API's seam in main (shared/design.md §3, spec-review S2-S4; 00 contract), implemented by notes-service.ts
// over notes-store.ts. A caller given no service refuses (S2: no dep = refused): the handlers (ipc/notes-handlers.ts),
// host-api's `notes.*`.
//
// A store is per (project, plugin, key). The key is the overlay spec's `notes.key` as the opener gave it; the plugin is
// main's record of the opener (OverlayManager.notesOf), or the host's own plugin for `ctx.notes(key)`, never a payload.
import type { NoteAuthor, NotesSnapshot, NoteWriteResult } from '../../shared/overlay-envelope'
import type { CopyEvent, OverlayManager } from '../overlays/overlay-manager'
import { NotesService } from './notes-service'

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
  /**
   * Refused past a cap (shared/notes-limits.ts), never cut. `author` is main's word (S4), never the caller's.
   * `recheck` (every write): runs once the write's turn in the store's queue came and the file is loaded, right before
   * the change; it throws to refuse. A page's write re-checks its caller there (review S-2d).
   */
  add(projectId: string, pluginId: string, key: string, input: NoteInput, author: NoteAuthor, recheck?: () => void): Promise<NoteWriteResult>
  /** Any writer may change any note; its author stays the first writer's (S4). Bumps the note's `rev`. */
  change(projectId: string, pluginId: string, key: string, id: string, text: string, recheck?: () => void): Promise<NoteWriteResult>
  remove(projectId: string, pluginId: string, key: string, id: string, recheck?: () => void): Promise<NoteWriteResult>
  /** The note for Claude ('' clears it). */
  setGlobal(projectId: string, pluginId: string, key: string, text: string, recheck?: () => void): Promise<NoteWriteResult>
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
  /**
   * Discuss's removal once its send is delivered (task 03, S3): the notes still at the id and rev they had when the
   * text was composed, and the note for Claude while it is still the sent text. Absent: nothing is removed.
   */
  removeSent?(projectId: string, pluginId: string, key: string, sent: SentNotes): Promise<void>
}

/** What a Discuss text carried of a key's notes (S3): each note's id and rev, and the note for Claude as sent. */
export interface SentNotes {
  global: string
  notes: { id: string; rev: number }[]
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

/** The Notes service (notes-service.ts). */
export function createNotesApi(deps: NotesApiDeps): NotesApi | undefined {
  return new NotesService(deps)
}
