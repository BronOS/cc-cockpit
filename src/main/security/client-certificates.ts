// TLS client certificates: the app never presents one. With no `select-client-certificate`
// listener Electron answers a server's certificate request with the first certificate in the
// person's store, with no prompt (review finding), so any page we load (a webview panel, a url
// overlay, a plugin page, a remote server's page in a remote window) could authenticate to an mTLS
// service as the person, and a utility process's `net` request too. Nothing of the app's own needs
// one, so every request goes on without a certificate: the server then refuses the handshake or
// carries on anonymously, as a browser whose person picked "none" would.
//
// Two layers, each answering only when the other has not (Electron 45 forwards a WebContents'
// event to `app`'s, both listeners run on the same event, and the callback must be called once):
// - refuseClientCertificates on `app`, registered at start (index.ts), for every WebContents and
//   the utility processes;
// - refuseClientCertificatesOf on a webview page's WebContents (webview-hardening.ts), so the
//   hardening of the pages that are anything on the web does not rest on the app-wide listener.
//
// No Electron import but its types: unit tests pass an EventEmitter.

import type { App, Event, WebContents } from 'electron'

/** One answer per request: none if another listener already took it, else no certificate. */
function refuse(event: Event, callback: () => void): void {
  if (event.defaultPrevented) return
  // preventDefault takes the request from Electron's default (the first certificate); the empty
  // callback goes on without one.
  event.preventDefault()
  callback()
}

/** The app-wide listener (index.ts, at start). */
export function refuseClientCertificates(app: Pick<App, 'on'>): void {
  app.on('select-client-certificate', (event, _webContents, _url, _list, callback) => refuse(event, () => callback()))
}

/** One WebContents' listener (webview-hardening.ts hardenWebContents). */
export function refuseClientCertificatesOf(wc: Pick<WebContents, 'on'>): void {
  // Typed as taking a certificate; called with none, which Electron reads as "go on without one".
  wc.on('select-client-certificate', (event, _url, _list, callback) => refuse(event, () => (callback as () => void)()))
}
