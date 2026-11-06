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
