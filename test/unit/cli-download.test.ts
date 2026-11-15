// `ccc download <path>` (design-download.md §1.1, §2.2): the parse, the request (the path made absolute
// against the CLI's cwd, only from a tab), the answer printed at once, the socket handler's caller and
// window rules, the server refusing a tokenless caller, a plugin's `download` command demoted (the name
// is reserved now), and the guide and skill texts (drift).
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, Socket, type Server } from 'node:net'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs, usageFor } from '../../src/cli/args'
import { buildRequest, DOWNLOAD_REPLY_TIMEOUT_MS, REPLY_TIMEOUT_MS, runCommand, type Output } from '../../src/cli/client'
import { GUIDE_TOPICS } from '../../src/cli/guide'
import { CORE_SKILL_TEXT } from '../../src/main/claude-plugins/claude-plugins'
import { validateManifest } from '../../src/main/plugins/validate'
import { DOWNLOAD_TAB_ONLY_TEXT, downloadHandler } from '../../src/main/socket/handlers'
import { SocketServer, type Caller } from '../../src/main/socket/socket-server'
import { CLI_CLIENT_DEADLINE_MS } from '../../src/shared/plugin-cli'
import { CORE_CLI_COMMANDS, RESERVED_CLI_NAMES } from '../../src/shared/manifest'
import { encodeReply, encodeRequest, LineFramer, parseReply, parseRequest, TOKENLESS_COMMANDS, WINDOW_TOKEN_COMMANDS, type Reply, type Request } from '../../src/shared/protocol'

const POSIX = process.platform !== 'win32'
const TOKEN = 'c'.repeat(64)
const CWD = '/work/dir'

describe('parse and request', () => {
  it('takes exactly one path; no include flag', () => {
    expect(parseArgs(['download', 'out/report.pdf'])).toEqual({ kind: 'download', path: 'out/report.pdf' })
    expect(parseArgs(['download']).kind).toBe('usage')
    expect(parseArgs(['download', ''])).toEqual({ kind: 'usage', message: 'download takes one path' })
    expect(parseArgs(['download', 'a', '--all']).kind).toBe('usage')
    expect(parseArgs(['download', '--help'])).toEqual({ kind: 'help', command: 'download' })
    expect(usageFor('download')).toMatch(/^ {2}ccc download <path>/)
  })

  it('in a tab: the path made absolute against the cwd, the token, no project', () => {
    expect(buildRequest({ kind: 'download', path: 'out/report.pdf' }, { APP_TAB_TOKEN: TOKEN }, CWD)).toEqual({
      v: 1,
      id: 1,
      cmd: 'download',
      args: { path: '/work/dir/out/report.pdf' },
      token: TOKEN
    })
    expect(buildRequest({ kind: 'download', path: '/tmp/x' }, { APP_TAB_TOKEN: TOKEN }, CWD)).toMatchObject({ args: { path: '/tmp/x' } })
  })

  it('tokenless is refused before any connection, "run it in a tab of the project"', () => {
    expect(buildRequest({ kind: 'download', path: 'x' }, {}, CWD)).toEqual({ error: 'download: run it in a tab of the project' })
  })

  it('is a core command a tab token reaches, never a tokenless one', () => {
    expect(CORE_CLI_COMMANDS).toContain('download')
    expect(RESERVED_CLI_NAMES).toContain('download')
    expect(WINDOW_TOKEN_COMMANDS).toContain('download')
    expect(TOKENLESS_COMMANDS).not.toContain('download')
  })

  it('waits longer than the plain reply (a folder count is up to 10 s) but is bounded', () => {
    expect(DOWNLOAD_REPLY_TIMEOUT_MS).toBeGreaterThan(REPLY_TIMEOUT_MS)
    expect(DOWNLOAD_REPLY_TIMEOUT_MS).toBeLessThanOrEqual(CLI_CLIENT_DEADLINE_MS)
  })
})

describe('the round trip', () => {
  let root: string
  let sock: string
  let server: Server | undefined
  let out: string
  let err: string
  const io: Output = { stdout: (t) => void (out += t), stderr: (t) => void (err += t) }

  beforeEach(() => {
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccd-'))
    sock = join(root, 's.sock')
    out = ''
    err = ''
  })
  afterEach(() => {
    server?.close()
    rmSync(root, { recursive: true, force: true })
  })

  async function app(answer: (r: Request) => Reply): Promise<Request[]> {
    const seen: Request[] = []
    server = createServer((socket: Socket) => {
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) {
          const r = parseRequest(line)
          seen.push(r)
          socket.end(encodeReply(answer(r)))
        }
      })
    })
    await new Promise<void>((resolve) => server!.listen(sock, resolve))
    return seen
  }

  it('prints main\'s line (control characters made spaces) and exits 0', async () => {
    const seen = await app((r) => ({ id: r.id, ok: true, result: { text: 'offered report.pdf (2.3 MB) to the browser views of this project; the person decides\u001b[2J' } }))
    expect(await runCommand({ kind: 'download', path: 'report.pdf' }, { APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(0)
    expect(out).toBe('offered report.pdf (2.3 MB) to the browser views of this project; the person decides [2J\n')
    expect(seen.map((r) => [r.cmd, r.args.path])).toEqual([['download', '/work/dir/report.pdf']])
  })

  it('a refusal is exit 1 with the reason', async () => {
    await app((r) => ({ id: r.id, ok: false, error: 'this project is on this computer: /p/report.pdf' }))
    expect(await runCommand({ kind: 'download', path: 'report.pdf' }, { APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(1)
    expect(err).toBe('ccc: this project is on this computer: /p/report.pdf\n')
  })

  it('tokenless is a usage error (2) that never connects', async () => {
    const seen = await app((r) => ({ id: r.id, ok: true, result: { text: 'no' } }))
    expect(await runCommand({ kind: 'download', path: 'x' }, { CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(2)
    expect(err).toBe('ccc: download: run it in a tab of the project\n')
    expect(seen).toEqual([])
  })
})

describe('the socket handler', () => {
  const offers: Array<{ caller: { projectId: string; windowId: number }; abs: string }> = []
  const handler = downloadHandler({
    windowIdOf: (projectId) => (projectId === 'p1' ? 7 : undefined),
    offer: async (caller, abs) => {
      offers.push({ caller, abs })
      return { text: `offered ${abs}` }
    }
  })
  const signal = new AbortController().signal
  const call = (args: Record<string, unknown>, caller: Caller): Promise<unknown> => Promise.resolve(handler(args, caller, signal))

  beforeEach(() => void offers.splice(0))

  it('a Claude tab and a shell tab offer to their project\'s open window; the window is main\'s, never the args\'', async () => {
    await expect(call({ path: '/p/a.txt', windowId: 99, projectId: 'other' }, { kind: 'session', tabId: 't1', projectId: 'p1' })).resolves.toEqual({ text: 'offered /p/a.txt' })
    await expect(call({ path: '/p/b.txt' }, { kind: 'window', projectId: 'p1' })).resolves.toEqual({ text: 'offered /p/b.txt' })
    expect(offers).toEqual([
      { caller: { projectId: 'p1', windowId: 7 }, abs: '/p/a.txt' },
      { caller: { projectId: 'p1', windowId: 7 }, abs: '/p/b.txt' }
    ])
  })

  it('refuses a tokenless caller, a relative or junk path, and a project with no open window', async () => {
    await expect(call({ path: '/p/a' }, { kind: 'project', path: '/p', projectId: 'p1' })).rejects.toThrow(DOWNLOAD_TAB_ONLY_TEXT)
    await expect(call({ path: '/p/a' }, { kind: 'anonymous' })).rejects.toThrow(DOWNLOAD_TAB_ONLY_TEXT)
    await expect(call({ path: 'a.txt' }, { kind: 'window', projectId: 'p1' })).rejects.toThrow('download needs an absolute path')
    await expect(call({ path: 42 }, { kind: 'window', projectId: 'p1' })).rejects.toThrow('download needs an absolute path')
    await expect(call({ path: '/p/a\0b' }, { kind: 'window', projectId: 'p1' })).rejects.toThrow('download needs an absolute path')
    await expect(call({ path: '/p/a' }, { kind: 'window', projectId: 'p2' })).rejects.toThrow(/not open/)
    expect(offers).toEqual([])
  })
})

describe('the socket server', () => {
  let root: string
  let s: SocketServer | undefined
  beforeEach(() => {
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccds-'))
  })
  afterEach(async () => {
    await s?.stop()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a tokenless `download` (even with --project) before its handler; a window token reaches it', async () => {
    const sock = join(root, 's.sock')
    s = new SocketServer({
      path: sock,
      resolveToken: (token) => (token === TOKEN ? { kind: 'window', projectId: 'p1' } : undefined),
      resolveProject: (path) => ({ path, projectId: 'p1' }),
      log: () => {}
    })
    const reached: Caller[] = []
    s.handle('download', (_args, caller) => {
      reached.push(caller)
      return { text: 'ok' }
    })
    expect(await s.start()).toBe(true)
    const ask = (req: Partial<Request>): Promise<Reply> =>
      new Promise((resolve, reject) => {
        const framer = new LineFramer()
        const socket = new Socket()
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            socket.destroy()
            resolve(parseReply(line))
          }
        })
        socket.on('error', reject)
        socket.connect(sock, () => socket.write(encodeRequest({ v: 1, id: 1, cmd: 'download', args: { path: '/p/a' }, ...req })))
      })
    expect(await ask({ project: '/p' })).toMatchObject({ ok: false, error: expect.stringMatching(/needs a tab token/) })
    expect(reached).toEqual([])
    expect(await ask({ token: TOKEN })).toMatchObject({ ok: true, result: { text: 'ok' } })
    expect(reached).toEqual([{ kind: 'window', projectId: 'p1' }])
  })
})

describe('a plugin command named download', () => {
  it('is refused as reserved, so the installer disables (demotes) a plugin that declares it', async () => {
    const dir = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccdp-'))
    try {
      const r = await validateManifest(
        { id: 'acme.dl', name: 'Dl', version: '1.0.0', api: 1, contributes: { cli: [{ name: 'download', summary: 'mine' }] } },
        dir
      )
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors).toContain('cli command "download" is reserved for the app')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('guide drift', () => {
  const cli = GUIDE_TOPICS.find((t) => t.name === 'cli')?.text ?? ''

  it('the cli topic documents the command, its answers, the tab-only rule and the limits', () => {
    for (const text of [
      'ccc download <path>',
      'run it in a tab of the project',
      'this project is on this computer: <path>',
      'the offer waits 10',
      '3 offers waiting and 10 offers per 10 minutes per window'
    ]) {
      expect(cli.replace(/\s+/g, ' '), text).toContain(text)
    }
  })

  it('the core skill tells Claude to offer an artifact once, and that it fails on a local desktop', () => {
    const skill = CORE_SKILL_TEXT.replace(/\s+/g, ' ')
    expect(skill).toContain('Offer an artifact the person asked for once with `ccc download <path>`')
    expect(skill).toContain('it fails on a local desktop, where the file is already theirs')
  })
})
