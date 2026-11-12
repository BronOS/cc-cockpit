// The browser's dropdown for a streamed page's `<select>` (design-web-browser.md §4.4, plan
// 20261111-streamed-webviews.md Task 9): where it goes over the canvas (the select's page rectangle
// through the frame's scale and the letterbox, below the select or flipped above it near the
// bottom), and which option the keys move to (arrows, Home/End, PageUp/PageDown, type-ahead), with
// disabled options skipped. DOM-free, unit tested; the component is webview-select-menu.tsx.

import type { WebviewSelectOption, WebviewSelectRect } from '../../shared/ipc'
import { framePageSize, type Letterbox } from './webview-stream'

/** A rectangle in the canvas area, CSS px from its top left. */
export interface AreaRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The select's page rectangle (viewport CSS px of the page) in the canvas area: page px → frame px
 * (the header's scale) → area px (the letterbox's scale and offset), i.e. page px times the drawn
 * width over the page width. Undefined with no frame drawn.
 */
export function pageRectToArea(box: Letterbox, frame: { width: number; height: number; scale: number }, rect: WebviewSelectRect): AreaRect | undefined {
  const page = framePageSize(frame)
  if (!(box.width > 0 && page.width > 0)) return undefined
  const k = box.width / page.width
  return { x: box.x + rect.x * k, y: box.y + rect.y * k, width: rect.width * k, height: rect.height * k }
}

/** Where the menu goes in the area: `top` (below the select) or `bottom` (flipped above it). */
export interface MenuPlace {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

/** The menu's least width (a narrow select still gets readable rows), CSS px. */
export const MENU_MIN_WIDTH = 140
/** Gap kept to the area's edges, CSS px. */
const EDGE = 4

/**
 * The menu for a select at `anchor` in an area of `area` size wanting `wanted` px of height: below
 * the select when that fits, else on the side with more room (above, as a native select flips near
 * the bottom); as wide as the select, at least MENU_MIN_WIDTH, never past the area's sides. A
 * select scrolled partly out of the area is clamped into it first.
 */
export function placeMenu(anchor: AreaRect, area: { width: number; height: number }, wanted: number): MenuPlace {
  const width = Math.max(1, Math.min(area.width - 2 * EDGE, Math.max(MENU_MIN_WIDTH, anchor.width)))
  const left = Math.max(EDGE, Math.min(area.width - EDGE - width, anchor.x))
  const top = Math.max(0, Math.min(area.height, anchor.y))
  const bottom = Math.max(top, Math.min(area.height, anchor.y + anchor.height))
  const below = area.height - bottom - EDGE
  const above = top - EDGE
  if (below >= wanted || below >= above) return { left, width, top: bottom, maxHeight: Math.max(0, below) }
  return { left, width, bottom: area.height - top, maxHeight: Math.max(0, above) }
}

/** The position (in `options`) a popup opens on: the selected option when it is listed, else the first enabled. */
export function initialActive(options: readonly WebviewSelectOption[], selected: number): number {
  const at = options.findIndex((o) => o.index === selected)
  if (at >= 0 && options[at]?.disabled !== true) return at
  return firstEnabled(options, 0, 1)
}

/** The first enabled position from `from` going `step` (±1), or -1. */
function firstEnabled(options: readonly WebviewSelectOption[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < options.length; i += step) if (options[i]?.disabled === false) return i
  return -1
}

/**
 * The position a navigation key moves to from `active`: Down/Up the next enabled one that way
 * (staying put at the end), PageDown/PageUp `page` rows on (or the last enabled one that way),
 * Home/End the first/last enabled one. Undefined for any other key.
 */
export function moveActive(options: readonly WebviewSelectOption[], active: number, key: string, page = 10): number | undefined {
  const keep = (next: number): number => (next >= 0 ? next : active)
  switch (key) {
    case 'ArrowDown':
      return keep(firstEnabled(options, active + 1, 1))
    case 'ArrowUp':
      return active < 0 ? keep(firstEnabled(options, options.length - 1, -1)) : keep(firstEnabled(options, active - 1, -1))
    case 'Home':
      return keep(firstEnabled(options, 0, 1))
    case 'End':
      return keep(firstEnabled(options, options.length - 1, -1))
    case 'PageDown': {
      const to = Math.min(options.length - 1, Math.max(0, active) + page)
      const back = firstEnabled(options, to, -1)
      return keep(back > active ? back : firstEnabled(options, to, 1))
    }
    case 'PageUp': {
      const to = Math.max(0, active - page)
      const on = firstEnabled(options, to, 1)
      return keep(on >= 0 && on < active ? on : firstEnabled(options, to, -1))
    }
    default:
      return undefined
  }
}

/** How long typed letters keep adding to one type-ahead search, ms (as a native select's). */
export const TYPE_AHEAD_MS = 700

/**
 * Type-ahead: the enabled option whose label starts with `typed` (case-insensitive), searched from
 * the one after `active` and wrapping, so typing the same letter again cycles through the options
 * that start with it (a run of one letter searches for that letter). -1 when none matches.
 */
export function typeAhead(options: readonly WebviewSelectOption[], active: number, typed: string): number {
  if (typed === '' || options.length === 0) return -1
  const lower = typed.toLocaleLowerCase()
  const chars = [...lower]
  const one = chars.every((c) => c === chars[0]) ? (chars[0] as string) : undefined
  // A longer search keeps the current option if it still matches; a cycling letter moves on.
  const start = one !== undefined ? active + 1 : Math.max(0, active)
  const needle = one ?? lower
  for (let n = 0; n < options.length; n++) {
    const i = (((start + n) % options.length) + options.length) % options.length
    const o = options[i]
    if (o && !o.disabled && o.label.toLocaleLowerCase().startsWith(needle)) return i
  }
  return -1
}

/** Consecutive options of the same group (none: undefined), for the menu's headings. */
export function groupRuns(options: readonly WebviewSelectOption[]): Array<{ group: string | undefined; from: number; items: WebviewSelectOption[] }> {
  const runs: Array<{ group: string | undefined; from: number; items: WebviewSelectOption[] }> = []
  options.forEach((o, i) => {
    const last = runs[runs.length - 1]
    if (last && last.group === o.group) last.items.push(o)
    else runs.push({ group: o.group, from: i, items: [o] })
  })
  return runs
}
