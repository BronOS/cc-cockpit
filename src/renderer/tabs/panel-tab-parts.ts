// What a Terminal panel strip tab draws (TerminalPanelBody.tsx), DOM-free so unit tests run it. A side
// zone is narrow (QA Q1: at ~320 px the strip showed "S.." and an exited command only "(exited)"), so
// the state is never visible text competing with the name: it is a shape on the kind icon (a filled
// square for exited, a hollow ring for not started, never a colour alone) and the same words, hidden
// visually, keep the tab's accessible name as the main strip's (`<label> (exited)`, SELECTORS.md).
import type { TabInfo } from '../../shared/ipc'

export type PanelTabState = 'exited' | 'notStarted' | null

export interface PanelTabParts {
  /** The kind icon: a custom command's, or a shell's. */
  icon: 'command' | 'shell'
  /** The mark on the icon (its `data-state`). */
  state: PanelTabState
  /** The visible name (truncated by the CSS, never by the text). */
  name: string
  /** The hidden words after the name: they complete the accessible name. Empty for a running tab. */
  stateText: string
  /** The tooltip: the whole name and the state in words. */
  title: string
}

export function panelTabParts(tab: Pick<TabInfo, 'kind' | 'exit' | 'notStarted'>, label: string): PanelTabParts {
  const state: PanelTabState = tab.notStarted ? 'notStarted' : tab.exit ? 'exited' : null
  const stateText = state === 'exited' ? ' (exited)' : state === 'notStarted' ? ' (not started)' : ''
  return { icon: tab.kind === 'command' ? 'command' : 'shell', state, name: label, stateText, title: label + stateText }
}
