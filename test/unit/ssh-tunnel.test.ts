import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { REMOTE_CCC_MISSING, remoteCommand } from '../../src/shared/remote-servers'
import { createSshSpawn, type SshExit, type SshProcess, type SshSpawn } from '../../src/main/remote/ssh-process'
import {
  IDLE_STOP_MS,
  KILL_GRACE_MS,
  REMOTE_TIMEOUT_MS,
  SshTunnel,
  TUNNEL_READY_MS,
  addDeviceToken,
  namesTakenPort,
  netPortProbe,
  runRemote,
  serverStatus,
  type PortProbe,
  type TunnelState
} from '../../src/main/remote/ssh-tunnel'

const COMMON = [
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

class FakeSsh implements SshProcess {
  readonly kills: string[] = []
  private readonly outs: Array<(t: string) => void> = []
  private readonly errs: Array<(t: string) => void> = []
  private readonly exits: Array<(e: SshExit) => void> = []
  result: SshExit | undefined
  /** Exit as soon as a signal arrives (a well-behaved ssh). */
  exitOnSignal = true

  constructor(readonly argv: readonly string[]) {}

  onStdout(l: (t: string) => void): void {
    this.outs.push(l)
  }
  onStderr(l: (t: string) => void): void {
    this.errs.push(l)
  }
  onExit(l: (e: SshExit) => void): void {
    if (this.result !== undefined) l(this.result)
    else this.exits.push(l)
  }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.result !== undefined) return
    this.kills.push(signal)
    if (this.exitOnSignal || signal === 'SIGKILL') this.exit(null, signal)
  }
  out(text: string): void {
    for (const l of this.outs) l(text)
  }
  err(text: string): void {
    for (const l of this.errs) l(text)
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null, error?: string): void {
    if (this.result !== undefined) return
    this.result = error === undefined ? { code, signal } : { code, signal, error }
    for (const l of this.exits.splice(0)) l(this.result)
  }
  get running(): boolean {
    return this.result === undefined
  }
}

function fakeSpawn(onSpawn?: (child: FakeSsh) => void): { spawn: SshSpawn; children: FakeSsh[] } {
  const children: FakeSsh[] = []
  const spawn: SshSpawn = (argv) => {
    const child = new FakeSsh(argv)
    children.push(child)
    onSpawn?.(child)
    return child
  }
  return { spawn, children }
}

/** A spawn whose children answer with `stdout` and exit `code` on the next tick. */
function answering(stdout: string, code = 0, stderr = ''): { spawn: SshSpawn; children: FakeSsh[] } {
  return fakeSpawn((child) => {
    queueMicrotask(() => {
      if (stdout) child.out(stdout)
      if (stderr) child.err(stderr)
      child.exit(code)
    })
  })
}

const HINT = 'Run `ssh devbox` once in a terminal (accept the host key; add your key to the agent).'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('runRemote', () => {
  it('runs ssh with the common options, --, the host and the one quoted remote command', async () => {
    const { spawn, children } = answering('ok\n')
    await expect(runRemote(spawn, 'devbox', ['web', 'status', '--json'])).resolves.toBe('ok')
    const command = remoteCommand(['web', 'status', '--json'])
    expect(children[0]?.argv).toEqual(['ssh', ...COMMON, '--', 'devbox', command])
    expect(command.startsWith("'sh' '-c' 'CCC=$1; shift; ")).toBe(true)
    expect(command.endsWith("' 'sh' '' 'web' 'status' '--json'")).toBe(true)
  })

  it('passes the ccc override as the script argument', async () => {
    const { spawn, children } = answering('ok\n')
    await runRemote(spawn, 'me@devbox', ['web', 'add-device'], '/opt/ccc')
    expect(children[0]?.argv.at(-1)).toBe(remoteCommand(['web', 'add-device'], '/opt/ccc'))
    expect(children[0]?.argv.at(-1)?.endsWith("'sh' '/opt/ccc' 'web' 'add-device'")).toBe(true)
  })

  it('refuses a bad host or override before spawning anything', async () => {
    const { spawn, children } = answering('ok\n')
    await expect(runRemote(spawn, '-oProxyCommand=x', ['web'])).rejects.toThrow('cannot start with "-"')
    await expect(runRemote(spawn, 'dev;box', ['web'])).rejects.toThrow('may only hold')
    await expect(runRemote(spawn, 'devbox', ['web'], "/a'b")).rejects.toThrow('single quote')
    expect(children).toHaveLength(0)
  })

  it('returns the last non-empty stdout line, rc-file noise before it ignored', async () => {
    const { spawn } = answering('Welcome to devbox\r\nlast login: today\n{"a":1}\r\n\n  \n')
    await expect(runRemote(spawn, 'devbox', ['web'])).resolves.toBe('{"a":1}')
  })

  it('kills ssh with SIGKILL after 20 s', async () => {
    const { spawn, children } = fakeSpawn()
    const run = runRemote(spawn, 'devbox', ['web'])
    const settled = expect(run).rejects.toThrow('did not finish in 20 s')
    await vi.advanceTimersByTimeAsync(REMOTE_TIMEOUT_MS - 1)
    expect(children[0]?.kills).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(children[0]?.kills).toEqual(['SIGKILL'])
  })

  it('keeps only the tail of a huge stdout', async () => {
    const noise = 'x'.repeat(100 * 1024)
    const { spawn } = answering(`${noise}\nanswer\n`)
    await expect(runRemote(spawn, 'devbox', ['web'])).resolves.toBe('answer')
    const { spawn: spawn2 } = answering('y'.repeat(200 * 1024))
    const line = await runRemote(spawn2, 'devbox', ['web'])
    expect(line.length).toBe(64 * 1024)
  })

  it('calls empty stdout a missing install or a stopped server', async () => {
    const { spawn } = answering('\n \n')
    await expect(runRemote(spawn, 'devbox', ['web'])).rejects.toThrow('cc-cockpit is not installed on devbox, or the server is not running.')
  })

  it('names a missing ccc from the script marker (exit 127)', async () => {
    const { spawn } = answering(`motd\n${REMOTE_CCC_MISSING}\n`, 127)
    await expect(runRemote(spawn, 'devbox', ['web'])).rejects.toThrow("cc-cockpit's ccc was not found on devbox")
  })

  it.each([
    ['Host key verification failed.', `ssh could not verify the host key of devbox. ${HINT}`],
    ['user@devbox: Permission denied (publickey,password).', 'was refused'],
    ['ssh: Could not resolve hostname devbox: Name or service not known', 'ssh could not find the host devbox'],
    ['ssh: connect to host devbox port 22: Connection timed out', 'ssh could not reach devbox: the connection timed out.'],
    ['ssh: connect to host devbox port 22: Connection refused', 'ssh could not reach devbox: the connection was refused.']
  ])('maps ssh stderr %j', async (stderr, text) => {
    const { spawn } = answering('', 255, `Warning: something first\n${stderr}\n`)
    await expect(runRemote(spawn, 'devbox', ['web'])).rejects.toThrow(text)
  })

  it('adds the terminal hint to an auth failure', async () => {
    const { spawn } = answering('', 255, 'Permission denied (publickey).\n')
    await expect(runRemote(spawn, 'devbox', ['web'])).rejects.toThrow(HINT)
  })

  it('shows an unknown stderr line raw, control characters stripped and capped', async () => {
    const { spawn } = answering('', 1, `ccc: something \u001b[31mbroke\u0007 here\n`)
    await expect(runRemote(spawn, 'devbox', ['web'])).rejects.toThrow(/^ccc: something \[31mbroke here$/)
    const { spawn: spawn2 } = answering('', 1, `${'z'.repeat(1000)}\n`)
    const err = await runRemote(spawn2, 'devbox', ['web']).catch((e: Error) => e)
    expect((err as Error).message.length).toBeLessThanOrEqual(300)
  })

  it('reports a missing ssh and a bare non-zero exit', async () => {
    const missing = fakeSpawn((c) => queueMicrotask(() => c.exit(null, null, 'ssh was not found on this machine')))
    await expect(runRemote(missing.spawn, 'devbox', ['web'])).rejects.toThrow('ssh was not found')
    const { spawn } = answering('', 3)
    await expect(runRemote(spawn, 'devbox', ['web'])).rejects.toThrow('ssh to devbox failed (exit code 3)')
  })
})

describe('serverStatus and addDeviceToken', () => {
  const status = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      server: true,
      version: '0.17.0',
      scheme: 'http',
      enabled: true,
      mode: 'link',
      port: 7420,
      gateway: { state: 'listening', bind: '127.0.0.1', port: 7421, origin: 'http://127.0.0.1:7421' },
      ...over
    })

  it('returns the listening port, mode and version, asking with web status --json', async () => {
    const { spawn, children } = answering(`noise\n${status()}\n`)
    await expect(serverStatus(spawn, 'devbox')).resolves.toEqual({ port: 7421, mode: 'link', version: '0.17.0' })
    expect(children[0]?.argv.at(-1)).toBe(remoteCommand(['web', 'status', '--json']))
  })

  it('refuses a desktop app (not server mode)', async () => {
    const { spawn } = answering(status({ server: false }))
    await expect(serverStatus(spawn, 'devbox')).rejects.toThrow('devbox is not a cc-cockpit server in server mode')
  })

  it('asks for an update when scheme is absent, naming the version when there is one', async () => {
    await expect(serverStatus(answering(status({ scheme: undefined })).spawn, 'devbox')).rejects.toThrow(
      'Update cc-cockpit on devbox (it runs 0.17.0).'
    )
    await expect(serverStatus(answering(status({ scheme: undefined, version: undefined })).spawn, 'devbox')).rejects.toThrow(
      'Update cc-cockpit on devbox (it runs an older version).'
    )
    await expect(serverStatus(answering(status({ scheme: 'gopher' })).spawn, 'devbox')).rejects.toThrow('Update cc-cockpit')
  })

  it('refuses https over the tunnel with the §5.4 text', async () => {
    const { spawn } = answering(status({ scheme: 'https' }))
    await expect(serverStatus(spawn, 'devbox')).rejects.toThrow(
      'Connect Direct with its address, or turn TLS off: the SSH tunnel encrypts already.'
    )
  })

  it('refuses web access off, a gateway not listening and broken fields', async () => {
    await expect(serverStatus(answering(status({ enabled: false, gateway: { state: 'off' } })).spawn, 'devbox')).rejects.toThrow('Web access is off')
    await expect(serverStatus(answering(status({ gateway: { state: 'failed', reason: 'port in use\u0007' } })).spawn, 'devbox')).rejects.toThrow(
      'The web gateway on devbox is not listening: port in use'
    )
    await expect(serverStatus(answering(status({ gateway: { state: 'listening', port: '7421' } })).spawn, 'devbox')).rejects.toThrow('no usable gateway port')
    await expect(serverStatus(answering(status({ mode: 'magic' })).spawn, 'devbox')).rejects.toThrow('sign-in mode')
    await expect(serverStatus(answering('not json at all').spawn, 'devbox')).rejects.toThrow('not a cc-cockpit status: not json at all')
    await expect(serverStatus(answering('[1,2]').spawn, 'devbox')).rejects.toThrow('not a cc-cockpit status')
  })

  it('keeps only the token of the add-device link', async () => {
    const { spawn, children } = answering('motd\nhttps://devbox.example:7421/#t=abc123\n')
    await expect(addDeviceToken(spawn, 'devbox')).resolves.toBe('abc123')
    expect(children[0]?.argv.at(-1)).toBe(remoteCommand(['web', 'add-device']))
    await expect(addDeviceToken(answering('http://127.0.0.1:7421/\n').spawn, 'devbox')).rejects.toThrow('did not answer with an add-device link')
    await expect(addDeviceToken(answering('nonsense\n').spawn, 'devbox')).rejects.toThrow('did not answer with an add-device link')
  })
})

describe('namesTakenPort', () => {
  it('matches only a bind failure naming that port', () => {
    expect(namesTakenPort('bind [127.0.0.1]:8080: Address already in use\n', 8080)).toBe(true)
    expect(namesTakenPort('channel_setup_fwd_listener_tcpip: cannot listen to port: 8080\n', 8080)).toBe(true)
    expect(namesTakenPort('bind [127.0.0.1]:18080: Address already in use\n', 8080)).toBe(false)
    expect(namesTakenPort('Permission denied (publickey).\n', 8080)).toBe(false)
  })
})

/** The tunnel's world: ports in use, ports ssh listens on, and fresh ports from 50000 up. */
function world(): {
  probe: PortProbe
  taken: Set<number>
  listening: Set<number>
  connect: (port: number) => Promise<boolean>
} {
  const taken = new Set<number>()
  const listening = new Set<number>()
  let next = 50000
  const probe: PortProbe = {
    isFree: async (port) => !taken.has(port),
    freePort: async () => {
      while (taken.has(next)) next++
      return next++
    }
  }
  return { probe, taken, listening, connect: async (port) => listening.has(port) }
}

function localPortOf(child: FakeSsh): number {
  const forward = child.argv[child.argv.indexOf('-L') + 1] as string
  return Number(forward.split(':')[1])
}

/** What `ssh -v` prints before the forward: noise the tunnel must read past. */
const VERBOSE_PREAMBLE =
  'OpenSSH_9.9p1, OpenSSL 3.4.0 22 Oct 2024\ndebug1: Reading configuration data /etc/ssh/ssh_config\n' +
  'debug1: Connecting to devbox [10.0.0.2] port 22.\nAuthenticated to devbox ([10.0.0.2]:22) using "publickey".\n'

/** ssh's bind confirmation for `port`, as `-v` logs it, split across two chunks (CRLF, as over a pty-less pipe it may be). */
function sayListening(child: FakeSsh, port: number): void {
  child.err(`${VERBOSE_PREAMBLE}debug1: Local forwarding listen`)
  child.err(`ing on 127.0.0.1 port ${port}.\r\ndebug1: channel 0: new port-listener [port listener] (inactive timeout: 0)\n`)
}

/** A well-behaved ssh: binds its port (the port accepts) and says so, on the next tick. */
function listen(child: FakeSsh, w: { listening: Set<number> }): void {
  const port = localPortOf(child)
  w.listening.add(port)
  queueMicrotask(() => sayListening(child, port))
}

describe('SshTunnel', () => {
  /** A tunnel whose ssh children listen at once (behaviour per child can be overridden by `onSpawn`). */
  function setup(onSpawn?: (child: FakeSsh, w: ReturnType<typeof world>) => void): {
    tunnel: SshTunnel
    children: FakeSsh[]
    w: ReturnType<typeof world>
    states: TunnelState[]
    ports: number[]
  } {
    const w = world()
    const states: TunnelState[] = []
    const ports: number[] = []
    const { spawn, children } = fakeSpawn((child) => {
      if (onSpawn) onSpawn(child, w)
      else listen(child, w)
    })
    const tunnel = new SshTunnel({
      host: 'devbox',
      spawn,
      probe: w.probe,
      connect: w.connect,
      onState: (s) => states.push(s),
      onPort: (p) => ports.push(p)
    })
    return { tunnel, children, w, states, ports }
  }

  it('spawns the forward with the common options, the forward options and -- host', async () => {
    const { tunnel, children } = setup()
    const started = tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(200)
    await expect(started).resolves.toBe(41000)
    expect(children[0]?.argv).toEqual([
      'ssh',
      ...COMMON,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-v',
      '-N',
      '-L',
      '127.0.0.1:41000:127.0.0.1:7421',
      '--',
      'devbox'
    ])
  })

  it('uses the preferred port when free, else a fresh one, and reports it', async () => {
    const a = setup()
    const p1 = a.tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(200)
    await expect(p1).resolves.toBe(41000)
    expect(a.ports).toEqual([41000])
    expect(a.tunnel.state).toEqual({ state: 'up', localPort: 41000 })
    expect(a.states.map((s) => s.state)).toEqual(['connecting', 'up'])

    const b = setup()
    b.w.taken.add(41000)
    const p2 = b.tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(200)
    await expect(p2).resolves.toBe(50000)
    expect(b.ports).toEqual([50000])
  })

  it('an up tunnel to the same port answers at once; a start in progress is shared', async () => {
    const { tunnel, children } = setup()
    const p1 = tunnel.start(7421)
    const p2 = tunnel.start(7421)
    expect(p2).toBe(p1)
    await vi.advanceTimersByTimeAsync(200)
    await expect(tunnel.start(7421)).resolves.toBe(50000)
    expect(children).toHaveLength(1)
  })

  it('is ready only after ssh logs that it bound our port, then the port accepts', async () => {
    const { tunnel, w, children } = setup(() => {})
    let done = false
    const started = tunnel.start(7421, 41000).then((p) => {
      done = true
      return p
    })
    await vi.advanceTimersByTimeAsync(10)
    const child = children[0] as FakeSsh
    // Something answers on 41000 (another local process holds it): a connect alone is never ready.
    w.listening.add(41000)
    child.err(VERBOSE_PREAMBLE)
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)
    // ssh's line for another port does not count either.
    child.err('debug1: Local forwarding listening on 127.0.0.1 port 4100.\ndebug1: Local forwarding listening on 127.0.0.1 port 410001.\n')
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)
    expect(tunnel.state).toEqual({ state: 'connecting' })
    // Nor the text outside a debug line (a banner line, say).
    child.err('Local forwarding listening on 127.0.0.1 port 41000.\n')
    await vi.advanceTimersByTimeAsync(2000)
    expect(done).toBe(false)
    sayListening(child, 41000)
    await vi.advanceTimersByTimeAsync(1)
    await expect(started).resolves.toBe(41000)
    expect(child.running).toBe(true)
  })

  it('after the line, waits for the port to accept as a second check', async () => {
    const { tunnel, w, children } = setup(() => {})
    let done = false
    const started = tunnel.start(7421, 41000).then((p) => {
      done = true
      return p
    })
    await vi.advanceTimersByTimeAsync(10)
    sayListening(children[0] as FakeSsh, 41000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(done).toBe(false)
    w.listening.add(41000)
    await vi.advanceTimersByTimeAsync(100)
    await expect(started).resolves.toBe(41000)
  })

  it('fails and kills ssh when no bind line comes within 15 s, even if the port answers', async () => {
    const { tunnel, children, w } = setup((child) => queueMicrotask(() => child.err(VERBOSE_PREAMBLE)))
    w.listening.add(41000)
    const started = tunnel.start(7421, 41000)
    const settled = expect(started).rejects.toThrow('did not come up in 15 s (ssh: Authenticated to devbox')
    await vi.advanceTimersByTimeAsync(TUNNEL_READY_MS)
    await settled
    expect(children[0]?.kills).toEqual(['SIGTERM'])
    expect(tunnel.state).toMatchObject({ state: 'down' })
  })

  it('fails with the mapped ssh error when ssh exits before the port is up', async () => {
    const { tunnel } = setup((child) => queueMicrotask(() => {
      child.err('OpenSSH_9.9p1\ndebug1: Next authentication method: publickey\nuser@devbox: Permission denied (publickey).\n')
      child.err('debug1: No more authentication methods to try.\n')
      child.exit(255)
    }))
    const started = tunnel.start(7421, 41000)
    const settled = expect(started).rejects.toThrow(HINT)
    await vi.advanceTimersByTimeAsync(200)
    await settled
    expect(tunnel.state).toMatchObject({ state: 'down', error: expect.stringContaining('was refused') })
    expect(tunnel.state).not.toHaveProperty('retryInMs')
  })

  it('retries with a fresh port when ssh says the port is taken, twice, then fails', async () => {
    const takenOnce = setup((child, w) => {
      const port = localPortOf(child)
      if (port === 41000) {
        queueMicrotask(() => {
          child.err(`${VERBOSE_PREAMBLE}bind [127.0.0.1]:${port}: Address already in use\n`)
          child.err(`channel_setup_fwd_listener_tcpip: cannot listen to port: ${port}\nCould not request local forwarding.\n`)
          child.exit(255)
        })
      } else listen(child, w)
    })
    const p1 = takenOnce.tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(500)
    await expect(p1).resolves.toBe(50000)
    expect(takenOnce.children).toHaveLength(2)
    expect(takenOnce.ports).toEqual([50000])

    const alwaysTaken = setup((child) => {
      const port = localPortOf(child)
      queueMicrotask(() => {
        child.err(`channel_setup_fwd_listener_tcpip: cannot listen to port: ${port}\n`)
        child.exit(255)
      })
    })
    const p2 = alwaysTaken.tunnel.start(7421, 41000)
    const settled = expect(p2).rejects.toThrow('cannot listen to port')
    await vi.advanceTimersByTimeAsync(500)
    await settled
    expect(alwaysTaken.children.map(localPortOf)).toEqual([41000, 50000, 50001])
  })

  it('does not retry another port when stderr names a different one', async () => {
    const { tunnel, children } = setup((child) => queueMicrotask(() => {
      child.err('bind [127.0.0.1]:9999: Address already in use\n')
      child.exit(255)
    }))
    const started = tunnel.start(7421, 41000)
    const settled = expect(started).rejects.toThrow('Address already in use')
    await vi.advanceTimersByTimeAsync(500)
    await settled
    expect(children).toHaveLength(1)
  })

  it('restarts with backoff (1, 2, 5, 10, 10 s) while wanted, on the same port', async () => {
    let fail = false
    const { tunnel, children, w, states } = setup((child, world) => {
      if (fail) queueMicrotask(() => child.exit(255))
      else listen(child, world)
    })
    tunnel.acquire()
    const started = tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(200)
    await started
    fail = true
    w.listening.delete(41000)
    children[0]?.exit(255)
    expect(tunnel.state).toMatchObject({ state: 'down', retryInMs: 1000 })
    const expected = [1000, 2000, 5000, 10_000, 10_000]
    for (const [i, delay] of expected.entries()) {
      const before = children.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(children.length).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(children.length).toBe(before + 1)
      expect(localPortOf(children.at(-1) as FakeSsh)).toBe(41000)
      if (i < expected.length - 1) expect(tunnel.state).toMatchObject({ state: 'down', retryInMs: expected[i + 1] })
    }
    // Back up: the next drop after 60 s up starts from 1 s again.
    fail = false
    await vi.advanceTimersByTimeAsync(10_200)
    expect(tunnel.state).toEqual({ state: 'up', localPort: 41000 })
    expect(states.filter((s) => s.state === 'up')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    ;(children.at(-1) as FakeSsh).exit(255)
    expect(tunnel.state).toMatchObject({ state: 'down', retryInMs: 1000 })
  })

  it('keeps the backoff growing when the tunnel drops soon after coming back', async () => {
    const { tunnel, children } = setup()
    tunnel.acquire()
    const started = tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(200)
    await started
    children[0]?.err('Timeout, server devbox not responding.\ndebug1: channel 0: free: port listener\n')
    children[0]?.err('Transferred: sent 4, received 8 bytes, in 9.0 seconds\nBytes per second: sent 0.4, received 0.9')
    children[0]?.exit(255)
    // ssh's own message, not the -v chatter or the exit statistics after it.
    expect(tunnel.state).toEqual({ state: 'down', error: 'Timeout, server devbox not responding.', retryInMs: 1000 })
    await vi.advanceTimersByTimeAsync(1200)
    expect(tunnel.state).toMatchObject({ state: 'up' })
    children[1]?.exit(255)
    expect(tunnel.state).toMatchObject({ retryInMs: 2000 })
  })

  it('does not restart after stop, nor when no window holds it', async () => {
    const a = setup()
    a.tunnel.acquire()
    const p1 = a.tunnel.start(7421)
    await vi.advanceTimersByTimeAsync(200)
    await p1
    a.tunnel.stop()
    expect(a.children[0]?.kills).toEqual(['SIGTERM'])
    expect(a.tunnel.state).toEqual({ state: 'stopped' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(a.children).toHaveLength(1)

    const b = setup()
    const p2 = b.tunnel.start(7421)
    await vi.advanceTimersByTimeAsync(200)
    await p2
    b.children[0]?.exit(255)
    expect(b.tunnel.state).toMatchObject({ state: 'down' })
    expect(b.tunnel.state).not.toHaveProperty('retryInMs')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(b.children).toHaveLength(1)
  })

  it('a start nobody acquires stops after 30 s', async () => {
    const { tunnel, children } = setup()
    const started = tunnel.start(7421)
    await vi.advanceTimersByTimeAsync(200)
    await started
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS)
    expect(children[0]?.kills).toEqual(['SIGTERM'])
  })

  it('the last release stops the tunnel 30 s later; acquire in between cancels it', async () => {
    const { tunnel, children } = setup()
    tunnel.acquire()
    tunnel.acquire()
    const started = tunnel.start(7421)
    await vi.advanceTimersByTimeAsync(200)
    await started
    tunnel.release()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
    expect(children[0]?.running).toBe(true)
    tunnel.release()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1000)
    tunnel.acquire()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS * 2)
    expect(children[0]?.running).toBe(true)
    tunnel.release()
    await vi.advanceTimersByTimeAsync(IDLE_STOP_MS - 1)
    expect(children[0]?.running).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(children[0]?.kills).toEqual(['SIGTERM'])
    expect(tunnel.state).toEqual({ state: 'stopped' })
  })

  it('stop sends SIGTERM, then SIGKILL after 2 s to an ssh that lingers', async () => {
    const { tunnel, children } = setup()
    const started = tunnel.start(7421)
    await vi.advanceTimersByTimeAsync(200)
    await started
    const child = children[0] as FakeSsh
    child.exitOnSignal = false
    tunnel.stop()
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS - 1)
    expect(child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.running).toBe(false)
  })

  it('dispose (app quit) kills, cancels a pending restart and refuses new starts', async () => {
    const { tunnel, children } = setup()
    tunnel.acquire()
    const started = tunnel.start(7421)
    await vi.advanceTimersByTimeAsync(200)
    await started
    children[0]?.exit(255)
    expect(tunnel.state).toMatchObject({ retryInMs: 1000 })
    tunnel.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(children).toHaveLength(1)
    await expect(tunnel.start(7421)).rejects.toThrow('closed')
  })

  it('a stop during a start rejects that start and kills its ssh', async () => {
    const { tunnel, children } = setup(() => {})
    const started = tunnel.start(7421, 41000)
    const settled = expect(started).rejects.toThrow('stopped')
    await vi.advanceTimersByTimeAsync(300)
    tunnel.stop()
    await vi.advanceTimersByTimeAsync(100)
    await settled
    expect(children[0]?.kills).toEqual(['SIGTERM'])
    expect(tunnel.state).toEqual({ state: 'stopped' })
  })

  it('replaces the tunnel when the server reports another gateway port', async () => {
    const { tunnel, children } = setup()
    const p1 = tunnel.start(7421, 41000)
    await vi.advanceTimersByTimeAsync(200)
    await p1
    const p2 = tunnel.start(7500)
    await vi.advanceTimersByTimeAsync(200)
    await expect(p2).resolves.toBe(41000)
    expect(children[0]?.kills).toEqual(['SIGTERM'])
    expect(children[1]?.argv).toContain('127.0.0.1:41000:127.0.0.1:7500')
  })

  it('refuses a bad host', () => {
    expect(() => new SshTunnel({ host: '-oProxyCommand=x', spawn: fakeSpawn().spawn })).toThrow('cannot start with "-"')
  })
})

describe('real adapters', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('createSshSpawn runs argv, tracks the child and reports output and exit', async () => {
    const tracked: ChildProcess[] = []
    const spawn = createSshSpawn({ track: (c) => void tracked.push(c), env: () => process.env })
    const child = spawn([process.execPath, '-e', 'process.stdout.write("out\\n"); process.stderr.write("err\\n"); process.exit(3)'])
    let out = ''
    let err = ''
    child.onStdout((t) => (out += t))
    child.onStderr((t) => (err += t))
    const exit = await new Promise<SshExit>((resolve) => child.onExit(resolve))
    expect(exit).toEqual({ code: 3, signal: null })
    expect(out).toBe('out\n')
    expect(err).toBe('err\n')
    expect(tracked).toHaveLength(1)
  })

  it('createSshSpawn reports a missing program as an exit with error text', async () => {
    const spawn = createSshSpawn({ track: () => {}, env: () => ({ PATH: '/nonexistent' }) })
    const exit = await new Promise<SshExit>((resolve) => spawn(['ssh', '-V']).onExit(resolve))
    expect(exit.code).toBeNull()
    expect(exit.error).toContain('ssh was not found')
  })

  it('createSshSpawn kill signals the child', async () => {
    const spawn = createSshSpawn({ track: () => {} })
    const child = spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'])
    const exited = new Promise<SshExit>((resolve) => child.onExit(resolve))
    await new Promise((r) => setTimeout(r, 100))
    child.kill('SIGTERM')
    expect((await exited).signal).toBe('SIGTERM')
  })

  it('netPortProbe tells a taken port from a free one', async () => {
    const free = await netPortProbe.freePort()
    expect(await netPortProbe.isFree(free)).toBe(true)
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(free, '127.0.0.1', resolve))
    try {
      expect(await netPortProbe.isFree(free)).toBe(false)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
