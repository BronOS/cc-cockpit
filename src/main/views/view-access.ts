// Who is behind a view, for main code that holds only a ViewId (design-guests §2, spec-review 5): the terminal
// sizes, the per-view selections, the overlays and the asks. The router has the caller's `who` on its CallView;
// these modules get an `AccessOf` instead, built once from ViewRegistry.whoOf and the guest store.
//
// `who` is frozen at `hello` (ViewRegistry.addRemote); the role and scope are read live through
// GuestService.access on every call, so a role switch or a kick holds at once. A guest view with no guest store
// behind it (an unwired build, a gone guest) is `revoked`: it gets nothing, never the owner's rights.

import type { GuestAccess } from '../../shared/guests'
import { isRemoteViewId, type ViewId, type Who } from '../../shared/views'
import type { GuestService } from '../ipc/guest-deps'

/** The access behind a view id, read live. */
export type AccessOf = (viewId: ViewId) => GuestAccess

export const OWNER_ACCESS: GuestAccess = Object.freeze({ kind: 'owner' })
export const REVOKED_ACCESS: GuestAccess = Object.freeze({ kind: 'revoked' })

/**
 * The access of `viewId`, whose frozen `who` is `who` (undefined: no live view by that id). The desktop page
 * and server mode's hidden page are always the owner; a browser view is what its `who` says, a guest only while
 * the store still has it as a guest (and nothing at all with no store).
 */
export function accessOfView(viewId: ViewId, who: Who | undefined, guests: Pick<GuestService, 'access'> | undefined): GuestAccess {
  if (!isRemoteViewId(viewId)) return OWNER_ACCESS
  if (who === undefined) return REVOKED_ACCESS
  if (who === 'owner') return OWNER_ACCESS
  const access = guests?.access(who)
  return access !== undefined && access.kind === 'guest' ? access : REVOKED_ACCESS
}

/** Whether the access is the owner's (a guest, or a view that is gone, is not). */
export function isOwnerAccess(access: GuestAccess): boolean {
  return access.kind === 'owner'
}
