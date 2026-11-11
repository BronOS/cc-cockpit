// Every link main opens outside the app goes through here (design-web.md §6.1, §9 "shell.openExternal"):
// ctx.openExternal, `app.openExternal`, the update notice, plugin OAuth, the webview manager's
// window.open, the reviewer's mail links (the window-open handler) and URL overlay views. One place
// decides where a link may go, so a call site cannot open the host's browser for a person who is not
// in front of the host:
// - on the desktop, a browser view's call gets a clickable notice in that view (`app.linkNotice`; a
//   page cannot open a tab without a click), and everything else the OS browser, as before;
// - in server mode, never the OS browser (there is no screen, and Electron's opener has no session
//   bus): a notice to the asking browser view, or to every browser view of the window when no browser
//   view asked (a timer, the hidden page, a sign-in a plugin started on its own), or of every window
//   for a call tied to none. With no browser reached the link is refused with a log line.
//
// The target is always main's: the router's bound caller, the plugin host's own window and origin
// view, the window a view or overlay belongs to. Never a window or view id read from a payload.
//
// No Electron import: the OS opener is passed in (electron-open-external.ts, looked up at each call
// so the e2e recorder that replaces `shell.openExternal` is seen); unit tests pass recorders.

import { isRemoteViewId, type ViewId } from '../../shared/views'
import { warnLog } from '../warn-log'

/**
 * Who a link is for: a window, and the view of it that asked when main knows one (a browser view, or
 * the desktop view), or `'app'` for a call tied to no window.
 */
export type OpenTarget = { windowId: number; viewId?: ViewId } | 'app'

/** Opens `url` (already checked http(s)) for `target`; rejects when it was refused. */
export type OpenExternal = (url: string, target: OpenTarget) => Promise<void>

/** The ViewRegistry methods the adapter uses (a fake in unit tests). */
export interface LinkViews {
  toView(viewId: ViewId, channel: 'app.linkNotice', payload: { url: string }): boolean
  toBrowserViews(windowId: number | 'all', channel: 'app.linkNotice', payload: { url: string }): number
}

export interface OpenExternalOptions {
  /** Main's server flag (index.ts): fixed for the run. */
  server: boolean
  /** The OS browser (electron-open-external.ts). Never called in server mode. */
  system(url: string): Promise<void>
  views: LinkViews
  log?: (message: string) => void
}

/** The refusal's text: the same for every reason, and never the URL (an OAuth URL carries its `state`). */
export const NO_BROWSER_TEXT = 'no browser is connected to show the link in'

/**
 * `url` for a log line: scheme, host and path only. The query and fragment go (an OAuth auth URL has
 * its `state` and challenge there, a link may carry a token), and so does any userinfo.
 */
export function urlForLog(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '(not a URL)'
  }
}

export function createOpenExternal(options: OpenExternalOptions): OpenExternal {
  const log = options.log ?? warnLog
  return async (url, target) => {
    const asking = target !== 'app' && target.viewId !== undefined && isRemoteViewId(target.viewId) ? target.viewId : undefined
    if (!options.server) {
      // v1 (design-web.md §6.1): the host's browser is not a browser view's screen. A view that is gone
      // by now gets nothing, as before: its person left.
      if (asking !== undefined) {
        options.views.toView(asking, 'app.linkNotice', { url })
        return
      }
      await options.system(url)
      return
    }
    // Server mode. Only the asking view when a browser asked: another device of the person may be on
    // the same window, and a link it did not ask for would open there at once (a click's activation).
    // Its view gone means its person left; the link is refused rather than sent to another screen.
    let reached: number
    if (asking !== undefined) reached = options.views.toView(asking, 'app.linkNotice', { url }) ? 1 : 0
    else reached = options.views.toBrowserViews(target === 'app' ? 'all' : target.windowId, 'app.linkNotice', { url })
    if (reached > 0) return
    log(`open external: ${NO_BROWSER_TEXT}; not opened: ${urlForLog(url)}`)
    throw new Error(NO_BROWSER_TEXT)
  }
}
