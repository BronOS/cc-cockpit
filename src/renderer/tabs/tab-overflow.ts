/**
 * Pure geometry for a tab strip that holds more tabs than it has room for (TabBar.tsx), kept out of
 * the component so it is testable without a DOM.
 */

/** Which edges of the strip have tabs hidden behind them. */
export interface OverflowState {
  start: boolean
  end: boolean
}

/** Sub-pixel scroll positions and rounded layout widths disagree by up to a pixel; below it is "at the edge". */
const EDGE_SLACK = 1

/** Whether tabs are hidden left of and right of the visible part of a strip scrolled to `scrollLeft`. */
export function overflowState(scrollLeft: number, clientWidth: number, scrollWidth: number): OverflowState {
  return {
    start: scrollLeft > EDGE_SLACK,
    end: scrollLeft + clientWidth < scrollWidth - EDGE_SLACK
  }
}

/**
 * The scrollLeft that brings a tab fully into view with the least movement, or `scrollLeft` itself
 * when it already is. `tabLeft` / `tabRight` are offsets inside the scrolled content (not the
 * viewport), `pad` keeps a little of the neighbour in sight so the edge fade does not cover the tab.
 */
export function scrollToReveal(
  scrollLeft: number,
  clientWidth: number,
  tabLeft: number,
  tabRight: number,
  pad: number
): number {
  if (tabLeft - pad < scrollLeft) return Math.max(0, tabLeft - pad)
  if (tabRight + pad > scrollLeft + clientWidth) return tabRight + pad - clientWidth
  return scrollLeft
}

/**
 * Whether a wheel event should scroll the strip sideways: a mostly vertical wheel (a mouse wheel;
 * a trackpad's sideways swipe already scrolls the strip itself) while there is something to scroll.
 */
export function wheelScrollsSideways(deltaX: number, deltaY: number, hasOverflow: boolean): boolean {
  return hasOverflow && Math.abs(deltaY) > Math.abs(deltaX)
}

/** Where a tab sits in the strip's viewport coordinates, and its flag colour (only flagged tabs are passed). */
export interface FlaggedRect<C extends string = string> {
  left: number
  right: number
  color: C
}

/**
 * The colour hint each edge of the strip shows: the flag of the hidden flagged tab nearest that
 * edge, so the person sees which of their marked tabs is out of view and on which side. A tab
 * counts as hidden past an edge once its centre is under that edge's fade (`fade` px wide, the
 * mask in styles.css): a sliver at the edge is not readable as a tab. `listLeft` / `listRight` are
 * the strip's visible edges in the same coordinates as the rects.
 */
export function hiddenFlags<C extends string>(
  listLeft: number,
  listRight: number,
  tabs: readonly FlaggedRect<C>[],
  fade: number
): { start?: C; end?: C } {
  let start: FlaggedRect<C> | undefined
  let end: FlaggedRect<C> | undefined
  for (const t of tabs) {
    const centre = (t.left + t.right) / 2
    if (centre < listLeft + fade && (!start || t.right > start.right)) start = t
    else if (centre > listRight - fade && (!end || t.left < end.left)) end = t
  }
  const out: { start?: C; end?: C } = {}
  if (start) out.start = start.color
  if (end) out.end = end.color
  return out
}
