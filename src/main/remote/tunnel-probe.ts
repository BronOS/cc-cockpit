// My own tunnel's probe (design-remote-desktop.md §6): before every load main makes of a tunnel
// server's page (open, reload, a sign-in with a pasted link; the page's own reconnects are not
// covered), main asks `GET /auth/session` on `127.0.0.1:<localPort>` itself, so the device cookie
// only goes where a cc-cockpit gateway answers, and a tunnel that is not up yet shows the command to
// start it instead of Chromium's error page.
//
// The request is Node's `http` with no cookie (none is ever attached here), no redirect followed
// (Node's `http` follows none), the body capped at PROBE_MAX_BYTES and the whole exchange at
// PROBE_TIMEOUT_MS. What the answer means:
//  - nothing listens, the connection resets (the person's ssh accepts locally, then the server side
//    refuses the channel) or no answer in time: `nothing`, and the window waits with the command;
//  - 200 with the gateway's session reply (`sessionReplyOf`): `cockpit`, load;
//  - 403 `unknown host`: a gateway whose Host check takes only its own port, so a cockpit older than
//    the "loopback on any port" change (§5.7), or one not in server mode: `old`;
//  - anything else: `other`, never loaded (the cookie is not sent to it).
// What it cannot tell: a local process that imitates the reply (§6 "What the app cannot check").
import { request as httpRequest } from 'node:http'
import { tunnelCommand, type RemoteServerRecord, type RemoteVia } from '../../shared/remote-servers'
import { SESSION_PATH } from '../../shared/web-protocol'
import { sessionReplyOf } from './remote-windows'

export const PROBE_TIMEOUT_MS = 2000
export const PROBE_MAX_BYTES = 16 * 1024
/** A waiting window probes again this often while it is open (RemoteWindows). */
export const TUNNEL_RETRY_MS = 3000

export type TunnelProbeResult = 'cockpit' | 'nothing' | 'other' | 'old'

/** The gateway's refusal of a Host it does not list (gateway.ts `request`). */
const UNKNOWN_HOST_BODY = 'unknown host'

/** One probe of `127.0.0.1:<port>`; never rejects. `timeoutMs` is a test seam. */
export function probeTunnel(port: number, options: { timeoutMs?: number } = {}): Promise<TunnelProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: TunnelProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      resolve(result)
    }
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: SESSION_PATH,
        method: 'GET',
        // A fresh connection (no pooled socket from an earlier probe) and only these headers: no cookie.
        agent: false,
        headers: { Host: `127.0.0.1:${port}`, Accept: 'application/json' }
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > PROBE_MAX_BYTES) return finish('other')
          chunks.push(chunk)
        })
        res.on('error', () => finish('nothing'))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          const status = res.statusCode ?? 0
          if (status === 403 && body.trim() === UNKNOWN_HOST_BODY) return finish('old')
          if (status !== 200) return finish('other')
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            return finish('other')
          }
          finish(sessionReplyOf(parsed) === undefined ? 'other' : 'cockpit')
        })
      }
    )
    // Refused, reset, or a tunnel whose far end is not there yet: wait for it.
    req.on('error', () => finish('nothing'))
    const timer = setTimeout(() => finish('nothing'), timeoutMs)
    req.end()
  })
}

type TunnelVia = Extract<RemoteVia, { kind: 'tunnel' }>

/** The waiting page's text: what is missing and the command that starts the tunnel. */
export function tunnelWaitingText(via: TunnelVia): string {
  return [
    `Nothing answers on 127.0.0.1:${via.localPort}. Start the tunnel:`,
    '',
    `    ${tunnelCommand(via)}`,
    '',
    `This window tries again every ${TUNNEL_RETRY_MS / 1000} seconds.`
  ].join('\n')
}

/** Why a probe result refuses the load, or undefined when it does not (`cockpit`, `nothing`). */
export function tunnelProbeError(via: TunnelVia, result: TunnelProbeResult): string | undefined {
  if (result === 'other') {
    return `Something else is listening on 127.0.0.1:${via.localPort}: it did not answer as a cc-cockpit server, so nothing was sent to it. Check the local port of the tunnel.`
  }
  if (result === 'old') {
    return `The server at the end of the tunnel on 127.0.0.1:${via.localPort} refused that address: update cc-cockpit on the server (and run it in server mode).`
  }
  return undefined
}

/** What RemoteWindows does before a main-made load: go ahead, wait with this text, or show this error. */
export type LoadGate = { go: true } | { wait: string } | { error: string }

/** The gate of a server's loads: My own tunnel probes first; every other kind goes ahead. */
export function tunnelGate(probe: (port: number) => Promise<TunnelProbeResult>): (server: RemoteServerRecord) => Promise<LoadGate> {
  return async (server) => {
    if (server.via.kind !== 'tunnel') return { go: true }
    const via = server.via
    const result = await probe(via.localPort)
    if (result === 'cockpit') return { go: true }
    if (result === 'nothing') return { wait: tunnelWaitingText(via) }
    return { error: tunnelProbeError(via, result) ?? 'the tunnel did not answer as expected' }
  }
}
