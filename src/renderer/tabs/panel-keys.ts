// The Terminal panel's part of the key rules (design-terminal-panel.md §6, §13.3, D10), DOM-free so
// unit tests run it: which area a focus moving lands in, and what Close Tab, the tab switch chords and
// New Shell do while the panel holds the keys. TabsPane registers these handlers on the stack only
// then; every other command, and these with the main area's keys, are the main area's as before.
import type { CommandContext, CommandHandler } from '../commands/keybindings'
import { SWITCH_NEXT, SWITCH_PREV } from './tab-switcher'

/** Which area holds a view's keys. */
export type KeysOwner = 'main' | 'panel'

/** The part of an Element this reads (`closest`), so tests pass a fake. */
export interface FocusTarget {
  closest(selector: string): unknown
}

/**
 * The area a focus moving to `target` gives the keys to: the panel's body (its terminal, strip and
 * menus, all inside `[data-terminal-panel]`), or the main area (`.zones-centre`: its strip and panes);
 * anything else (a popup, the palette, a dialog, nothing) changes nothing (undefined).
 */
export function ownerOfFocus(target: FocusTarget | null): KeysOwner | undefined {
  if (!target) return undefined
  if (target.closest('[data-terminal-panel]')) return 'panel'
  if (target.closest('.zones-centre')) return 'main'
  return undefined
}

/** The tab a plain step in the panel's strip goes to (wrapping), or undefined for an empty panel. */
export function panelStep(ids: readonly string[], current: string | null, dir: 1 | -1): string | undefined {
  if (ids.length === 0) return undefined
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return dir === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(at + dir + ids.length) % ids.length]
}

export interface PanelKeysContext {
  /** The panel's tabs in strip order and its selection. */
  panel(): { ids: readonly string[]; activeId: string | null }
  /** The main area's keys are off (D3): a frame's chord acts on nothing then. */
  mainKeysOff(): boolean
  /** The person's close (asks about a running process). */
  close(tabId: string): void
  /** The person picked a panel tab (selected, taken, focused). */
  pick(tabId: string): void
  /** A new shell in the panel. */
  newShell(): void
}

/**
 * The overrides while the panel holds the keys: Close Tab closes the panel's selected tab (a chord a
 * page tab's frame forwarded names its own tab: that one, by the main area's rule), the switch chords
 * step the panel's strip (no switcher), New Shell opens one in the panel.
 */
export function panelCommandHandlers(ctx: PanelKeysContext): Record<string, CommandHandler> {
  const step =
    (dir: 1 | -1) =>
    (): void => {
      const { ids, activeId } = ctx.panel()
      const next = panelStep(ids, activeId, dir)
      if (next !== undefined && next !== activeId) ctx.pick(next)
    }
  return {
    'tab.close': (run?: CommandContext) => {
      if (run?.tabId !== undefined) {
        if (!ctx.mainKeysOff()) ctx.close(run.tabId)
        return
      }
      const { activeId } = ctx.panel()
      if (activeId !== null) ctx.close(activeId)
    },
    [SWITCH_NEXT]: step(1),
    [SWITCH_PREV]: step(-1),
    'tab.newShell': () => ctx.newShell()
  }
}
