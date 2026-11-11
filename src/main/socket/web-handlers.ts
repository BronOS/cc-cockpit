// `ccc web` (design-web.md §9.4): web access from a shell on the server, as socket handlers: `status`,
// `revoke` and `stop` (server-mode plan Task 11), and the server mode's own way to hand out and change
// sign-in, `link`, `add-device`, `password`, `mode` and `set` (Task 12), which on the desktop are the
// Settings page's alone (`no`-class channels).
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
// Secrets: the password arrives only in `web.password`'s args over the private socket (never argv:
// argv shows in `ps`). It is never in an error text, the reply or a log line: errors here name the
// rule, never the value, and `web-access.log` gets what changed from the shell (`logShell`), never
// a link, a token or a password.
//
// No Electron import: main passes the parts in, unit tests pass fakes.
import { isAbsolute } from 'node:path'
import { HOST_ONLY_COMMANDS, HOST_ONLY_TEXT } from '../../shared/protocol'
import type { WebAccessRisk } from '../../shared/types'
import {
  WEB_RISK_ORDER,
  WEB_RISK_TEXT,
  type WebAccessPatch,
  type WebAccessSetReply,
  type WebActionReply,
  type WebCliRevokeResult,
  type WebCliNotice,
  type WebCliStatus,
  SERVER_NONE_WARNING,
  type WebLinkReply,
  type WebSecretsStatus,
  WEB_SHELL_MODES
} from '../../shared/web-access'
import type { AccessLog } from '../web/access-log'
import type { WebAccessService } from '../web/access-service'
import { MAX_PASSWORD_BYTES, MAX_PASSWORD_LENGTH } from '../web/password'
import { SERVER_NO_CONFIRM_MODE } from '../web/settings'
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
  /** The access link, made on first use; `regenerate` kills it and its devices first (WebAccessService). */
  link(regenerate: boolean): Promise<WebLinkReply>
  /** A one-time add-device link, 10 minutes (WebAccessService.addDevice). */
  addDevice(): WebLinkReply
  /** Sets the password (WebAccessService.setPassword: scrypt off the main thread). */
  setPassword(password: string): Promise<WebActionReply>
  /** The Settings page's change path (WebAccessService.set, `applyWebAccessPatch` with main's `server`). */
  set(patch: WebAccessPatch): Promise<WebAccessSetReply>
  /** One `web-access.log` line for a change made from the shell: what changed, never a secret. */
  logShell(detail: string): void
}

/**
 * How long `web.stop` waits before it quits: the reply is written first, since the quit ends the
 * socket's connections and the shell would otherwise see a dropped one instead of the answer.
 */
export const STOP_AFTER_REPLY_MS = 100

/**
 * The handlers' deps as main wires them (index.ts; cli-web.test.ts runs the same wiring): every
 * write through the WebAccessService calls the Settings page makes, with its `server` rules (no
 * off, no desktop confirm); revocations carry SHELL_REVOKE_REASON; `stop` quits (`quit`, SIGTERM to
 * main itself) STOP_AFTER_REPLY_MS after it answered.
 */
export function webHandlerDeps(input: {
  server: boolean
  access: Pick<WebAccessService, 'cliStatus' | 'revoke' | 'revokeAll' | 'link' | 'regenerate' | 'addDevice' | 'setPassword' | 'set'>
  /** This run's secret store as status shows it (index.ts `webSecretsStatus`). */
  secrets: () => Promise<WebSecretsStatus>
  /** The core notices of this run (core-notices.ts). */
  notices: () => WebCliNotice[]
  accessLog: Pick<AccessLog, 'write'>
  quit: () => void
  setTimer?: (fn: () => void, ms: number) => void
}): WebHandlerDeps {
  const { access } = input
  const setTimer = input.setTimer ?? ((fn: () => void, ms: number): void => void setTimeout(fn, ms))
  return {
    server: input.server,
    status: async () => access.cliStatus(await input.secrets(), input.notices()),
    revoke: (id) => access.revoke(id, { reason: SHELL_REVOKE_REASON }),
    revokeAll: () => access.revokeAll({ reason: SHELL_REVOKE_REASON }),
    stop: () => setTimer(input.quit, STOP_AFTER_REPLY_MS),
    link: (regenerate) => (regenerate ? access.regenerate() : access.link()),
    addDevice: () => access.addDevice(),
    setPassword: (password) => access.setPassword(password),
    set: (patch) => access.set(patch),
    logShell: (detail) => input.accessLog.write({ event: 'shell', detail })
  }
}

/** What `web.mode` answers; `warning` is §9.12's shared-server text for None. */
export interface WebCliModeResult {
  mode: string
  warning?: string
}

/** What `web.link` and `web.add-device` answer: the link (only ever in this reply), and when a one-time one expires. */
export interface WebCliLinkResult {
  link: string
  expiresAt?: number
}

/** The tokenless, projectless caller only (a shell outside the app); everything else gets HOST_ONLY_TEXT. */
function hostOnly(caller: Caller): void {
  if (caller.kind !== 'anonymous') throw new Error(HOST_ONLY_TEXT)
}

function serverOnly(deps: Pick<WebHandlerDeps, 'server'>): void {
  if (!deps.server) throw new Error(DESKTOP_REFUSAL)
}

/** Refuses an args key outside `allowed`: a field this request has no use for is a caller's mistake, not ignored. */
function onlyKeys(args: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new Error(`${what}: unexpected field ${JSON.stringify(key.slice(0, 40))}`)
}

/** The `--confirm` risks of a request: absent is none, anything but a list of known risks is refused. */
function risksOf(raw: unknown, what: string): WebAccessRisk[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > WEB_RISK_ORDER.length * 2 || !raw.every((r) => WEB_RISK_ORDER.includes(r as WebAccessRisk))) {
    throw new Error(`${what}: --confirm takes ${WEB_RISK_ORDER.join(' or ')}`)
  }
  return [...new Set(raw as WebAccessRisk[])]
}

/**
 * The §4.3 confirm as a shell sees it: each risk's own words (WEB_RISK_TEXT, the same the Settings
 * page shows), then the flags that accept them. Nothing was changed.
 */
export function confirmNeededText(risks: readonly WebAccessRisk[]): string {
  const blocks = risks.map((r) => [WEB_RISK_TEXT[r].title, ...WEB_RISK_TEXT[r].paragraphs].join('\n'))
  const flags = risks.map((r) => `--confirm ${r}`).join(' ')
  return `nothing changed; this needs a confirm:\n\n${blocks.join('\n\n')}\n\nto do it anyway, run the same command with ${flags}`
}

/** The settings change's outcome: a refusal throws (nothing changed), a confirm needed throws its text. */
async function applyPatch(deps: Pick<WebHandlerDeps, 'set'>, patch: WebAccessPatch): Promise<void> {
  const reply = await deps.set(patch)
  if ('needsConfirm' in reply) throw new Error(confirmNeededText(reply.needsConfirm))
}

function linkResult(reply: WebLinkReply, what: string): WebCliLinkResult {
  if (!reply.ok) throw new Error(`${what}: ${reply.reason}`)
  return reply.expiresAt === undefined ? { link: reply.link } : { link: reply.link, expiresAt: reply.expiresAt }
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

/** `{ regenerate?: true }`: prints the access link (made on first use), or a new one in place of the old. */
export function webLinkHandler(deps: Pick<WebHandlerDeps, 'server' | 'link' | 'logShell'>): Handler {
  return async (args, caller): Promise<WebCliLinkResult> => {
    hostOnly(caller)
    serverOnly(deps)
    onlyKeys(args, ['regenerate'], 'web link')
    if (args.regenerate !== undefined && args.regenerate !== true) throw new Error('web link: regenerate is true or absent')
    const regenerate = args.regenerate === true
    const reply = await deps.link(regenerate)
    // A regenerate that ran took access back even when the new link could not be stored, but a refusal
    // before it ran (not listening, not link mode) is indistinguishable here: a failed one is worded
    // as an attempt so the log never claims a change that may not have happened.
    if (reply.ok) deps.logShell(regenerate ? 'ccc web link --regenerate' : 'ccc web link')
    else if (regenerate) deps.logShell('ccc web link --regenerate (failed: nothing may have changed)')
    return linkResult(reply, 'web link')
  }
}

/** A one-time link, 10 minutes, replacing the previous one (design-web.md §4.2). */
export function webAddDeviceHandler(deps: Pick<WebHandlerDeps, 'server' | 'addDevice' | 'logShell'>): Handler {
  return (args, caller): WebCliLinkResult => {
    hostOnly(caller)
    serverOnly(deps)
    onlyKeys(args, [], 'web add-device')
    const result = linkResult(deps.addDevice(), 'web add-device')
    deps.logShell('ccc web add-device')
    return result
  }
}

/**
 * `{ password }`, read by the CLI from stdin or a no-echo prompt. The length cap before hashing is the
 * sign-in route's (MAX_PASSWORD_BYTES code units); passwordProblem says the rest. Answers the
 * mode, so the CLI can say when the password is not what signs people in yet.
 */
export function webPasswordHandler(deps: Pick<WebHandlerDeps, 'server' | 'setPassword' | 'status' | 'logShell'>): Handler {
  return async (args, caller): Promise<{ set: true; mode: string }> => {
    hostOnly(caller)
    serverOnly(deps)
    onlyKeys(args, ['password'], 'web password')
    const password = args.password
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_BYTES) {
      throw new Error(`web password: give a password of at most ${MAX_PASSWORD_LENGTH} characters on stdin`)
    }
    const reply = await deps.setPassword(password)
    // The reason is WebAuth's: a length rule or the store's failure, never the value.
    if (!reply.ok) throw new Error(`web password: ${reply.reason}`)
    deps.logShell('ccc web password')
    return { set: true, mode: (await deps.status()).mode }
  }
}

/** `{ mode, confirm? }`: through the Settings page's change path; None on a network bind takes `--confirm none-network`. */
export function webModeHandler(deps: Pick<WebHandlerDeps, 'server' | 'set' | 'logShell'>): Handler {
  return async (args, caller): Promise<WebCliModeResult> => {
    hostOnly(caller)
    serverOnly(deps)
    onlyKeys(args, ['mode', 'confirm'], 'web mode')
    // Desktop confirm is refused with its reason (nobody could answer it); the CLI passes it on for this.
    if (args.mode === 'confirm') throw new Error(SERVER_NO_CONFIRM_MODE)
    const mode = WEB_SHELL_MODES.find((m) => m === args.mode)
    if (mode === undefined) throw new Error(`web mode takes ${WEB_SHELL_MODES.join(', ')}`)
    const confirm = risksOf(args.confirm, 'web mode')
    await applyPatch(deps, confirm.length > 0 ? { mode, confirm } : { mode })
    deps.logShell(['ccc web mode', mode, ...confirm.map((r) => `--confirm ${r}`)].join(' '))
    // §9.12: on a shared server every local user reaches loopback, so None hands the account to all of them.
    return mode === 'none' ? { mode, warning: SERVER_NONE_WARNING } : { mode }
  }
}

/** The fields `web.set` takes, `WebAccessPatch`'s names; `enabled` and `mode` are not among them. */
const SET_KEYS = ['bind', 'port', 'externalOrigin', 'hosts', 'tls', 'confirm'] as const
/** The flag each field came from, for the log line. */
const SET_FLAGS: Record<(typeof SET_KEYS)[number], string> = {
  bind: '--bind',
  port: '--port',
  externalOrigin: '--origin',
  hosts: '--host',
  tls: '--tls-cert/--tls-key',
  confirm: '--confirm'
}

/**
 * Bind, port, origin, hosts and TLS through the same `applyWebAccessPatch` as the Settings page (main's
 * `server` included). A §4.3 risk is refused with its confirm text unless the request confirms it. TLS
 * paths must be absolute: the CLI makes them so against its own cwd, and main's cwd means nothing to
 * the caller, so a relative one is refused here rather than read against it. Answers the status after
 * the change (listening or why not).
 */
export function webSetHandler(deps: Pick<WebHandlerDeps, 'server' | 'set' | 'status' | 'logShell'>): Handler {
  return async (args, caller): Promise<WebCliStatus> => {
    hostOnly(caller)
    serverOnly(deps)
    onlyKeys(args, SET_KEYS, 'web set')
    if (Object.keys(args).length === 0) throw new Error('web set: nothing to change')
    const patch: Record<string, unknown> = {}
    for (const key of SET_KEYS) if (key in args) patch[key] = args[key]
    const tls = args.tls
    if (tls !== undefined && tls !== null) {
      const t = (typeof tls === 'object' ? tls : {}) as Record<string, unknown>
      if (typeof t.certPath !== 'string' || typeof t.keyPath !== 'string' || !isAbsolute(t.certPath) || !isAbsolute(t.keyPath)) {
        throw new Error('web set: --tls-cert and --tls-key take absolute paths')
      }
      patch.tls = { certPath: t.certPath, keyPath: t.keyPath }
    }
    if ('confirm' in args) patch.confirm = risksOf(args.confirm, 'web set')
    await applyPatch(deps, patch as WebAccessPatch)
    const flags = SET_KEYS.filter((k) => k in args && k !== 'confirm').map((k) => (k === 'tls' && args.tls === null ? '--no-tls' : SET_FLAGS[k]))
    deps.logShell(['ccc web set', ...flags, ...((patch.confirm as WebAccessRisk[] | undefined) ?? []).map((r) => `--confirm ${r}`)].join(' '))
    return deps.status()
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
    'web.stop': webStopHandler(deps),
    'web.link': webLinkHandler(deps),
    'web.add-device': webAddDeviceHandler(deps),
    'web.password': webPasswordHandler(deps),
    'web.mode': webModeHandler(deps),
    'web.set': webSetHandler(deps)
  }
}

export function registerWebHandlers(socket: { handle(cmd: string, handler: Handler): void }, deps: WebHandlerDeps): void {
  for (const [cmd, handler] of Object.entries(webHandlers(deps))) {
    // Belt and braces next to SocketServer.handle's own check, for a fake socket in a test as well.
    if (!HOST_ONLY_COMMANDS.includes(cmd)) throw new Error(`${cmd} is not in HOST_ONLY_COMMANDS`)
    socket.handle(cmd, handler)
  }
}
