// One built-in SSH link per saved server (design-remote-desktop.md §5.1-§5.6): the `ssh2` connection
// (through ssh-client.ts, the only `ssh2` import), the sign-in order, the host key decision, the two
// `ccc web` commands (remote-status.ts) and the tunnel's loopback listener, which this app owns.
//
// Plain logic: every outside thing comes in through `SshLinkOptions` (the dial, the store's read
// side, `~/.ssh/config`, known_hosts and key file readers, the home directory, the login env, the
// clock, the listener), so unit tests run it against `ssh2`'s own `Server` in-process with a temp
// home and never touch the person's `~/.ssh` or agent.
//
// The rules, and why:
//  - Main never waits on the picker inside a call (§5.4). A call that needs the person (a host key
//    nobody vouches for, a password, a passphrase) ends with a typed `need`; the picker asks and
//    calls again with every answer of that connect. A first connect therefore dials more than once.
//  - Nothing is saved here. The link reads the record and the store's secrets, and reports in
//    `accepted` what of the answers (or of known_hosts) the live connection rests on; the caller
//    (RemoteService) saves that only once the whole connect, pairing included, has succeeded, so a
//    `need` halfway or a cancelled connect leaves nothing behind (plan rev 2, "nothing saved before
//    success"). Answers are used only in the call that carries them; a redial uses the store alone.
//  - Host keys (§5.3): looked up by the resolved HostName and port as `ssh` does, the known types
//    offered first so the known key is the one compared. A key the record holds that differs, or one
//    known_hosts lists differently or as `@revoked`, refuses without reading the answers: a changed
//    key is never a question, since that click-through is the attack. A picker answer counts only in
//    the "unknown" branch and only when it equals the key this very dial saw.
//  - Sign-in (§5.1), each method at most once and in our order: auto = the agent, then key files
//    (a locked one skipped and named); password = `password` when offered, else keyboard-interactive
//    with exactly the one-password-prompt rule (never both: a wrong password sent both ways doubles
//    the server's lockout count); key = that file only, parsed here first because `ssh2` silently
//    skips a key it cannot read.
//  - The tunnel (§5.2): a listener on 127.0.0.1 that exists before any window loads and stays bound
//    across redials, so no other local process can be holding the port when the page sends its
//    cookie, and the page's origin never moves under it. Each accepted socket is piped to one
//    `forwardOut` channel; while the connection is down, accepted sockets are closed at once (the
//    page's own reconnect retries). A redial re-runs `web status` (the server may have restarted on
//    another gateway port); so does a page channel the server refuses while SSH stays up (its
//    cockpit restarted alone), at most once per GATEWAY_RECHECK_MS, and the socket is retried once
//    on the new port. A redial refused on sign-in or on the host key stops and says why: the
//    background never asks.
//  - Secrets (password, passphrase) never reach a log, a state, an error text or a result.
import { readFile, stat } from 'node:fs/promises'
import { createServer, type Server as NetServer, type Socket } from 'node:net'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { errorText } from '../../shared/error-text'
import {
  isLocalPort,
  sshAuthOf,
  type RemoteHostKey,
  type RemoteNeed,
  type RemoteSecretName,
  type RemoteServerRecord,
  type SshAuth
} from '../../shared/remote-servers'
import { checkKnownHost, fingerprint, keyBlobType, knownHostKeyTypes, knownHostKeys } from './known-hosts'
import { addDeviceToken, serverStatus, shownText, type RemoteExec, type RemoteStatus } from './remote-status'
import {
  dial as ssh2Dial,
  parseKey,
  type DialOptions,
  type SshAuthHandler,
  type SshAuthMethod,
  type SshConnection,
  type SshError,
  type SshPrivateKey,
  type SshPromptAnswer,
  type SshPromptRound
} from './ssh-client'
import { nodeSshConfigFiles, resolveSshConfig, type SshConfigResult, type SshIdentityAgent } from './ssh-config'

// ---------------------------------------------------------------------------------------------
// Limits (design §5.1, §5.2, §5.6)

/** Handshake plus sign-in with no agent. */
export const READY_TIMEOUT_MS = 10_000
/** ... and when the agent is tried: an agent may wait for Touch ID or a 1Password unlock. */
export const AGENT_READY_TIMEOUT_MS = 30_000
/** A `ccc web` command's output (stdout plus stderr) and deadline. */
export const EXEC_MAX_BYTES = 64 * 1024
export const EXEC_TIMEOUT_MS = 20_000
/** A key file is read only up to this (a real private key is a few KiB). */
export const KEY_FILE_MAX_BYTES = 64 * 1024
/** known_hosts is read only up to this; a bigger file is read as empty (every host "unknown": asked). */
const KNOWN_HOSTS_MAX_BYTES = 4 * 1024 * 1024
/** Redial delays after the connection dropped while windows use it; the last one repeats. */
export const REDIAL_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000, 30_000]
/** A connection up this long before it dropped redials from the first delay again. */
export const BACKOFF_RESET_MS = 60_000
/** The link stays this long after its last user (window or command) is done: a quick reopen reuses it. */
export const IDLE_STOP_MS = 30_000
/** The default key files of `auto` when the config names none, in `ssh`'s order (§5.1). */
const DEFAULT_KEY_FILES = ['id_ed25519', 'id_ecdsa', 'id_rsa'] as const
/** `CHANNEL_OPEN_FAILURE` reasons (RFC 4254 §5.1), as `ssh2` puts them on a refused `forwardOut`. */
const OPEN_ADMINISTRATIVELY_PROHIBITED = 1
const OPEN_CONNECT_FAILED = 2
/**
 * A refused page channel re-runs `web status` at most this often (the server's cockpit restarted on
 * another gateway port while SSH stayed up): a page retrying in a loop must not turn into a stream
 * of remote commands.
 */
export const GATEWAY_RECHECK_MS = 5000

// ---------------------------------------------------------------------------------------------
// The interface RemoteService talks to

/**
 * What the picker answered so far in this connect (design §5.4); the picker resends them all on
 * every retry. Main compares `hostKey` with the key it sees; secrets are used for this call only.
 */
export interface LinkAnswers {
  /** The `SHA256:` fingerprint the person trusted. */
  hostKey?: string
  password?: string
  passphrase?: string
}

/** What a call needs from the person before it can go on (design §5.4): passed to the picker as is. */
export type LinkNeed = RemoteNeed

/**
 * What the live connection rests on that the store does not have yet: a host key trusted from an
 * answer or vouched for by known_hosts (absent once the record holds that key), and which secrets
 * came from the answers. The caller saves these after the whole connect succeeded; saving again is
 * harmless (the flags last as long as the connection).
 */
export interface LinkAccepted {
  hostKey?: RemoteHostKey
  password?: true
  passphrase?: true
}

export type LinkResult<T> =
  | { ok: true; value: T; accepted: LinkAccepted }
  | { ok: false; need: LinkNeed }
  | { ok: false; error: string }

/** How the link is doing, for the picker's row and the windows' banner. */
export type LinkState =
  | { state: 'stopped' }
  | { state: 'connecting' }
  /** Signed in. `localPort`: the listener, once a window acquired the tunnel. */
  | { state: 'up'; localPort?: number }
  /** `retryInMs`: a redial is scheduled (windows use the link); absent: nothing will happen by itself. */
  | { state: 'down'; error: string; retryInMs?: number }

/**
 * One saved server's way in (design §5, plan rev 2 "a per-server link interface"). Every call may
 * dial; each takes the connect's answers and may end with a `need`.
 */
export interface RemoteLink {
  readonly state: LinkState
  /** The listener's local port while it is bound (it stays bound across redials), else undefined. */
  readonly port: number | undefined
  /** `ccc web status --json` (also remembers the gateway port for the tunnel). */
  status(answers?: LinkAnswers): Promise<LinkResult<RemoteStatus>>
  /** `ccc web add-device`: the one-time token only. */
  addDevice(answers?: LinkAnswers): Promise<LinkResult<string>>
  /**
   * Bring the tunnel up (connection, gateway port, listener, the forwarding probe) and count one
   * user; resolves with the local port. Each ok `acquire` must be balanced by one `release`; a
   * failed one counts nothing.
   */
  acquire(answers?: LinkAnswers): Promise<LinkResult<number>>
  /** One user is done; the last one ends the link 30 s later unless acquired again. */
  release(): void
  onState(listener: (state: LinkState) => void): () => void
  /** End the connection and the listener now; later calls fail. */
  dispose(): void
}

// ---------------------------------------------------------------------------------------------
// Injected parts

/** The store's read side; the link never writes it (see the header). */
export interface SshLinkStore {
  get(id: string): RemoteServerRecord | undefined
  /** A remembered or memory-held secret, decrypted. */
  getSecret(id: string, name: RemoteSecretName): Promise<string | undefined>
}

/** The clock. The defaults read the globals at call time. */
export interface LinkTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export const realLinkTimers: LinkTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

/** A bound listener: its port, and `close` to stop accepting (sockets already accepted are the link's). */
export interface LinkListener {
  readonly port: number
  close(): void
}

/** Bind 127.0.0.1 on `preferred` when it is free, else on a port the OS picks. */
export type LinkListen = (preferred: number | undefined, onSocket: (socket: Socket) => void) => Promise<LinkListener>

/** A key file's bytes, or why there are none (`missing` is told apart: a default key that is absent is no news). */
export type KeyFileRead = { data: Buffer } | { missing: true } | { problem: string }

export type LinkEnv = Readonly<Record<string, string | undefined>>

export interface SshLinkOptions {
  serverId: string
  store: SshLinkStore
  /** The person's home: `~/` paths and `~/.ssh` resolve against it, never `os.homedir()` here. */
  home: string
  /** The login environment at call time (`loginEnv`, not `process.env`: §5.1, an app started from the Dock lacks `SSH_AUTH_SOCK`). */
  env: () => LinkEnv
  dial?: (options: DialOptions) => Promise<SshConnection>
  /** The local user name, for a record and config with no user. Default: `os.userInfo()`. */
  localUser?: () => string
  /** `~/.ssh/config` for the record's host. Default: `resolveSshConfig` over the real files under `home`. */
  resolveConfig?: (host: string) => Promise<SshConfigResult>
  /** `~/.ssh/known_hosts` as text ('' when there is none). */
  readKnownHosts?: () => Promise<string>
  readKeyFile?: (path: string) => Promise<KeyFileRead>
  listen?: LinkListen
  timers?: LinkTimers
}

/** Regular files only, capped; a FIFO is never opened (it would block a thread-pool thread for good). */
export async function nodeReadKeyFile(path: string): Promise<KeyFileRead> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return { problem: 'not a regular file' }
    if (info.size > KEY_FILE_MAX_BYTES) return { problem: `larger than ${KEY_FILE_MAX_BYTES / 1024} KiB, so not a private key` }
    const data = await readFile(path)
    if (data.length > KEY_FILE_MAX_BYTES) return { problem: `larger than ${KEY_FILE_MAX_BYTES / 1024} KiB, so not a private key` }
    return { data }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    return { problem: 'it cannot be read' }
  }
}

/** `<home>/.ssh/known_hosts`, '' when absent, not a regular file or over the cap. Never written. */
export function nodeReadKnownHosts(home: string): () => Promise<string> {
  return async () => {
    const path = join(home, '.ssh', 'known_hosts')
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > KNOWN_HOSTS_MAX_BYTES) return ''
      return await readFile(path, 'utf8')
    } catch {
      return ''
    }
  }
}

/**
 * The real listener. `exclusive`: the port is this process's alone. The preferred port is tried by
 * binding it (no probe-then-bind race): taken, it falls back to a fresh one.
 */
export const netListen: LinkListen = async (preferred, onSocket) => {
  const bind = (port: number): Promise<NetServer> =>
    new Promise((resolve, reject) => {
      const server = createServer(onSocket)
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        server.off('error', reject)
        // A listener error after bind (EMFILE on accept) must not crash main.
        server.on('error', () => {})
        resolve(server)
      })
    })
  let server: NetServer
  if (isLocalPort(preferred)) {
    try {
      server = await bind(preferred)
    } catch {
      server = await bind(0)
    }
  } else server = await bind(0)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { port, close: () => server.close() }
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** An internal failure: `retry` says whether a background redial may try again (sign-in and host keys stop it). */
type Failure = { ok: false; need: LinkNeed } | { ok: false; error: string; retry: boolean }

function failure(error: string, retry: boolean): Failure {
  return { ok: false, error, retry }
}

/** A failure as callers get it (the `retry` flag is the redial loop's business). */
type PublicFailure = { ok: false; need: LinkNeed } | { ok: false; error: string }

function publicFailure(f: PublicFailure): PublicFailure {
  return 'need' in f ? { ok: false, need: f.need } : { ok: false, error: f.error }
}

/** `path` as the person knows it: `~/...` under home. */
function shownPath(path: string, home: string): string {
  const prefix = home.endsWith('/') ? home : `${home}/`
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path
}

/** A record's key path (absolute or `~/`, checked on save) as a real path. */
function expandPath(path: string, home: string): string {
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** The agent socket to try (§5.1): the config's `IdentityAgent`, else the login env's `SSH_AUTH_SOCK`. */
export function agentSocketOf(agent: SshIdentityAgent | undefined, env: LinkEnv): string | undefined {
  let socket: string | undefined
  if (agent === undefined) socket = env['SSH_AUTH_SOCK']
  else if (agent.kind === 'none') socket = undefined
  else if (agent.kind === 'env') socket = env[agent.name]
  else socket = agent.path
  return socket === undefined || socket === '' ? undefined : socket
}

/** The host as the Trust dialog shows it: `host` on 22, `host:port` (`[v6]:port`) otherwise. */
function addressOf(hostName: string, port: number): string {
  if (port === 22) return hostName
  return `${hostName.includes(':') ? `[${hostName}]` : hostName}:${port}`
}

/** What the verifier decided on one dial, read when the dial fails. */
interface HostCheck {
  seen?: RemoteHostKey
  verdict?: 'record' | 'known' | 'answer' | 'changed' | 'known-changed' | 'revoked' | 'unknown' | 'unreadable'
}

/** What one dial's sign-in did, read when it fails. */
interface SignInTrack {
  kind: SshAuth['kind']
  /** The methods the server last said it still accepts. */
  methods: string[]
  agentTried: boolean
  keysTried: number
  /** Key files skipped for a passphrase (auto), as the person knows their paths. */
  lockedKeys: string[]
  /** Key files skipped for another reason (auto): `path: why`. */
  badKeys: string[]
  passwordMissing: boolean
  passwordSent: boolean
  passwordWrong: boolean
  /** A keyboard-interactive prompt other than the password (a 2FA code). */
  extraPrompt?: string
  /** The server accepted a step and wants another (partial success): more than we do. */
  partial: boolean
  keySent: boolean
}

interface SignIn {
  handler: SshAuthHandler
  track: SignInTrack
  agentTried: boolean
  /** Secrets this dial takes from the answers (reported as accepted when it succeeds). */
  fromAnswers: { password?: true; passphrase?: true }
}

// ---------------------------------------------------------------------------------------------
// The link

export class SshLink implements RemoteLink {
  private readonly options: SshLinkOptions
  private readonly id: string
  private readonly dialFn: (options: DialOptions) => Promise<SshConnection>
  private readonly timers: LinkTimers
  private readonly listen: LinkListen
  private readonly readKnownHosts: () => Promise<string>
  private readonly readKeyFile: (path: string) => Promise<KeyFileRead>
  private readonly resolveConfig: (host: string) => Promise<SshConfigResult>

  private conn: SshConnection | undefined
  /** What the live connection took from answers or known_hosts (see `LinkAccepted`). */
  private accepted: { hostKey?: RemoteHostKey; password?: true; passphrase?: true } = {}
  private dialing: Promise<{ ok: true; conn: SshConnection } | Failure> | undefined
  /** The server's gateway port from the last `web status` on the live connection; unknown after a drop. */
  private gatewayPort: number | undefined
  /** The forwarding probe passed on the live connection. */
  private probed = false
  /** A `web status` re-run after a refused page channel (one at a time), and when the last one started. */
  private rechecking: Promise<number | undefined> | undefined
  private lastRecheck = -Infinity
  private listener: LinkListener | undefined
  private opening: Promise<LinkListener> | undefined
  /** Acquired users (windows). */
  private users = 0
  /** Calls in flight: the idle stop waits for them. */
  private busy = 0
  /** Index into REDIAL_BACKOFF_MS for the next redial. */
  private failures = 0
  private upSince = 0
  private redialTimer: unknown
  private idleTimer: unknown
  /** Bumped by every stop: a dial or listen that settles after one is thrown away. */
  private gen = 0
  private disposed = false
  private current: LinkState = { state: 'stopped' }
  private readonly stateListeners = new Set<(state: LinkState) => void>()
  /** Accepted sockets and their channels, closed when the connection goes. */
  private readonly pipes = new Set<Socket | Duplex>()

  constructor(options: SshLinkOptions) {
    this.options = options
    this.id = options.serverId
    this.dialFn = options.dial ?? ssh2Dial
    this.timers = options.timers ?? realLinkTimers
    this.listen = options.listen ?? netListen
    this.readKnownHosts = options.readKnownHosts ?? nodeReadKnownHosts(options.home)
    this.readKeyFile = options.readKeyFile ?? nodeReadKeyFile
    this.resolveConfig = options.resolveConfig ?? ((host) => resolveSshConfig(host, { home: options.home, ...nodeSshConfigFiles }))
  }

  get state(): LinkState {
    return this.current
  }

  get port(): number | undefined {
    return this.listener?.port
  }

  onState(listener: (state: LinkState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  status(answers: LinkAnswers = {}): Promise<LinkResult<RemoteStatus>> {
    return this.call(async () => {
      const c = await this.connect(answers, false)
      if (!c.ok) return c
      const s = await this.statusOn(c.conn)
      if (!s.ok) return s
      this.gatewayPort = s.status.port
      return this.ok(s.status)
    })
  }

  addDevice(answers: LinkAnswers = {}): Promise<LinkResult<string>> {
    return this.call(async () => {
      const c = await this.connect(answers, false)
      if (!c.ok) return c
      const via = this.via()
      if (via === undefined) return failure('this server is not saved any more', false)
      // A re-pair right after a redial this call made itself (windows waiting): their tunnel needs
      // the gateway port too, and sockets are closed while it is unknown.
      if (this.gatewayPort === undefined && this.users > 0) {
        const s = await this.statusOn(c.conn)
        if (s.ok && this.conn === c.conn) this.gatewayPort = s.status.port
      }
      try {
        return this.ok(await addDeviceToken(this.execOn(c.conn), via.host, via.ccc))
      } catch (err) {
        return failure(errorText(err), true)
      }
    })
  }

  async acquire(answers: LinkAnswers = {}): Promise<LinkResult<number>> {
    if (this.disposed) return { ok: false, error: this.closedText() }
    // Counted before the work, so the idle stop cannot fire under it; uncounted again on failure.
    this.users++
    this.clearIdle()
    const result = await this.call(async () => {
      const c = await this.connect(answers, false)
      if (!c.ok) return c
      if (this.gatewayPort === undefined) {
        const s = await this.statusOn(c.conn)
        if (!s.ok) return s
        this.gatewayPort = s.status.port
      }
      const l = await this.openListener()
      if ('error' in l) return failure(l.error, true)
      if (!this.probed && this.conn === c.conn) {
        const p = await this.probe(c.conn, this.gatewayPort)
        if (p !== undefined) return failure(p, false)
        this.probed = true
      }
      this.markUp()
      return this.ok(l.port)
    })
    if (!result.ok) this.release()
    return result
  }

  release(): void {
    if (this.users > 0) this.users--
    this.armIdle()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
  }

  // -------------------------------------------------------------------------------------------
  // Calls

  /** Runs one public call: counted as busy (no idle stop under it), its failure made public. */
  private async call<T>(work: () => Promise<LinkResult<T> | Failure>): Promise<LinkResult<T>> {
    if (this.disposed) return { ok: false, error: this.closedText() }
    this.busy++
    this.clearIdle()
    try {
      const result = await work()
      return result.ok ? result : publicFailure(result)
    } catch (err) {
      // Nothing above throws by design; a bug must still answer the picker, not hang it.
      return { ok: false, error: errorText(err) }
    } finally {
      this.busy--
      this.armIdle()
    }
  }

  private ok<T>(value: T): LinkResult<T> {
    const accepted: LinkAccepted = {}
    const key = this.accepted.hostKey
    const saved = this.options.store.get(this.id)?.hostKey
    if (key !== undefined && (saved === undefined || saved.sha256 !== key.sha256 || saved.type !== key.type)) accepted.hostKey = { ...key }
    if (this.accepted.password) accepted.password = true
    if (this.accepted.passphrase) accepted.passphrase = true
    return { ok: true, value, accepted }
  }

  private via(): Extract<RemoteServerRecord['via'], { kind: 'ssh' }> | undefined {
    const record = this.options.store.get(this.id)
    return record?.via.kind === 'ssh' ? record.via : undefined
  }

  private hostLabel(): string {
    return this.via()?.host ?? 'the server'
  }

  private closedText(): string {
    return `the connection to ${this.hostLabel()} was closed`
  }

  private execOn(conn: SshConnection): RemoteExec {
    return (command) => conn.exec(command, { maxBytes: EXEC_MAX_BYTES, timeoutMs: EXEC_TIMEOUT_MS })
  }

  private async statusOn(conn: SshConnection): Promise<{ ok: true; status: RemoteStatus } | Failure> {
    const via = this.via()
    if (via === undefined) return failure('this server is not saved any more', false)
    try {
      return { ok: true, status: await serverStatus(this.execOn(conn), via.host, via.ccc) }
    } catch (err) {
      return failure(errorText(err), true)
    }
  }

  // -------------------------------------------------------------------------------------------
  // The connection

  /** The live connection, or a dial for one (a dial in progress is waited for first). */
  private async connect(answers: LinkAnswers, background: boolean): Promise<{ ok: true; conn: SshConnection } | Failure> {
    if (this.disposed) return failure(this.closedText(), false)
    if (this.conn !== undefined) return { ok: true, conn: this.conn }
    if (this.dialing !== undefined) {
      // Its answers may not be ours (a background redial has none): if it failed, dial with ours.
      await this.dialing
      if (this.conn !== undefined) return { ok: true, conn: this.conn }
      if (this.disposed) return failure(this.closedText(), false)
    }
    const run = this.dialOnce(answers, background)
    this.dialing = run
    try {
      return await run
    } finally {
      if (this.dialing === run) this.dialing = undefined
    }
  }

  private async dialOnce(answers: LinkAnswers, background: boolean): Promise<{ ok: true; conn: SshConnection } | Failure> {
    const gen = this.gen
    const record = this.options.store.get(this.id)
    if (record === undefined || record.via.kind !== 'ssh') return failure('this server is not saved any more', false)
    const via = record.via
    const host = via.host
    if (this.redialTimer === undefined) this.setState({ state: 'connecting' })

    let config: SshConfigResult
    try {
      config = await this.resolveConfig(host)
    } catch {
      config = { identityFiles: [], jump: false, matchSkipped: false, notes: [] }
    }
    // The record wins over the config (§5.5); the built-in client does not hop (§0 non-goals).
    if (config.jump) {
      return this.dialFailed(failure('This host goes through a jump host (ProxyJump or ProxyCommand in ~/.ssh/config): use My own tunnel.', false), background)
    }
    const hostName = config.hostName ?? host
    const port = via.port ?? config.port ?? 22
    const username = via.user ?? config.user ?? this.localUser()
    if (username === '') return this.dialFailed(failure('no user name to sign in with: fill in User', false), background)

    const known = await this.readKnownHosts().catch(() => '')
    const preferred: string[] = []
    if (record.hostKey !== undefined) preferred.push(record.hostKey.type)
    for (const type of knownHostKeyTypes(knownHostKeys(hostName, port, known))) if (!preferred.includes(type)) preferred.push(type)

    const signIn = await this.signIn(sshAuthOf(via), config, answers)
    if (!('handler' in signIn)) return this.dialFailed(signIn, background)

    const check: HostCheck = {}
    const saved = record.hostKey
    const answeredKey = background ? undefined : answers.hostKey
    const hostVerifier = (blob: Buffer): boolean => {
      const type = keyBlobType(blob)
      if (type === null) {
        check.verdict = 'unreadable'
        return false
      }
      const seen: RemoteHostKey = { type, sha256: fingerprint(blob) }
      check.seen = seen
      const verdict = checkKnownHost(hostName, port, type, blob, known)
      // A revoked key is revoked for every host and every record, whatever else vouches for it.
      if (verdict === 'revoked') {
        check.verdict = 'revoked'
        return false
      }
      if (saved !== undefined) {
        // §5.3 step 1: the record decides alone; a mismatch is never a question, so the answers are not read.
        check.verdict = saved.sha256 === seen.sha256 && saved.type === seen.type ? 'record' : 'changed'
        return check.verdict === 'record'
      }
      if (verdict === 'trusted') {
        check.verdict = 'known'
        return true
      }
      if (verdict === 'changed') {
        check.verdict = 'known-changed'
        return false
      }
      // Unknown: only the person's answer for exactly this key lets it through.
      check.verdict = answeredKey !== undefined && answeredKey === seen.sha256 ? 'answer' : 'unknown'
      return check.verdict === 'answer'
    }

    let conn: SshConnection
    try {
      conn = await this.dialFn({
        host: hostName,
        port,
        username,
        authHandler: signIn.handler,
        hostVerifier,
        preferredHostKeyTypes: preferred,
        readyTimeout: signIn.agentTried ? AGENT_READY_TIMEOUT_MS : READY_TIMEOUT_MS
      })
    } catch (err) {
      return this.dialFailed(this.dialFailure(err as SshError, check, signIn.track, { host, hostName, port }), background)
    }
    if (gen !== this.gen || this.disposed) {
      // Stopped (released, forgotten, quitting) while dialling: this connection is nobody's.
      conn.end()
      return failure(this.closedText(), false)
    }
    this.conn = conn
    this.gatewayPort = undefined
    this.probed = false
    this.accepted = {
      ...(check.verdict === 'known' || check.verdict === 'answer' ? { hostKey: check.seen } : {}),
      ...signIn.fromAnswers
    }
    this.upSince = this.timers.now()
    this.clearRedial()
    conn.onClose((error) => this.closed(conn, error))
    // A redial is up only once `web status` named the gateway port again (`redial`): until then a
    // page's socket would be closed, so "up" would be a lie the windows act on.
    if (!background) this.markUp()
    return { ok: true, conn }
  }

  /** A failed dial's state: a background redial decides its own (see `redial`); a foreground one says why. */
  private dialFailed(f: Failure, background: boolean): Failure {
    if (!background && this.redialTimer === undefined && this.conn === undefined) {
      if (!('need' in f)) this.setState({ state: 'down', error: f.error })
      else this.setState(this.listener === undefined ? { state: 'stopped' } : { state: 'down', error: 'waiting for sign-in' })
    }
    return f
  }

  private localUser(): string {
    if (this.options.localUser) return this.options.localUser()
    try {
      return userInfo().username
    } catch {
      return this.options.env()['USER'] ?? ''
    }
  }

  /**
   * The sign-in of one dial (§5.1), with everything read before the dial: the key files parsed (a
   * locked one is skipped under auto and asked for under key), the secret taken from the answers or
   * the store. A key-file problem ends the call before any dial.
   */
  private async signIn(auth: SshAuth, config: SshConfigResult, answers: LinkAnswers): Promise<SignIn | Failure> {
    const home = this.options.home
    const track: SignInTrack = {
      kind: auth.kind,
      methods: [],
      agentTried: false,
      keysTried: 0,
      lockedKeys: [],
      badKeys: [],
      passwordMissing: false,
      passwordSent: false,
      passwordWrong: false,
      partial: false,
      keySent: false
    }
    const fromAnswers: SignIn['fromAnswers'] = {}

    if (auth.kind === 'auto') {
      const agent = agentSocketOf(config.identityAgent, this.options.env())
      const paths = config.identityFiles.length > 0 ? config.identityFiles : DEFAULT_KEY_FILES.map((name) => join(home, '.ssh', name))
      const keys: SshPrivateKey[] = []
      for (const path of paths) {
        const read = await this.readKeyFile(path)
        if ('missing' in read) continue
        if ('problem' in read) {
          track.badKeys.push(`${shownPath(path, home)}: ${read.problem}`)
          continue
        }
        const parsed = parseKey(read.data)
        if (parsed.kind === 'ok') keys.push(parsed.key)
        else if (parsed.kind === 'needs-passphrase') track.lockedKeys.push(shownPath(path, home))
        else track.badKeys.push(`${shownPath(path, home)}: not a key this app can read`)
      }
      const steps: SshAuthMethod[] = keys.map((key) => ({ type: 'publickey' as const, key }))
      if (agent !== undefined) steps.unshift({ type: 'agent', agent })
      const handler: SshAuthHandler = (left, partial) => {
        if (left === null) return { type: 'none' }
        track.methods = left
        if (partial) {
          track.partial = true
          return false
        }
        if (!left.includes('publickey')) return false
        const next = steps.shift()
        if (next === undefined) return false
        if (next.type === 'agent') track.agentTried = true
        else track.keysTried++
        return next
      }
      return { handler, track, agentTried: agent !== undefined, fromAnswers }
    }

    if (auth.kind === 'password') {
      const answered = answers.password !== undefined && answers.password !== '' ? answers.password : undefined
      const password = answered ?? (await this.options.store.getSecret(this.id, 'password'))
      if (answered !== undefined) fromAnswers.password = true
      let passwordPrompt: string | undefined
      const onRound = (round: SshPromptRound): SshPromptAnswer => {
        if (round.prompts.length === 0) return []
        const only = round.prompts.length === 1 ? round.prompts[0] : undefined
        if (only !== undefined && !only.echo && password !== undefined) {
          // The first echo-off prompt is the password. The same prompt again means it was wrong (PAM
          // asks again): never resent. Any other prompt (a code, a question) is more than we answer.
          if (passwordPrompt === undefined) {
            passwordPrompt = only.prompt
            track.passwordSent = true
            return [password]
          }
          if (only.prompt === passwordPrompt) {
            track.passwordWrong = true
            return { fail: 'the password was not accepted' }
          }
        }
        track.extraPrompt = shownText(round.prompts.map((p) => p.prompt).join(' ') || round.name || round.instructions, 120)
        return { fail: 'the server asks for more than a password' }
      }
      const handler: SshAuthHandler = (left, partial) => {
        if (left === null) return { type: 'none' }
        track.methods = left
        if (partial) {
          track.partial = true
          return false
        }
        if (track.passwordSent) {
          // Sent once and the server is asking again: it was refused.
          if (track.extraPrompt === undefined) track.passwordWrong = true
          return false
        }
        if (password === undefined) {
          track.passwordMissing = true
          return false
        }
        if (left.includes('password')) {
          track.passwordSent = true
          return { type: 'password', password }
        }
        if (left.includes('keyboard-interactive')) return { type: 'keyboard-interactive', onRound }
        return false
      }
      return { handler, track, agentTried: false, fromAnswers }
    }

    // A key file: read and parsed before dialling (§5.1).
    const path = expandPath(auth.path, home)
    const read = await this.readKeyFile(path)
    if ('missing' in read) return failure(`The key file ${auth.path} does not exist.`, false)
    if ('problem' in read) return failure(`The key file ${auth.path} cannot be used: ${read.problem}.`, false)
    let parsed = parseKey(read.data)
    if (parsed.kind === 'needs-passphrase') {
      const answered = answers.passphrase !== undefined && answers.passphrase !== '' ? answers.passphrase : undefined
      const passphrase = answered ?? (await this.options.store.getSecret(this.id, 'passphrase'))
      if (passphrase === undefined) return { ok: false, need: { need: 'passphrase', path: auth.path } }
      parsed = parseKey(read.data, passphrase)
      if (parsed.kind === 'wrong-passphrase' || parsed.kind === 'needs-passphrase') {
        return { ok: false, need: { need: 'passphrase', path: auth.path, again: true } }
      }
      if (answered !== undefined) fromAnswers.passphrase = true
    }
    if (parsed.kind !== 'ok') {
      return failure(`The key file ${auth.path} is not a private key this app can read (FIDO and certificate keys need My own tunnel).`, false)
    }
    const key = parsed.key
    const handler: SshAuthHandler = (left, partial) => {
      if (left === null) return { type: 'none' }
      track.methods = left
      if (partial) {
        track.partial = true
        return false
      }
      if (track.keySent || !left.includes('publickey')) return false
      track.keySent = true
      return { type: 'publickey', key }
    }
    return { handler, track, agentTried: false, fromAnswers }
  }

  /** A failed dial as one plain line, a `need`, and whether a redial may try again. */
  private dialFailure(err: SshError, check: HostCheck, track: SignInTrack, where: { host: string; hostName: string; port: number }): Failure {
    const { host } = where
    const passed = check.verdict === undefined || check.verdict === 'record' || check.verdict === 'known' || check.verdict === 'answer'
    if (err.hostKeyRefused === true || !passed) {
      switch (check.verdict) {
        case 'unknown':
          if (check.seen !== undefined) {
            const address = addressOf(where.hostName, where.port)
            return { ok: false, need: { need: 'hostKey', type: check.seen.type, sha256: check.seen.sha256, address } }
          }
          break
        case 'changed':
          return failure(`The host key of ${host} changed. If the server was reinstalled, Forget the trusted key in Edit.`, false)
        case 'known-changed':
          return failure(
            `The host key of ${host} does not match the one in ~/.ssh/known_hosts. ` +
              `If the server was reinstalled, remove its old line there (ssh-keygen -R ${where.hostName}).`,
            false
          )
        case 'revoked':
          return failure(`The host key of ${host} is marked @revoked in ~/.ssh/known_hosts.`, false)
        case 'unreadable':
          return failure(`${host} sent a host key this app cannot read.`, false)
        default:
          break
      }
      return failure(`The host key of ${host} was refused.`, false)
    }
    if (err.level === 'client-authentication' || err.level === 'auth-handler') return this.authFailure(err, track, host)
    if (err.level === 'client-timeout') return failure(`${host} did not answer in time (the SSH sign-in took too long).`, true)
    const code = (err as SshError & { code?: unknown }).code
    if (code === 'ECONNREFUSED') return failure(`Could not reach ${host}: the connection was refused.`, true)
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return failure(`Could not find the host ${host} (its name does not resolve).`, true)
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return failure(`Could not reach ${host}: the connection timed out.`, true)
    }
    return failure(`SSH to ${host} failed: ${shownText(err.message)}`, true)
  }

  private authFailure(err: SshError, track: SignInTrack, host: string): Failure {
    const offers = track.methods.length > 0 ? ` (it offers: ${track.methods.join(', ')})` : ''
    if (track.partial) return failure(`${host} asks for a second sign-in step: use My own tunnel.`, false)
    if (track.kind === 'password') {
      if (track.extraPrompt !== undefined) return failure(`${host} asks for more than a password ("${track.extraPrompt}"): use My own tunnel.`, false)
      if (track.passwordMissing) return { ok: false, need: { need: 'password' } }
      if (track.passwordWrong) return { ok: false, need: { need: 'password', again: true } }
      return failure(`${host} does not take a password${offers}. Choose Key file or Agent and my keys.`, false)
    }
    if (track.kind === 'key') {
      if (!track.keySent) return failure(`${host} does not take keys${offers}.`, false)
      const via = this.via()
      const auth = via === undefined ? undefined : sshAuthOf(via)
      return failure(`${host} did not accept the key ${auth?.kind === 'key' ? auth.path : 'file'}.`, false)
    }
    // auto
    const notes: string[] = []
    if (err.agentError !== undefined) notes.push(`the SSH agent could not be used (${shownText(err.agentError, 120)})`)
    for (const path of track.lockedKeys) notes.push(`${path} needs a passphrase: choose Key file`)
    for (const bad of track.badKeys) notes.push(bad)
    const tail = notes.length > 0 ? ` ${notes.join('; ')}.` : ''
    if (track.methods.length > 0 && !track.methods.includes('publickey')) {
      return failure(`${host} does not take keys${offers}. Choose Password.${tail}`, false)
    }
    if (!track.agentTried && track.keysTried === 0) {
      return failure(`No SSH agent and no usable key in ~/.ssh to sign in to ${host} with: choose Password or Key file.${tail}`, false)
    }
    return failure(`${host} accepted none of your keys.${tail}`, false)
  }

  /** The connection closed by itself (a drop, the server going away), or a stop/drop of ours (ignored). */
  private closed(conn: SshConnection, error: SshError | undefined): void {
    if (this.conn !== conn) return
    this.conn = undefined
    this.accepted = {}
    this.gatewayPort = undefined
    this.probed = false
    this.closePipes()
    if (this.disposed) return
    const host = this.hostLabel()
    const text = error === undefined ? `the connection to ${host} closed` : `the connection to ${host} dropped: ${shownText(error.message, 160)}`
    if (this.users > 0) {
      if (this.timers.now() - this.upSince >= BACKOFF_RESET_MS) this.failures = 0
      this.scheduleRedial(text)
    } else this.setState({ state: 'down', error: text })
  }

  /** End the live connection ourselves (no redial follows from its close). */
  private dropConnection(): void {
    const conn = this.conn
    this.conn = undefined
    this.accepted = {}
    this.gatewayPort = undefined
    this.probed = false
    this.closePipes()
    conn?.end()
  }

  private scheduleRedial(error: string): void {
    this.clearRedial()
    const delay = REDIAL_BACKOFF_MS[Math.min(this.failures, REDIAL_BACKOFF_MS.length - 1)] as number
    this.failures++
    this.setState({ state: 'down', error, retryInMs: delay })
    this.redialTimer = this.timers.setTimeout(() => {
      this.redialTimer = undefined
      void this.redial()
    }, delay)
  }

  /** A background redial (§5.2): no answers, the store's secrets only; `web status` again on success. */
  private async redial(): Promise<void> {
    if (this.users === 0 || this.disposed || this.conn !== undefined) return
    this.busy++
    try {
      const c = await this.connect({}, true)
      if (this.disposed) return
      if (!c.ok) {
        if ('need' in c) this.setState({ state: 'down', error: this.backgroundNeedText(c.need) })
        else if (!c.retry) this.setState({ state: 'down', error: c.error })
        else if (this.users > 0) this.scheduleRedial(c.error)
        else this.setState({ state: 'down', error: c.error })
        return
      }
      const s = await this.statusOn(c.conn)
      if (this.conn !== c.conn) return
      if (!s.ok) {
        // SSH answers but the cockpit does not (yet): restarting. Try the whole thing again later.
        this.dropConnection()
        if (this.users > 0) this.scheduleRedial('error' in s ? s.error : 'the server did not answer')
        else this.setState({ state: 'down', error: 'error' in s ? s.error : 'the server did not answer' })
        return
      }
      this.gatewayPort = s.status.port
      this.markUp()
    } finally {
      this.busy--
      this.armIdle()
    }
  }

  /** A `need` met in the background, where nobody can be asked: stop and say how to go on. */
  private backgroundNeedText(need: LinkNeed): string {
    const host = this.hostLabel()
    if (need.need === 'hostKey') return `The host key of ${host} is not trusted yet: open the server from the picker.`
    if (need.need === 'password') return `${host} needs the password again: open the server from the picker.`
    return `The key ${need.path} needs its passphrase again: open the server from the picker.`
  }

  // -------------------------------------------------------------------------------------------
  // The tunnel

  private async openListener(): Promise<LinkListener | { error: string }> {
    if (this.listener !== undefined) return this.listener
    const gen = this.gen
    if (this.opening === undefined) {
      this.opening = this.listen(this.options.store.get(this.id)?.localPort, (socket) => this.accept(socket))
    }
    const opening = this.opening
    let listener: LinkListener
    try {
      listener = await opening
    } catch (err) {
      return { error: `could not open a local port for the tunnel: ${errorText(err)}` }
    } finally {
      if (this.opening === opening) this.opening = undefined
    }
    if (gen !== this.gen || this.disposed) {
      listener.close()
      return { error: this.closedText() }
    }
    this.listener ??= listener
    if (this.listener !== listener) listener.close()
    return this.listener
  }

  /** One page connection: piped to a `forwardOut` channel, or closed at once while the link is down. */
  private accept(socket: Socket): void {
    socket.on('error', () => {})
    const conn = this.conn
    const port = this.gatewayPort
    if (conn === undefined || port === undefined || this.disposed) {
      socket.destroy()
      return
    }
    this.pipes.add(socket)
    socket.once('close', () => this.pipes.delete(socket))
    void this.forward(conn, socket, port, true)
  }

  /**
   * Pipe `socket` to a `forwardOut` channel to the gateway's `port`. A channel the server refuses
   * (CHANNEL_OPEN_FAILURE: nothing listens there) while the connection stays up may mean the
   * server's cockpit restarted on another gateway port, which only a redial used to notice: then
   * `web status` runs again (throttled) and, when the port moved, the socket is tried once more there.
   */
  private async forward(conn: SshConnection, socket: Socket, port: number, retry: boolean): Promise<void> {
    let channel: Duplex
    try {
      channel = await conn.forwardOut(socket.remotePort ?? 0, port)
    } catch (err) {
      const refused = typeof (err as { reason?: unknown }).reason === 'number'
      const moved = refused && retry && !socket.destroyed ? await this.recheckGateway(conn) : undefined
      if (moved !== undefined && moved !== port && !socket.destroyed && this.conn === conn) return this.forward(conn, socket, moved, false)
      socket.destroy()
      return
    }
    if (socket.destroyed || this.conn !== conn) {
      channel.destroy()
      return
    }
    this.pipes.add(channel)
    const closeBoth = (): void => {
      this.pipes.delete(channel)
      socket.destroy()
      channel.destroy()
    }
    channel.on('error', closeBoth)
    channel.on('close', closeBoth)
    socket.on('close', closeBoth)
    socket.pipe(channel)
    channel.pipe(socket)
  }

  /**
   * The gateway port after a refused page channel: `web status` again on the live connection, at most
   * once per GATEWAY_RECHECK_MS (sockets refused meanwhile share the run in flight, or get the port
   * as it stands). A failed status keeps the port: the page's own reconnect tries again later.
   */
  private recheckGateway(conn: SshConnection): Promise<number | undefined> {
    if (this.rechecking !== undefined) return this.rechecking
    const now = this.timers.now()
    if (now - this.lastRecheck < GATEWAY_RECHECK_MS) return Promise.resolve(this.gatewayPort)
    this.lastRecheck = now
    this.busy++
    const run = this.statusOn(conn)
      .then((s) => {
        if (s.ok && this.conn === conn) this.gatewayPort = s.status.port
        return this.conn === conn ? this.gatewayPort : undefined
      })
      .finally(() => {
        this.rechecking = undefined
        this.busy--
        this.armIdle()
      })
    this.rechecking = run
    return run
  }

  /**
   * One channel opened and closed before the first window loads (§5.2 "First use"): a server with
   * forwarding off is said so, not a page that never loads. Undefined when it worked.
   */
  private async probe(conn: SshConnection, port: number): Promise<string | undefined> {
    const host = this.hostLabel()
    try {
      const channel = await conn.forwardOut(0, port)
      channel.destroy()
      return undefined
    } catch (err) {
      const reason = (err as { reason?: unknown }).reason
      if (reason === OPEN_ADMINISTRATIVELY_PROHIBITED) return `TCP forwarding is disabled on ${host} (AllowTcpForwarding in its sshd_config).`
      if (reason === OPEN_CONNECT_FAILED) return `Nothing answers on the web gateway's port ${port} on ${host}.`
      return `The tunnel to ${host} could not be opened: ${shownText(errorText(err), 160)}`
    }
  }

  private closePipes(): void {
    for (const pipe of [...this.pipes]) pipe.destroy()
    this.pipes.clear()
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle

  private markUp(): void {
    if (this.conn === undefined) return
    this.setState(this.listener === undefined ? { state: 'up' } : { state: 'up', localPort: this.listener.port })
  }

  private armIdle(): void {
    if (this.users > 0 || this.busy > 0 || this.disposed || this.idleTimer !== undefined) return
    if (this.conn === undefined && this.listener === undefined && this.redialTimer === undefined) return
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined
      if (this.users === 0 && this.busy === 0) this.stop()
    }, IDLE_STOP_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer === undefined) return
    this.timers.clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private clearRedial(): void {
    if (this.redialTimer === undefined) return
    this.timers.clearTimeout(this.redialTimer)
    this.redialTimer = undefined
  }

  /** Connection, listener, sockets and timers gone; the next call starts from scratch. */
  private stop(): void {
    this.gen++
    this.users = 0
    this.clearIdle()
    this.clearRedial()
    this.dropConnection()
    this.listener?.close()
    this.listener = undefined
    this.failures = 0
    this.setState({ state: 'stopped' })
  }

  private setState(state: LinkState): void {
    this.current = state
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state)
      } catch {
        // One listener's failure must not keep the others (or the link) from going on.
      }
    }
  }
}
