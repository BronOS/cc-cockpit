// The certificate a Direct guest link's server presents (main/remote/peer-certificate.ts, D-29): read over a
// real TLS handshake to a throwaway self-signed server (openssl, as the gateway's TLS tests), hashed as the
// invite's `c=` pin is; unreadable, http and junk origins answer undefined.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer, type Server } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { peerCertificateSha256 } from '../../src/main/remote/peer-certificate'

let dir: string
let server: Server
let port: number
let expected: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-peer-cert-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'pipe' })
  const pem = readFileSync(cert)
  expected = createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
  server = createTlsServer({ key: readFileSync(key), cert: pem }, (socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

describe('peerCertificateSha256', () => {
  it('hashes the DER of the certificate the server presents, self-signed included', async () => {
    expect(await peerCertificateSha256(`https://127.0.0.1:${port}`)).toBe(expected)
  })

  it('answers undefined for http, junk, a closed port and a server that never speaks TLS', async () => {
    expect(await peerCertificateSha256(`http://127.0.0.1:${port}`)).toBeUndefined()
    expect(await peerCertificateSha256('not a url')).toBeUndefined()
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const closed = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    expect(await peerCertificateSha256(`https://127.0.0.1:${closed}`)).toBeUndefined()
    // Accepts and never answers: the handshake waits until the timeout. Its sockets are destroyed at the end
    // (server.close waits for open connections).
    const held: import('node:net').Socket[] = []
    const silent = createServer((s) => void held.push(s))
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
    const silentPort = (silent.address() as AddressInfo).port
    expect(await peerCertificateSha256(`https://127.0.0.1:${silentPort}`, 200)).toBeUndefined()
    for (const s of held) s.destroy()
    await new Promise<void>((resolve) => silent.close(() => resolve()))
  })
})
