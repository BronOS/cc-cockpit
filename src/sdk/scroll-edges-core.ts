// Edges-only scrolling (the shell and every plugin page): no scrollbar at rest, the content fading
// out over the top edge while content is hidden above and over the bottom edge while content is
// hidden below, and the bar shown while the element scrolls (about a second after the last scroll)
// or while the pointer is near the container's right edge, to grab it. The bars stay the browser's
// own (drag, keyboard, accessibility); only their colour changes, and `scrollbar-width: thin` keeps
// their strip reserved, so rows never move sideways when the thumb appears or goes.
//
// DOM-free, so unit tests run it in plain Node: the stylesheets, and the pure rules the page script
// (scroll-edges.ts) applies. Both the shell (src/renderer/main.tsx, web/main.tsx) and the panel SDK
// (panel.ts, through panel-core.ts) take them from here, so the two cannot drift.
//
// How the page script and the sheets split the work:
//   data-cc-scroller        the script marks every element whose computed overflow is auto or scroll
//                           (not the root: the viewport is handled by `:root::after`). Only these
//                           get the fade: an animation on every element would cost too much, and
//                           CSS has no selector for "is a scroll container".
//   --cc-edge-top/-bottom   0 to 1, driven by two scroll-driven animations on the element's own
//                           scroll position (`animation-timeline: scroll(self)`), ramped over the
//                           first and last 24px: no script runs while scrolling, and a list that grows
//                           or shrinks updates by itself. A scroller that does not overflow has an
//                           inactive timeline, so both stay at 0. Where the browser lacks scroll
//                           timelines or `if()` (Firefox, Safari, through web access: EDGE_TIMELINES),
//                           the script sets data-cc-edge-top / -bottom from scroll and resize instead.
//   data-cc-scrolling       set on the element a `scroll` event came from, removed SCROLLING_MS after
//                           its last one (ScrollingMarks)
//   data-cc-scroll-near     the scroller whose right (or bottom) edge is within NEAR_EDGE_PX of the
//                           pointer (nearScrollbar), at most one at a time
//   --cc-edge-canvas        on the root, set by the script: the page's own background colour, for the
//                           document scroller's fade (see SCROLL_EDGES_CSS)
//
// Everything is in `@layer cc.scroll` with `:where()` selectors: a sub-layer of the component sheet's
// `cc` layer, so the components' own rules, the shell's rules and any page rule win over it. A page
// that wants no fade on an element sets its own `mask-image` (none).

/** How long the bar stays after an element's last `scroll` event. */
export const SCROLLING_MS = 1000
/** The pointer within this many px of a scroller's right (or bottom) edge shows its bar. */
export const NEAR_EDGE_PX = 24
/** The fade ramps in over this much scrolling from either end (scroll-driven `animation-range`). */
export const EDGE_RAMP_PX = 24
/** How deep the fade reaches into the content from the edge. */
export const EDGE_FADE_PX = 24

export const SCROLLER_ATTR = 'data-cc-scroller'
export const SCROLLING_ATTR = 'data-cc-scrolling'
export const NEAR_ATTR = 'data-cc-scroll-near'
export const EDGE_TOP_ATTR = 'data-cc-edge-top'
export const EDGE_BOTTOM_ATTR = 'data-cc-edge-bottom'
/** The page's own background colour, on the root (the document scroller's fade). */
export const EDGE_CANVAS_VAR = '--cc-edge-canvas'

/**
 * What the CSS path needs, as `@supports` conditions: scroll timelines drive the numbers, and `if()`
 * keeps the mask off while neither edge is hidden. Safari 26 has the first and not the second; there
 * a declaration with `if()` holds `var()`, so it would parse and then compute to nothing (no fade at
 * all). Both or the attribute path: the script asks `CSS.supports` the same two questions.
 */
export const EDGE_TIMELINES = ['animation-timeline: scroll()', 'mask-image: if(style(--cc-edge-top: 0): none; else: none)'] as const

// The fade is a mask: the content goes from opaque 24px in to fully transparent at the edge, so it
// fades into whatever is behind the scroller (the owner's pick over a shadow: an inset shadow paints
// under the children, and an opaque card hid it). Its alpha at the edge is 1 - the edge's number.
const fadeStop = (edge: string): string => `rgb(0 0 0 / calc(1 - var(${edge})))`
const EDGE_MASK = `linear-gradient(to bottom, ${fadeStop('--cc-edge-top')} 0, #000 ${EDGE_FADE_PX}px, #000 calc(100% - ${EDGE_FADE_PX}px), ${fadeStop('--cc-edge-bottom')} 100%)`
// A mask makes a stacking context and paints every descendant clipped to the box (position: fixed
// ones too), so it is on only while an edge is hidden: a scroller at rest with nothing hidden, and
// one that does not overflow, keep `none`. Form fields that scroll (a textarea, a list box) never
// get it: it would clip their focus ring and outer shadow, which paint outside the box.
const MASKED = `[${SCROLLER_ATTR}]:not(textarea):not(select)`
const EDGE_MASK_GATED = `if(style(--cc-edge-top: 0) and style(--cc-edge-bottom: 0): none; else: ${EDGE_MASK})`
// The document scroller has no box that stays at the viewport's edges (a mask on the root scrolls
// with the document), so a fixed overlay above the content veils it in the page's own background:
// the colour the script found, or the theme's, or the system's canvas.
const CANVAS = `var(${EDGE_CANVAS_VAR}, var(--cc-bg, Canvas))`
const veil = (edge: string): string => `color-mix(in srgb, ${CANVAS} calc(100% * var(${edge})), transparent)`
const EDGE_VEIL = `linear-gradient(to bottom, ${veil('--cc-edge-top')} 0, transparent ${EDGE_FADE_PX}px, transparent calc(100% - ${EDGE_FADE_PX}px), ${veil('--cc-edge-bottom')} 100%)`

/**
 * The fade, on every platform. Installed at once, before the first theme. Two numbers are
 * registered (`@property`) so the animations interpolate them and `style()` compares them.
 *
 * The root scroller (a page whose document scrolls) gets a fixed `:root::after` overlay instead,
 * driven by the root's timeline; it is above the content (pointer-events none) and paints nothing
 * while its timeline is inactive.
 */
export const SCROLL_EDGES_CSS = `@property --cc-edge-top { syntax: '<number>'; inherits: false; initial-value: 0; }
@property --cc-edge-bottom { syntax: '<number>'; inherits: false; initial-value: 0; }
@layer cc.scroll {
  @keyframes cc-edge-top { from { --cc-edge-top: 0; } to { --cc-edge-top: 1; } }
  @keyframes cc-edge-bottom { from { --cc-edge-bottom: 1; } to { --cc-edge-bottom: 0; } }
  :where(:root)::after {
    content: '';
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    pointer-events: none;
    background: ${EDGE_VEIL};
  }
  @supports (${EDGE_TIMELINES[0]}) and (${EDGE_TIMELINES[1]}) {
    :where([${SCROLLER_ATTR}]) {
      animation: cc-edge-top linear both, cc-edge-bottom linear both;
      animation-timeline: scroll(self block), scroll(self block);
      animation-range: 0px ${EDGE_RAMP_PX}px, calc(100% - ${EDGE_RAMP_PX}px) 100%;
    }
    :where(${MASKED}) { mask-image: ${EDGE_MASK_GATED}; }
    :where(:root)::after {
      animation: cc-edge-top linear both, cc-edge-bottom linear both;
      animation-timeline: scroll(root block), scroll(root block);
      animation-range: 0px ${EDGE_RAMP_PX}px, calc(100% - ${EDGE_RAMP_PX}px) 100%;
    }
  }
  @supports not ((${EDGE_TIMELINES[0]}) and (${EDGE_TIMELINES[1]})) {
    :where([${SCROLLER_ATTR}][${EDGE_TOP_ATTR}]), :where(:root[${EDGE_TOP_ATTR}])::after { --cc-edge-top: 1; }
    :where([${SCROLLER_ATTR}][${EDGE_BOTTOM_ATTR}]), :where(:root[${EDGE_BOTTOM_ATTR}])::after { --cc-edge-bottom: 1; }
    :where(${MASKED}[${EDGE_TOP_ATTR}]), :where(${MASKED}[${EDGE_BOTTOM_ATTR}]) { mask-image: ${EDGE_MASK}; }
  }
}`

/**
 * The bars: thin (`scrollbar-width` does not inherit, hence `*`), and transparent until the element
 * scrolls or the pointer nears its edge. The thumb is still there while transparent, so a drag that
 * starts on it works; the near rule shows it before the pointer gets there. Every scroller gets the
 * transparent colour of its own, so a scrolling ancestor's visible colour (which inherits) does not
 * light up the bars inside it.
 *
 * On macOS only while its bars are classic (always shown: a mouse is connected and "Show scroll
 * bars" is Automatic, or the setting is Always), measured by the page itself (watchClassicBars in
 * scroll-edges.ts) and turned off again when they become overlay bars: those already hide at rest,
 * and setting either property turns them into always-visible classic bars.
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

/**
 * The bars' style from a probe that scrolls both ways and that no sheet styles: true for classic
 * bars (they take layout room), false for overlay bars, undefined when the probe has no layout (a
 * frame that is `display: none`): the caller keeps what it had.
 */
export function classicBars(offsetWidth: number, clientWidth: number): boolean | undefined {
  if (offsetWidth <= 0) return undefined
  return offsetWidth - clientWidth > 0
}

/**
 * A computed background colour that paints nothing (the page leaves its background to the frame
 * under it): `transparent`, or any colour with a zero alpha in the forms Chromium, WebKit and Gecko
 * serialise.
 */
export function isClearColour(colour: string): boolean {
  const c = colour.trim().toLowerCase()
  if (c === '' || c === 'transparent') return true
  return /^rgba\(.*,\s*0(\.0+)?\s*\)$/.test(c) || /\/\s*0(\.0+)?\s*\)$/.test(c)
}

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
