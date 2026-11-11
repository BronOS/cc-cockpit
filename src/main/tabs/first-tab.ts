// The first Claude tab of a project that opens empty (design §3 Tabs, "First tab"). A project
// window that opens with nothing to restore would otherwise show "No tabs yet"; with the app
// setting `claudeTabOnOpen` on (the default) main starts one Claude tab in the project folder,
// as the user's "New tab > Claude" would. No Electron import: index.ts wires it, vitest drives it.
//
// When it is decided, and why there:
//  - Eligibility is fixed when the window opens (`arm`), not read from the live tab count later.
//    A restore plan whose tabs all failed to spawn leaves zero live tabs, yet those tabs came back
//    in the user's eyes (their records ride along in TabRestorer.unrestored): starting a fresh
//    Claude there would be a tab nobody asked for. So a window opened with a queued restore plan,
//    or with saved tabs in its record, is never armed.
//  - The tab is started when the window's renderer first attaches (`settle`), after the restore
//    run resolved, for the reason restore.ts gives: output printed before the page subscribed to
//    `tabs.data` is lost. The attach reply then carries the tab, so no `tabs.added` is needed.
//  - The live count is read at that moment, synchronously before the spawn. A plugin host starts
//    in parallel with the window and its `ctx.tabs.open` also waits for the login env: whichever
//    of the two runs second sees the other's tab. A plugin tab that is already there wins.
//  - The arm is spent by the first settle whatever it decides, so it fires at most once per
//    window open: a page reload, or the user closing the last tab (by hand or by a clean exit),
//    never brings a tab back.
import { errorText } from '../../shared/error-text'
import { warnLog } from '../warn-log'

export interface FirstTabOptions {
  /** The app setting, read at decision time (claudeTabOnOpenOf applied). */
  enabled(): boolean
  /** The project's live tabs right now (TabManager.list). */
  tabCount(projectId: string): number
  /** The project's current window id, undefined when it has none (WindowManager.windowIdOf). */
  windowIdOf(projectId: string): number | undefined
  /** Start a Claude tab in the project folder (TabManager.create). May throw: logged, not raised. */
  open(projectId: string): void
  log?: (message: string) => void
}

export class FirstTab {
  // projectId -> the window that was opened and has not attached yet.
  private readonly armed = new Map<string, number>()
  // The decision in flight per project: a second attach (a reload while the login env is awaited)
  // waits for it, so its tab list already has the new tab.
  private readonly running = new Map<string, Promise<void>>()
  private readonly log: (message: string) => void

  constructor(private readonly options: FirstTabOptions) {
    this.log = options.log ?? warnLog
  }

  /**
   * A project window was created. `restoring`: it has tabs to bring back (a queued restore plan,
   * or saved tabs in its record); such a window is not armed, even if none of them starts.
   */
  arm(projectId: string, windowId: number, restoring: boolean): void {
    if (restoring) this.armed.delete(projectId)
    else this.armed.set(projectId, windowId)
  }

  /** The project's window closed before it attached. */
  disarm(projectId: string): void {
    this.armed.delete(projectId)
  }

  /**
   * Window `windowId`'s renderer attached and its restore (if any) has resolved: open the Claude
   * tab if this window is armed, the setting is on and the project still has no tab. Only the
   * armed window spends the arm: an attach of a window that closed meanwhile (its restore was
   * still awaited) must not take the arm of the window reopened after it, and spawn before that
   * window's page listens. `ready` is the login env: a tab spawned before it would get the GUI
   * app's bare PATH and not find `claude`. Never rejects: a failed spawn is logged and the window
   * just stays empty.
   */
  settle(projectId: string, windowId: number, ready: Promise<unknown>): Promise<void> {
    if (this.armed.get(projectId) !== windowId) return this.running.get(projectId) ?? Promise.resolve()
    this.armed.delete(projectId)
    const run = ready
      .then(() => {
        // Closed (and maybe reopened as another window, which has its own arm) while waiting: a
        // tab spawned now would be a PTY no window shows.
        if (this.options.windowIdOf(projectId) !== windowId) return
        if (!this.options.enabled()) return
        if (this.options.tabCount(projectId) > 0) return
        this.options.open(projectId)
      })
      .catch((err: unknown) => {
        this.log(`cannot open the first Claude tab of project ${projectId}: ${errorText(err)}`)
      })
    const done = run.finally(() => {
      if (this.running.get(projectId) === done) this.running.delete(projectId)
    })
    this.running.set(projectId, done)
    return done
  }
}
