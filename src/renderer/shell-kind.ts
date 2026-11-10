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

let webShell = false

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

/** Test hook: back to the Electron shell. */
export function resetShellKindForTest(): void {
  webShell = false
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
