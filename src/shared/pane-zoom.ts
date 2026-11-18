// D5's automatic zoom, in pixels: the one rule the page draws by (renderer/tabs/pane-layout.ts) and main places a
// plugin's `beside` by (main/tabs/tab-groups.ts `panesFit`, from each view's reported split geometry). Pure and
// DOM-free, so both sides run the very same arithmetic: main once had its own approximation in terminal cells, which
// disagreed with the view at tiny fonts, near the 40-column boundary and with dragged shares (codex review of 496bcbf).
// Not imported by src/sdk/panel.ts (a module shared with it becomes a chunk the page cannot load, CLAUDE.md).
import { AUTO_ZOOM_CELLS, PANE_MIN_CELLS, evenRoot, rectsOf, type PaneNode, type PaneRect } from './tab-groups'

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
 * Pixels lost to rounding: a pane's box is a fraction of the area (187.92px), and the fit addon
 * floors its parent's width before counting cells, so a pane computed to hold exactly 20 columns
 * got 19 (qa run 1 Q4). Every check takes it off; a divider's stop adds one more pixel on top, so a
 * pane dragged to the stop never reads as under the minimum (which would auto-zoom it, D5).
 */
export const ROUNDING_PX = 1

/** A fractional rect (rectsOf) in pixels of an area. */
export function toPx(r: PaneRect, area: Size): PaneRect {
  return { x: r.x * area.width, y: r.y * area.height, w: r.w * area.width, h: r.h * area.height }
}

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
 * 40x6 cells (a phone, a narrow window) shows only the focused pane. Decided per view and never
 * saved; an area not measured yet (0x0) zooms nothing.
 */
export function needsAutoZoom(root: PaneNode, area: Size, cell: Size, min: { cols: number; rows: number } = AUTO_ZOOM_CELLS): boolean {
  if (!(area.width > 0) || !(area.height > 0)) return false
  return rectsOf(root).panes.some((p) => !holdsCells(toPx(p, area), cell, min, true))
}

/**
 * The view shows the group zoomed to its focused pane (D5), for either of two reasons:
 * - the view is narrow for this arrangement: even with every split equal, some pane would get
 *   under about 40x6 (a phone, a small window). Judged on equal shares, not the shared ones, so a
 *   divider the person dragged on a large screen (down to the 20x5 minimum) does not zoom it there;
 * - or a pane at the shared sizes falls under the 20x5 minimum here (sizes set on a wide screen,
 *   seen on a narrow one), where its terminal would be unusable.
 */
export function autoZoomed(root: PaneNode, area: Size, cell: Size): boolean {
  return needsAutoZoom(evenRoot(root), area, cell) || needsAutoZoom(root, area, cell, PANE_MIN_CELLS)
}

/**
 * What a view reports of its split view (`groups.area`): the tab area's size in pixels (what it calls autoZoomed with)
 * and its cell (measured, else estimated). Main judges a plugin's placement by it, with autoZoomed.
 */
export interface SplitGeometry {
  area: Size
  cell: Size
}

/** Bounds of a reported geometry: an 8K screen at 4x zoom fits under the area cap; a cell over 200 px is no terminal font. */
export const SPLIT_GEOMETRY_CAPS = Object.freeze({ area: 32768, cell: 200 })

/**
 * A view's report checked (main: the payload is a view's word): every number finite, positive and under its cap, the
 * fields exactly these. Undefined for anything else, which main then ignores.
 */
export function splitGeometryOf(raw: unknown): SplitGeometry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { area, cell } = raw as Record<string, unknown>
  const size = (v: unknown, max: number): Size | undefined => {
    if (typeof v !== 'object' || v === null) return undefined
    const { width, height } = v as Record<string, unknown>
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= max
    return ok(width) && ok(height) ? { width, height } : undefined
  }
  const a = size(area, SPLIT_GEOMETRY_CAPS.area)
  const c = size(cell, SPLIT_GEOMETRY_CAPS.cell)
  return a && c ? { area: a, cell: c } : undefined
}
