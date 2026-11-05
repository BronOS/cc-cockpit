// The Claude tabs Discuss with Claude offers (design-next §3.5), DOM-free so a unit test loads it:
// this window's Claude tabs in tab order, named as the tab bar names them, with the status the
// window's session snapshot has for each. An ended session is left out (main refuses it as a
// target), and so is a tab the snapshot does not know yet.
import type { SessionDetail, TabInfo, TabStatus } from '../../shared/ipc'
import { tabLabel } from '../tabs/tab-label'

/** One Claude tab of this window as the popover lists it. */
export interface DiscussTab {
  tabId: string
  label: string
  status: TabStatus
  tool?: string
}

export function discussTabsOf(tabs: readonly TabInfo[], own: ReadonlyMap<string, SessionDetail>): DiscussTab[] {
  const out: DiscussTab[] = []
  for (const tab of tabs) {
    if (tab.kind !== 'claude') continue
    const session = own.get(tab.id)
    if (!session || session.status === 'ended') continue
    const entry: DiscussTab = { tabId: tab.id, label: tabLabel(tab, session.title, session.name), status: session.status }
    if (session.tool !== undefined) entry.tool = session.tool
    out.push(entry)
  }
  return out
}

/**
 * The ▾ menu's order: the preselected tab (shared/discuss.ts: the opener's `discuss.tabId`, else
 * the window's selected Claude tab) first, then the tabs waiting for input (a send goes in now),
 * then the busy ones (queued by the send gate until they are free), each group in tab order.
 */
export function orderDiscussTabs(tabs: readonly DiscussTab[], preselectedId: string | undefined): DiscussTab[] {
  const first = tabs.filter((t) => t.tabId === preselectedId)
  const rest = tabs.filter((t) => t.tabId !== preselectedId)
  return [...first, ...rest.filter((t) => t.status === 'waiting'), ...rest.filter((t) => t.status !== 'waiting')]
}

/** Only `waiting` takes a send now; any other status queues it (send gate: idle is not sendable). */
export function discussQueues(tab: DiscussTab): boolean {
  return tab.status !== 'waiting'
}

/** The ▾ part is disabled with no existing session to pick; its tooltip says why. */
export function existingMenuTitle(tabs: readonly DiscussTab[]): string {
  return tabs.length === 0 ? 'No Claude session in this window to discuss in' : 'Discuss in an existing session'
}
