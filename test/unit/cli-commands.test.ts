// The user-facing `ccc` commands (Task 21): argument parsing, the request each one builds, and the
// round trip against a fake app on a real Unix socket in a temp dir (under /tmp: macOS's
// /var/folders is long enough to push a socket path past sun_path).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs, USAGE } from '../../src/cli/args'
import { buildHookRequestLine, buildRequest, run, runCommand, type Output, type UserCommand } from '../../src/cli/client'
import { BUILD_VERSION } from '../../src/shared/app-version'
import {
  encodeReply,
  LineFramer,
  parseRequest,
  PROJECTLESS_COMMANDS,
  TOKENLESS_COMMANDS,
  WINDOW_TOKEN_COMMANDS,
  type Request
} from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'
const TOKEN = 'c'.repeat(64)
const CWD = '/work/dir'

describe('parseArgs: user commands', () => {
  it('open takes one path', () => {
    expect(parseArgs(['open', '~/x'])).toEqual({ kind: 'open', path: '~/x' })
    expect(parseArgs(['open'])).toMatchObject({ kind: 'usage' })
    expect(parseArgs(['open', 'a', 'b'])).toMatchObject({ kind: 'usage' })
    expect(parseArgs(['open', ''])).toMatchObject({ kind: 'usage' })
  })

  it('session note joins the words into one text and accepts -- before text that starts with a dash', () => {
    expect(parseArgs(['session', 'note', 'hi'])).toEqual({ kind: 'note', text: 'hi' })
    expect(parseArgs(['session', 'note', 'fixed', 'the', 'build'])).toEqual({ kind: 'note', text: 'fixed the build' })
    expect(parseArgs(['session', 'note', '--', '-x is wrong'])).toEqual({ kind: 'note', text: '-x is wrong' })
    expect(parseArgs(['session', 'note'])).toMatchObject({ kind: 'usage' })
    expect(parseArgs(['session', 'note', '  '])).toMatchObject({ kind: 'usage' })
  })

  it.each([
    ['3/5', 3, 5],
    ['0/1', 0, 1],
    ['5/5', 5, 5]
  ])('session steps %s', (arg, done, total) => {
    expect(parseArgs(['session', 'steps', arg])).toEqual({ kind: 'steps', done, total })
  })

  it.each([['6/5'], ['0/0'], ['3'], ['3/'], ['/5'], ['-1/5'], ['1.5/3'], ['a/b'], ['3/5/7'], ['123456789/123456789']])(
    'session steps rejects %s',
    (arg) => {
      expect(parseArgs(['session', 'steps', arg])).toMatchObject({ kind: 'usage' })
    }
  )

  it('session needs a known subcommand, and steps exactly one argument', () => {
    expect(parseArgs(['session'])).toMatchObject({ kind: 'usage', message: expect.stringMatching(/note or steps/) })
    expect(parseArgs(['session', 'frob'])).toMatchObject({ kind: 'usage', message: expect.stringMatching(/frob/) })
    expect(parseArgs(['session', 'steps'])).toMatchObject({ kind: 'usage' })
    expect(parseArgs(['session', 'steps', '1/2', '3/4'])).toMatchObject({ kind: 'usage' })
  })

  it('overlay --terminal takes the program verbatim after --', () => {
    expect(parseArgs(['overlay', '--terminal', '--', 'git', 'log', '--oneline', '-n', '5'])).toEqual({
      kind: 'overlay',
      target: { mode: 'terminal', argv: ['git', 'log', '--oneline', '-n', '5'] }
    })
    expect(parseArgs(['overlay', '--project', '/p', '--terminal', '--', 'true'])).toEqual({
      kind: 'overlay',
      project: '/p',
      target: { mode: 'terminal', argv: ['true'] }
    })
    // Options may also come first.
    expect(parseArgs(['overlay', '--terminal', '--project', 'rel', '--', 'a'])).toMatchObject({ project: 'rel' })
  })

  it('overlay --url and --html', () => {
    expect(parseArgs(['overlay', '--url', 'https://example.com/x'])).toEqual({
      kind: 'overlay',
      target: { mode: 'url', url: 'https://example.com/x' }
    })
    expect(parseArgs(['overlay', '--html', 'page.html', '--project', '/p'])).toEqual({
      kind: 'overlay',
      project: '/p',
      target: { mode: 'html', file: 'page.html' }
    })
  })

  it.each([
    [['overlay']],
    [['overlay', '--terminal']], // no program
    [['overlay', '--terminal', '--']],
    [['overlay', '--terminal', 'true']], // the program must follow --
    [['overlay', '--url']],
    [['overlay', '--html']],
    [['overlay', '--project']],
    [['overlay', '--url', 'https://a', '--html', 'f']], // two modes
    [['overlay', '--url', 'https://a', '--terminal', '--', 'x']],
    [['overlay', '--url', 'https://a', '--', 'x']], // a tail only --terminal takes
    [['overlay', '--bogus']]
  ])('overlay rejects %j', (argv) => {
    expect(parseArgs(argv)).toMatchObject({ kind: 'usage' })
  })

  it('sessions takes only --json; notify takes text', () => {
    expect(parseArgs(['sessions'])).toEqual({ kind: 'sessions', json: false })
    expect(parseArgs(['sessions', '--json'])).toEqual({ kind: 'sessions', json: true })
    expect(parseArgs(['sessions', '--yaml'])).toMatchObject({ kind: 'usage' })
    expect(parseArgs(['notify', 'build', 'done'])).toEqual({ kind: 'notify', text: 'build done' })
    expect(parseArgs(['notify'])).toMatchObject({ kind: 'usage' })
  })

  it('an unknown command, or none, gets a message naming it; help is not an error', () => {
    // A word with the plugin command shape is a plugin command (main says whether one exists);
    // anything else, and a reserved name, is a usage error here.
    expect(parseArgs(['Frob_nicate'])).toEqual({ kind: 'usage', message: 'unknown command: Frob_nicate' })
    expect(parseArgs(['version'])).toEqual({ kind: 'usage', message: 'unknown command: version' })
    expect(parseArgs([])).toEqual({ kind: 'usage', message: 'missing command' })
    for (const h of ['--help', '-h', 'help']) expect(parseArgs([h])).toEqual({ kind: 'help' })
  })
})

describe('buildRequest', () => {
  const inTab = { APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: '/s' }

  it('in a tab, the token identifies the caller and no project is sent', () => {
    const req = buildRequest({ kind: 'note', text: 'hi' }, inTab, CWD) as Request
    expect(req).toMatchObject({ v: 1, cmd: 'session.note', token: TOKEN, args: { text: 'hi' } })
    expect(req.project).toBeUndefined()
    expect(buildRequest({ kind: 'steps', done: 3, total: 5 }, inTab, CWD)).toMatchObject({
      cmd: 'session.steps',
      args: { done: 3, total: 5 }
    })
    // An overlay in a tab needs no --project; one given is ignored (the token picks the window).
    const overlay = buildRequest(
      { kind: 'overlay', project: '/elsewhere', target: { mode: 'url', url: 'https://a/' } },
      inTab,
      CWD
    ) as Request
    expect(overlay).toMatchObject({ cmd: 'overlay', token: TOKEN, args: { url: 'https://a/' } })
    expect(overlay.project).toBeUndefined()
  })

  it('outside a tab, overlay names its project (made absolute against the CLI cwd)', () => {
    const req = buildRequest(
      { kind: 'overlay', project: 'proj', target: { mode: 'terminal', argv: ['less', 'f'] } },
      {},
      CWD
    ) as Request
    expect(req).toMatchObject({ cmd: 'overlay', project: '/work/dir/proj', args: { terminal: ['less', 'f'], cwd: CWD } })
    expect(req.token).toBeUndefined()
    expect(
      buildRequest({ kind: 'overlay', target: { mode: 'url', url: 'https://a/' } }, {}, CWD)
    ).toEqual({ error: expect.stringMatching(/--project/) })
  })

  it('--html is sent as an absolute path (the file itself is read by main)', () => {
    expect(
      buildRequest({ kind: 'overlay', project: '/p', target: { mode: 'html', file: '../x/page.html' } }, {}, CWD)
    ).toMatchObject({ args: { html: '/work/x/page.html' } })
    expect(
      buildRequest({ kind: 'overlay', project: '/p', target: { mode: 'html', file: '/abs/p.html' } }, {}, CWD)
    ).toMatchObject({ args: { html: '/abs/p.html' } })
  })

  it('open names the folder as the project for a tokenless call, and in args for both', () => {
    expect(buildRequest({ kind: 'open', path: 'repo' }, {}, CWD)).toMatchObject({
      cmd: 'open',
      project: '/work/dir/repo',
      args: { path: '/work/dir/repo' }
    })
    const inside = buildRequest({ kind: 'open', path: '/r' }, inTab, CWD) as Request
    expect(inside).toMatchObject({ token: TOKEN, args: { path: '/r' } })
    expect(inside.project).toBeUndefined()
  })

  it('sessions and notify name no project', () => {
    const s = buildRequest({ kind: 'sessions', json: true }, {}, CWD) as Request
    expect(s).toMatchObject({ cmd: 'sessions', args: {} })
    expect(s.project).toBeUndefined()
    expect(buildRequest({ kind: 'notify', text: 'x' }, {}, CWD)).toMatchObject({ cmd: 'notify', args: { text: 'x' } })
  })

  it('keeps hostile text as one JSON value', () => {
    const text = '"; rm -rf / #\n$(x) `y`'
    expect(buildRequest({ kind: 'note', text }, inTab, CWD)).toMatchObject({ args: { text } })
  })
})

describe('runCommand against a fake app', () => {
  let root: string
  let sock: string
  let servers: Server[]
  let out: string
  let err: string
  const io: Output = {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t)
  }

  beforeEach(() => {
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccm-'))
    sock = join(root, 's.sock')
    servers = []
    out = ''
    err = ''
  })
  afterEach(() => {
    for (const s of servers) s.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** A listening fake app; `answer` returns the reply for a request, or undefined to close without one. */
  type Answer = { ok: true; result: unknown } | { ok: false; error: string }
  function fakeApp(answer: (r: Request) => Answer | undefined): { seen: Request[] } {
    const seen: Request[] = []
    const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) {
          const request = parseRequest(line)
          seen.push(request)
          const reply = answer(request)
          if (reply === undefined) socket.destroy()
          else socket.write(encodeReply({ id: request.id, ...reply }))
        }
      })
      socket.on('error', () => {})
    })
    servers.push(server)
    server.listen(sock)
    return { seen }
  }
  const listening = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (servers.every((s) => s.listening)) return
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('fake app never listened')
  }
  const tab = (): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock })
  /** A plausible `plugin.config` answer: the view without `set`, the set result with it. */
  const configResult = (r: Request): unknown =>
    r.args.set === undefined
      ? { id: 'acme.x', app: { fields: ['limit'], values: { limit: 1 }, secrets: {} } }
      : { id: 'acme.x', scope: 'app', values: { limit: 5 } }

  it('prints the overlay result as JSON on stdout and exits 0', async () => {
    const app = fakeApp(() => ({ ok: true, result: { kind: 'exit', code: 0 } }))
    await listening()
    const cmd: UserCommand = { kind: 'overlay', target: { mode: 'terminal', argv: ['true'] } }
    expect(await runCommand(cmd, tab(), CWD, io)).toBe(0)
    expect(out).toBe('{"kind":"exit","code":0}\n')
    expect(err).toBe('')
    expect(app.seen[0]).toMatchObject({ cmd: 'overlay', token: TOKEN, args: { terminal: ['true'], cwd: CWD } })
  })

  it('waits for a slow answer (an overlay stays open for as long as the user takes)', async () => {
    const server = createServer((socket) => {
      socket.on('data', () => {
        setTimeout(() => socket.write(encodeReply({ id: 1, ok: true, result: { kind: 'dismissed' } })), 300)
      })
      socket.on('error', () => {})
    })
    servers.push(server)
    server.listen(sock)
    await listening()
    const cmd: UserCommand = { kind: 'overlay', target: { mode: 'url', url: 'https://a/' } }
    expect(await runCommand(cmd, tab(), CWD, io)).toBe(0)
    expect(out).toBe('{"kind":"dismissed"}\n')
  })

  it('sessions prints JSON with --json, tab-separated lines without', async () => {
    const list = [{ tabId: 't1', project: 'p', status: 'working', tool: 'Bash' }]
    fakeApp(() => ({ ok: true, result: list }))
    await listening()
    expect(await runCommand({ kind: 'sessions', json: true }, tab(), CWD, io)).toBe(0)
    expect(JSON.parse(out)).toEqual(list)
    out = ''
    expect(await runCommand({ kind: 'sessions', json: false }, tab(), CWD, io)).toBe(0)
    expect(out).toBe('p\tworking\tBash\tt1\n')
  })

  it('note, steps, notify, open print nothing on success', async () => {
    fakeApp(() => ({ ok: true, result: null }))
    await listening()
    for (const cmd of [
      { kind: 'note', text: 'hi' },
      { kind: 'steps', done: 1, total: 2 },
      { kind: 'notify', text: 'x' },
      { kind: 'open', path: '/r' }
    ] as UserCommand[]) {
      expect(await runCommand(cmd, tab(), CWD, io)).toBe(0)
    }
    expect({ out, err }).toEqual({ out: '', err: '' })
  })

  it('an error reply goes to stderr with exit code 1', async () => {
    fakeApp(() => ({ ok: false, error: 'that project is not open' }))
    await listening()
    expect(await runCommand({ kind: 'note', text: 'x' }, tab(), CWD, io)).toBe(1)
    expect(err).toBe('ccc: that project is not open\n')
    expect(out).toBe('')
  })

  // Review finding (ext round 9): an error can quote a file or front-matter name from a folder
  // nobody allowed yet (`ccc plugin link`); its escape sequences must not reach the terminal.
  it('an error reply has its control characters turned into spaces, line breaks kept', async () => {
    fakeApp(() => ({ ok: false, error: 'skill "x": front matter name "\u001b]0;pwned\u0007\u001b[2J"\nsecond\tline\r' }))
    await listening()
    expect(await runCommand({ kind: 'note', text: 'x' }, tab(), CWD, io)).toBe(1)
    expect(err).toBe('ccc: skill "x": front matter name " ]0;pwned  [2J"\nsecond\tline \n')
  })

  it('exits 0 and prints nothing when the app is not running', async () => {
    // Nobody listens on `sock`.
    const cmds: UserCommand[] = [
      { kind: 'note', text: 'hi' },
      { kind: 'sessions', json: true },
      { kind: 'notify', text: 'x' },
      { kind: 'overlay', target: { mode: 'terminal', argv: ['true'] } },
      { kind: 'open', path: '/r' }
    ]
    for (const cmd of cmds) expect(await runCommand(cmd, tab(), CWD, io)).toBe(0)
    expect({ out, err }).toEqual({ out: '', err: '' })
  })

  it('exits 1 with a message when the app drops the connection without answering', async () => {
    // Not "the app is not there" (that is the silent 0 above): it was there and said nothing, which
    // is also what an oversized request or reply looks like.
    fakeApp(() => undefined)
    await listening()
    expect(await runCommand({ kind: 'overlay', target: { mode: 'url', url: 'https://a/' } }, tab(), CWD, io)).toBe(1)
    expect(out).toBe('')
    expect(err).toMatch(/without a reply/)
  })

  it('inside a tab without CC_COCKPIT_SOCK it exits 0 without connecting', async () => {
    const app = fakeApp(() => ({ ok: true, result: null }))
    await listening()
    expect(await runCommand({ kind: 'note', text: 'hi' }, { APP_TAB_TOKEN: TOKEN }, CWD, io)).toBe(0)
    expect(app.seen).toEqual([])
    expect({ out, err }).toEqual({ out: '', err: '' })
  })

  // Review finding: `plugin link|unlink|list --project` were documented but main refused them
  // ("needs a tab token") before their handlers, because their commands were not in
  // TOKENLESS_COMMANDS. So: every documented `--project` form, run outside a tab, and every request
  // it sends must be one main lets in without a token (with a project, unless projectless).
  it('every request a documented --project form sends outside a tab is one main accepts without a token', async () => {
    const forms = new Set([...USAGE.matchAll(/ccc ((?:[a-z]+ )*)\[--project <path>\]/g)].map((m) => (m[1] as string).trim()))
    const runs: Record<string, string[][]> = {
      overlay: [['overlay', '--project', '/p', '--url', 'https://a/']],
      'plugin link': [['plugin', 'link', '--project', '/p', '/dev/plugin']],
      'plugin unlink': [['plugin', 'unlink', '--project', '/p', 'acme.x']],
      'plugin list': [['plugin', 'list', '--project', '/p'], ['plugin', 'list', '--project', '/p', '--json']],
      'plugin config': [
        ['plugin', 'config', '--project', '/p', 'acme.x'],
        ['plugin', 'config', '--project', '/p', 'acme.x', '--json'],
        ['plugin', 'config', '--project', '/p', 'acme.x', '--scope', 'app', 'limit=5']
      ],
      'panel show': [['panel', 'show', '--project', '/p', 'acme.x/list']],
      // A plugin command: the spec lookup, then the call.
      '': [['--project', '/p', 'demo', 'x']]
    }
    // A new documented form must be added above.
    expect([...forms].sort()).toEqual(Object.keys(runs).sort())
    const app = fakeApp((r) => ({ ok: true, result: r.cmd === 'plugin.cli' ? { stdout: '', stderr: '', code: 0 } : r.cmd === 'plugin.link' ? { id: 'acme.x', name: 'X' } : r.cmd === 'plugin.list' ? [] : r.cmd === 'plugin.config' ? configResult(r) : {} }))
    await listening()
    // The tokenless commands with no --project form: open (its path is the project), notify, sessions.
    const argvs = [...Object.values(runs).flat(), ['open', '/p'], ['notify', 'hi'], ['sessions']]
    for (const argv of argvs) {
      expect(await run(argv, { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD), argv.join(' ')).toBe(0)
    }
    expect(err).toBe('')
    const sent = new Set(app.seen.map((r) => r.cmd))
    for (const cmd of ['overlay', 'plugin.link', 'plugin.unlink', 'plugin.list', 'plugin.config', 'panel.show', 'plugin.cli.spec', 'plugin.cli', 'open', 'notify', 'sessions']) {
      expect(sent.has(cmd), cmd).toBe(true)
    }
    for (const r of app.seen) {
      expect(r.token, r.cmd).toBeUndefined()
      expect(TOKENLESS_COMMANDS, r.cmd).toContain(r.cmd)
      if (!PROJECTLESS_COMMANDS.includes(r.cmd)) expect(r.project, r.cmd).toBe('/p')
    }
  })

  // A shell or command tab now has a token too, a window token (main decides the kind; the CLI
  // cannot tell and sends it the same way). Every window-level form run there WITHOUT --project
  // must send the token, and only requests main lets a window token make.
  it('in a tab, every window-level form goes out with the token and no project, and main lets a window token make each', async () => {
    const app = fakeApp((r) => ({ ok: true, result: r.cmd === 'plugin.cli' ? { stdout: '', stderr: '', code: 0 } : r.cmd === 'plugin.link' ? { id: 'acme.x', name: 'X' } : r.cmd === 'plugin.list' || r.cmd === 'plugin.cli.list' ? [] : r.cmd === 'plugin.config' ? configResult(r) : {} }))
    await listening()
    const argvs = [
      ['overlay', '--url', 'https://a/'],
      ['plugin', 'link', '/dev/plugin'],
      ['plugin', 'unlink', 'acme.x'],
      ['plugin', 'list'],
      ['plugin', 'config', 'acme.x'],
      ['plugin', 'config', 'acme.x', 'limit=5'],
      ['panel', 'show', 'acme.x/list'],
      ['demo', 'x'],
      ['help'],
      ['open', '/p'],
      ['notify', 'hi'],
      ['sessions']
    ]
    for (const argv of argvs) {
      expect(await run(argv, tab(), Readable.from([]), io, CWD), argv.join(' ')).toBe(0)
    }
    expect(err).toBe('')
    const sent = new Set(app.seen.map((r) => r.cmd))
    for (const cmd of ['overlay', 'plugin.link', 'plugin.unlink', 'plugin.list', 'plugin.config', 'panel.show', 'plugin.cli.spec', 'plugin.cli', 'plugin.cli.list', 'open', 'notify', 'sessions']) {
      expect(sent.has(cmd), cmd).toBe(true)
    }
    for (const r of app.seen) {
      expect(r.token, r.cmd).toBe(TOKEN)
      expect(r.project, r.cmd).toBeUndefined()
      expect(WINDOW_TOKEN_COMMANDS, r.cmd).toContain(r.cmd)
    }
    // The session-only ones are not window commands: main refuses them for a shell tab's token.
    for (const cmd of ['hook', 'session.note', 'session.steps']) expect(WINDOW_TOKEN_COMMANDS).not.toContain(cmd)
  })

  it('an overlay outside a tab without --project is a usage error (2), before any connection', async () => {
    const app = fakeApp(() => ({ ok: true, result: null }))
    await listening()
    const cmd: UserCommand = { kind: 'overlay', target: { mode: 'url', url: 'https://a/' } }
    expect(await runCommand(cmd, { CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(2)
    expect(err).toMatch(/--project/)
    expect(app.seen).toEqual([])
  })
})

describe('run(): exit codes and messages', () => {
  const out = (): { o: string; e: string; io: Output } => {
    const r = { o: '', e: '', io: { stdout: (t: string) => void (r.o += t), stderr: (t: string) => void (r.e += t) } }
    return r
  }
  const nothing = Readable.from([])

  it('an unknown command prints its name and the usage on stderr, exit 2', async () => {
    const o = out()
    expect(await run(['Frob_nicate'], {}, nothing, o.io, CWD)).toBe(2)
    expect(o.e).toContain('unknown command: Frob_nicate')
    expect(o.e).toContain(USAGE)
    expect(o.o).toBe('')
  })

  it('help prints the usage on stdout, exit 0', async () => {
    const o = out()
    expect(await run(['--help'], {}, nothing, o.io, CWD)).toBe(0)
    expect(o.o).toBe(`${USAGE}\n`)
  })

  it('a hook line it cannot read is a silent 0', async () => {
    const o = out()
    expect(await run(['hook', 'Bogus'], {}, nothing, o.io, CWD)).toBe(0)
    expect({ o: o.o, e: o.e }).toEqual({ o: '', e: '' })
  })

  // Review finding: run() turned every thrown error into a silent 0, so a script read a failed
  // command as success. Only a hook (and "the app is not running") is 0 whatever happens.
  it('a user command that throws prints the message and exits 1; a hook that throws is still 0', async () => {
    let e = ''
    const throwing = {
      stdout: (): void => {
        throw new Error('stdout is gone')
      },
      stderr: (t: string): void => void (e += t)
    }
    expect(await run(['--help'], {}, nothing, throwing, CWD)).toBe(1)
    expect(e).toBe('ccc: stdout is gone\n')
    e = ''
    expect(await run(['guide'], {}, nothing, throwing, CWD)).toBe(1)
    expect(e).toBe('ccc: stdout is gone\n')
    // stderr throwing too: still exit 1, nothing escapes.
    const both = { stdout: throwing.stdout, stderr: throwing.stdout }
    expect(await run(['--help'], {}, nothing, both, CWD)).toBe(1)
    e = ''
    expect(await run(['hook', 'SessionStart'], {}, nothing, throwing, CWD)).toBe(0)
    expect(e).toBe('')
  })
})

describe('version check against a fake app', () => {
  const OTHER = '99.1.2'
  const warning = `ccc: the app is running version ${OTHER}, this ccc is version ${BUILD_VERSION}. Restart cc-cockpit.\n`
  let root: string
  let sock: string
  let server: Server | undefined
  let out: string
  let err: string
  let seen: string[]
  const io: Output = {
    stdout: (t) => void (out += t),
    stderr: (t) => void (err += t)
  }
  const tab = (): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock })
  const nothing = (): Readable => Readable.from([])

  beforeEach(() => {
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccv-'))
    sock = join(root, 's.sock')
    out = ''
    err = ''
    seen = []
  })
  afterEach(() => {
    server?.close()
    rmSync(root, { recursive: true, force: true })
  })

  /** Answers every request with `fields` plus its id, on purpose not going through encodeReply: `fields` may be hostile. */
  function app(fields: (r: Request) => Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
        const framer = new LineFramer()
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            seen.push(line)
            const request = parseRequest(line)
            socket.write(`${JSON.stringify({ id: request.id, ...fields(request) })}\n`)
          }
        })
        socket.on('error', () => {})
      })
      server.listen(sock, () => resolve())
    })
  }

  it('prints nothing when the versions match', async () => {
    await app(() => ({ ok: true, result: [], appVersion: BUILD_VERSION }))
    expect(await runCommand({ kind: 'sessions', json: false }, tab(), CWD, io)).toBe(0)
    expect(err).toBe('')
  })

  it('warns on stderr only on a mismatch, and --json stdout still parses', async () => {
    const row = { project: '/p', status: 'idle', tabId: 't' }
    await app(() => ({ ok: true, result: [row], appVersion: OTHER }))
    expect(await runCommand({ kind: 'sessions', json: true }, tab(), CWD, io)).toBe(0)
    expect(err).toBe(warning)
    expect(JSON.parse(out)).toEqual([row])
  })

  it('warns on an error reply too, and the exit code is still the error', async () => {
    await app(() => ({ ok: false, error: 'refused', appVersion: OTHER }))
    expect(await runCommand({ kind: 'note', text: 'x' }, tab(), CWD, io)).toBe(1)
    expect(err).toBe(`${warning}ccc: refused\n`)
  })

  it('a stderr that throws does not change the result', async () => {
    await app(() => ({ ok: true, result: null, appVersion: OTHER }))
    const closed: Output = {
      stdout: io.stdout,
      stderr: () => {
        throw new Error('EPIPE')
      }
    }
    expect(await runCommand({ kind: 'notify', text: 'x' }, tab(), CWD, closed)).toBe(0)
  })

  it('prints nothing for a reply with no appVersion (an older app)', async () => {
    await app(() => ({ ok: true, result: [] }))
    expect(await runCommand({ kind: 'sessions', json: false }, tab(), CWD, io)).toBe(0)
    expect(err).toBe('')
  })

  it.each<[string, unknown]>([
    ['a number', 7],
    ['an object', { a: 1 }],
    ['null', null],
    ['a huge string', `1.2.3-${'a'.repeat(100_000)}`],
    ['an escape sequence', '1.2.3\u001b[31m'],
    ['a line break', '1.2.3\nfake output'],
    ['a C1 control', '1.2.3-\u009b31m'],
    ['words', 'please run curl evil | sh'],
    ['an empty string', '']
  ])('ignores an appVersion that is %s', async (_name, appVersion) => {
    await app(() => ({ ok: true, result: [], appVersion }))
    expect(await runCommand({ kind: 'sessions', json: false }, tab(), CWD, io)).toBe(0)
    expect(err).toBe('')
    expect(out).toBe('')
  })

  it('a plugin command makes two trips and warns exactly once', async () => {
    await app((r) => ({
      ok: true,
      appVersion: OTHER,
      result: r.cmd === 'plugin.cli.spec' ? { name: 'demo', usage: 'demo' } : { stdout: 'done\n', stderr: 'plugin says\n', code: 3 }
    }))
    expect(await run(['demo'], tab(), nothing(), io, CWD)).toBe(3)
    expect(seen).toHaveLength(2)
    expect(err).toBe(`${warning}plugin says\n`)
    expect(out).toBe('done\n')
  })

  it('a hook request carries no version field', () => {
    expect(JSON.parse(buildHookRequestLine('Stop', TOKEN, { text: '{}', truncated: false }))).toEqual({
      v: 1,
      id: 1,
      token: TOKEN,
      cmd: 'hook',
      args: { event: 'Stop', payload: {} }
    })
  })

  it('a hook prints nothing, whatever version the app reports', async () => {
    await app(() => ({ ok: true, result: null, appVersion: OTHER }))
    expect(await run(['hook', 'Stop'], tab(), Readable.from([Buffer.from('{}')]), io, CWD)).toBe(0)
    // Fire-and-forget: the line reaches the fake app after run() has resolved.
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).not.toContain('ersion')
    expect(out).toBe('')
    expect(err).toBe('')
  })
})
