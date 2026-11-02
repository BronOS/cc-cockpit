/**
 * Pure geometry for dragging a tab along the strip (TabBar.tsx), kept out of the component so it is
 * testable without a DOM.
 */

/** How far (px) the pointer must travel before a press on a tab becomes a drag; less is a click. */
export const DRAG_THRESHOLD = 5

/**
 * Where a dragged tab lands: the number of OTHER tabs whose centre lies left of the pointer. That
 * is the tab's index once it has been taken out of the list and put back, which is exactly what
 * main's `tabs.reorder` takes as `toIndex` (it splices the tab out first, then in). Using the
 * centres means a tab only has to cross half of its neighbour to swap with it.
 *
 * `centres` are the x centres of the other tabs, left to right, without the dragged one.
 */
export function dropIndex(centres: readonly number[], pointerX: number): number {
  let index = 0
  for (const c of centres) if (pointerX > c) index++
  return index
}

/**
 * Which tab draws the drop marker, and on which edge: before the tab now at `toIndex` among the
 * others, or after the last one when the drop is at the end. Null when the drop leaves the order
 * as it is (`toIndex === from`), so a small wiggle shows nothing. `others` are the ids of the tabs
 * without the dragged one, left to right.
 */
export function dropMarker(
  others: readonly string[],
  from: number,
  toIndex: number
): { tabId: string; edge: 'before' | 'after' } | null {
  if (toIndex === from || others.length === 0) return null
  if (toIndex < others.length) return { tabId: others[toIndex]!, edge: 'before' }
  return { tabId: others[others.length - 1]!, edge: 'after' }
}
