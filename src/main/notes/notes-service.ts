// The Notes service in main (shared/design.md §3, spec-review S2-S4): implements notes-api.ts's NotesApi over
// notes-store.ts. Main is the authority: a page or a host only asks.
//
// - Caps (shared/notes-limits.ts) refuse a write, never cut it: a silently shortened note is worse than an error.
// - Ids are minted here; the author is the caller's word only in the sense that main's handler read it from the view it
//   bound (S4: `ViewRegistry.whoOf` + the guest's invite name) or the host's own plugin; a page's never reaches here.
// - Every write bumps the key's `rev` and the service-wide `seq` (the page's ordering of a `list` reply against the
//   pushes, shared/overlay-envelope.ts), then pushes the key's whole state to every live copy of the key's overlays in
//   the project's window through `postEnvelope`, which applies main's admission rule (mayConnectCopy, via) itself.
// - Discuss removes the notes it sent once the send is delivered (`removeSent`): only those still at the id and rev
//   they had when the text was composed, and the note for Claude only while it is the text that was sent (S3).
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  isNotesKey,
  MAX_GLOBAL_NOTE,
  MAX_NOTE_ANCHOR_JSON,
  MAX_NOTE_QUOTE,
  MAX_NOTE_TEXT,
  MAX_NOTES,
  MAX_NOTES_JSON,
  MAX_NOTES_KEYS
} from '../../shared/notes-limits'
import {
  ENVELOPE_VERSION,
  type EnvelopePush,
  type NoteAuthor,
  type NotesSnapshot,
  type NotesState,
  type NoteWriteResult,
  type OverlayNote
} from '../../shared/overlay-envelope'
import type { NoteInput, NotesApi, NotesApiDeps, NotesChange, SentNotes } from './notes-api'
import { NotesStore } from './notes-store'

const EMPTY: NotesState = { global: '', notes: [], rev: 0 }

/** Thousands with a comma, for the refusal texts ("at most 4,000 characters"). */
function n(value: number): string {
  return value.toLocaleString('en-US')
}

function checkText(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') throw new Error(`Not saved: ${what} must be text`)
  if (value.length > max) throw new Error(`Not saved: ${what} is at most ${n(max)} characters`)
  return value
}

/** The author as main gave it, re-checked (fail closed: anything else refuses the write). */
function checkAuthor(author: unknown): NoteAuthor {
  if (typeof author === 'object' && author !== null) {
    const a = author as Record<string, unknown>
    if (a.plugin === true) return { plugin: true }
    if ((a.access === 'owner' || a.access === 'write') && (a.person === undefined || typeof a.person === 'string')) {
      return a.person === undefined ? { access: a.access } : { access: a.access, person: a.person as string }
    }
  }
  throw new Error('Not saved: no author')
}

function checkAnchor(anchor: unknown): unknown {
  let json: string | undefined
  try {
    json = JSON.stringify(anchor ?? null)
  } catch {
    throw new Error('Not saved: the anchor is not plain JSON')
  }
  if (json === undefined || json.length > MAX_NOTE_ANCHOR_JSON) {
    throw new Error(`Not saved: the anchor is at most ${n(MAX_NOTE_ANCHOR_JSON)} characters of JSON`)
  }
  return JSON.parse(json) as unknown
}

function checkKey(pluginId: string, key: string): void {
  if (typeof pluginId !== 'string' || pluginId === '') throw new Error('notes: no plugin')
  if (!isNotesKey(key)) throw new Error('notes: not a notes key')
}

export class NotesService implements NotesApi {
  private readonly store: NotesStore
  private seq = 0
  private readonly listeners = new Set<(change: NotesChange) => void>()

  constructor(private readonly deps: NotesApiDeps) {
    this.store = new NotesStore(join(deps.dataDir, 'notes'), deps.log)
  }

  list(projectId: string, pluginId: string, key: string): Promise<NotesSnapshot> {
    return this.store.serial(async () => {
      checkKey(pluginId, key)
      const state = (await this.store.load(projectId, pluginId)).get(key) ?? EMPTY
      return { ...structuredClone(state), seq: this.seq }
    })
  }

  add(projectId: string, pluginId: string, key: string, input: NoteInput, author: NoteAuthor, recheck?: () => void): Promise<NoteWriteResult> {
    return this.write(projectId, pluginId, key, recheck, (state, isNew, keyCount) => {
      const i = (typeof input === 'object' && input !== null ? input : {}) as Partial<NoteInput>
      const quote = checkText(i.quote ?? '', MAX_NOTE_QUOTE, 'a quote')
      const text = checkText(i.text ?? '', MAX_NOTE_TEXT, 'a note')
      const anchor = checkAnchor(i.anchor)
      const by = checkAuthor(author)
      if (isNew && keyCount >= MAX_NOTES_KEYS) throw new Error(`Not saved: this plugin keeps notes on at most ${n(MAX_NOTES_KEYS)} documents in a project`)
      if (state.notes.length >= MAX_NOTES) throw new Error(`Not saved: at most ${n(MAX_NOTES)} notes on one document`)
      const note: OverlayNote = { id: randomUUID(), quote, anchor, text, rev: 1, author: by }
      return { state: { ...state, notes: [...state.notes, note] }, note }
    })
  }

  change(projectId: string, pluginId: string, key: string, id: string, text: string, recheck?: () => void): Promise<NoteWriteResult> {
    return this.write(projectId, pluginId, key, recheck, (state) => {
      const next = checkText(text, MAX_NOTE_TEXT, 'a note')
      const old = state.notes.find((note) => note.id === id)
      if (!old) throw new Error('Not saved: that note is gone')
      // The first writer stays the author (S4): any writer may change any note.
      const note: OverlayNote = { ...old, text: next, rev: old.rev + 1 }
      return { state: { ...state, notes: state.notes.map((x) => (x.id === id ? note : x)) }, note }
    })
  }

  remove(projectId: string, pluginId: string, key: string, id: string, recheck?: () => void): Promise<NoteWriteResult> {
    return this.write(projectId, pluginId, key, recheck, (state) => {
      if (!state.notes.some((note) => note.id === id)) throw new Error('Not removed: that note is gone')
      return { state: { ...state, notes: state.notes.filter((note) => note.id !== id) } }
    })
  }

  setGlobal(projectId: string, pluginId: string, key: string, text: string, recheck?: () => void): Promise<NoteWriteResult> {
    return this.write(projectId, pluginId, key, recheck, (state, isNew, keyCount) => {
      const global = checkText(text, MAX_GLOBAL_NOTE, 'the note for Claude')
      if (isNew && global !== '' && keyCount >= MAX_NOTES_KEYS) {
        throw new Error(`Not saved: this plugin keeps notes on at most ${n(MAX_NOTES_KEYS)} documents in a project`)
      }
      return { state: { ...state, global } }
    })
  }

  /**
   * After a delivered Discuss (S3): remove the sent notes still at their sent `rev`, and clear the note for Claude when
   * it is still the sent text. A note changed, or a note for Claude rewritten, while the send waited stays. Nothing
   * left to remove: no write and no push.
   */
  removeSent(projectId: string, pluginId: string, key: string, sent: SentNotes): Promise<void> {
    return this.store
      .serial(async () => {
        checkKey(pluginId, key)
        const file = await this.store.load(projectId, pluginId)
        const state = file.get(key)
        if (!state) return
        const was = new Set(sent.notes.map((x) => `${x.id}\0${x.rev}`))
        const notes = state.notes.filter((note) => !was.has(`${note.id}\0${note.rev}`))
        const global = sent.global !== '' && state.global === sent.global ? '' : state.global
        if (notes.length === state.notes.length && global === state.global) return
        await this.commit(projectId, pluginId, key, file, state, { global, notes, rev: state.rev + 1 })
      })
      .then(() => undefined)
  }

  onChange(listener: (change: NotesChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  removePlugin(pluginId: string): void {
    void this.store.serial(() => this.store.removePlugin(pluginId)).catch((err) => this.deps.log(`notes: dropping ${pluginId}'s notes failed: ${String(err)}`))
  }

  dropProject(projectId: string): void {
    void this.store.serial(() => this.store.dropProject(projectId)).catch((err) => this.deps.log(`notes: dropping project ${projectId}'s notes failed: ${String(err)}`))
  }

  /** Wait for every queued operation (tests, and a caller that must see a removal done). */
  idle(): Promise<void> {
    return this.store.serial(async () => undefined)
  }

  /**
   * One write: `change` computes the next state from the current one (or throws the refusal), checked whole here.
   * `recheck` runs after the last await before the commit (the queue and the load) and throws to refuse: a write that
   * waited behind others must not land for a caller whose rights changed meanwhile (review S-2d).
   */
  private write(
    projectId: string,
    pluginId: string,
    key: string,
    recheck: (() => void) | undefined,
    change: (state: NotesState, isNew: boolean, keyCount: number) => { state: NotesState; note?: OverlayNote }
  ): Promise<NoteWriteResult> {
    return this.store.serial(async () => {
      checkKey(pluginId, key)
      const file = await this.store.load(projectId, pluginId)
      // Nothing awaits between this check and the commit's file update below.
      recheck?.()
      const prev = file.get(key)
      const next = change(prev ?? EMPTY, prev === undefined, file.size)
      const state: NotesState = { ...next.state, rev: (prev?.rev ?? 0) + 1 }
      if (JSON.stringify(state).length > MAX_NOTES_JSON) {
        throw new Error(`Not saved: one document's notes are at most ${n(MAX_NOTES_JSON)} characters in all`)
      }
      await this.commit(projectId, pluginId, key, file, prev, state)
      return next.note ? { note: structuredClone(next.note), seq: this.seq } : { seq: this.seq }
    })
  }

  /** Store `state` (an empty one deletes the key), then count and push. A failed save leaves the old state. */
  private async commit(
    projectId: string,
    pluginId: string,
    key: string,
    file: Map<string, NotesState>,
    prev: NotesState | undefined,
    state: NotesState
  ): Promise<void> {
    const empty = state.notes.length === 0 && state.global === ''
    if (empty) file.delete(key)
    else file.set(key, state)
    try {
      await this.store.save(projectId, pluginId, file)
    } catch (err) {
      if (prev === undefined) file.delete(key)
      else file.set(key, prev)
      this.deps.log(`notes: saving ${pluginId}'s notes failed: ${String(err)}`)
      throw new Error('Not saved: the notes could not be written', { cause: err })
    }
    this.seq += 1
    this.push(projectId, pluginId, key, empty ? { ...EMPTY, rev: state.rev } : state)
  }

  /** The key's whole state to each live copy of its overlays in the project's window (main's admission applies there). */
  private push(projectId: string, pluginId: string, key: string, state: NotesState): void {
    const seq = this.seq
    const windowId = this.deps.windowOfProject(projectId)
    if (windowId !== undefined) {
      const push: EnvelopePush<'notes'> = { $cc: ENVELOPE_VERSION, ev: 'notes', seq, data: { type: 'state', state } }
      const text = JSON.stringify(push)
      const { overlays } = this.deps
      for (const overlayId of overlays.overlaysWithNotes(windowId, pluginId, key)) {
        for (const { copy } of overlays.copiesOf(windowId, overlayId)) {
          try {
            overlays.postEnvelope(windowId, overlayId, copy, text)
          } catch (err) {
            this.deps.log(`notes: a push to overlay ${overlayId} failed: ${String(err)}`)
          }
        }
      }
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({ projectId, pluginId, key, seq })
      } catch (err) {
        this.deps.log(`notes: a change listener threw: ${String(err)}`)
      }
    }
  }
}
