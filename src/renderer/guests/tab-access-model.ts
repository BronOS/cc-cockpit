// What the tab strip offers a view by its access (design-guests §10, spec-review 24, D-9, D-21),
// DOM-free so unit tests run it. A UI HINT ONLY: the shell hides what a guest may not do so it never
// offers a dead control (hide, don't grey out), but main refuses every such call by the access of the
// view it bound (GUEST_CLASS), whatever this page draws. The desktop page is always the owner.

import type { GuestScope, GuestView, PresenceSnapshot } from '../../shared/guests'
import type { TabInfo } from '../../shared/ipc'
import type { ViewAccess } from '../../shared/views'

/** The tab menu's sections, in the order TabBar draws them. */
export type TabMenuItem = 'move' | 'rename' | 'split' | 'room' | 'share' | 'flag' | 'close'

export interface TabControls {
  /**
   * The [+] menu: `all` (Claude, Shell and the person's command entries), `core` (Claude and Shell
   * only: a write guest's new tab is the owner's process, D-21, and command entries are the owner's
   * own commands), or none.
   */
  newTab: 'all' | 'core' | 'none'
  /** The tab menu's items; empty: no tab menu at all (a right click does nothing). */
  menu: ReadonlySet<TabMenuItem>
  /** A tab's own close button (a write guest's close of the owner's tab asks the owner, D-9). */
  closeButton: boolean
  /** Drag a tab or a group along the strip, or into a pane. */
  drag: boolean
  /** A split group's handle menu (rename, equalize, ungroup, close all). */
  groupMenu: boolean
  /** Room controls on a tab: the held badge and the queued list's cancel (the owner's, like the room mark). */
  roomControls: boolean
}

const OWNER_MENU: ReadonlySet<TabMenuItem> = new Set(['move', 'rename', 'split', 'room', 'share', 'flag', 'close'])
const WRITE_MENU: ReadonlySet<TabMenuItem> = new Set(['close'])
const NO_MENU: ReadonlySet<TabMenuItem> = new Set()

/**
 * The strip's controls for a view's access. A read guest watches: no new tab, no menu, no drag, no
 * rename, no flag editing (a flag's colour still shows), no close. A write guest pairs: New tab with
 * Claude and Shell only, Close (its own tabs close, the owner's ask the owner), nothing else.
 */
export function tabControls(access: ViewAccess): TabControls {
  if (access === 'owner') {
    return { newTab: 'all', menu: OWNER_MENU, closeButton: true, drag: true, groupMenu: true, roomControls: true }
  }
  if (access === 'write') {
    return { newTab: 'core', menu: WRITE_MENU, closeButton: true, drag: false, groupMenu: false, roomControls: false }
  }
  return { newTab: 'none', menu: NO_MENU, closeButton: false, drag: false, groupMenu: false, roomControls: false }
}

/** One "Share with <guest>" entry of the owner's tab menu. */
export interface ShareItem {
  guestId: string
  /** The guest's name, for the refusal line. */
  name: string
  label: string
  checked: boolean
}

function scopeHas(scope: GuestScope, tabId: string): boolean {
  return scope !== 'all' && scope.includes(tabId)
}

/**
 * The owner's "Share with <guest>" entries for a tab (design §7: a selected-tabs guest sees a tab
 * opened later only once the owner shares it): one per guest of this project whose scope is a list,
 * checked when the list has the tab. The scope in `guests.changed` is the source of truth (main answers
 * the toggle with a new list), not `TabInfo.sharedWith`, which can lag behind it by an event. An
 * all-tabs guest has no entry (it sees every tab already); none before the first list arrived.
 */
export function shareItems(
  guests: readonly GuestView[] | null,
  projectId: string | undefined,
  tab: TabInfo,
  /**
   * Whether this view may widen a guest's scope (`canWidenGuests`, D-11): sharing widens, unsharing
   * narrows. An owner browser of a desktop host may only unshare, so it is offered only the checked
   * entries (main refuses a share from it regardless).
   */
  canWiden = true
): ShareItem[] {
  if (projectId === undefined || guests === null) return []
  return guests
    .filter((g) => g.projectId === projectId && g.scope !== 'all')
    .map((g) => ({ guestId: g.id, name: g.name, label: `Share with ${g.name}`, checked: scopeHas(g.scope, tab.id) }))
    .filter((item) => canWiden || item.checked)
}

/**
 * The one line the strip shows when main answers a Share toggle `false` (the guest left, the invite was used
 * up or expired meanwhile, the tab is not this project's): nothing changed, and the menu, which reads the
 * scope from `guests.changed`, already shows what holds. A pending invite's guest is shared with like a
 * joined one (main edits the invite's scope until the redeem copies it).
 */
export function shareRefusedText(name: string, shared: boolean): string {
  return shared
    ? `This tab was not shared with ${name}: the guest or the invite is gone.`
    : `${name} still sees this tab: the guest or the invite is gone.`
}

/**
 * A guest's name by its id, for the "Opened by guest" line (TabInfo.openedByGuest holds the id, D-21): the
 * owner's guest list first, then presence (which a guest view has too), then the view's own hint. Undefined
 * when none knows it (the guest left): the line then says "a guest", never the raw id.
 */
export function guestNameOf(
  guestId: string,
  guests: readonly GuestView[] | null,
  presence: PresenceSnapshot | null,
  self?: { id: string; name: string }
): string | undefined {
  return (
    guests?.find((g) => g.id === guestId)?.name ??
    presence?.people.find((p) => p.id === guestId)?.name ??
    (self?.id === guestId ? self.name : undefined)
  )
}
