// A project window's saved bounds (`ProjectRecord.bounds`): validating what the record holds and
// fitting it onto the displays connected now. Pure (no `electron` import) so vitest covers every
// case; the Electron side (`electron-window-factory.ts`) only applies the result.
import type { WindowBounds } from '../../shared/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A project window's minimum size (the factory passes these as minWidth / minHeight). */
export const MIN_WINDOW_WIDTH = 480
export const MIN_WINDOW_HEIGHT = 320

/**
 * Larger than any real display arrangement. A record is user-writable, and a width of 1e9 is
 * finite but would ask the OS for an absurd window; anything over this is clamped down (and then
 * to the display's work area by `fitBounds`).
 */
const MAX_WINDOW_SIDE = 16384

/**
 * How much of a restored window must overlap some display to keep its saved position. Below
 * this (an external monitor was unplugged since last time) the window would open off screen
 * with no way to grab its title bar, so it is moved onto the nearest display instead.
 */
const MIN_VISIBLE_PX = 64

/**
 * The record's `bounds` as usable bounds, or undefined (use the default size, OS-centred). The
 * record is a user-writable file and older builds wrote fewer fields, so this is checked, never
 * cast: width/height must be finite positive numbers (else the whole value is damaged and
 * dropped: half a size is no size), x/y count only as a finite pair (else the size is kept and the
 * OS centres the window), and the window-state flags only when literally `true`. Numbers are
 * rounded: the OS works in whole pixels, and Electron rejects fractional bounds in some calls.
 */
export function sanitizeBounds(value: unknown): WindowBounds | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const width = positive(v['width'])
  const height = positive(v['height'])
  if (width === undefined || height === undefined) return undefined
  const bounds: WindowBounds = {
    width: Math.min(Math.max(width, MIN_WINDOW_WIDTH), MAX_WINDOW_SIDE),
    height: Math.min(Math.max(height, MIN_WINDOW_HEIGHT), MAX_WINDOW_SIDE)
  }
  const x = finite(v['x'])
  const y = finite(v['y'])
  if (x !== undefined && y !== undefined) {
    bounds.x = x
    bounds.y = y
  }
  return withFlags(bounds, v['maximized'] === true, v['fullScreen'] === true)
}

/**
 * Sanitized bounds made safe to apply on the displays connected now. `workAreas` lists the
 * primary display first (the factory's contract).
 * - Overlapping some display by at least MIN_VISIBLE_PX each way: kept as saved, even when it
 *   spans two displays (a legitimate setup that a per-display clamp would shrink).
 * - Off every display (a monitor unplugged, a resolution drop): clamped onto the nearest display,
 *   shrunk to its work area if needed, so the whole window including its title bar is on screen.
 *   Clamping (not re-centring) keeps it near where the user put it, as macOS itself does.
 * - Size only (no saved position): the size, shrunk to the primary work area; the OS centres it.
 * The maximized / full-screen flags pass through: the factory restores the normal bounds first,
 * so un-maximising lands on them.
 */
export function fitBounds(
  bounds: WindowBounds | undefined,
  workAreas: readonly Rect[]
): WindowBounds | undefined {
  if (!bounds) return undefined
  // No display information at all (should not happen): nothing to fit against, trust the record.
  if (workAreas.length === 0) return bounds
  const flagged = (b: WindowBounds): WindowBounds =>
    withFlags(b, bounds.maximized === true, bounds.fullScreen === true)
  const { x, y, width, height } = bounds
  if (x === undefined || y === undefined) {
    const primary = workAreas[0]!
    return flagged({ width: Math.min(width, primary.width), height: Math.min(height, primary.height) })
  }
  const visible = workAreas.some((a) => {
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x)
    const h = Math.min(y + height, a.y + a.height) - Math.max(y, a.y)
    return w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX
  })
  if (visible) return flagged({ x, y, width, height })

  // Nearest by the gap between the rectangles (0 when they touch or overlap by a sliver); the
  // first one wins a tie, which is the primary display.
  let nearest = workAreas[0]!
  let best = Infinity
  for (const a of workAreas) {
    const dx = Math.max(a.x - (x + width), 0, x - (a.x + a.width))
    const dy = Math.max(a.y - (y + height), 0, y - (a.y + a.height))
    const gap = dx * dx + dy * dy
    if (gap < best) {
      best = gap
      nearest = a
    }
  }
  const w = Math.min(width, nearest.width)
  const h = Math.min(height, nearest.height)
  return flagged({
    x: clamp(x, nearest.x, nearest.x + nearest.width - w),
    y: clamp(y, nearest.y, nearest.y + nearest.height - h),
    width: w,
    height: h
  })
}

/**
 * The flags are set only when true: a record of a plain window stays `{x, y, width, height}`, the
 * shape every build so far has written.
 */
function withFlags(bounds: WindowBounds, maximized: boolean, fullScreen: boolean): WindowBounds {
  if (maximized) bounds.maximized = true
  if (fullScreen) bounds.fullScreen = true
  return bounds
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined
}

function positive(value: unknown): number | undefined {
  const n = finite(value)
  return n !== undefined && n > 0 ? n : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
