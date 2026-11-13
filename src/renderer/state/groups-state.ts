// The split view's part of the page's tab state (tabs-store.ts), kept apart so the 260-line
// reducer only wires it. Main owns the groups (`groups.changed`, shared/tab-groups.ts); what is
// here is this view's own: which group it shows (the group of its selected tab), the last focused
// pane of each group, a zoomed pane per group, and whether its keys are off (D3).
import type { TabInfo } from '../../shared/ipc'
import { contiguousOrder, groupOf, leavesOf, type TabGroup } from '../../shared/tab-groups'
import { tookItsSpace } from '../tabs/pane-layout'

/** Per-view split state (never sent to main, never saved: D13 says zoom is never saved). */
export interface GroupsViewState {
  groups: TabGroup[]
  /** The newest `groups.changed` applied; an older one is dropped. -1 before the first. */
  groupsSeq: number
  /** groupId -> the pane this view zoomed (⌘⇧Enter). Per view, gone with the group or the pane. */
  zoomed: Record<string, string>
  /** groupId -> the pane this view last focused there; selecting the group by its handle returns to it. */
  lastFocus: Record<string, string>
  /**
   * D3: something done elsewhere (another view, a plugin, a process exit) took this view's focused
   * pane away. The view still shows the group (a pane is selected for the strip and for main), but no
   * terminal has the keyboard until the person clicks a pane or uses a chord: keys typed meanwhile
   * must never land in a terminal the person did not choose, where they could answer a Claude prompt.
   */
  keysOff: boolean
}

export const initialGroupsView: GroupsViewState = {
  groups: [],
  groupsSeq: -1,
  zoomed: {},
  lastFocus: {},
  keysOff: false
}

/**
 * `tabs` in main's `order`; a held tab the snapshot does not name (created here after main took it)
 * stays right after the tab it followed. A tab named but not held is main's news the page has not
 * had yet (its pane draws "starting").
 */
export function applyOrder(tabs: readonly TabInfo[], order: readonly string[]): TabInfo[] {
  const pos = new Map<string, number>()
  order.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, i)
  })
  const out = tabs.filter((t) => pos.has(t.id)).sort((a, b) => pos.get(a.id)! - pos.get(b.id)!)
  tabs.forEach((t, i) => {
    if (pos.has(t.id)) return
    const prev = i > 0 ? tabs[i - 1]!.id : undefined
    const at = prev === undefined ? -1 : out.findIndex((o) => o.id === prev)
    out.splice(at + 1, 0, t)
  })
  return out
}

/**
 * Keep every group's members together in leaf order (contiguousOrder), as main does: a tab that
 * arrives after the snapshot placing it (a split's create reply, `tabs.added`) is appended at the end
 * by the plain reducer and must join its block.
 */
export function keepContiguous(tabs: TabInfo[], groups: readonly TabGroup[]): TabInfo[] {
  if (groups.length === 0) return tabs
  const order = contiguousOrder(
    tabs.map((t) => t.id),
    groups
  )
  if (order.every((id, i) => tabs[i]?.id === id)) return tabs
  return applyOrder(tabs, order)
}

/**
 * Drop per-view entries that no longer apply: a zoom or a remembered focus for a group that is gone
 * or a pane no longer in it.
 */
export function pruneView(groups: readonly TabGroup[], zoomed: Record<string, string>, lastFocus: Record<string, string>): {
  zoomed: Record<string, string>
  lastFocus: Record<string, string>
} {
  const members = new Map(groups.map((g) => [g.id, new Set(leavesOf(g.root))]))
  const keep = (rec: Record<string, string>): Record<string, string> => {
    let changed = false
    const out: Record<string, string> = {}
    for (const [gid, tab] of Object.entries(rec)) {
      if (members.get(gid)?.has(tab)) out[gid] = tab
      else changed = true
    }
    return changed ? out : rec
  }
  return { zoomed: keep(zoomed), lastFocus: keep(lastFocus) }
}

/**
 * A new snapshot took the selected tab out of the group it was a pane of: which tab the view selects
 * now, and whether its keys go off (D3). Undefined when the selection stays.
 *
 * - Closed (not in main's `order` any more; the snapshot may beat the close event): the pane that
 *   took its space, or the one member left of a dissolved group.
 * - Moved out of a group that still stands (to the strip or another group): this view keeps showing
 *   the group, on the pane that took its space.
 * - Its group dissolved while it lives (Ungroup, or the other pane of two moved out): it stays
 *   selected. The same terminal keeps the keys, so nothing reaches a terminal the person did not
 *   choose, and the two cases cannot be told apart from the snapshot.
 *
 * `leave`: the person's own close or move out in this view; the keys stay on (they were looking at
 * it). `stay`: the person's own placement of this tab (Show beside, a drag); nothing moves.
 * Anything else came from elsewhere: keys off until a click or a chord.
 */
export function selectionAfterSnapshot(
  before: readonly TabGroup[],
  after: readonly TabGroup[],
  order: readonly string[],
  activeId: string | null,
  intent: 'leave' | 'stay' | undefined
): { activeId: string; keysOff: boolean } | undefined {
  if (activeId === null || intent === 'stay') return undefined
  const was = groupOf(before, activeId)
  if (!was) return undefined
  const now = after.find((g) => g.id === was.id)
  if (now && leavesOf(now.root).includes(activeId)) return undefined
  const alive = order.includes(activeId)
  if (!now && alive) return undefined
  const leftover = leavesOf(was.root).filter((t) => t !== activeId && order.includes(t))
  if (!now && leftover.length !== 1) return undefined
  const next = tookItsSpace(was.root, now?.root, activeId, leftover[0])
  if (next === undefined) return undefined
  return { activeId: next, keysOff: intent !== 'leave' }
}
