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
 * A new snapshot took the selected tab out of the group it was a pane of: which tab the view shows
 * now, and whether its keys go off (D3, D18 as clarified by D24, D22). Undefined when the selection
 * stays as it is.
 *
 * - Still open and plain now (moved out, its group ungrouped or dissolved): the same tab stays shown.
 *   From elsewhere its keys go off; this view's own edit (`ownEdit`: an intent of this page names a
 *   member, such as moving the other of two panes out) keeps them on.
 * - Moved into another group elsewhere: the view does not follow it; it shows what is left of the
 *   old group on the pane that took its space (or the old group's remaining plain tab), keys off.
 * - Closed (not in main's `order` any more; the snapshot may beat the close event): the pane that
 *   took its space, or the one tab left of a two-pane group.
 *
 * `leave`: the person's own close or move out of this tab in this view: the pane that took its space,
 * keys on (they were looking at it). `stay`: the person's own placement or Ungroup of this tab;
 * nothing moves. Anything else came from elsewhere: no pane has the keys until a click or a chord
 * (keysOff; D18: no outline either, and no `tabs.selected` is sent meanwhile).
 */
export function selectionAfterSnapshot(
  before: readonly TabGroup[],
  after: readonly TabGroup[],
  order: readonly string[],
  activeId: string | null,
  intent: 'leave' | 'stay' | undefined,
  ownEdit = false
): { activeId: string; keysOff: boolean } | undefined {
  if (activeId === null || intent === 'stay') return undefined
  const was = groupOf(before, activeId)
  if (!was) return undefined
  const now = after.find((g) => g.id === was.id)
  if (now && leavesOf(now.root).includes(activeId)) return undefined
  // D24's D18: a view never follows its tab into an arrangement made elsewhere. Still open and plain
  // now (moved out, an Ungroup, the other of two panes moved out): that same tab stays shown. Moved
  // into another group: what is left of the old group, below.
  if (intent !== 'leave' && order.includes(activeId) && !groupOf(after, activeId)) {
    return ownEdit ? undefined : { activeId, keysOff: true }
  }
  const leftover = leavesOf(was.root).filter((t) => t !== activeId && order.includes(t))
  if (!now && leftover.length !== 1) return undefined
  const next = tookItsSpace(was.root, now?.root, activeId, leftover[0])
  if (next === undefined) return undefined
  return { activeId: next, keysOff: intent !== 'leave' }
}

/** What this view shows of its selection: the group (none for a plain tab), its zoomed pane, the visible panes. */
export interface PaneView {
  group?: TabGroup
  /** The one pane shown of the group, by this view's zoom or by D5's automatic zoom. */
  zoomTab?: string
  /** The automatic zoom (a narrow view), which the person cannot undo by the zoom chord. */
  auto: boolean
  /** Tabs drawn now: the active plain tab, or every visible pane of the group (possibly not held yet). */
  visible: string[]
}

/**
 * The panes this view shows: the selected tab's group, all of it or only its zoomed pane. Every pane
 * listed is laid out (and so takes the pty size on the person's gestures, D2); every other terminal
 * is display:none and takes nothing.
 */
export function paneView(
  groups: readonly TabGroup[],
  activeId: string | null,
  zoomed: Readonly<Record<string, string>>,
  autoZoom: (group: TabGroup) => boolean
): PaneView {
  if (activeId === null) return { auto: false, visible: [] }
  const group = groupOf(groups, activeId)
  if (!group) return { auto: false, visible: [activeId] }
  const own = zoomed[group.id]
  const auto = own === undefined && autoZoom(group)
  const zoomTab = own ?? (auto ? activeId : undefined)
  return zoomTab !== undefined ? { group, zoomTab, auto, visible: [zoomTab] } : { group, auto, visible: leavesOf(group.root) }
}

/**
 * D23 R2: main asks the page to select a tab (`tabs.select`: a plugin's `sessions.focus`, or its
 * `beside` + `focus: true` naming the anchor) while this view's keys are off. Main's idea of the
 * view's selection is stale then (a keys-off view sends no `tabs.selected`), so a select of a pane
 * the view already shows is no reason to give a terminal the keys: it is ignored, keys stay off.
 * Anything else (a tab not on screen) is selected as usual.
 */
export function ignoresMainSelect(keysOff: boolean, visible: readonly string[], tabId: string): boolean {
  return keysOff && visible.includes(tabId)
}
