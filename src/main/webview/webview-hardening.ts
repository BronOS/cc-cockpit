// The hardening every webview panel's page gets, whichever adapter made it: the desktop's
// WebContentsView (electron-webview.ts) and server mode's off-screen BrowserWindow
// (electron-offscreen-webview.ts). One function per layer, so the two adapters cannot drift: a
// cancel added here reaches both, and a test of either adapter checks the same wiring
// (test/unit/electron-webview.test.ts, electron-offscreen-webview.test.ts).
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
//   would do nothing while the CLI printed `ok` (review finding). The unload always goes ahead;
// - a TLS client certificate is never presented (`select-client-certificate`, security/client-certificates.ts);
// - HTTP auth (`login`) is cancelled and a bad certificate (`certificate-error`) refused, both
//   explicitly: that is what Electron does with no listener (spike, 2026-11-11, Electron 45: the
//   401 body shows, the load fails with ERR_CERT_AUTHORITY_INVALID), pinned here so neither an
//   Electron upgrade nor an app-level listener can turn either into a prompt or a silent accept.
// Unlike an overlay, http(s) navigation stays in the view (it is a browser).
//
// A failed load: Electron has no error page. It commits an empty page at the failed URL (titled
// with its host) and fires `did-fail-load`, but no `did-navigate`; a navigation superseded by a
// newer one is ERR_ABORTED (-3), on `loadURL`'s promise only. So the failure is reported to the
// manager (loadFailed) and `load` rejects with it, -3 excepted on both paths (checked against
// Electron 45 at runtime: a closed port gives ERR_CONNECTION_REFUSED (-102) and an empty body).
//
// The crash surface under server mode's headless platform (design-web-browser.md §2, spiked
// 2026-11-11 with trusted input through sendInputEvent): only a JS dialog aborts main
// (`disableDialogs`, set by the off-screen adapter). print(), file choosers and the File System
// Access pickers do not abort, but where a desktop portal answers on the session bus (server mode
// started inside a desktop session) they open the portal's dialog on that desktop, and print()
// blocks the page's renderer until someone there answers it; cancelOffscreenNativeUi takes them
// away for off-screen views only (the desktop keeps printing and uploads). Colour and date
// pickers, context menus, drags, mailto: in a sub-frame (will-frame-navigate refuses it and the
// session denies `openExternal`), HTTP auth and certificate errors all left main alive.
import { session as electronSession, type Session, type WebContents, type WebPreferences } from 'electron'
import { refuseClientCertificatesOf } from '../security/client-certificates'
import { lockDownSession, NO_APP_PAGE } from '../windows/permissions'
import { PREVIEW_SCHEME } from './preview-protocol'
import type { WebviewEvents, WebviewPage, WebviewView } from './webview-manager'

/** Chromium's ERR_ABORTED: a navigation superseded by a newer one (or stopped), not a failed page. */
export const ERR_ABORTED = -3

/** A load error as `ERR_NAME (code)`, from loadURL's rejection or did-fail-load's arguments. */
export function loadErrorText(code: unknown, errno: unknown, fallback: string): string {
  if (typeof code === 'string' && code !== '') return typeof errno === 'number' ? `${code} (${errno})` : code
  return fallback
}

/** The webPreferences of a webview page on `partition`; an adapter only adds what is its own. */
export function webviewPreferences(partition: string): WebPreferences {
  return {
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
}

/** Answer one cc-preview request from `partition`'s session (preview-protocol.ts + the manager's tokens). */
export type ServePreview = (partition: string, url: string, method: string) => Promise<Response>

/**
 * The webview sessions, each locked down and given its cc-preview handler once (a session outlives
 * its views, and `on` adds a listener per call). One per factory: `protocol.handle` throws for a
 * scheme already handled on a session, so two factories must never prepare the same partition.
 */
export class WebviewSessions {
  private readonly prepared = new WeakSet<Session>()

  constructor(private readonly servePreview: ServePreview) {}

  /** `partition`'s session, ready before the view exists: the first load must already find the handler and the lock-down. */
  prepare(partition: string): Session {
    const ses = electronSession.fromPartition(partition)
    if (this.prepared.has(ses)) return ses
    this.prepared.add(ses)
    // No page here is the app page: every permission, device and screen capture is refused.
    lockDownSession(ses, NO_APP_PAGE)
    ses.on('will-download', (event) => event.preventDefault())
    ses.protocol.handle(PREVIEW_SCHEME, (request) => this.servePreview(partition, request.url, request.method))
    return ses
  }
}

/**
 * Wire a webview page's WebContents to the manager's decisions and install the shared cancels.
 * Everything a page can do on its own (open a window, navigate a frame, redirect, hold an unload,
 * ask for credentials, present a bad certificate, fail a load, crash) goes through here.
 * Keyboard chords are the desktop adapter's own (the off-screen view has no shell to send them to).
 */
export function hardenWebContents(wc: WebContents, events: WebviewEvents): void {
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
  // decides per frame kind. A mailto: link in a sub-frame stops here too (spike).
  wc.on('will-frame-navigate', (event) => {
    if (!events.allowNavigation(event.url, event.isMainFrame)) event.preventDefault()
  })
  // Server redirects (not covered by will-frame-navigate).
  wc.on('will-redirect', (event) => {
    if (!events.allowNavigation(event.url, event.isMainFrame)) event.preventDefault()
  })
  // A page's beforeunload may not block a navigate, reload or close (see the top of the file).
  wc.on('will-prevent-unload', (event) => event.preventDefault())
  // HTTP auth (a page, a sub-resource or a proxy): no credentials are ever given. preventDefault
  // takes the request from Electron's default, the empty callback cancels it, and the page shows
  // the server's 401 body. Without the preventDefault an app-level `login` listener would decide.
  wc.on('login', (event, _details, _authInfo, callback) => {
    event.preventDefault()
    callback()
  })
  // A certificate Chromium refused stays refused (the load fails with its ERR_CERT_* error, which
  // the manager reports like any failed load); there is no "proceed anyway".
  wc.on('certificate-error', (event, _url, _error, _certificate, callback) => {
    event.preventDefault()
    callback(false)
  })
  // A server asking for a TLS client certificate gets none: Electron's default hands it the first
  // one in the person's store, unasked. The app-wide listener does the same (index.ts); this one
  // keeps the page's hardening whole on its own (security/client-certificates.ts).
  refuseClientCertificatesOf(wc)
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
}

/** The navigation half of a WebviewView, the same for both adapters (all no-ops once the page is gone). */
export function webviewNavigation(wc: WebContents): Pick<WebviewView, 'load' | 'back' | 'forward' | 'reload' | 'current'> {
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
    current: (): WebviewPage => (wc.isDestroyed() ? { url: '', title: '' } : { url: wc.getURL(), title: wc.getTitle() })
  }
}

/**
 * The page's print() made a no-op in every document of the main frame and its same-process frames,
 * before any page script runs (`runImmediately`: also the document already there). Locked
 * (`configurable: false`), so `delete window.print` cannot bring the native one back.
 */
export const PRINT_DISABLED_SOURCE =
  "Object.defineProperty(window, 'print', { value: function print() {}, writable: false, configurable: false })"

/**
 * Off-screen views only: cancel the native UI a page can raise that nobody can answer. Spike
 * (2026-11-11, server-mode switches, a desktop portal on the session bus): print() opened
 * xdg-desktop-portal's Print dialog on the host's desktop and blocked the page's renderer until
 * it was answered (the view no longer navigated; only destroy freed it); a file input and
 * showOpenFilePicker / showSaveFilePicker / showDirectoryPicker opened the portal's file chooser
 * there. With no portal (a plain server) all of them return at once, but the session bus is the
 * service manager's, not ours to rely on. Electron 45 has no event for either, so this goes
 * through the page's DevTools protocol (main-side only, nothing the page can reach):
 * - `Page.setInterceptFileChooserDialog` with `cancel`: every chooser of the page is cancelled
 *   before it shows (a picker rejects with AbortError); it needs `Page.enable` (spike: without it
 *   the interception does not apply);
 * - PRINT_DISABLED_SOURCE in every new document. A cross-site sub-frame runs in another process
 *   the session is not attached to, so its print() is not covered (not proven either way in the
 *   spike); the worst it does there is the portal dialog and that frame's renderer blocked.
 * Commands are sent without waiting: they apply before the first load (spike), and a failure
 * (an already attached debugger) is logged, never thrown, so a view is still made.
 */
export function cancelOffscreenNativeUi(wc: WebContents, log: (message: string) => void): void {
  try {
    wc.debugger.attach('1.3')
  } catch (err) {
    log(`webview: attaching the page's protocol for its cancels failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const send = (method: string, params?: Record<string, unknown>): void => {
    wc.debugger.sendCommand(method, params).catch((err: unknown) => {
      // A view closed under the command: nothing left to cancel for.
      if (wc.isDestroyed()) return
      log(`webview: ${method} failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  send('Page.enable')
  send('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true })
  send('Page.addScriptToEvaluateOnNewDocument', { source: PRINT_DISABLED_SOURCE, runImmediately: true })
  // Detached by anything but the page closing (`target closed`, also our own destroy, while the
  // WebContents does not say destroyed yet): the cancels are off from here on, so say so. A
  // cross-site navigation swaps the renderer but keeps the attachment (checked at runtime).
  wc.debugger.on('detach', (_event, reason) => {
    if (reason !== 'target closed' && !wc.isDestroyed()) {
      log(`webview: the page's protocol detached (${reason}); its pickers and print are no longer cancelled`)
    }
  })
}
