// A view's terminal input (the router's `tabs.input`, design-web.md §5.2 "Input from any view").
// One path for every view: the desktop window's page and a browser's are both the person at the
// keyboard (a signed-in device is the person, design §4), so a browser's keys set SessionInfo.typed
// and answer a permission dialog exactly as the desktop's do, and the send gate applies unchanged:
// a plugin's `sessions.send` to the tab is refused from then on and its queued texts are dropped.
// Two views typing at once interleave, as two keyboards on one machine would.
//
// Kept apart from index.ts so a test drives the very wiring main uses (router -> TabManager ->
// SessionRegistry). The send gate's own paste never comes through here (it writes through
// TabManager.input), which is what lets `typed` mean "the person typed".
import type { ViewId } from '../../shared/views'

export interface ViewInputDeps {
  /** TabManager.viewInput: strips the view's query replies, writes the rest, notes who typed. */
  viewInput(projectId: string, tabId: string, data: string, viewId: ViewId): string
  /** SessionRegistry.userInput: `typed` (the takeover) and the answer-key step. */
  userInput(projectId: string, tabId: string, data: string): void
}

/** The router's `tabs.input` dependency. The registry sees what reached the pty, not the raw chunk. */
export function viewInputHandler(deps: ViewInputDeps): (projectId: string, tabId: string, data: string, viewId: ViewId) => void {
  return (projectId, tabId, data, viewId) => {
    const sent = deps.viewInput(projectId, tabId, data, viewId)
    deps.userInput(projectId, tabId, sent)
  }
}
