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
 * How a send to the tab goes. `now`: it waits for input, typed at once. `queued`: a turn (or a
 * permission prompt) is running, the send gate holds the text until that turn's Stop. `not-ready`:
 * idle or starting, i.e. no turn since SessionStart (a fresh, resumed or /clear-ed session): idle is
 * not sendable (a startup dialog may be up) and no Stop comes until the person runs a prompt, so a
 * queued text would wait there indefinitely. The incident: a tab resumed by an app restart took a
 * Discuss as "queued 1" and nothing happened. Main refuses the same targets (overlay-manager).
 */
export type DiscussReadiness = 'now' | 'queued' | 'not-ready'

export function discussReadiness(tab: Pick<DiscussTab, 'status'>): DiscussReadiness {
  if (tab.status === 'waiting') return 'now'
  return tab.status === 'idle' || tab.status === 'starting' ? 'not-ready' : 'queued'
}

/**
 * The ▾ menu's order: the preselected tab (shared/discuss.ts: the opener's `discuss.tabId`, else
 * the window's selected Claude tab) first unless it is not ready, then the tabs waiting for input
 * (a send goes in now), then the busy ones (queued by the send gate until they are free), then the
 * not-ready ones (listed, so the person sees why their tab cannot take it), each group in tab order.
 */
export function orderDiscussTabs(tabs: readonly DiscussTab[], preselectedId: string | undefined): DiscussTab[] {
  const group = (r: DiscussReadiness) => (t: DiscussTab) => discussReadiness(t) === r
  const first = tabs.filter((t) => t.tabId === preselectedId && discussReadiness(t) !== 'not-ready')
  const rest = tabs.filter((t) => !first.includes(t))
  return [...first, ...rest.filter(group('now')), ...rest.filter(group('queued')), ...rest.filter(group('not-ready'))]
}

/** The row's status line: the status, and what a send there does when it is not typed now. */
export function discussRowMeta(tab: DiscussTab, status: string): string {
  switch (discussReadiness(tab)) {
    case 'now':
      return status
    case 'queued':
      return `${status} · queued — sent when it is free`
    case 'not-ready':
      return `${status} · not ready — run a prompt in it first`
  }
}

/** The ▾ part is disabled with no existing session to pick; its tooltip says why. */
export function existingMenuTitle(tabs: readonly DiscussTab[]): string {
  return tabs.length === 0 ? 'No Claude session in this window to discuss in' : 'Discuss in an existing session'
}
