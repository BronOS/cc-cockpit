// Plugin CLI routing (plan B Task 5), layer by layer:
//   - the shared caps (encoded size, exit codes);
//   - parseArgs: which words become a plugin command;
//   - the CLI client (runPlugin, ccc help) against a fake app on a real Unix socket;
//   - main's socket handlers (owner, enabled, window, argument checks);
//   - HostManager.runCli wired to a real HostContexts over an in-memory port: routing, timeout,
//     in-flight cap, truncation, cancellation on dispose and on peer gone.
// Sockets live under /tmp: macOS's /var/folders is long enough to push a path past sun_path.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { parseArgs, USAGE } from '../../src/cli/args'
import { pluginHelp, REPLY_TIMEOUT_MS, run, STDIN_READ_TIMEOUT_MS, type Output } from '../../src/cli/client'
import { HostContexts } from '../../src/host/ctx'
import type { HostPluginSpec } from '../../src/host/loader'
import { RpcEndpoint } from '../../src/host/rpc'
import type { PluginContext } from '../../src/sdk/types'
import { HostManager, type HostCliCall, type HostPlugin, type HostProcess, type HostProcessFactory } from '../../src/main/plugins/host-manager'
import { pluginCliHandler, pluginCliListHandler, pluginCliSpecHandler, type PluginCliOptions } from '../../src/main/socket/handlers'
import type { Caller } from '../../src/main/socket/socket-server'
import type { CliContribution } from '../../src/shared/manifest'
import {
  capEncoded,
  CLI_CALL_TIMEOUT_MS,
  CLI_CLIENT_DEADLINE_MS,
  CLI_REPLY_TIMEOUT_MS,
  CLI_TIMEOUT_CODE,
  CLI_TRUNCATED_MARKER,
  encodedBytes,
  exitCodeOf,
  MAX_CLI_IN_FLIGHT,
  MAX_CLI_IO_BYTES,
  normalizeCliResult,
  type PluginCliResult,
  type PluginCliSpec
} from '../../src/shared/plugin-cli'
import { encodeReply, LineFramer, MAX_LINE_BYTES, parseRequest, type Request } from '../../src/shared/protocol'
import { memoryPortPair } from '../fakes/memory-port'

const POSIX = process.platform !== 'win32'
const TOKEN = 'd'.repeat(64)
const CWD = '/work/dir'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

async function waitFor<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('shared caps', () => {
  it('measures JSON-encoded UTF-8 bytes', () => {
    expect(encodedBytes('ab')).toBe(4)
    expect(encodedBytes('\u0001')).toBe(8) // "\u0001" with its quotes
    expect(encodedBytes('"')).toBe(4)
    expect(encodedBytes('é')).toBe(4)
    expect(encodedBytes('😀')).toBe(6)
  })

  it('leaves text that fits alone and cuts the rest to fit with the marker', () => {
    expect(capEncoded('hello', 100)).toBe('hello')
    const cut = capEncoded('x'.repeat(1000), 100)
    expect(cut.endsWith(CLI_TRUNCATED_MARKER)).toBe(true)
    expect(encodedBytes(cut)).toBeLessThanOrEqual(100)
    expect(encodedBytes(capEncoded('x'.repeat(1000), 100).slice(0, -CLI_TRUNCATED_MARKER.length) + 'xx' + CLI_TRUNCATED_MARKER)).toBeGreaterThan(100)
  })

  it('caps by the encoded size: characters JSON escapes count six times', () => {
    // 100 000 raw bytes, 600 000 once encoded: over the 256 KiB cap although the raw text is not.
    const text = '\u0001'.repeat(100_000)
    expect(text.length).toBeLessThan(MAX_CLI_IO_BYTES)
    const cut = capEncoded(text)
    expect(cut.endsWith(CLI_TRUNCATED_MARKER)).toBe(true)
    expect(encodedBytes(cut)).toBeLessThanOrEqual(MAX_CLI_IO_BYTES)
    expect(encodedBytes(cut)).toBeGreaterThan(MAX_CLI_IO_BYTES - 16)
  })

  it('never cuts inside a surrogate pair', () => {
    const cut = capEncoded('😀'.repeat(100), 41)
    const body = cut.slice(0, -CLI_TRUNCATED_MARKER.length)
    expect(body.length % 2).toBe(0)
    expect(body).toBe('😀'.repeat(body.length / 2))
  })

  it('makes any value a real exit code', () => {
    expect(exitCodeOf(undefined)).toBe(0)
    expect(exitCodeOf(7)).toBe(7)
    expect(exitCodeOf(255)).toBe(255)
    expect(exitCodeOf(300)).toBe(1)
    expect(exitCodeOf(-1)).toBe(1)
    expect(exitCodeOf(1.5)).toBe(1)
    expect(exitCodeOf('0')).toBe(1)
  })

  it('the CLI waits past main\'s own timeout, so main\'s exit 124 arrives first', () => {
    expect(CLI_REPLY_TIMEOUT_MS).toBeGreaterThan(CLI_CALL_TIMEOUT_MS)
    // The hard backstop comes last: it never cuts a reply the timers before it would let through.
    expect(CLI_CLIENT_DEADLINE_MS).toBeGreaterThan(CLI_REPLY_TIMEOUT_MS)
    expect(CLI_CALL_TIMEOUT_MS).toBe(30_000)
    expect(REPLY_TIMEOUT_MS).toBeLessThan(CLI_CALL_TIMEOUT_MS)
  })

  it('normalizes an untrusted result', () => {
    expect(normalizeCliResult(undefined)).toEqual({ stdout: '', stderr: '', code: 0 })
    expect(normalizeCliResult({ stdout: 5, stderr: 'e', code: 2 })).toEqual({ stdout: '', stderr: 'e', code: 2 })
    expect(normalizeCliResult('text')).toEqual({ stdout: '', stderr: '', code: 0 })
  })
})

describe('parseArgs: plugin commands', () => {
  it('a word with the name shape is a plugin command, the rest verbatim', () => {
    expect(parseArgs(['demo', 'echo', '--x', 'a b'])).toEqual({ kind: 'plugin', name: 'demo', argv: ['echo', '--x', 'a b'] })
    expect(parseArgs(['my-tool'])).toEqual({ kind: 'plugin', name: 'my-tool', argv: [] })
    expect(parseArgs(['demo', '--help'])).toEqual({ kind: 'plugin', name: 'demo', argv: ['--help'] })
  })

  it.each([['x'], ['Demo'], ['9lives'], ['de.mo'], ['-demo'], ['app'], ['config'], ['version']])('%s is a usage error', (name) => {
    expect(parseArgs([name])).toEqual({ kind: 'usage', message: `unknown command: ${name}` })
  })

  it('core commands keep their meaning', () => {
    expect(parseArgs(['sessions']).kind).toBe('sessions')
    expect(parseArgs(['help']).kind).toBe('help')
  })

  it('--project before a plugin command names the project', () => {
    expect(parseArgs(['--project', '/p', 'demo', 'a'])).toEqual({ kind: 'plugin', name: 'demo', argv: ['a'], project: '/p' })
    expect(parseArgs(['--project'])).toMatchObject({ kind: 'usage' })
    expect(parseArgs(['--project', '/p'])).toMatchObject({ kind: 'usage' })
    // Review finding (ext round 8): a help request after the prefix, not "unknown command: --help".
    expect(parseArgs(['--project', '/p', '--help'])).toEqual({ kind: 'help' })
    expect(parseArgs(['--project', '/p', '-h'])).toEqual({ kind: 'help' })
    // Only a plugin command may follow: overlay takes its own --project after its name.
    // Review finding (ext round 10): it said "unknown command: overlay"; it names where --project goes.
    expect(parseArgs(['--project', '/p', 'overlay', '--url', 'https://x'])).toEqual({
      kind: 'usage',
      message: 'overlay takes --project after its name: ccc overlay --project <path> ...'
    })
    expect(parseArgs(['--project', '/p', 'plugin', 'list'])).toEqual({
      kind: 'usage',
      message: 'plugin takes --project after its name: ccc plugin link|unlink|list --project <path> ...'
    })
    expect(parseArgs(['--project', '/p', 'sessions'])).toEqual({
      kind: 'usage',
      message: 'sessions takes no --project (it goes before a plugin command only)'
    })
  })

  it('the usage text names plugin commands', () => {
    expect(USAGE).toContain('ccc [--project <path>] <plugin command> [args...]')
  })
})

describe.skipIf(!POSIX)('the CLI client', () => {
  let root: string
  let sock: string
  let servers: Server[]
  /** Requests the fake app received, oldest first. */
  let received: Request[]
  /** How the fake app answers a request; undefined means never. */
  let answer: (r: Request) => { ok: true; result: unknown } | { ok: false; error: string } | undefined

  beforeEach(async () => {
    root = mkdtempSync(join('/tmp', 'cpc-'))
    sock = join(root, 's.sock')
    servers = []
    received = []
    answer = () => ({ ok: true, result: null })
    await new Promise<void>((resolve) => {
      const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
        const framer = new LineFramer()
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            const r = parseRequest(line)
            received.push(r)
            const a = answer(r)
            if (a) socket.write(encodeReply({ id: r.id, ...a }))
          }
        })
        socket.on('error', () => {})
      })
      servers.push(server)
      server.listen(sock, () => resolve())
    })
  })

  afterEach(() => {
    for (const s of servers) s.close()
    rmSync(root, { recursive: true, force: true })
  })

  const env = (over: Record<string, string> = {}): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock, ...over })
  const out = (): { o: string; e: string; io: Output } => {
    const r = { o: '', e: '', io: { stdout: (t: string) => void (r.o += t), stderr: (t: string) => void (r.e += t) } }
    return r
  }
  const spec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'demo',
    pluginId: 'test.hostcli',
    summary: 'Echo',
    usage: 'demo echo <words...>',
    stdin: false,
    ...over
  })
  /** A fake app with a spec and a result for `plugin.cli`. */
  const app = (s: Record<string, unknown>, result: unknown): void => {
    answer = (r) => {
      if (r.cmd === 'plugin.cli.spec') return { ok: true, result: s }
      if (r.cmd === 'plugin.cli') return { ok: true, result }
      return { ok: false, error: `unexpected ${r.cmd}` }
    }
  }

  it('asks for the spec, then runs the call with the argv verbatim; prints output, keeps the exit code', async () => {
    app(spec(), { stdout: 'a b\n', stderr: 'warn\n', code: 3 })
    const o = out()
    expect(await run(['demo', 'echo', 'a', 'b'], env(), Readable.from([]), o.io, CWD)).toBe(3)
    expect(o.o).toBe('a b\n')
    expect(o.e).toBe('warn\n')
    expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec', 'plugin.cli'])
    expect(received[0]).toMatchObject({ token: TOKEN, args: { name: 'demo' } })
    // No stdin key at all for a command that does not take it.
    expect(received[1]?.args).toEqual({ name: 'demo', argv: ['echo', 'a', 'b'], cwd: CWD })
  })

  it('an error from main (unknown command, disabled plugin) is exit 1 with the reason; the call is not made', async () => {
    answer = () => ({ ok: false, error: 'unknown command: demo' })
    const o = out()
    expect(await run(['demo'], env(), Readable.from([]), o.io, CWD)).toBe(1)
    expect(o.e).toBe('ccc: unknown command: demo\n')
    expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec'])
  })

  it('an error on the call itself (host down) is exit 1 with the reason', async () => {
    answer = (r) =>
      r.cmd === 'plugin.cli.spec' ? { ok: true, result: spec() } : { ok: false, error: 'demo: plugin test.hostcli is not running in this window' }
    const o = out()
    expect(await run(['demo'], env(), Readable.from([]), o.io, CWD)).toBe(1)
    expect(o.e).toContain('is not running')
  })

  it('an error from main has its control characters turned into spaces', async () => {
    answer = (r) => (r.cmd === 'plugin.cli.spec' ? { ok: true, result: spec() } : { ok: false, error: 'demo: \u001b[31mred\u009b' })
    const o = out()
    expect(await run(['demo'], env(), Readable.from([]), o.io, CWD)).toBe(1)
    expect(o.e).toBe('ccc: demo:  [31mred \n')
  })

  it('<name> --help prints the declared usage and summary without calling the plugin', async () => {
    app(spec(), { stdout: 'ran' })
    const o = out()
    expect(await run(['demo', '--help'], env(), Readable.from([]), o.io, CWD)).toBe(0)
    expect(o.o).toBe('usage: ccc demo echo <words...>\nEcho\n')
    expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec'])
  })

  it('--help strips control characters from the manifest text', async () => {
    app(spec({ usage: 'demo \u001b[31mred', summary: 'x\ny' }), null)
    const o = out()
    await run(['demo', '-h'], env(), Readable.from([]), o.io, CWD)
    expect(o.o).toBe('usage: ccc demo  [31mred\nx y\n')
  })

  it('a stdin: false command with an open, silent pipe returns without waiting for it', async () => {
    app(spec(), { stdout: 'done\n' })
    const silent = new PassThrough() // never written, never ended
    const o = out()
    const started = Date.now()
    expect(await run(['demo', 'echo'], env(), silent, o.io, CWD)).toBe(0)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(o.o).toBe('done\n')
  })

  it('a stdin: true command reads stdin and sends it', async () => {
    app(spec({ stdin: true }), { stdout: 'ok' })
    expect(await run(['demo'], env(), Readable.from([Buffer.from('piped text')]), out().io, CWD)).toBe(0)
    expect(received[1]?.args).toEqual({ name: 'demo', argv: [], cwd: CWD, stdin: 'piped text' })
  })

  it('a stdin read error after partial input is exit 1 and the plugin is not called (review finding)', async () => {
    app(spec({ stdin: true }), { stdout: 'ok' })
    const failing = new PassThrough()
    failing.write('{"half":')
    setTimeout(() => failing.destroy(new Error('EIO: i/o error, read')), 10)
    const o = out()
    expect(await run(['demo'], env(), failing, o.io, CWD)).toBe(1)
    expect(o.e).toBe('ccc: demo: reading stdin failed: EIO: i/o error, read\n')
    expect(o.o).toBe('')
    expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec'])
  })

  it('a stdin: true command whose stdin never ends: exit 124 naming stdin, the call not made', async () => {
    app(spec({ stdin: true }), { stdout: 'ok' })
    const open = new PassThrough() // a pipe nobody writes to or closes
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
    try {
      const o = out()
      const running = run(['demo'], env(), open, o.io, CWD)
      for (let i = 0; i < 500 && received.length < 1; i++) await turn()
      await turn()
      vi.advanceTimersByTime(STDIN_READ_TIMEOUT_MS)
      expect(await running).toBe(CLI_TIMEOUT_CODE)
      expect(o.e).toBe(`ccc: demo: stdin was not closed within ${STDIN_READ_TIMEOUT_MS / 1000} s; pipe input or redirect </dev/null\n`)
      expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stdin: true command with a terminal that never ends sends empty stdin at once', async () => {
    app(spec({ stdin: true }), { stdout: 'ok' })
    // A PassThrough never ends: reading it would hang the test, not just slow it.
    const tty = Object.assign(new PassThrough(), { isTTY: true })
    expect(await run(['demo'], env(), tty, out().io, CWD)).toBe(0)
    expect(received[1]?.args).toMatchObject({ stdin: '' })
  })

  it('a stdin: true command does not read a terminal', async () => {
    app(spec({ stdin: true }), { stdout: 'ok' })
    const tty = Object.assign(new PassThrough(), { isTTY: true })
    expect(await run(['demo'], env(), tty, out().io, CWD)).toBe(0)
    expect(received[1]?.args).toMatchObject({ stdin: '' })
  })

  it('refuses stdin over the cap, measured encoded, before sending the call', async () => {
    app(spec({ stdin: true }), { stdout: 'ok' })
    // 50 000 raw bytes, 300 000 once encoded.
    const o = out()
    expect(await run(['demo'], env(), Readable.from([Buffer.from('\u0001'.repeat(50_000))]), o.io, CWD)).toBe(1)
    expect(o.e).toContain('stdin is over 256 KiB')
    expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec'])
    // And plainly over the cap in raw bytes.
    received = []
    expect(await run(['demo'], env(), Readable.from([Buffer.alloc(MAX_CLI_IO_BYTES + 10, 0x61)]), out().io, CWD)).toBe(1)
    expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec'])
  })

  it('keeps every request line under the socket limit with stdin at the cap', async () => {
    app(spec({ stdin: true }), { stdout: '' })
    const text = 'a'.repeat(MAX_CLI_IO_BYTES - 2)
    expect(await run(['demo'], env(), Readable.from([Buffer.from(text)]), out().io, CWD)).toBe(0)
    expect(received[1]?.args.stdin).toBe(text)
    expect(Buffer.byteLength(JSON.stringify(received[1]))).toBeLessThan(MAX_LINE_BYTES)
  })

  it('caps the printed output again (a reply the app did not cap)', async () => {
    app(spec(), { stdout: 'x'.repeat(MAX_CLI_IO_BYTES + 100) })
    const o = out()
    expect(await run(['demo'], env(), Readable.from([]), o.io, CWD)).toBe(0)
    expect(o.o.endsWith(CLI_TRUNCATED_MARKER)).toBe(true)
  })

  it('outside a tab it needs --project, and sends it resolved against the cwd', async () => {
    app(spec(), { stdout: 'ok\n' })
    const noTab = { CC_COCKPIT_SOCK: sock }
    const o = out()
    expect(await run(['demo'], noTab, Readable.from([]), o.io, CWD)).toBe(2)
    expect(o.e).toContain('needs --project')
    expect(received).toEqual([])
    expect(await run(['--project', 'proj', 'demo'], noTab, Readable.from([]), out().io, CWD)).toBe(0)
    expect(received.map((r) => [r.cmd, r.project, r.token])).toEqual([
      ['plugin.cli.spec', '/work/dir/proj', undefined],
      ['plugin.cli', '/work/dir/proj', undefined]
    ])
  })

  it('no reply to the call is exit 124 with a message, never a hang (friction round 1, Task 2)', async () => {
    // The spec is answered, the call never is: main stuck, or a reply lost on the way.
    answer = (r) => (r.cmd === 'plugin.cli.spec' ? { ok: true, result: spec() } : undefined)
    // Only the timers are faked: the sockets stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
    try {
      const o = out()
      const running = run(['demo'], env(), Readable.from([]), o.io, CWD)
      for (let i = 0; i < 500 && received.length < 2; i++) await turn()
      expect(received.map((r) => r.cmd)).toEqual(['plugin.cli.spec', 'plugin.cli'])
      vi.advanceTimersByTime(CLI_REPLY_TIMEOUT_MS - 1)
      await turn()
      vi.advanceTimersByTime(1)
      expect(await running).toBe(CLI_TIMEOUT_CODE)
      expect(o.e).toBe(`ccc: demo: no answer from the app within ${CLI_REPLY_TIMEOUT_MS / 1000} s\n`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exits 0 silently when the app is not running', async () => {
    const o = out()
    expect(await run(['demo', 'x'], env({ CC_COCKPIT_SOCK: join(root, 'none.sock') }), Readable.from([]), o.io, CWD)).toBe(0)
    expect(o).toMatchObject({ o: '', e: '' })
  })

  describe('ccc help', () => {
    it('inside a tab appends the project\'s plugin commands', async () => {
      answer = (r) =>
        r.cmd === 'plugin.cli.list'
          ? {
              ok: true,
              result: [
                { name: 'demo', summary: 'Echo the arguments back', usage: 'demo echo <words...>' },
                { name: 'long', summary: 'Long one', usage: `long ${'x'.repeat(50)}` }
              ]
            }
          : undefined
      const o = out()
      expect(await run(['help'], env(), Readable.from([]), o.io, CWD)).toBe(0)
      expect(o.o.startsWith(`${USAGE}\n`)).toBe(true)
      expect(o.o).toContain('plugin commands of this project:\n')
      expect(o.o).toContain(`${'  ccc demo echo <words...>'.padEnd(43)}Echo the arguments back\n`)
      expect(o.o).toContain(`  ccc long ${'x'.repeat(50)}\n${' '.repeat(43)}Long one\n`)
      expect(received[0]).toMatchObject({ cmd: 'plugin.cli.list', token: TOKEN })
    })

    it('prints only the core usage when the app does not answer or refuses', async () => {
      answer = () => ({ ok: false, error: 'nope' })
      const o = out()
      expect(await run(['help'], env(), Readable.from([]), o.io, CWD)).toBe(0)
      expect(o.o).toBe(`${USAGE}\n`)
      expect(await pluginHelp(env({ CC_COCKPIT_SOCK: join(root, 'none.sock') }))).toBe('')
    })

    it('outside a tab does not connect at all', async () => {
      const o = out()
      expect(await run(['help'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), o.io, CWD)).toBe(0)
      expect(o.o).toBe(`${USAGE}\n`)
      expect(received).toEqual([])
    })

    it('one command\'s help does not ask for the list', async () => {
      const o = out()
      await run(['notify', '--help'], env(), Readable.from([]), o.io, CWD)
      expect(received).toEqual([])
    })
  })
})

describe('socket handlers', () => {
  const demo: CliContribution = { name: 'demo', summary: 'Echo', usage: 'demo echo' }
  const piped: CliContribution = { name: 'pipe', summary: 'Pipe', stdin: true }
  let calls: { projectId: string; pluginId: string; call: HostCliCall }[]
  let enabled: Set<string>
  let windowOpen: boolean
  let options: PluginCliOptions

  beforeEach(() => {
    calls = []
    enabled = new Set(['test.hostcli'])
    windowOpen = true
    options = {
      cliContributions: () => [demo, piped].map((cli) => ({ pluginId: 'test.hostcli', cli })),
      enabledIn: (_projectId, pluginId) => enabled.has(pluginId),
      windowIdOf: () => (windowOpen ? 1 : undefined),
      runCli: async (projectId, pluginId, call) => {
        calls.push({ projectId, pluginId, call })
        return { stdout: 'ok', stderr: '', code: 0 }
      }
    }
  })

  const tab: Caller = { kind: 'session', tabId: 't1', projectId: 'p1' }
  const args = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ name: 'demo', argv: ['a'], cwd: '/w', ...over })

  it('spec: from the manifest, without asking the host', async () => {
    expect(await pluginCliSpecHandler(options)({ name: 'demo' }, tab)).toEqual({
      name: 'demo',
      pluginId: 'test.hostcli',
      summary: 'Echo',
      usage: 'demo echo',
      stdin: false
    })
    expect(calls).toEqual([])
  })

  it('routes a call to the owner in the caller\'s project', async () => {
    expect(await pluginCliHandler(options)(args(), tab)).toEqual({ stdout: 'ok', stderr: '', code: 0 })
    expect(calls).toEqual([{ projectId: 'p1', pluginId: 'test.hostcli', call: { name: 'demo', argv: ['a'], stdin: '', cwd: '/w' } }])
  })

  it('an unknown name, a plugin not enabled here, a closed window: the reason', async () => {
    const h = pluginCliHandler(options)
    await expect(h(args({ name: 'nope' }), tab)).rejects.toThrow('unknown command: nope')
    enabled.clear()
    await expect(h(args(), tab)).rejects.toThrow('demo comes from plugin test.hostcli, which is not enabled in this project')
    expect(() => pluginCliSpecHandler(options)({ name: 'demo' }, tab)).toThrow('not enabled')
    enabled.add('test.hostcli')
    windowOpen = false
    await expect(h(args(), tab)).rejects.toThrow('that project is not open')
    expect(calls).toEqual([])
  })

  it('a window token (a shell or command tab) runs in its own project, spec, call and list alike', async () => {
    const win: Caller = { kind: 'window', projectId: 'p1' }
    expect(await pluginCliSpecHandler(options)({ name: 'demo' }, win)).toMatchObject({ name: 'demo' })
    expect(await pluginCliHandler(options)(args(), win)).toMatchObject({ code: 0 })
    expect(calls).toEqual([{ projectId: 'p1', pluginId: 'test.hostcli', call: { name: 'demo', argv: ['a'], stdin: '', cwd: '/w' } }])
    expect(((await pluginCliListHandler(options)({}, win)) as unknown[]).length).toBe(2)
  })

  it('a --project caller with no record, and an anonymous one, are refused', async () => {
    const h = pluginCliHandler(options)
    await expect(h(args(), { kind: 'project', path: '/x', projectId: undefined })).rejects.toThrow('not open')
    await expect(h(args(), { kind: 'anonymous' })).rejects.toThrow('tab token or --project')
    expect(await h(args(), { kind: 'project', path: '/x', projectId: 'p2' })).toMatchObject({ code: 0 })
    expect(calls[0]?.projectId).toBe('p2')
  })

  it('checks every field: argv strings, an absolute cwd, stdin under the cap', async () => {
    const h = pluginCliHandler(options)
    await expect(h(args({ argv: 'a' }), tab)).rejects.toThrow('argv')
    await expect(h(args({ argv: [1] }), tab)).rejects.toThrow('argv')
    await expect(h(args({ cwd: 'rel' }), tab)).rejects.toThrow('absolute cwd')
    await expect(h(args({ cwd: undefined }), tab)).rejects.toThrow('absolute cwd')
    await expect(h(args({ stdin: 5 }), tab)).rejects.toThrow('stdin')
    await expect(h(args({ name: 'pipe', stdin: '"'.repeat(MAX_CLI_IO_BYTES / 2) }), tab)).rejects.toThrow('stdin is over')
    await expect(h(args({ argv: ['x'.repeat(MAX_CLI_IO_BYTES)] }), tab)).rejects.toThrow('arguments are over')
    expect(calls).toEqual([])
  })

  it('drops stdin a command did not declare, passes it to one that did', async () => {
    const h = pluginCliHandler(options)
    await h(args({ stdin: 'secret' }), tab)
    await h(args({ name: 'pipe', stdin: 'data' }), tab)
    expect(calls.map((c) => c.call.stdin)).toEqual(['', 'data'])
  })

  it('list: the commands of the plugins enabled in the caller\'s project, by name, as spec rows', () => {
    const other: CliContribution = { name: 'alpha', summary: 'Other plugin' }
    const contributions = options.cliContributions()
    options.cliContributions = () => [...contributions, { pluginId: 'test.other', cli: other }]
    expect(pluginCliListHandler(options)({}, tab)).toEqual([
      { name: 'demo', pluginId: 'test.hostcli', summary: 'Echo', usage: 'demo echo', stdin: false },
      { name: 'pipe', pluginId: 'test.hostcli', summary: 'Pipe', stdin: true }
    ])
    enabled.add('test.other')
    expect((pluginCliListHandler(options)({}, tab) as PluginCliSpec[]).map((s) => s.name)).toEqual(['alpha', 'demo', 'pipe'])
    expect(() => pluginCliListHandler(options)({}, { kind: 'anonymous' })).toThrow(/needs a tab token or --project/)
  })
})

/**
 * A host process backed by a real HostContexts over an in-memory port: `activate` builds each
 * plugin's ctx and runs `activators[id](ctx)`, `plugin.unload` disposes one.
 */
class ContextHost implements HostProcess {
  readonly port
  readonly contexts: HostContexts
  readonly endpoint: RpcEndpoint
  readonly events: { event: string; params: unknown }[] = []
  exited = false
  private readonly exitListeners: Array<(code: number) => void> = []

  constructor(
    activators: Record<string, (ctx: PluginContext) => void>,
    /** Replaces a handler: a host that never answers `cli.run`, not even after `cli.cancel`. */
    overrides: Record<string, (params: unknown) => unknown> = {}
  ) {
    const [main, host] = memoryPortPair()
    this.port = main
    this.contexts = new HostContexts({ log: () => {}, call: async () => null })
    this.endpoint = new RpcEndpoint({
      port: host,
      handlers: {
        activate: (p) =>
          (p as { plugins: HostPluginSpec[] }).plugins.map((spec) => {
            activators[spec.id]?.(this.contexts.create(spec))
            return { id: spec.id, state: 'active' }
          }),
        deactivate: () => {
          this.contexts.disposeAll()
          return null
        },
        'plugin.unload': (p) => {
          this.contexts.dispose((p as { pluginId: string }).pluginId)
          return null
        },
        'cli.run': (p) => this.contexts.runCli(p),
        ...overrides
      },
      onEvent: (event, params) => {
        this.events.push({ event, params })
        this.contexts.handleEvent(event, params)
      }
    })
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.push(listener)
  }
  kill(): void {
    this.exit(-1)
  }
  transferPort(): void {}
  exit(code: number): void {
    if (this.exited) return
    this.exited = true
    this.endpoint.close('exited')
    queueMicrotask(() => {
      for (const l of this.exitListeners) l(code)
    })
  }
}

describe('HostManager.runCli with a real host context', () => {
  const cli: CliContribution[] = [{ name: 'demo', summary: 'Demo' }]
  let activators: Record<string, (ctx: PluginContext) => void>
  let overrides: Record<string, (params: unknown) => unknown>
  let host: ContextHost
  let manager: HostManager
  let plugins: HostPlugin[]

  beforeEach(() => {
    activators = {}
    overrides = {}
    plugins = [{ id: 'a.cli', dir: '/plugins/a.cli', main: 'host.js', panels: [], cli }]
    const factory: HostProcessFactory = {
      spawn: () => {
        host = new ContextHost(activators, overrides)
        return host
      }
    }
    manager = new HostManager({
      factory,
      plugins: () => plugins,
      env: () => ({ PATH: '/usr/bin' }),
      projectPath: () => '/projects/p1',
      layouts: { setPluginPanels: () => {}, setError: () => true },
      pluginDataDir: (projectId, pluginId) => `/data/${projectId}/${pluginId}`,
      pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
      cliTimeoutMs: 200,
      log: () => {}
    })
  })

  const call = (argv: string[] = []): HostCliCall => ({ name: 'demo', argv, stdin: '', cwd: '/w' })

  it('routes the call to the handler with argv, stdin and cwd, and returns its result', async () => {
    let seen: unknown
    activators['a.cli'] = (ctx) =>
      ctx.cli.register('demo', (argv, c) => {
        seen = { argv, stdin: c.stdin, cwd: c.cwd }
        return { stdout: `${argv.join(' ')}\n`, code: 5 }
      })
    await manager.open('p1', 1)
    expect(await manager.runCli('p1', 'a.cli', { name: 'demo', argv: ['echo', 'a'], stdin: 'in', cwd: '/w' })).toEqual({
      stdout: 'echo a\n',
      stderr: '',
      code: 5
    })
    expect(seen).toEqual({ argv: ['echo', 'a'], stdin: 'in', cwd: '/w' })
  })

  it('a name the plugin does not declare, another project, a plugin not in the launch: unknown command', async () => {
    activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => ({}))
    await manager.open('p1', 1)
    await expect(manager.runCli('p1', 'a.cli', { ...call(), name: 'other' })).rejects.toThrow('unknown command: other')
    await expect(manager.runCli('p2', 'a.cli', call())).rejects.toThrow('unknown command')
    await expect(manager.runCli('p1', 'b.other', call())).rejects.toThrow('unknown command')
  })

  it('a host that is down: not running', async () => {
    activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => ({}))
    await manager.open('p1', 1)
    host.exit(1) // a crash; the restart waits a second
    await flush()
    await expect(manager.runCli('p1', 'a.cli', call())).rejects.toThrow('plugin a.cli is not running in this window')
  })

  it('a handler the plugin never registered: the host says so', async () => {
    await manager.open('p1', 1)
    await expect(manager.runCli('p1', 'a.cli', call())).rejects.toThrow('has not registered this command')
  })

  it('a handler that throws is exit 1 with the message on stderr', async () => {
    activators['a.cli'] = (ctx) =>
      ctx.cli.register('demo', () => {
        throw new Error('boom')
      })
    await manager.open('p1', 1)
    expect(await manager.runCli('p1', 'a.cli', call())).toEqual({ stdout: '', stderr: 'ccc demo: boom\n', code: 1 })
  })

  it('a result whose fields throw, or an error whose message throws, is exit 1 at once (review finding: it hung)', async () => {
    activators['a.cli'] = (ctx) =>
      ctx.cli.register('demo', (argv) => {
        if (argv[0] === 'message') {
          throw Object.defineProperty(new Error(), 'message', {
            get(): string {
              throw new Error('no message')
            }
          })
        }
        return {
          get stdout(): string {
            throw new Error('bad getter')
          }
        }
      })
    await manager.open('p1', 1)
    expect(await manager.runCli('p1', 'a.cli', call())).toEqual({ stdout: '', stderr: 'ccc demo: bad getter\n', code: 1 })
    expect(await manager.runCli('p1', 'a.cli', call(['message']))).toEqual({ stdout: '', stderr: 'ccc demo: the command failed\n', code: 1 })
  })

  it('a handler that does not answer in time is exit 124, and its signal is aborted', async () => {
    let signal: AbortSignal | undefined
    activators['a.cli'] = (ctx) =>
      ctx.cli.register('demo', (_argv, c) => {
        signal = c.signal
        return new Promise(() => {})
      })
    await manager.open('p1', 1)
    const result = await manager.runCli('p1', 'a.cli', call())
    expect(result.code).toBe(CLI_TIMEOUT_CODE)
    expect(result.stderr).toContain('no answer within')
    await waitFor(() => (signal?.aborted ? true : undefined))
    expect(host.events.map((e) => e.event)).toContain('cli.cancel')
  })

  it('a host that never answers leaves no pending rpc call behind after the timeout or Ctrl+C', async () => {
    // A handler stuck in a loop blocks the host's event loop: not even `cli.cancel` gets an answer.
    overrides['cli.run'] = () => new Promise(() => {})
    await manager.open('p1', 1)
    const signals: AbortSignal[] = []
    const realCall = RpcEndpoint.prototype.call
    const spy = vi.spyOn(RpcEndpoint.prototype, 'call').mockImplementation(function (this: RpcEndpoint, method, params, options) {
      if (method === 'cli.run' && options?.signal) signals.push(options.signal)
      return realCall.call(this, method, params, options)
    })
    try {
      expect((await manager.runCli('p1', 'a.cli', call())).code).toBe(CLI_TIMEOUT_CODE)
      const gone = new AbortController()
      const running = manager.runCli('p1', 'a.cli', call(), gone.signal)
      await waitFor(() => (signals.length === 2 ? true : undefined))
      gone.abort()
      await expect(running).rejects.toThrow('the caller went away')
      // Both calls' rpc entries were dropped (RpcEndpoint.call removes the entry on abort).
      expect(signals.map((s) => s.aborted)).toEqual([true, true])
    } finally {
      spy.mockRestore()
    }
  })

  it('truncates output at the encoded size: a reply full of characters JSON escapes', async () => {
    activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => ({ stdout: '\u0001'.repeat(100_000), stderr: '"'.repeat(200_000) }))
    await manager.open('p1', 1)
    const result = await manager.runCli('p1', 'a.cli', call())
    for (const text of [result.stdout, result.stderr]) {
      expect(text.endsWith(CLI_TRUNCATED_MARKER)).toBe(true)
      expect(encodedBytes(text)).toBeLessThanOrEqual(MAX_CLI_IO_BYTES)
    }
    // The reply line `ccc` gets stays under the socket's limit.
    expect(Buffer.byteLength(encodeReply({ id: 1, ok: true, result }))).toBeLessThan(MAX_LINE_BYTES)
  })

  it('caps the calls in flight per plugin; a finished call frees its slot', async () => {
    const pending: Array<(r: PluginCliResult) => void> = []
    activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => new Promise((resolve) => pending.push(resolve)))
    await manager.open('p1', 1)
    const running = Array.from({ length: MAX_CLI_IN_FLIGHT }, () => manager.runCli('p1', 'a.cli', call()))
    await waitFor(() => (pending.length === MAX_CLI_IN_FLIGHT ? true : undefined))
    await expect(manager.runCli('p1', 'a.cli', call())).rejects.toThrow(`already runs ${MAX_CLI_IN_FLIGHT} commands`)
    pending[0]?.({ stdout: 'one', stderr: '', code: 0 })
    expect(await running[0]).toMatchObject({ stdout: 'one' })
    const next = manager.runCli('p1', 'a.cli', call())
    await waitFor(() => (pending.length === MAX_CLI_IN_FLIGHT + 1 ? true : undefined))
    for (const resolve of pending.slice(1)) resolve({ stdout: '', stderr: '', code: 0 })
    await Promise.all([...running, next])
  })

  it('peer gone (Ctrl+C on ccc) rejects at once, frees the slot and aborts the handler', async () => {
    const signals: AbortSignal[] = []
    activators['a.cli'] = (ctx) =>
      ctx.cli.register('demo', (_argv, c) => {
        signals.push(c.signal)
        return new Promise(() => {})
      })
    await manager.open('p1', 1)
    const gone = Array.from({ length: MAX_CLI_IN_FLIGHT }, () => new AbortController())
    const running = gone.map((g) => manager.runCli('p1', 'a.cli', call(), g.signal))
    await waitFor(() => (signals.length === MAX_CLI_IN_FLIGHT ? true : undefined))
    gone[0]?.abort()
    await expect(running[0]).rejects.toThrow('the caller went away')
    await waitFor(() => (signals[0]?.aborted ? true : undefined))
    // The slot is free again: a fifth call starts.
    const fifth = manager.runCli('p1', 'a.cli', call())
    await waitFor(() => (signals.length === MAX_CLI_IN_FLIGHT + 1 ? true : undefined))
    for (const g of gone.slice(1)) g.abort()
    await Promise.allSettled(running)
    void fifth.catch(() => {})
    // A caller already gone never starts a call.
    const done = new AbortController()
    done.abort()
    await expect(manager.runCli('p1', 'a.cli', call(), done.signal)).rejects.toThrow('went away')
  })

  it('the plugin\'s context disposed (unload, reload) answers the running call at once: exit 1', async () => {
    let signal: AbortSignal | undefined
    activators['a.cli'] = (ctx) =>
      ctx.cli.register('demo', (_argv, c) => {
        signal = c.signal
        return new Promise(() => {})
      })
    await manager.open('p1', 1)
    const running = manager.runCli('p1', 'a.cli', call())
    await waitFor(() => signal)
    host.contexts.dispose('a.cli')
    expect(await running).toEqual({ stdout: '', stderr: 'ccc demo: the plugin is deactivated\n', code: 1 })
    expect(signal?.aborted).toBe(true)
  })

  // Friction round 1, Task 2: a `ccc` command sent while its linked plugin reloads (edit, the app
  // reloads by itself, run the command) or while the window's host starts. Through the socket
  // handler as `ccc` reaches it, with the reload and the launch run by HostManager itself.
  describe('a call while the plugin is on its way in', () => {
    const tab: Caller = { kind: 'session', tabId: 't1', projectId: 'p1' }
    const viaSocket = async (): Promise<unknown> =>
      await pluginCliHandler({
        cliContributions: () => plugins.flatMap((p) => (p.cli ?? []).map((c) => ({ pluginId: p.id, cli: c }))),
        enabledIn: () => true,
        windowIdOf: () => 1,
        runCli: (projectId, pluginId, c, gone) => manager.runCli(projectId, pluginId, c, gone)
      })({ name: 'demo', argv: ['x'], cwd: '/w' }, tab)
    const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    /** `plugin.reload` as the host does it: the old ctx goes at once, the new copy comes after `ready`. */
    const reloadAfter = (ready: Promise<void>, version: string): ((params: unknown) => Promise<unknown>) => async (params) => {
      const spec = (params as { plugin: HostPluginSpec }).plugin
      host.contexts.dispose(spec.id)
      await ready
      host.contexts.create(spec).cli.register('demo', (argv) => ({ stdout: `${version} ${argv.join(' ')}\n` }))
      return { id: spec.id, state: 'active' }
    }

    it('during a dev reload: served by the new copy once it is active', async () => {
      activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => ({ stdout: 'old\n' }))
      let reloadSent = false
      const ready = later(80)
      overrides['plugin.reload'] = (params) => {
        reloadSent = true
        return reloadAfter(ready, 'new')(params)
      }
      await manager.open('p1', 1)
      const reload = manager.devReload('a.cli')
      await waitFor(() => (reloadSent ? true : undefined))
      // The old copy is gone and the new one not active yet: the call waits for it.
      expect(await viaSocket()).toEqual({ stdout: 'new x\n', stderr: '', code: 0 })
      await reload
    })

    it('during a reload that does not finish within the limit: exit 124, not a hang', async () => {
      activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => ({ stdout: 'old\n' }))
      let reloadSent = false
      overrides['plugin.reload'] = (params) => {
        reloadSent = true
        return reloadAfter(new Promise(() => {}), 'never')(params)
      }
      await manager.open('p1', 1)
      void manager.devReload('a.cli')
      await waitFor(() => (reloadSent ? true : undefined))
      const started = Date.now()
      const result = (await viaSocket()) as PluginCliResult
      expect(result.code).toBe(CLI_TIMEOUT_CODE)
      expect(result.stderr).toBe('ccc demo: plugin a.cli did not become active within 0 s\n')
      // The one limit (cliTimeoutMs: 200 here), not the limit and then the call's own on top.
      expect(Date.now() - started).toBeLessThan(400)
    })

    it('while the window\'s host is still activating (window open, app start): served once active', async () => {
      overrides.activate = async (p) => {
        await later(80)
        return (p as { plugins: HostPluginSpec[] }).plugins.map((spec) => {
          host.contexts.create(spec).cli.register('demo', (argv) => ({ stdout: `started ${argv.join(' ')}\n` }))
          return { id: spec.id, state: 'active' }
        })
      }
      const opening = manager.open('p1', 1)
      await flush()
      expect(await viaSocket()).toEqual({ stdout: 'started x\n', stderr: '', code: 0 })
      await opening
    })

    it('a plugin whose new copy failed to activate: refused at once with the reason, not a wait', async () => {
      activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => ({ stdout: 'old\n' }))
      overrides['plugin.reload'] = async (params) => {
        const spec = (params as { plugin: HostPluginSpec }).plugin
        host.contexts.dispose(spec.id)
        return { id: spec.id, state: 'errored', error: 'activate() failed: boom' }
      }
      await manager.open('p1', 1)
      await manager.devReload('a.cli')
      await expect(viaSocket()).rejects.toThrow('plugin a.cli is not running in this window')
    })
  })

  it('the host exiting mid-call rejects it', async () => {
    activators['a.cli'] = (ctx) => ctx.cli.register('demo', () => new Promise(() => {}))
    await manager.open('p1', 1)
    const running = manager.runCli('p1', 'a.cli', call())
    await flush()
    host.exit(1)
    await expect(running).rejects.toThrow()
  })
})

describe('ctx.cli.register', () => {
  const spec = (cli: string[]): HostPluginSpec => ({
    id: 'a.cli',
    dir: '/p',
    main: 'host.js',
    projectDir: '/p',
    dataDir: '/p/.data',
    appDataDir: '/p/.app-data',
    storageFile: '/p/.data/storage.json',
    commands: [],
    panels: [],
    cli,
    settings: { project: {}, app: {} }
  })

  it('accepts only declared names, one handler each; the disposer unregisters', async () => {
    const contexts = new HostContexts({ log: () => {} })
    const ctx = contexts.create(spec(['demo']))
    expect(() => ctx.cli.register('other', () => ({}))).toThrow('not declared in plugin.json contributes.cli')
    expect(() => ctx.cli.register('demo', 5 as never)).toThrow('needs a name and a function')
    const off = ctx.cli.register('demo', () => ({ stdout: 'x' }))
    expect(() => ctx.cli.register('demo', () => ({}))).toThrow('already registered')
    expect(await contexts.runCli({ pluginId: 'a.cli', name: 'demo', argv: [], cwd: '/w' })).toEqual({ stdout: 'x', stderr: '', code: 0 })
    off()
    await expect(contexts.runCli({ pluginId: 'a.cli', name: 'demo', argv: [], cwd: '/w' })).rejects.toThrow('has not registered')
    // A spec from before contributes.cli: nothing may be registered.
    const old = new HostContexts({ log: () => {} }).create({ ...spec([]), cli: undefined })
    expect(() => old.cli.register('demo', () => ({}))).toThrow('not declared')
  })

  it('checks main\'s params and normalizes what the handler returns', async () => {
    const contexts = new HostContexts({ log: () => {} })
    const ctx = contexts.create(spec(['demo']))
    ctx.cli.register('demo', (argv) => ({ stdout: argv.join(','), code: 300 }))
    await expect(contexts.runCli({ pluginId: 'a.cli', name: 'demo', argv: 'x', cwd: '/w' })).rejects.toThrow('argv')
    await expect(contexts.runCli({ pluginId: 'a.cli', name: 'demo', argv: [] })).rejects.toThrow('cwd')
    expect(await contexts.runCli({ pluginId: 'a.cli', name: 'demo', argv: ['a', 'b'], cwd: '/w' })).toEqual({ stdout: 'a,b', stderr: '', code: 1 })
  })

  it('cli.cancel aborts the call it names and answers it', async () => {
    const contexts = new HostContexts({ log: () => {} })
    const ctx = contexts.create(spec(['demo']))
    let signal: AbortSignal | undefined
    ctx.cli.register('demo', (_argv, c) => {
      signal = c.signal
      return new Promise(() => {})
    })
    const running = contexts.runCli({ pluginId: 'a.cli', name: 'demo', argv: [], cwd: '/w', callId: 7 })
    await flush()
    contexts.handleEvent('cli.cancel', { callId: 8 })
    expect(signal?.aborted).toBe(false)
    contexts.handleEvent('cli.cancel', { callId: 7 })
    expect(await running).toEqual({ stdout: '', stderr: 'ccc demo: the call was cancelled\n', code: 1 })
    expect(signal?.aborted).toBe(true)
  })

  it('after dispose, register throws', () => {
    const contexts = new HostContexts({ log: () => {} })
    const ctx = contexts.create(spec(['demo']))
    contexts.dispose('a.cli')
    expect(() => ctx.cli.register('demo', () => ({}))).toThrow('deactivated')
  })
})
