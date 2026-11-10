// The selected tab per view and the project's `activeTab` (design-web.md §5.1 "Selected tab").
//
// Each view of a project window selects its own tab: the selection lives in that view's page, and a
// plugin's `ctx.sessions.focus` selects in the view the click came from (host-api.ts originOf), never
// on every screen. The project still has ONE active tab for plugins (SessionInfo.active) and Discuss:
// the selection of the view that acted last, where acting is selecting a tab (`tabs.selected`) or
// typing into one (`tabs.input` with the person's keys). A view that goes away hands the active
// tab back to the newest remaining view's selection, so a phone that closes does not leave the
// desktop's plugins pointed at the phone's tab.
//
// With web access off a window has one view, and this is exactly the old rule: the active tab is
// what the window last selected.
import { desktopViewId, type ViewId } from '../../shared/views'

export interface ViewSelectionsDeps {
  /** Whether `tabId` is a tab of `projectId` now (a stale or foreign id changes nothing). */
  isTab(projectId: string, tabId: string): boolean
  /** SessionRegistry.setActive: the project's active tab. */
  setActive(projectId: string, tabId: string | undefined): void
}

export class ViewSelections {
  /** viewId -> its project and the tab it shows. Map order: least to most recently acting. */
  private readonly byView = new Map<ViewId, { projectId: string; tabId: string }>()

  constructor(private readonly deps: ViewSelectionsDeps) {}

  /**
   * `viewId` selected `tabId` or typed into it: remembered as its selection, and the project's active
   * tab becomes it (this view acted last). The caller resolved `projectId` from the view itself.
   */
  acted(projectId: string, viewId: ViewId, tabId: string): void {
    if (!this.deps.isTab(projectId, tabId)) return
    this.byView.delete(viewId)
    this.byView.set(viewId, { projectId, tabId })
    this.deps.setActive(projectId, tabId)
  }

  /** The tab `viewId` last selected (or typed into), if any. */
  selectionOf(viewId: ViewId): string | undefined {
    return this.byView.get(viewId)?.tabId
  }

  /**
   * A view went away (a socket closed, a window closed). When another view of its project remains,
   * the newest one's selection becomes the active tab again; when it was not the last to act, that
   * is the active tab already and nothing changes.
   */
  viewGone(viewId: ViewId): void {
    const gone = this.byView.get(viewId)
    if (!gone) return
    this.byView.delete(viewId)
    let next: string | undefined
    for (const s of this.byView.values()) {
      if (s.projectId === gone.projectId && this.deps.isTab(s.projectId, s.tabId)) next = s.tabId
    }
    if (next !== undefined) this.deps.setActive(gone.projectId, next)
  }

  /** The project's window closed: every view's selection of it goes (its caller clears the active tab). */
  closeProject(projectId: string): void {
    for (const [viewId, s] of [...this.byView]) if (s.projectId === projectId) this.byView.delete(viewId)
  }
}

export interface FocusTabDeps {
  /** The window that shows `projectId` (WindowManager.windowIdOf). */
  windowOfProject(projectId: string): number | undefined
  /** The window a live view belongs to (ViewRegistry.windowOf). */
  windowOfView(viewId: ViewId): number | undefined
  /** Raise the project's desktop window (WindowManager.focusProject); false when it has none. */
  raise(projectId: string): boolean
  /** Tell one view to select a tab (ViewRegistry.toView with `tabs.select`). */
  select(viewId: ViewId, tabId: string): boolean
}

/**
 * ctx.sessions.focus's move, per view (design-web.md §5.1): with `view` (a remote view HostApi
 * checked is of the asking host's window) and the tab in that same window, only that view selects
 * it and the desktop window is not raised (the click was on another device). Otherwise the tab's
 * window is raised and its desktop view selects it; the window's remote views keep their own
 * selection. The selecting view reports `tabs.selected` back, which makes it the last to act.
 */
export function focusTabInView(deps: FocusTabDeps, projectId: string, tabId: string, view?: ViewId): boolean {
  const windowId = deps.windowOfProject(projectId)
  if (windowId === undefined) return false
  if (view !== undefined && deps.windowOfView(view) === windowId) return deps.select(view, tabId)
  if (!deps.raise(projectId)) return false
  deps.select(desktopViewId(windowId), tabId)
  return true
}
