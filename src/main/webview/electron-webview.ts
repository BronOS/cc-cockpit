// Electron adapter for webview panels: creates their WebContentsView (the only WebContentsView
// code besides electron-url-view.ts). Thin on purpose (covered by e2e from Task 8, and by
// test/unit/electron-webview.test.ts with `electron` stubbed for the hardening); every decision
// (which navigation may go ahead, which tokens a session serves, where window.open goes) is
// webview-manager.ts's.
//
// Hardened like a url overlay (electron-url-view.ts), because the page is anything on the web:
// - no preload, no Node, sandboxed and context-isolated: the page has no bridge to main at all;
// - an in-memory session partition per project and plugin (`webview-<projectId>-<pluginId>`), so
//   it shares no cookies or storage with the shell UI, another plugin or another project, and
//   nothing persists past quit;
// - every permission, device and screen capture denied, downloads cancelled, WebRTC kept off
//   non-proxied UDP;
// - `cc-preview://` is answered on THAT session only (`session.protocol.handle`), never on the
//   default one where the shell page and cc-plugin:// live, and only with that session's tokens;
// - a `beforeunload` handler never holds the view: Electron cancels the unload silently once the
//   user has touched such a page (an editor, a form), so `ccc browser open <other>` and reload
//   would do nothing while the CLI printed `ok` (review finding). The unload always goes ahead.
// Unlike an overlay, http(s) navigation stays in the view (it is a browser).
//
// A failed load: Electron has no error page. It commits an empty page at the failed URL (titled
// with its host) and fires `did-fail-load`, but no `did-navigate`; a navigation superseded by a
// newer one is ERR_ABORTED (-3), on `loadURL`'s promise only. So the failure is reported to the
// manager (loadFailed) and `load` rejects with it, -3 excepted on both paths (checked against
// Electron 45 at runtime: a closed port gives ERR_CONNECTION_REFUSED (-102) and an empty body).
import { BrowserWindow, session as electronSession, WebContentsView, type Session } from 'electron'
import { chordOfInput, type ViewBounds } from '../overlays/overlay-manager'
import { lockDownSession, NO_APP_PAGE } from '../windows/permissions'
import { PREVIEW_SCHEME } from './preview-protocol'
import type { WebviewEvents, WebviewPage, WebviewView, WebviewViewFactory } from './webview-manager'

/** Chromium's ERR_ABORTED: a navigation superseded by a newer one (or stopped), not a failed page. */
const ERR_ABORTED = -3

/** A load error as `ERR_NAME (code)`, from loadURL's rejection or did-fail-load's arguments. */
function loadErrorText(code: unknown, errno: unknown, fallback: string): string {
  if (typeof code === 'string' && code !== '') return typeof errno === 'number' ? `${code} (${errno})` : code
  return fallback
}

export class ElectronWebviewFactory implements WebviewViewFactory {
  /** Sessions already locked down and given the cc-preview handler (a session outlives its views). */
  private readonly prepared = new WeakSet<Session>()

  constructor(
    /** Answer one cc-preview request from `partition`'s session (preview-protocol.ts + the manager's tokens). */
    private readonly servePreview: (partition: string, url: string, method: string) => Promise<Response>
  ) {}

  create(windowId: number, partition: string, events: WebviewEvents): WebviewView {
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) throw new Error('webview: the window is gone')
    // Before the view exists: the first load must already find the handler and the lock-down.
    this.prepare(electronSession.fromPartition(partition), partition)
    const view = new WebContentsView({
      webPreferences: {
        // Deliberately no `preload`.
        partition,
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
    // WebRTC ignores the CSP's connect-src (STUN/TURN): no UDP outside a proxy, so a local page
    // cannot hand what it read to a STUN server. Costs nothing; a TURN server over TCP still works,
    // which preview-protocol.ts lists among what the CSP does not stop.
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    wc.setWindowOpenHandler(({ url }) => {
      events.openWindow(url)
      return { action: 'deny' }
    })
    wc.on('render-process-gone', () => events.gone())
    wc.on('destroyed', () => events.gone())
    // Every frame's navigation (links, scripts, form posts), the main frame's included; the manager
    // decides per frame kind.
    wc.on('will-frame-navigate', (event) => {
      if (!events.allowNavigation(event.url, event.isMainFrame)) event.preventDefault()
    })
    // Server redirects (not covered by will-frame-navigate).
    wc.on('will-redirect', (event) => {
      if (!events.allowNavigation(event.url, event.isMainFrame)) event.preventDefault()
    })
    // A page's beforeunload may not block a navigate, reload or close (see the top of the file).
    wc.on('will-prevent-unload', (event) => event.preventDefault())
    wc.on('did-navigate', () => events.navigated(true))
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) events.navigated(true)
    })
    // The empty page of a failed load gets a title too (its host): not a commit.
    wc.on('page-title-updated', () => events.navigated(false))
    // Main frame only: a sub-frame's failure is the page's business. Covers reload, back, forward
    // and links, which navigate's own wait (load below) does not see.
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return
      events.loadFailed(validatedURL, loadErrorText(errorDescription, errorCode, `error ${errorCode}`))
    })
    // Keys typed into the page never reach the shell UI; app and overlay keys are resolved in main.
    wc.on('before-input-event', (event, input) => {
      if (events.chord(chordOfInput(input) ?? '')) event.preventDefault()
    })
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    win.contentView.addChildView(view)

    return {
      load: async (url: string) => {
        if (wc.isDestroyed()) return
        try {
          await wc.loadURL(url)
        } catch (err) {
          // Superseded by a newer navigate (or the view closed under it): that one has the say.
          const { code, errno } = (err ?? {}) as { code?: unknown; errno?: unknown }
          if (errno === ERR_ABORTED) return
          throw new Error(loadErrorText(code, errno, err instanceof Error ? err.message : String(err)), { cause: err })
        }
      },
      back: () => {
        if (!wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
      },
      forward: () => {
        if (!wc.isDestroyed() && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
      },
      reload: () => {
        if (!wc.isDestroyed()) wc.reload()
      },
      current: (): WebviewPage => (wc.isDestroyed() ? { url: '', title: '' } : { url: wc.getURL(), title: wc.getTitle() }),
      isFocused: () => !wc.isDestroyed() && wc.isFocused(),
      setBounds: (bounds: ViewBounds) => {
        if (!wc.isDestroyed()) view.setBounds(bounds)
      },
      setVisible: (visible: boolean) => {
        if (!wc.isDestroyed()) view.setVisible(visible)
      },
      destroy: () => {
        if (!win.isDestroyed()) win.contentView.removeChildView(view)
        // A WebContentsView's page is not closed with the view; it would live on unseen.
        if (!wc.isDestroyed()) wc.close()
      }
    }
  }

  private prepare(ses: Session, partition: string): void {
    if (this.prepared.has(ses)) return
    this.prepared.add(ses)
    // No page here is the app page: every permission, device and screen capture is refused.
    lockDownSession(ses, NO_APP_PAGE)
    ses.on('will-download', (event) => event.preventDefault())
    ses.protocol.handle(PREVIEW_SCHEME, (request) => this.servePreview(partition, request.url, request.method))
  }
}
