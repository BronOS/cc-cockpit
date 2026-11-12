import { EventEmitter } from 'node:events'
import type { App, WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { refuseClientCertificates, refuseClientCertificatesOf } from '../../src/main/security/client-certificates'

// Review finding: with no `select-client-certificate` listener Electron hands a server the first
// client certificate in the person's store, unasked, so a page we load could sign in to an mTLS
// service as the person. Both listeners take the request and go on with no certificate.

interface Ev {
  defaultPrevented: boolean
  preventDefault(): void
}

function event(): Ev {
  const e: Ev = { defaultPrevented: false, preventDefault: () => void (e.defaultPrevented = true) }
  return e
}

const CERTS = [{ subjectName: 'Me' }, { subjectName: 'Me too' }]

describe('client certificates', () => {
  it('app-wide: takes the request from Electron and goes on with no certificate', () => {
    const app = new EventEmitter()
    refuseClientCertificates(app as unknown as App)
    const e = event()
    const answers: unknown[][] = []
    app.emit('select-client-certificate', e, null, 'https://mtls.example/', CERTS, (...a: unknown[]) => answers.push(a))
    expect(e.defaultPrevented).toBe(true)
    expect(answers).toEqual([[]])
  })

  it('a webview page: the same, on its own WebContents', () => {
    const wc = new EventEmitter()
    refuseClientCertificatesOf(wc as unknown as WebContents)
    const e = event()
    const answers: unknown[][] = []
    wc.emit('select-client-certificate', e, 'https://mtls.example/', CERTS, (...a: unknown[]) => answers.push(a))
    expect(e.defaultPrevented).toBe(true)
    expect(answers).toEqual([[]])
  })

  // Electron forwards a WebContents' request to `app` with the same event and callback, which may
  // be called once: the second listener to see it leaves it alone.
  it('answers a request once when both listeners see it', () => {
    const app = new EventEmitter()
    const wc = new EventEmitter()
    refuseClientCertificates(app as unknown as App)
    refuseClientCertificatesOf(wc as unknown as WebContents)
    wc.on('select-client-certificate', (ev: Ev, url: string, list: unknown[], cb: () => void) => app.emit('select-client-certificate', ev, wc, url, list, cb))
    const e = event()
    const answers: unknown[][] = []
    wc.emit('select-client-certificate', e, 'https://mtls.example/', CERTS, (...a: unknown[]) => answers.push(a))
    expect(answers).toEqual([[]])
  })
})
