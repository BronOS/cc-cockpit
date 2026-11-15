// Split view geometry for the page (design.md §1 "Strip and ways in/out", "Size"; decisions D3, D5,
// D16). Pure and DOM-free like tab-drag.ts, so the rules the person relies on (which pane the
// focus goes to, how far a divider may go, when a narrow view zooms) are unit-tested without a
// window. The tree itself and every edit of it are shared/tab-groups.ts's; this file only reads
// trees and turns pixels into the shares main is asked for.
import {
  AUTO_ZOOM_CELLS,
  GROUP_CAPS,
  PANE_MIN_CELLS,
  isLeaf,
  leavesOf,
  rectsOf,
  removeLeaf,
  type PaneEdge,
  type PaneNode,
  type PaneRect,
  type PaneSplit,
  type TabGroup
} from '../../shared/tab-groups'

export interface Size {
  width: number
  height: number
}

/**
 * Pixels a pane spends on things other than cells: the terminal host's padding (styles.css
 * `.terminal-host`, 18px across and 16px down), the 14px xterm's fit addon keeps for the scrollbar
 * (`DEFAULT_SCROLL_BAR_WIDTH`, taken off whenever there is scrollback) and, while more than one pane
 * shows, the pane header (D8). The minimum and the auto-zoom threshold count the cells the pty
 * really gets, not the box (qa run 1: without the scrollbar a dragged pane ended at 19 columns).
 */
export const PANE_CHROME = Object.freeze({ width: 18 + 14, height: 16, header: 22 })

/**
 * About one cell of the terminal font, for the D5 thresholds only (never for sizing a pty: the
 * terminal measures itself). Monospace advance is close to 0.6 em and xterm's row about 1.2 em
 * times the line height; "about 40x10" does not need better.
 */
export function cellEstimate(font: { size: number; lineHeight?: number; letterSpacing?: number }): Size {
  const size = Number.isFinite(font.size) && font.size > 0 ? font.size : 13
  const lh = font.lineHeight !== undefined && Number.isFinite(font.lineHeight) && font.lineHeight >= 1 ? font.lineHeight : 1
  const ls = font.letterSpacing !== undefined && Number.isFinite(font.letterSpacing) ? font.letterSpacing : 0
  return { width: Math.max(1, size * 0.6 + ls), height: Math.max(1, Math.ceil(size * 1.2 * lh)) }
}

/** A fractional rect (rectsOf) in pixels of an area. */
export function toPx(r: PaneRect, area: Size): PaneRect {
  return { x: r.x * area.width, y: r.y * area.height, w: r.w * area.width, h: r.h * area.height }
}

/**
 * Pixels lost to rounding: a pane's box is a fraction of the area (187.92px), and the fit addon
 * floors its parent's width before counting cells, so a pane computed to hold exactly 20 columns
 * got 19 (qa run 1 Q4). Every check takes it off; a divider's stop adds one more pixel on top, so a
 * pane dragged to the stop never reads as under the minimum (which would auto-zoom it, D5).
 */
const ROUNDING_PX = 1

/** Whether a pane of `px` pixels holds `min` cells, its chrome and the rounding taken off. */
export function holdsCells(
  px: { w: number; h: number },
  cell: Size,
  min: { cols: number; rows: number },
  header: boolean
): boolean {
  const w = px.w - PANE_CHROME.width - ROUNDING_PX
  const h = px.h - PANE_CHROME.height - (header ? PANE_CHROME.header : 0) - ROUNDING_PX
  if (!(cell.width > 0) || !(cell.height > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return false
  return Math.floor(w / cell.width) >= min.cols && Math.floor(h / cell.height) >= min.rows
}

/**
 * D5's automatic zoom: a view whose group, drawn at `area`, would give some pane fewer than about
 * 40x10 cells (a phone, a narrow window) shows only the focused pane. Decided per view and never
 * saved; an area not measured yet (0x0) zooms nothing.
 */
export function needsAutoZoom(root: PaneNode, area: Size, cell: Size, min: { cols: number; rows: number } = AUTO_ZOOM_CELLS): boolean {
  if (!(area.width > 0) || !(area.height > 0)) return false
  return rectsOf(root).panes.some((p) => !holdsCells(toPx(p, area), cell, min, true))
}

/** `root` with every split's children equal. */
function evened(root: PaneNode): PaneNode {
  if (isLeaf(root)) return root
  return { ...root, children: root.children.map(evened), sizes: root.children.map(() => 1 / root.children.length) }
}

/**
 * The view shows the group zoomed to its focused pane (D5), for either of two reasons:
 * - the view is narrow for this arrangement: even with every split equal, some pane would get
 *   under about 40x10 (a phone, a small window). Judged on equal shares, not the shared ones, so a
 *   divider the person dragged on a large screen (down to the 20x5 minimum) does not zoom it there;
 * - or a pane at the shared sizes falls under the 20x5 minimum here (sizes set on a wide screen,
 *   seen on a narrow one), where its terminal would be unusable.
 */
export function autoZoomed(root: PaneNode, area: Size, cell: Size): boolean {
  return needsAutoZoom(evened(root), area, cell) || needsAutoZoom(root, area, cell, PANE_MIN_CELLS)
}

/**
 * Whether the pane of `tabId` can be split on `edge` (D5): the new pane takes half of it, and both
 * halves must still hold PANE_MIN_CELLS. `paneRect` is the pane's rect in pixels as drawn now (a
 * plain tab: the whole terminal area). A split always shows headers after it.
 */
export function splitFits(paneRect: { w: number; h: number }, edge: PaneEdge, cell: Size): boolean {
  const half = edge === 'left' || edge === 'right' ? { w: paneRect.w / 2, h: paneRect.h } : { w: paneRect.w, h: paneRect.h / 2 }
  return holdsCells(half, cell, PANE_MIN_CELLS, true)
}

/** Overlap area of two rects (any unit). */
function overlap(a: PaneRect, b: PaneRect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * "The pane that took its space" (D3, the person's own close or move out): of the panes left in
 * `after` (undefined: the group dissolved), the one covering most of where `tabId` was in `before`.
 * A dissolved group leaves one tab, `remaining`, which is the answer. Undefined when `tabId` was
 * not in `before`.
 */
export function tookItsSpace(before: PaneNode, after: PaneNode | undefined, tabId: string, remaining?: string): string | undefined {
  const was = rectsOf(before).panes.find((p) => p.tab === tabId)
  if (!was) return undefined
  if (!after) return remaining
  let best: { tab: string; area: number } | undefined
  for (const p of rectsOf(after).panes) {
    if (p.tab === tabId) continue
    const a = overlap(was, p)
    if (!best || a > best.area) best = { tab: p.tab, area: a }
  }
  return best?.tab
}

/**
 * Where the focus goes when `tabId` leaves its group, computed from the arrangement the page holds
 * (main's snapshot may come before or after the close): removeLeaf on the page's copy, then the
 * pane that took its space. Undefined for a plain tab.
 */
export function successorInGroup(groups: readonly TabGroup[], order: readonly string[], tabId: string): string | undefined {
  const group = groups.find((g) => leavesOf(g.root).includes(tabId))
  if (!group) return undefined
  const result = removeLeaf(groups, order, tabId)
  if (!result.ok) return undefined
  const after = result.groups.find((g) => g.id === group.id)
  const remaining = after ? undefined : leavesOf(group.root).find((t) => t !== tabId)
  return tookItsSpace(group.root, after?.root, tabId, remaining)
}

/** The path from `root` to the leaf of `tabId`: each split with the index of the child taken. */
function pathTo(root: PaneNode, tabId: string): Array<{ split: PaneSplit; index: number }> | undefined {
  if (isLeaf(root)) return root.tab === tabId ? [] : undefined
  for (let i = 0; i < root.children.length; i++) {
    const rest = pathTo(root.children[i]!, tabId)
    if (rest) return [{ split: root, index: i }, ...rest]
  }
  return undefined
}

/**
 * Move divider `index` of `sizes` (between child index and index+1) by `delta` (a share of the
 * split), keeping both children at least `min`. Only those two change; the result keeps the sum.
 */
export function moveDivider(sizes: readonly number[], index: number, delta: number, min: number): number[] {
  const out = [...sizes]
  const a = out[index]
  const b = out[index + 1]
  if (a === undefined || b === undefined || !Number.isFinite(delta)) return out
  const lo = Math.min(0, min - a)
  const hi = Math.max(0, b - min)
  const d = Math.max(lo, Math.min(hi, delta))
  out[index] = a + d
  out[index + 1] = b - d
  return out
}

/**
 * The resize chord on the focused pane (⌥⇧⌘Arrow, D10): moves the divider on that side of the
 * pane in the arrow's direction (Right grows a pane with a neighbour on its right), else the
 * divider on its other side (Right shrinks the rightmost pane from the left). The nearest split
 * along that axis wins, as tmux's resize-pane does. Undefined when the pane has no divider along
 * that axis or it is already at the limit.
 */
export function nudgePane(
  root: PaneNode,
  tabId: string,
  dir: PaneEdge,
  step: number,
  min = GROUP_CAPS.minShare
): { splitId: string; sizes: number[] } | undefined {
  const path = pathTo(root, tabId)
  if (!path) return undefined
  const axis = dir === 'left' || dir === 'right' ? 'row' : 'column'
  const forward = dir === 'right' || dir === 'down'
  for (let i = path.length - 1; i >= 0; i--) {
    const { split, index } = path[i]!
    if (split.dir !== axis) continue
    // The divider after the pane moves forward or back; with none after it, the one before it.
    const divider = index < split.children.length - 1 ? index : index > 0 ? index - 1 : -1
    if (divider < 0) continue
    const sizes = moveDivider(split.sizes, divider, forward ? step : -step, min)
    if (sizes.every((s, k) => Math.abs(s - split.sizes[k]!) < 1e-9)) return undefined
    return { splitId: split.id, sizes }
  }
  return undefined
}

/** Equalize (handle menu, D16): one `{splitId, sizes}` per split whose children are not equal yet. */
export function equalizeSplits(root: PaneNode): Array<{ splitId: string; sizes: number[] }> {
  const out: Array<{ splitId: string; sizes: number[] }> = []
  const walk = (n: PaneNode): void => {
    if (isLeaf(n)) return
    const even = 1 / n.children.length
    if (n.sizes.some((s) => Math.abs(s - even) > 1e-6)) out.push({ splitId: n.id, sizes: n.children.map(() => even) })
    n.children.forEach(walk)
  }
  walk(root)
  return out
}

/** A split's sizes with every child equal (a divider's double-click, D16). */
export function evenSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n)
}

/**
 * The smallest share a child of a split may get during a divider drag: main's 10% clamp, or
 * PANE_MIN_CELLS of the split's own pixel extent, whichever is larger (D5: a drag stops at the
 * minimum rather than send a size main or the terminal would refuse).
 */
export function dragMinShare(splitPx: number, axis: 'row' | 'column', cell: Size): number {
  const cells =
    (axis === 'row' ? PANE_MIN_CELLS.cols * cell.width + PANE_CHROME.width : PANE_MIN_CELLS.rows * cell.height + PANE_CHROME.height + PANE_CHROME.header) +
    ROUNDING_PX +
    1
  if (!(splitPx > 0)) return GROUP_CAPS.minShare
  return Math.min(0.5, Math.max(GROUP_CAPS.minShare, cells / splitPx))
}

/** The share of the drop zone along each side of a pane (design §1: about 30% of each side). */
export const EDGE_ZONE = 0.3

/**
 * Which edge zone of a pane `point` is in (pane mode of a strip drag): the nearest edge, when the
 * point is within EDGE_ZONE of it; null in the middle (a drop there cancels) or outside the pane.
 * Distances are compared as shares of the pane, so a wide pane's left and right zones are as easy
 * to hit as a tall one's top and bottom.
 */
export function edgeZone(pane: PaneRect, point: { x: number; y: number }): PaneEdge | null {
  if (!(pane.w > 0) || !(pane.h > 0)) return null
  const fx = (point.x - pane.x) / pane.w
  const fy = (point.y - pane.y) / pane.h
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null
  const near: Array<[PaneEdge, number]> = [
    ['left', fx],
    ['right', 1 - fx],
    ['up', fy],
    ['down', 1 - fy]
  ]
  near.sort((a, b) => a[1] - b[1])
  const [edge, d] = near[0]!
  return d <= EDGE_ZONE ? edge : null
}

/** The part of a pane a drop on `edge` would give the new pane: the preview drawn in pane mode. */
export function edgePreview(pane: PaneRect, edge: PaneEdge): PaneRect {
  switch (edge) {
    case 'left':
      return { x: pane.x, y: pane.y, w: pane.w / 2, h: pane.h }
    case 'right':
      return { x: pane.x + pane.w / 2, y: pane.y, w: pane.w / 2, h: pane.h }
    case 'up':
      return { x: pane.x, y: pane.y, w: pane.w, h: pane.h / 2 }
    case 'down':
      return { x: pane.x, y: pane.y + pane.h / 2, w: pane.w, h: pane.h / 2 }
  }
}

/** "Right of npm dev": the preview's label and the menu's wording. */
export function edgeWords(edge: PaneEdge): string {
  return edge === 'left' ? 'Left of' : edge === 'right' ? 'Right of' : edge === 'up' ? 'Above' : 'Below'
}

/** How far below the strip (px) a tab drag turns into pane mode (design §1: about 24px). */
export const PANE_MODE_PX = 24

/** `root` with split `splitId`'s sizes replaced (a drag in progress or a resize main has not echoed yet). */
export function withSizes(root: PaneSplit, splitId: string, sizes: readonly number[]): PaneSplit {
  const walk = (n: PaneNode): PaneNode => {
    if (isLeaf(n)) return n
    const children = n.children.map(walk)
    const own = n.id === splitId && sizes.length === n.children.length ? [...sizes] : n.sizes
    return { ...n, children, sizes: own }
  }
  return walk(root) as PaneSplit
}

/** The sizes of split `splitId` in `root`, or undefined. */
export function sizesOf(root: PaneNode, splitId: string): number[] | undefined {
  if (isLeaf(root)) return undefined
  if (root.id === splitId) return root.sizes
  for (const c of root.children) {
    const s = sizesOf(c, splitId)
    if (s) return s
  }
  return undefined
}

/** A frame's box in pixels, relative to the split area (the page tab layer's box). */
export interface FrameBox {
  tab: string
  left: number
  top: number
  width: number
  height: number
}

/** What `frameBoxes` reads of the view: the panes drawn now, whether zoomed, which of them are page tabs. */
export interface FrameView {
  /** The panes drawn now (PaneView.visible): the plain tab, the zoomed pane or every pane of the group. */
  visible: readonly string[]
  /** Zoomed by the person or by D5's automatic zoom: the one visible pane fills the area. */
  zoomed: boolean
  /** Whether a tab is a page tab (the only panes with a frame). */
  isPage(tabId: string): boolean
}

/**
 * Pixels a frame leaves uncovered on each side of its pane while several panes show
 * (design-split-pages.md §2): the splitter's grab zone (`::before`, 3px into each neighbour) and the
 * focused pane's 2px outline (`.pane[data-focused-pane]::after`) are drawn in `.terminals`, under the
 * frame layer, so whatever a frame covered could be neither seen nor grabbed.
 */
export const FRAME_INSET_PX = 3

/**
 * Where each visible page pane's frame goes (design-split-pages.md §2): its `rectsOf` rect in pixels
 * of `area`, less the pane header (the one line a page cannot draw: the shell's own, naming the
 * plugin) and FRAME_INSET_PX on each side while `many` panes show. A plain or zoomed page tab gets
 * the whole area, no inset. Terminal panes yield nothing (they draw themselves); an area not
 * measured yet (0x0) yields nothing. `root` is the arrangement as drawn now, a live divider drag's
 * sizes included (SplitArea's `withSizes`), so frames move with the divider. Pure and DOM-free: the
 * area is the layer's measured box (PageTabArea), never SplitArea's lagging `area` state. Edges are
 * rounded to whole pixels, so neighbouring frames never overlap and their text is not blurred.
 */
export function frameBoxes(view: FrameView, root: PaneNode | undefined, area: Size, many: boolean): FrameBox[] {
  if (!(area.width > 0) || !(area.height > 0)) return []
  const pages = view.visible.filter((id) => view.isPage(id))
  if (pages.length === 0) return []
  const rects = root !== undefined && !view.zoomed ? rectsOf(root).panes : undefined
  const inset = many ? FRAME_INSET_PX : 0
  const header = many ? PANE_CHROME.header : 0
  const out: FrameBox[] = []
  for (const tab of pages) {
    const frac = rects ? rects.find((p) => p.tab === tab) : { x: 0, y: 0, w: 1, h: 1 }
    if (!frac) continue
    const px = toPx(frac, area)
    const left = Math.min(Math.round(px.x + inset), area.width)
    // A pane shorter than header + insets would put the top below the pane (or the area): clamp it.
    const top = Math.min(Math.round(px.y + header + inset), area.height)
    const right = Math.round(px.x + px.w - inset)
    const bottom = Math.round(px.y + px.h - inset)
    out.push({ tab, left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) })
  }
  return out
}
