// The Ctrl+Tab tab switcher's rules, DOM-free so unit tests load them (TabsPane holds the state,
// TabSwitcher.tsx draws it).
//
// The switcher walks the tabs in most-recently-used order, as a browser or an IDE does: a quick
// Ctrl+Tab goes back to the tab you were in before, and holding Ctrl while pressing Tab again
// walks further back. Releasing the held modifier picks the highlighted tab. The overlay listing
// the tabs only shows once the chord is held a moment (SHOW_DELAY_MS), so a quick flip between
// two tabs never flashes it.
import { splitChord } from '../../shared/keys'
import type { TabInfo } from '../../shared/ipc'

/** How long the chord must be held before the overlay shows; a release sooner just switches. */
export const SHOW_DELAY_MS = 150

/** The command ids of the switcher (CORE_COMMANDS in command-registry.ts holds their chords). */
export const SWITCH_NEXT = 'tab.switchNext'
export const SWITCH_PREV = 'tab.switchPrev'

/** The recency list after `id` became the active tab: `id` first, each id once. */
export function touchRecent(recent: readonly string[], id: string): string[] {
  return [id, ...recent.filter((r) => r !== id)]
}

/**
 * The tabs in most-recently-used order: those in `recent` that still exist, then any tab never
 * active (announced in the background, restored and not visited yet) in strip order.
 */
export function recentOrder(tabs: readonly TabInfo[], recent: readonly string[]): TabInfo[] {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const out: TabInfo[] = []
  for (const id of recent) {
    const tab = byId.get(id)
    if (tab) {
      out.push(tab)
      byId.delete(id)
    }
  }
  for (const tab of tabs) if (byId.has(tab.id)) out.push(tab)
  return out
}

/** One step forward (+1) or back (-1) through `count` entries, wrapping at both ends. */
export function step(index: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0
  return (((index + dir) % count) + count) % count
}

/**
 * The modifiers of a chord that the user holds while switching: its Ctrl, Alt and Meta. Shift is
 * left out: Ctrl+Shift+Tab walks back, and letting go of Shift to walk forward again must not pick
 * a tab. Empty for a chord with none of them (a bare F-key the user bound): the switcher then
 * stays open until Enter, Esc or a click, since there is no release to wait for.
 */
export function heldModifiers(chord: string | undefined): string[] {
  const mods = chord ? (splitChord(chord)?.mods ?? []) : []
  return mods.filter((m) => m === 'ctrl' || m === 'alt' || m === 'meta')
}

/** The modifier state of a key or pointer event. */
export interface ModifierState {
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
}

/** Whether every held modifier is up in `e` (a keyup reports the state after the release). */
export function released(mods: readonly string[], e: ModifierState): boolean {
  if (mods.length === 0) return false
  return mods.every((m) => (m === 'ctrl' ? !e.ctrlKey : m === 'alt' ? !e.altKey : !e.metaKey))
}

/** An open switcher. */
export interface SwitcherState {
  /** Tab ids in the order the overlay lists them (recentOrder at open). */
  order: string[]
  /** The highlighted entry. */
  index: number
  /** The overlay is drawn (the chord was held past SHOW_DELAY_MS, or it opened sticky). */
  shown: boolean
  /**
   * A release no longer picks: the pointer moved over the list (the user reaches for a row with
   * the mouse), the chord has no modifier to hold, or it came from a web panel's page, whose
   * modifier may be up before the page hears of it. Enter, Esc or a click ends it then.
   */
  sticky: boolean
  /** heldModifiers of the chord that opened it. */
  mods: string[]
}

/**
 * The switcher opened by a switch command: the recent-order list with the entry one step from the
 * current tab highlighted (the previous tab forward, the least recent one backward). Null with
 * fewer than two tabs: there is nothing to switch to.
 */
export function openSwitcher(
  tabs: readonly TabInfo[],
  recent: readonly string[],
  dir: 1 | -1,
  mods: string[],
  sticky: boolean
): SwitcherState | null {
  const order = recentOrder(tabs, recent).map((t) => t.id)
  if (order.length < 2) return null
  const stuck = sticky || mods.length === 0
  return { order, index: step(0, order.length, dir), shown: stuck, sticky: stuck, mods }
}
