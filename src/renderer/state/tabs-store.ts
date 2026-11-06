// Renderer-side tab list: a pure reducer, so the selection rules are unit-testable without a DOM.
// main owns the real list and its order (src/main/tabs/tab-manager.ts); this mirrors it after each
// invoke that succeeded, plus the `tabs.exit`, `tabs.added` and `tabs.removed` events. A tab's
// flag comes the same way: main answers `tabs.flag` / `tabs.toggleFlag` with the flag as stored.
import type { TabInfo } from '../../shared/ipc'
import type { TabFlag } from '../../shared/tab-flag'

type Exit = NonNullable<TabInfo['exit']>

/** An exit main reported, with the generation (TabInfo.gen) of the process that ended. */
export interface GenExit {
  exit: Exit
  gen: number
}

export interface TabsState {
  tabs: TabInfo[]
  /** The selected tab; null only while there are no tabs. */
  activeId: string | null
  /**
   * Exits of a process newer than the tab the renderer holds, or of a tab it has not seen yet.
   * `tabs.create` resolves after the PTY started, so a command that dies at once (a missing shell,
   * `claude` not installed) can send `tabs.exit` first; a restarted process that dies at once can
   * beat the `tabs.restart` reply the same way. Without this the tab would never show its exited
   * banner (and Restart button) again.
   */
  earlyExits: Record<string, GenExit>
  /** The `tabs.list` answer was applied; a later `loaded` repeats an older snapshot. */
  listed: boolean
  /**
   * Tabs this page closed before the list answered. The list may have been taken before the close
   * (main awaits the login env and the restore first) and must not bring a killed tab back.
   */
  closedEarly: string[]
  /**
   * Tabs main closed on a clean exit (`tabs.removed`) before this page held them, by the
   * generation that exited. A process that exits at once can beat the `tabs.create` or
   * `tabs.restart` reply (see earlyExits), and that reply must not bring the closed tab back. Kept
   * until a snapshot of that tab arrives; one that never does costs an id.
   */
  removedEarly: Record<string, number>
}

/**
 * Every main snapshot of a tab (the list, create and restart replies, `tabs.added`) and every exit
 * is merged by generation instead of replacing what is there: replies and events can arrive in
 * any order, and an older snapshot must not undo a newer fact (a delayed list dropping a tab
 * announced after it was taken, a restart reply clearing the exit of the process it started).
 */
export type TabsAction =
  /**
   * `tabs.list` answered (page load): main's order, then the tabs this page learned of after the
   * snapshot (announced, or created by the user meanwhile); the selection stays when it survives.
   */
  | { type: 'loaded'; tabs: TabInfo[] }
  /** `tabs.create` answered: append and select. */
  | { type: 'added'; tab: TabInfo }
  /**
   * main started a tab on its own (`tabs.added`, a plugin's ctx.sessions.open): append, but keep
   * the selection (the user may be typing in another tab); only an empty window selects it.
   */
  | { type: 'announced'; tab: TabInfo }
  /** `tabs.restart` answered: same id, a newer generation; selection and position unchanged. */
  | { type: 'restarted'; tab: TabInfo }
  | { type: 'closed'; tabId: string }
  /**
   * main closed the tab itself (`tabs.removed`: process `gen` exited cleanly). Like 'closed' for a
   * tab held at that generation or an older one; remembered for a tab not held yet.
   */
  | { type: 'removed'; tabId: string; gen: number }
  | { type: 'selected'; tabId: string }
  /** Mirror of main's reorder: move to `toIndex`, clamped to the ends. */
  | { type: 'moved'; tabId: string; toIndex: number }
  | { type: 'exited'; tabId: string; exit: Exit; gen: number }
  /**
   * main stored the tab's flag (`null`: cleared), as its `tabs.flag` reply says. Not by
   * generation: a flag belongs to the tab, not to a process, and only this page sets it.
   */
  | { type: 'flagged'; tabId: string; flag: TabFlag | null }

export const initialTabsState: TabsState = {
  tabs: [],
  activeId: null,
  earlyExits: {},
  listed: false,
  closedEarly: [],
  removedEarly: {}
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'loaded': {
      // The list is asked for once per page load (TabsPane attachTabs); a second dispatch (a
      // StrictMode remount reusing the answer) carries the same, by now older, snapshot.
      if (state.listed) return state
      const earlyExits = { ...state.earlyExits }
      const removedEarly = { ...state.removedEarly }
      const known = new Map(state.tabs.map((t) => [t.id, t]))
      const listedIds = new Set(action.tabs.map((t) => t.id))
      const tabs = [
        ...action.tabs
          .filter((t) => !state.closedEarly.includes(t.id) && !removedBefore(t, removedEarly))
          .map((t) => settle(newer(known.get(t.id), t), earlyExits)),
        // Not in the list: announced or created after it was taken. A tab that closed since
        // (this page's Close, or main's `tabs.removed`) has already left `state.tabs`, so a tab
        // held here is still alive.
        ...state.tabs.filter((t) => !listedIds.has(t.id))
      ]
      const keep = tabs.some((t) => t.id === state.activeId)
      return {
        tabs,
        activeId: keep ? state.activeId : (tabs[0]?.id ?? null),
        earlyExits,
        listed: true,
        closedEarly: [],
        removedEarly
      }
    }
    case 'added':
    case 'announced': {
      const removedEarly = { ...state.removedEarly }
      if (removedBefore(action.tab, removedEarly)) return { ...state, removedEarly }
      const earlyExits = { ...state.earlyExits }
      const existing = state.tabs.find((t) => t.id === action.tab.id)
      const tab = settle(newer(existing, action.tab), earlyExits)
      const tabs = existing ? state.tabs.map((t) => (t.id === tab.id ? tab : t)) : [...state.tabs, tab]
      const activeId = action.type === 'added' ? tab.id : (state.activeId ?? tab.id)
      return { ...state, tabs, activeId, earlyExits }
    }
    case 'restarted': {
      const existing = state.tabs.find((t) => t.id === action.tab.id)
      // Not held: closed by this page, or by main (a restarted process that exited cleanly at once
      // sends `tabs.removed` before this reply), so there is nothing to restart.
      if (!existing) return state
      const earlyExits = { ...state.earlyExits }
      const tab = settle(newer(existing, action.tab), earlyExits)
      return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? tab : t)), earlyExits }
    }
    case 'closed': {
      const index = state.tabs.findIndex((t) => t.id === action.tabId)
      if (index < 0) return state
      const tabs = state.tabs.filter((t) => t.id !== action.tabId)
      const closedEarly = state.listed ? state.closedEarly : [...state.closedEarly, action.tabId]
      if (state.activeId !== action.tabId) return { ...state, tabs, closedEarly }
      // The tab that slides into the closed one's place (its right neighbour), else the left one.
      const next = tabs[index] ?? tabs[index - 1]
      return { ...state, tabs, closedEarly, activeId: next?.id ?? null }
    }
    case 'removed': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      if (!tab) {
        // Not held yet: its create / list / announce snapshot is still on the way.
        const held = state.removedEarly[action.tabId]
        if (held !== undefined && held >= action.gen) return state
        return { ...state, removedEarly: { ...state.removedEarly, [action.tabId]: action.gen } }
      }
      // main closes only the current process's tab and a closed tab never restarts, so a held
      // generation newer than the removal cannot happen; ignored rather than trusted if it does.
      if (action.gen < tab.gen) return state
      const earlyExits = { ...state.earlyExits }
      delete earlyExits[action.tabId]
      return tabsReducer({ ...state, earlyExits }, { type: 'closed', tabId: action.tabId })
    }
    case 'selected':
      if (state.activeId === action.tabId || !state.tabs.some((t) => t.id === action.tabId)) {
        return state
      }
      return { ...state, activeId: action.tabId }
    case 'moved': {
      const from = state.tabs.findIndex((t) => t.id === action.tabId)
      if (from < 0) return state
      const to = Math.max(0, Math.min(state.tabs.length - 1, action.toIndex))
      if (to === from) return state
      const tabs = [...state.tabs]
      const [tab] = tabs.splice(from, 1)
      tabs.splice(to, 0, tab!)
      return { ...state, tabs }
    }
    case 'flagged': {
      if (!state.tabs.some((t) => t.id === action.tabId)) return state
      const tabs = state.tabs.map((t) => {
        if (t.id !== action.tabId) return t
        const next = { ...t }
        if (action.flag === null) delete next.flag
        else next.flag = { ...action.flag }
        return next
      })
      return { ...state, tabs }
    }
    case 'exited': {
      const tab = state.tabs.find((t) => t.id === action.tabId)
      if (!tab || action.gen > tab.gen) {
        // Its tab, or the snapshot of the process that ended, has not arrived yet: held until then.
        const held = state.earlyExits[action.tabId]
        if (held && held.gen > action.gen) return state
        return {
          ...state,
          earlyExits: { ...state.earlyExits, [action.tabId]: { exit: action.exit, gen: action.gen } }
        }
      }
      // An earlier process of a tab that has been restarted since.
      if (action.gen < tab.gen) return state
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.tabId ? { ...t, exit: action.exit } : t))
      }
    }
  }
}

/**
 * The newer of two snapshots of one tab: the later generation, and within one generation the one
 * with the exit (a process that ended stays ended; a snapshot without it was taken before).
 */
function newer(existing: TabInfo | undefined, incoming: TabInfo): TabInfo {
  if (!existing || incoming.gen > existing.gen) return incoming
  if (incoming.gen < existing.gen) return existing
  return existing.exit && !incoming.exit ? { ...incoming, exit: existing.exit } : incoming
}

/**
 * Whether main already removed this snapshot's tab (`tabs.removed` for this generation or a later
 * one), consuming the record: the snapshot was taken before the removal.
 */
function removedBefore(tab: TabInfo, removed: Record<string, number>): boolean {
  const gen = removed[tab.id]
  if (gen === undefined) return false
  delete removed[tab.id]
  return gen >= tab.gen
}

/**
 * Fold a held exit into a tab that just arrived or moved to a newer generation, consuming it from
 * `early`. One of an older generation is dropped; one of a newer generation stays held.
 */
function settle(tab: TabInfo, early: Record<string, GenExit>): TabInfo {
  const held = early[tab.id]
  if (!held || held.gen > tab.gen) return tab
  delete early[tab.id]
  if (held.gen < tab.gen || tab.exit) return tab
  return { ...tab, exit: held.exit }
}
