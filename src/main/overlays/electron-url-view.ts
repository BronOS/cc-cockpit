// Electron adapter for url overlays: the only code that creates a WebContentsView. Thin on purpose
// (covered by e2e); the decisions (which URLs, which site is "another", which keys) live in
// overlay-manager.ts.
//
// A url overlay shows a web page the caller named, so it gets nothing of the app:
// - no preload, no Node, sandboxed and context-isolated: the page has no bridge to main at all;
// - its own in-memory session partition per window (`overlay-<windowId>`), so it shares no
//   cookies or storage with the shell UI or with another window's overlays, and nothing persists;
// - every permission (camera, notifications, ...), device and screen capture denied, downloads
//   cancelled;
// - `window.open` and navigation to another site go to the system browser (http/https only).
import { BrowserWindow, WebContentsView, type Session } from 'electron'
import {
  chordOfInput,
  overlayUrlOf,
  sameSite,
  type UrlView,
  type UrlViewFactory,
  type ViewBounds
} from './overlay-manager'
import { lockDownSession, NO_APP_PAGE } from '../windows/permissions'

/** Partitions already locked down (a session outlives the views that use it). */
const hardened = new WeakSet<Session>()
/** Chromium's net::ERR_ABORTED: the navigation was cancelled, often because another replaced it. */
const ERR_ABORTED = -3

function harden(session: Session): void {
  if (hardened.has(session)) return
  hardened.add(session)
  // No page here is the app page, so every permission, device and screen capture is refused
  // (windows/permissions.ts).
  lockDownSession(session, NO_APP_PAGE)
  session.on('will-download', (event) => event.preventDefault())
}

/**
 * What a URL overlay's page does with a link that leaves it: the openExternal adapter
 * (external/open-external.ts) for the overlay's window, which main wires in.
 */
export type OverlayLinkOpener = (url: string, windowId: number) => Promise<void>

export class ElectronUrlViewFactory implements UrlViewFactory {
  constructor(private readonly open: OverlayLinkOpener) {}

  /** Hand a link on when it is http(s); anything else is dropped. */
  private openExternal(url: string, windowId: number): void {
    let href: string
    try {
      href = overlayUrlOf(url)
    } catch {
      return
    }
    this.open(href, windowId).catch((err: unknown) => console.warn('open external failed', err))
  }

  create(
    windowId: number,
    url: string,
    onChord: (chord: string) => boolean,
    onGone: () => void,
    onLoaded: () => void
  ): UrlView {
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) throw new Error('overlay: the window is gone')
    const view = new WebContentsView({
      webPreferences: {
        // Deliberately no `preload`.
        partition: `overlay-${windowId}`,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        experimentalFeatures: false,
        safeDialogs: true
      }
    })
    const wc = view.webContents
    harden(wc.session)
    wc.setWindowOpenHandler(({ url: target }) => {
      this.openExternal(target, windowId)
      return { action: 'deny' }
    })
    // The page went away by itself (renderer crash or kill, OOM, the page closed itself): the
    // overlay must not stay up over a dead view. Also fires after our own destroy(); harmless.
    wc.on('render-process-gone', () => onGone())
    wc.on('destroyed', () => onGone())
    // The first load ended, either way: the overlay's loader goes and the view shows (the manager
    // keeps it hidden until then; it ignores the calls after the first). A failed load leaves
    // Electron's empty page, which the user then sees and closes. ERR_ABORTED (-3) is not an end:
    // the main frame gets it when another navigation replaced the first one, and showing the view
    // then would flash a blank page mid-redirect; the navigation that replaced it ends the loader.
    // `did-stop-loading` (the spinner stopped, nothing more is coming) ends it whatever happened:
    // a first load that ends with no load event at all, a 204 or a redirect our will-redirect
    // cancels (to a non-http scheme), only fires that one, and left the loader up for good.
    wc.on('did-finish-load', () => onLoaded())
    wc.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== ERR_ABORTED) onLoaded()
    })
    wc.on('did-stop-loading', () => onLoaded())
    // The page's own links and script navigations: same site (http(s) only, see sameSite)
    // stays, anything else leaves.
    wc.on('will-navigate', (event) => {
      if (sameSite(wc.getURL() || url, event.url)) return
      event.preventDefault()
      this.openExternal(event.url, windowId)
    })
    // Server redirects. The first load may land on another host (example.com -> www.example.com,
    // a login hop) and the caller chose that URL, so only the scheme is checked until a page has
    // committed; after that a redirect to another site leaves like a link would.
    let committed = false
    wc.on('did-navigate', () => {
      committed = true
    })
    wc.on('will-redirect', (event) => {
      if (!event.isMainFrame) return
      let httpLike = false
      try {
        httpLike = /^https?:$/.test(new URL(event.url).protocol)
      } catch {
        // Unparseable: treated like a non-http scheme.
      }
      if (httpLike && (!committed || sameSite(wc.getURL() || url, event.url))) return
      event.preventDefault()
      if (httpLike) this.openExternal(event.url, windowId)
    })
    // Keys typed into the page never reach the shell UI; the overlay keys are resolved in main.
    wc.on('before-input-event', (event, input) => {
      if (onChord(chordOfInput(input) ?? '')) event.preventDefault()
    })
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    win.contentView.addChildView(view)
    wc.loadURL(url).catch((err: unknown) => {
      // A failed load (no network, bad certificate) leaves an empty page at the URL (Electron has
      // no error page); the overlay stays so the user sees it and closes it.
      console.warn('overlay page failed to load', err)
    })

    return {
      setBounds: (bounds: ViewBounds) => {
        if (!wc.isDestroyed()) view.setBounds(bounds)
      },
      setVisible: (visible: boolean) => {
        if (!wc.isDestroyed()) view.setVisible(visible)
      },
      focus: () => {
        if (!wc.isDestroyed()) wc.focus()
      },
      destroy: () => {
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        // A WebContentsView's page is not closed with the view; it would live on unseen.
        if (!wc.isDestroyed()) wc.close()
      }
    }
  }

  focusWindow(windowId: number): void {
    const win = BrowserWindow.fromId(windowId)
    if (win && !win.isDestroyed()) win.webContents.focus()
  }
}
