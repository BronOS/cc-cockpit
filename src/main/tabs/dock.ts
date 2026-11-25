// The person's move of a tab between the main tab area and the Terminal panel (`tabs.dock`,
// docs/design-terminal-panel.md §2, §3, §13). One step for everything a move touches, in this order:
//   1. the tab is checked (a shell or command tab of the sender's project; TabManager.setDock throws otherwise);
//   2. docking takes it out of its split group first (a docked tab is never a pane; a group of two dissolves);
//   3. the field is set and saved (setDock; docking clears the flag, D4);
//   4. the selections follow (a docked tab is no view's main selection and never the active tab, §13.5);
//   5. every view of the window hears `tabs.docked` (guests drop it: GUEST_EVENT);
//   6. guests that saw the tab lose it by a narrowing reconnect, guests that see it now gain it by a widening one
//      (D-30's path, §13.2), never a made-up `tabs.removed` / `tabs.added`;
//   7. the person's own "Move to tab area" selects the tab in the view that asked (§13.11).
// Pure wiring with its deps injected (index.ts), so a unit test drives the exact order.
import type { TabKind } from '../../shared/types'
import type { ViewId } from '../../shared/views'

export interface DockDeps {
  /** TabManager.kindOf: undefined for an unknown or another project's tab. */
  kindOf(projectId: string, tabId: string): TabKind | undefined
  /** TabManager.dockOf. */
  dockOf(projectId: string, tabId: string): 'panel' | undefined
  /** TabGroups.remove: out of its group (a refusal for a plain tab is fine and ignored). */
  ungroup(projectId: string, tabId: string): void
  /** TabManager.setDock. */
  setDock(projectId: string, tabId: string, dock: 'panel' | undefined): boolean
  /** ViewSelections.docked / undocked. */
  docked(projectId: string, tabId: string): void
  undocked(projectId: string, tabId: string): void
  /** `tabs.docked` to every view of the project's window (ViewRegistry.toProject). */
  announce(projectId: string, payload: { tabId: string; dock: 'panel' | 'main' }): void
  /** GuestStore.guestsSeeing / tabDockChanged; absent (no guest store): nothing to tell. */
  guestsSeeing?(projectId: string, tabId: string): ReadonlySet<string>
  guestsChanged?(projectId: string, tabId: string, sawBefore: ReadonlySet<string>): void
  /** `tabs.select` to one view (ViewRegistry.toView): the moved-back tab in the view that asked. */
  selectIn(viewId: ViewId, tabId: string): void
  log?(message: string): void
}

/** Move `tabId` of `projectId` (`'panel'` in, `'main'` out) for the view `viewId` main bound. Throws for a bad tab. */
export function dockTab(deps: DockDeps, projectId: string, tabId: string, dock: 'panel' | 'main', viewId: ViewId): void {
  const kind = deps.kindOf(projectId, tabId)
  if (kind === undefined) throw new Error('unknown tab')
  if (kind !== 'shell' && kind !== 'command') throw new Error('only a shell or command tab moves to the Terminal panel')
  const target = dock === 'panel' ? 'panel' : undefined
  if (deps.dockOf(projectId, tabId) === target) return
  // Read before the move: after it a docked tab is invisible to every guest, so who lost it could not be told.
  const sawBefore = deps.guestsSeeing?.(projectId, tabId) ?? new Set<string>()
  if (target === 'panel') deps.ungroup(projectId, tabId)
  if (!deps.setDock(projectId, tabId, target)) return
  if (target === 'panel') deps.docked(projectId, tabId)
  else deps.undocked(projectId, tabId)
  deps.announce(projectId, { tabId, dock })
  try {
    deps.guestsChanged?.(projectId, tabId, sawBefore)
  } catch (err) {
    // The move stands; a guest store that fails is logged (its own paths fail closed on the next call).
    deps.log?.(`terminal panel: telling the guests of a dock failed: ${String(err)}`)
  }
  if (target === undefined) deps.selectIn(viewId, tabId)
}
