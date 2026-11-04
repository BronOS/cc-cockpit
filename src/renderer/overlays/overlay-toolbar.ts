// The overlay toolbar's logic (design-next §3.2), DOM-free so unit tests load it: which buttons
// show in the row, in what order, which fold into the "…" menu, and the loader's "Still loading…"
// clock (§3.4). OverlayToolbar.tsx draws what this decides.
import type { OverlayButtonInfo, OverlayTypeButtonInfo } from '../../shared/ipc'

/** More buttons than this (Discuss and ✕ not counted) fold into a "…" menu. */
export const MAX_TOOLBAR_BUTTONS = 6
/** The loader adds "Still loading…" after this long (✕ works all along). */
export const STILL_LOADING_MS = 10_000

/** One button in the row or the menu, with where a click goes. */
export type ToolbarEntry =
  | { source: 'opener'; button: OverlayButtonInfo }
  | { source: 'type'; pluginId: string; button: OverlayTypeButtonInfo }

export interface ToolbarLayout {
  /** In the row, in order: the opener's first, then the type buttons. */
  row: ToolbarEntry[]
  /** How many of `row` are the opener's: the divider goes after them when both groups are in the row. */
  openerCount: number
  /** In the "…" menu, in the same order; empty: no menu. */
  menu: ToolbarEntry[]
}

/**
 * The type buttons grouped by plugin in plugin-title order (case-insensitive, then the plugin id
 * so two plugins of the same title keep a fixed order); each plugin's own buttons keep its order.
 */
export function orderTypeButtons(buttons: readonly OverlayTypeButtonInfo[]): OverlayTypeButtonInfo[] {
  return buttons
    .map((button, index) => ({ button, index }))
    .sort((a, b) => {
      if (a.button.pluginId !== b.button.pluginId) {
        const byTitle = a.button.pluginTitle.localeCompare(b.button.pluginTitle, undefined, { sensitivity: 'base' })
        if (byTitle !== 0) return byTitle
        return a.button.pluginId < b.button.pluginId ? -1 : 1
      }
      return a.index - b.index
    })
    .map((e) => e.button)
}

/**
 * The row and the menu. Up to 6 buttons all show; with more, the first 5 show and the rest go into
 * "…", which takes the 6th place, so the row never holds more than 6 controls besides Discuss and ✕.
 */
export function toolbarLayout(
  opener: readonly OverlayButtonInfo[] | undefined,
  typed: readonly OverlayTypeButtonInfo[] | undefined
): ToolbarLayout {
  const entries: ToolbarEntry[] = [
    ...(opener ?? []).map((button): ToolbarEntry => ({ source: 'opener', button })),
    ...orderTypeButtons(typed ?? []).map((button): ToolbarEntry => ({ source: 'type', pluginId: button.pluginId, button }))
  ]
  const openers = opener?.length ?? 0
  if (entries.length <= MAX_TOOLBAR_BUTTONS) return { row: entries, openerCount: openers, menu: [] }
  const shown = MAX_TOOLBAR_BUTTONS - 1
  return { row: entries.slice(0, shown), openerCount: Math.min(openers, shown), menu: entries.slice(shown) }
}

/** A button that takes no click: busy (it shows a spinner) or disabled. */
export function inert(button: OverlayButtonInfo): boolean {
  return button.busy === true || button.disabled === true
}

/**
 * Call `onStill` once the loader has been up for STILL_LOADING_MS; the returned function cancels it
 * (the loader went, or the overlay closed).
 */
export function stillLoadingTimer(onStill: () => void, ms = STILL_LOADING_MS): () => void {
  const timer = setTimeout(onStill, ms)
  return () => clearTimeout(timer)
}
