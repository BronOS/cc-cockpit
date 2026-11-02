// Pure helpers for the top strip, so the order and the labels are unit-testable without a DOM.
import type { SessionStripEntry, TabStatus } from '../../shared/ipc'

/**
 * The strip shows what needs the user first: a permission prompt, then a session waiting for
 * input, then the busy ones, then the quiet ones. `starting` shares the idle rank (a process
 * that has not reported yet is as quiet as an idle one), `ended` is last.
 */
const RANK: Record<TabStatus, number> = {
  'needs-permission': 0,
  waiting: 1,
  working: 2,
  idle: 3,
  starting: 3,
  ended: 4
}

/**
 * Sorted by the ranks above, STABLE by the input order: the registry lists tabs in creation
 * order, so two tabs in the same state keep their tab order and the strip does not shuffle when
 * one of them changes between two other states. Returns a new array.
 */
export function orderStrip(entries: readonly SessionStripEntry[]): SessionStripEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => RANK[a.entry.status] - RANK[b.entry.status] || a.index - b.index)
    .map(({ entry }) => entry)
}

const LABEL: Record<TabStatus, string> = {
  starting: 'starting',
  idle: 'idle',
  working: 'working',
  'needs-permission': 'needs permission',
  waiting: 'waiting for input',
  ended: 'ended'
}

export function statusLabel(status: TabStatus): string {
  return LABEL[status]
}

/** `project · status · tool` (the tool only while there is one). */
export function stripText(entry: SessionStripEntry): string {
  const parts = [entry.projectName, statusLabel(entry.status)]
  if (entry.tool) parts.push(entry.tool)
  return parts.join(' · ')
}

/**
 * The strip entries of OTHER windows. The snapshot's `strip` lists every Claude tab, this window's
 * own included, but those are already in its tab bar and its Sessions panel, so the top bar would
 * show them twice. An entry carries no project id (by design), so own entries are recognised by
 * `own` (the snapshot's full detail of this window's project's tabs): same snapshot, same tab ids.
 */
export function otherWindowsEntries(
  strip: readonly SessionStripEntry[],
  own: readonly { tabId: string }[]
): SessionStripEntry[] {
  const mine = new Set(own.map((d) => d.tabId))
  return strip.filter((e) => !mine.has(e.tabId))
}

/**
 * The top bar's class list. `title-bar` (macOS: the bar is the window's title bar) reserves the
 * traffic lights' room; `full-screen` collapses it, because macOS hides the lights in full screen
 * and the gap would be dead space. Full screen means nothing without the in-page title bar.
 */
export function topStripClass(titleBar: boolean, fullScreen: boolean): string {
  if (!titleBar) return 'top-strip'
  return fullScreen ? 'top-strip title-bar full-screen' : 'top-strip title-bar'
}
