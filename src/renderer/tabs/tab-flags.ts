// The renderer's rules for tab flags (shared/tab-flag.ts has the model main owns), DOM-free so
// unit tests load them: TabBar.tsx and TabSwitcher.tsx draw from these.
import type { TabInfo, TabStatus } from '../../shared/ipc'

/**
 * The "All tabs" menu's order: flagged tabs first, then the rest, each part in strip order. The
 * menu is what a crowded strip leaves to reach a hidden tab, and a flagged tab is the one the
 * person must not lose; strip order inside each part keeps the list predictable.
 */
export function allTabsOrder(tabs: readonly TabInfo[]): TabInfo[] {
  return [...tabs.filter((t) => t.flag !== undefined), ...tabs.filter((t) => t.flag === undefined)]
}

/**
 * Which flagged Claude tabs pulse for attention after a sessions snapshot: those that just became
 * `waiting` (waiting for input: Claude is done and needs the person) while another tab was
 * selected. A tab stays in the set until the person selects it, its flag goes or it closes, so a
 * reminder is not lost because Claude moved on (a plugin's queued text started a new turn).
 *
 * `seen` is each tab's status at the previous call. A tab first seen already waiting does not
 * start pulsing: that is a page load (a reload, a window reopened), not a change, and every
 * flagged tab of a reopened window would pulse at once. A restored tab still pulses when it gets
 * there: it starts as `starting`.
 */
export function nextAttention(
  prev: ReadonlySet<string>,
  seen: ReadonlyMap<string, TabStatus>,
  tabs: readonly TabInfo[],
  statusOf: (tabId: string) => TabStatus | undefined,
  activeId: string | null
): Set<string> {
  const out = new Set<string>()
  for (const tab of tabs) {
    if (tab.flag === undefined || tab.kind !== 'claude' || tab.id === activeId) continue
    const status = statusOf(tab.id)
    const before = seen.get(tab.id)
    const became = status === 'waiting' && before !== undefined && before !== 'waiting'
    if (prev.has(tab.id) || became) out.add(tab.id)
  }
  return out
}

/** Every tab's status now, for the next nextAttention call. */
export function statusesOf(tabs: readonly TabInfo[], statusOf: (tabId: string) => TabStatus | undefined): Map<string, TabStatus> {
  const out = new Map<string, TabStatus>()
  for (const tab of tabs) {
    const status = statusOf(tab.id)
    if (status !== undefined) out.set(tab.id, status)
  }
  return out
}

/** Two sets hold the same ids (so a render can keep the old one and React skips the update). */
export function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) if (!b.has(id)) return false
  return true
}
