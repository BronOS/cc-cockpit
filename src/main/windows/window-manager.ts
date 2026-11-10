// Window bookkeeping: one window per project, a project picker when none is open (or when the
// user asks for it: the top strip's "+", File › Open Project), and the map
// from a renderer (its webContents id) to the window and project it belongs to. That map is what
// the IPC router resolves `event.sender` against, so it is the root of "main is the only
// authority": a renderer is only ever acting for the project main opened it for.
//
// No runtime `electron` import (unit tests load this file in plain Node). Creating, focusing and
// measuring real windows goes through `WindowFactory`; the Electron adapter is
// `electron-window-factory.ts`.
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { errorText } from '../../shared/error-text'
import type { ProjectRegistry } from '../projects/registry'
import type { ProjectView, WindowBounds } from '../../shared/types'
import { fitBounds, sanitizeBounds, type Rect } from './window-bounds'
import { OPAQUE_LOOK, type ProjectWindowLook } from './window-chrome'
import type { ViewRegistry, ViewSink } from '../views/view-registry'
import type { AskClose, CloseChoice } from './close-dialog'

export type { Rect } from './window-bounds'

/** A created window, as the manager sees it. */
export interface WindowHandle {
  /** The window's own id (BrowserWindow.id). */
  readonly id: number
  /** Its renderer's webContents id: what an IPC event carries as `event.sender.id`. */
  readonly senderId: number
  /**
   * Its page as a view (design-web.md §2.2): events and port posts reach it only through the
   * ViewRegistry, which the manager registers it with on creation and drops it from on close.
   */
  readonly sink: ViewSink
  /** Bring to front, restoring it first when minimised and showing it when hidden. */
  focus(): void
  /**
   * Take it off screen without closing it (kept running for a browser, design-web.md §5.6). Its
   * page lives on, throttled; `focus` shows it again.
   */
  hide(): void
  /** Ask it to close: the factory's `onCloseRequested` is asked first, as for the person's own close. */
  close(): void
  /**
   * The normal (not maximised / fullscreen) bounds, which is what is worth persisting, plus the
   * maximised / full-screen flags (set only when true).
   */
  getBounds(): WindowBounds
  /** Minimised: its position is the OS's (on Windows, -32000) and not worth persisting. */
  isMinimized(): boolean
  /** In full screen right now (macOS hides the traffic lights then). */
  isFullScreen(): boolean
  /**
   * Turn the blur behind a transparent window on or off (macOS vibrancy, Windows acrylic; nothing
   * on Linux). The manager calls it only for windows it created transparent.
   */
  setBlur(on: boolean): void
}

export interface WindowCallbacks {
  /**
   * Moved, resized, maximised / restored, in or out of full screen, or about to close (the window
   * is still alive then, so its bounds can be read; on `closed` they cannot).
   */
  onBoundsChanged(): void
  /**
   * Entered or left full screen. Separate from `onBoundsChanged` because the page cares too: on
   * macOS the traffic lights hide in full screen, and the top bar collapses the room it keeps for
   * them (the manager's `onFullScreenChanged` carries it to the renderer).
   */
  onFullScreenChanged(fullScreen: boolean): void
  /** The window is gone (user close, programmatic close, or quit). */
  onClosed(): void
  /**
   * The window is about to close (Electron's `close`, for the person's close button and for
   * `close()` alike). True keeps it open: the manager asks what the close means first and closes it
   * itself once answered. Absent (the picker): every close goes ahead.
   */
  onCloseRequested?(): boolean
}

/** The Electron side, behind an interface so the logic here runs under vitest with a fake. */
export interface WindowFactory {
  /**
   * `look`: whether the window is made transparent (and blurred). Creation-only in Electron, so
   * it is decided here, once, from the setting as it is at this moment.
   */
  createProjectWindow(
    project: ProjectView,
    bounds: WindowBounds | undefined,
    callbacks: WindowCallbacks,
    look: ProjectWindowLook
  ): WindowHandle
  /**
   * `parentId`: the project window the picker opens over, as a modal child of it (a sheet on
   * macOS): that window takes no focus or input until the picker closes. Absent: a standalone
   * window (nothing to be modal to).
   */
  createPickerWindow(callbacks: Pick<WindowCallbacks, 'onClosed'>, parentId?: number): WindowHandle
  /** Work areas of the connected displays, primary first, to keep restored bounds on screen. */
  workAreas(): Rect[]
}

/** Who an IPC sender is. A picker has no project, so project-scoped handlers refuse it. */
export type SenderContext =
  | { kind: 'picker'; windowId: number }
  | { kind: 'project'; windowId: number; projectId: string }

export type ManagerRegistry = Pick<
  ProjectRegistry,
  'openPath' | 'recent' | 'update' | 'markOpen' | 'markClosed'
>

export interface WindowManagerOptions {
  factory: WindowFactory
  registry: ManagerRegistry
  /** `process.platform`; decides what closing the picker does (see `pickerClosed`). */
  platform: NodeJS.Platform
  /** Quit the app (Electron's `app.quit`). */
  quit: () => void
  /**
   * A project window is gone (closed by the user or during quit). The tab manager kills that
   * project's terminals here: a PTY outliving its window would have nobody to show or stop it.
   * `windowId` is the closed window's id (already gone from `windowIdOf`): its overlays go too.
   * `reopening`: the window was closed by `reopen` and a new one opens for the project right
   * after this returns, so its tabs are not over (restore.ts brings them back); the caller must
   * not treat this close as the user ending them.
   */
  onProjectClosed?: (projectId: string, windowId: number, reopening: boolean) => void
  /**
   * A `reopen` closed the project's window but could not open the new one (the folder vanished in
   * between): the project is closed after all. Called after `onProjectClosed`.
   */
  onReopenFailed?: (projectId: string) => void
  /**
   * A project window was created (not called when an open project's window is only focused).
   * The plugin host manager starts the project's plugin host here.
   */
  onProjectOpened?: (projectId: string, windowId: number) => void
  /** A project window entered or left full screen (sent on to its renderer). */
  onFullScreenChanged?: (windowId: number, fullScreen: boolean) => void
  /**
   * How a project window is made (AppSettings.windowBackground, defaults applied), read at each
   * creation. Absent: opaque. Never asked for the picker, which stays opaque: it is a short-lived
   * list to read, and as a sheet it sits over a window that may itself be see-through.
   */
  projectWindowLook?: () => ProjectWindowLook
  /**
   * Where every window's page is registered as its desktop view (project windows and the picker:
   * app-wide events reach both). Absent: nothing is registered (tests that do not look at events).
   */
  views?: Pick<ViewRegistry, 'addDesktop' | 'removeWindow'>
  /**
   * The names of the devices with a live remote view of this window, one per device (design-web.md
   * §5.6). Absent or empty: closing the window closes it, as without web access.
   */
  remoteDevices?: (windowId: number) => readonly string[]
  /**
   * Asks the person what closing a window with remote views means (close-dialog.ts). Absent: every
   * close goes ahead, as before web access.
   */
  askClose?: AskClose
  /**
   * A project window was hidden (kept running for a browser) or shown again. index.ts marks its
   * desktop view hidden for the terminal sizes: a hidden renderer is throttled, and a size nobody
   * looks at must never shrink Claude for the browser that does (terminal-sizes.ts).
   */
  onWindowVisibility?: (windowId: number, visible: boolean) => void
  log?: (message: string) => void
}

export class WindowManager {
  /** projectId -> its window. At most one window per project, by construction. */
  private readonly projects = new Map<string, WindowHandle>()
  /** webContents id -> who that renderer is. Entries leave when the window closes. */
  private readonly senders = new Map<number, SenderContext>()
  /**
   * The project windows created transparent, as handles (an id could be reused by a later window).
   * Fixed for each window's life: the setting changing later does not change an open window.
   */
  private readonly transparent = new Set<WindowHandle>()
  /**
   * Project windows `reopen` is closing, with the folder to open again once `closed` arrives.
   * Keyed by handle, like `transparent`: the new window for the project is another handle.
   */
  private readonly reopening = new Map<WindowHandle, string>()
  private picker: WindowHandle | undefined
  /** The folder each open project window was opened from (what `reopen` opens again). */
  private readonly paths = new Map<WindowHandle, string>()
  /** The project window the open picker is a modal child of (none: a standalone picker). */
  private pickerParent: WindowHandle | undefined
  /**
   * Project windows kept running for a browser (design-web.md §5.6): off screen, project open,
   * tabs alive. Opening the project again (`openView`: the picker, `ccc open`) or the dock
   * (`activate`) shows the window; nothing a plugin or a remote view does shows it.
   */
  private readonly hidden = new Set<WindowHandle>()
  /** Windows whose close dialog is up: a second close while it is up waits for the same answer. */
  private readonly asking = new Set<WindowHandle>()
  /** Windows this manager is closing after "Close for everyone": their `close` is not asked again. */
  private readonly closing = new Set<WindowHandle>()
  /**
   * Set on `before-quit`. Quitting closes every window one by one, and each `closed` must not be
   * read as "the user closed it": that would open a picker mid-quit (which can cancel the quit)
   * and mark every project closed, emptying the open list that the next start restores.
   */
  private quitting = false
  private readonly options: WindowManagerOptions

  constructor(options: WindowManagerOptions) {
    this.options = options
  }

  /**
   * Open a folder as a project, or focus its window when it is already open. Throws when the path
   * is not a directory, or names a known project whose folder is gone (relink comes later).
   */
  openPath(path: string): ProjectView {
    return this.openView(this.options.registry.openPath(path))
  }

  /**
   * Open a project from the recent list. The id comes from a renderer, so it is only looked up in
   * that list (the scope a picker may act on), never used to address a record directly.
   */
  openRecent(id: string): ProjectView {
    const entry = this.options.registry.recent().find((p) => p.id === id)
    if (!entry) throw new Error('not a recent project')
    return this.openPath(entry.path)
  }

  /**
   * Show the picker (or focus it: there is only ever one). Does nothing while quitting. Called
   * when no project window is left, and on the user's request with project windows open.
   *
   * `callerWindowId` is the project window that asked (the IPC sender's window, or the focused
   * one for the menu: both resolved by main). The picker then opens as a modal child of it, so
   * that window takes no input until the picker closes. It is looked up in this manager's own
   * table, never used as an id to address a BrowserWindow, so an id that is not a project window
   * (a picker, a stale one) simply gives a standalone picker. An already open picker is focused
   * whoever asks: a second one would split the recent list's actions, and focusing a sheet of
   * another window is how the user finds it again.
   */
  showPicker(callerWindowId?: number): void {
    if (this.quitting) return
    if (this.picker) {
      this.picker.focus()
      return
    }
    let parent: WindowHandle | undefined
    if (callerWindowId !== undefined) {
      // Never a hidden window: a sheet on a window that is off screen would be off screen too.
      for (const h of this.projects.values()) if (h.id === callerWindowId && !this.hidden.has(h)) parent = h
    }
    let handle: WindowHandle | undefined = undefined
    handle = this.options.factory.createPickerWindow(
      {
        onClosed: () => {
          if (handle) this.pickerClosed(handle)
        }
      },
      parent?.id
    )
    this.picker = handle
    this.pickerParent = parent
    this.senders.set(handle.senderId, { kind: 'picker', windowId: handle.id })
    this.options.views?.addDesktop(handle.id, handle.sink)
  }

  /**
   * Surface the app (a bare relaunch through `second-instance`): focus a project window through
   * its handle, which un-minimises it first (BrowserWindow.focus alone does not), else show the
   * picker. The most recently opened visible project window is chosen, else the most recently
   * opened hidden one, which is shown (relaunching the app is the person asking for it on this
   * screen); closed ones have already left `projects`.
   */
  focusAny(): void {
    const last = this.lastWindow()
    if (last) this.show(last)
    else this.showPicker()
  }

  /**
   * Bring a project's window to front (un-minimising it, via its handle). False when that project
   * has no open window. The caller names the project from main's own tables (a session entry),
   * never from a renderer payload. A window kept running for a browser stays hidden (true: the
   * project is open): what raises a window here is a plugin or a click in another view (a session
   * chip, ctx.sessions.focus, a plugin's tab close), and only the person opening the project again
   * on this machine brings it back (design-web.md §5.6).
   */
  focusProject(projectId: string): boolean {
    const handle = this.projects.get(projectId)
    if (!handle) return false
    if (!this.hidden.has(handle)) handle.focus()
    return true
  }

  /** Every open project window, in the order they were opened (for per-window broadcasts). */
  projectWindows(): Array<{ projectId: string; windowId: number }> {
    return [...this.projects].map(([projectId, handle]) => ({ projectId, windowId: handle.id }))
  }

  /**
   * macOS dock click: an app with no window on screen shows the most recent window kept running
   * for a browser (the dock is one of the ways back, design-web.md §5.6), else the picker.
   */
  activate(): void {
    if (this.picker) return
    if ([...this.projects.values()].some((h) => !this.hidden.has(h))) return
    const last = this.lastWindow()
    if (last) this.show(last)
    else this.showPicker()
  }

  /** Whether this project window is kept running hidden for a browser (false for an unknown window). */
  isHidden(windowId: number): boolean {
    for (const h of this.hidden) if (h.id === windowId) return true
    return false
  }

  /** Call on `before-quit`; from here on closing windows is not a user action. */
  beginQuit(): void {
    this.quitting = true
  }

  /** Who the renderer with this webContents id is, or undefined for anything we did not open. */
  resolveSender(senderId: number): SenderContext | undefined {
    return this.senders.get(senderId)
  }

  /** Whether this project window is in full screen (false for an unknown window). */
  isFullScreen(windowId: number): boolean {
    for (const h of this.projects.values()) if (h.id === windowId) return h.isFullScreen()
    return false
  }

  /** Whether this project window was created transparent (false for an unknown window, the picker included). */
  isTransparent(windowId: number): boolean {
    for (const h of this.transparent) if (h.id === windowId) return true
    return false
  }

  /**
   * "Blur behind" changed: apply it to every open window that was created transparent. An opaque
   * window is left alone: vibrancy on it would paint the material over nothing (its page is
   * opaque) and only cost compositing.
   */
  setBlur(on: boolean): void {
    for (const h of this.transparent) h.setBlur(on)
  }

  /**
   * Close this project's window and open it again at once, through the same path a user close and
   * a new open take, so the new window is made from the settings as they are now (transparency is
   * creation-only in Electron). The project stays in the open list throughout, no picker appears,
   * and closing the only window does not quit the app. A modal picker over the window is closed
   * first: Electron would close it with its parent anyway, and the orphan bookkeeping in
   * `projectClosed` is for a user close. The id is the caller's, resolved by main (the IPC
   * sender's project), never a renderer payload. Throws when the project has no window; a second
   * call while the first close is still under way is a no-op.
   */
  reopen(projectId: string): void {
    const handle = this.projects.get(projectId)
    if (!handle) throw new Error('the project has no open window')
    if (this.quitting || this.reopening.has(handle)) return
    const path = this.paths.get(handle)
    if (path === undefined) throw new Error('the project has no open window')
    if (this.pickerParent === handle) this.closePicker()
    this.reopening.set(handle, path)
    handle.close()
  }

  /** The id of the project window that is open for this project, if any. */
  windowIdOf(projectId: string): number | undefined {
    return this.projects.get(projectId)?.id
  }

  get projectWindowCount(): number {
    return this.projects.size
  }

  /** The open picker's window id (main pushes `projects.changed` to it); undefined when none is open. */
  get pickerWindowId(): number | undefined {
    return this.picker?.id
  }

  /** The open picker is a modal child of a project window (so it offers Cancel / Esc). */
  get pickerModal(): boolean {
    return this.picker !== undefined && this.pickerParent !== undefined
  }

  /**
   * The picker's Cancel / Esc. Only a modal picker may be dismissed this way: a standalone one is
   * the app's only window, and closing it ends the app on Linux / Windows, which is the close
   * button's decision, not a page's. Closes through the handle like a user close, so the parent
   * gets its focus back (`pickerClosed`).
   */
  dismissPicker(): void {
    if (this.picker && this.pickerParent) this.picker.close()
  }

  get pickerOpen(): boolean {
    return this.picker !== undefined
  }

  private openView(view: ProjectView, { keepPicker = false }: { keepPicker?: boolean } = {}): ProjectView {
    const existing = this.projects.get(view.id)
    if (existing) {
      // Opening the project again is how a window kept running for a browser comes back.
      this.show(existing)
      // Picked in a picker the user opened over open projects (the top strip's "+"): the pick is
      // done, so the picker goes as it does when a new window opens.
      this.closePicker()
      return view
    }
    if (view.missing) {
      // A window for a folder that is not there would start tabs in a nonexistent cwd.
      throw new Error(`project folder is missing: ${view.path}`)
    }
    const projectId = view.id
    const look = this.options.projectWindowLook?.() ?? OPAQUE_LOOK
    let handle: WindowHandle | undefined = undefined
    handle = this.options.factory.createProjectWindow(
      view,
      // The record is user-writable: a damaged `bounds` reads as none (today's default size).
      fitBounds(sanitizeBounds(view.bounds), this.options.factory.workAreas()),
      {
        onBoundsChanged: () => {
          // JsonFile debounces (one write per window of time however many events arrive), so
          // saving on every move/resize event is cheap. A minimised window keeps what was saved
          // before: its bounds are the OS's parking spot, not a place to reopen at.
          if (!handle || handle.isMinimized()) return
          const bounds = handle.getBounds()
          this.options.registry.update(projectId, (r) => {
            r.bounds = bounds
          })
        },
        onFullScreenChanged: (fullScreen) => {
          if (handle) this.options.onFullScreenChanged?.(handle.id, fullScreen)
        },
        onClosed: () => {
          if (handle) this.projectClosed(projectId, handle)
        },
        onCloseRequested: () => (handle ? this.closeRequested(projectId, handle) : false)
      },
      look
    )
    if (look.transparent) this.transparent.add(handle)
    this.paths.set(handle, view.path)
    this.projects.set(projectId, handle)
    this.senders.set(handle.senderId, { kind: 'project', windowId: handle.id, projectId })
    // Before onProjectOpened: the plugin host it starts may already emit to the project.
    this.options.views?.addDesktop(handle.id, handle.sink)
    this.options.registry.markOpen(projectId)
    this.options.onProjectOpened?.(projectId, handle.id)

    // A project opened, so the picker's job is done. Close it after the project is registered,
    // so its `closed` sees a project window and does not quit the app on Linux.
    if (!keepPicker) this.closePicker()
    return view
  }

  private closePicker(): void {
    const picker = this.picker
    if (!picker) return
    this.picker = undefined
    this.pickerParent = undefined
    this.senders.delete(picker.senderId)
    picker.close()
  }

  /**
   * The window is about to close (design-web.md §5.6). True keeps it open for now: browsers have it
   * open, so the person is asked whether the close is for everyone or only for this screen, and the
   * answer closes or hides it. Nothing asks while quitting (quit closes every view, with a notice),
   * for a reopen (the window comes straight back) or for the close the answer itself starts.
   */
  private closeRequested(projectId: string, handle: WindowHandle): boolean {
    if (this.quitting || this.reopening.has(handle) || this.closing.has(handle)) return false
    if (this.projects.get(projectId) !== handle) return false
    // The dialog is up: a second click on the close button waits for the same answer.
    if (this.asking.has(handle)) return true
    const ask = this.options.askClose
    const devices = this.options.remoteDevices?.(handle.id) ?? []
    if (!ask || devices.length === 0) return false
    this.asking.add(handle)
    const answered = (choice: CloseChoice): void => this.closeAnswered(projectId, handle, choice)
    ask(handle.id, devices).then(answered, (err: unknown) => {
      // A dialog that cannot be shown must not leave a window nobody can close (close-dialog.ts).
      this.logLine(`window close dialog failed: ${errorText(err)}`)
      answered('everyone')
    })
    return true
  }

  private closeAnswered(projectId: string, handle: WindowHandle, choice: CloseChoice): void {
    this.asking.delete(handle)
    // Closed meanwhile (a quit closes it without asking): the answer is about a window that is gone.
    if (this.quitting || this.projects.get(projectId) !== handle) return
    if (choice === 'everyone') {
      this.closing.add(handle)
      handle.close()
    } else if (choice === 'keep') {
      this.hide(handle)
    }
  }

  /**
   * Keep the window running off screen. A modal picker over it goes first (a sheet of a hidden
   * window would be off screen too, and would hold the window's input when it comes back).
   */
  private hide(handle: WindowHandle): void {
    if (this.hidden.has(handle)) return
    if (this.pickerParent === handle) this.closePicker()
    this.hidden.add(handle)
    handle.hide()
    this.options.onWindowVisibility?.(handle.id, false)
  }

  /** Bring a window to front, showing it again when it was kept running hidden. */
  private show(handle: WindowHandle): void {
    const wasHidden = this.hidden.delete(handle)
    handle.focus()
    if (wasHidden) this.options.onWindowVisibility?.(handle.id, true)
  }

  /** The most recently opened project window on screen, else the most recently opened hidden one. */
  private lastWindow(): WindowHandle | undefined {
    let visible: WindowHandle | undefined
    let any: WindowHandle | undefined
    for (const handle of this.projects.values()) {
      any = handle
      if (!this.hidden.has(handle)) visible = handle
    }
    return visible ?? any
  }

  private logLine(message: string): void {
    const log = this.options.log ?? ((m: string) => console.warn(m))
    log(message)
  }

  private projectClosed(projectId: string, handle: WindowHandle): void {
    this.senders.delete(handle.senderId)
    this.hidden.delete(handle)
    this.asking.delete(handle)
    this.closing.delete(handle)
    // Its views go with it, before onProjectClosed: the tabs killed there emit to a window that is gone.
    this.options.views?.removeWindow(handle.id)
    this.transparent.delete(handle)
    this.paths.delete(handle)
    const reopenPath = this.reopening.get(handle)
    this.reopening.delete(handle)
    // A reopen of a window that is no longer the project's (cannot happen: reopen takes the
    // current one, and only a `closed` removes it) is just a close.
    const current = this.projects.get(projectId) === handle
    const reopening = reopenPath !== undefined && current && !this.quitting
    if (current) {
      this.projects.delete(projectId)
      // Only for the window that was current: a late `closed` of an older window must not kill
      // the tabs of a newer window opened for the same project.
      this.options.onProjectClosed?.(projectId, handle.id, reopening)
    }
    if (this.quitting) return
    // A picker that was this window's modal child dies with it (Electron closes children with
    // their parent). Let go of it before deciding about a new one, or showPicker would only
    // "focus" the dying window and the app would be left without any.
    const orphan = this.pickerParent === handle ? this.picker : undefined
    if (orphan) {
      this.picker = undefined
      this.pickerParent = undefined
      this.senders.delete(orphan.senderId)
    }
    if (reopening) {
      // Synchronously, inside the old window's `closed`: no moment without the project's window,
      // so nothing below (markClosed, the picker for "no project open", quit on Linux / Windows
      // when the picker then closes) ever sees the project as closed. registry.openPath reads the
      // record in memory, which the old window's `close` just updated with its final bounds and
      // maximised / full-screen flags, so the new window comes back where the old one was. A
      // picker open over another window is the user's and stays (an open from the picker closes
      // it; this one is not a pick).
      try {
        this.openView(this.options.registry.openPath(reopenPath), { keepPicker: true })
        orphan?.close()
        return
      } catch (err) {
        const log = this.options.log ?? ((m: string) => console.warn(m))
        log(`cannot reopen ${reopenPath}: ${errorText(err)}`)
        this.options.onReopenFailed?.(projectId)
      }
    }
    this.options.registry.markClosed(projectId)
    // Design: "a project picker when none is open". On every platform the last project window
    // closing leaves the picker, so Cmd+O / a recent project is one click away.
    if (this.projects.size === 0) this.showPicker()
    orphan?.close()
  }

  /**
   * The picker was closed. With project windows open (we closed it after opening one) nothing
   * happens. With none, platforms differ: macOS apps stay alive in the dock with no window (a
   * dock click calls `activate`, which re-shows the picker); on Linux (and Windows) a closed last
   * window means quit.
   */
  private pickerClosed(handle: WindowHandle): void {
    this.senders.delete(handle.senderId)
    this.options.views?.removeWindow(handle.id)
    // Closed by the user (Esc / Cancel / the close button), not by `closePicker` (which clears
    // `picker` first): a sheet gives the key focus back to its parent on macOS, but not reliably
    // elsewhere, so hand it over explicitly.
    const parent = this.picker === handle ? this.pickerParent : undefined
    if (this.picker === handle) {
      this.picker = undefined
      this.pickerParent = undefined
    }
    if (parent && [...this.projects.values()].includes(parent)) parent.focus()
    // `picker` set: a replacement picker already exists (the orphan of a closed parent), so this
    // `closed` is not the last window going away.
    if (this.quitting || this.projects.size > 0 || this.picker) return
    if (this.options.platform !== 'darwin') this.options.quit()
  }
}

/**
 * The folder to open from a command line (`cc-cockpit <path>` at start, or the argv a second
 * instance forwards on `second-instance`). argv[0] is the executable; under `electron .`
 * (`process.defaultApp`) the app path is a directory itself and must not be taken for a project.
 * It is the first non-switch argument, not necessarily argv[1]: `electron --inspect=9229 .`
 * puts a switch in front, and Electron documents that the argv `second-instance` delivers may be
 * reordered with switches moved. A fixed index would drop the switch and keep `.`, and a bare
 * relaunch would then open the cc-cockpit source folder as a project. Chromium also appends its
 * own `--switch=value` arguments, so dash-prefixed arguments are skipped everywhere, and relative
 * paths resolve against the invoking shell's cwd (the second instance's, not ours). The last
 * argument that is an existing directory wins.
 */
export function projectPathFromArgv(
  argv: readonly string[],
  cwd: string,
  defaultApp: boolean,
  isDirectory: (path: string) => boolean = isDir
): string | undefined {
  const isSwitch = (arg: string): boolean => arg === '' || arg.startsWith('-')
  let args = argv.slice(1)
  if (defaultApp) {
    const appPath = args.findIndex((arg) => !isSwitch(arg))
    if (appPath >= 0) args = args.slice(appPath + 1)
  }
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i]!
    if (isSwitch(arg)) continue
    const path = resolve(cwd, arg)
    if (isDirectory(path)) return path
  }
  return undefined
}

/** What a second instance sends through `requestSingleInstanceLock(additionalData)`. */
export interface SecondInstanceData {
  argv: string[]
  cwd: string
}

/**
 * The `additionalData` of a `second-instance` event, if it has the shape this app sends. It comes
 * from another process (possibly an older or newer build holding the same lock), so it is
 * checked, never cast; undefined means "use Electron's argv instead".
 */
export function asSecondInstanceData(data: unknown): SecondInstanceData | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { argv, cwd } = data as Record<string, unknown>
  if (typeof cwd !== 'string' || cwd === '') return undefined
  if (!Array.isArray(argv) || !argv.every((a): a is string => typeof a === 'string')) {
    return undefined
  }
  return { argv, cwd }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
