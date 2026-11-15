// The session registry: one entry per Claude tab, driven by hook events and PTY lifecycle, and the
// snapshot main broadcasts to the windows (plan: Technical Details > Tab status and session
// registry). The state transitions themselves live in the pure status-reducer.ts; this class owns
// the entries, the change subscriptions and the broadcast throttle; the send-text gate
// (send-gate.ts, also pure) decides when queued text is typed, and this class does the typing
// through the `write` option and owns the `delivering` timeout.
//
// main is the only authority: callers name a tab by the id main resolved (socket token ->
// TabManager.resolveToken), never by anything a hook payload says. A payload is data for the
// reducer to read, already capped there.
//
// No Electron import: the broadcast goes out through an option, so vitest drives it with fakes.
import { randomUUID } from 'node:crypto'
import { errorText } from '../../shared/error-text'
import type { HookEvent } from '../../shared/hooks'
import type { SessionDetail, SessionsSnapshot } from '../../shared/ipc'
import { projectColorCss, type ProjectColor } from '../../shared/project-color'
import type { SessionSummary } from '../../sdk/types'
import type { TabFlag } from '../../shared/tab-flag'
import type { TabKind } from '../../shared/types'
import { exitStatus } from '../pty/pty-backend'
import * as gate from './send-gate'
import { cap, isAnswerKey, newEntry, reduce, withNote, withSteps, type QueuedText, type ReducerEvent, type SendOrigin, type SessionEntry, type SessionRoom } from './status-reducer'
import { isPersonInput } from './terminal-reports'
import { cleanTitle, TitleParser } from './terminal-title'
import { warnLog } from '../warn-log'

/** The longest gist kept (the gist run asks for ~80 characters; a chatty answer is cut). */
export const MAX_GIST_CHARS = 160

/** At most this many snapshots per second (plan: throttled to 10/s). */
const DEFAULT_INTERVAL_MS = 100

/** What a subscriber hears about one tab. `entry` is undefined once the tab is gone. */
export interface SessionChange {
  tabId: string
  entry: SessionEntry | undefined
  prev: SessionEntry | undefined
  /**
   * Queued texts thrown away by this change because the session ended, the tab closed or the
   * person took the tab over (its plugin texts only), oldest first (the plan's "queue cleared (and
   * reported)"). Absent when nothing was dropped.
   */
  dropped?: QueuedText[]
}

/** What `send` did with the text. */
export interface SendResult {
  /** The item's id; `cancelQueued` takes it while the item is still queued. */
  id: string
  /** True when it was written to the PTY now, false when it waits in the queue. */
  delivered: boolean
}

export interface SessionRegistryOptions {
  /** The display name of a project, for summariesFor (scope all); read at each call so a rename shows. */
  projectName(projectId: string): string | undefined
  /** The project's colour, for summariesFor's dot; read at each call like the name. */
  projectColor?(projectId: string): ProjectColor | undefined
  /**
   * Send each window its snapshot. Called at most once per `intervalMs`, with the function that
   * builds a window's view from the project it shows: the caller (main) knows which window shows
   * which project and must send `snapshotFor(thatProject)` to it and nothing else, so a window
   * never sees another project's prompts, notes, files or queue.
   */
  broadcast(snapshotFor: (projectId: string) => SessionsSnapshot): void
  /**
   * Type into the tab's PTY. Called only with a framed paste the send gate produced, only while
   * the entry is `waiting`, synchronously from the event or the `send` that allowed it (no await
   * in between, so no later hook can change the status first). May throw; the item then stays
   * queued.
   */
  write(entry: { tabId: string; projectId: string }, data: string): void
  intervalMs?: number
  /** How long a delivery waits for its UserPromptSubmit (default send-gate.ts). */
  deliveringTimeoutMs?: number
  /** Tests only: the settle window after SessionStart (default send-gate.ts SESSION_START_SETTLE_MS). */
  settleMs?: number
  log?: (message: string) => void
}

export class SessionRegistry {
  /** Insertion order = tab creation order, which is what the strip's stable sort relies on. */
  private readonly entries = new Map<string, SessionEntry>()
  private readonly listeners = new Set<(change: SessionChange) => void>()
  private readonly inputListeners = new Set<(tabId: string) => void>()
  private readonly promptListeners = new Set<(tabId: string) => void>()
  private readonly interval: number
  private readonly log: (message: string) => void
  private lastSent = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  /** tabId -> the timer of the delivery in flight (at most one per tab: `delivering`). */
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deliveringTimeout: number
  /** The settle window after SessionStart (send-gate.ts settled), per tab. */
  private readonly settleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly settleMs: number
  /**
   * tabId -> the terminal-title parser of its current process. Per process, not per entry: a
   * sequence half-read when the process died must not run into the next one's output.
   */
  private readonly titles = new Map<string, TitleParser>()
  /**
   * projectId -> the tab its window shows (selected in the tab pane), as the renderer last
   * reported it (`tabs.selected`, checked by main to be a tab of that project). Any tab kind: a
   * selected shell tab means no Claude tab is active. Read for `SessionInfo.active`; kept apart
   * from the entries because selection is the window's state, not the session's, and a restart
   * (a fresh entry) must not lose it.
   */
  private readonly activeTabs = new Map<string, string>()

  constructor(private readonly options: SessionRegistryOptions) {
    this.interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.deliveringTimeout = options.deliveringTimeoutMs ?? gate.DELIVERING_TIMEOUT_MS
    this.settleMs = options.settleMs ?? gate.SESSION_START_SETTLE_MS
    this.log = options.log ?? warnLog
  }

  /**
   * A tab's process just started (a new tab, or a restart of an exited one). Only Claude tabs get
   * an entry. A restart replaces the old entry with a fresh `starting` one (same place in the
   * order) but keeps the session id: the restart resumes that session, and SessionStart reports
   * it again. The old process's queue was already dropped at its exit; its delivery timer must
   * not outlive it and clear a `delivering` flag of the new process.
   */
  tabStarted(tab: { tabId: string; projectId: string; kind: TabKind; cwd: string; name?: string; flag?: TabFlag; typed?: true }): void {
    // Only Claude tabs. A page tab (design-editor.md §1) never even gets here (TabManager reports no
    // `started` for it): with no entry it is outside the send gate, `typed` and Claude status.
    if (tab.kind !== 'claude') return
    const prev = this.entries.get(tab.tabId)
    this.clearDeliveryTimer(tab.tabId)
    this.clearSettleTimer(tab.tabId)
    this.titles.set(tab.tabId, new TitleParser())
    // `typed` survives the restart too: the tab is the same one the person took over (and the
    // restart is theirs), and the flag is never cleared while the tab exists. A restored room
    // member is born typed (TabEvent.typed, design-rooms.md §1 "Restart"): `typed` is not saved,
    // and the restored session is the person's, so its room's messages wait for the person's mark.
    const next = newEntry({ ...tab, sessionId: prev?.sessionId, typed: prev?.typed === true || tab.typed === true })
    // A restart is the same tab in the same room: its room fields stay until the room delivery says
    // otherwise (setRoom). The draft bit does not: the new process's input box starts empty.
    if (prev?.room !== undefined) next.room = { ...prev.room }
    if (prev?.held !== undefined) next.held = prev.held
    this.set(prev, next)
  }

  /**
   * Output of a Claude tab's PTY (TabManager calls it with each flushed chunk). Only the terminal
   * title is read (terminal-title.ts) and becomes the entry's `title`. A change is reported only
   * when the cleaned title differs: Claude rewrites the title on every spinner frame while it
   * works, and each of those would otherwise be a change and a broadcast. A title that names
   * nothing (empty, plain "Claude Code") leaves the last topic in place.
   */
  tabOutput(tabId: string, chunk: string): void {
    const raw = this.titles.get(tabId)?.feed(chunk)
    if (raw === undefined) return
    const title = cleanTitle(raw)
    const prev = this.entries.get(tabId)
    if (title === undefined || !prev || prev.title === title) return
    this.set(prev, { ...prev, title })
  }

  /**
   * Store (or with null, remove) the name the person gave the tab (TabManager.rename checked it).
   * False when the tab has no entry.
   */
  setName(tabId: string, name: string | null): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) return false
    if (prev.name === (name ?? undefined)) return true
    const next = { ...prev }
    if (name === null) delete next.name
    else next.name = name
    this.set(prev, next)
    return true
  }

  /**
   * Mirror the person's flag (or with null, its removal) from the tab manager, its owner and only
   * writer (TabManager.setFlag, which checked it): plugins read it as SessionInfo.flag and, colour
   * only, in the summaries. Nothing a plugin or a hook sends reaches this. False when the tab has
   * no entry (a shell or command tab: the flag lives on the tab, the registry has no entry for it).
   */
  setFlag(tabId: string, flag: TabFlag | null): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) return false
    if (prev.flag?.color === flag?.color && prev.flag?.note === flag?.note) return true
    const next = { ...prev }
    if (flag === null) delete next.flag
    else next.flag = { ...flag }
    this.set(prev, next)
    return true
  }

  /**
   * Store (or with undefined, remove) the tab's session gist (session-gist.ts, main's own Haiku
   * run). Trimmed, one line, capped; a blank text removes it. False when the tab has no entry.
   */
  setGist(tabId: string, gist: string | undefined): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) return false
    const text = gist === undefined ? '' : cap(gist.replace(/\s+/g, ' ').trim(), MAX_GIST_CHARS)
    const next = text === '' ? undefined : text
    if (prev.gist === next) return true
    const entry = { ...prev }
    if (next === undefined) delete entry.gist
    else entry.gist = next
    this.set(prev, entry)
    return true
  }

  /**
   * Store the session's cost and context fill from its status line (`ccc statusline`; the socket
   * handler checked the numbers, shared/rate-limits.ts). A field the report lacks is left as it
   * was: a status line that stops carrying one does not blank it. Ignored for an entry that ended
   * with its process (exitCode set): a late report from a dying `claude` must not bring back what
   * the exit cleared. A change is reported only when a number moved, since the status line runs
   * after every message. False when the tab has no entry.
   */
  setUsage(tabId: string, usage: { costUsd?: number; contextPercent?: number }): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) return false
    if (prev.exitCode !== undefined) return true
    const next = { ...prev }
    if (usage.costUsd !== undefined) next.costUsd = usage.costUsd
    if (usage.contextPercent !== undefined) next.contextPercent = usage.contextPercent
    if (next.costUsd !== prev.costUsd || next.contextPercent !== prev.contextPercent) this.set(prev, next)
    return true
  }

  /**
   * Apply a hook event the socket delivered for `tabId`. Synchronous on purpose: the caller (the
   * `hook` socket handler) must call this before any `await`, so two hooks from one connection
   * cannot be reordered (see status-reducer.ts). False when the tab has no entry.
   */
  applyHook(tabId: string, event: HookEvent, payload: unknown, blocked?: string): boolean {
    // `blocked` is the ack id of the room block main answered this Stop with (rooms/room-stop.ts);
    // only a Stop can be blocked, so it is dropped for any other event.
    const ev: ReducerEvent = event === 'Stop' && blocked !== undefined ? { type: 'hook', event, payload, blocked } : { type: 'hook', event, payload }
    // The person's prompt: a UserPromptSubmit while the draft bit is set, i.e. the person's own input
    // reached the box since the last submit and was now sent. Not our gate's paste (it never lands on
    // a draft of a marked tab, and an untyped tab has no draft); a badge click or Discuss on top of a
    // draft counts, which is the person's act anyway. Read before apply: the submit clears the bit.
    const personPrompt = event === 'UserPromptSubmit' && this.entries.get(tabId)?.draft === true
    const applied = this.apply(tabId, ev)
    if (applied && personPrompt) this.notify(this.promptListeners, tabId, 'person-prompt')
    return applied
  }

  /**
   * Turn the blocked Stop `ackId` back into a plain Stop (`waiting`, the gate's head delivered): `ccc hook Stop` closed
   * its connection without acking the block, and it prints the block only after main confirmed the ack
   * (cli/client.ts runHook), so it never printed and Claude stopped. Only while that blocked Stop is still the tab's
   * last event (SessionEntry.blockedStop): after any later hook the turn moved on and this is a no-op. True when the
   * Stop was applied.
   */
  unblockStop(tabId: string, ackId: string, payload: unknown): boolean {
    const entry = this.entries.get(tabId)
    if (entry?.blockedStop === undefined || entry.blockedStop !== ackId) return false
    return this.apply(tabId, { type: 'hook', event: 'Stop', payload })
  }

  /**
   * Listen for the person's submitted prompts in a tab (a UserPromptSubmit after their input, see
   * applyHook): the room stop ends a tab's run of Stop blocks and its cap on it (rooms/room-stop.ts,
   * design-rooms.md §2 "Loops": "until the person's next prompt"). The tab id only, after the
   * prompt's own change was applied.
   */
  onPersonPrompt(listener: (tabId: string) => void): () => void {
    this.promptListeners.add(listener)
    return () => {
      this.promptListeners.delete(listener)
    }
  }

  /**
   * Listen for the person's input in a tab (every chunk userInput counts as the person's, not only
   * the first): the room stop resets its room's auto-pause count on it (rooms/room-stop.ts). The
   * tab id only, after the input's own change was applied.
   */
  onPersonInput(listener: (tabId: string) => void): () => void {
    this.inputListeners.add(listener)
    return () => {
      this.inputListeners.delete(listener)
    }
  }

  /**
   * The user typed into the tab (renderer keystrokes only, never the gate's own paste). A key that
   * answers a permission dialog moves a `needs-permission` tab to `working` (status-reducer.ts
   * isAnswerKey says why and which keys). `projectId` is the window's project as main resolved it:
   * a tab of another project is ignored, as TabManager.viewInput ignores it.
   *
   * The first chunk that is the person's (terminal-reports.ts isPersonInput: not only focus, mouse
   * and other replies xterm sends by itself) sets `typed`, the takeover flag plugins read as
   * SessionInfo.typed; it reports one change and never flips back. That this means a PERSON rests
   * on the one caller: main's `tabs.input` IPC handler (through `TabManager.viewInput`), fed by the renderer's terminal `onData`.
   * Nothing main types reaches this method: the send gate writes its paste through the registry's
   * `write` option (TabManager.input directly, index.ts), so neither a plugin's `ctx.sessions.send`
   * nor Discuss can set the flag.
   *
   * The flip is enforced here, not left to plugins reading the flag (send-gate.ts takenOver): the
   * tab's queued plugin texts are dropped in the same change, before the chunk's answer step, so
   * no later Stop can deliver one, and `send` refuses plugin texts from now on.
   */
  userInput(projectId: string, tabId: string, data: string): void {
    const entry = this.entries.get(tabId)
    if (!entry || entry.projectId !== projectId) return
    if (isPersonInput(data)) {
      let next = entry
      let dropped: QueuedText[] | undefined
      if (!entry.typed) {
        const step = gate.takenOver(entry)
        if (step.dropped) {
          this.log(`session ${tabId}: the person typed, dropped ${step.dropped.length} queued plugin text(s)`)
        }
        next = step.entry
        dropped = step.dropped
      }
      // The draft bit (design-rooms.md §2), on every input of the person's, not only the first: a
      // marked member gets no room pointer pasted on top of what they may be typing. Set on any key,
      // an answer to a permission dialog included: a wrong guess only holds a pointer back (the
      // Stop pointer and the badge still reach the tab), it never types anything.
      if (next.draft !== true) next = { ...next, draft: true }
      if (next !== entry) this.set(entry, next, dropped)
      this.notify(this.inputListeners, tabId, 'person-input')
    }
    if (isAnswerKey(data)) this.apply(tabId, { type: 'answer' })
  }

  /**
   * The tab's PTY exited. The entry ends with the exit code and stays until the tab closes. A
   * signal death reads as 128 + n (exitStatus): node-pty can report it as code 0, and a crashed
   * Claude must not show `exitCode: 0` in `ccc sessions`.
   */
  tabExited(tabId: string, code: number, signal: number | null = null): void {
    this.apply(tabId, { type: 'exit', code: exitStatus(code, signal) })
  }

  /** The tab was closed or its window went away: forget it, and its queue with it (reported). */
  tabClosed(tabId: string): void {
    const prev = this.entries.get(tabId)
    if (!prev) return
    this.clearDeliveryTimer(tabId)
    this.clearSettleTimer(tabId)
    this.titles.delete(tabId)
    this.entries.delete(tabId)
    const change: SessionChange = { tabId, entry: undefined, prev }
    if (prev.queue.length > 0) {
      change.dropped = prev.queue
      this.log(`session ${tabId}: tab closed, dropped ${prev.queue.length} queued text(s)`)
    }
    this.changed(change)
  }

  /**
   * Send text to a Claude tab (main-internal; plugins and IPC reach it in later tasks, always
   * scoped to their own project by the caller). Written at once as one bracketed paste when the tab
   * is waiting for input and no earlier paste is in flight; otherwise queued, and the next `Stop`
   * delivers one item. Throws for an unknown tab, an ended session, a full queue or unusable text
   * (send-gate.ts prepareText), and for a `plugin` text once the person took the tab over
   * (send-gate.ts TYPED_ERROR).
   *
   * `origin` has no default on purpose: every sender must say whose text it is, so a new way in
   * cannot slip past the takeover by forgetting to (host-api passes `plugin`; Discuss and the
   * test hook `core`, index.ts and overlay-manager.ts).
   */
  send(tabId: string, text: string, origin: SendOrigin): SendResult {
    const prev = this.entries.get(tabId)
    if (!prev) throw new Error('unknown tab')
    const item: QueuedText = { id: randomUUID(), text: gate.prepareText(text), origin }
    const step = gate.send(prev, item)
    const entry = this.commit(prev, step)
    // Delivered only when this very item left the queue and was not put back by a failed write.
    return { id: item.id, delivered: step.delivered === item && !entry.queue.includes(item) }
  }

  /**
   * Paste the room pointer (rooms/room-delivery.ts) now if the tab may take text (send-gate.ts
   * sendNow): true when it was written, false when the tab was not sendable or the write failed.
   * Never queued, never put back. The caller (the room delivery) already decided that this tab
   * may get it (untyped, or the person's mark with no draft, or the person's badge click); the
   * gate only adds its own rule, waiting for input with nothing in flight. Throws for an unknown
   * tab or an ended session, and for text prepareText refuses (the pointer is fixed text).
   */
  sendPointer(tabId: string, text: string): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) throw new Error('unknown tab')
    const item: QueuedText = { id: randomUUID(), text: gate.prepareText(text), origin: 'room' }
    const step = gate.sendNow(prev, item)
    if (step.delivered === undefined) return false
    return this.commit(prev, step).delivering
  }

  /**
   * Mirror the tab's room membership and held count (SessionInfo.room / held) from the room
   * delivery, which reads the room registry, the authority; null removes both (the tab left, the
   * room ended). `held` is kept only when above 0. Nothing a plugin or a hook sends reaches this.
   * False when the tab has no entry.
   */
  setRoom(tabId: string, room: (SessionRoom & { held: number }) | null): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) return false
    const next = { ...prev }
    delete next.room
    delete next.held
    if (room !== null) {
      next.room = { title: room.title, name: room.name, coordinator: room.coordinator }
      if (room.held > 0) next.held = room.held
    }
    const same =
      prev.room?.title === next.room?.title &&
      prev.room?.name === next.room?.name &&
      prev.room?.coordinator === next.room?.coordinator &&
      prev.held === next.held
    if (!same) this.set(prev, next)
    return true
  }

  /**
   * `ccc session note`: add a line to the tab's entry (capped, newest last; status-reducer.ts
   * withNote). `tabId` is the one main resolved from the caller's token. Throws for a tab with no
   * entry (a shell tab) or blank text.
   */
  addNote(tabId: string, text: string): void {
    const prev = this.entries.get(tabId)
    if (!prev) throw new Error('this tab has no Claude session')
    this.set(prev, withNote(prev, text))
  }

  /** `ccc session steps 3/5`: set the tab's progress counter. Same rules as addNote. */
  setSteps(tabId: string, done: unknown, total: unknown): void {
    const prev = this.entries.get(tabId)
    if (!prev) throw new Error('this tab has no Claude session')
    this.set(prev, withSteps(prev, done, total))
  }

  /** Remove a queued item. False when the tab is unknown or the item is no longer queued. */
  cancelQueued(tabId: string, itemId: string): boolean {
    const prev = this.entries.get(tabId)
    if (!prev || typeof itemId !== 'string') return false
    const step = gate.cancel(prev, itemId)
    if (!step) return false
    this.commit(prev, step)
    return true
  }

  /**
   * Remove a queued item, but only when the tab belongs to `projectId`: the renderer's cancel
   * button reaches this with the project main resolved from the sender, so a tab id of another
   * project (guessed or stale) is treated as unknown, like every other tab-scoped IPC.
   */
  cancelQueuedFor(projectId: string, tabId: string, itemId: string): boolean {
    if (this.entries.get(tabId)?.projectId !== projectId) return false
    return this.cancelQueued(tabId, itemId)
  }

  /**
   * The project window selected `tabId` (or, with undefined, its window went away). The caller
   * (main's `tabs.selected` handler) has checked the tab belongs to `projectId`; an entry is still
   * marked only when its own project matches, so a stale or foreign id can never mark another
   * project's tab. The Claude entries that gained or lost the selection are reported as changes
   * (entry === prev: nothing in the entry moved), which sends plugin hosts their throttled
   * `sessions` event; a move between two shell tabs reports nothing.
   */
  setActive(projectId: string, tabId: string | undefined): void {
    const before = this.activeTabs.get(projectId)
    if (before === tabId) return
    if (tabId === undefined) this.activeTabs.delete(projectId)
    else this.activeTabs.set(projectId, tabId)
    for (const id of [before, tabId]) {
      const entry = id === undefined ? undefined : this.entries.get(id)
      if (entry && entry.projectId === projectId) this.changed({ tabId: entry.tabId, entry, prev: entry })
    }
  }

  /**
   * The tab `projectId`'s window shows, any kind (a shell or page tab too), as setActive was last
   * told. For the page tabs' unseen dot (TabManager.createPage): opened while this is some tab, a
   * new one was opened while the person looked elsewhere.
   */
  selectedTab(projectId: string): string | undefined {
    return this.activeTabs.get(projectId)
  }

  /** The Claude tab `projectId`'s window shows, if the selected tab is one (see setActive). */
  activeTab(projectId: string): string | undefined {
    const tabId = this.activeTabs.get(projectId)
    return tabId !== undefined && this.entries.get(tabId)?.projectId === projectId ? tabId : undefined
  }

  get(tabId: string): SessionEntry | undefined {
    return this.entries.get(tabId)
  }

  list(): SessionEntry[] {
    return [...this.entries.values()]
  }

  listByProject(projectId: string): SessionEntry[] {
    return this.list().filter((e) => e.projectId === projectId)
  }

  /**
   * Subscribe to changes of any entry; returns the unsubscribe function. Called synchronously,
   * not throttled (the throttle is only for the broadcast to windows). A throwing subscriber is
   * logged and does not stop the others or the hook that caused the change.
   */
  onChange(listener: (change: SessionChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Tell subscribers that something shown about a project's tabs changed outside the registry (its
   * colour, which summaries carry): one unchanged-entry change per tab, so a plugin that lists the
   * tabs of all windows reads them again. Gist and the other subscribers act only on a status move.
   */
  projectChanged(projectId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.projectId === projectId) this.changed({ tabId: entry.tabId, entry, prev: entry })
    }
  }

  /**
   * The view of a window that shows `projectId`: the full detail of that project's tabs only
   * (plan: "a window gets full entries only for its own project's tabs"). Other windows' tabs are
   * not in it: their strip is a plugin's now (summariesFor, design-next §4). Built from explicit
   * fields, never by spreading an entry, so a field added to SessionEntry later (cwd, projectId,
   * a token) is not exposed by accident.
   */
  snapshotFor(projectId: string): SessionsSnapshot {
    return { own: this.listByProject(projectId).map(detailOf) }
  }

  /**
   * Every Claude tab of every window as a plugin with the `access` declaration sees it
   * (ctx.sessions.list({ scope: 'all' }), design-next §4.1), from the view of a host of `projectId`:
   * status, tool, title and the project's name and colour (as CSS), `own` for that project's tabs.
   * Field by field like snapshotFor: prompts, notes, files, cwd and the queue never leave main here.
   */
  summariesFor(projectId: string): SessionSummary[] {
    return this.list().map((e) => {
      const color = this.options.projectColor?.(e.projectId)
      const out: { -readonly [K in keyof SessionSummary]: SessionSummary[K] } = {
        tabId: e.tabId,
        own: e.projectId === projectId,
        project: { name: this.options.projectName(e.projectId) ?? '', ...(color !== undefined ? { color: projectColorCss(color) } : {}) },
        status: e.status
      }
      if (e.tool !== undefined) out.tool = e.tool
      if (e.title !== undefined) out.title = e.title
      if (e.name !== undefined) out.name = e.name
      // The colour only: the note is the person's own words about the tab, which (like prompts and
      // notes) stay with the tab's own window.
      if (e.flag !== undefined) out.flag = { color: e.flag.color }
      return out
    })
  }

  /** Cancel a pending trailing broadcast and every delivery timer (app quit). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
    for (const timer of this.settleTimers.values()) clearTimeout(timer)
    this.settleTimers.clear()
    this.listeners.clear()
    this.inputListeners.clear()
    this.promptListeners.clear()
  }

  /** Tell one set of tab-id listeners; one that throws is logged and the others still run. */
  private notify(listeners: Set<(tabId: string) => void>, tabId: string, what: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(tabId)
      } catch (err) {
        this.log(`session registry: a ${what} subscriber threw: ${errorText(err)}`)
      }
    }
  }

  private apply(tabId: string, event: ReducerEvent): boolean {
    const prev = this.entries.get(tabId)
    if (!prev) return false
    // Reducer first (the status), then the gate on the RESULT: a Stop delivers only if it really
    // left the tab waiting, and an event the reducer ignored (a late hook of a dead process) finds
    // an ended entry the gate never types into.
    this.commit(prev, gate.afterEvent(reduce(prev, event), event))
    return true
  }

  /**
   * Apply a gate step: write its paste (if any), then store the entry and tell subscribers.
   * Synchronous end to end, so the status the gate checked is still the status when the bytes
   * reach the PTY. A write that throws puts the item back at the head of the queue, not delivering.
   * Returns the entry as stored.
   */
  private commit(prev: SessionEntry, step: gate.GateStep): SessionEntry {
    let entry = step.entry
    if (step.write !== undefined && step.delivered !== undefined) {
      try {
        this.options.write({ tabId: entry.tabId, projectId: entry.projectId }, step.write)
        this.startDeliveryTimer(entry.tabId)
      } catch (err) {
        this.log(`session ${entry.tabId}: writing queued text failed: ${errorText(err)}`)
        // A room pointer is not put back (send-gate.ts sendNow): its messages stay held in the room.
        entry =
          step.delivered.origin === 'room'
            ? { ...entry, delivering: false }
            : { ...entry, queue: [step.delivered, ...entry.queue], delivering: false }
      }
    }
    if (!entry.delivering) this.clearDeliveryTimer(entry.tabId)
    // A SessionStart opened the settle window; one already running is not restarted by later events.
    if (entry.settling && !this.settleTimers.has(entry.tabId)) this.startSettleTimer(entry.tabId)
    if (!entry.settling) this.clearSettleTimer(entry.tabId)
    if (step.dropped) {
      this.log(`session ${entry.tabId}: session ended, dropped ${step.dropped.length} queued text(s)`)
    }
    if (entry !== prev) this.set(prev, entry, step.dropped) // else nothing changed
    return entry
  }

  /**
   * The flag clears after the timeout, logged, and NOTHING is delivered by it (send-gate.ts
   * deliveringTimedOut). Cleared whenever the flag clears another way, the process restarts, the
   * tab closes or the app quits, so a stale timer never touches a later delivery.
   */
  private startDeliveryTimer(tabId: string): void {
    this.clearDeliveryTimer(tabId)
    const timer = setTimeout(() => {
      this.deliveryTimers.delete(tabId)
      const prev = this.entries.get(tabId)
      if (!prev?.delivering) return
      this.log(`session ${tabId}: no UserPromptSubmit ${this.deliveringTimeout} ms after a send; no longer delivering`)
      this.set(prev, gate.deliveringTimedOut(prev))
    }, this.deliveringTimeout)
    timer.unref?.()
    this.deliveryTimers.set(tabId, timer)
  }

  /** Ends the settle window: send-gate.ts settled delivers the queue head if the tab still waits. */
  private startSettleTimer(tabId: string): void {
    this.clearSettleTimer(tabId)
    const timer = setTimeout(() => {
      this.settleTimers.delete(tabId)
      const prev = this.entries.get(tabId)
      if (prev?.settling) this.commit(prev, gate.settled(prev))
    }, this.settleMs)
    timer.unref?.()
    this.settleTimers.set(tabId, timer)
  }

  private clearSettleTimer(tabId: string): void {
    const timer = this.settleTimers.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.settleTimers.delete(tabId)
  }

  private clearDeliveryTimer(tabId: string): void {
    const timer = this.deliveryTimers.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.deliveryTimers.delete(tabId)
  }

  private set(prev: SessionEntry | undefined, entry: SessionEntry, dropped?: QueuedText[]): void {
    this.entries.set(entry.tabId, entry)
    const change: SessionChange = { tabId: entry.tabId, entry, prev }
    if (dropped) change.dropped = dropped
    this.changed(change)
  }

  private changed(change: SessionChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (err) {
        this.log(`session registry: a subscriber threw: ${errorText(err)}`)
      }
    }
    this.markDirty()
  }

  /**
   * Leading and trailing throttle: the first change after a quiet spell goes out at once, changes
   * inside the interval are folded into one snapshot sent when the interval ends. The snapshot is
   * built at send time, so it always holds the latest state.
   */
  private markDirty(): void {
    if (this.timer !== undefined) return
    const wait = this.lastSent + this.interval - Date.now()
    if (wait <= 0) {
      this.flush()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, wait)
    // A pending broadcast must not keep the process alive at quit.
    this.timer.unref?.()
  }

  private flush(): void {
    this.lastSent = Date.now()
    try {
      this.options.broadcast((projectId) => this.snapshotFor(projectId))
    } catch (err) {
      this.log(`session registry: broadcast failed: ${errorText(err)}`)
    }
  }
}

function detailOf(e: SessionEntry): SessionDetail {
  const out: SessionDetail = {
    tabId: e.tabId,
    status: e.status,
    notes: [...e.notes],
    files: [...e.files],
    queue: e.queue.map((q) => ({ id: q.id, text: q.text }))
  }
  if (e.tool !== undefined) out.tool = e.tool
  if (e.lastPrompt !== undefined) out.lastPrompt = e.lastPrompt
  if (e.title !== undefined) out.title = e.title
  if (e.name !== undefined) out.name = e.name
  if (e.gist !== undefined) out.gist = e.gist
  if (e.steps !== undefined) out.steps = { ...e.steps }
  if (e.room !== undefined) out.room = { ...e.room }
  if (e.held !== undefined && e.held > 0) out.held = e.held
  if (e.typed) out.typed = true
  return out
}
