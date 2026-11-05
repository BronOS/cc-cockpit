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
