// Where a guest invite points (WebAccessService.inviteTarget, design-guests §4, D-29, D-35): the access links'
// origin, whether only this computer can open it, and the gateway's own certificate pin when it serves TLS.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebAccessService } from '../../src/main/web/access-service'

let dir: string
let cert: string
let key: string
let pin: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-invite-target-'))
  cert = join(dir, 'cert.pem')
  key = join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=host.example'], { stdio: 'pipe' })
  pin = createHash('sha256').update(new X509Certificate(readFileSync(cert)).raw).digest('hex')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function service(stored: Record<string, unknown>, readFile?: (path: string) => Buffer): WebAccessService {
  return new WebAccessService({
    guests: { blockingNone: () => [] },
    gateway: {
      apply: async () => ({ state: 'off' }),
      status: () => ({ state: 'off' }),
      connections: () => new Map(),
      disconnectDevice: () => 0,
      onConnectionsChanged: () => () => undefined
    },
    auth: { devices: { onChanged: () => () => undefined }, onChanged: () => () => undefined } as never,
    read: () => stored,
    write: () => undefined,
    emit: () => undefined,
    terminals: { start: () => undefined, drain: async () => undefined },
    version: '0.0.0',
    ...(readFile === undefined ? {} : { readFile })
  })
}

describe('inviteTarget', () => {
  it('a loopback bind over http: the access links\' origin, loopback only (D-35), no pin', () => {
    expect(service({ enabled: true, bind: '127.0.0.1', port: 8765 }).inviteTarget()).toEqual({ origin: 'http://127.0.0.1:8765', loopbackOnly: true })
  })

  it('TLS served by the gateway: the pin is the SHA-256 of its certificate\'s DER (D-29)', () => {
    const target = service({ enabled: true, bind: '192.168.1.5', port: 8765, tls: { certPath: cert, keyPath: key } }).inviteTarget()
    expect(target).toEqual({ origin: 'https://192.168.1.5:8765', loopbackOnly: false, certPin: pin })
  })

  it('behind an external origin: that origin, not loopback only, and no pin (a proxy\'s certificate is not the gateway\'s)', () => {
    const target = service({ enabled: true, bind: '127.0.0.1', port: 8765, externalOrigin: 'https://cockpit.example', tls: { certPath: cert, keyPath: key } }).inviteTarget()
    expect(target).toEqual({ origin: 'https://cockpit.example', loopbackOnly: false })
  })

  it('a certificate that cannot be read or parsed gives no pin', () => {
    const settings = { enabled: true, bind: '192.168.1.5', port: 8765, tls: { certPath: cert, keyPath: key } }
    expect(service(settings, () => { throw new Error('gone') }).inviteTarget()).not.toHaveProperty('certPin')
    expect(service(settings, () => Buffer.from('not a certificate')).inviteTarget()).not.toHaveProperty('certPin')
  })
})
