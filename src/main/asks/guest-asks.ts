// Which ask a guest's answer names (design-guests §9, spec-review 9): the router's `askInfo` (GuestRouterDeps), so
// a guest may answer only an ask it was shown (shared/guest-filter.ts askVisible decides both the sink's drop and
// this). Each shared-ask family has its own request id prefix (`trash-1`, `offer-2`), so a lookup asks each
// source in turn; the first that knows the id answers.
//
// Only trash asks and download offers can be a guest's (askVisible): the plugin link (D-4), close, room remove and
// guest close asks never are, so they need no source here and any id of theirs is unknown, hence refused.

import type { GuestAskInfo, GuestAskKind } from '../../shared/guest-filter'

export interface GuestAskSource {
  kind: GuestAskKind
  /** What the pending ask is about, or undefined when this source does not have it. */
  info(windowId: number, requestId: string): GuestAskInfo | undefined
}

/** The router's `askInfo` over `sources` (07: the trash asks, `pluginOf`, and the download offers' origin tab). */
export function askInfoFrom(
  sources: readonly GuestAskSource[]
): (windowId: number, requestId: string) => { kind: GuestAskKind; info: GuestAskInfo } | undefined {
  return (windowId, requestId) => {
    for (const source of sources) {
      const info = source.info(windowId, requestId)
      if (info !== undefined) return { kind: source.kind, info }
    }
    return undefined
  }
}

/**
 * A download offer source (D-23): the offer's origin tab (Downloads.offerOrigin). An offer made with no tab answers
 * `{}`, so its kind is still known and askVisible refuses it.
 */
export function downloadOfferSource(downloads: {
  offerOrigin(windowId: number, requestId: string): { originTab?: string } | undefined
}): GuestAskSource {
  return { kind: 'download', info: (windowId, requestId) => downloads.offerOrigin(windowId, requestId) }
}

/** A trash ask source: the asking plugin of a pending trash ask (TrashAsks.pluginOf). */
export function trashAskSource(trash: { pluginOf(windowId: number, requestId: string): string | undefined }): GuestAskSource {
  return {
    kind: 'trash',
    info: (windowId, requestId) => {
      const pluginId = trash.pluginOf(windowId, requestId)
      return pluginId === undefined ? undefined : { pluginId }
    }
  }
}
