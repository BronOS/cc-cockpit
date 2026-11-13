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
  neighbour,
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
 * `.terminal-host`, 18px across and 16px down) and, while more than one pane shows, the pane header
 * (D8). The minimum and the auto-zoom threshold count cells the terminal really gets, not the box.
 */
export const PANE_CHROME = Object.freeze({ width: 18, height: 16, header: 22 })

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

/** Whether a pane of `px` pixels holds `min` cells, its chrome taken off. */
export function holdsCells(
  px: { w: number; h: number },
  cell: Size,
  min: { cols: number; rows: number },
  header: boolean
): boolean {
  const w = px.w - PANE_CHROME.width
  const h = px.h - PANE_CHROME.height - (header ? PANE_CHROME.header : 0)
  if (!(cell.width > 0) || !(cell.height > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return false
  return Math.floor(w / cell.width) >= min.cols && Math.floor(h / cell.height) >= min.rows
}

/**
 * D5's automatic zoom: a view whose group, drawn at `area`, would give some pane fewer than about
 * 40x10 cells (a phone, a narrow window) shows only the focused pane. Decided per view and never
 * saved; an area not measured yet (0x0) zooms nothing.
 */
export function needsAutoZoom(root: PaneNode, area: Size, cell: Size, min = AUTO_ZOOM_CELLS): boolean {
  if (!(area.width > 0) || !(area.height > 0)) return false
  return rectsOf(root).panes.some((p) => !holdsCells(toPx(p, area), cell, min, true))
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
  const cells = axis === 'row' ? PANE_MIN_CELLS.cols * cell.width + PANE_CHROME.width : PANE_MIN_CELLS.rows * cell.height + PANE_CHROME.height + PANE_CHROME.header
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

/** The focus chord's target (⌥⌘Arrow): the spatial neighbour, no wrap (shared/tab-groups.ts). */
export function focusTarget(root: PaneNode, tabId: string, dir: PaneEdge): string | undefined {
  return neighbour(root, tabId, dir)
}

/** How far below the strip (px) a tab drag turns into pane mode (design §1: about 24px). */
export const PANE_MODE_PX = 24
