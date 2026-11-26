// ctx.notes(key) (shared/design.md §3, spec-review S2): the notes the plugin's overlays opened with `notes: { key }`
// keep, in this project. Main owns the store (main/notes/, the Notes service): one writer for every window and view,
// and Discuss, which main composes, removes the sent notes there. So each method is one RPC; main checks the plugin
// (one its host runs: HostApi's `plugin()`), the project (the host's own scope, never a payload), the key and the caps
// again. The checks here are the same shared ones (shared/notes-limits.ts), run first so a bad call fails at the call
// site without a round trip.
//
// RPC (host -> main), each with `{ pluginId, key }`:
//   notes.list                               -> NotesSnapshot (state + seq; the seq is dropped here)
//   notes.add       { quote, anchor, text }  -> NoteWriteResult (its `note`)
//   notes.change    { id, text }             -> NoteWriteResult (its `note`)
//   notes.remove    { id }                   -> NoteWriteResult
//   notes.setGlobal { text }                 -> NoteWriteResult
// and the event main -> host `notes.changed { pluginId, key }` after any write to a key of a plugin this host runs:
// the plugin's `onChange` listeners of that key run (with nothing: they list again). A note this host adds is marked
// as the plugin's (`{ plugin: true }`) by main, never by this code.
import type { Disposer, JsonValue, NotesState, OverlayNote, PluginNotes } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { isNotesKey, MAX_GLOBAL_NOTE, MAX_NOTE_ANCHOR_JSON, MAX_NOTE_QUOTE, MAX_NOTE_TEXT } from '../../shared/notes-limits'

/** Host RPC names (frozen by the 00 contract: `notes.*`). */
export const NOTES_LIST = 'notes.list'
export const NOTES_ADD = 'notes.add'
export const NOTES_CHANGE = 'notes.change'
export const NOTES_REMOVE = 'notes.remove'
export const NOTES_SET_GLOBAL = 'notes.setGlobal'
/** Event main -> host after a write to a key of one of this host's plugins. */
export const NOTES_CHANGED = 'notes.changed'
/** A note id main mints is short; anything past this names no note (refused here, as main would). */
const MAX_NOTE_ID = 100

export interface NotesApiDeps {
  pluginId: string
  call(method: string, params: unknown): Promise<unknown>
  /** Rejects once the plugin is deactivated, and turns a synchronous throw into a rejection. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  alive(): void
  listeners: NotesListeners
}

/**
 * The `onChange` listeners of every plugin of this host, by plugin and key; main's `notes.changed` runs them. A
 * listener that throws is logged in its plugin's log and the next still runs.
 */
export class NotesListeners {
  private readonly byKey = new Map<string, Set<() => void>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  add(pluginId: string, key: string, listener: () => void): Disposer {
    const k = `${pluginId}\n${key}`
    const set = this.byKey.get(k) ?? new Set()
    // Wrapped: the same function added twice is two listeners, each with its disposer.
    const entry = (): void => listener()
    set.add(entry)
    this.byKey.set(k, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.byKey.get(k) === set) this.byKey.delete(k)
    }
  }

  /** main's `notes.changed { pluginId, key }`; anything malformed is dropped. */
  handleEvent(params: unknown): void {
    const { pluginId, key } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || !isNotesKey(key)) return
    for (const listener of [...(this.byKey.get(`${pluginId}\n${key}`) ?? [])]) {
      try {
        listener()
      } catch (err) {
        this.log(pluginId, `a ctx.notes onChange listener threw: ${errorText(err)}`)
      }
    }
  }

  /** The plugin's ctx ended: its listeners go. */
  removePlugin(pluginId: string): void {
    const prefix = `${pluginId}\n`
    for (const k of [...this.byKey.keys()]) if (k.startsWith(prefix)) this.byKey.delete(k)
  }
}

function checkText(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`ctx.notes ${what} must be a string`)
  if (value.length > max) throw new RangeError(`ctx.notes ${what}: ${value.length} characters exceeds ${max}`)
  return value
}

function checkId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_NOTE_ID) throw new TypeError('ctx.notes: id must be the id of a note')
  return value
}

/** The anchor as JSON within its cap; absent is null. */
function checkAnchor(anchor: unknown): JsonValue {
  if (anchor === undefined) return null
  let text: string | undefined
  try {
    text = JSON.stringify(anchor)
  } catch (err) {
    throw new TypeError(`ctx.notes add: anchor is not JSON: ${errorText(err)}`, { cause: err })
  }
  if (text === undefined) throw new TypeError('ctx.notes add: anchor is not JSON')
  if (text.length > MAX_NOTE_ANCHOR_JSON) throw new RangeError(`ctx.notes add: anchor of ${text.length} characters of JSON exceeds ${MAX_NOTE_ANCHOR_JSON}`)
  return anchor as JsonValue
}

/** The state out of main's answer (the snapshot's `seq` is the page's business). */
function stateOf(raw: unknown): NotesState {
  const { global, notes, rev } = (raw ?? {}) as Record<string, unknown>
  if (typeof global !== 'string' || !Array.isArray(notes) || typeof rev !== 'number') throw new Error('ctx.notes list: the app answered no notes state')
  return { global, notes: notes as OverlayNote[], rev }
}

function noteOf(raw: unknown, what: string): OverlayNote {
  const note = (raw as { note?: unknown } | null)?.note
  if (typeof note !== 'object' || note === null) throw new Error(`ctx.notes ${what}: the app answered no note`)
  return note as OverlayNote
}

/** `ctx.notes`: a function of the key, each call its own frozen object. */
export function createNotesApi(deps: NotesApiDeps): (key: string) => PluginNotes {
  const { pluginId, call, guardAsync, alive, listeners } = deps
  return (key: string): PluginNotes => {
    alive()
    if (!isNotesKey(key)) {
      throw new TypeError('ctx.notes: key must be 1 to 200 characters of A-Z a-z 0-9 . _ : @ # + = ~ / -')
    }
    // `pluginId` is this plugin's own; main refuses an id its host does not run and takes the project from the host.
    const ask = (method: string, params: Record<string, unknown>): Promise<unknown> => call(method, { pluginId, key, ...params })
    return Object.freeze({
      list: (): Promise<NotesState> => guardAsync(async () => stateOf(await ask(NOTES_LIST, {}))),
      add: (note: { quote: string; anchor?: JsonValue; text: string }): Promise<OverlayNote> =>
        guardAsync(async () => {
          if (typeof note !== 'object' || note === null) throw new TypeError('ctx.notes add needs { quote, anchor?, text }')
          const quote = checkText(note.quote, MAX_NOTE_QUOTE, 'add: quote')
          const text = checkText(note.text, MAX_NOTE_TEXT, 'add: text')
          const anchor = checkAnchor(note.anchor)
          return noteOf(await ask(NOTES_ADD, { quote, anchor, text }), 'add')
        }),
      change: (id: string, patch: { text: string }): Promise<OverlayNote> =>
        guardAsync(async () => {
          const noteId = checkId(id)
          if (typeof patch !== 'object' || patch === null) throw new TypeError('ctx.notes change needs { text }')
          const text = checkText(patch.text, MAX_NOTE_TEXT, 'change: text')
          return noteOf(await ask(NOTES_CHANGE, { id: noteId, text }), 'change')
        }),
      remove: (id: string): Promise<void> =>
        guardAsync(async () => {
          await ask(NOTES_REMOVE, { id: checkId(id) })
        }),
      setGlobal: (text: string): Promise<void> =>
        guardAsync(async () => {
          await ask(NOTES_SET_GLOBAL, { text: checkText(text, MAX_GLOBAL_NOTE, 'setGlobal: text') })
        }),
      onChange: (listener: () => void): Disposer => {
        alive()
        if (typeof listener !== 'function') throw new TypeError('ctx.notes onChange needs a function')
        return listeners.add(pluginId, key, listener)
      }
    })
  }
}
