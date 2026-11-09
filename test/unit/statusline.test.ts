// `ccc statusline` (cli/statusline.ts): the person's own status line found as Claude Code merges
// its settings, run with the same stdin and printed unchanged; the usage fields forwarded to main
// over the tab's socket; and the hook's invariant, never failing and never hanging, with the app
// down, bad JSON, or a status line command that is missing, slow or failing. Real files, a real
// socket and real child processes in a temp dir; nothing reads the person's own ~/.claude.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  claudeConfigDir,
  findUserStatusLine,
  NESTED_ENV,
  projectDirOf,
  readInput,
  reportUsage,
  runStatusLine,
  runUserCommand,
  STDIN_CAP_BYTES,
  type ReadText
} from '../../src/cli/statusline'
import { parseArgs } from '../../src/cli/args'
import { LineFramer, parseRequest, type Request } from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'

let root: string
let servers: Server[]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccsl-'))
  servers = []
})
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  rmSync(root, { recursive: true, force: true })
})

/** Settings files from a map of path -> text (a missing path reads as no file). */
const files = (map: Record<string, string>): ReadText => (path) => map[path]

const sl = (statusLine: unknown): string => JSON.stringify({ statusLine })

/** A Unix socket server that collects the requests it gets, one per line. */
async function collector(): Promise<{ sock: string; requests: Request[]; next: () => Promise<Request> }> {
  const sock = join(root, 'app.sock')
  const requests: Request[] = []
  const waiters: ((r: Request) => void)[] = []
  const server = createServer((socket) => {
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      for (const line of framer.push(chunk)) {
        const request = parseRequest(line)
        requests.push(request)
        waiters.shift()?.(request)
      }
    })
    socket.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
  return {
    sock,
    requests,
    next: () => (requests.length > 0 ? Promise.resolve(requests[0]!) : new Promise((resolve) => waiters.push(resolve)))
  }
}

const STATUS_JSON = {
  session_id: 's1',
  cwd: '/work/proj',
  transcript_path: '/home/me/.claude/projects/x.jsonl',
  workspace: { current_dir: '/work/proj/sub', project_dir: '/work/proj' },
  cost: { total_cost_usd: 1.25, total_duration_ms: 1000 },
  context_window: { used_percentage: 42, total_input_tokens: 1234 },
  rate_limits: {
    five_hour: { used_percentage: 12.5, resets_at: 1_762_600_000 },
    seven_day: { used_percentage: 61, resets_at: 1_763_000_000 }
  }
}

describe('ccc statusline argument parsing', () => {
  it('is exactly `statusline`: extra words are a hand-typed call and do nothing', () => {
    expect(parseArgs(['statusline'])).toEqual({ kind: 'statusline' })
    expect(parseArgs(['statusline', 'x'])).toEqual({ kind: 'none' })
    expect(parseArgs(['statusline', '--help'])).toEqual({ kind: 'none' })
  })
})

describe('findUserStatusLine (Claude Code settings precedence, ours excluded)', () => {
  const dirs = { projectDir: '/p', configDir: '/home/me/.claude' }
  const user = '/home/me/.claude/settings.json'
  const project = '/p/.claude/settings.json'
  const local = '/p/.claude/settings.local.json'

  it('takes the user settings when the project has none', () => {
    expect(findUserStatusLine(dirs, files({ [user]: sl({ type: 'command', command: 'echo user' }) }))).toBe('echo user')
  })

  it('lets project settings win over user settings, and local over both', () => {
    const all = {
      [user]: sl({ type: 'command', command: 'echo user' }),
      [project]: sl({ type: 'command', command: 'echo project' }),
      [local]: sl({ type: 'command', command: 'echo local' })
    }
    expect(findUserStatusLine(dirs, files(all))).toBe('echo local')
    const noLocal: Record<string, string> = { ...all }
    delete noLocal[local]
    expect(findUserStatusLine(dirs, files(noLocal))).toBe('echo project')
  })

  it('merges the statusLine objects key by key, as Claude deep-merges the layers', () => {
    // A project file that only sets padding keeps the user's command.
    const read = files({ [user]: sl({ type: 'command', command: 'echo user' }), [project]: sl({ padding: 2 }) })
    expect(findUserStatusLine(dirs, read)).toBe('echo user')
  })

  it('skips a file that is missing or not JSON, and a statusLine that is not an object', () => {
    const read = files({ [user]: sl({ type: 'command', command: 'echo user' }), [project]: '{ not json', [local]: sl('echo nope') })
    expect(findUserStatusLine(dirs, read)).toBe('echo user')
  })

  it('has none without type "command" or with a blank command', () => {
    expect(findUserStatusLine(dirs, files({}))).toBeUndefined()
    expect(findUserStatusLine(dirs, files({ [user]: sl({ type: 'static', command: 'echo x' }) }))).toBeUndefined()
    expect(findUserStatusLine(dirs, files({ [user]: sl({ type: 'command', command: '  ' }) }))).toBeUndefined()
    expect(findUserStatusLine(dirs, files({ [user]: sl({ type: 'command', command: 7 }) }))).toBeUndefined()
    expect(findUserStatusLine(dirs, files({ [user]: '{}' }))).toBeUndefined()
  })

  it('reads real files', () => {
    const config = join(root, 'config')
    const proj = join(root, 'proj')
    mkdirSync(config)
    mkdirSync(join(proj, '.claude'), { recursive: true })
    writeFileSync(join(config, 'settings.json'), sl({ type: 'command', command: 'echo user' }))
    writeFileSync(join(proj, '.claude', 'settings.local.json'), sl({ type: 'command', command: 'echo local' }))
    expect(findUserStatusLine({ projectDir: proj, configDir: config })).toBe('echo local')
    expect(findUserStatusLine({ projectDir: join(root, 'elsewhere'), configDir: config })).toBe('echo user')
  })
})

describe('where the settings are', () => {
  it('uses $CLAUDE_CONFIG_DIR for the user settings when set, else ~/.claude', () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/cfg' }, '/home/me')).toBe('/cfg')
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: '' }, '/home/me')).toBe(join('/home/me', '.claude'))
    expect(claudeConfigDir({}, '/home/me')).toBe(join('/home/me', '.claude'))
  })

  it("takes the project folder from the JSON's workspace, then cwd, then our own folder; absolute paths only", () => {
    expect(projectDirOf(STATUS_JSON, '/fallback')).toBe('/work/proj')
    expect(projectDirOf({ workspace: { current_dir: '/cur' }, cwd: '/c' }, '/fallback')).toBe('/cur')
    expect(projectDirOf({ cwd: '/c' }, '/fallback')).toBe('/c')
    expect(projectDirOf({ workspace: { project_dir: 'relative' }, cwd: 3 }, '/fallback')).toBe('/fallback')
    expect(projectDirOf(undefined, '/fallback')).toBe('/fallback')
    expect(projectDirOf('text', '/fallback')).toBe('/fallback')
  })
})

describe('readInput (bounded stdin)', () => {
  it('reads to the end', async () => {
    const r = await readInput(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')]))
    expect(r).toEqual({ data: Buffer.from('{"a":1}'), complete: true })
  })

  it('stops at the cap and says the text is cut', async () => {
    const big = Buffer.alloc(STDIN_CAP_BYTES + 10, 'x')
    const r = await readInput(Readable.from([big]))
    expect(r.complete).toBe(false)
    expect(r.data.length).toBe(STDIN_CAP_BYTES)
  })

  it('gives up at the deadline on a stdin that never closes', async () => {
    const stream = new PassThrough()
    stream.write('{"partial":')
    const started = Date.now()
    const r = await readInput(stream, STDIN_CAP_BYTES, 50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(r).toEqual({ data: Buffer.from('{"partial":'), complete: false })
  })

  it('ends on a stream error with what arrived, never rejecting', async () => {
    const stream = new PassThrough()
    stream.write('ab')
    setTimeout(() => stream.destroy(new Error('EIO')), 5)
    const r = await readInput(stream)
    expect(r.complete).toBe(false)
  })
})

describe.skipIf(!POSIX)('runUserCommand (the person\'s status line)', () => {
  it('passes stdin through and returns stdout byte for byte, stderr dropped', async () => {
    const out = await runUserCommand(`cat; printf '\\033[1m\\377 end'; echo oops >&2`, Buffer.from('{"x":1}\n'), { env: process.env })
    expect(out).toEqual(Buffer.concat([Buffer.from('{"x":1}\n'), Buffer.from([0x1b, 0x5b, 0x31, 0x6d, 0xff]), Buffer.from(' end')]))
  })

  it("runs in the shell with our environment and folder, plus the nested guard", async () => {
    const out = await runUserCommand(`printf '%s|%s|%s' "$CC_TEST_VALUE" "$${NESTED_ENV}" "$PWD"`, Buffer.alloc(0), {
      env: { ...process.env, CC_TEST_VALUE: 'from claude' }
    })
    expect(out?.toString()).toBe(`from claude|1|${process.cwd()}`)
  })

  it('returns nothing for a failing command or a missing program (Claude shows a line only on exit 0)', async () => {
    expect(await runUserCommand('echo partial; exit 3', Buffer.alloc(0), { env: process.env })).toBeUndefined()
    expect(await runUserCommand(join(root, 'no-such-program'), Buffer.alloc(0), { env: process.env })).toBeUndefined()
  })

  it('kills a slow command (and what it started) at the timeout and returns nothing', async () => {
    const started = Date.now()
    const out = await runUserCommand('echo early; sleep 10; echo late', Buffer.alloc(0), { env: process.env, timeoutMs: 200 })
    expect(out).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('does not fail when the command never reads its stdin', async () => {
    const out = await runUserCommand('echo ignored-input', Buffer.alloc(STDIN_CAP_BYTES, 'x'), { env: process.env })
    expect(out?.toString()).toBe('ignored-input\n')
  })

  it('caps the output', async () => {
    const out = await runUserCommand("head -c 100000 /dev/zero | tr '\\0' 'y'", Buffer.alloc(0), { env: process.env, outputCap: 1000 })
    expect(out?.length).toBe(1000)
  })
})

describe('reportUsage (the forward to main)', () => {
  it('sends only the usage fields, with the tab token, as a statusline request', async () => {
    const app = await collector()
    await reportUsage({ APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: app.sock }, STATUS_JSON)
    const request = await app.next()
    expect(request).toMatchObject({ cmd: 'statusline', token: 'tok' })
    expect(request.args).toEqual({
      rate_limits: {
        five_hour: { used_percentage: 12.5, resets_at: 1_762_600_000 },
        seven_day: { used_percentage: 61, resets_at: 1_763_000_000 }
      },
      cost: { total_cost_usd: 1.25 },
      context_window: { used_percentage: 42 }
    })
    // Nothing else of the payload leaves the CLI: no paths, no session id.
    expect(JSON.stringify(request)).not.toContain('/work/proj')
    expect(JSON.stringify(request)).not.toContain('s1')
  })

  it('sends nothing outside a tab, or without the socket main exported, or with no usage fields', async () => {
    const app = await collector()
    await reportUsage({ CC_COCKPIT_SOCK: app.sock }, STATUS_JSON)
    await reportUsage({ APP_TAB_TOKEN: 'tok' }, STATUS_JSON)
    await reportUsage({ APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: app.sock }, { cwd: '/x' })
    await new Promise((r) => setTimeout(r, 50))
    expect(app.requests).toEqual([])
  })

  it('resolves quietly when the app is not running', async () => {
    await expect(reportUsage({ APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: join(root, 'gone.sock') }, STATUS_JSON)).resolves.toBeUndefined()
  })

  it('gives up within its budget on a socket that accepts and never reads', async () => {
    // A listener that never reads: the write may still complete into the kernel buffer, so this
    // only checks the call ends in time, never hanging.
    const sock = join(root, 'hung.sock')
    const held: Socket[] = []
    const server = createServer((s) => void held.push(s))
    await new Promise<void>((resolve) => server.listen(sock, () => resolve()))
    const started = Date.now()
    await reportUsage({ APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: sock }, STATUS_JSON, 100)
    expect(Date.now() - started).toBeLessThan(1000)
    // Never read, so it never sees the end: destroyed by hand, or close() would wait for it.
    for (const s of held) s.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('runStatusLine (end to end, never failing)', () => {
  /** A project folder whose local settings name `command` as the status line. */
  function projectWith(command: string | undefined): string {
    const proj = join(root, 'proj')
    mkdirSync(join(proj, '.claude'), { recursive: true })
    if (command !== undefined) writeFileSync(join(proj, '.claude', 'settings.local.json'), sl({ type: 'command', command }))
    return proj
  }

  async function run(input: string | Readable, env: Record<string, string | undefined>, cwd: string): Promise<string> {
    const out: Buffer[] = []
    await runStatusLine({
      env,
      stdin: typeof input === 'string' ? Readable.from([Buffer.from(input)]) : input,
      write: (data) => out.push(data),
      cwd,
      // No user settings: the person's real ~/.claude is never read.
      home: join(root, 'home'),
      readMs: 200,
      userTimeoutMs: 1000
    })
    return Buffer.concat(out).toString()
  }

  it.skipIf(!POSIX)("forwards the usage and prints the person's own line, from the project the JSON names", async () => {
    const app = await collector()
    const proj = projectWith('printf "line:"; cat')
    const json = JSON.stringify({ ...STATUS_JSON, workspace: { project_dir: proj } })
    const out = await run(json, { APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: app.sock }, '/')
    expect(out).toBe(`line:${json}`)
    expect((await app.next()).cmd).toBe('statusline')
  })

  it.skipIf(!POSIX)('prints the line with the app not running', async () => {
    const proj = projectWith('echo mine')
    expect(await run(JSON.stringify({ cwd: proj }), { APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: join(root, 'gone.sock') }, '/')).toBe('mine\n')
  })

  it('prints nothing when the person has no status line', async () => {
    const proj = projectWith(undefined)
    expect(await run(JSON.stringify({ cwd: proj }), {}, '/')).toBe('')
  })

  it.skipIf(!POSIX)('still runs the line on bad JSON, with the bytes Claude sent, and forwards nothing', async () => {
    const app = await collector()
    const proj = projectWith('cat')
    // Not JSON, so the project folder is our own cwd.
    expect(await run('not json', { APP_TAB_TOKEN: 'tok', CC_COCKPIT_SOCK: app.sock }, proj)).toBe('not json')
    await new Promise((r) => setTimeout(r, 50))
    expect(app.requests).toEqual([])
  })

  it.skipIf(!POSIX)('prints nothing for a failing, missing or slow command, and returns in time', async () => {
    for (const command of ['echo bad; exit 1', join(root, 'missing-cmd'), 'sleep 10']) {
      const proj = projectWith(command)
      const started = Date.now()
      expect(await run(JSON.stringify({ cwd: proj }), {}, '/'), command).toBe('')
      expect(Date.now() - started).toBeLessThan(3000)
    }
  })

  it.skipIf(!POSIX)('runs no command when nested in another ccc statusline (a copied settings file)', async () => {
    const proj = projectWith('echo would-loop')
    expect(await run(JSON.stringify({ cwd: proj }), { [NESTED_ENV]: '1' }, '/')).toBe('')
  })

  it('returns on a stdin that never closes', async () => {
    const proj = projectWith(undefined)
    const stdin = new PassThrough()
    const started = Date.now()
    expect(await run(stdin, {}, proj)).toBe('')
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it.skipIf(!POSIX)('does not throw when writing the output fails (Claude went away)', async () => {
    const proj = projectWith('echo x')
    await expect(
      runStatusLine({
        env: {},
        stdin: Readable.from([Buffer.from(JSON.stringify({ cwd: proj }))]),
        write: () => {
          throw new Error('EPIPE')
        },
        cwd: '/',
        home: join(root, 'home')
      })
    ).resolves.toBeUndefined()
  })
})
