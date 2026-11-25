// The project has one tab order (main's TabManager.order) and two strips that show parts of it: the
// main tab area (tabs with no `dock`) and the Terminal panel (`dock: 'panel'`, design-terminal-panel.md
// §2 "One order", §13.6). Main's `tabs.reorder` takes an index into the full order; a strip only knows
// its own positions, so a drop or a Move left / right is mapped here to the full index of the tab's
// neighbour in that strip. A step past a docked tab hidden between two main tabs then moves the tab
// visibly, never into a slot the strip cannot show. Pure, so it is unit-tested without a window.
import type { TabInfo } from '../../shared/ipc'

/** Whether a tab lives in the Terminal panel (absent `dock`: the main tab area). */
export function isDocked(tab: Pick<TabInfo, 'dock'> | undefined): boolean {
  return tab?.dock === 'panel'
}

/** The tabs of one strip, in the one order. */
export function stripTabs<T extends Pick<TabInfo, 'dock'>>(tabs: readonly T[], panel: boolean): T[] {
  return tabs.filter((t) => isDocked(t) === panel)
}

/**
 * The full-order index for putting `moving` (one tab, or a group's block) at `toIndex` of its strip,
 * where `toIndex` counts the strip's OTHER tabs (the moving ones taken out first, as TabBar's drag and
 * main's reorder count). `strip` is the strip's ids in order (the moving ones included or not);
 * `full` the project's order. The tab lands right before the strip tab now at `toIndex`, or right
 * after the strip's last tab when `toIndex` is past its end; with no other tab in the strip, where it
 * already is. The answer counts the full order without the moving tabs, as main's `reorder` does.
 */
export function fullIndexOf(full: readonly string[], strip: readonly string[], moving: readonly string[], toIndex: number): number {
  const out = new Set(moving)
  const rest = full.filter((id) => !out.has(id))
  const others = strip.filter((id) => !out.has(id))
  if (others.length === 0) {
    // Nothing else in the strip to be beside: keep its place in the full order.
    const first = full.findIndex((id) => out.has(id))
    return first < 0 ? rest.length : full.slice(0, first).filter((id) => !out.has(id)).length
  }
  const at = Math.max(0, Math.min(others.length, Math.trunc(toIndex)))
  if (at < others.length) return rest.indexOf(others[at]!)
  return rest.indexOf(others[others.length - 1]!) + 1
}

/** The strip neighbour a Move left (-1) / right (+1) of `tabId` goes to, as a strip index for fullIndexOf; undefined at an end. */
export function stepIndex(strip: readonly string[], tabId: string, delta: -1 | 1): number | undefined {
  const from = strip.indexOf(tabId)
  if (from < 0) return undefined
  const to = from + delta
  if (to < 0 || to >= strip.length) return undefined
  return to
}
