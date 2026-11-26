// Parts' layout in their window (shared/design-parts.md §4), pure: OverlayParts.tsx draws it. The parent's body is a row
// (side by side, wide), a column (stacked) or one frame at a time behind a switch (narrow). Each part's share is
// remembered per (opener plugin, part plugin) per device in the browser's own storage, as a remote view keeps its
// zone sizes (zones/view-geometry.ts): never in main, and storage that is missing or throws gives the default.

/** A part starts at this share of the body, and stays within these bounds. */
export const PART_DEFAULT = 0.4
export const PART_MIN = 0.25
export const PART_MAX = 0.6
/** The opener keeps at least this share, however many parts there are. */
export const OPENER_MIN = 0.25

/** Side by side from this body width (px); stacked below it; one frame behind a switch below SWITCH_BELOW. */
export const SIDE_BY_SIDE_FROM = 1280
export const SWITCH_BELOW = 700

export type PartSplitMode = 'side' | 'stacked' | 'switch'

/** The layout for a body `width` px wide (a width not measured yet counts as wide: it is measured on mount). */
export function partSplitMode(width: number): PartSplitMode {
  if (!Number.isFinite(width) || width >= SIDE_BY_SIDE_FROM) return 'side'
  return width >= SWITCH_BELOW ? 'stacked' : 'switch'
}

/** A share clamped to PART_MIN..PART_MAX; anything that is not a finite number is the default. */
export function clampPartFraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return PART_DEFAULT
  return Math.min(PART_MAX, Math.max(PART_MIN, value))
}

/**
 * The parts' shares as drawn: each clamped, then all scaled down together when they would leave the opener less than
 * OPENER_MIN (two parts at 60% each). The opener takes the rest.
 */
export function partShares(fractions: readonly number[]): number[] {
  const clamped = fractions.map(clampPartFraction)
  const total = clamped.reduce((a, b) => a + b, 0)
  const room = 1 - OPENER_MIN
  return total > room ? clamped.map((f) => (f * room) / total) : clamped
}

/**
 * A divider drag: the part's new share from where the pointer is. Side by side the parts sit right of the opener, so
 * the part's share grows as the pointer moves left (`pos` is the pointer's distance from the body's start, `size`
 * the body's length on that axis, `after` the shares of the parts after this one). Clamped.
 */
export function dragPartFraction(pos: number, size: number, after: number): number {
  if (!Number.isFinite(pos) || !Number.isFinite(size) || size <= 0) return PART_DEFAULT
  return clampPartFraction(1 - pos / size - after)
}

/** The part of `localStorage` this needs; structural so tests can pass a fake. */
export interface PartStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const PART_SPLIT_KEY_PREFIX = 'cc-cockpit.part-split.'

function keyOf(opener: string, part: string): string {
  return `${PART_SPLIT_KEY_PREFIX}${opener}|${part}`
}

/**
 * The remembered share of `part` in `opener`'s windows on this device, or the default. `storage` is a getter: merely
 * reading `window.localStorage` throws where site data is blocked.
 */
export function loadPartFraction(storage: () => PartStorage | undefined, opener: string, part: string): number {
  try {
    const raw = storage()?.getItem(keyOf(opener, part))
    if (typeof raw !== 'string') return PART_DEFAULT
    return clampPartFraction(Number(raw))
  } catch {
    return PART_DEFAULT
  }
}

/** Keep the share for next time; storage that throws keeps nothing (the share lives while the window is open). */
export function savePartFraction(storage: () => PartStorage | undefined, opener: string, part: string, fraction: number): void {
  try {
    storage()?.setItem(keyOf(opener, part), String(clampPartFraction(fraction)))
  } catch {
    // Not stored.
  }
}
