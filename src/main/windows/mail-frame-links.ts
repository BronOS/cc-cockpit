// A link clicked inside a mail frame of a plugin's html overlay (an `about:srcdoc` child of the overlay page, such as
// the Original view of a mail: plugins/reviewer/src/page/original.mjs, the kit's Original frame) opens in the system
// browser, and no other window-open request of a shell window does anything. Kept apart from create-window.ts, which
// imports Electron, so vitest pins the rule (test/unit/mail-frame-links.test.ts).
//
// Why main and not the page: the mail is shown in `<iframe sandbox="allow-popups">` with no script, so nothing in it
// can tell the overlay page which link was clicked, and the page may not look inside (no allow-same-origin). Each
// link there has `target="_blank"`, so a click asks Chromium for a popup, which reaches the window's
// setWindowOpenHandler: the one place that sees the click. The window is ALWAYS denied (no BrowserWindow is ever
// made, the frame never navigates); only the URL goes on, to the same checks as a plugin's ctx.openExternal.
//
// Chromium lets a frame open a popup only with transient user activation (a real click or Enter on the link, about
// 5 s), so no click means no request at all; a mail has no script to ask without one anyway.
//
// Any plugin's overlay page, not only the Reviewer's (shared/design.md §7, spec-review S9): each plugin draws its own
// documents now. That grants a plugin nothing it did not have: its srcdoc child could run the plugin's own script
// (srcdoc inherits the page's CSP, `script-src 'self'`) and ask for any URL on a click, which is what ctx.openExternal
// already does from its host, with no ask and the same checks. Only plugin overlays get `allow-popups` at all
// (PluginFrame.tsx: panels, slots and page tabs are `allow-scripts` alone, so their frames never ask); the overlay
// check below is main's own record, not that sandbox.
import { checkWebUrl, MAX_PLUGIN_URL_LENGTH } from '../../shared/web-url'
import { EXTERNAL_OPEN_WINDOW_MS, MAX_EXTERNAL_OPENS_PER_WINDOW } from '../plugins/host-api'
import { RateWindow } from '../rate-window'
import { warnLog } from '../warn-log'

/** The part of Electron's WebFrameMain this rule reads (a fake in the unit test). */
export interface FrameLike {
  readonly url: string
  readonly parent: FrameLike | null
}

/**
 * Whether a URL is the page of an open html overlay a plugin opened in this window (OverlayManager.isOverlayPage,
 * bound to the window by create-window.ts). Main's own record, read at the request.
 */
export type OverlayPageCheck = (url: string) => boolean

/**
 * The plugin whose overlay page holds `frame` as a mail frame, or undefined: `frame` is an `about:srcdoc` document
 * whose parent is a plugin's open html overlay page (`cc-plugin://<plugin>/...`, `isOverlayPage`), itself a direct
 * child of the shell page (the main frame). Electron's window-open details carry no frame and, from a `cc-plugin:`
 * page, no referrer (both checked in Electron 45), so the frame is the window's FOCUSED one: a click on a link moves
 * the focus into its frame before the popup is asked for, Enter on a link needs the focus there.
 *
 * Never a match: a panel's, slot's or page tab's srcdoc child (their page is no open overlay's), the overlay page
 * itself, a srcdoc nested deeper, an overlay page nested under another frame, an inline `cc-overlay:` page. Fail
 * closed: no check wired, a check that throws, a parent URL that cannot be read or parsed, and a frame that went away
 * while being read (Electron throws) are no match.
 */
export function overlayMailFramePlugin(frame: FrameLike | null | undefined, isOverlayPage: OverlayPageCheck | undefined): string | undefined {
  try {
    if (!isOverlayPage || !frame || frame.url !== 'about:srcdoc') return undefined
    const page = frame.parent
    if (!page) return undefined
    const shell = page.parent
    // The shell page is the main frame (no parent): an overlay page nested any deeper is not the overlay.
    if (!shell || shell.parent !== null) return undefined
    const url = page.url
    if (typeof url !== 'string') return undefined
    const u = new URL(url)
    if (u.protocol !== 'cc-plugin:' || u.hostname === '') return undefined
    return isOverlayPage(url) === true ? u.hostname : undefined
  } catch {
    return undefined
  }
}

export interface WindowOpenDeps {
  /**
   * The system browser (shell.openExternal through a lambda, looked up at each call, so the e2e recorder that
   * replaces it is seen). Given only a URL checkWebUrl passed.
   */
  openExternal(url: string): Promise<void> | void
  /** This window's overlay pages (OverlayManager.isOverlayPage). Absent: no frame matches, every request is denied. */
  isOverlayPage?: OverlayPageCheck
  log?(message: string): void
}

/** What Electron's setWindowOpenHandler gets that this rule reads. */
export interface WindowOpenRequest {
  url: string
}

/**
 * The window-open handler of one shell window (create-window.ts): `focused` is that window's
 * `webContents.focusedFrame` at the time of the request. Always `{ action: 'deny' }`. A request of a plugin overlay's
 * mail frame also hands its URL to the system browser after the checks of ctx.openExternal (host-api.ts): checkWebUrl
 * with the plugin rules (http and https only, so `javascript:` (which reaches here as `about:blank`), `file:`,
 * `data:`, `mailto:` and app schemes are refused, as the reviewer's own Links list refuses mailto; no user:pass@;
 * MAX_PLUGIN_URL_LENGTH) and a budget of 3 links in 10 s per window and plugin (the overlay page's hostname), its
 * own, apart from ctx.openExternal's: a page that somehow asked in a loop would flood the person's browser, the most
 * intrusive thing a link can do, and one plugin's loop must not use up another's clicks.
 */
export function windowOpenHandler(deps: WindowOpenDeps): (request: WindowOpenRequest, focused: FrameLike | null) => { action: 'deny' } {
  const budget = new RateWindow(MAX_EXTERNAL_OPENS_PER_WINDOW, EXTERNAL_OPEN_WINDOW_MS)
  const log = deps.log ?? warnLog
  return (request, focused) => {
    const plugin = overlayMailFramePlugin(focused, deps.isOverlayPage)
    if (plugin === undefined) return { action: 'deny' }
    let href: string
    try {
      href = checkWebUrl(request.url, { method: 'mail link', maxLength: MAX_PLUGIN_URL_LENGTH, noUserinfo: true })
    } catch (err) {
      // A refused URL spends no budget, as in ctx.openExternal.
      log(err instanceof Error ? err.message : String(err))
      return { action: 'deny' }
    }
    if (!budget.take(plugin)) {
      log(`mail link (${plugin}): more than ${MAX_EXTERNAL_OPENS_PER_WINDOW} links in ${EXTERNAL_OPEN_WINDOW_MS / 1000} s; not opened`)
      return { action: 'deny' }
    }
    // Through a promise: a synchronous throw or a rejection of the OS call must not escape Electron's handler.
    Promise.resolve()
      .then(() => deps.openExternal(href))
      .catch((err: unknown) => log(`mail link: open external failed: ${err instanceof Error ? err.message : String(err)}`))
    return { action: 'deny' }
  }
}
