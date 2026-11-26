// The page side of a perView overlay copy's envelope (shared/overlay-envelope.ts; shared/design.md §3-§5, spec-review
// S1): `ccPanel.notes`, `ccPanel.ask` and `ccPanel.overlay.discuss`. DOM-free like panel-core.ts, which owns one of
// these and hands it the port's traffic; bundled into out/sdk/panel.js (its imports are leaves, inlined there).
//
// The shell tells a copy's frame what it has with the intro (`cc-plugin.overlay`, before the port). Without it (a
// panel, a slot, a page tab, a non-perView overlay, an older app) nothing here exists, and the page's `ccPanel.notes`
// and `ccPanel.ask` stay undefined: feature-detect them at use time, as they appear with the copy's connection.
//
// Requests go up the copy's port as `{"$cc":1, id, op, args}` and the shell answers each one on the same port
// (`{"$cc":1, re, ok, value | error}`), after main or the Discuss popover decided: never more than
// MAX_OUTSTANDING_ENVELOPES at once, each rejected after ENVELOPE_REQUEST_TIMEOUT_MS. Main's pushes come down as
// `{"$cc":1, ev, seq, data}`. Nothing here is a check: main refuses by the view it bound (a read guest's write, a
// guest's continue, a cap). The caps below only refuse early, at the call, with the cap named.
import { ASK_MAX_QUESTION, ASK_MAX_QUOTE } from '../shared/ask'
import { MAX_GLOBAL_NOTE, MAX_NOTE_ANCHOR_JSON, MAX_NOTE_QUOTE, MAX_NOTE_TEXT } from '../shared/notes-limits'
import {
  ENVELOPE_KEY,
  ENVELOPE_REQUEST_TIMEOUT_MS,
  ENVELOPE_VERSION,
  MAX_OUTSTANDING_ENVELOPES,
  type AskPickState,
  type AskPush,
  type EnvelopeOp,
  type NotesSnapshot,
  type NotesState,
  type NoteWriteResult,
  type OverlayIntroFeatures
} from '../shared/overlay-envelope'

/** A note id or a model/effort name past this names nothing (main mints short ids; the lists are short words). */
const MAX_ID_LENGTH = 100

/** `ccPanel.notes`: the overlay's notes (its `notes: { key }`), shared by every view's copy and kept in the app. */
export interface PanelNotesApi {
  /** The whole store now, with the push counter it reflects. */
  list(): Promise<NotesSnapshot>
  /** A new note on `quote`; the app makes its id and says who wrote it. `anchor`: JSON only this page reads. */
  add(note: { quote: string; anchor?: unknown; text: string }): Promise<NoteWriteResult>
  change(id: string, patch: { text: string }): Promise<NoteWriteResult>
  remove(id: string): Promise<NoteWriteResult>
  /** The note for Claude ('' clears it). */
  setGlobal(text: string): Promise<NoteWriteResult>
  /** The store after any write (this view's, another view's, the host's, Discuss removing sent notes). */
  onChange(listener: (state: NotesState) => void): () => void
}

/** The Ask push types a page may listen for (shared/overlay-envelope.ts AskPush). */
export type AskEventType = AskPush['type']
const ASK_EVENTS: readonly AskEventType[] = ['history', 'state', 'delta', 'tool', 'answer', 'end']

/** `ccPanel.ask`: a quick Claude chat about this overlay's document, run by the app (shared/design.md §5). */
export interface PanelAskApi {
  /** Ask a question (the chat's first, or after Esc or a restart: the app resumes the stored chat). */
  start(question: string | { question: string; quote?: string }): Promise<null>
  /** Ask the next question of the live chat. */
  say(question: string | { question: string; quote?: string }): Promise<null>
  /** End the chat's process (the stored turns stay). */
  close(): Promise<null>
  /** Read (no argument) or change the model and effort; the lists come from the app. */
  pick(choice?: { model?: string; effort?: string }): Promise<AskPickState>
  /** Continue this chat in a Claude tab (the owner only; the app refuses anyone else). */
  continue(): Promise<{ tabId: string }>
  /** Hear one kind of push: `history`, `state`, `delta`, `tool`, `answer` or `end`. Returns the unsubscribe. */
  on<T extends AskEventType>(type: T, listener: (data: Extract<AskPush, { type: T }>) => void): () => void
}

/** `ccPanel.overlay`: what an overlay copy's page may ask of the app's window around it. */
export interface PanelOverlayApi {
  /**
   * Open the app's own Discuss with Claude popover (new session or an open tab) from the page's own button; the app
   * arms its Send after a moment and sends nothing by itself. Present in a view that may write (never
   * a read guest's), also before the overlay has Discuss: the call rejects while it has none (the plugin adds
   * `handle.onDiscuss` when it likes, and the page is told once, before its port).
   */
  readonly discuss?: () => Promise<null>
}

interface Pending {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The page's end of one overlay copy's envelope. `send` posts a JSON text on the port (or queues it); false: dropped. */
export class OverlayCopyClient {
  private features: OverlayIntroFeatures | undefined
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  /** The highest notes `seq` seen from a list: a push at or below it is older than what the page holds. */
  private notesSeq = -1
  private askSeq = -1
  /**
   * The last Ask `history` and `state` pushes (main sends history once, when the copy is ready): replayed to an `ask.on`
   * listener added after them, so a page or a kit that subscribes late still shows the chat (dev-frank's B2).
   */
  private readonly lastAsk = new Map<AskEventType, unknown>()
  private readonly notesListeners = new Set<(state: NotesState) => void>()
  private readonly askListeners = new Map<AskEventType, Set<(data: unknown) => void>>()
  private readonly notesApi: PanelNotesApi
  private readonly askApi: PanelAskApi
  private readonly discussApi: PanelOverlayApi
  private readonly bareOverlayApi: PanelOverlayApi

  constructor(
    private readonly send: (text: string) => boolean,
    private readonly warn: (message: string) => void,
    /** The view's access as the shell said it (a UI hint): a read guest's page refuses its own writes early. */
    private readonly access: () => 'owner' | 'read' | 'write',
    private readonly maxLength: number,
    private readonly timeoutMs = ENVELOPE_REQUEST_TIMEOUT_MS
  ) {
    this.notesApi = Object.freeze({
      list: () => this.request('notes.list', {}).then((v) => this.listed(v as NotesSnapshot)),
      add: (note: { quote: string; anchor?: unknown; text: string }) =>
        this.write(() => {
          if (typeof note !== 'object' || note === null) throw new TypeError('notes.add needs { quote, anchor?, text }')
          return {
            op: 'notes.add',
            args: {
              quote: text(note.quote, MAX_NOTE_QUOTE, 'notes.add: quote'),
              anchor: anchorOf(note.anchor),
              text: text(note.text, MAX_NOTE_TEXT, 'notes.add: text')
            }
          }
        }),
      change: (id: string, patch: { text: string }) =>
        this.write(() => {
          if (typeof patch !== 'object' || patch === null) throw new TypeError('notes.change needs { text }')
          return { op: 'notes.change', args: { id: idOf(id, 'notes.change'), text: text(patch.text, MAX_NOTE_TEXT, 'notes.change: text') } }
        }),
      remove: (id: string) => this.write(() => ({ op: 'notes.remove', args: { id: idOf(id, 'notes.remove') } })),
      setGlobal: (value: string) => this.write(() => ({ op: 'notes.setGlobal', args: { text: text(value, MAX_GLOBAL_NOTE, 'notes.setGlobal: text') } })),
      onChange: (listener: (state: NotesState) => void) => {
        if (typeof listener !== 'function') throw new TypeError('notes.onChange needs a function')
        // Wrapped: the same function added twice is two listeners, each with its unsubscribe.
        const entry = (state: NotesState): void => listener(state)
        this.notesListeners.add(entry)
        return () => {
          this.notesListeners.delete(entry)
        }
      }
    }) as PanelNotesApi
    this.askApi = Object.freeze({
      start: (q: string | { question: string; quote?: string }) => this.call('ask.start', () => questionOf(q, 'ask.start')) as Promise<null>,
      say: (q: string | { question: string; quote?: string }) => this.call('ask.say', () => questionOf(q, 'ask.say')) as Promise<null>,
      close: () => this.request('ask.close', {}) as Promise<null>,
      pick: (choice?: { model?: string; effort?: string }) => this.call('ask.pick', () => pickOf(choice)) as Promise<AskPickState>,
      continue: () => this.request('ask.continue', {}) as Promise<{ tabId: string }>,
      on: (type: AskEventType, listener: (data: never) => void) => {
        if (!ASK_EVENTS.includes(type)) throw new TypeError(`ask.on: type must be one of ${ASK_EVENTS.join(', ')}`)
        if (typeof listener !== 'function') throw new TypeError('ask.on needs a function')
        const set = this.askListeners.get(type) ?? new Set()
        const entry = (data: unknown): void => listener(data as never)
        set.add(entry)
        this.askListeners.set(type, set)
        // Late to a history or state push: that push, once, after this call returns. Not when a newer one came
        // meanwhile (the listener heard it live) or the listener was removed.
        const stored = this.lastAsk.get(type)
        if (stored !== undefined) {
          queueMicrotask(() => {
            if (!set.has(entry) || this.lastAsk.get(type) !== stored) return
            this.safely(() => entry(structuredClone(stored)), `an ask.on("${type}") listener`)
          })
        }
        return () => {
          set.delete(entry)
        }
      }
    }) as PanelAskApi
    this.discussApi = Object.freeze({ discuss: () => this.request('discuss.open', {}) as Promise<null> })
    this.bareOverlayApi = Object.freeze({})
  }

  /** The shell's intro (`cc-plugin.overlay`): what this copy has. Anything but `true` is no. */
  intro(raw: unknown): void {
    const o = (raw ?? {}) as Record<string, unknown>
    this.features = { notes: o['notes'] === true, ask: o['ask'] === true, discuss: o['discuss'] === true }
  }

  /** The page is an overlay copy (an intro came): envelopes on its port are the app's. */
  get isCopy(): boolean {
    return this.features !== undefined
  }

  get notes(): PanelNotesApi | undefined {
    return this.features?.notes === true ? this.notesApi : undefined
  }

  get ask(): PanelAskApi | undefined {
    return this.features?.ask === true ? this.askApi : undefined
  }

  get overlay(): PanelOverlayApi | undefined {
    if (!this.features) return undefined
    return this.features.discuss ? this.discussApi : this.bareOverlayApi
  }

  /**
   * An envelope that came down the port (parsed, within the port's cap): an answer settles its request, a push goes
   * to its listeners. Anything else is dropped with a warning.
   */
  receive(message: Record<string, unknown>): void {
    if (typeof message['re'] === 'number') {
      const pending = this.pending.get(message['re'])
      // A late answer (after its timeout) or one for no request of this page: nothing waits for it.
      if (!pending) return
      this.pending.delete(message['re'])
      clearTimeout(pending.timer)
      if (message['ok'] === true) pending.resolve(message['value'] ?? null)
      else pending.reject(new Error(typeof message['error'] === 'string' ? message['error'] : 'refused'))
      return
    }
    const { ev, seq, data } = message as { ev?: unknown; seq?: unknown; data?: unknown }
    if (typeof seq !== 'number' || typeof data !== 'object' || data === null) {
      this.warn('dropped an app message that is not an answer or a push')
      return
    }
    if (ev === 'notes') {
      const state = (data as { state?: unknown }).state
      if ((data as { type?: unknown }).type !== 'state' || typeof state !== 'object' || state === null) {
        this.warn('dropped a notes push that carries no state')
        return
      }
      // Older than (or the same as) what the page holds: a list answered after this push was sent.
      if (seq <= this.notesSeq) return
      this.notesSeq = seq
      for (const listener of [...this.notesListeners]) this.safely(() => listener(structuredClone(state) as NotesState), 'a notes.onChange listener')
      return
    }
    if (ev === 'ask') {
      const type = (data as { type?: unknown }).type
      if (typeof type !== 'string' || !ASK_EVENTS.includes(type as AskEventType)) {
        this.warn('dropped an Ask push of an unknown type')
        return
      }
      if (seq <= this.askSeq) return
      this.askSeq = seq
      if (type === 'history' || type === 'state') this.lastAsk.set(type, structuredClone(data))
      for (const listener of [...(this.askListeners.get(type as AskEventType) ?? [])]) {
        this.safely(() => listener(structuredClone(data)), `an ask.on("${type}") listener`)
      }
      return
    }
    this.warn('dropped an app push of an unknown kind')
  }

  /** The port was replaced: what was asked on the old one gets no answer, so it is rejected now. */
  reset(reason: string): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
  }

  private listed(snapshot: NotesSnapshot): NotesSnapshot {
    if (typeof snapshot?.seq === 'number' && snapshot.seq > this.notesSeq) this.notesSeq = snapshot.seq
    return snapshot
  }

  /** A notes write: a read guest's page refuses it here (main would anyway). */
  private write(build: () => { op: EnvelopeOp; args: Record<string, unknown> }): Promise<NoteWriteResult> {
    if (this.access() === 'read') return Promise.reject(new Error('notes: a read-only guest cannot change notes'))
    let built: { op: EnvelopeOp; args: Record<string, unknown> }
    try {
      built = build()
    } catch (err) {
      return Promise.reject(err)
    }
    return this.request(built.op, built.args) as Promise<NoteWriteResult>
  }

  private call(op: EnvelopeOp, args: () => Record<string, unknown>): Promise<unknown> {
    let built: Record<string, unknown>
    try {
      built = args()
    } catch (err) {
      return Promise.reject(err)
    }
    return this.request(op, built)
  }

  private request(op: EnvelopeOp, args: Record<string, unknown>): Promise<unknown> {
    if (this.pending.size >= MAX_OUTSTANDING_ENVELOPES) {
      return Promise.reject(new RangeError(`${op}: ${MAX_OUTSTANDING_ENVELOPES} requests are already waiting for the app`))
    }
    const id = this.nextId++
    const text = JSON.stringify({ [ENVELOPE_KEY]: ENVELOPE_VERSION, id, op, args })
    if (text.length > this.maxLength) return Promise.reject(new RangeError(`${op}: request of ${text.length} chars exceeds ${this.maxLength}`))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${op}: the app did not answer in ${this.timeoutMs / 1000} s`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      if (!this.send(text)) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`${op}: not connected, and too many messages are waiting`))
      }
    })
  }

  private safely(run: () => void, what: string): void {
    try {
      run()
    } catch (err) {
      this.warn(`${what} threw: ${errorText(err)}`)
    }
  }
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a string`)
  if (value.length > max) throw new RangeError(`${what}: ${value.length} characters exceeds ${max}`)
  return value
}

function idOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ID_LENGTH) throw new TypeError(`${what}: id must be a note's id`)
  return value
}

/** A note's anchor: JSON within its cap, absent as null. */
function anchorOf(anchor: unknown): unknown {
  if (anchor === undefined) return null
  let json: string | undefined
  try {
    json = JSON.stringify(anchor)
  } catch (err) {
    throw new TypeError(`notes.add: anchor is not JSON: ${errorText(err)}`, { cause: err })
  }
  if (json === undefined) throw new TypeError('notes.add: anchor is not JSON')
  if (json.length > MAX_NOTE_ANCHOR_JSON) throw new RangeError(`notes.add: anchor of ${json.length} characters of JSON exceeds ${MAX_NOTE_ANCHOR_JSON}`)
  return anchor
}

function questionOf(raw: unknown, what: string): { question: string; quote?: string } {
  const q = typeof raw === 'string' ? { question: raw } : raw
  if (typeof q !== 'object' || q === null) throw new TypeError(`${what} needs a question`)
  const { question, quote } = q as { question?: unknown; quote?: unknown }
  const clean = text(question, ASK_MAX_QUESTION, `${what}: question`)
  if (clean.trim() === '') throw new TypeError(`${what}: the question is empty`)
  if (quote === undefined) return { question: clean }
  return { question: clean, quote: text(quote, ASK_MAX_QUOTE, `${what}: quote`) }
}

function pickOf(choice: unknown): { model?: string; effort?: string } {
  if (choice === undefined) return {}
  if (typeof choice !== 'object' || choice === null) throw new TypeError('ask.pick takes { model?, effort? }')
  const { model, effort } = choice as { model?: unknown; effort?: unknown }
  const name = (value: unknown, what: string): string => {
    if (typeof value !== 'string' || value === '' || value.length > MAX_ID_LENGTH) throw new TypeError(`ask.pick: ${what} must be a name from the list`)
    return value
  }
  return { ...(model !== undefined ? { model: name(model, 'model') } : {}), ...(effort !== undefined ? { effort: name(effort, 'effort') } : {}) }
}
