// Presence (design-guests §10, shared/design.md §16.7): who is in a project and where, for the avatars on tabs,
// the guest list and the guest's own banner. Main only, never saved, never given to plugins in v1.
//
// One person per identity, not per view: the owner is every owner view of the project (the desktop window
// and owner browsers); a guest is its device's views. A person's tab is the one its most recently active view
// shows (the view that last selected a tab or typed). `typing` is keys in the last 2 s. A person whose last
// view left is `reconnecting` for RECONNECT_GRACE_MS (a phone switching networks), then `away`.
//
// Whole snapshots, never deltas (a reconnecting page needs only the latest), at most 4 a second per project
// (`MIN_EMIT_MS`, trailing: the last change always goes out). Every view of the project gets the same snapshot
// through the registry; a guest's sink filters it (guest-events.ts GUEST_EVENT `presence.changed` =
// shared/guest-filter.ts `guestPresence`: a tab the guest cannot see becomes `null` + `elsewhere`).
// `snapshotFor` (the `presence.get` invoke) applies the same filter for a guest view.
//
// No Electron import; timers and the clock are deps, so the tests run on a fake clock.

import type { PresencePerson, PresenceSnapshot } from '../../shared/guests'
import type { GuestRole, ViewId, Who } from '../../shared/views'
import type { PresenceService } from '../ipc/guest-deps'

/** Keys within this long make a person "typing". */
export const TYPING_MS = 2000
/** A person whose last view left is "reconnecting" this long before "away". */
export const RECONNECT_GRACE_MS = 5000
/** At most one `presence.changed` per project this often (4 a second). */
export const MIN_EMIT_MS = 250
/** Palette size: `PresencePerson.color` is 0..PALETTE-1. */
export const PALETTE = 8

/** A stable palette index for a person id: the owner is 0, a guest a hash of its id over the other seven. */
export function presenceColor(id: string): number {
  if (id === 'owner') return 0
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return 1 + (h % (PALETTE - 1))
}

export interface PresenceDeps {
  /** The owner's name (Web access setting, D-24, default "Host"). */
  ownerName(): string
  /** The project's live guests (GuestStore.guestsOf): every one is a person, with a view or not. */
  guestsOf(projectId: string): Array<{ id: string; name: string; role: GuestRole }>
  /** Send the project's snapshot to every view of it (ViewRegistry.toProject 'presence.changed'). */
  emit(projectId: string, snapshot: PresenceSnapshot): void
  /**
   * For `snapshotFor`: the guest filter for a guest view (shared/guest-filter.ts `guestPresence` with that view's
   * context), undefined for an owner view, `'revoked'` for a view whose guest is gone (gets nobody).
   */
  filterFor(viewId: ViewId, who: Who): ((s: PresenceSnapshot) => PresenceSnapshot) | 'revoked' | undefined
  log(message: string): void
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

interface ViewState {
  projectId: string
  person: string
  who: Who
  tabId: string | null
  /** When this view last selected a tab or typed (its person's most recent view wins). */
  activeAt: number
}

interface PersonState {
  /** When the last view left; undefined while the person has a view. */
  leftAt?: number
  typedAt?: number
}

interface ProjectState {
  people: Map<string, PersonState>
  lastTyped: Map<string, string>
  seq: number
  lastEmitAt: number
  timer?: unknown
  /** The next state change no event will announce (typing ending, the grace running out). */
  wake?: unknown
}

const personOfWho = (who: Who): string => (who === 'owner' ? 'owner' : who.guest)

export class Presence implements PresenceService {
  private readonly views = new Map<ViewId, ViewState>()
  private readonly projects = new Map<string, ProjectState>()
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: PresenceDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer =
      deps.setTimeout ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms)
        t.unref?.()
        return t
      })
    this.clearTimer = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  // -------------------------------------------------------------------------------------------
  // Inputs (index.ts wires them to the registry, the router's viewSelect and TabManager.viewInput)

  /** A view joined a project window (the desktop's own view included: the owner). */
  viewJoined(viewId: ViewId, projectId: string, who: Who): void {
    const person = personOfWho(who)
    this.views.set(viewId, { projectId, person, who, tabId: null, activeAt: this.now() })
    const p = this.project(projectId)
    const s = p.people.get(person) ?? {}
    delete s.leftAt
    p.people.set(person, s)
    this.changed(projectId)
  }

  /** A view left (closed, dropped, its window gone). */
  viewLeft(viewId: ViewId): void {
    const v = this.views.get(viewId)
    if (!v) return
    this.views.delete(viewId)
    const p = this.project(v.projectId)
    if (!this.hasView(v.projectId, v.person)) {
      const s = p.people.get(v.person) ?? {}
      s.leftAt = this.now()
      p.people.set(v.person, s)
    }
    this.changed(v.projectId)
  }

  /** A view shows this tab now (the router's viewSelect, after its own checks). */
  viewSelected(viewId: ViewId, tabId: string | null): void {
    const v = this.views.get(viewId)
    if (!v) return
    v.tabId = tabId
    v.activeAt = this.now()
    this.changed(v.projectId)
  }

  /** The person behind a view typed into a tab (TabManager.viewInput: a person's input only, never a report). */
  typed(viewId: ViewId, tabId: string): void {
    const v = this.views.get(viewId)
    if (!v) return
    const now = this.now()
    v.activeAt = now
    v.tabId = tabId
    const p = this.project(v.projectId)
    const s = p.people.get(v.person) ?? {}
    const wasTyping = s.typedAt !== undefined && now - s.typedAt < TYPING_MS
    s.typedAt = now
    p.people.set(v.person, s)
    const before = p.lastTyped.get(tabId)
    p.lastTyped.set(tabId, v.person)
    // Keys while already typing on the same tab change nothing a snapshot shows: no emit for every key.
    if (wasTyping && before === v.person) return
    this.changed(v.projectId)
  }

  /** A tab is gone: it leaves `lastTyped` and every view showing it shows none. */
  tabClosed(tabId: string): void {
    for (const [projectId, p] of this.projects) {
      let touched = p.lastTyped.delete(tabId)
      for (const v of this.views.values()) {
        if (v.projectId === projectId && v.tabId === tabId) {
          v.tabId = null
          touched = true
        }
      }
      if (touched) this.changed(projectId)
    }
  }

  /** The guests (or the owner's name) changed: every project's people are re-read. */
  peopleChanged(): void {
    for (const projectId of this.projects.keys()) this.changed(projectId)
  }

  /** A project's window closed: its state goes (views leave on their own). */
  projectClosed(projectId: string): void {
    const p = this.projects.get(projectId)
    if (!p) return
    if (p.timer !== undefined) this.clearTimer(p.timer)
    if (p.wake !== undefined) this.clearTimer(p.wake)
    this.projects.delete(projectId)
  }

  dispose(): void {
    for (const id of [...this.projects.keys()]) this.projectClosed(id)
  }

  // -------------------------------------------------------------------------------------------
  // Answers

  /** The project's snapshot now, unfiltered (the owner's views). */
  snapshot(projectId: string): PresenceSnapshot {
    const p = this.project(projectId)
    const now = this.now()
    const people: PresencePerson[] = []
    const person = (id: string, name: string, role: PresencePerson['role']): void => {
      const s = p.people.get(id)
      const live = this.hasView(projectId, id)
      const state: PresencePerson['state'] = live
        ? 'live'
        : s?.leftAt !== undefined && now - s.leftAt < RECONNECT_GRACE_MS
          ? 'reconnecting'
          : 'away'
      people.push({
        id,
        name,
        role,
        color: presenceColor(id),
        state,
        tabId: live ? this.tabOf(projectId, id) : null,
        typing: live && s?.typedAt !== undefined && now - s.typedAt < TYPING_MS
      })
    }
    person('owner', this.ownerName(), 'owner')
    for (const g of this.guests(projectId)) person(g.id, g.name, g.role)
    return { seq: p.seq, people, lastTyped: Object.fromEntries(p.lastTyped) }
  }

  snapshotFor(viewId: ViewId): PresenceSnapshot {
    const v = this.views.get(viewId)
    if (!v) return { seq: 0, people: [], lastTyped: {} }
    const s = this.snapshot(v.projectId)
    let filter: ReturnType<PresenceDeps['filterFor']>
    try {
      filter = this.deps.filterFor(viewId, v.who)
    } catch (err) {
      this.deps.log(`presence: filter failed: ${String(err)}`)
      filter = 'revoked'
    }
    if (filter === 'revoked') return { seq: s.seq, people: [], lastTyped: {} }
    return filter ? filter(s) : s
  }

  /** The name of the person behind a view (GuestFilterContext.personOf; TabInfo.typedBy for guests). */
  personOf(viewId: string | null): string | undefined {
    if (viewId === null) return undefined
    const v = this.views.get(viewId as ViewId)
    if (!v) return undefined
    if (v.person === 'owner') return this.ownerName()
    return this.guests(v.projectId).find((g) => g.id === v.person)?.name
  }

  // -------------------------------------------------------------------------------------------
  // Internals

  private ownerName(): string {
    try {
      return this.deps.ownerName()
    } catch {
      return 'Host'
    }
  }

  private guests(projectId: string): Array<{ id: string; name: string; role: GuestRole }> {
    try {
      return this.deps.guestsOf(projectId)
    } catch (err) {
      this.deps.log(`presence: guest list failed: ${String(err)}`)
      return []
    }
  }

  private project(projectId: string): ProjectState {
    let p = this.projects.get(projectId)
    if (!p) {
      p = { people: new Map(), lastTyped: new Map(), seq: 0, lastEmitAt: -Infinity }
      this.projects.set(projectId, p)
    }
    return p
  }

  private hasView(projectId: string, person: string): boolean {
    for (const v of this.views.values()) if (v.projectId === projectId && v.person === person) return true
    return false
  }

  /** The tab the person's most recently active view shows. */
  private tabOf(projectId: string, person: string): string | null {
    let best: ViewState | undefined
    for (const v of this.views.values()) {
      if (v.projectId !== projectId || v.person !== person) continue
      if (!best || v.activeAt >= best.activeAt) best = v
    }
    return best?.tabId ?? null
  }

  /** Something changed: emit now, or at the end of the 250 ms window (one trailing emit). */
  private changed(projectId: string): void {
    const p = this.project(projectId)
    if (p.timer !== undefined) return
    const wait = p.lastEmitAt + MIN_EMIT_MS - this.now()
    if (wait <= 0) return this.emit(projectId)
    p.timer = this.setTimer(() => {
      p.timer = undefined
      this.emit(projectId)
    }, wait)
  }

  private emit(projectId: string): void {
    const p = this.projects.get(projectId)
    if (!p) return
    p.seq++
    p.lastEmitAt = this.now()
    const snap = this.snapshot(projectId)
    try {
      this.deps.emit(projectId, snap)
    } catch (err) {
      this.deps.log(`presence: emit failed: ${String(err)}`)
    }
    this.scheduleWake(projectId)
  }

  /** The next change that no input announces: someone's typing ends, or a reconnect grace runs out. */
  private scheduleWake(projectId: string): void {
    const p = this.projects.get(projectId)
    if (!p) return
    if (p.wake !== undefined) this.clearTimer(p.wake)
    p.wake = undefined
    const now = this.now()
    let next = Infinity
    for (const s of p.people.values()) {
      if (s.typedAt !== undefined && now - s.typedAt < TYPING_MS) next = Math.min(next, s.typedAt + TYPING_MS)
      if (s.leftAt !== undefined && now - s.leftAt < RECONNECT_GRACE_MS) next = Math.min(next, s.leftAt + RECONNECT_GRACE_MS)
    }
    if (next === Infinity) return
    p.wake = this.setTimer(() => {
      p.wake = undefined
      this.changed(projectId)
    }, Math.max(0, next - now))
  }
}
