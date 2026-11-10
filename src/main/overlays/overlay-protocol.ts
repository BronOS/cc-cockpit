// Electron adapter: serves html overlay pages at `cc-overlay://<overlayId>/` from main's memory.
// Thin on purpose (covered by e2e); which page a URL names is OverlayManager.pageHtml.
//
// Why a scheme at all: the page must run its own script, and a data: URL or srcdoc frame
// inherits the shell page's CSP (`script-src 'self'`), which blocks it. A page from its own scheme
// gets only the CSP sent with it (OVERLAY_PAGE_CSP), and the shell's `frame-src cc-overlay:` lets
// nothing else be framed. The iframe is sandboxed without allow-same-origin, so the page runs in
// an opaque origin whatever the scheme.
//
// `ccc overlay --html F` (Task 21) uses this same scheme and handler instead of a second one of
// its own: Electron takes one `registerSchemesAsPrivileged` list and one handler per scheme. The
// one-shot semantics the plan asks for are the ones every html overlay already has: the host is a
// random 128-bit id (a UUID) known only to main and the owning window, it maps to that one page
// (the file's content, read once by socket/handlers.ts), only `/` is served (no relative
// resources: any other path is a 404), the CSP is OVERLAY_PAGE_CSP (the plan's, plus no fonts or
// forms), and the mapping goes when the overlay closes. The page answers through the MessagePort.
//
// A remote view (web access, design-web.md §5.5) gets the same page over HTTP instead, from
// web/plugin-pages.ts under `/o/<token>/<id>/` (OverlayManager.inlinePage, overlayPageHeaders plus
// the sandbox a browser needs); this handler stays the desktop's.
//
// This file is also the Electron adapter of the plugin scheme (`cc-plugin://`, Task 28): both
// schemes must be registered in the same call (below), and the plugin handler is as thin as this
// one (what it serves is plugins/plugin-protocol.ts).
import { protocol } from 'electron'
import { PLUGIN_SCHEME } from '../plugins/plugin-protocol'
import { PREVIEW_SCHEME } from '../webview/preview-protocol'
import { OVERLAY_SCHEME, overlayPageHeaders } from './overlay-manager'

/**
 * Must run before `ready`. Electron takes ONE `registerSchemesAsPrivileged` call per app (a later
 * call replaces the earlier list), so every app scheme is in this one list.
 * - cc-overlay: `standard` gives the URL a host (the overlay id); nothing else is granted: no
 *   fetch API, no CORS, no CSP bypass, no service workers.
 * - cc-plugin: `standard` (a host per plugin, relative URLs resolve inside it), `secure` (a
 *   secure context, like https), `supportFetchAPI` and `corsEnabled`, so a panel in a sandboxed
 *   iframe (an opaque origin) can load its own scripts and `fetch` its own files. No CSP bypass,
 *   no service workers, no stream privilege.
 * - cc-preview (webview panels' local files, plan B Task 7): `standard` (the token is the host, so
 *   a page's relative css/img URLs resolve inside its folder), `secure` (a secure context like
 *   https, so a mock-up's modern APIs work) and `supportFetchAPI` (a page may fetch its own JSON;
 *   its CSP keeps that to its own token). No `corsEnabled`: no other origin may read it. Its
 *   handler is registered per webview session (electron-webview.ts), not with protocol.handle.
 */
export function registerAppSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: OVERLAY_SCHEME, privileges: { standard: true } },
    {
      scheme: PLUGIN_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    },
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/** After `ready`: answer every `cc-plugin:` request through `serve` (plugin-protocol.ts). */
export function handlePluginScheme(serve: (url: string, method: string) => Promise<Response>): void {
  protocol.handle(PLUGIN_SCHEME, (request) => serve(request.url, request.method))
}

/** After `ready`: answer `cc-overlay://<id>/` with that open overlay's page, else 404. */
export function handleOverlayScheme(pageHtml: (url: string) => string | undefined): void {
  protocol.handle(OVERLAY_SCHEME, (request) => {
    const html = request.method === 'GET' ? pageHtml(request.url) : undefined
    if (html === undefined) return new Response('not found', { status: 404 })
    return new Response(html, { headers: overlayPageHeaders() })
  })
}
