// Parts (shared/design-parts.md §2, D13): which part may attach to which overlay. Pure: OverlayManager.attachPart
// gathers the facts (its own records and host-api's word on the plugin) and creates the part only when this says
// nothing. A part is its own overlay record, opened by the part's plugin, drawn beside its parent's page; every
// per-overlay rule (copies, onConnect and hide, the guest filter, visibleTo) then works on the part's own id.
//
// Fail closed: a parent that is not known (never opened, ended, another window's) is refused, and so is an
// overlay that never announced: announcing (`handle.announce`) is the opener's consent to parts (§1).

/** At most this many parts in one overlay (the layout has room for two beside the opener's page, §4). */
export const MAX_PARTS = 2

/** What attachPart knows of the parent; undefined: no such overlay open in this window. */
export interface PartParent {
  /** The parent is itself a part: parts do not nest. */
  isPart: boolean
  /** Its opener announced (OverlayManager.markAnnounced). */
  announced: boolean
  kind: 'terminal' | 'url' | 'html'
  /** Its parts now, in attach order. */
  parts: readonly { pluginId: string }[]
}

export interface PartRequest {
  pluginId: string
  /** The part plugin's manifest says `overlays.perView` (host-api's read). */
  perView: boolean
  /** The part plugin is one this window's plugin host runs (host-api's `plugin()`); absent counts as no. */
  inHost: boolean
  /** The part's spec as main will open it. */
  spec: unknown
}

/** Why the part may not attach, as the plugin's error reads; undefined when it may. */
export function partRefusal(parent: PartParent | undefined, request: PartRequest): string | undefined {
  if (!parent) return 'overlay.part: that overlay is not open in this window'
  if (parent.isPart) return 'overlay.part: a part cannot have parts'
  if (!parent.announced) return 'overlay.part: that overlay did not announce what it shows (no consent to parts)'
  if (parent.kind !== 'html') return 'overlay.part: only an html overlay takes parts'
  if (!request.inHost) return "overlay.part: the plugin is not one of this window's"
  if (!request.perView) return 'overlay.part: a part needs "overlays": { "perView": true } in plugin.json'
  const spec = request.spec as { kind?: unknown; notes?: unknown } | null
  if (typeof spec !== 'object' || spec === null || spec.kind !== 'html') return 'overlay.part: a part is an html page'
  // Notes stay the opener's (§5, v1): a part's would be a second store on one window.
  if (spec.notes !== undefined) return 'overlay.part: a part has no notes'
  if (parent.parts.some((p) => p.pluginId === request.pluginId)) return 'overlay.part: that overlay already has a part of this plugin'
  if (parent.parts.length >= MAX_PARTS) return `overlay.part: that overlay already has ${MAX_PARTS} parts`
  return undefined
}
