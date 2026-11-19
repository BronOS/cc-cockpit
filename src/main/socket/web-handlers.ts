// `ccc web` (design-web.md §9.4): web access from a shell on the server, as socket handlers: `status`,
// `revoke` and `stop` (server-mode plan Task 11), and the server mode's own way to hand out and change
// sign-in, `link`, `add-device`, `password`, `mode` and `set` (Task 12), which on the desktop are the
// Settings page's alone (`no`-class channels). The guest commands (design-guests §12, D-25): `invite`,
// `guests`, `kick` and `role`.
//
// Authority, twice over:
//   - Host-only. The socket server refuses any token for a HOST_ONLY_COMMANDS request before a
//     handler is looked up (socket-server.ts `identify`), and every handler here refuses any caller
//     kind but the tokenless, projectless one again (`hostOnly`), as the session-only handlers
//     refuse a window token again: a handler reached some other way (registered under a name the
//     list lacks, which SocketServer.handle refuses, or a later change to identify) still answers a
//     Claude tab with nothing. Not a boundary (protocol.ts says why it is there anyway).
//   - Narrowing on the desktop. Outside server mode only what narrows access or reads it is answered:
//     `status`, `revoke`, `guests`, `kick` and `role … read`. Anything else (`invite`, `role … write`
//     included) would let any process of the user (a plugin with exec, a remote view's shell) change who
//     gets in, or what they may do, with nobody asked, where on the desktop that takes a click on the
//     person's screen. Decided by main's `server` flag for the run, never by anything in the request.
//
// Secrets: the password arrives only in `web.password`'s args over the private socket (never argv:
// argv shows in `ps`). It is never in an error text, the reply or a log line: errors here name the
// rule, never the value, and `web-access.log` gets what changed from the shell (`logShell`), never
// a link, a token or a password. An invite's link goes in `web.invite`'s reply alone (shown once); the log
// line names the guest by id, never by name (owner text that the core notice would show in every browser).
//
// No Electron import: main passes the parts in, unit tests pass fakes.
import { isAbsolute } from 'node:path'
import {
  DEFAULT_GUEST_LIFETIME,
  GUEST_NAME_MAX,
  guestLifetimeOf,
  guestRoleOf,
  guestScopeOf,
  MAX_GUESTS,
  type GuestInviteError,
  type GuestView
} from '../../shared/guests'
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
import type { GuestService } from '../ipc/guest-deps'
import type { AccessLog } from '../web/access-log'
import type { WebAccessService } from '../web/access-service'
import { MAX_PASSWORD_BYTES, MAX_PASSWORD_LENGTH } from '../web/password'
import { SERVER_NO_CONFIRM_MODE } from '../web/settings'
import type { Caller, Handler } from './socket-server'

/** What a desktop run answers every `ccc web` subcommand but `status` and `revoke` with. */
export const DESKTOP_REFUSAL = 'use Settings › Web access'

/**
 * What a desktop run answers `web invite` and `web role … write` with (D-25): minting a guest and giving one
 * write access stay on the desktop page, where the person sees and clicks.
 */
export const DESKTOP_GUEST_REFUSAL = 'on the desktop, invite guests and give them write access in the app window, not from a shell'

/** What the guest commands answer while main has no guest service wired. */
export const GUESTS_UNAVAILABLE = 'guests are not available'

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
  /**
   * One `web-access.log` line for a change made from the shell: what changed, never a secret. Main's
   * wiring also raises a core notice with it (`access-changed`: in server mode a stdout line and an
   * in-page notice in every browser), so a widening from a shell is seen where the person looks.
   */
  logShell(detail: string): void
  /** The guest store (main/web/guests.ts); absent until main wires it: the guest commands answer GUESTS_UNAVAILABLE. */
  guests?: Pick<GuestService, 'list' | 'invite' | 'revokeInvite' | 'kick' | 'setRole'>
  /**
   * The id of a known project named by its id or by an absolute folder path (the registry's), else undefined:
   * a relative path, an unknown id or folder. `web.invite` refuses "no such project" for undefined. Absent
   * with `guests`: GUESTS_UNAVAILABLE.
   */
  projectOf?: (idOrPath: string) => string | undefined
}

/**
 * The core notice for a change made from a shell: the command and its flags, never a value. The desktop now gets
 * some too (`kick`, `role … read` answer there), as an OS notification, so it is not called the server's shell.
 */
export function shellChangeNotice(detail: string, server = true): string {
  return `Web access was changed from ${server ? 'the server shell' : 'a shell outside cc-cockpit'}: ${detail}`
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
  /** A core notice (`access-changed`) for each change made from the shell (core-notices.ts). Absent: none. */
  notice?: (text: string) => void
  quit: () => void
  setTimer?: (fn: () => void, ms: number) => void
  /** The guest store and the project lookup, passed through as they are (WebHandlerDeps); absent: no guests. */
  guests?: WebHandlerDeps['guests']
  projectOf?: WebHandlerDeps['projectOf']
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
    logShell: (detail) => {
      input.accessLog.write({ event: 'shell', detail })
      input.notice?.(shellChangeNotice(detail, input.server))
    },
    ...(input.guests !== undefined ? { guests: input.guests } : {}),
    ...(input.projectOf !== undefined ? { projectOf: input.projectOf } : {})
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
const SET_KEYS = ['bind', 'port', 'externalOrigin', 'hosts', 'tls', 'confirm', 'startFolder'] as const
/** The flag each field came from, for the log line. */
const SET_FLAGS: Record<(typeof SET_KEYS)[number], string> = {
  bind: '--bind',
  port: '--port',
  externalOrigin: '--origin',
  hosts: '--host',
  tls: '--tls-cert/--tls-key',
  confirm: '--confirm',
  startFolder: '--start-folder'
}

/**
 * Bind, port, origin, hosts, TLS and the browser picker's start folder through the same
 * `applyWebAccessPatch` as the Settings page (main's `server` included). A §4.3 risk is refused with
 * its confirm text unless the request confirms it. TLS paths and the start folder must be absolute:
 * the CLI makes them so against its own cwd, and main's cwd means nothing to the caller, so a relative
 * one is refused here rather than read against it. Answers the status after the change (listening or
 * why not).
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
    // The browser picker's start folder (design-web.md §9.8): absolute, as the TLS paths and for the
    // same reason; null or '' clears it (back to the home folder).
    const start = args.startFolder
    if (start !== undefined && start !== null && start !== '' && (typeof start !== 'string' || !isAbsolute(start))) {
      throw new Error('web set: --start-folder takes an absolute path, or \'\' for the home folder')
    }
    if ('confirm' in args) patch.confirm = risksOf(args.confirm, 'web set')
    await applyPatch(deps, patch as WebAccessPatch)
    const flags = SET_KEYS.filter((k) => k in args && k !== 'confirm').map((k) => (k === 'tls' && args.tls === null ? '--no-tls' : SET_FLAGS[k]))
    deps.logShell(['ccc web set', ...flags, ...((patch.confirm as WebAccessRisk[] | undefined) ?? []).map((r) => `--confirm ${r}`)].join(' '))
    return deps.status()
  }
}

/** What `web.invite` answers: the link (only ever in this reply, shown once), the ids, the invite's expiry. */
export interface WebCliInviteResult {
  link: string
  inviteId: string
  guestId: string
  expiresAt: number
  warning?: 'loopback-only'
}

/** What `web.kick` answers: the guest removed (`guest`) or the invite cancelled (`invite`), by id; the name when known. */
export type WebCliKickResult = { guest: string; name: string } | { invite: string; name?: string }

/** What `web.role` answers. */
export interface WebCliRoleResult {
  guest: string
  name: string
  role: 'read' | 'write'
}

/** Each GuestInviteError as a sentence; nothing was made. */
export const INVITE_ERROR_TEXT: Readonly<Record<GuestInviteError, string>> = {
  'none-mode': 'web invite: sign-in is none (no sign-in), and a guest needs one: ccc web mode link or password first',
  'name-taken': 'web invite: a guest already has that name',
  cap: `web invite: there are already ${MAX_GUESTS} guests and pending invites: remove one first (ccc web kick)`,
  full: 'web invite: the device store is full: sign a device out first (ccc web revoke)'
}

/** Longest guest id, invite id or name `web.kick` and `web.role` take (ids are minted short; a name is at most GUEST_NAME_MAX). */
const MAX_GUEST_TARGET = 128
/** Longest `--project` value `web.invite` takes: PATH_MAX. */
const MAX_PROJECT_ARG = 4096

function guestsOf(deps: Pick<WebHandlerDeps, 'guests'>): NonNullable<WebHandlerDeps['guests']> {
  if (deps.guests === undefined) throw new Error(GUESTS_UNAVAILABLE)
  return deps.guests
}

/** A name or an id as `web.kick` and `web.role` take it: a non-empty string, bounded. */
function targetOf(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_GUEST_TARGET) throw new Error(`${what}: not a guest id or name`)
  return raw
}

/** A control character (C0, DEL, C1): a name is shown in pages and terminals, plain text only. */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/**
 * The guest or pending invite `target` names: an id first (unique), then a name. Two rows with the name are
 * refused (the person picks by id); an unknown target is not repeated back, as `web.revoke` does not. A pending
 * invite counts: its row's id is the guest id the redeem will have.
 */
function resolveGuest(list: readonly GuestView[], target: string, what: string): GuestView {
  const byId = list.find((g) => g.id === target)
  if (byId !== undefined) return byId
  const named = list.filter((g) => g.name === target)
  if (named.length > 1) throw new Error(`${what}: two guests are named ${target}: use the id (ccc web guests lists them)`)
  const [one] = named
  if (one === undefined) throw new Error(`${what}: no guest or invite has that id or name (ccc web guests lists them)`)
  return one
}

/**
 * `{ project, name, role, scope?, lifetime? }` (server mode only, D-25): makes an invite for the project main
 * resolves from an id or an absolute path. Answers the link once; the log line has no link, name or token.
 */
export function webInviteHandler(deps: Pick<WebHandlerDeps, 'server' | 'guests' | 'projectOf' | 'logShell'>): Handler {
  return async (args, caller): Promise<WebCliInviteResult> => {
    hostOnly(caller)
    if (!deps.server) throw new Error(DESKTOP_GUEST_REFUSAL)
    const guests = guestsOf(deps)
    if (deps.projectOf === undefined) throw new Error(GUESTS_UNAVAILABLE)
    onlyKeys(args, ['project', 'name', 'role', 'scope', 'lifetime'], 'web invite')
    const name = args.name
    if (typeof name !== 'string' || name.trim() === '' || name.length > GUEST_NAME_MAX || hasControl(name)) {
      throw new Error(`web invite: a name is 1 to ${GUEST_NAME_MAX} characters of plain text`)
    }
    const role = guestRoleOf(args.role)
    if (role === undefined) throw new Error('web invite: --role takes read or write')
    const scope = args.scope === undefined ? 'all' : guestScopeOf(args.scope)
    if (scope === undefined) throw new Error('web invite: --tabs takes all or tab ids')
    const lifetime = args.lifetime === undefined ? DEFAULT_GUEST_LIFETIME : guestLifetimeOf(args.lifetime)
    if (lifetime === undefined) throw new Error('web invite: --lifetime takes 1d, 7d or forever')
    const project = args.project
    // The value is not echoed: a path is the person's, and the answer is the same for every unknown one.
    if (typeof project !== 'string' || project === '' || project.length > MAX_PROJECT_ARG) throw new Error('web invite: --project takes a project id or a folder path')
    const projectId = deps.projectOf(project)
    if (projectId === undefined) throw new Error('web invite: no such project (a project id, or the folder of a project cc-cockpit knows)')
    const answer = await guests.invite(projectId, { name, role, scope, lifetime })
    if (!answer.ok) throw new Error(INVITE_ERROR_TEXT[answer.error] ?? 'web invite: no invite was made')
    const tabs = scope === 'all' ? 'all' : `${scope.length} tab(s)`
    deps.logShell(`ccc web invite --role ${role} --tabs ${tabs} --lifetime ${lifetime} (guest ${answer.guestId})`)
    const result: WebCliInviteResult = { link: answer.link, inviteId: answer.inviteId, guestId: answer.guestId, expiresAt: answer.expiresAt }
    if (answer.warning === 'loopback-only') result.warning = 'loopback-only'
    return result
  }
}

/** Every guest and pending invite (GuestService.list), both hosts: listing narrows nothing and widens nothing. */
export function webGuestsHandler(deps: Pick<WebHandlerDeps, 'guests'>): Handler {
  return (args, caller): GuestView[] => {
    hostOnly(caller)
    const guests = guestsOf(deps)
    onlyKeys(args, [], 'web guests')
    return guests.list()
  }
}

/**
 * `{ guest }` (an id or a name) or `{ invite }` (an invite id), exactly one; both hosts (it narrows). A guest
 * still pending is its invite: naming it cancels the invite, so `kick <name>` works before and after the redeem.
 */
export function webKickHandler(deps: Pick<WebHandlerDeps, 'guests' | 'logShell'>): Handler {
  return (args, caller): WebCliKickResult => {
    hostOnly(caller)
    const guests = guestsOf(deps)
    onlyKeys(args, ['guest', 'invite'], 'web kick')
    if ((args.guest === undefined) === (args.invite === undefined)) throw new Error('web kick takes one guest id or name, or --invite <invite id>')
    if (args.invite !== undefined) {
      const id = targetOf(args.invite, 'web kick')
      if (!guests.revokeInvite(id)) throw new Error('web kick: no pending invite has that id (ccc web guests lists them)')
      deps.logShell(`ccc web kick --invite ${id}`)
      return { invite: id }
    }
    const row = resolveGuest(guests.list(), targetOf(args.guest, 'web kick'), 'web kick')
    if (row.state === 'pending' && row.inviteId !== undefined) {
      // Redeemed in the meantime: the invite is gone, and the row's guest goes as a guest below would.
      if (guests.revokeInvite(row.inviteId)) {
        deps.logShell(`ccc web kick --invite ${row.inviteId}`)
        return { invite: row.inviteId, name: row.name }
      }
    }
    if (!guests.kick(row.id)) throw new Error('web kick: no guest or invite has that id or name (ccc web guests lists them)')
    deps.logShell(`ccc web kick ${row.id}`)
    return { guest: row.id, name: row.name }
  }
}

/**
 * `{ guest, role }`: `read` on both hosts (it narrows), `write` in server mode only (D-25). The desktop refusal
 * comes before the guest is looked up, so its answer says nothing about which guests exist.
 */
export function webRoleHandler(deps: Pick<WebHandlerDeps, 'server' | 'guests' | 'logShell'>): Handler {
  return (args, caller): WebCliRoleResult => {
    hostOnly(caller)
    onlyKeys(args, ['guest', 'role'], 'web role')
    const role = guestRoleOf(args.role)
    if (role === undefined) throw new Error('web role: the role is read or write')
    if (role === 'write' && !deps.server) throw new Error(DESKTOP_GUEST_REFUSAL)
    const guests = guestsOf(deps)
    const row = resolveGuest(guests.list(), targetOf(args.guest, 'web role'), 'web role')
    // False for a row the list just gave: gone meanwhile, or a pending invite the store does not switch (redo the invite).
    if (!guests.setRole(row.id, role)) throw new Error('web role: that guest\'s role could not be changed (gone, or an invite not redeemed yet)')
    deps.logShell(`ccc web role ${row.id} ${role}`)
    return { guest: row.id, name: row.name, role }
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
    'web.set': webSetHandler(deps),
    'web.invite': webInviteHandler(deps),
    'web.guests': webGuestsHandler(deps),
    'web.kick': webKickHandler(deps),
    'web.role': webRoleHandler(deps)
  }
}

export function registerWebHandlers(socket: { handle(cmd: string, handler: Handler): void }, deps: WebHandlerDeps): void {
  for (const [cmd, handler] of Object.entries(webHandlers(deps))) {
    // Belt and braces next to SocketServer.handle's own check, for a fake socket in a test as well.
    if (!HOST_ONLY_COMMANDS.includes(cmd)) throw new Error(`${cmd} is not in HOST_ONLY_COMMANDS`)
    socket.handle(cmd, handler)
  }
}
