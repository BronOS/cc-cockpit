// Electron adapter for webview panels in server mode (design-web-browser.md §3.1): each view is an
// off-screen BrowserWindow (`webPreferences.offscreen`) whose frames later tasks stream to the
// browser views, since the server has no screen to place a WebContentsView on. The only
// `offscreen` BrowserWindow in the app. Like electron-webview.ts it decides nothing; it makes the
// page and reports what the page does, and implements the same WebviewView, so WebviewManager
// keeps every decision whichever adapter main picked (by `server`, decided once at start).
//
// What differs from the desktop adapter, and why:
// - `disableDialogs: true`, always: under Ozone headless a JS dialog (alert, confirm, prompt) in
//   the page aborts main (SIGTRAP, spike 2026-11-11), ending every project on the server. With it
//   `alert` returns at once, `confirm` is false, `prompt` throws in the page.
// - cancelOffscreenNativeUi (webview-hardening.ts): file choosers, the File System Access pickers
//   and print() cancelled, since nobody can answer them here and a desktop portal on the session
//   bus would show them on the server's desktop (print blocking the page until answered).
// - Sized explicitly: under the headless platform the window starts 1x1 whatever `width` and
//   `height` say (spike), so the size is set right after creation and on every setBounds. Only the
//   size counts; there is no screen position.
// - Never shown, focused or positioned: no `show`, `focus` or `setBounds` on the window. Not
//   `focusable: false` either, which may cost the keyboard events later tasks send with
//   sendInputEvent (the spike's key events went to a default, never-shown window).
// - No `before-input-event` chord forwarding: shell chords never reach the page from a browser
//   (the web shell keeps them), and the desktop path (`webviewChord`) would focus the hidden page
//   and run a command only it runs (plan review).
// - setVisible is painting: `stopPainting` while no browser shows the panel (no CPU, no frames),
//   `startPainting` plus `invalidate` when one does, so a full frame comes at once (an idle page
//   paints nothing by itself, spike).
// - `paint` and `cursor-changed` go to the view's sink (setSink), for the frame stream and the
//   browsers' cursor; with no sink they are dropped. Input comes back through sendInput
//   (`sendInputEvent`, checked by webview-input.ts).
import { BrowserWindow, type NativeImage, type Rectangle } from 'electron'
import type { ViewBounds } from '../overlays/overlay-manager'
import { cancelOffscreenNativeUi, hardenWebContents, webviewNavigation, webviewPreferences, WebviewSessions, type ServePreview } from './webview-hardening'
import { SELECTION_SCRIPT, WEBVIEW_WORLD_ID, type ElectronInputEvent } from './webview-input'
import { chooseScript, hitScript } from './select-hit'
import type { WebviewEvents, WebviewView, WebviewViewFactory } from './webview-manager'

/** The page's size before any browser reported one (CSS px; a common laptop browser area). */
export const OFFSCREEN_INITIAL_SIZE = { width: 1280, height: 800 } as const
/** The largest page side the adapter applies (design-web-browser.md §5; placement clamps first). */
export const OFFSCREEN_MAX_SIDE = 4096
/** Frames per second at most while painting (design-web-browser.md §3.3). */
export const OFFSCREEN_FRAME_RATE = 30

/** Where an off-screen view's output goes (the frame stream, the browsers' cursor). */
export interface OffscreenSink {
  /** A frame: the whole page as `image`, `dirty` the part that changed. */
  paint(dirty: Rectangle, image: NativeImage): void
  /** The page's cursor changed (Chromium's cursor type name: `pointer`, `hand`, `text`, ...). */
  cursor(type: string): void
}

/** A WebviewView that paints off-screen. */
export interface OffscreenWebviewView extends WebviewView {
  /** Where paints and cursor changes go from now on (undefined: dropped). */
  setSink(sink: OffscreenSink | undefined): void
  /** The page's current size (CSS px). */
  size(): { width: number; height: number }
  /** Ask the page for a full frame (a new viewer with no frame to show yet). No-op once gone. */
  invalidate(): void
  /** Trusted input for the page (`sendInputEvent`), as webview-input.ts checked and mapped it. No-op once gone. */
  sendInput(events: readonly ElectronInputEvent[]): void
}

/** One live off-screen view's window, as the test hook `offscreenWebviews` reports it. */
export interface OffscreenWindowInfo {
  /** The off-screen window's own id (never a project window's). */
  windowId: number
  /** Its page's WebContents id (main's sender table must not know it). */
  webContentsId: number
  /** The project window the view belongs to (in server mode the hidden page's). */
  ownerWindowId: number
  visible: boolean
  focused: boolean
  painting: boolean
  width: number
  height: number
}

/**
 * Whether `win` is an off-screen webview window of this adapter. main's app-wide window events
 * (`browser-window-created`, `browser-window-focus`) see these windows too, and must leave them
 * alone: one is never a project window, the picker or the hidden page. Read from the page's own
 * flag rather than a table, since `browser-window-created` fires inside the BrowserWindow
 * constructor, before create() below can note the new window's id.
 */
export function isOffscreenWindow(win: BrowserWindow): boolean {
  return !win.isDestroyed() && win.webContents.isOffscreen()
}

/** A side from setBounds: whole pixels, at most OFFSCREEN_MAX_SIDE; undefined for no usable size. */
function sideOf(n: number): number | undefined {
  if (!Number.isFinite(n) || n < 1) return undefined
  return Math.min(OFFSCREEN_MAX_SIDE, Math.round(n))
}

export class OffscreenWebviewFactory implements WebviewViewFactory {
  private readonly sessions: WebviewSessions
  /** The live views' windows (describe, destroyAll); each removes itself on destroy. */
  private readonly live = new Map<BrowserWindow, { info(): OffscreenWindowInfo; destroy(): void }>()

  constructor(
    /** Answer one cc-preview request from `partition`'s session (preview-protocol.ts + the manager's tokens). */
    servePreview: ServePreview,
    private readonly log: (message: string) => void
  ) {
    this.sessions = new WebviewSessions(servePreview)
  }

  create(windowId: number, partition: string, events: WebviewEvents): OffscreenWebviewView {
    // The project window the view belongs to (in server mode the hidden page's): the same contract
    // as the desktop adapter, and its close takes the view along (below).
    const owner = BrowserWindow.fromId(windowId)
    if (!owner || owner.isDestroyed()) throw new Error('webview: the window is gone')
    this.sessions.prepare(partition)
    const win = new BrowserWindow({
      show: false,
      width: OFFSCREEN_INITIAL_SIZE.width,
      height: OFFSCREEN_INITIAL_SIZE.height,
      useContentSize: true,
      frame: false,
      skipTaskbar: true,
      webPreferences: { ...webviewPreferences(partition), offscreen: true, disableDialogs: true }
    })
    const wc = win.webContents
    let size: { width: number; height: number } = { ...OFFSCREEN_INITIAL_SIZE }
    win.setContentSize(size.width, size.height)
    hardenWebContents(wc, events)
    cancelOffscreenNativeUi(wc, this.log)
    wc.setFrameRate(OFFSCREEN_FRAME_RATE)
    // Hidden until the manager says a browser shows it, like the desktop view's zero bounds.
    let painting = false
    wc.stopPainting()
    let sink: OffscreenSink | undefined
    wc.on('paint', (_event, dirty, image) => sink?.paint(dirty, image))
    wc.on('cursor-changed', (_event, type) => sink?.cursor(type))

    let destroyed = false
    const destroy = (): void => {
      if (destroyed) return
      destroyed = true
      sink = undefined
      this.live.delete(win)
      if (!owner.isDestroyed()) owner.removeListener('closed', destroy)
      // destroy, not close: a page whose renderer is blocked (a print the portal still holds,
      // spike) never answers a close; destroy frees it at once. `destroyed` on its WebContents
      // tells the manager (gone), as a closed desktop view does.
      if (!win.isDestroyed()) win.destroy()
    }
    // An off-screen window is not a child of the project window: if a view were left behind when it
    // closes it would live on unseen, holding a renderer and keeping the app's window count up.
    owner.once('closed', destroy)
    this.live.set(win, {
      info: () => ({
        windowId: win.id,
        webContentsId: wc.id,
        ownerWindowId: windowId,
        visible: win.isVisible(),
        focused: win.isFocused(),
        painting,
        ...size
      }),
      destroy
    })

    return {
      ...webviewNavigation(wc),
      // Never focused (nothing here is ever handed the keyboard), so the manager never thinks an
      // off-screen view took it from the shell page.
      isFocused: () => false,
      setBounds: (bounds: ViewBounds) => {
        if (win.isDestroyed()) return
        // Zero bounds are the manager's "no placement yet": keep the last size (hiding is
        // setVisible's job), so the page does not reflow to 1x1 and back.
        const width = sideOf(bounds.width)
        const height = sideOf(bounds.height)
        if (width === undefined || height === undefined) return
        if (width === size.width && height === size.height) return
        size = { width, height }
        win.setContentSize(width, height)
      },
      setVisible: (visible: boolean) => {
        if (wc.isDestroyed() || visible === painting) return
        painting = visible
        if (visible) {
          wc.startPainting()
          wc.invalidate()
        } else {
          wc.stopPainting()
        }
      },
      destroy,
      setSink: (next) => {
        sink = destroyed ? undefined : next
      },
      size: () => ({ ...size }),
      // A browser's pointer, wheel and keys, checked and mapped by webview-input.ts (main's only
      // path here: `webviews.input` from a viewer). Never focuses the window: off-screen input
      // reaches the page without it (spike).
      sendInput: (events) => {
        if (wc.isDestroyed()) return
        for (const event of events) wc.sendInputEvent(event)
      },
      // A browser's committed text (an IME, a dead key, non-ASCII, a paste; webview-input.ts has
      // checked and cleaned it): into the focused field as an IME commit, nothing when none is.
      // Through the page's protocol (attached by cancelOffscreenNativeUi), whose `Input.insertText`
      // is an IME commit on the widget's input pipe: the renderer queues it behind the keys
      // sendInputEvent already sent, and it settles once the page has it. `webContents.insertText`
      // is an IPC of its own to the renderer, which a key sent just before or after it overtook
      // (the e2e typed 'héllo ü' as "hlélo ü" and "éhllo ü", about one run in ten); it is only the
      // fallback for a view whose protocol detached. A rejection is the lane's to hear (it lets
      // the input after the text go), never thrown here.
      insertText: (text) => {
        if (wc.isDestroyed()) return Promise.resolve()
        return wc.debugger.isAttached() ? wc.debugger.sendCommand('Input.insertText', { text }) : wc.insertText(text)
      },
      // The page's selection, read in main's own isolated world (webview-input.ts SELECTION_SCRIPT):
      // the page's scripts cannot see the read nor stand in for what it calls.
      readSelection: () =>
        wc.isDestroyed() ? Promise.resolve(undefined) : wc.executeJavaScriptInIsolatedWorld(WEBVIEW_WORLD_ID, [{ code: SELECTION_SCRIPT }]),
      // A select popup the page does not paint (select-hit.ts): what is under a press, and the
      // browser's answer, in the same isolated world (the element is kept there between the two).
      hitSelect: (x, y, id) =>
        wc.isDestroyed() ? Promise.resolve(undefined) : wc.executeJavaScriptInIsolatedWorld(WEBVIEW_WORLD_ID, [{ code: hitScript(x, y, id) }]),
      chooseSelect: (id, index) =>
        wc.isDestroyed() ? Promise.resolve(false) : wc.executeJavaScriptInIsolatedWorld(WEBVIEW_WORLD_ID, [{ code: chooseScript(id, index) }]),
      invalidate: () => {
        if (!wc.isDestroyed()) wc.invalidate()
      }
    }
  }

  /** The live views' windows, for the test hook `offscreenWebviews` (never shown, never focused). */
  describe(): OffscreenWindowInfo[] {
    const out: OffscreenWindowInfo[] = []
    for (const [win, entry] of this.live) if (!win.isDestroyed()) out.push(entry.info())
    return out
  }

  /**
   * Destroy every live view's window (main's `before-quit`). Electron's own quit closes each window,
   * and a close waits for the page: one whose renderer is blocked (a cross-site sub-frame's print
   * held by a desktop portal, the one case the hardening does not cover, design-web-browser.md §2)
   * would never answer and hold the quit up until systemd's SIGKILL. destroy does not wait. The
   * manager hears each go (`gone`) as when the page crashed.
   */
  destroyAll(): void {
    for (const entry of [...this.live.values()]) entry.destroy()
  }
}
