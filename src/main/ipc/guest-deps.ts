// The guest services the router, the gateway and the plugin hosts build against (design-guests,
// shared/design.md §16.8, spec-review 4). Task 01 declares them; task 02 implements GuestService and
// PresenceService (main/web/guests.ts, presence.ts), task 04 PluginGuestAccessService (main/settings), and
// task 07 wires them in index.ts. Until then a router with none of them refuses every guest caller.
//
// The services take no caller: the router decides who may call what (GUEST_CLASS, owner-only `adapted`
// channels, "widening only from an owner view", D-11) from the view main bound, and passes plain ids on.

import type { GuestVisibility } from '../../shared/guest-access'
import type { GuestAccess, GuestInviteAnswer, GuestInviteRequest, GuestScope, GuestView, PresenceSnapshot } from '../../shared/guests'
import type { GuestRole, ViewId, Who } from '../../shared/views'

/** The guest store and its live answers (task 02, main/web/guests.ts). */
export interface GuestService {
  /** Who a caller is now: read live on every call (a kick or a role switch holds at once). */
  access(who: Who): GuestAccess
  /** The same for a bare view id (main code that holds no CallView: sizes, selections, overlays, asks). A desktop view is the owner; an unknown one `revoked`. */
  whoAccess(viewId: ViewId): GuestAccess
  /** shared/guest-filter.ts `tabVisible` with the store's live data (scope, opened tabs, the tab's plugin). */
  tabVisible(guestId: string, tabId: string): boolean
  /** Whether guests of the project see the plugin (PluginGuestAccessService.visible, or false when it is off there). */
  pluginVisible(projectId: string, pluginId: string): boolean
  /** The tabs this guest opened (D-9, D-21). */
  openedTabs(guestId: string): readonly string[]
  /** A tab this guest just opened: it joins the guest's `openedTabs` (the router checked MAX_GUEST_TABS). */
  noteOpenedTab(guestId: string, tabId: string): void
  /** Every guest and pending invite, for the owner's list. */
  list(): GuestView[]
  /** Make an invite for `projectId` (the caller's project, the router's). */
  invite(projectId: string, req: GuestInviteRequest): Promise<GuestInviteAnswer>
  revokeInvite(inviteId: string): boolean
  kick(guestId: string): boolean
  setRole(guestId: string, role: GuestRole): boolean
  setScope(guestId: string, scope: GuestScope): boolean
  /** Add a tab to (or take it out of) a selected-tabs guest's scope. */
  shareTab(guestId: string, tabId: string, shared: boolean): boolean
  /** Restore minted new tab ids (main/restore.ts `onRestored`): scopes and opened tabs follow them. */
  remap(projectId: string, idMap: ReadonlyMap<string, string>): void
  /** Titles of this guest's page tabs with unsaved changes (a downgrade warns the owner). */
  unsaved(guestId: string): string[]
  /** Guests, invites, roles or scopes changed. */
  onChange(listener: () => void): () => void
}

/** The plugins guests see (task 04, main/settings; shared/guest-access.ts for the rule). */
export interface PluginGuestAccessService {
  /** `guestVisibility(...).effective === 'shown'` for the project. */
  visible(projectId: string, pluginId: string): boolean
  /** The port a guest of `role` gets to the plugin's pages in the project (D-17). */
  port(projectId: string, pluginId: string, role: GuestRole): 'none' | 'oneWay' | 'full'
  /** Store the owner's value: app-wide, or for `projectId` (`null`: absent, use the next). False for an unknown plugin. */
  set(pluginId: string, target: 'app' | 'project', value: GuestVisibility | null, projectId?: string): boolean
  onChange(listener: () => void): () => void
}

/** Who is here and where (task 02, main/web/presence.ts). */
export interface PresenceService {
  /** The snapshot as `viewId` may see it (filtered for a guest view: shared/guest-filter.ts `guestPresence`). */
  snapshotFor(viewId: ViewId): PresenceSnapshot
}

/** What the router takes for guests; all absent in task 01, so every non-owner caller is refused. */
export interface GuestDeps {
  guests?: GuestService
  pluginAccess?: PluginGuestAccessService
  presence?: PresenceService
}
