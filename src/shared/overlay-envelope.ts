// The envelope on a perView overlay copy's own port (shared/design.md §3-§5, spec-review S1, design-parts.md §7).
//
// A leaf with no imports: main, the shell, the plugin host and panel.js all read it (as overlay-message.ts). panel.js
// is its own IIFE build (electron.vite.config.ts), so a module it shares with main is inlined there, never a chunk.
//
// The port carries JSON texts. The page SDK sends a request; the shell answers it on the same port (after its invoke
// of main's `overlays.notes.*` / `overlays.ask.*` channel, or after the Discuss popover for `discuss.open`):
//
//   page -> shell   {"$cc": 1, "id": <n>, "op": <EnvelopeOp>, "args": {...}}
//   shell -> page   {"$cc": 1, "re": <n>, "ok": true, "value": ...}  |  {"$cc": 1, "re": <n>, "ok": false, "error": "..."}
//   main -> page    {"$cc": 1, "ev": "notes" | "ask", "seq": <n>, "data": {...}}     (a push)
//
// A refused invoke (guest class, not perView, a cap) answers `ok: false`, never hangs. Pushes ride the
// `overlays.message` event with `envelope: true` (main's mark): a message the opener's host posted never carries it, and
// `$cc` is reserved, so a plugin cannot fake core's answers or pushes to its own page (ccPanel.post throws on a top-level
// `$cc`, handle.post and host-api refuse one, the shell refuses one coming up as a plain page message).
//
// Before the port, the shell sends a copy's frame the intro (OVERLAY_INTRO_MESSAGE): which of notes, Ask and
// page-started Discuss this copy has. Without it `ccPanel.notes` and `ccPanel.ask` stay undefined.

/** The reserved top-level key of every envelope. */
export const ENVELOPE_KEY = '$cc'
/** The envelope's version, the value of ENVELOPE_KEY. */
export const ENVELOPE_VERSION = 1

/** A page request with no answer by then is rejected in the page (the shell answers every request it got). */
export const ENVELOPE_REQUEST_TIMEOUT_MS = 30_000
/** Requests a page may have outstanding; one more rejects at once with a RangeError. */
export const MAX_OUTSTANDING_ENVELOPES = 50

/** The intro's `type` (frame-messages.ts's `cc-plugin.*` family), sent by the shell before the copy's port. */
export const OVERLAY_INTRO_MESSAGE = 'cc-plugin.overlay'

/**
 * What this copy has: `notes` (the overlay has a notes key), `ask` (the same, and the view may Ask: never a read guest),
 * `discuss` (the toolbar shows Discuss: page-started Discuss opens its popover). A part's intro is all false.
 */
export interface OverlayIntroFeatures {
  notes: boolean
  ask: boolean
  discuss: boolean
}

export interface OverlayIntro {
  type: typeof OVERLAY_INTRO_MESSAGE
  overlay: OverlayIntroFeatures
}

/** The ops a page may send. `discuss.open` is the shell's alone (the popover); the others become main's channels. */
export type EnvelopeOp =
  | 'notes.list'
  | 'notes.add'
  | 'notes.change'
  | 'notes.remove'
  | 'notes.setGlobal'
  | 'ask.start'
  | 'ask.say'
  | 'ask.close'
  | 'ask.pick'
  | 'ask.continue'
  | 'discuss.open'

export const ENVELOPE_OPS: readonly EnvelopeOp[] = [
  'notes.list',
  'notes.add',
  'notes.change',
  'notes.remove',
  'notes.setGlobal',
  'ask.start',
  'ask.say',
  'ask.close',
  'ask.pick',
  'ask.continue',
  'discuss.open'
]

/** Each op's `args` (the shell adds `overlayId` and `copy` from its own record, never the page's). */
export interface EnvelopeArgs {
  'notes.list': Record<string, never>
  'notes.add': { quote: string; anchor: unknown; text: string }
  'notes.change': { id: string; text: string }
  'notes.remove': { id: string }
  'notes.setGlobal': { text: string }
  'ask.start': { question: string; quote?: string }
  'ask.say': { question: string; quote?: string }
  'ask.close': Record<string, never>
  'ask.pick': { model?: string; effort?: string }
  'ask.continue': Record<string, never>
  'discuss.open': Record<string, never>
}

/** Each op's `value` in an `ok: true` answer. */
export interface EnvelopeValues {
  'notes.list': NotesSnapshot
  'notes.add': NoteWriteResult
  'notes.change': NoteWriteResult
  'notes.remove': NoteWriteResult
  'notes.setGlobal': NoteWriteResult
  'ask.start': null
  'ask.say': null
  'ask.close': null
  'ask.pick': AskPickState
  'ask.continue': { tabId: string }
  'discuss.open': null
}

export interface EnvelopeRequest<O extends EnvelopeOp = EnvelopeOp> {
  $cc: typeof ENVELOPE_VERSION
  id: number
  op: O
  args: EnvelopeArgs[O]
}

export type EnvelopeAnswer =
  | { $cc: typeof ENVELOPE_VERSION; re: number; ok: true; value: unknown }
  | { $cc: typeof ENVELOPE_VERSION; re: number; ok: false; error: string }

export interface EnvelopePush<E extends 'notes' | 'ask' = 'notes' | 'ask'> {
  $cc: typeof ENVELOPE_VERSION
  ev: E
  /**
   * Per (overlay, copy) for `ask`; store-wide for `notes` (the `notes.list` answer carries it too, and the page drops
   * a notes push whose `seq` is not above the list's).
   */
  seq: number
  data: E extends 'notes' ? NotesPush : AskPush
}

// ---- notes (the same shapes as sdk/types.ts's, which plugin hosts get; that file is standalone by design) ----

/** Who wrote a note, read by main at write time: never the page's word (S4). The owner has no `person`. */
export type NoteAuthor = { access: 'owner' | 'write'; person?: string } | { plugin: true }

export interface OverlayNote {
  /** Minted by main. */
  id: string
  quote: string
  /** Opaque JSON only the page reads (at most MAX_NOTE_ANCHOR_JSON characters). */
  anchor: unknown
  text: string
  /** Bumped by every change; Discuss removes a sent note only when its id and rev are unchanged (S3). */
  rev: number
  author: NoteAuthor
}

export interface NotesState {
  /** The note for Claude ('' for none). */
  global: string
  notes: OverlayNote[]
  /** Bumped by every write to the key. */
  rev: number
}

/** `notes.list`'s answer: the state and the store-wide push counter it reflects. */
export interface NotesSnapshot extends NotesState {
  seq: number
}

/** A write's answer: the note it made or changed (none for remove and setGlobal), and the push counter after it. */
export interface NoteWriteResult {
  note?: OverlayNote
  seq: number
}

/** A notes push: the key's whole state after a write (under MAX_NOTES_JSON, so one message). */
export interface NotesPush {
  type: 'state'
  state: NotesState
}

// ---- Ask ----

/** The chat's phase (the editor quick chat's, quick-chat.js:61). */
export type AskPhase = 'starting' | 'thinking' | 'ready'

/** One stored turn (main's copy, restored on connect, design-parts.md §7). */
export interface AskTurn {
  question: string
  quote?: string
  answer: string
  /** The turn ended with an error (timed out, crashed, refused): its text. */
  error?: string
}

/** The model and effort lists (session-options.ts) and this chat's pick. Absent pick: the person's default. */
export interface AskPickState {
  model?: string
  effort?: string
  models: readonly string[]
  efforts: readonly string[]
}

/**
 * An Ask push, to the asking copy only (the owner's chat to every owner copy showing it, design-parts.md §7):
 * - `history`: on a copy's connect, the key's stored turns (main's copy), the pick and where it was continued.
 * - `state`: the phase changed.
 * - `delta`: answer text as it is written (appended to the open turn).
 * - `tool`: Claude used a tool (name and a short detail; never the tool's output).
 * - `answer`: the turn ended; `text` is the whole answer (cut at ASK_MAX_ANSWER).
 * - `end`: the chat's process is over (idle, refused, crashed, closed, continued in a tab); the stored turns stay.
 */
export type AskPush =
  | { type: 'history'; turns: AskTurn[]; pick: AskPickState; continuedIn?: string }
  | { type: 'state'; phase: AskPhase; model?: string; effort?: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; detail?: string }
  | { type: 'answer'; text: string; error?: string }
  | { type: 'end'; message: string; error: boolean }

/** A parsed JSON value is an envelope (any direction): a plain object whose ENVELOPE_KEY is ENVELOPE_VERSION. */
export function isEnvelope(value: unknown): value is { $cc: typeof ENVELOPE_VERSION } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as Record<string, unknown>)[ENVELOPE_KEY] === ENVELOPE_VERSION
}

/** A value carries the reserved key at its top level at all (any value): what plain posts must never do. */
export function hasEnvelopeKey(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, ENVELOPE_KEY)
}

// ---- Host RPC of parts and announcements (design-parts.md; spec-review S12) ------------------------------------
// Names and payloads only, frozen here for tasks 05 (host) and 14 (main); nothing sends them in this build. The host
// never knows an overlay's id for its own handle, so it names the handle; main resolves it to the overlay.

/** host → main call: `handle.announce({ kind, refs })`. */
export const HOST_OVERLAY_ANNOUNCE = 'overlay.announce'
/** main → host event: an overlay of the window announced (to every plugin with an `onAnnounce` of the kind). */
export const HOST_OVERLAY_ANNOUNCED = 'overlay.announced'
/** main → host event: an announced overlay closed, or announced something else (its last announcement is void). */
export const HOST_OVERLAY_UNANNOUNCED = 'overlay.unannounced'

/** The `overlay.announce` call's params (host → main). */
export interface OverlayAnnounceCall {
  pluginId: string
  handle: string
  kind: string
  refs: string[]
}

/** The `overlay.announced` event's params (main → host): main's own record of the overlay, never the opener's. */
export interface OverlayAnnouncedEvent {
  overlay: { id: string; opener: string; title: string; type?: { name: string; data: unknown } }
  kind: string
  refs: string[]
}

/** The `overlay.unannounced` event's params (main → host). */
export interface OverlayUnannouncedEvent {
  id: string
}
