// Electron adapter for webview panels: creates their WebContentsView (the only WebContentsView
// code besides electron-url-view.ts). Thin on purpose (covered by e2e from Task 8, and by
// test/unit/electron-webview.test.ts with `electron` stubbed for the hardening); every decision
// (which navigation may go ahead, which tokens a session serves, where window.open goes) is
// webview-manager.ts's.
//
// The page's hardening (preferences, session lock-down, cc-preview on its own session, the
// navigation hooks and the cancels) is webview-hardening.ts's, shared with server mode's
// off-screen adapter (electron-offscreen-webview.ts); what stays here is the desktop's own: the
// view placed in the project window, and key chords typed into the page sent to main.
import { BrowserWindow, WebContentsView } from 'electron'
import { chordOfInput, type ViewBounds } from '../overlays/overlay-manager'
import { hardenWebContents, webviewNavigation, webviewPreferences, WebviewSessions, type ServePreview } from './webview-hardening'
import type { WebviewEvents, WebviewView, WebviewViewFactory } from './webview-manager'

export class ElectronWebviewFactory implements WebviewViewFactory {
  private readonly sessions: WebviewSessions

  constructor(
    /** Answer one cc-preview request from `partition`'s session (preview-protocol.ts + the manager's tokens). */
    servePreview: ServePreview
  ) {
    this.sessions = new WebviewSessions(servePreview)
  }

  create(windowId: number, partition: string, events: WebviewEvents): WebviewView {
    const win = BrowserWindow.fromId(windowId)
    if (!win || win.isDestroyed()) throw new Error('webview: the window is gone')
    this.sessions.prepare(partition)
    const view = new WebContentsView({ webPreferences: webviewPreferences(partition) })
    const wc = view.webContents
    hardenWebContents(wc, events)
    // Keys typed into the page never reach the shell UI; app and overlay keys are resolved in main.
    wc.on('before-input-event', (event, input) => {
      if (events.chord(chordOfInput(input) ?? '')) event.preventDefault()
    })
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    view.setVisible(false)
    win.contentView.addChildView(view)

    return {
      ...webviewNavigation(wc),
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
}
