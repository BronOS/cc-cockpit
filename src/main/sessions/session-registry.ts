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
import type { SessionDetail, SessionsSnapshot, SessionStripEntry } from '../../shared/ipc'
import type { ProjectColor } from '../../shared/project-color'
import type { TabKind } from '../../shared/types'
import { exitStatus } from '../pty/pty-backend'
import * as gate from './send-gate'
import { isAnswerKey, newEntry, reduce, withNote, withSteps, type QueuedText, type ReducerEvent, type SessionEntry } from './status-reducer'

/** At most this many snapshots per second (plan: throttled to 10/s). */
const DEFAULT_INTERVAL_MS = 100

/** What a subscriber hears about one tab. `entry` is undefined once the tab is gone. */
export interface SessionChange {
  tabId: string
  entry: SessionEntry | undefined
  prev: SessionEntry | undefined
  /**
   * Queued texts thrown away by this change because the session ended or the tab closed, oldest
   * first (the plan's "queue cleared (and reported)"). Absent when nothing was dropped.
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
  /** The display name of a project, for the strip; read at each snapshot so a rename shows. */
  projectName(projectId: string): string | undefined
  /**
   * The project's colour, for the strip's dot; read at each snapshot like the name. A change does
   * not touch any entry, so whoever stores one calls `refresh()` to send the snapshot again.
   */
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
  log?: (message: string) => void
}

export class SessionRegistry {
  /** Insertion order = tab creation order, which is what the strip's stable sort relies on. */
  private readonly entries = new Map<string, SessionEntry>()
  private readonly listeners = new Set<(change: SessionChange) => void>()
  private readonly interval: number
  private readonly log: (message: string) => void
  private lastSent = -Infinity
  private timer: ReturnType<typeof setTimeout> | undefined
  /** tabId -> the timer of the delivery in flight (at most one per tab: `delivering`). */
  private readonly deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly deliveringTimeout: number

  constructor(private readonly options: SessionRegistryOptions) {
    this.interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.deliveringTimeout = options.deliveringTimeoutMs ?? gate.DELIVERING_TIMEOUT_MS
    this.log = options.log ?? ((m) => console.warn(m))
  }

  /**
   * A tab's process just started (a new tab, or a restart of an exited one). Only Claude tabs get
   * an entry. A restart replaces the old entry with a fresh `starting` one (same place in the
   * order) but keeps the session id: the restart resumes that session, and SessionStart reports
   * it again. The old process's queue was already dropped at its exit; its delivery timer must
   * not outlive it and clear a `delivering` flag of the new process.
   */
  tabStarted(tab: { tabId: string; projectId: string; kind: TabKind; cwd: string }): void {
    if (tab.kind !== 'claude') return
    const prev = this.entries.get(tab.tabId)
    this.clearDeliveryTimer(tab.tabId)
    this.set(prev, newEntry({ ...tab, sessionId: prev?.sessionId }))
  }

  /**
   * Apply a hook event the socket delivered for `tabId`. Synchronous on purpose: the caller (the
   * `hook` socket handler) must call this before any `await`, so two hooks from one connection
   * cannot be reordered (see status-reducer.ts). False when the tab has no entry.
   */
  applyHook(tabId: string, event: HookEvent, payload: unknown): boolean {
    return this.apply(tabId, { type: 'hook', event, payload })
  }

  /**
   * The user typed into the tab (renderer keystrokes only, never the gate's own paste). A key that
   * answers a permission dialog moves a `needs-permission` tab to `working` (status-reducer.ts
   * isAnswerKey says why and which keys). `projectId` is the window's project as main resolved it:
   * a tab of another project is ignored, as TabManager.input ignores it.
   */
  userInput(projectId: string, tabId: string, data: string): void {
    const entry = this.entries.get(tabId)
    if (!entry || entry.projectId !== projectId || !isAnswerKey(data)) return
    this.apply(tabId, { type: 'answer' })
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
   * (send-gate.ts prepareText).
   */
  send(tabId: string, text: string): SendResult {
    const prev = this.entries.get(tabId)
    if (!prev) throw new Error('unknown tab')
    const item: QueuedText = { id: randomUUID(), text: gate.prepareText(text) }
    const step = gate.send(prev, item)
    const entry = this.commit(prev, step)
    // Delivered only when this very item left the queue and was not put back by a failed write.
    return { id: item.id, delivered: step.delivered === item && !entry.queue.includes(item) }
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
   * The view of a window that shows `projectId`: the strip fields of every Claude tab, and the
   * full detail of that project's tabs only (plan: "a window gets full entries only for its own
   * project's tabs"). Built from explicit fields, never by spreading an entry, so a field added
   * to SessionEntry later (cwd, projectId, a token) is not exposed by accident.
   */
  snapshotFor(projectId: string): SessionsSnapshot {
    const entries = this.list()
    return {
      strip: entries.map((e) => {
        const out: SessionStripEntry = {
          tabId: e.tabId,
          projectName: this.options.projectName(e.projectId) ?? '',
          status: e.status
        }
        const color = this.options.projectColor?.(e.projectId)
        if (color !== undefined) out.projectColor = color
        if (e.tool !== undefined) out.tool = e.tool
        return out
      }),
      own: entries.filter((e) => e.projectId === projectId).map(detailOf)
    }
  }

  /**
   * Send the snapshot again although no entry changed: something it reads from outside (a
   * project's colour) did. Through the same throttle as every change, so it is one more send at
   * most, and a window with no Claude tab of its own still hears about other projects' colours.
   */
  refresh(): void {
    this.markDirty()
  }

  /** Cancel a pending trailing broadcast and every delivery timer (app quit). */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer)
    this.deliveryTimers.clear()
    this.listeners.clear()
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
        entry = { ...entry, queue: [step.delivered, ...entry.queue], delivering: false }
      }
    }
    if (!entry.delivering) this.clearDeliveryTimer(entry.tabId)
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
  if (e.steps !== undefined) out.steps = { ...e.steps }
  return out
}
