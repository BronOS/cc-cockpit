// The tab strip's split groups (design.md §1 "Strip and ways in/out"; decisions D9): a group is a
// bracketed segment of its members with a handle, and every member keeps its own tab (dot, tint,
// flag, ×). Pure, so the segmenting and the handle's words are unit-tested without a DOM.
import type { TabInfo, TabStatus } from '../../shared/ipc'
import { groupOf, leavesOf, type TabGroup } from '../../shared/tab-groups'
import { statusLabel } from '../status/strip-order'

/** A run of the strip: one plain tab, or a group's members (contiguous in the order, main keeps them so). */
export interface StripRun {
  group?: TabGroup
  tabs: TabInfo[]
}

/**
 * The strip in runs. A group whose members are not contiguous (a snapshot and a tab event crossing)
 * gets one segment per run; the next snapshot joins them.
 */
export function stripRuns(tabs: readonly TabInfo[], groups: readonly TabGroup[]): StripRun[] {
  const out: StripRun[] = []
  for (const tab of tabs) {
    const g = groupOf(groups, tab.id)
    const last = out[out.length - 1]
    if (g && last?.group === g) last.tabs.push(tab)
    else out.push(g ? { group: g, tabs: [tab] } : { tabs: [tab] })
  }
  return out
}

/** A group's name as the strip shows it: the person's name, else "Split". */
export function groupTitle(group: TabGroup): string {
  return group.name ?? 'Split'
}

/** The statuses a person must not miss, in words (role 6: never colour alone). */
const ASK: ReadonlySet<TabStatus> = new Set<TabStatus>(['waiting', 'needs-permission'])

/**
 * The handle's visible text and its accessible label. Shown: the name, and "⤢ zoomed (n hidden)"
 * when this view zooms the group (own or automatic). Label: also the pane count and every member
 * waiting or needing permission, so a screen reader hears what the dots show.
 */
export function handleWords(
  group: TabGroup,
  zoom: { zoomTab?: string; auto: boolean } | undefined,
  statusOf: (tabId: string) => TabStatus | undefined,
  labelOf: (tabId: string) => string
): { text: string; zoomText?: string; label: string } {
  const members = leavesOf(group.root)
  const hidden = zoom?.zoomTab !== undefined ? members.length - 1 : 0
  const zoomText = zoom?.zoomTab !== undefined ? `zoomed (${hidden} hidden)` : undefined
  const asks = members.flatMap((t) => {
    const s = statusOf(t)
    return s && ASK.has(s) ? [`${labelOf(t)} ${statusLabel(s)}`] : []
  })
  const parts = [`Split group ${groupTitle(group)}`, `${members.length} panes`]
  if (zoomText) parts.push(zoom?.auto ? `${zoomText}, automatically` : zoomText)
  parts.push(...asks)
  return { text: groupTitle(group), ...(zoomText ? { zoomText } : {}), label: parts.join(', ') }
}

/**
 * Whether a member dropped at `pointerX` left its segment (D9: dragging a member out detaches it;
 * inside the segment nothing reorders). `segment` is the segment's box on screen, the dragged
 * member's own slot included.
 */
export function leftSegment(segment: { left: number; right: number }, pointerX: number): boolean {
  return pointerX < segment.left || pointerX > segment.right
}
