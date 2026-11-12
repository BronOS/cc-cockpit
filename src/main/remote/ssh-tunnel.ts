// SSH to a cc-cockpit server (design-remote-desktop.md §5.1, §5.2, §5.4, §8): the two `ccc web`
// commands run over SSH, and the per-server `ssh -N -L` tunnel a remote window loads through.
//
// Plain logic over the spawn adapter (ssh-process.ts), with every clock, port probe and connect
// check injectable: unit tests drive it with a fake `ssh` and fake timers.
//
// Trust: the app never shows a password or passphrase prompt and never answers a host-key question
// (BatchMode). A failure is ssh's own last stderr line, mapped to plain words for the common ones,
// with the one command that fixes most of them. Everything the remote prints is untrusted: only the
// last stdout line is read, it is parsed with JSON.parse or URL and checked field by field, and any
// text from it that reaches a message is capped and stripped of control characters.
import { createServer, connect as netConnect } from 'node:net'
import { REMOTE_CCC_MISSING, checkSshHost, isLocalPort, remoteCommand } from '../../shared/remote-servers'
import { lastLine, parseAddDeviceToken, parseServerStatus, shownText, type RemoteStatus } from './remote-status'
import type { SshExit, SshProcess, SshSpawn } from './ssh-process'

export type { RemoteStatus }

/**
 * On every run (design §5.1). The person's `ssh_config` is honoured except what breaks a managed
 * child: a ControlMaster would take over the forward and let our child exit (restart and kill
 * tracking fail), a configured RemoteCommand conflicts with ours, and a configured LocalForward
 * failing would be misread as "port L taken". `-T`: no tty, so no RequestTTY either.
 */
export const SSH_COMMON_OPTIONS: readonly string[] = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'RemoteCommand=none',
  '-o',
  'ClearAllForwardings=yes'
]

/** A `ccc web` command over SSH is killed after this (ConnectTimeout is 10 s; the command itself answers in well under one). */
export const REMOTE_TIMEOUT_MS = 20_000
/** stdout kept: its tail, so rc-file noise before the answer cannot push the answer out. */
const MAX_STDOUT = 64 * 1024
/** stderr kept: its tail (the last line is the error; warnings come before it). */
const MAX_STDERR = 4096

/** The fix for host-key and key-auth failures: the app never answers those itself (design §5.1). */
function sshHint(host: string): string {
  return `Run \`ssh ${host}\` once in a terminal (accept the host key; add your key to the agent).`
}

/** A refused or failed SSH step; the message is shown to the person as is. */
export class SshError extends Error {
  override name = 'SshError'
}

/** The injectable clock. The defaults read the globals at call time (vitest's fake timers replace them). */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now()
}

/**
 * ssh's failure in plain words, from its last stderr line (OpenSSH's own wording). The hint goes
 * only where the person's terminal is the fix: the host key and key auth. A line we do not know is
 * shown as ssh wrote it.
 */
export function sshFailureText(host: string, stderr: string, exit: SshExit): string {
  if (exit.error !== undefined) return exit.error
  const line = lastLine(stderr)
  const lower = line.toLowerCase()
  if (lower.includes('host key verification failed')) {
    return `ssh could not verify the host key of ${host}. ${sshHint(host)}`
  }
  if (lower.includes('permission denied')) {
    return `ssh to ${host} was refused: no key the agent offers was accepted (the app never asks for a password or passphrase). ${sshHint(host)}`
  }
  if (lower.includes('could not resolve')) return `ssh could not find the host ${host} (its name does not resolve).`
  if (lower.includes('connection timed out') || lower.includes('operation timed out')) {
    return `ssh could not reach ${host}: the connection timed out.`
  }
  if (lower.includes('connection refused')) return `ssh could not reach ${host}: the connection was refused.`
  if (line !== '') return shownText(line)
  return exit.signal !== null ? `ssh to ${host} was stopped (${exit.signal})` : `ssh to ${host} failed (exit code ${String(exit.code)})`
}

export interface RunOptions {
  timers?: Timers
  timeoutMs?: number
}

/**
 * The argv of a `ccc <args>` run on `host`: the common options, `--`, the host, and the ONE remote
 * command string (`remoteCommand`: the fixed `sh -c` script, every word single-quoted). Throws
 * `SshError` on a host or override that may not go to ssh.
 */
export function remoteArgv(host: string, args: readonly string[], override?: string): string[] {
  const bad = checkSshHost(host)
  if (bad !== undefined) throw new SshError(`this host cannot be used: ${bad}`)
  let command: string
  try {
    command = remoteCommand(args, override)
  } catch (err) {
    throw new SshError(err instanceof Error ? err.message : String(err))
  }
  return ['ssh', ...SSH_COMMON_OPTIONS, '--', host, command]
}

/**
 * Run `ccc <args>` on `host` and resolve with the last non-empty stdout line. Bounded: killed
 * (SIGKILL, its group) after `REMOTE_TIMEOUT_MS`. Rejects with an `SshError` whose message is for
 * the person: the remote has no `ccc` (the script's marker line), printed nothing (the wrapper
 * exits 0 silently when no app runs there), or ssh failed (`sshFailureText`).
 */
export function runRemote(spawn: SshSpawn, host: string, args: readonly string[], override?: string, options: RunOptions = {}): Promise<string> {
  const timers = options.timers ?? realTimers
  const timeoutMs = options.timeoutMs ?? REMOTE_TIMEOUT_MS
  let argv: string[]
  try {
    argv = remoteArgv(host, args, override)
  } catch (err) {
    return Promise.reject(err)
  }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(argv)
    const timer = timers.setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new SshError(`ssh to ${host} did not finish in ${Math.round(timeoutMs / 1000)} s and was stopped.`))
    }, timeoutMs)
    child.onStdout((text) => {
      stdout += text
      if (stdout.length > MAX_STDOUT) stdout = stdout.slice(-MAX_STDOUT)
    })
    child.onStderr((text) => {
      stderr += text
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR)
    })
    child.onExit((exit) => {
      if (settled) return
      settled = true
      timers.clearTimeout(timer)
      const line = lastLine(stdout)
      // Before the exit code: the script exits 127 with the marker as its last line.
      if (line === REMOTE_CCC_MISSING) {
        reject(new SshError(`cc-cockpit's ccc was not found on ${host}. Set the path to ccc in the server's settings, or install cc-cockpit there.`))
        return
      }
      if (exit.error !== undefined || exit.code !== 0) {
        reject(new SshError(sshFailureText(host, stderr, exit)))
        return
      }
      if (line === '') {
        reject(new SshError(`cc-cockpit is not installed on ${host}, or the server is not running.`))
        return
      }
      resolve(line)
    })
  })
}

/** `ccc web status --json` on `host` over the spawned ssh; the parsing is remote-status.ts's. */
export async function serverStatus(spawn: SshSpawn, host: string, override?: string, options: RunOptions = {}): Promise<RemoteStatus> {
  return parseServerStatus(host, await runRemote(spawn, host, ['web', 'status', '--json'], override, options))
}

/** `ccc web add-device` on `host` over the spawned ssh: the token only (remote-status.ts parses it). */
export async function addDeviceToken(spawn: SshSpawn, host: string, override?: string, options: RunOptions = {}): Promise<string> {
  return parseAddDeviceToken(host, await runRemote(spawn, host, ['web', 'add-device'], override, options))
}

// ---------------------------------------------------------------------------------------------
// The tunnel

/** How the tunnel is doing, for the picker and the window's banner. */
export type TunnelState =
  | { state: 'stopped' }
  | { state: 'connecting' }
  | { state: 'up'; localPort: number }
  /** `retryInMs`: a restart is scheduled (windows are open); absent: nothing will happen by itself. */
  | { state: 'down'; error: string; retryInMs?: number }

/** Local port checks; the default (`netPortProbe`) binds and closes on 127.0.0.1. */
export interface PortProbe {
  /** `port` can be bound on 127.0.0.1 right now. */
  isFree(port: number): Promise<boolean>
  /** A port the OS just handed out on 127.0.0.1:0 (bound and closed again). */
  freePort(): Promise<number>
}

/** One TCP connect attempt to 127.0.0.1:`port`: true when it is accepted. Never rejects. */
export type ConnectCheck = (port: number) => Promise<boolean>

export const netPortProbe: PortProbe = {
  isFree: (port) =>
    new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)))
    }),
  freePort: () =>
    new Promise((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        server.close(() => (port > 0 ? resolve(port) : reject(new Error('no free local port'))))
      })
    })
}

/** How long one connect attempt may take before it counts as refused. */
const CONNECT_ATTEMPT_MS = 1000

export const netConnectCheck: ConnectCheck = (port) =>
  new Promise((resolve) => {
    const socket = netConnect({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), CONNECT_ATTEMPT_MS)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })

/** ssh must confirm its listener (and the port accept) within this, else the start fails (ConnectTimeout is 10 s). */
export const TUNNEL_READY_MS = 15_000
/** Between connect checks once ssh has confirmed its listener. */
const READY_POLL_MS = 100
/** An unfinished stderr line longer than this is dropped (`-v` output is many short lines). */
const MAX_PARTIAL_LINE = 4096
/** Fresh ports tried after the first when ssh says the chosen one is taken (design §5.1). */
const PORT_RETRIES = 2
/** Restart delays after an unexpected exit; the last one repeats. */
export const RESTART_BACKOFF_MS: readonly number[] = [1000, 2000, 5000, 10_000]
/** A tunnel up this long before it dropped restarts from the first delay again. */
export const BACKOFF_RESET_MS = 60_000
/** A server's tunnel stays this long after its last window closed (a quick reopen reuses it). */
export const IDLE_STOP_MS = 30_000
/** After SIGTERM, ssh gets this long before SIGKILL. */
export const KILL_GRACE_MS = 2000

/** The argv of the tunnel `127.0.0.1:local` → the server's `127.0.0.1:remote` (design §5.1). */
export function tunnelArgv(host: string, local: number, remote: number): string[] {
  const bad = checkSshHost(host)
  if (bad !== undefined) throw new SshError(`this host cannot be used: ${bad}`)
  return [
    'ssh',
    ...SSH_COMMON_OPTIONS,
    '-o',
    // Without it a taken local port is only a warning and ssh stays up with no forward.
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    // Debug level 1: the only way to learn from ssh itself that it bound OUR port (see TunnelLog).
    '-v',
    '-N',
    '-L',
    `127.0.0.1:${local}:127.0.0.1:${remote}`,
    '--',
    host
  ]
}

/** `text` holds `port` as a whole number (not inside a longer one: 8080 is not in 18080). */
function hasPortNumber(text: string, port: number): boolean {
  const needle = String(port)
  const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9'
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    if (!isDigit(text[at - 1]) && !isDigit(text[at + needle.length])) return true
  }
  return false
}

/**
 * ssh's stderr says the local port `port` could not be bound (taken between our probe and ssh's
 * bind). OpenSSH: `bind [127.0.0.1]:L: Address already in use`, `channel_setup_fwd_listener_tcpip:
 * cannot listen to port: L`. Only a line naming `port` counts: a failure about anything else is
 * not cured by another port.
 */
export function namesTakenPort(stderr: string, port: number): boolean {
  for (const raw of stderr.split('\n')) {
    const line = raw.toLowerCase()
    const portWords = line.includes('bind') || line.includes('address already in use') || line.includes('cannot listen to port')
    if (portWords && hasPortNumber(line, port)) return true
  }
  return false
}

/**
 * OpenSSH's own confirmation that the forward's listener is bound (channels.c,
 * `channel_setup_fwd_listener_tcpip`: `debug("Local forwarding listening on %s port %s.")`, the
 * same wording for many releases), seen at `-v`. The trailing `.` keeps 4100 from matching 41000.
 */
export function listeningText(port: number): string {
  return `Local forwarding listening on 127.0.0.1 port ${port}.`
}

/** A `-v` line that is not ssh's message to the person: debug output and the exit statistics. */
function isVerboseNoise(line: string): boolean {
  return line.startsWith('debug') || line.startsWith('Transferred:') || line.startsWith('Bytes per second:')
}

/**
 * One tunnel child's `ssh -v` stderr, read line by line as it arrives, keeping only what matters:
 *  - `listening`: ssh logged that IT bound 127.0.0.1:`port`. This, not a TCP connect, is what
 *    makes the tunnel ready. Why: a connect to 127.0.0.1:L succeeds for whoever holds L. If another
 *    local process (another OS user on a shared machine) grabbed L between our probe and ssh's
 *    bind, ssh fails to bind and exits, but a connect check could already have reached that
 *    process, and the window would then send it the device cookie: a credential leak, not a
 *    hiccup. ssh logs the line only after authenticating and binding, so with it L is ssh's.
 *    (A line of the same text could only come from the server's pre-auth banner, after its host key
 *    was verified: that server is where the cookie goes anyway.)
 *  - `portTaken`: a non-debug line says `port` could not be bound (`namesTakenPort`).
 *  - `tail`: the last non-noise lines (capped), so the error text is ssh's message and not the
 *    last of its debug chatter.
 */
class TunnelLog {
  listening = false
  portTaken = false
  tail = ''
  private partial = ''
  private readonly listenLine: string

  constructor(private readonly port: number) {
    this.listenLine = ` ${listeningText(port)}`
  }

  push(text: string): void {
    let data = this.partial + text
    for (let nl = data.indexOf('\n'); nl !== -1; nl = data.indexOf('\n')) {
      this.line(data.slice(0, nl))
      data = data.slice(nl + 1)
    }
    this.partial = data.length > MAX_PARTIAL_LINE ? '' : data
  }

  /** At exit: an unfinished last line counts too. */
  flush(): void {
    const rest = this.partial
    this.partial = ''
    this.line(rest)
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (line === '') return
    if (line.startsWith('debug')) {
      // `debug1: Local forwarding listening on 127.0.0.1 port L.` (a function-name prefix tolerated).
      if (line.endsWith(this.listenLine)) this.listening = true
      return
    }
    if (isVerboseNoise(line)) return
    if (namesTakenPort(line, this.port)) this.portTaken = true
    this.tail += `${line}\n`
    if (this.tail.length > MAX_STDERR) this.tail = this.tail.slice(-MAX_STDERR)
  }
}

export interface SshTunnelOptions {
  host: string
  spawn: SshSpawn
  probe?: PortProbe
  connect?: ConnectCheck
  timers?: Timers
  /** Every state change (the UI's banner and the picker's row). */
  onState?(state: TunnelState): void
  /** The local port a start settled on; the caller saves it (`RemoteServerStore.setLocalPort`) so the origin stays. */
  onPort?(port: number): void
}

type Attempt = { ok: true } | { ok: false; error: string; portTaken: boolean }

/**
 * One server's `ssh -N -L` (design §5.1). Windows `acquire()` it and `release()` it; `start()`
 * brings it up and resolves with the local port once ssh has logged that it bound that port (and
 * the port then accepts a connection): never on a connect alone, which anyone holding the port
 * would answer (TunnelLog).
 *
 * Lifecycle:
 *  - While wanted (acquired at least once and not released), an unexpected exit of an up tunnel
 *    restarts it with backoff (1, 2, 5, 10, 10… s; from 1 s again after 60 s up). A restart that
 *    fails schedules the next one. An explicit `start()` that fails only rejects: the caller shows
 *    the error, and nothing hammers a host that refused the key.
 *  - The last `release()` stops the tunnel after 30 s unless acquired again; a `start()` nobody
 *    acquires gets the same 30 s, so a connect abandoned before its window opened cannot leave ssh
 *    running.
 *  - `stop()` kills at once (SIGTERM, SIGKILL 2 s later); `dispose()` also refuses later starts.
 *
 * Each ssh child belongs to one generation (`gen`): a stop or a new start bumps it, so a late exit
 * or a late connect check of an old child changes nothing.
 */
export class SshTunnel {
  private readonly host: string
  private readonly spawn: SshSpawn
  private readonly probe: PortProbe
  private readonly connect: ConnectCheck
  private readonly timers: Timers
  private readonly options: SshTunnelOptions

  private users = 0
  private gen = 0
  private disposed = false
  private remotePort: number | undefined
  /** The port last settled on: a restart tries it first, so the windows' origin stays. */
  private localPort: number | undefined
  private child: SshProcess | undefined
  private starting: Promise<number> | undefined
  private upSince = 0
  /** Index into RESTART_BACKOFF_MS for the next restart. */
  private failures = 0
  private restartTimer: unknown
  private stopTimer: unknown
  private current: TunnelState = { state: 'stopped' }

  constructor(options: SshTunnelOptions) {
    const bad = checkSshHost(options.host)
    if (bad !== undefined) throw new SshError(`this host cannot be used: ${bad}`)
    this.options = options
    this.host = options.host
    this.spawn = options.spawn
    this.probe = options.probe ?? netPortProbe
    this.connect = options.connect ?? netConnectCheck
    this.timers = options.timers ?? realTimers
  }

  get state(): TunnelState {
    return this.current
  }

  /** The local port while up, else undefined. */
  get port(): number | undefined {
    return this.current.state === 'up' ? this.current.localPort : undefined
  }

  /** A window uses the tunnel: cancels a pending idle stop. */
  acquire(): void {
    this.users++
    this.clearStopTimer()
  }

  /** A window is gone; the last one schedules the stop. */
  release(): void {
    if (this.users > 0) this.users--
    if (this.users === 0) this.armStop()
  }

  /**
   * Bring the tunnel to the server's gateway port `remotePort` up and resolve with the local port.
   * `preferred` is the server's saved port, used when free. An up tunnel to the same port resolves
   * at once; a start in progress is shared; a tunnel to another port (the server moved) is replaced.
   */
  start(remotePort: number, preferred?: number): Promise<number> {
    if (this.disposed) return Promise.reject(new SshError('the tunnel is closed'))
    if (!isLocalPort(remotePort)) return Promise.reject(new SshError(`${this.host} reported no usable gateway port.`))
    if (this.remotePort === remotePort) {
      if (this.current.state === 'up') return Promise.resolve(this.current.localPort)
      if (this.starting !== undefined) return this.starting
    } else {
      this.killCurrent()
    }
    this.clearRestartTimer()
    this.remotePort = remotePort
    if (this.users === 0) this.armStop()
    return this.begin(preferred ?? this.localPort, false)
  }

  /** Kill now (SIGTERM, then SIGKILL after 2 s) and forget the wanted count: no restart follows. */
  stop(): void {
    this.users = 0
    this.clearStopTimer()
    this.clearRestartTimer()
    this.killCurrent()
    this.failures = 0
    this.setState({ state: 'stopped' })
  }

  /** Stop for good (the server was forgotten, the app quits). */
  dispose(): void {
    this.disposed = true
    this.stop()
  }

  private begin(preferred: number | undefined, restart: boolean): Promise<number> {
    const gen = ++this.gen
    const run = this.launch(gen, preferred)
    this.starting = run
    run.then(
      () => {
        if (this.starting === run) this.starting = undefined
      },
      (err: unknown) => {
        if (this.starting === run) this.starting = undefined
        if (gen !== this.gen) return
        const error = err instanceof Error ? err.message : String(err)
        // A restart that failed tries again while wanted; a first start reports and waits.
        if (restart && this.wanted()) this.scheduleRestart(error)
        else this.setState({ state: 'down', error })
      }
    )
    return run
  }

  private wanted(): boolean {
    return this.users > 0 && !this.disposed
  }

  private async launch(gen: number, preferred: number | undefined): Promise<number> {
    this.setState({ state: 'connecting' })
    let port = preferred !== undefined && isLocalPort(preferred) && (await this.probe.isFree(preferred)) ? preferred : await this.probe.freePort()
    for (let attempt = 0; ; attempt++) {
      if (gen !== this.gen) throw new SshError('the tunnel was stopped')
      const result = await this.runOnce(gen, port)
      if (gen !== this.gen) throw new SshError('the tunnel was stopped')
      if (result.ok) {
        this.localPort = port
        this.upSince = this.timers.now()
        this.options.onPort?.(port)
        this.setState({ state: 'up', localPort: port })
        return port
      }
      if (!result.portTaken || attempt >= PORT_RETRIES) throw new SshError(result.error)
      port = await this.probe.freePort()
    }
  }

  /**
   * One ssh child on `port`: resolves when ssh has logged that it bound `port` and the port then
   * accepts a connection, when ssh exits first, or when the ready deadline passes. The connect is
   * only a second check after ssh's own line, never readiness on its own (see TunnelLog).
   */
  private runOnce(gen: number, port: number): Promise<Attempt> {
    const remote = this.remotePort as number
    return new Promise((resolve) => {
      const log = new TunnelLog(port)
      let phase: 'waiting' | 'up' | 'done' = 'waiting'
      let poll: unknown
      let polling = false
      const child = this.spawn(tunnelArgv(this.host, port, remote))
      this.child = child
      const finish = (attempt: Attempt): void => {
        if (phase !== 'waiting') return
        this.timers.clearTimeout(deadline)
        this.timers.clearTimeout(poll)
        phase = attempt.ok ? 'up' : 'done'
        resolve(attempt)
      }
      const check = (): void => {
        if (phase !== 'waiting' || gen !== this.gen) return
        void this.connect(port).then((ok) => {
          if (phase !== 'waiting' || gen !== this.gen) return
          if (ok) finish({ ok: true })
          else poll = this.timers.setTimeout(check, READY_POLL_MS)
        })
      }
      child.onStderr((text) => {
        log.push(text)
        if (log.listening && !polling && phase === 'waiting') {
          polling = true
          check()
        }
      })
      child.onExit((exit) => {
        if (this.child === child) this.child = undefined
        log.flush()
        if (phase === 'waiting') {
          finish({ ok: false, error: sshFailureText(this.host, log.tail, exit), portTaken: log.portTaken })
          return
        }
        if (phase === 'up' && gen === this.gen) this.dropped(sshFailureText(this.host, log.tail, exit))
      })
      const deadline = this.timers.setTimeout(() => {
        if (phase !== 'waiting') return
        const said = lastLine(log.tail)
        // Settled first, so the exit the kill causes is not read as ssh's own failure.
        finish({
          ok: false,
          error: `The tunnel to ${this.host} did not come up in ${TUNNEL_READY_MS / 1000} s${said === '' ? '.' : ` (ssh: ${shownText(said)})`}`,
          portTaken: false
        })
        // ssh is alive but never confirmed its listener: kill it so it cannot come up unowned later.
        if (this.child === child) this.child = undefined
        this.terminate(child)
      }, TUNNEL_READY_MS)
    })
  }

  /** The up tunnel's ssh exited by itself. */
  private dropped(error: string): void {
    if (this.timers.now() - this.upSince >= BACKOFF_RESET_MS) this.failures = 0
    if (this.wanted()) this.scheduleRestart(error)
    else this.setState({ state: 'down', error })
  }

  private scheduleRestart(error: string): void {
    const delay = RESTART_BACKOFF_MS[Math.min(this.failures, RESTART_BACKOFF_MS.length - 1)] as number
    this.failures++
    this.clearRestartTimer()
    this.setState({ state: 'down', error, retryInMs: delay })
    this.restartTimer = this.timers.setTimeout(() => {
      this.restartTimer = undefined
      if (!this.wanted() || this.remotePort === undefined) return
      this.begin(this.localPort, true)
    }, delay)
  }

  private armStop(): void {
    if (this.stopTimer !== undefined) return
    this.stopTimer = this.timers.setTimeout(() => {
      this.stopTimer = undefined
      if (this.users === 0) this.stop()
    }, IDLE_STOP_MS)
  }

  private clearStopTimer(): void {
    if (this.stopTimer === undefined) return
    this.timers.clearTimeout(this.stopTimer)
    this.stopTimer = undefined
  }

  private clearRestartTimer(): void {
    if (this.restartTimer === undefined) return
    this.timers.clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  /** Retire the current child, if any: a new generation, so its exit is not a drop. */
  private killCurrent(): void {
    this.gen++
    this.starting = undefined
    const child = this.child
    this.child = undefined
    if (child !== undefined) this.terminate(child)
  }

  /** SIGTERM (ssh closes its forwards cleanly), SIGKILL if it is still there after the grace. */
  private terminate(child: SshProcess): void {
    let gone = false
    child.onExit(() => {
      gone = true
    })
    child.kill('SIGTERM')
    if (gone) return
    const t = this.timers.setTimeout(() => {
      if (!gone) child.kill('SIGKILL')
    }, KILL_GRACE_MS)
    child.onExit(() => this.timers.clearTimeout(t))
  }

  private setState(state: TunnelState): void {
    this.current = state
    this.options.onState?.(state)
  }
}
