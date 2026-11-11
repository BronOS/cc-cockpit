// Real Unix sockets in a temp dir. The temp root is under /tmp rather than os.tmpdir(): macOS's
// /var/folders/... is long enough to push a nested socket path past sun_path (104 bytes).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { fallbackSocketDir, socketPath } from '../../src/main/paths'
import { spawnSync } from 'node:child_process'
import { connect, listen } from '../../src/main/socket/transport'
import { SocketServer, type Caller, type SocketServerOptions } from '../../src/main/socket/socket-server'
import {
  HOST_ONLY_COMMANDS,
  HOST_ONLY_TEXT,
  LineFramer,
  MAX_LINE_BYTES,
  WINDOW_TOKEN_COMMANDS,
  encodeRequest,
  parseReply,
  type Reply,
  type Request
} from '../../src/shared/protocol'

const TOKEN = 'a'.repeat(64)
/** A shell tab's (or terminal overlay's) token: main's lookup says it is a window token. */
const WINDOW_TOKEN = 'c'.repeat(64)
const POSIX = process.platform !== 'win32'

let root: string
let sock: string
let logs: string[]
let servers: SocketServer[]
let running = 0
let peakRunning = 0

beforeEach(() => {
  root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccs-'))
  sock = join(root, 's.sock')
  logs = []
  servers = []
  running = 0
  peakRunning = 0
})

afterEach(async () => {
  for (const s of servers) await s.stop()
  rmSync(root, { recursive: true, force: true })
})

function server(over: Partial<SocketServerOptions> = {}): SocketServer {
  const s = new SocketServer({
    path: sock,
    resolveToken: (token) =>
      token === TOKEN
        ? { kind: 'session', tabId: 'tab-1', projectId: 'proj-1' }
        : token === WINDOW_TOKEN
          ? { kind: 'window', projectId: 'proj-w' }
          : undefined,
    resolveProject: (path) => ({ path, projectId: path === '/known' ? 'proj-k' : undefined }),
    log: (m) => logs.push(m),
    probeTimeoutMs: 200,
    ...over
  })
  servers.push(s)
  return s
}

/** A server with an `echo` (token-only) and `open` (tokenless) handler that reveal the caller. */
async function started(over: Partial<SocketServerOptions> = {}): Promise<SocketServer> {
  const s = server(over)
  const echo = (args: Record<string, unknown>, caller: Caller): unknown => ({ args, caller })
  s.handle('echo', echo)
  s.handle('open', echo)
  s.handle('notify', echo)
  s.handle('sessions', echo)
  s.handle('overlay', echo)
  s.handle('boom', () => {
    throw new Error('handler failed')
  })
  s.handle('slow-boom', async () => {
    await new Promise((r) => setTimeout(r, 5))
    throw new Error('async failed')
  })
  // Answers after args.ms; tracks how many run at once.
  s.handle('sleep', async (args) => {
    running++
    peakRunning = Math.max(peakRunning, running)
    await new Promise((r) => setTimeout(r, Number(args.ms)))
    running--
    return 'slept'
  })
  expect(await s.start()).toBe(true)
  return s
}

/** A line-oriented client: send raw lines, read replies in order. */
class Client {
  private readonly framer = new LineFramer()
  private readonly lines: string[] = []
  private waiters: Array<() => void> = []
  closed = false

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.lines.push(...this.framer.push(chunk))
      this.wake()
    })
    socket.on('close', () => {
      this.closed = true
      this.wake()
    })
    socket.on('error', () => {})
  }

  static async open(path = sock): Promise<Client> {
    return new Client(await connect(path, 1000))
  }

  sendRaw(text: string): void {
    this.socket.write(text)
  }

  async request(req: Partial<Request> & { cmd: string }): Promise<Reply> {
    this.sendRaw(encodeRequest({ v: 1, id: 1, args: {}, ...req }))
    return this.reply()
  }

  async reply(): Promise<Reply> {
    while (this.lines.length === 0) {
      if (this.closed) throw new Error('connection closed')
      await new Promise<void>((r) => this.waiters.push(r))
    }
    return parseReply(this.lines.shift()!)
  }

  async waitClosed(): Promise<void> {
    while (!this.closed) await new Promise<void>((r) => this.waiters.push(r))
  }

  close(): void {
    this.socket.destroy()
  }

  private wake(): void {
    const w = this.waiters
    this.waiters = []
    for (const f of w) f()
  }
}

describe('requests', () => {
  it('stamps appVersion on ok, error, refused and unserializable replies when it has one', async () => {
    const s = await started({ appVersion: '1.2.3' })
    s.handle('cycle', () => {
      const a: Record<string, unknown> = {}
      a.self = a
      return a
    })
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true, appVersion: '1.2.3' })
    expect(await c.request({ token: TOKEN, cmd: 'boom' })).toMatchObject({ ok: false, appVersion: '1.2.3' })
    expect(await c.request({ token: 'nope', cmd: 'echo' })).toMatchObject({ ok: false, error: 'invalid token', appVersion: '1.2.3' })
    expect(await c.request({ token: TOKEN, cmd: 'cycle' })).toMatchObject({ ok: false, appVersion: '1.2.3' })
  })

  it('sends no appVersion when it has none', async () => {
    await started()
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).not.toHaveProperty('appVersion')
  })

  it('round-trips a tokened request with the caller resolved by main', async () => {
    await started()
    const c = await Client.open()
    const reply = await c.request({ id: 42, token: TOKEN, project: '/ignored', cmd: 'echo', args: { x: 1 } })
    expect(reply).toEqual({
      id: 42,
      ok: true,
      result: { args: { x: 1 }, caller: { kind: 'session', tabId: 'tab-1', projectId: 'proj-1' } }
    })
    // Several requests on one connection.
    expect((await c.request({ id: 43, token: TOKEN, cmd: 'echo' })).id).toBe(43)
    c.close()
  })

  it('resolves --project for a tokenless allow-listed command', async () => {
    await started()
    const c = await Client.open()
    expect(await c.request({ cmd: 'open', project: '/known' })).toMatchObject({
      ok: true,
      result: { caller: { kind: 'project', path: '/known', projectId: 'proj-k' } }
    })
    // An unknown folder still reaches the handler (open of a new folder), without an id.
    const unknown = await c.request({ cmd: 'open', project: '/new' })
    expect(unknown).toMatchObject({ ok: true, result: { caller: { kind: 'project', path: '/new' } } })
    expect((unknown as { result: { caller: Caller } }).result.caller).not.toHaveProperty('projectId', 'proj-k')
    c.close()
  })

  it('returns an error for bad json and keeps the connection usable', async () => {
    await started()
    const c = await Client.open()
    c.sendRaw('{not json\n')
    expect(await c.reply()).toEqual({ id: null, ok: false, error: 'bad json' })
    c.sendRaw('{"v":9,"id":5,"cmd":"echo"}\n')
    expect(await c.reply()).toMatchObject({ id: 5, ok: false, error: expect.stringMatching(/version/) })
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    c.close()
  })

  it('refuses an invalid token, even for a tokenless command', async () => {
    await started()
    const c = await Client.open()
    expect(await c.request({ token: 'b'.repeat(64), cmd: 'echo' })).toEqual({
      id: 1,
      ok: false,
      error: 'invalid token'
    })
    expect(await c.request({ token: 'nope', project: '/known', cmd: 'open' })).toMatchObject({
      ok: false,
      error: 'invalid token'
    })
    c.close()
  })

  it('turns a window token into a window caller for the window commands, and refuses it for the rest', async () => {
    const s = await started()
    // Every window command reaches its handler with the token's project and no tab id, whatever
    // the request says about a project.
    for (const cmd of WINDOW_TOKEN_COMMANDS) if (!['open', 'notify', 'sessions', 'overlay'].includes(cmd)) s.handle(cmd, (_a, caller) => ({ caller }))
    s.handle('hook', (_a, caller) => ({ caller }))
    s.handle('session.note', (_a, caller) => ({ caller }))
    s.handle('session.steps', (_a, caller) => ({ caller }))
    const c = await Client.open()
    for (const cmd of WINDOW_TOKEN_COMMANDS) {
      const reply = await c.request({ token: WINDOW_TOKEN, project: '/known', cmd })
      expect(reply, cmd).toMatchObject({ ok: true, result: { caller: { kind: 'window', projectId: 'proj-w' } } })
      expect((reply as { result: { caller: Caller } }).result.caller, cmd).not.toHaveProperty('tabId')
    }
    // The commands that need a Claude session are refused before their handler runs: a shell
    // tab's `ccc hook` must never create a status entry. `echo` stands for any other command.
    for (const cmd of ['hook', 'session.note', 'session.steps', 'echo']) {
      expect(await c.request({ token: WINDOW_TOKEN, cmd }), cmd).toEqual({
        id: 1,
        ok: false,
        error: `${cmd} needs a Claude session (run it inside a cockpit Claude tab, not a shell tab)`
      })
    }
    // The session token still reaches them.
    expect(await c.request({ token: TOKEN, cmd: 'hook' })).toMatchObject({ ok: true, result: { caller: { kind: 'session' } } })
    c.close()
  })

  it('refuses a tokenless call to a token-only command', async () => {
    await started()
    const c = await Client.open()
    expect(await c.request({ project: '/known', cmd: 'echo' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/needs a tab token/)
    })
    // Not registered and not allow-listed: the caller learns nothing about which commands exist.
    expect(await c.request({ project: '/known', cmd: 'hook' })).toMatchObject({
      error: expect.stringMatching(/needs a tab token/)
    })
    c.close()
  })

  it('requires an absolute --project for tokenless calls', async () => {
    await started()
    const c = await Client.open()
    expect(await c.request({ cmd: 'open' })).toMatchObject({ ok: false, error: expect.stringMatching(/--project/) })
    expect(await c.request({ cmd: 'open', project: 'rel/dir' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/absolute/)
    })
    c.close()
  })

  it('lets notify and sessions through with no project, and nothing else', async () => {
    await started()
    const c = await Client.open()
    // They act on no single project: an anonymous caller, not an error.
    for (const cmd of ['notify', 'sessions']) {
      expect(await c.request({ cmd })).toMatchObject({ ok: true, result: { caller: { kind: 'anonymous' } } })
    }
    // A project, when given, is still resolved (and checked) like for any tokenless command.
    expect(await c.request({ cmd: 'sessions', project: '/known' })).toMatchObject({
      result: { caller: { kind: 'project', projectId: 'proj-k' } }
    })
    expect(await c.request({ cmd: 'sessions', project: 'rel' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/absolute/)
    })
    // overlay acts on a window, so it still needs --project.
    expect(await c.request({ cmd: 'overlay' })).toMatchObject({ ok: false, error: expect.stringMatching(/--project/) })
    // A token wins over everything: the caller is the tab.
    expect(await c.request({ token: TOKEN, cmd: 'sessions' })).toMatchObject({
      result: { caller: { kind: 'session', tabId: 'tab-1' } }
    })
    c.close()
  })

  it('reports an unknown command and handler errors (sync and async) as error replies', async () => {
    await started()
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'nope' })).toMatchObject({ ok: false, error: 'unknown command: nope' })
    expect(await c.request({ token: TOKEN, cmd: 'boom' })).toMatchObject({ ok: false, error: 'handler failed' })
    expect(await c.request({ token: TOKEN, cmd: 'slow-boom' })).toMatchObject({ ok: false, error: 'async failed' })
    c.close()
  })

  it('a resolver that throws becomes an error reply', async () => {
    await started({
      resolveProject: () => {
        throw new Error('cannot resolve')
      }
    })
    const c = await Client.open()
    expect(await c.request({ cmd: 'open', project: '/x' })).toMatchObject({ ok: false, error: 'cannot resolve' })
    c.close()
  })

  // `ccc web` (design-web.md §9.4): a shell on the server only. Every one of the eight is refused
  // for any token with the same text, before a handler is looked up, so a tab cannot even tell
  // which have one; tokenless, the registered ones reach their handler as an anonymous caller and
  // the rest are "unknown command".
  it('refuses every HOST_ONLY_COMMANDS request that carries a token, with one text, whether or not it has a handler', async () => {
    const s = await started()
    let reached = 0
    const registered = ['web.status', 'web.revoke', 'web.stop']
    for (const cmd of registered) {
      s.handle(cmd, (_a, caller) => {
        reached++
        return { caller }
      })
    }
    const c = await Client.open()
    for (const cmd of HOST_ONLY_COMMANDS) {
      for (const token of [TOKEN, WINDOW_TOKEN, 'f'.repeat(64)]) {
        expect(await c.request({ token, cmd }), `${cmd} ${token[0]}`).toEqual({ id: 1, ok: false, error: HOST_ONLY_TEXT })
        expect(await c.request({ token, cmd, project: '/known' }), cmd).toEqual({ id: 1, ok: false, error: HOST_ONLY_TEXT })
      }
    }
    expect(reached).toBe(0)
    for (const cmd of HOST_ONLY_COMMANDS) {
      const reply = await c.request({ cmd })
      if (registered.includes(cmd)) expect(reply, cmd).toMatchObject({ ok: true, result: { caller: { kind: 'anonymous' } } })
      else expect(reply, cmd).toEqual({ id: 1, ok: false, error: `unknown command: ${cmd}` })
      // A tokenless one names no project: nothing in ccc web is about one.
      expect(await c.request({ cmd, project: '/known' }), cmd).toEqual({ id: 1, ok: false, error: `${cmd} names no project` })
    }
    expect(reached).toBe(registered.length)
    c.close()
  })

  it('refuses to register a web.* handler that HOST_ONLY_COMMANDS lacks', () => {
    const s = server()
    expect(() => s.handle('web.debug', () => 1)).toThrow(/HOST_ONLY_COMMANDS/)
    expect(() => s.handle('web.status', () => 1)).not.toThrow()
  })

  it('refuses a second handler for the same command', () => {
    const s = server()
    s.handle('x', () => 1)
    expect(() => s.handle('x', () => 2)).toThrow(/already registered/)
  })
})

describe('connections', () => {
  it('closes a connection that sends an oversized line, and others keep working', async () => {
    await started()
    const bad = await Client.open()
    const good = await Client.open()
    bad.sendRaw('x'.repeat(MAX_LINE_BYTES + 10))
    await bad.waitClosed()
    expect(bad.closed).toBe(true)
    expect(logs.some((l) => /longer than/.test(l))).toBe(true)
    expect(await good.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    good.close()
  })

  it('aborts the handler\'s peerGone signal when the client goes away', async () => {
    const s = await started()
    let signal: AbortSignal | undefined
    s.handle('wait', (_args, _caller, peerGone) => {
      signal = peerGone
      return new Promise(() => {})
    })
    const c = await Client.open()
    c.sendRaw(encodeRequest({ v: 1, id: 1, token: TOKEN, cmd: 'wait', args: {} }))
    for (let i = 0; i < 100 && !signal; i++) await new Promise((r) => setTimeout(r, 5))
    expect(signal?.aborted).toBe(false)
    c.close()
    for (let i = 0; i < 100 && !signal?.aborted; i++) await new Promise((r) => setTimeout(r, 5))
    expect(signal?.aborted).toBe(true)
  })

  it('survives a client that disconnects before its reply is written', async () => {
    await started()
    const gone = await Client.open()
    gone.sendRaw(encodeRequest({ v: 1, id: 1, token: TOKEN, cmd: 'slow-boom', args: {} }))
    gone.close()
    await new Promise((r) => setTimeout(r, 30))
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    c.close()
  })
})

describe('connection limits', () => {
  it('closes a connection that stays quiet with nothing in progress', async () => {
    await started({ idleTimeoutMs: 50 })
    const idle = await Client.open()
    await idle.waitClosed()
    expect(idle.closed).toBe(true)
  })

  it('keeps a connection open while its request runs past the idle timeout', async () => {
    await started({ idleTimeoutMs: 50 })
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'sleep', args: { ms: 200 } })).toMatchObject({ ok: true, result: 'slept' })
    c.close()
  })

  it('refuses connections past the cap, and frees a slot when one closes', async () => {
    await started({ maxConnections: 2 })
    const a = await Client.open()
    const b = await Client.open()
    const extra = await Client.open()
    await extra.waitClosed()
    expect(logs.some((l) => /2 already open/.test(l))).toBe(true)
    expect(await b.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    a.close()
    await new Promise((r) => setTimeout(r, 30))
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    b.close()
    c.close()
  })

  it('runs a bounded number of pipelined requests at once and answers all of them', async () => {
    await started()
    const c = await Client.open()
    const n = 40
    c.sendRaw(
      Array.from({ length: n }, (_, i) => encodeRequest({ v: 1, id: i, token: TOKEN, cmd: 'sleep', args: { ms: 10 } })).join('')
    )
    const ids: Array<number | null> = []
    for (let i = 0; i < n; i++) ids.push((await c.reply()).id)
    expect(ids.sort((x, y) => (x ?? 0) - (y ?? 0))).toEqual(Array.from({ length: n }, (_, i) => i))
    expect(peakRunning).toBeGreaterThan(1)
    expect(peakRunning).toBeLessThanOrEqual(16)
    c.close()
  })

  it('answers a client that half-closes right after its request, then ends the connection', async () => {
    await started()
    const c = await Client.open()
    // `socket.end(line)`, as `nc -U` fed from a pipe does; the reply is not ready at that point.
    c.socket.end(encodeRequest({ v: 1, id: 5, token: TOKEN, cmd: 'sleep', args: { ms: 50 } }))
    expect(await c.reply()).toMatchObject({ id: 5, ok: true, result: 'slept' })
    await c.waitClosed()
  })
})

describe('socket file', () => {
  it.runIf(POSIX)('is mode 0600', async () => {
    await started()
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it.runIf(POSIX)('is born 0600 under a loose umask, and the umask is restored', async () => {
    // transport.listen alone (no chmod): a umask of 0002 would otherwise leave the file group-
    // writable between bind and chmod, and the kernel queues connects made in that window.
    const old = process.umask(0o002)
    try {
      const srv = await listen(sock, (c) => c.destroy())
      expect(statSync(sock).mode & 0o777).toBe(0o600)
      expect(process.umask()).toBe(0o002)
      await new Promise<void>((r) => srv.close(() => r()))
    } finally {
      process.umask(old)
    }
  })

  it('is removed on stop', async () => {
    const s = await started()
    expect(existsSync(sock)).toBe(true)
    await s.stop()
    expect(existsSync(sock)).toBe(false)
    expect(s.listening).toBe(false)
  })

  it('replaces a stale socket nobody answers on', async () => {
    // A socket file left behind by a crashed instance: a child binds it and is SIGKILLed, so
    // nothing closes or unlinks it.
    spawnSync(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`
    ])
    expect(statSync(sock).isSocket()).toBe(true)
    await started()
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    c.close()
  })

  it('does not replace a live socket', async () => {
    const first = await started()
    const second = server()
    expect(await second.start()).toBe(false)
    expect(logs.some((l) => /in use by another running instance/.test(l))).toBe(true)
    // The first still owns the file and answers.
    expect(first.listening).toBe(true)
    const c = await Client.open()
    expect(await c.request({ token: TOKEN, cmd: 'echo' })).toMatchObject({ ok: true })
    c.close()
    // And the loser's stop() does not remove the winner's file.
    await second.stop()
    expect(existsSync(sock)).toBe(true)
  })

  it('never deletes a file that is not a socket', async () => {
    writeFileSync(sock, 'precious')
    expect(await server().start()).toBe(false)
    expect(existsSync(sock)).toBe(true)
    expect(logs.some((l) => /not a socket/.test(l))).toBe(true)
  })
})

describe.runIf(POSIX)('fallback dir', () => {
  it('is created 0700 when the socket path falls back (socketPath with a long data dir)', async () => {
    const dataDir = join(root, 'd'.repeat(120))
    const uid = process.getuid!()
    const path = socketPath(dataDir, {}, uid, root)
    const dir = fallbackSocketDir(root, uid)
    expect(path.startsWith(dir)).toBe(true)
    sock = path
    await started({ path, fallbackDir: dir })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('refuses a pre-existing dir with mode 0777 and creates no socket', async () => {
    const dir = join(root, 'ccc-x')
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    const path = join(dir, 'a.sock')
    expect(await server({ path, fallbackDir: dir }).start()).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(logs.some((l) => /refusing fallback dir.*777/.test(l))).toBe(true)
  })

  it('refuses a dir owned by another uid', async () => {
    const dir = join(root, 'ccc-y')
    mkdirSync(dir, { mode: 0o700 })
    const path = join(dir, 'a.sock')
    expect(await server({ path, fallbackDir: dir, uid: process.getuid!() + 1 }).start()).toBe(false)
    expect(logs.some((l) => /owned by uid/.test(l))).toBe(true)
  })

  it('does not apply the checks when the socket is not in the fallback dir', async () => {
    const dir = join(root, 'ccc-z')
    mkdirSync(dir)
    chmodSync(dir, 0o777)
    await started({ fallbackDir: dir })
    expect(existsSync(sock)).toBe(true)
  })
})
