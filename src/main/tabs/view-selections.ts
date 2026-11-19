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
//
// A guest's view (design-guests §7) keeps its own selection too (presence shows where each person is), but
// never acts for the project: its select or keys never set the active tab, it is never `lastActing` (server
// mode's overlay holder), and its going away hands nothing back. Otherwise Discuss and every plugin would
// retarget to a guest's click.
import { desktopViewId, isRemoteViewId, type ViewId, type Who } from '../../shared/views'

export interface ViewSelectionsDeps {
  /** Whether `tabId` is a tab of `projectId` now (a stale or foreign id changes nothing). */
  isTab(projectId: string, tabId: string): boolean
  /** SessionRegistry.setActive: the project's active tab. */
  setActive(projectId: string, tabId: string | undefined): void
  /** Clock for the exit focus's "typed just now" (EXIT_FOCUS_TYPED_MS); tests inject one. Default Date.now. */
  now?: () => number
}

/**
 * How recently the person's own keys must have gone into a pane, in the same view, for its exit to
 * count as their act (`exitFocus`): Ctrl+D ends a shell within milliseconds, `exit` + Enter within a
 * few hundred; a command that ends seconds after the last key did so on its own.
 */
export const EXIT_FOCUS_TYPED_MS = 1500

/** Tabs remembered per view for the exit focus's most recently used order (more than a group's 8 panes). */
const RECENT_CAP = 32

export class ViewSelections {
  /** viewId -> its project and the tab it shows. Map order: least to most recently acting. `guest`: a guest's view. */
  private readonly byView = new Map<ViewId, { projectId: string; tabId: string; guest?: true }>()
  /** viewId -> the tabs it selected or typed into, most recent first (capped; stale ids are harmless). */
  private readonly recent = new Map<ViewId, string[]>()
  /** viewId -> the tab the person last typed into there, and when (main's clock). */
  private readonly typedAt = new Map<ViewId, { tabId: string; at: number }>()
  private readonly now: () => number

  constructor(private readonly deps: ViewSelectionsDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * `viewId` selected `tabId` or typed into it: remembered as its selection, and the project's active
   * tab becomes it (this view acted last). The caller resolved `projectId` from the view itself.
   */
  acted(projectId: string, viewId: ViewId, tabId: string): void {
    if (!this.deps.isTab(projectId, tabId)) return
    this.byView.delete(viewId)
    this.byView.set(viewId, { projectId, tabId })
    const recent = this.recent.get(viewId) ?? []
    if (recent[0] !== tabId) this.recent.set(viewId, [tabId, ...recent.filter((t) => t !== tabId)].slice(0, RECENT_CAP))
    this.deps.setActive(projectId, tabId)
  }

  /**
   * A guest's view shows `tabId` (design-guests §7): remembered as that view's selection (presence, the exit
   * focus), never the project's active tab. The router checked the tab is one the guest sees.
   */
  guestActed(projectId: string, viewId: ViewId, tabId: string): void {
    if (!this.deps.isTab(projectId, tabId)) return
    this.byView.delete(viewId)
    this.byView.set(viewId, { projectId, tabId, guest: true })
    const recent = this.recent.get(viewId) ?? []
    if (recent[0] !== tabId) this.recent.set(viewId, [tabId, ...recent.filter((t) => t !== tabId)].slice(0, RECENT_CAP))
  }

  /** A write guest typed into `tabId` (view-input.ts guestViewInputHandler): as `guestActed`, timed for the exit focus. */
  guestTyped(projectId: string, viewId: ViewId, tabId: string): void {
    if (!this.deps.isTab(projectId, tabId)) return
    this.guestActed(projectId, viewId, tabId)
    this.typedAt.set(viewId, { tabId, at: this.now() })
  }

  /**
   * The person typed into `tabId` in `viewId` (view-input.ts, only for input that counts as theirs:
   * isPersonInput, the same signal as SessionInfo.typed). Acting, as `acted`, and remembered with
   * the time for the exit focus.
   */
  typed(projectId: string, viewId: ViewId, tabId: string): void {
    if (!this.deps.isTab(projectId, tabId)) return
    this.acted(projectId, viewId, tabId)
    this.typedAt.set(viewId, { tabId, at: this.now() })
  }

  /**
   * A pane's process exited and closed it (TabManagerOptions.exitClosed), leaving `panes` (what is
   * left of its group in reading order, or the one tab a dissolve left plain; TabGroups.departedPanes).
   * The exception to D3 (design.md §3 "Split groups"): a view that had the closed pane selected AND
   * sent it the person's own keys within EXIT_FOCUS_TYPED_MS ended it itself (Ctrl+D, `exit`), so its
   * focus goes to its most recently used remaining pane, else the group's first. Every other view,
   * and every other close, is left keys-off as before. Decided from main's own record of who typed
   * where and when, never from anything a page says. Returns the selects to send, one per view.
   */
  exitFocus(
    projectId: string,
    closedTabId: string,
    panes: readonly string[],
    guestSees?: (viewId: ViewId, tabId: string) => boolean
  ): Array<{ viewId: ViewId; tabId: string }> {
    const out: Array<{ viewId: ViewId; tabId: string }> = []
    if (panes.length === 0) return out
    const now = this.now()
    for (const [viewId, sel] of this.byView) {
      if (sel.projectId !== projectId || sel.tabId !== closedTabId) continue
      const typed = this.typedAt.get(viewId)
      if (typed?.tabId !== closedTabId || now - typed.at > EXIT_FOCUS_TYPED_MS || now < typed.at) continue
      // A guest's view is handed only a pane it sees (design-guests §7): never a hidden member's id. With no
      // way to ask (`guestSees` absent) it is left keys-off, as every other view of the close is.
      const own = sel.guest === true ? (guestSees ? panes.filter((t) => guestSees(viewId, t)) : []) : panes
      if (own.length === 0) continue
      const tabId = (this.recent.get(viewId) ?? []).find((t) => own.includes(t)) ?? own[0]!
      out.push({ viewId, tabId })
    }
    return out
  }

  /** The tab `viewId` last selected (or typed into), if any. */
  selectionOf(viewId: ViewId): string | undefined {
    return this.byView.get(viewId)?.tabId
  }

  /**
   * Of `candidates`, the view that acted last (selected or typed into a tab), or undefined when none
   * of them has acted. Server mode's html overlay holder (overlay-manager.ts browserViews).
   */
  lastActing(candidates: readonly ViewId[]): ViewId | undefined {
    let last: ViewId | undefined
    // A guest's view never holds for the project (design-guests §7): not the server's overlay holder.
    for (const [viewId, sel] of this.byView) if (sel.guest !== true && candidates.includes(viewId)) last = viewId
    return last
  }

  /**
   * A view went away (a socket closed, a window closed). When another view of its project remains,
   * the newest one's selection becomes the active tab again; when it was not the last to act, that
   * is the active tab already and nothing changes.
   */
  viewGone(viewId: ViewId): void {
    this.recent.delete(viewId)
    this.typedAt.delete(viewId)
    const gone = this.byView.get(viewId)
    if (!gone) return
    this.byView.delete(viewId)
    // A guest's view never set the active tab, so its going hands nothing back.
    if (gone.guest === true) return
    let next: string | undefined
    for (const s of this.byView.values()) {
      if (s.guest !== true && s.projectId === gone.projectId && this.deps.isTab(s.projectId, s.tabId)) next = s.tabId
    }
    if (next !== undefined) this.deps.setActive(gone.projectId, next)
  }

  /** The project's window closed: every view's selection of it goes (its caller clears the active tab). */
  closeProject(projectId: string): void {
    for (const [viewId, s] of [...this.byView]) {
      if (s.projectId !== projectId) continue
      this.byView.delete(viewId)
      this.recent.delete(viewId)
      this.typedAt.delete(viewId)
    }
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
  /** Main runs as a server (main's own flag, never a payload): project windows are hidden pages. */
  server: boolean
  /** Tell one browser view to go to another project's page and select a tab there (`project.goto`). */
  goto(viewId: ViewId, projectId: string, tabId: string): boolean
  /** Who a live view is bound to (ViewRegistry.whoOf); undefined for a view main no longer has. */
  whoOf(viewId: ViewId): Who | undefined
}

/**
 * ctx.sessions.focus's move, per view (design-web.md §5.1): with `view` (a remote view HostApi
 * checked is of the asking host's window) and the tab in that same window, only that view selects
 * it and the desktop window is not raised (the click was on another device). Otherwise the tab's
 * window is raised and its desktop view selects it; the window's remote views keep their own
 * selection. The selecting view reports `tabs.selected` back, which makes it the last to act.
 *
 * Server mode: a project window is a hidden page that is never shown, so raising it moves nothing
 * on any screen and a browser's click on another project's tab (the cockpit.sessions strip lists
 * every open project) would do nothing. There the acting browser view itself is sent to the other
 * project's page (`project.goto`, which the web client turns into `?project=<id>&tab=<id>`). Only a
 * remote view main still has (a closed one falls through to the raise, which selects in the hidden
 * page, as before); the desktop page and the hidden page never get the event.
 */
export function focusTabInView(deps: FocusTabDeps, projectId: string, tabId: string, view?: ViewId): boolean {
  const windowId = deps.windowOfProject(projectId)
  if (windowId === undefined) return false
  if (view !== undefined && deps.windowOfView(view) === windowId) return deps.select(view, tabId)
  // A guest's view (or a remote view main no longer has, which might have been one) moves nothing beyond itself
  // (design-guests §7, 03f): no raise, no desktop selection, no goto to another project.
  if (view !== undefined && isRemoteViewId(view) && deps.whoOf(view) !== 'owner') return false
  if (deps.server && view !== undefined && isRemoteViewId(view) && deps.windowOfView(view) !== undefined) {
    return deps.goto(view, projectId, tabId)
  }
  if (!deps.raise(projectId)) return false
  deps.select(desktopViewId(windowId), tabId)
  return true
}
