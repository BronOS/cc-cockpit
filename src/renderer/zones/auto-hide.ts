// Auto-hiding the side zones when the terminal gets narrow (design §4 "Auto-hide"; app settings
// `zoneAutoHide` / `minTerminalWidth`, shared/zone-auto-hide.ts). The terminal is the priority:
// when the window narrows so the centre would be under the minimum, the right zone's panel area
// hides first, then the left one's; as the window widens they come back last-hidden first (left,
// then right). Pure, no DOM: use-auto-hide.ts measures and feeds it, unit tests play it out.
//
// Rules, each with the case behind it:
//  - Auto-hidden is the window's own state, never the stored layout: the zone stays expanded with
//    its panels open in the project record, so a wider window (or another machine) brings it back,
//    and a zone the person closed themselves (collapsed, or no panel open) is never in `hidden` and
//    never comes back on its own.
//  - Hiding is checked only when something can have made the terminal too narrow without the
//    person asking for it: the room shrank (a window resize), the minimum was raised or the setting
//    turned on, the first decision, or a panel appeared (the layout arrived, a plugin declared its
//    panels). Not when the person opened a zone or dragged one wider: that is their pick, and
//    hiding the zone they just showed (or are dragging) would fight them. So a zone the person shows
//    by hand while narrow stays until the next resize that shrinks the window.
//  - Restoring is checked on every decision, and needs RESTORE_MARGIN more than the minimum with
//    the zone shown. Hiding a zone frees its whole width, so without the margin a window resting a
//    pixel or two around the threshold (a drag that jitters, a fractional DPI width) would hide and
//    show the zone on alternate frames.
//  - Widths are the zone's own saved size (resizable, capped like the CSS cap), so a zone dragged
//    wide gives way sooner and needs more room to come back.

export type SideZone = 'left' | 'right'
export const SIDE_ZONES: readonly SideZone[] = ['left', 'right']
/** Hidden in this order as the window narrows; restored in the reverse. */
export const HIDE_ORDER: readonly SideZone[] = ['right', 'left']
/** Extra room over the minimum a zone needs to come back (hysteresis). */
export const RESTORE_MARGIN = 48

export interface AutoHideState {
  /** The side zones auto-hidden now, in the order they were hidden (restored last first). */
  readonly hidden: readonly SideZone[]
  /** The room at the last decision; undefined before the first (or after the setting went off). */
  readonly room?: number
  /** The minimum at the last decision: raising it re-checks at once. */
  readonly minWidth?: number
  /** The panel keys at the last decision: a new one (the layout arrived, a plugin's) re-checks. */
  readonly panels?: readonly string[]
}

export const INITIAL_AUTO_HIDE: AutoHideState = { hidden: [] }

export interface AutoHideInput {
  enabled: boolean
  /** The terminal's minimum width (px). */
  minWidth: number
  /**
   * The width the terminal and the two side panel areas share: the zones' row minus the icon
   * strips, which stay on screen whatever is hidden (a hidden zone's panels stay one click away).
   */
  room: number
  /** The width each side panel area takes when shown. */
  sizes: Readonly<Record<SideZone, number>>
  /** The person has the zone open: expanded, with an open panel. Only those take room or hide. */
  open: Readonly<Record<SideZone, boolean>>
  /** The panels that exist now (any zone, hidden ones too). */
  panels: readonly string[]
}

/** The terminal's width with every open zone shown except those in `hidden`. */
function centre(input: AutoHideInput, hidden: readonly SideZone[]): number {
  let width = input.room
  for (const z of SIDE_ZONES) if (input.open[z] && !hidden.includes(z)) width -= input.sizes[z]
  return width
}

const sameList = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i])

/**
 * The next state for `input`. Returns `prev` itself when nothing changed, so a caller can skip a
 * re-render with `next === prev`.
 */
export function decideAutoHide(prev: AutoHideState, input: AutoHideInput): AutoHideState {
  // Off: nothing hidden, and nothing remembered, so turning it back on checks from scratch.
  if (!input.enabled) return prev.hidden.length === 0 && prev.room === undefined ? prev : INITIAL_AUTO_HIDE
  // Not laid out (a 0-wide first frame): no basis for a decision.
  if (!(input.room > 0) || !Number.isFinite(input.room)) return prev

  // A zone the person closed while it was auto-hidden (its last panel moved away or hidden from
  // the strip's menu) is theirs now: it must not come back on its own.
  let hidden = prev.hidden.filter((z) => input.open[z])

  const known = new Set(prev.panels ?? [])
  const check =
    prev.room === undefined ||
    input.room < prev.room ||
    prev.minWidth === undefined ||
    input.minWidth > prev.minWidth ||
    input.panels.some((key) => !known.has(key))
  if (check) {
    for (const z of HIDE_ORDER) {
      if (centre(input, hidden) >= input.minWidth) break
      if (input.open[z] && !hidden.includes(z)) hidden = [...hidden, z]
    }
  }
  // Last hidden comes back first, each only with the margin to spare.
  while (hidden.length > 0) {
    const back = hidden.slice(0, -1)
    if (centre(input, back) < input.minWidth + RESTORE_MARGIN) break
    hidden = back
  }

  const next: AutoHideState = { hidden, room: input.room, minWidth: input.minWidth, panels: [...input.panels] }
  return sameList(prev.hidden, next.hidden) &&
    prev.room === next.room &&
    prev.minWidth === next.minWidth &&
    sameList(prev.panels, next.panels)
    ? prev
    : next
}

/**
 * The person showed an auto-hidden zone (an icon click, the zone's toggle key, a panel opened or
 * moved into it, ctx.panels.show): it is shown, and stays until a check (decideAutoHide) hides it
 * again, which a later shrink of the window does.
 */
export function revealZone(state: AutoHideState, zone: SideZone): AutoHideState {
  return state.hidden.includes(zone) ? { ...state, hidden: state.hidden.filter((z) => z !== zone) } : state
}

/** The open panel keys of a side zone in a layout-like shape (shared/layout.ts LayoutState). */
interface ZonesLike {
  zones: Record<SideZone, { collapsed: boolean; panels: ReadonlyArray<{ panelKey: string; open: boolean }> }>
}

/**
 * The side zones in which the person (or a plugin's show) put something new on screen between two
 * layouts: the zone got expanded with a panel open, or a panel opened in it (an icon click, a move
 * into it, an unhide). In an auto-hidden zone that is a request to see it (revealZone).
 */
export function newlyShown(prev: ZonesLike, next: ZonesLike): SideZone[] {
  return SIDE_ZONES.filter((z) => {
    const after = next.zones[z]
    if (after.collapsed) return false
    const before = prev.zones[z]
    const wasOpen = new Set(before.collapsed ? [] : before.panels.filter((p) => p.open).map((p) => p.panelKey))
    return after.panels.some((p) => p.open && !wasOpen.has(p.panelKey))
  })
}
