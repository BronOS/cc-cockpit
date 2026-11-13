// "Ask before closing a tab that is still running" (AppSettings.confirmTabClose, design §3 Close).
// Pure, so the decision is unit-testable without a DOM; TabsPane asks it on every close the USER
// starts (the × button, the tab menu's Close, Close Tab by key or palette, the exited banner's
// Close). Closes that are not a user's click never come here: main's clean-exit close
// (`tabs.removed`), main's own, a window closing (which asks in main, windows/unsaved-dialog.ts). A
// plugin's ctx.sessions.close does (`sessions.closeAsk`).
//
// A page tab runs no process: it asks only when its page holds unsaved changes in any view
// (TabInfo.dirty, kept per view by main; design-editor.md §1 "Dirty and close"), and then whatever
// the setting says, since what a close loses there is the person's text.
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
  /** A page tab with unsaved changes in some view: the ask is about those, not a process. */
  unsaved?: true
}

/**
 * The tab's process is alive. An exited tab carries `exit`, and so does a restored command tab
 * that never ran (`notStarted`, gen 0): neither has anything a close could kill. Nor does a page tab.
 */
export function tabIsRunning(tab: TabInfo): boolean {
  // A page tab runs no process; whether closing it loses anything is its dirty state (core's ask).
  if (tab.kind === 'page') return false
  return tab.exit === undefined
}

/**
 * Whether a close of `tab` may ask at all (then the setting is read): a process runs in it, or it is
 * a page tab with unsaved changes.
 */
export function closeMayAsk(tab: TabInfo): boolean {
  return tabIsRunning(tab) || (tab.kind === 'page' && tab.dirty === true)
}

/**
 * What a user's close of `tab` must ask, or null to close at once: the setting is off, the tab is
 * gone (main answers the close as it does for any unknown id), or nothing runs in it. `status` is
 * the Claude tab's status from the window's own sessions, when it has one. A page tab asks when it
 * has unsaved changes, whatever the setting (which is about running processes).
 */
export function closeQuestion(
  tab: TabInfo | undefined,
  status: TabStatus | undefined,
  enabled: boolean
): CloseQuestion | null {
  if (tab?.kind === 'page') return tab.dirty === true ? { tabId: tab.id, title: tabLabel(tab), unsaved: true } : null
  if (!enabled || !tab || !tabIsRunning(tab)) return null
  return {
    tabId: tab.id,
    title: tabLabel(tab),
    ...(tab.kind === 'claude' && status ? { status: statusLabel(status) } : {})
  }
}

/** The sentence under the dialog's title. */
export function closeQuestionText(q: CloseQuestion): string {
  if (q.unsaved) return 'It has unsaved changes. Closing it discards them.'
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
