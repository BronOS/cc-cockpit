// The CLI client against real Unix sockets in a temp dir (under /tmp: macOS's /var/folders is long
// enough to push a socket path past sun_path). Fakes are plain `net` servers, not SocketServer, so
// each test controls exactly what the "app" does: nothing, hang, or record what it received.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import {
  HOOK_BUDGET_MS,
  SESSION_START_NOTE,
  STDIN_CAP_BYTES,
  buildHookRequestLine,
  hookSocketPath,
  readStdinCapped,
  resolveSocketPath,
  run,
  runHook,
  type SystemInputs
} from '../../src/cli/client'
import { fallbackSocketDir } from '../../src/main/paths'
import { LineFramer, MAX_LINE_BYTES, parseRequest, type Request } from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'
const TOKEN = 'b'.repeat(64)

let root: string
let sock: string
let servers: Server[]

beforeEach(() => {
  root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccl-'))
  sock = join(root, 's.sock')
  servers = []
})

afterEach(() => {
  for (const s of servers) s.close()
  rmSync(root, { recursive: true, force: true })
})

/** A listening fake app. `onRequest` gets each parsed request line; it never replies. */
function fakeApp(onRequest: (r: Request) => void = () => {}, onConnect: (s: Socket) => void = () => {}): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      onConnect(socket)
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) onRequest(parseRequest(line))
      })
      socket.on('error', () => {})
    })
    servers.push(server)
    server.listen(sock, () => resolve(server))
  })
}

const env = (over: Record<string, string> = {}): Record<string, string> => ({
  APP_TAB_TOKEN: TOKEN,
  CC_COCKPIT_SOCK: sock,
  ...over
})
const stdinOf = (text: string): Readable => Readable.from([Buffer.from(text)])

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('runHook: the app is not there', () => {
  it('resolves quietly when the socket file does not exist (ENOENT)', async () => {
    await expect(runHook('Stop', env(), stdinOf('{}'))).resolves.toBeUndefined()
  })

  it.skipIf(!POSIX)('resolves quietly when the socket file is stale (ECONNREFUSED)', async () => {
    // A listener killed with SIGKILL leaves its socket file behind with nobody behind it.
    try {
      execFileSync(process.execPath, [
        '-e',
        `require('net').createServer().listen(${JSON.stringify(sock)}, () => process.kill(process.pid, 'SIGKILL'))`
      ])
    } catch {
      // killed by the signal, as intended
    }
    expect(existsSync(sock)).toBe(true)
    await expect(runHook('Stop', env(), stdinOf('{}'))).resolves.toBeUndefined()
  })

  it('resolves after the budget when stdin never ends', async () => {
    await fakeApp()
    const started = Date.now()
    await runHook('Stop', env(), new PassThrough())
    // Bounded by the budget: well below "hangs until Claude kills the hook". The headroom is for a
    // loaded machine; vitest's 5 s test timeout is the backstop either way.
    expect(Date.now() - started).toBeLessThan(HOOK_BUDGET_MS + 1500)
  })

  it('resolves after the budget when the app never reads', async () => {
    // A 900 KiB payload fills the socket buffer of a peer that does not read, so the write cannot
    // finish; the budget must cut it off.
    await fakeApp(
      () => {},
      (s) => s.pause()
    )
    const big = JSON.stringify({ x: 'a'.repeat(900 * 1024) })
    const started = Date.now()
    await runHook('PreToolUse', env(), stdinOf(big))
    // Same bound and headroom as above: the write never finishes, so only the budget ends it.
    expect(Date.now() - started).toBeLessThan(HOOK_BUDGET_MS + 1500)
  })

  it('does not connect without a tab token, even when something listens at the socket', async () => {
    let connections = 0
    await fakeApp(
      () => {},
      () => connections++
    )
    await runHook('Stop', env({ APP_TAB_TOKEN: '' }), stdinOf('{}'))
    await new Promise((r) => setTimeout(r, 50))
    expect(connections).toBe(0)
  })

  it('does not connect inside a tab that has no CC_COCKPIT_SOCK (an app that is not listening)', async () => {
    let connections = 0
    await fakeApp(
      () => {},
      () => connections++
    )
    // Even if the default path would have led to a listener, a tab never computes one.
    await runHook('Stop', { APP_TAB_TOKEN: TOKEN, CC_COCKPIT_DATA_DIR: root }, stdinOf('{}'))
    await new Promise((r) => setTimeout(r, 50))
    expect(connections).toBe(0)
  })
})

describe('runHook: the app is up', () => {
  it('sends the token, the event and the payload as one request line', async () => {
    const seen: Request[] = []
    await fakeApp((r) => seen.push(r))
    const payload = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }
    await runHook('PreToolUse', env(), stdinOf(JSON.stringify(payload)))
    const request = await waitFor(() => seen[0])
    expect(request).toMatchObject({
      v: 1,
      cmd: 'hook',
      token: TOKEN,
      args: { event: 'PreToolUse', payload }
    })
    expect(request.args.truncated).toBeUndefined()
    expect(request.project).toBeUndefined()
  })

  it('does not wait for a reply: resolves while the app stays silent', async () => {
    const seen: Request[] = []
    await fakeApp((r) => seen.push(r))
    const started = Date.now()
    // A 10 s budget: a client that waited for a reply (the fake app never sends one) would run
    // into it, past vitest's 5 s test timeout. Resolving well before it proves it did not wait,
    // without a bound tight enough to trip on a slow machine.
    await runHook('Stop', env(), stdinOf('{}'), 10_000)
    expect(Date.now() - started).toBeLessThan(3000)
    await waitFor(() => seen[0])
  })

  it('sends payload null for text that is not JSON', async () => {
    const seen: Request[] = []
    await fakeApp((r) => seen.push(r))
    await runHook('Stop', env(), stdinOf('not json'))
    expect((await waitFor(() => seen[0])).args).toEqual({ event: 'Stop', payload: null })
  })

  it('marks a payload over the stdin cap as truncated and drops it', async () => {
    const seen: Request[] = []
    await fakeApp((r) => seen.push(r))
    await runHook('Stop', env(), stdinOf('{"p":"' + 'a'.repeat(STDIN_CAP_BYTES) + '"}'))
    expect((await waitFor(() => seen[0])).args).toEqual({ event: 'Stop', payload: null, truncated: true })
  })

  it('run() parses argv and dispatches the hook', async () => {
    const seen: Request[] = []
    await fakeApp((r) => seen.push(r))
    await run(['hook', 'SessionEnd'], env(), stdinOf('{"reason":"exit"}'))
    expect((await waitFor(() => seen[0])).args).toEqual({ event: 'SessionEnd', payload: { reason: 'exit' } })
  })

  it('run() answers a hook with exit code 0 whatever happens', async () => {
    await expect(run(['hook', 'Stop'], env(), stdinOf('{}'))).resolves.toBe(0) // no app listening
  })

  it('run() with a hook line it does not know does nothing and does not throw', async () => {
    let connections = 0
    await fakeApp(
      () => {},
      () => connections++
    )
    await expect(run(['hook', 'Bogus'], env(), stdinOf('{}'))).resolves.toBe(0)
    expect(connections).toBe(0)
  })

  describe('the SessionStart note', () => {
    /** An Output that records, and the order of stdout writes against the app receiving the hook. */
    function recorder(): { out: { stdout(t: string): void; stderr(t: string): void }; log: string[] } {
      const log: string[] = []
      return { log, out: { stdout: (t) => log.push(`stdout:${t}`), stderr: (t) => log.push(`stderr:${t}`) } }
    }

    it('is printed on stdout before the event is delivered, and the event still arrives', async () => {
      const { out, log } = recorder()
      await fakeApp((r) => log.push(`delivered:${(r.args as { event: string }).event}`))
      await expect(run(['hook', 'SessionStart'], env(), stdinOf('{"source":"startup"}'), out)).resolves.toBe(0)
      await waitFor(() => log.find((l) => l.startsWith('delivered:')))
      expect(log).toEqual([`stdout:${SESSION_START_NOTE}\n`, 'delivered:SessionStart'])
    })

    it('is printed when the app is not running, and the hook exits 0', async () => {
      const { out, log } = recorder()
      await expect(run(['hook', 'SessionStart'], env(), stdinOf('{}'), out)).resolves.toBe(0)
      expect(log).toEqual([`stdout:${SESSION_START_NOTE}\n`])
    })

    it('is printed outside a tab too (no token, no socket), with exit 0', async () => {
      const { out, log } = recorder()
      await expect(run(['hook', 'SessionStart'], {}, stdinOf('{}'), out)).resolves.toBe(0)
      expect(log).toEqual([`stdout:${SESSION_START_NOTE}\n`])
    })

    it('a stdout that throws does not fail the hook or stop delivery', async () => {
      const seen: Request[] = []
      await fakeApp((r) => seen.push(r))
      const out = {
        stdout: () => {
          throw new Error('EPIPE')
        },
        stderr: () => {}
      }
      await expect(run(['hook', 'SessionStart'], env(), stdinOf('{}'), out)).resolves.toBe(0)
      expect((await waitFor(() => seen[0])).args).toMatchObject({ event: 'SessionStart' })
    })

    it('no other event prints anything', async () => {
      for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd', 'Bogus']) {
        const { out, log } = recorder()
        await expect(run(['hook', event], env(), stdinOf('{}'), out)).resolves.toBe(0)
        expect(log, event).toEqual([])
      }
    })

    it('is one line naming ccc guide and ccc help', () => {
      expect(SESSION_START_NOTE).not.toMatch(/\n/)
      expect(SESSION_START_NOTE).toContain('`ccc guide`')
      expect(SESSION_START_NOTE).toContain('`ccc help`')
      expect(Buffer.byteLength(SESSION_START_NOTE)).toBeLessThan(512)
    })
  })
})

describe('buildHookRequestLine', () => {
  it('keeps a payload under the stdin cap whose request line would still exceed the line limit out of the socket', () => {
    // 1 MiB of payload fits the stdin cap, but the envelope pushes the line over the server's cap.
    const text = JSON.stringify({ x: 'a'.repeat(MAX_LINE_BYTES - 20) })
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(STDIN_CAP_BYTES)
    const line = buildHookRequestLine('Stop', TOKEN, { text, truncated: false })
    expect(Buffer.byteLength(line) - 1).toBeLessThanOrEqual(MAX_LINE_BYTES)
    expect(parseRequest(line.trim()).args).toEqual({ event: 'Stop', payload: null, truncated: true })
  })

  it('treats empty stdin as payload null without a truncated flag', () => {
    const line = buildHookRequestLine('Stop', TOKEN, { text: '', truncated: false })
    expect(parseRequest(line.trim()).args).toEqual({ event: 'Stop', payload: null })
  })
})

describe('readStdinCapped', () => {
  it('reads everything under the cap', async () => {
    expect(await readStdinCapped(stdinOf('héllo'), 100)).toEqual({ text: 'héllo', truncated: false })
  })

  it('stops at the cap and flags it', async () => {
    const out = await readStdinCapped(Readable.from([Buffer.from('a'.repeat(50)), Buffer.from('b'.repeat(50))]), 60)
    expect(out.truncated).toBe(true)
    expect(out.text).toBe('a'.repeat(50) + 'b'.repeat(10))
  })

  it('resolves on a stream error', async () => {
    const stream = new PassThrough()
    const pending = readStdinCapped(stream)
    stream.destroy(new Error('EBADF'))
    expect(await pending).toEqual({ text: '', truncated: false, error: 'EBADF' })
  })

  it('reports an error after partial input, not a clean end', async () => {
    const stream = new PassThrough()
    const pending = readStdinCapped(stream)
    stream.write('{"partial":')
    await new Promise((r) => setImmediate(r))
    stream.destroy(new Error('EIO: i/o error, read'))
    expect(await pending).toEqual({ text: '{"partial":', truncated: false, error: 'EIO: i/o error, read' })
  })
})

describe('socket path resolution', () => {
  it('hook: only inside a tab and only from CC_COCKPIT_SOCK', () => {
    expect(hookSocketPath({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: '/s' })).toBe('/s')
    expect(hookSocketPath({ APP_TAB_TOKEN: TOKEN })).toBeUndefined()
    expect(hookSocketPath({ CC_COCKPIT_SOCK: '/s' })).toBeUndefined()
    expect(hookSocketPath({ APP_TAB_TOKEN: '', CC_COCKPIT_SOCK: '/s' })).toBeUndefined()
  })

  const system = (tmp: string, uid = process.getuid?.() ?? 0): SystemInputs => ({
    platform: 'linux',
    uid,
    tmpdir: tmp,
    home: '/home/x'
  })

  it('inside a tab without CC_COCKPIT_SOCK: nothing is computed', () => {
    expect(resolveSocketPath({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_DATA_DIR: root }, system(root))).toBeUndefined()
  })

  it('outside a tab: $CC_COCKPIT_SOCK, else <data>/app.sock from CC_COCKPIT_DATA_DIR, else the platform default', () => {
    expect(resolveSocketPath({ CC_COCKPIT_SOCK: '/tmp/x.sock' }, system(root))).toBe('/tmp/x.sock')
    expect(resolveSocketPath({ CC_COCKPIT_DATA_DIR: '/d' }, system(root))).toBe('/d/app.sock')
    expect(resolveSocketPath({}, system(root))).toBe('/home/x/.config/cc-cockpit/app.sock')
    expect(resolveSocketPath({ XDG_CONFIG_HOME: '/xdg' }, system(root))).toBe('/xdg/cc-cockpit/app.sock')
    expect(resolveSocketPath({}, { ...system(root), platform: 'darwin' })).toBe(
      '/home/x/Library/Application Support/cc-cockpit/app.sock'
    )
  })

  describe.skipIf(!POSIX)('fallback directory (over-long data dir)', () => {
    const longData = '/' + 'd'.repeat(120)
    const uid = process.getuid?.() ?? 0

    it('is used when it is our own 0700 directory', () => {
      mkdirSync(fallbackSocketDir(root, uid), { mode: 0o700 })
      const path = resolveSocketPath({ CC_COCKPIT_DATA_DIR: longData }, system(root))
      expect(path).toMatch(new RegExp(`^${root}/ccc-${uid}/[0-9a-f]{12}\\.sock$`))
    })

    it('is refused when it does not exist (the server creates it; a CLI never does)', () => {
      expect(resolveSocketPath({ CC_COCKPIT_DATA_DIR: longData }, system(root))).toBeUndefined()
    })

    it('is refused when group/other can enter it', () => {
      const dir = fallbackSocketDir(root, uid)
      mkdirSync(dir)
      chmodSync(dir, 0o777)
      expect(resolveSocketPath({ CC_COCKPIT_DATA_DIR: longData }, system(root))).toBeUndefined()
    })

    it('is refused when another uid owns it', () => {
      mkdirSync(fallbackSocketDir(root, uid), { mode: 0o700 })
      expect(resolveSocketPath({ CC_COCKPIT_DATA_DIR: longData }, system(root, uid + 1))).toBeUndefined()
    })

    it('is refused when it is a symlink or a file', () => {
      writeFileSync(fallbackSocketDir(root, uid), '')
      expect(resolveSocketPath({ CC_COCKPIT_DATA_DIR: longData }, system(root))).toBeUndefined()
    })
  })
})
