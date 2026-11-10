// Where the web shell loads plugin files and inline overlays (design-web.md §5.5): main names a
// path prefix per installed plugin and one for the device's inline overlays (WebPagePaths, in
// `ready` and `paths` frames, bridge.ts), and the shared React tree keeps using the desktop's
// `cc-plugin://` / `cc-overlay://` URLs main puts in panel infos, overlay infos and settings pages.
// `shellPageUrl` turns one into the HTTP path in the web shell and leaves it alone on the desktop.
// The paths stay in the shell: a plugin page never sees them (it is a sandboxed cross-origin frame).
// DOM-free so unit tests import it.

import { webPageUrl, type WebPagePaths } from '../../shared/web-protocol'
import { isWebShell } from '../shell-kind'

let current: WebPagePaths | undefined

/** The bridge's `onPagePaths` (web/main.tsx): main's latest paths for this view. */
export function setPagePaths(paths: WebPagePaths): void {
  current = paths
}

/**
 * The URL a shell image or frame loads for a page URL main gave: unchanged in the Electron shell;
 * in the web shell the HTTP path, or undefined when this view has no path for it (an unknown
 * plugin, a scheme the browser cannot load). Callers treat undefined as a failed load.
 */
export function shellPageUrl(src: string): string | undefined {
  return isWebShell() ? webPageUrl(src, current) : src
}

/** Test hook. */
export function resetPagePathsForTest(): void {
  current = undefined
}
