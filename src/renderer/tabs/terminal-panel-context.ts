// What the Terminal panel's body (TerminalPanelBody.tsx) gets from TabsPane (design-terminal-panel.md
// §4, §13.10): TabsPane owns the one tab list, the one SessionRegistry and every tab action, and the
// panel is drawn inside Zones (a child of TabsPane), so it reaches them through this context rather
// than through the zone props. Every function is stable for the page's life (TabsPane reads its
// current state through refs), so the body's effects never run again for a new callback.
import { createContext } from 'react'
import type { TabCommandMenu, TabInfo } from '../../shared/ipc'
import type { TabCommandLevel } from '../../shared/types'
import type { PanelFocusAsks } from './panel-focus'
import type { SessionRegistry } from './terminal-session'

export interface TerminalPanelApi {
  /** The panel's tabs (docked), in the one order. */
  tabs: TabInfo[]
  /** The panel's selected tab in this view. */
  activeId: string | null
  sessions: SessionRegistry
  /** The [+] menu's user entries, as last read (null until first read). */
  commands: TabCommandMenu | null
  /** This view may write (open, close, restart, move tabs): only the owner ever has a panel. */
  canWrite: boolean
  /** The focus asks (panel-focus.ts): the body takes one when `focusSeq` or its selection changes. */
  focusAsks: PanelFocusAsks
  /** Bumped by every ask, so the body's effect runs for it. */
  focusSeq: number
  /** Label of a panel tab, as the main strip names it. */
  labelOf(tab: TabInfo): string
  /** The person picked a tab in the panel's strip. */
  select(tabId: string): void
  createShell(): void
  createCommand(level: TabCommandLevel, entryId: string): void
  /** The [+] menu is opening: read the user entries again. */
  loadCommands(): void
  /** The person's close (×, the menu, the exited banner): asks about a running process as every close does. */
  close(tabId: string): void
  restart(tabId: string): void
  /** "Move to tab area". */
  moveToMain(tabId: string): void
  /** A drag in the strip ended: `toIndex` among the strip's other tabs. */
  reorder(tabId: string, toIndex: number): void
  /** The tab menu's Move left / right. */
  move(tabId: string, delta: -1 | 1): void
  /** The body is on screen (mounted) or not: the panel is shown, hidden, collapsed or moved. */
  shown(on: boolean): void
  /** A menu of the panel took the keyboard and went: give it back (TabsPane's give-back rule). */
  menuClosed(): void
}

export const TerminalPanelContext = createContext<TerminalPanelApi | null>(null)
