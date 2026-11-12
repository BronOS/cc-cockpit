// Server mode's session counts (gateway SESSIONS_PATH, design-remote-desktop.md §4.1): every Claude
// tab of the server folded into three counts for the desktop app's machine chip. Only the registry's
// statuses go in and only numbers come out, so nothing a tab says (title, tool, prompt, project) can
// reach another machine through it.
import type { TabStatus } from '../../shared/ipc'
import type { WebSessionCounts } from '../../shared/web-protocol'

/**
 * Which count a status lands in. Every Claude tab lands in exactly one, so the three add up to the
 * server's Claude tabs:
 *  - `waiting`: `waiting` (at the prompt, its turn done) and `needs-permission` (a dialog open). Both
 *    wait for the person, which is what the chip is for; the strip marks them alike as "needs you".
 *  - `working`: `working` and `starting` (launched, its first prompt not up yet): busy, nothing to
 *    answer yet.
 *  - `idle`: `idle` (at the prompt with nothing new, or after an interrupt: not sendable, design.md)
 *    and `ended` (the process exited; the tab is still there to restart or close). Neither asks
 *    anything of the person nor does any work.
 * A `Record` over the whole union, so a status added to TabStatus later fails the typecheck here
 * instead of falling silently into no count.
 */
const COUNT_OF: Record<TabStatus, keyof WebSessionCounts> = {
  waiting: 'waiting',
  'needs-permission': 'waiting',
  working: 'working',
  starting: 'working',
  idle: 'idle',
  ended: 'idle'
}

/** The counts over these entries (SessionRegistry.list(): Claude tabs only, a shell tab has no entry). */
export function countSessions(entries: Iterable<{ status: TabStatus }>): WebSessionCounts {
  const counts: WebSessionCounts = { waiting: 0, working: 0, idle: 0 }
  for (const e of entries) {
    // Own-property lookup: a status that is not a key (only a corrupt entry could carry one) counts
    // nowhere rather than reading `toString` off the prototype.
    const key = Object.prototype.hasOwnProperty.call(COUNT_OF, e.status) ? COUNT_OF[e.status] : undefined
    if (key !== undefined) counts[key] += 1
  }
  return counts
}
