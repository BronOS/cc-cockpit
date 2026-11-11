// Electron adapter for WindowManager: the only code that turns its requests into BrowserWindows.
// Kept thin on purpose (covered by e2e, not unit tests); every decision lives in window-manager.ts
// and window-bounds.ts.
import { BrowserWindow, screen, type MessagePortMain } from 'electron'
import { errorText } from '../../shared/error-text'
import type { ProjectView, WindowBounds } from '../../shared/types'
import { createWindow, loadRenderer, type WindowLinkOpener } from './create-window'
import { MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, type Rect } from './window-bounds'
import { blurCall, projectWindowBackground, projectWindowChrome, type ProjectWindowLook } from './window-chrome'
import type { WindowCallbacks, WindowFactory, WindowHandle } from './window-manager'

export class ElectronWindowFactory implements WindowFactory {
  /** `openLink`: main's openExternal adapter, for the links a window's page asks to open (create-window.ts). */
  constructor(private readonly openLink: WindowLinkOpener) {}

  createProjectWindow(
    project: ProjectView,
    bounds: WindowBounds | undefined,
    callbacks: WindowCallbacks,
    look: ProjectWindowLook
  ): WindowHandle {
    // The flags are not constructor options (`maximized` does not exist, `fullscreen` is spelled
    // differently): the window is built at its NORMAL bounds and switched state once shown, so
    // un-maximising / leaving full screen lands on the saved normal bounds. No x/y = OS-centred.
    const { maximized, fullScreen, ...rect }: Partial<WindowBounds> = bounds ?? {}
    const win = createWindow({
      ...rect,
      // macOS: the page draws the title bar (traffic lights inset over it); elsewhere the native
      // frame. The title stays the project's name either way (Window menu, Mission Control).
      ...projectWindowChrome(process.platform),
      // Transparent (and blurred) when the setting is on now; creation-only, see window-chrome.ts.
      ...projectWindowBackground(process.platform, look),
      title: project.name,
      minWidth: MIN_WINDOW_WIDTH,
      minHeight: MIN_WINDOW_HEIGHT
    }, this.openLink)
    if (maximized || fullScreen) {
      // After createWindow's own ready-to-show listener (listeners run in order), so the window is
      // shown first: maximize() on a hidden window shows it before the page is painted (Electron
      // docs), and macOS can refuse full screen for a window that is not on screen yet.
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return
        if (fullScreen) win.setFullScreen(true)
        else win.maximize()
      })
    }
    // index.html's <title> would replace the project name on load; the title is main's to set.
    win.on('page-title-updated', (event) => event.preventDefault())
    // 'resize'/'move', not 'resized'/'moved': the latter are macOS/Windows only, so bounds would
    // never be saved on Linux. These fire continuously while dragging; the store debounces.
    // The state changes save the flags (a maximise does fire 'resize' on most platforms, but
    // not reliably before isMaximized() turns true). 'close', not 'closed': the window is still
    // alive, so the final bounds can be read (after 'closed' reading them throws).
    win.on('resize', callbacks.onBoundsChanged)
    win.on('move', callbacks.onBoundsChanged)
    win.on('maximize', callbacks.onBoundsChanged)
    win.on('unmaximize', callbacks.onBoundsChanged)
    win.on('enter-full-screen', () => {
      callbacks.onBoundsChanged()
      callbacks.onFullScreenChanged(true)
    })
    win.on('leave-full-screen', () => {
      callbacks.onBoundsChanged()
      callbacks.onFullScreenChanged(false)
    })
    // The manager may keep the window open: browsers have it open, and it asks the person first
    // (window-manager.ts closeRequested, design-web.md §5.6); it closes or hides it once answered.
    win.on('close', (event) => {
      callbacks.onBoundsChanged()
      if (callbacks.onCloseRequested?.()) event.preventDefault()
    })
    // Server mode's hidden page (design-web.md §9.8): a crashed renderer is reported so the manager
    // reloads it. Only wired when the manager asks (absent on the desktop: a crash there stays as
    // today, the person sees it and closes the window).
    const onPageGone = callbacks.onPageGone
    if (onPageGone) {
      win.webContents.on('render-process-gone', (_event, details) => {
        if (!win.isDestroyed()) onPageGone(`crashed (${details.reason}, exit code ${details.exitCode})`)
      })
    }
    return this.finish(win, callbacks.onClosed, onPageGone)
  }

  createPickerWindow(callbacks: Pick<WindowCallbacks, 'onClosed'>, parentId?: number): WindowHandle {
    // The parent is resolved here from the id the manager took from its own table; a window that
    // is gone by now gives a standalone picker rather than a failure.
    const parent = parentId === undefined ? null : BrowserWindow.fromId(parentId)
    const modalOver = parent && !parent.isDestroyed() ? parent : undefined
    // Sized for the picker's layout (ProjectPicker: header, filter, about six recent rows before
    // the list scrolls); not resizable, so the layout never has to cope with a cramped window.
    const win = createWindow({
      width: 680,
      height: 540,
      resizable: false,
      fullscreenable: false,
      title: 'cc-cockpit',
      // A modal child: the parent takes no focus or input until this closes (a sheet on macOS).
      // A modal child needs a shown parent, and createWindow shows its window on ready-to-show.
      ...(modalOver ? { parent: modalOver, modal: true } : {})
    }, this.openLink)
    return this.finish(win, callbacks.onClosed)
  }

  workAreas(): Rect[] {
    // Primary first: fitBounds caps a position-less size to the first one (the display the OS
    // centres a new window on).
    const primary = screen.getPrimaryDisplay()
    return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea)
  }

  private finish(win: BrowserWindow, onClosed: () => void, onPageGone?: (what: string) => void): WindowHandle {
    // Read the ids now: after `closed` the webContents is destroyed and reading it throws.
    const id = win.id
    const senderId = win.webContents.id
    win.on('closed', onClosed)
    // Counts the loads: a reload while an earlier load is still in flight makes the earlier one reject
    // (ERR_ABORTED), and that rejection is not a failed page: only the newest load's failure counts,
    // or it would schedule one extra reload cycle with a doubled pause.
    let loads = 0
    const load = (): void => {
      const mine = ++loads
      loadRenderer(win).catch((err: unknown) => {
        if (win.isDestroyed() || mine !== loads) return
        // Server mode: the manager reloads it after a pause (closing would end the project's tabs).
        if (onPageGone) {
          onPageGone(`failed to load (${errorText(err)})`)
          return
        }
        // ready-to-show never fires for a failed load, so the window would stay hidden forever.
        console.error('failed to load the shell UI', err)
        win.close()
      })
    }
    load()
    return {
      id,
      senderId,
      // The desktop view's sink (view-registry.ts): the only place a window's page is sent to. The
      // registry is Electron-free, so ports arrive typed unknown; main only ever posts MessagePortMain.
      sink: {
        send: (channel, payload) => win.webContents.send(channel, payload),
        postPort: (channel, payload, port) => win.webContents.postMessage(channel, payload, [port as MessagePortMain]),
        isClosed: () => win.isDestroyed() || win.webContents.isDestroyed()
      },
      focus: () => {
        if (win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      },
      hide: () => {
        if (!win.isDestroyed()) win.hide()
      },
      close: () => {
        if (!win.isDestroyed()) win.close()
      },
      reload: () => {
        if (!win.isDestroyed()) load()
      },
      // Normal bounds: a maximised or fullscreen window would otherwise save the screen size as
      // its "normal" size and reopen huge after un-maximising. The flags only when true.
      getBounds: () => ({
        ...win.getNormalBounds(),
        ...(win.isMaximized() ? { maximized: true } : {}),
        ...(win.isFullScreen() ? { fullScreen: true } : {})
      }),
      isMinimized: () => win.isMinimized(),
      isFullScreen: () => win.isFullScreen(),
      setBlur: (on) => {
        const call = blurCall(process.platform, on)
        if (!call || win.isDestroyed()) return
        if (call.kind === 'vibrancy') win.setVibrancy(call.type)
        else win.setBackgroundMaterial(call.material)
      }
    }
  }
}

/**
 * Crash a window's page as a real renderer crash would (`forcefullyCrashRenderer`). Test runs only
 * (the server-mode e2e's `crashPage` hook): here because this adapter owns the windows' webContents.
 */
export function crashWindowPage(windowId: number): boolean {
  const win = BrowserWindow.fromId(windowId)
  if (!win || win.isDestroyed()) return false
  win.webContents.forcefullyCrashRenderer()
  return true
}
