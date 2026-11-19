// The certificate a Direct guest link's server presents (design-guests §11, D-29), read by main itself before
// the person is asked to trust it: a TLS handshake to the link's origin that reads the peer certificate and
// sends nothing (no HTTP request, no cookie, no token). The answer the picker sends back
// (`RemoteAnswers.certificate`) is the page's word; main trusts it only when it equals both the invite's
// `c=` pin and this SHA-256 (RemoteService.connect).
//
// `rejectUnauthorized: false` on purpose: a self-signed certificate is exactly what a pin is for, and the
// handshake's only product is the certificate's hash; whether it is trusted is decided by comparing that
// hash, never by this socket. No `child_process` (main/remote's grep rule): node:tls only.
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { connect } from 'node:tls'

/** How long the handshake may take before the connect is told the certificate could not be read. */
export const PEER_CERT_TIMEOUT_MS = 10_000

/** Lowercase hex SHA-256 of the DER certificate an https origin presents now; undefined when it cannot be read. */
export function peerCertificateSha256(origin: string, timeoutMs = PEER_CERT_TIMEOUT_MS): Promise<string | undefined> {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return Promise.resolve(undefined)
  }
  if (url.protocol !== 'https:') return Promise.resolve(undefined)
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
  const port = url.port === '' ? 443 : Number(url.port)
  return new Promise((resolve) => {
    let done = false
    // SNI only for a name (an IP literal is not one, RFC 6066).
    const socket = connect({ host, port, rejectUnauthorized: false, ...(isIP(host) === 0 ? { servername: host } : {}) }, () => {
      const cert = socket.getPeerCertificate()
      finish(cert !== undefined && Buffer.isBuffer(cert.raw) && cert.raw.length > 0 ? createHash('sha256').update(cert.raw).digest('hex') : undefined)
    })
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    function finish(value: string | undefined): void {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    socket.on('error', () => finish(undefined))
  })
}
