// What this view's shell offers, by its access (design-guests §10, spec-review 24): the owner everything; a
// write guest the writes into what is shared with it (typing, Restart, Close, New Claude and Shell tabs,
// Discuss and Ask Claude, a panel's header actions); a read guest none of them. Neither guest gets the
// owner's tools (settings, the plugin gear and restart, the ccc offer, the [+] menu's command entries)
// nor any arrangement (split groups, tab order, rename, flag, room mark, panel moves and hiding).
//
// A UI HINT ONLY: it keeps the shell from drawing buttons main would refuse (GUEST_CLASS, by the view main
// bound), so nothing here is a check. Read from viewAccessHint() when a component renders or a handler
// runs, never at module load (the web entry sets the hint after its imports ran). DOM-free for unit tests.

import type { ViewAccess } from '../../shared/views'

export interface ShellAllows {
  /** Split groups, tab order, rename, flag, room marks, panel moves and hiding (every one guest `no`). */
  arrange: boolean
  /** The owner's own tools: settings, a plugin's gear and Restart, the ccc offer, the [+] menu's command entries. */
  ownerTools: boolean
  /** Writes into what is shared: type, Restart, Close, a queued text's cancel, Discuss, Ask Claude, header actions. */
  write: boolean
}

const OWNER: ShellAllows = Object.freeze({ arrange: true, ownerTools: true, write: true })
const WRITE: ShellAllows = Object.freeze({ arrange: false, ownerTools: false, write: true })
const READ: ShellAllows = Object.freeze({ arrange: false, ownerTools: false, write: false })

/** What the shell offers a view of `access`. */
export function shellAllows(access: ViewAccess): ShellAllows {
  return access === 'owner' ? OWNER : access === 'write' ? WRITE : READ
}

/**
 * The tab area's text with no tab in it. A guest sees only what is shared with it, so an empty list
 * means nothing is shared (a write guest's New tab is in the strip, not offered here).
 */
export function emptyTabsText(access: ViewAccess): string {
  return access === 'owner' ? 'No tabs yet. Use + to start Claude or a shell.' : 'Nothing shared right now'
}
