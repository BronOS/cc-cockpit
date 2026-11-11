// A link clicked inside the bundled reviewer's Original view of a mail (plugins/reviewer/src/page/original.mjs) opens
// in the system browser, and no other window-open request of a shell window does anything. Kept apart from
// create-window.ts, which imports Electron, so vitest pins the rule (test/unit/mail-frame-links.test.ts).
//
// Why main and not the page: the mail is shown in `<iframe sandbox="allow-popups">` with no script, so nothing in it
// can tell the reviewer page which link was clicked, and the page may not look inside (no allow-same-origin). Each
// link there has `target="_blank"`, so a click asks Chromium for a popup, which reaches the window's
// setWindowOpenHandler: the one place that sees the click. The window is ALWAYS denied (no BrowserWindow is ever
// made, the frame never navigates); only the URL goes on, to the same checks as a plugin's ctx.openExternal.
//
// Chromium lets a frame open a popup only with transient user activation (a real click or Enter on the link, about
// 5 s), so no click means no request at all; a mail has no script to ask without one anyway.
import { checkWebUrl, MAX_PLUGIN_URL_LENGTH } from '../../shared/web-url'
import { EXTERNAL_OPEN_WINDOW_MS, MAX_EXTERNAL_OPENS_PER_WINDOW, RateWindow } from '../plugins/host-api'
import { warnLog } from '../warn-log'

/** The part of Electron's WebFrameMain this rule reads (a fake in the unit test). */
export interface FrameLike {
  readonly url: string
  readonly parent: FrameLike | null
}

/** The reviewer's overlay page: an id under `cockpit.` loads only from the bundled root (isReservedPluginId). */
const REVIEWER_HOST = 'cockpit.reviewer'
const REVIEWER_PAGE_PATH = '/overlay/review.html'

/**
 * True when `frame` is a mail frame of the reviewer's Original view: an `about:srcdoc` document whose parent is the
 * bundled reviewer's overlay page (`cc-plugin://cockpit.reviewer/overlay/review.html`), itself a direct child of the
 * shell page (the main frame). Electron's window-open details carry no frame and, from a `cc-plugin:` page, no
 * referrer (both checked in Electron 45), so the frame is the window's FOCUSED one: a click on a link moves the focus
 * into its frame before the popup is asked for, Enter on a link needs the focus there. Another plugin's page, its
 * own srcdoc frames, the reviewer page itself and an inline `cc-overlay:` page never match (their url or parent
 * differ), and their requests are denied as before. A frame that went away while being read throws in Electron:
 * that is no match.
 */
export function isReviewerMailFrame(frame: FrameLike | null | undefined): boolean {
  try {
    if (!frame || frame.url !== 'about:srcdoc') return false
    const page = frame.parent
    if (!page) return false
    const shell = page.parent
    // The shell page is the main frame (no parent): a reviewer page nested any deeper is not the overlay.
    if (!shell || shell.parent !== null) return false
    const u = new URL(page.url)
    return u.protocol === 'cc-plugin:' && u.hostname === REVIEWER_HOST && u.pathname === REVIEWER_PAGE_PATH
  } catch {
    return false
  }
}

export interface WindowOpenDeps {
  /**
   * The system browser (shell.openExternal through a lambda, looked up at each call, so the e2e recorder that
   * replaces it is seen). Given only a URL checkWebUrl passed.
   */
  openExternal(url: string): Promise<void> | void
  log?(message: string): void
}

/** What Electron's setWindowOpenHandler gets that this rule reads. */
export interface WindowOpenRequest {
  url: string
}

/**
 * The window-open handler of one shell window (create-window.ts): `focused` is that window's
 * `webContents.focusedFrame` at the time of the request. Always `{ action: 'deny' }`. A request of the reviewer's
 * mail frame also hands its URL to the system browser after the checks of ctx.openExternal (host-api.ts): checkWebUrl
 * with the plugin rules (http and https only, so `javascript:` (which reaches here as `about:blank`), `file:`,
 * `data:`, `mailto:` and app schemes are refused, as the reviewer's own Links list refuses mailto; no user:pass@;
 * MAX_PLUGIN_URL_LENGTH) and the same budget, 3 links in 10 s per window: a page that somehow asked in a loop would
 * flood the person's browser, the most intrusive thing a link can do.
 */
export function windowOpenHandler(deps: WindowOpenDeps): (request: WindowOpenRequest, focused: FrameLike | null) => { action: 'deny' } {
  const budget = new RateWindow(MAX_EXTERNAL_OPENS_PER_WINDOW, EXTERNAL_OPEN_WINDOW_MS)
  const log = deps.log ?? warnLog
  return (request, focused) => {
    if (!isReviewerMailFrame(focused)) return { action: 'deny' }
    let href: string
    try {
      href = checkWebUrl(request.url, { method: 'mail link', maxLength: MAX_PLUGIN_URL_LENGTH, noUserinfo: true })
    } catch (err) {
      // A refused URL spends no budget, as in ctx.openExternal.
      log(err instanceof Error ? err.message : String(err))
      return { action: 'deny' }
    }
    if (!budget.take(REVIEWER_HOST)) {
      log(`mail link: more than ${MAX_EXTERNAL_OPENS_PER_WINDOW} links in ${EXTERNAL_OPEN_WINDOW_MS / 1000} s; not opened`)
      return { action: 'deny' }
    }
    // Through a promise: a synchronous throw or a rejection of the OS call must not escape Electron's handler.
    Promise.resolve()
      .then(() => deps.openExternal(href))
      .catch((err: unknown) => log(`mail link: open external failed: ${err instanceof Error ? err.message : String(err)}`))
    return { action: 'deny' }
  }
}
