// Which shell this page is: the Electron window (the preload's `window.cockpit`) or the web shell
// in a browser (web/main.tsx, the socket bridge; design-web.md §2). Both run the same React tree;
// the few things that belong to a native window are drawn only in the Electron one (§6.1: "Window
// controls, drag regions, full screen, update notice: not shown" in a remote view):
//  - the in-page title bar (macOS: room for the traffic lights, `-webkit-app-region: drag`);
//  - full screen (main's `window.state` is the desktop window's, never a browser tab's);
//  - the see-through background (the desktop window's glass; a browser page behind it is not the
//    desktop, and a transparent page there is just unreadable);
//  - the update notice (the host's app updates on the host, `updates.dismiss` is `no`-class).
// DOM-free (the root element is passed in) so unit tests run it in plain Node.

import { isRemoteViewId } from '../shared/views'

let webShell = false
/** The web shell's own view id, from main's `ready` (a fresh one per connection). */
let ownView: string | undefined

/** The part of the root element this sets; structural so tests can pass a fake. */
export interface ShellRoot {
  dataset: Record<string, string | undefined>
}

/**
 * Called once by the web shell's entry (web/main.tsx) before anything renders. Also stamps
 * `data-shell="web"` on the root element for the stylesheet (web.css).
 */
export function markWebShell(root?: ShellRoot): void {
  webShell = true
  if (root) root.dataset['shell'] = 'web'
}

/** Whether this page is the web shell (a remote view), not the Electron window. */
export function isWebShell(): boolean {
  return webShell
}

/** The web shell's view id, told by main in `ready` (web/main.tsx sets it before mounting the shell). */
export function setOwnView(viewId: string): void {
  ownView = viewId
}

/**
 * Whether `viewId` (TabInfo.typedBy) is this page's own view. The desktop page is its window's only
 * desktop view, and a tab belongs to one window, so any desktop id there is this page; a web page is
 * the one view main named in `ready` (two browser tabs on one device are two views).
 */
export function isOwnView(viewId: string): boolean {
  return webShell ? viewId === ownView : !isRemoteViewId(viewId)
}

/**
 * Whether this page holds a page that lives in one view of the window (design-web.md §5.4: an html
 * overlay's page, OverlayInfo.heldBy): absent names the window's desktop view, so with web access
 * off the desktop page always holds it and nothing changes.
 */
export function holdsPage(heldBy: { viewId: string } | undefined): boolean {
  return heldBy === undefined ? !webShell : isOwnView(heldBy.viewId)
}

/** Test hook: back to the Electron shell. */
export function resetShellKindForTest(): void {
  webShell = false
  ownView = undefined
}

export interface ShellChrome {
  /** The top bar is the window's title bar (macOS Electron only). */
  titleBar: boolean
  /** Honour main's full-screen state (window.info, window.state). */
  fullScreen: boolean
  /** Honour a transparent window (window.info): see-through backgrounds. */
  seeThrough: boolean
  /** Draw the update notice. */
  updateNotice: boolean
}

/** What window chrome this shell draws, from the shell kind and the platform. */
export function shellChrome(web: boolean, mac: boolean): ShellChrome {
  if (web) return { titleBar: false, fullScreen: false, seeThrough: false, updateNotice: false }
  return { titleBar: mac, fullScreen: true, seeThrough: true, updateNotice: true }
}

/** shellChrome for this page (read when called: the web entry marks the shell before rendering). */
export function currentShellChrome(): ShellChrome {
  return shellChrome(webShell, typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac'))
}
