// Edges-only scrolling (the shell and every plugin page): no scrollbar at rest, a dark shadow at
// the top edge while content is hidden above and at the bottom edge while content is hidden below,
// and the bar shown while the element scrolls (about a second after the last scroll) or while the
// pointer is near the container's right edge, to grab it. The bars stay the browser's own (drag,
// keyboard, accessibility); only their colour changes, and `scrollbar-width: thin` keeps their
// strip reserved, so rows never move sideways when the thumb appears or goes.
//
// DOM-free, so unit tests run it in plain Node: the stylesheets, and the pure rules the page script
// (scroll-edges.ts) applies. Both the shell (src/renderer/main.tsx, web/main.tsx) and the panel SDK
// (panel.ts, through panel-core.ts) take them from here, so the two cannot drift.
//
// How the page script and the sheets split the work:
//   data-cc-scroller        the script marks every element whose computed overflow is auto or scroll
//                           (not the root: the viewport is handled by `:root::after`). Only these
//                           get the edge shadows: an animation on every element would cost too much,
//                           and CSS has no selector for "is a scroll container".
//   --cc-edge-top/-bottom   0 to 1, driven by two scroll-driven animations on the element's own
//                           scroll position (`animation-timeline: scroll(self)`), ramped over the
//                           first and last 24px: no script runs while scrolling, and a list that grows
//                           or shrinks updates by itself. A scroller that does not overflow has an
//                           inactive timeline, so both stay at 0. Where the browser has no scroll
//                           timelines (Firefox, through web access), the script sets
//                           data-cc-edge-top / -bottom from scroll and resize instead.
//   data-cc-scrolling       set on the element a `scroll` event came from, removed SCROLLING_MS after
//                           its last one (ScrollingMarks)
//   data-cc-scroll-near     the scroller whose right (or bottom) edge is within NEAR_EDGE_PX of the
//                           pointer (nearScrollbar), at most one at a time
//
// Everything is in `@layer cc.scroll` with `:where()` selectors: a sub-layer of the component sheet's
// `cc` layer, so the components' own rules (a `.cc-menu`'s drop shadow), the shell's rules and any
// page rule win over it. A page that wants no edges on an element sets its own `box-shadow` (none).

/** How long the bar stays after an element's last `scroll` event. */
export const SCROLLING_MS = 1000
/** The pointer within this many px of a scroller's right (or bottom) edge shows its bar. */
export const NEAR_EDGE_PX = 24
/** The shadow ramps in over this much scrolling from either end (scroll-driven `animation-range`). */
export const EDGE_RAMP_PX = 24

export const SCROLLER_ATTR = 'data-cc-scroller'
export const SCROLLING_ATTR = 'data-cc-scrolling'
export const NEAR_ATTR = 'data-cc-scroll-near'
export const EDGE_TOP_ATTR = 'data-cc-edge-top'
export const EDGE_BOTTOM_ATTR = 'data-cc-edge-bottom'

// Per edge, a shadow: a negative spread pulls it in from the sides and the offset pushes it down
// from the edge, so it reads as a band under the edge rather than a frame. Black, denser on a dark
// theme (`light-dark` follows the `color-scheme` the theme sets on the root). On a near-black
// background even solid black is only a few levels darker, so a dark theme also gets a 1px line in
// the text colour along the edge: the owner asked for a shape cue that is plain on every theme, not
// a near-colour tint. Inset shadows paint under the element's content and stay put as it scrolls.
const EDGE_SHADOW = 'light-dark(rgb(0 0 0 / 0.7), rgb(0 0 0 / 0.95))'
const EDGE_LINE = 'light-dark(transparent, color-mix(in srgb, var(--cc-fg, #888) 45%, transparent))'
const scaled = (colour: string, edge: string): string => `color-mix(in srgb, ${colour} calc(100% * var(${edge})), transparent)`
const edgeShadow = (sign: 1 | -1, edge: string): string =>
  // The line first: the first shadow listed paints on top, and under the band it would be darkened away.
  `inset 0 ${sign}px 0 0 ${scaled(EDGE_LINE, edge)}, inset 0 ${sign * 20}px 16px -14px ${scaled(EDGE_SHADOW, edge)}`
const SHADOW_TOP = edgeShadow(1, '--cc-edge-top')
const SHADOW_BOTTOM = edgeShadow(-1, '--cc-edge-bottom')

/**
 * The edge shadows, on every platform (macOS too: its overlay bars already hide at rest, the edges
 * are new there as well). Installed at once, before the first theme.
 *
 * The root scroller (a page whose document scrolls) has no box to put an inset shadow on that stays
 * at the viewport's edges, so a fixed `:root::after` overlay carries them, driven by the root's
 * timeline; it is above the content (pointer-events none) and paints nothing while its timeline is
 * inactive. Two numbers are registered (`@property`) so the animations interpolate them.
 */
export const SCROLL_EDGES_CSS = `@property --cc-edge-top { syntax: '<number>'; inherits: false; initial-value: 0; }
@property --cc-edge-bottom { syntax: '<number>'; inherits: false; initial-value: 0; }
@layer cc.scroll {
  @keyframes cc-edge-top { from { --cc-edge-top: 0; } to { --cc-edge-top: 1; } }
  @keyframes cc-edge-bottom { from { --cc-edge-bottom: 1; } to { --cc-edge-bottom: 0; } }
  :where([${SCROLLER_ATTR}]), :where(:root)::after {
    box-shadow: ${SHADOW_TOP}, ${SHADOW_BOTTOM};
  }
  :where(:root)::after {
    content: '';
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
  }
  @supports (animation-timeline: scroll()) {
    :where([${SCROLLER_ATTR}]) {
      animation: cc-edge-top linear both, cc-edge-bottom linear both;
      animation-timeline: scroll(self block), scroll(self block);
      animation-range: 0px ${EDGE_RAMP_PX}px, calc(100% - ${EDGE_RAMP_PX}px) 100%;
    }
    :where(:root)::after {
      animation: cc-edge-top linear both, cc-edge-bottom linear both;
      animation-timeline: scroll(root block), scroll(root block);
      animation-range: 0px ${EDGE_RAMP_PX}px, calc(100% - ${EDGE_RAMP_PX}px) 100%;
    }
  }
  @supports not (animation-timeline: scroll()) {
    :where([${SCROLLER_ATTR}][${EDGE_TOP_ATTR}]), :where(:root[${EDGE_TOP_ATTR}])::after { --cc-edge-top: 1; }
    :where([${SCROLLER_ATTR}][${EDGE_BOTTOM_ATTR}]), :where(:root[${EDGE_BOTTOM_ATTR}])::after { --cc-edge-bottom: 1; }
  }
}`

/**
 * The bars: thin (`scrollbar-width` does not inherit, hence `*`), and transparent until the element
 * scrolls or the pointer nears its edge. The thumb is still there while transparent, so a drag that
 * starts on it works; the near rule shows it before the pointer gets there. Every scroller gets the
 * transparent colour of its own, so a scrolling ancestor's visible colour (which inherits) does not
 * light up the bars inside it. Not installed on macOS (the theme message's `mac`): its overlay bars
 * already behave like this, and setting either property turns them into always-visible classic bars.
 */
export const BASE_SCROLLBAR_CSS = `@layer cc.scroll {
  :where(*) { scrollbar-width: thin; }
  :where(:root), :where([${SCROLLER_ATTR}]) { scrollbar-color: transparent transparent; }
  :where([${SCROLLING_ATTR}]) { scrollbar-color: color-mix(in srgb, var(--cc-fg, #888) 45%, transparent) transparent; }
  :where([${NEAR_ATTR}]) { scrollbar-color: color-mix(in srgb, var(--cc-fg, #888) 60%, transparent) transparent; }
  @media (prefers-reduced-motion: no-preference) {
    :where(:root), :where([${SCROLLER_ATTR}]) { transition: scrollbar-color 0.2s; }
  }
}`

/** A computed `overflow-x` / `overflow-y` that makes a scroll container the person can scroll. */
export function isScrollOverflow(value: string): boolean {
  return value === 'auto' || value === 'scroll' || value === 'overlay'
}

/**
 * Whether content is hidden above and below, from the element's scroll metrics. One px of slack:
 * at a fractional zoom the bottom-most `scrollTop` can fall short of `scrollHeight - clientHeight`.
 */
export function scrollEdges(scrollTop: number, scrollHeight: number, clientHeight: number): { top: boolean; bottom: boolean } {
  return { top: scrollTop > 1, bottom: scrollTop + clientHeight < scrollHeight - 1 }
}

export interface EdgeBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * The pointer at (x, y) is over the box and within `px` of the edge its bar sits on: the right edge
 * for an element that scrolls vertically, the bottom edge for one that scrolls sideways. An element
 * that cannot scroll that way has no bar to show.
 */
export function nearScrollbar(
  box: EdgeBox,
  x: number,
  y: number,
  scrolls: { vertical: boolean; horizontal: boolean },
  px: number = NEAR_EDGE_PX
): boolean {
  if (x < box.left || x > box.right || y < box.top || y > box.bottom) return false
  if (scrolls.vertical && box.right - x <= px) return true
  return scrolls.horizontal && box.bottom - y <= px
}

/**
 * Which elements show their bar because they scrolled lately: `touch` on every `scroll` event,
 * `expire` when the timer fires. Generic and clock-free so tests run it without a DOM or timers.
 */
export class ScrollingMarks<T> {
  private readonly until = new Map<T, number>()

  constructor(private readonly hold: number = SCROLLING_MS) {}

  /** The item scrolled at `now`; true when it was not marked yet (the caller sets the attribute). */
  touch(item: T, now: number): boolean {
    const fresh = !this.until.has(item)
    this.until.set(item, now + this.hold)
    return fresh
  }

  /** The items whose hold ran out by `now`, forgotten here (the caller removes the attribute). */
  expire(now: number): T[] {
    const out: T[] = []
    for (const [item, end] of this.until) {
      if (end <= now) {
        this.until.delete(item)
        out.push(item)
      }
    }
    return out
  }

  /** When the next hold runs out, or undefined when nothing is marked. */
  next(): number | undefined {
    let min: number | undefined
    for (const end of this.until.values()) if (min === undefined || end < min) min = end
    return min
  }

  get size(): number {
    return this.until.size
  }
}
