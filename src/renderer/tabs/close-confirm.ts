// "Ask before closing a tab that is still running" (AppSettings.confirmTabClose, design §3 Close).
// Pure, so the decision is unit-testable without a DOM; TabsPane asks it on every close the USER
// starts (the × button, the tab menu's Close, Close Tab by key or palette, the exited banner's
// Close). Closes that are not a user's click never come here: main's clean-exit close
// (`tabs.removed`), a plugin's or main's own, a window closing.
import type { TabInfo, TabStatus } from '../../shared/ipc'
import { statusLabel } from '../status/strip-order'
import { tabLabel } from './tab-label'

/** What the dialog asks about one tab. */
export interface CloseQuestion {
  tabId: string
  /** The tab's label, as the tab bar shows it. */
  title: string
  /** A Claude tab's status in words ("working", "waiting for input"); absent for other tabs. */
  status?: string
  /**
   * A split group's Close all (design §1 "Strip"): one question for every member, listing those
   * still running. `tabId` is then the group's first member, `title` the group's name.
   */
  group?: { groupId: string; tabIds: string[]; running: Array<{ title: string; status?: string }> }
}

/**
 * What Close all of a split group must ask, or null to close every member at once: the setting is
 * off or nothing runs in any of them. `members` in pane order; `statusOf` the Claude tabs' statuses.
 */
export function closeGroupQuestion(
  groupId: string,
  name: string,
  members: readonly TabInfo[],
  statusOf: (tabId: string) => TabStatus | undefined,
  enabled: boolean
): CloseQuestion | null {
  const first = members[0]
  if (!enabled || !first) return null
  const running = members.filter(tabIsRunning).map((t) => {
    const status = statusOf(t.id)
    return { title: tabLabel(t), ...(t.kind === 'claude' && status ? { status: statusLabel(status) } : {}) }
  })
  if (running.length === 0) return null
  return { tabId: first.id, title: name, group: { groupId, tabIds: members.map((t) => t.id), running } }
}

/**
 * The tab's process is alive. An exited tab carries `exit`, and so does a restored command tab
 * that never ran (`notStarted`, gen 0): neither has anything a close could kill.
 */
export function tabIsRunning(tab: TabInfo): boolean {
  return tab.exit === undefined
}

/**
 * What a user's close of `tab` must ask, or null to close at once: the setting is off, the tab is
 * gone (main answers the close as it does for any unknown id), or nothing runs in it. `status` is
 * the Claude tab's status from the window's own sessions, when it has one.
 */
export function closeQuestion(
  tab: TabInfo | undefined,
  status: TabStatus | undefined,
  enabled: boolean
): CloseQuestion | null {
  if (!enabled || !tab || !tabIsRunning(tab)) return null
  return {
    tabId: tab.id,
    title: tabLabel(tab),
    ...(tab.kind === 'claude' && status ? { status: statusLabel(status) } : {})
  }
}

/** The sentence under the dialog's title. */
export function closeQuestionText(q: CloseQuestion): string {
  if (q.group) {
    const n = q.group.tabIds.length
    const r = q.group.running.length
    return `This closes all ${n} tabs of the group; ${r === 1 ? '1 is' : `${r} are`} still running. Closing ends them:`
  }
  return q.status
    ? `Claude is ${q.status} in this tab. Closing it ends the session.`
    : 'Its process is still running. Closing the tab ends it.'
}

/** What the dialog's answer does: close the tab, and turn the setting off ("Don't ask again"). */
export interface CloseAnswer {
  close: boolean
  /** Send `settings.confirmTabCloseSet { value: false }`. */
  stopAsking: boolean
}

/**
 * "Don't ask again" counts only with Close: Cancel (button, Esc, a click outside) leaves both the
 * tab and the setting as they were, since a dismissal is the user backing out of the whole dialog.
 */
export function closeAnswer(choice: 'close' | 'cancel', dontAskAgain: boolean): CloseAnswer {
  return choice === 'close' ? { close: true, stopAsking: dontAskAgain } : { close: false, stopAsking: false }
}
