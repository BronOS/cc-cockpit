// `ccc web` (design-web.md §9.4): web access from a shell on the server, as socket handlers. Part 1
// (server-mode plan Task 11): `status`, `revoke` and `stop`. `link`, `add-device`, `password`,
// `mode` and `set` come in Task 12; their names are already in HOST_ONLY_COMMANDS.
//
// Authority, twice over:
//   - Host-only. The socket server refuses any token for a HOST_ONLY_COMMANDS request before a
//     handler is looked up (socket-server.ts `identify`), and every handler here refuses any caller
//     kind but the tokenless, projectless one again (`hostOnly`), as the session-only handlers
//     refuse a window token again: a handler reached some other way (registered under a name the
//     list lacks, which SocketServer.handle refuses, or a later change to identify) still answers a
//     Claude tab with nothing. Not a boundary (protocol.ts says why it is there anyway).
//   - Narrowing on the desktop. Outside server mode only `status` and `revoke` are answered: anything
//     else would let any process of the user (a plugin with exec, a remote view's shell) change who
//     gets in with nobody asked, where on the desktop that takes a click on the person's screen.
//     Decided by main's `server` flag for the run, never by anything in the request.
//
// No Electron import: main passes the parts in, unit tests pass fakes.
import { HOST_ONLY_COMMANDS, HOST_ONLY_TEXT } from '../../shared/protocol'
import type { WebCliRevokeResult, WebCliStatus } from '../../shared/web-access'
import type { Caller, Handler } from './socket-server'

/** What a desktop run answers every `ccc web` subcommand but `status` and `revoke` with. */
export const DESKTOP_REFUSAL = 'use Settings › Web access'

/** What `web.revoke` writes to `web-access.log` as the reason. */
export const SHELL_REVOKE_REASON = 'revoked from the server shell (ccc web revoke)'

/** Longest device id `web.revoke` takes (a real one is 16 characters: 12 random bytes, base64url). */
const MAX_DEVICE_ID = 64

export interface WebHandlerDeps {
  /** Main's `server` flag for the run (server-mode.ts). */
  server: boolean
  /** The status as WebAccessService.cliStatus builds it, with this run's secret store. */
  status(): WebCliStatus | Promise<WebCliStatus>
  /** Revokes one device by id; false when there is none. */
  revoke(id: string): boolean
  /** Revokes every device; how many. */
  revokeAll(): number
  /**
   * Quits as SIGTERM does (main sends itself the signal, after the reply has gone out): the same
   * shutdown path as systemd's stop, so the browsers are told it is a server stop and retry.
   */
  stop(): void
}

/** The tokenless, projectless caller only (a shell outside the app); everything else gets HOST_ONLY_TEXT. */
function hostOnly(caller: Caller): void {
  if (caller.kind !== 'anonymous') throw new Error(HOST_ONLY_TEXT)
}

function serverOnly(deps: Pick<WebHandlerDeps, 'server'>): void {
  if (!deps.server) throw new Error(DESKTOP_REFUSAL)
}

export function webStatusHandler(deps: Pick<WebHandlerDeps, 'status'>): Handler {
  return (_args, caller) => {
    hostOnly(caller)
    return deps.status()
  }
}

/** `{ id }` revokes that device, `{ all: true }` every one; exactly one of the two. */
export function webRevokeHandler(deps: Pick<WebHandlerDeps, 'revoke' | 'revokeAll'>): Handler {
  return (args, caller): WebCliRevokeResult => {
    hostOnly(caller)
    const all = args.all === true
    const id = args.id
    if (all === (id !== undefined)) throw new Error('web revoke takes one device id or --all')
    if (all) return { revoked: deps.revokeAll() }
    if (typeof id !== 'string' || id === '' || id.length > MAX_DEVICE_ID) throw new Error('web revoke: not a device id')
    // The id is echoed only when it is one of ours: an unknown one is not repeated back.
    if (!deps.revoke(id)) throw new Error('web revoke: no signed-in device has that id (`ccc web status` lists them)')
    return { revoked: 1 }
  }
}

export function webStopHandler(deps: Pick<WebHandlerDeps, 'server' | 'stop'>): Handler {
  return (_args, caller) => {
    hostOnly(caller)
    serverOnly(deps)
    deps.stop()
    return { stopping: true }
  }
}

/**
 * The handlers by request name. Every name is in HOST_ONLY_COMMANDS (SocketServer.handle refuses a
 * `web.*` name that is not, and cli-web.test.ts checks this table against the list).
 */
export function webHandlers(deps: WebHandlerDeps): Record<string, Handler> {
  return {
    'web.status': webStatusHandler(deps),
    'web.revoke': webRevokeHandler(deps),
    'web.stop': webStopHandler(deps)
  }
}

export function registerWebHandlers(socket: { handle(cmd: string, handler: Handler): void }, deps: WebHandlerDeps): void {
  for (const [cmd, handler] of Object.entries(webHandlers(deps))) {
    // Belt and braces next to SocketServer.handle's own check, for a fake socket in a test as well.
    if (!HOST_ONLY_COMMANDS.includes(cmd)) throw new Error(`${cmd} is not in HOST_ONLY_COMMANDS`)
    socket.handle(cmd, handler)
  }
}
