// `ccc web` (server-mode plan Tasks 11 and 12, design-web.md §9.4): the host-only handlers of
// main/socket/web-handlers.ts called directly and over a real socket, the status that never carries
// a secret, the desktop's narrowing, the drift between the handlers and HOST_ONLY_COMMANDS, and the
// CLI side (the request each subcommand sends, what it prints, "not running" as exit 1). Part 2:
// link, add-device, password, mode and set, through the real WebAccessService too (a link usable
// once, a risk refused with its text and the record unchanged, the password in no log or reply).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs } from '../../src/cli/args'
import { buildRequest, NOT_RUNNING, readStdinCapped, run, runCommand, type Output } from '../../src/cli/client'
import { formatWebStatus } from '../../src/cli/web-format'
import { readHidden, readPassword } from '../../src/cli/web-password'
import { fakeSecretStore, KEYFILE_PREFIX, unreadableCounts, type SecretStore } from '../../src/main/secrets/secret-store'
import { SocketServer, type Caller, type Handler } from '../../src/main/socket/socket-server'
import {
  confirmNeededText,
  DESKTOP_REFUSAL,
  registerWebHandlers,
  SHELL_REVOKE_REASON,
  webHandlers,
  type WebHandlerDeps
} from '../../src/main/socket/web-handlers'
import { connect } from '../../src/main/socket/transport'
import { AccessLog } from '../../src/main/web/access-log'
import { SERVER_NONE_WARNING, WebAccessService, type GatewayLike } from '../../src/main/web/access-service'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import type { GatewayStatus } from '../../src/main/web/gateway'
import { PasswordHasher } from '../../src/main/web/password'
import { listenPlanOf, SERVER_NO_CONFIRM_MODE, SERVER_ONLY_WAY_IN, serverConfirmCommand, storedWebAccess } from '../../src/main/web/settings'
import {
  encodeReply,
  encodeRequest,
  HOST_ONLY_COMMANDS,
  HOST_ONLY_TEXT,
  LineFramer,
  parseReply,
  parseRequest,
  type Reply,
  type Request
} from '../../src/shared/protocol'
import type { WebAccessSettings } from '../../src/shared/types'
import { WEB_RISK_TEXT, type WebCliStatus } from '../../src/shared/web-access'

const POSIX = process.platform !== 'win32'
const TOKEN = 'c'.repeat(64)
const CWD = '/work/dir'

/** A status as main would build it, for the handler and the CLI's printing. */
const STATUS: WebCliStatus = {
  server: true,
  enabled: true,
  mode: 'link',
  bind: '127.0.0.1',
  port: 7330,
  externalOrigin: null,
  gateway: { state: 'listening', bind: '127.0.0.1', port: 7330, origin: 'http://127.0.0.1:7330' },
  secrets: { store: 'keyfile', unavailable: null, otherMode: 0, replaced: 0 },
  accessLink: 'set',
  password: 'unset',
  devices: [],
  notices: []
}

/** Deps that record what the handlers did. */
function recorder(server: boolean): WebHandlerDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    server,
    status: () => {
      calls.push('status')
      return STATUS
    },
    revoke: (id) => {
      calls.push(`revoke ${id}`)
      return id === 'dev-1'
    },
    revokeAll: () => {
      calls.push('revokeAll')
      return 3
    },
    stop: () => {
      calls.push('stop')
    },
    link: async (regenerate) => {
      calls.push(regenerate ? 'regenerate' : 'link')
      return { ok: true, link: 'http://127.0.0.1:7330/#t=LINK' }
    },
    addDevice: () => {
      calls.push('addDevice')
      return { ok: true, link: 'http://127.0.0.1:7330/#t=ONCE', expiresAt: 600_000 }
    },
    setPassword: async (password) => {
      calls.push(`setPassword ${password.length}`)
      return { ok: true }
    },
    set: async (patch) => {
      calls.push(`set ${JSON.stringify(patch)}`)
      return { ...VIEW }
    },
    logShell: (detail) => {
      calls.push(`log ${detail}`)
    }
  }
}

/** What WebAccessService.set answers after a change (only its shape matters here). */
const VIEW = {
  form: { enabled: true, bind: '127.0.0.1', port: 7330, externalOrigin: '', hosts: [], mode: 'link' as const, certPath: '', keyPath: '' },
  network: false,
  gateway: STATUS.gateway,
  devices: [],
  risks: [],
  passwordSet: false,
  credentials: { accessLink: 'unset' as const, password: 'unset' as const }
}

const NOT_HOST: Caller[] = [
  { kind: 'session', tabId: 'tab-1', projectId: 'p' },
  { kind: 'window', projectId: 'p' },
  { kind: 'project', path: '/p', projectId: 'p' },
  { kind: 'project', path: '/new', projectId: undefined }
]
const HOST: Caller = { kind: 'anonymous' }

describe('web handlers called directly', () => {
  it('each refuses a session, window or project caller itself, and does nothing', async () => {
    for (const server of [true, false]) {
      const deps = recorder(server)
      for (const [cmd, handler] of Object.entries(webHandlers(deps))) {
        for (const caller of NOT_HOST) {
          await expect(Promise.resolve().then(() => handler({ all: true }, caller)), `${cmd} ${caller.kind}`).rejects.toThrow(HOST_ONLY_TEXT)
        }
      }
      expect(deps.calls).toEqual([])
    }
  })

  it('answers status and revoke in both modes', async () => {
    for (const server of [true, false]) {
      const deps = recorder(server)
      const h = webHandlers(deps)
      expect(await h['web.status']!({}, HOST)).toEqual(STATUS)
      expect(h['web.revoke']!({ id: 'dev-1' }, HOST)).toEqual({ revoked: 1 })
      expect(h['web.revoke']!({ all: true }, HOST)).toEqual({ revoked: 3 })
      expect(deps.calls).toEqual(['status', 'revoke dev-1', 'revokeAll'])
    }
  })

  it('stops in server mode only; the desktop answers "use Settings › Web access"', () => {
    const server = recorder(true)
    expect(webHandlers(server)['web.stop']!({}, HOST)).toEqual({ stopping: true })
    expect(server.calls).toEqual(['stop'])
    const desktop = recorder(false)
    expect(() => webHandlers(desktop)['web.stop']!({}, HOST)).toThrow(DESKTOP_REFUSAL)
    expect(DESKTOP_REFUSAL).toBe('use Settings › Web access')
    expect(desktop.calls).toEqual([])
  })

  it('revoke takes exactly one of an id or all, and does not echo an unknown id', () => {
    const deps = recorder(true)
    const revoke = webHandlers(deps)['web.revoke']!
    for (const args of [{}, { id: 'dev-1', all: true }, { all: 'yes' }, { id: 5 }, { id: '' }, { id: 'x'.repeat(65) }]) {
      expect(() => revoke(args, HOST), JSON.stringify(args)).toThrow(/web revoke/)
    }
    expect(() => revoke({ id: 'secret-looking-id' }, HOST)).toThrow(/no signed-in device has that id/)
    try {
      revoke({ id: 'secret-looking-id' }, HOST)
    } catch (err) {
      expect(String(err)).not.toContain('secret-looking-id')
    }
    expect(deps.calls).toEqual(['revoke secret-looking-id', 'revoke secret-looking-id'])
  })
})

describe('the drift between the web handlers and HOST_ONLY_COMMANDS', () => {
  it('every request web-handlers.ts registers is in HOST_ONLY_COMMANDS', () => {
    const registered: string[] = []
    registerWebHandlers({ handle: (cmd) => void registered.push(cmd) }, recorder(true))
    expect(registered.length).toBeGreaterThan(0)
    for (const cmd of registered) expect(HOST_ONLY_COMMANDS, cmd).toContain(cmd)
    expect(registered.sort()).toEqual(Object.keys(webHandlers(recorder(true))).sort())
  })

  it('every handler whose name starts with web. is refused at registration unless it is listed', () => {
    const socket = new SocketServer({ path: '/nonexistent', resolveToken: () => undefined, resolveProject: (path) => ({ path, projectId: undefined }) })
    const noop: Handler = () => null
    for (const cmd of HOST_ONLY_COMMANDS) expect(() => socket.handle(cmd, noop), cmd).not.toThrow()
    for (const cmd of ['web.', 'web.statusx', 'web.debug', 'web.link.extra']) expect(() => socket.handle(cmd, noop), cmd).toThrow(/HOST_ONLY_COMMANDS/)
  })
})

describe('web handlers over the real socket', () => {
  let root: string
  let sock: string
  let socket: SocketServer
  const SESSION = 'a'.repeat(64)
  const WINDOW = 'b'.repeat(64)

  beforeEach(async () => {
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccw-'))
    sock = join(root, 's.sock')
  })
  afterEach(async () => {
    await socket.stop()
    rmSync(root, { recursive: true, force: true })
  })

  async function ask(request: Partial<Request> & { cmd: string }): Promise<Reply> {
    const conn = await connect(sock, 1000)
    const framer = new LineFramer()
    return new Promise((resolve, reject) => {
      conn.on('data', (chunk: Buffer) => {
        const [line] = framer.push(chunk)
        if (line !== undefined) {
          conn.destroy()
          resolve(parseReply(line))
        }
      })
      conn.on('error', reject)
      conn.write(encodeRequest({ v: 1, id: 1, args: {}, ...request }))
    })
  }

  async function serve(server: boolean): Promise<WebHandlerDeps & { calls: string[] }> {
    socket = new SocketServer({
      path: sock,
      resolveToken: (token) => (token === SESSION ? { kind: 'session', tabId: 't', projectId: 'p' } : token === WINDOW ? { kind: 'window', projectId: 'p' } : undefined),
      resolveProject: (path) => ({ path, projectId: undefined }),
      log: () => undefined
    })
    const deps = recorder(server)
    registerWebHandlers(socket, deps)
    expect(await socket.start()).toBe(true)
    return deps
  }

  it('each of the eight is refused for a session and a window token with the same text, nothing done', async () => {
    const deps = await serve(true)
    for (const cmd of HOST_ONLY_COMMANDS) {
      for (const token of [SESSION, WINDOW]) {
        expect(await ask({ cmd, token, args: { all: true } }), cmd).toEqual({ id: 1, ok: false, error: HOST_ONLY_TEXT })
      }
    }
    expect(deps.calls).toEqual([])
  })

  it('tokenless: every one of the eight answers in server mode', async () => {
    const deps = await serve(true)
    expect(await ask({ cmd: 'web.status' })).toEqual({ id: 1, ok: true, result: STATUS })
    expect(await ask({ cmd: 'web.revoke', args: { id: 'dev-1' } })).toEqual({ id: 1, ok: true, result: { revoked: 1 } })
    expect(await ask({ cmd: 'web.stop' })).toEqual({ id: 1, ok: true, result: { stopping: true } })
    expect(await ask({ cmd: 'web.link' })).toMatchObject({ ok: true, result: { link: 'http://127.0.0.1:7330/#t=LINK' } })
    expect(await ask({ cmd: 'web.add-device' })).toMatchObject({ ok: true, result: { link: 'http://127.0.0.1:7330/#t=ONCE', expiresAt: 600_000 } })
    expect(await ask({ cmd: 'web.password', args: { password: 'hunter2hunter2' } })).toMatchObject({ ok: true, result: { set: true, mode: 'link' } })
    expect(await ask({ cmd: 'web.mode', args: { mode: 'password' } })).toMatchObject({ ok: true, result: { mode: 'password' } })
    expect(await ask({ cmd: 'web.set', args: { port: 7400 } })).toMatchObject({ ok: true, result: STATUS })
    expect(deps.calls.filter((c) => !c.startsWith('log '))).toEqual([
      'status',
      'revoke dev-1',
      'stop',
      'link',
      'addDevice',
      'setPassword 14',
      'status',
      'set {"mode":"password"}',
      'set {"port":7400}',
      'status'
    ])
  })

  it('outside server mode only status and revoke are answered; the rest say "use Settings › Web access" and do nothing', async () => {
    const deps = await serve(false)
    expect(await ask({ cmd: 'web.status' })).toMatchObject({ ok: true })
    expect(await ask({ cmd: 'web.revoke', args: { all: true } })).toMatchObject({ ok: true, result: { revoked: 3 } })
    for (const [cmd, args] of [
      ['web.stop', {}],
      ['web.link', { regenerate: true }],
      ['web.add-device', {}],
      ['web.password', { password: 'hunter2hunter2' }],
      ['web.mode', { mode: 'none' }],
      ['web.set', { bind: '0.0.0.0', confirm: ['none-network', 'plain-http'] }]
    ] as const) {
      expect(await ask({ cmd, args }), cmd).toEqual({ id: 1, ok: false, error: DESKTOP_REFUSAL })
    }
    expect(deps.calls).toEqual(['status', 'revokeAll'])
  })
})

describe('WebAccessService.cliStatus: what ccc web status shows, and no secret', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccw-status-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports mode, address, gateway, credentials, devices and the secrets as given; never a link, token, cookie, hash or stored value', async () => {
    const accessLog = new AccessLog({ filePath: join(dir, 'logs', 'web-access.log') })
    const devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog })
    const auth = new WebAuth({
      devices,
      secrets: fakeSecretStore(),
      accessLog,
      hasher: new PasswordHasher({ params: { N: 1024, r: 8, p: 1 } }),
      log: () => undefined
    })
    let stored: unknown = { enabled: true, mode: 'link', externalOrigin: 'https://box.example' }
    let status: GatewayStatus = { state: 'listening', bind: '127.0.0.1', port: 7330 }
    const gateway: GatewayLike = {
      apply: async () => status,
      status: () => status,
      connections: () => new Map([[devices.list()[0]?.id ?? '', 1]]),
      disconnectDevice: () => 0,
      onConnectionsChanged: () => () => undefined
    }
    const service = new WebAccessService({
      gateway,
      auth,
      read: () => stored,
      write: (next) => {
        stored = storedWebAccess(stored as Partial<WebAccessSettings> | undefined, next)
      },
      emit: () => undefined,
      terminals: { start: () => undefined, drain: async () => undefined },
      server: true
    })
    auth.setMode('link')
    const made = await auth.accessLink('https://box.example')
    if (!made.ok) throw new Error(made.reason)
    const token = new URL(made.link).hash.slice('#t='.length)
    expect(token.length).toBeGreaterThan(20)
    const signedIn = await auth.signInWithToken({ token, name: 'Phone' })
    if (!signedIn.ok) throw new Error(signedIn.error)
    const password = 'correct horse battery'
    expect(await auth.setPassword(password)).toEqual({ ok: true })
    const once = auth.addDeviceLink('https://box.example').link

    const secrets = { store: 'keyfile' as const, unavailable: null, otherMode: 2, replaced: 1 }
    const view = service.cliStatus(secrets)
    expect(view).toEqual({
      server: true,
      enabled: true,
      mode: 'link',
      bind: '127.0.0.1',
      port: 7330,
      externalOrigin: 'https://box.example',
      gateway: { state: 'listening', bind: '127.0.0.1', port: 7330, origin: 'https://box.example' },
      secrets,
      accessLink: 'set',
      password: 'set',
      devices: [expect.objectContaining({ id: signedIn.device.id, name: 'Phone', mode: 'link', connected: true })],
      notices: []
    })

    const file = JSON.parse(readFileSync(join(dir, 'web-access.json'), 'utf8')) as Record<string, unknown>
    const json = JSON.stringify(view)
    const text = formatWebStatus(view, String)
    const secretsOnDisk = [
      token,
      new URL(once).hash.slice('#t='.length),
      signedIn.cookie,
      (signedIn.cookie.split('.')[1] as string),
      password,
      (file.accessToken as { hash: string; stored: string }).hash,
      (file.accessToken as { stored: string }).stored,
      (file.password as { stored: string }).stored,
      ...(file.devices as Array<{ secretHash: string }>).map((d) => d.secretHash)
    ]
    for (const secret of secretsOnDisk) {
      expect(json).not.toContain(secret)
      expect(text).not.toContain(secret)
    }
    expect(json).not.toContain('#t=')

    // Refused and failed: the reason, and the stored desktop off.
    status = { state: 'failed', reason: 'port 7330 is in use' }
    expect(service.cliStatus(secrets).gateway).toEqual({ state: 'failed', reason: 'port 7330 is in use' })
    // The core notices main kept ride along as given (none by default).
    const notice = { kind: 'update' as const, text: 'A new cc-cockpit version is available: 1.2.3 (running 1.0.0)', at: 5 }
    expect(service.cliStatus(secrets, [notice]).notices).toEqual([notice])
    expect(service.cliStatus(secrets).notices).toEqual([])
    service.dispose()
  })

  it('counts the values the running store cannot read, by why, without decrypting', () => {
    const keyFile: SecretStore = {
      kind: 'keyfile',
      unavailableReason: async () => null,
      encrypt: async () => {
        throw new Error('not here')
      },
      decrypt: async () => {
        throw new Error('not here')
      },
      isReplaced: (stored) => stored.endsWith('old')
    }
    const values = [`${KEYFILE_PREFIX}new`, `${KEYFILE_PREFIX}old`, `${KEYFILE_PREFIX}old`, 'djExMw==', '']
    expect(unreadableCounts(keyFile, values)).toEqual({ otherMode: 1, replaced: 2 })
    expect(unreadableCounts({ ...keyFile, kind: 'os', isReplaced: undefined }, values)).toEqual({ otherMode: 3, replaced: 0 })
    expect(unreadableCounts(fakeSecretStore(), values)).toEqual({ otherMode: 0, replaced: 0 })
  })
})

describe('ccc web: the CLI', () => {
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
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccwc-'))
    sock = join(root, 's.sock')
    servers = []
    out = ''
    err = ''
  })
  afterEach(() => {
    for (const s of servers) s.close()
    rmSync(root, { recursive: true, force: true })
  })

  function fakeApp(answer: (r: Request) => { ok: true; result: unknown } | { ok: false; error: string }): Promise<Request[]> {
    const seen: Request[] = []
    const server = createServer((socket: Socket) => {
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) {
          const request = parseRequest(line)
          seen.push(request)
          socket.write(encodeReply({ id: request.id, ...answer(request) }))
        }
      })
      socket.on('error', () => {})
    })
    servers.push(server)
    return new Promise((resolve) => server.listen(sock, () => resolve(seen)))
  }

  it('sends each subcommand as its request, with no project; in a tab the token goes along', () => {
    expect(buildRequest({ kind: 'web-status', json: true }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.status', args: {} })
    expect(buildRequest({ kind: 'web-revoke', id: 'dev-1', all: false }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.revoke', args: { id: 'dev-1' } })
    expect(buildRequest({ kind: 'web-revoke', all: true }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.revoke', args: { all: true } })
    expect(buildRequest({ kind: 'web-stop' }, { APP_TAB_TOKEN: TOKEN }, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.stop', args: {}, token: TOKEN })
  })

  it('with the app not running prints "cc-cockpit is not running" and exits 1 (other commands stay a silent 0)', async () => {
    for (const argv of [['web', 'status'], ['web', 'status', '--json'], ['web', 'revoke', '--all'], ['web', 'stop']]) {
      out = ''
      err = ''
      expect(await run(argv, { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD), argv.join(' ')).toBe(1)
      expect(out).toBe('')
      expect(err).toBe(`ccc: ${NOT_RUNNING}\n`)
    }
    err = ''
    expect(await run(['sessions'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(err).toBe('')
  })

  it('brackets an IPv6 address in the status lines', () => {
    const text = formatWebStatus({ bind: '::', port: 7000, gateway: { state: 'listening', bind: '::1', port: 7000, origin: 'http://[::1]:7000' } }, String)
    expect(text).toContain('address: [::]:7000')
    expect(text).toContain('listening on [::1]:7000')
  })

  it('prints the status as JSON with --json and as lines without; a refusal is exit 1 with its text', async () => {
    const seen = await fakeApp((r) => (r.token !== undefined ? { ok: false, error: HOST_ONLY_TEXT } : { ok: true, result: { ...STATUS, devices: [{ id: 'dev-1', name: 'Phone\u001b[2J', createdAt: 0, lastSeenAt: 0, mode: 'add', connected: true }] } }))
    expect(await runCommand({ kind: 'web-status', json: true }, { CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ server: true, mode: 'link' })
    out = ''
    expect(await runCommand({ kind: 'web-status', json: false }, { CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(0)
    expect(out).toContain('server mode: yes')
    expect(out).toContain('gateway: listening on 127.0.0.1:7330, links point at http://127.0.0.1:7330')
    expect(out).toContain("secret store: server mode's key file")
    expect(out).toContain('access link: made')
    expect(out).toContain('password: not set')
    expect(out).toContain('  dev-1\tPhone [2J\tsigned in with add\tlast seen 1970-01-01T00:00:00.000Z\tconnected')
    expect(out).not.toContain('\u001b')
    expect(err).toBe('')
    out = ''
    expect(await runCommand({ kind: 'web-status', json: false }, { CC_COCKPIT_SOCK: sock, APP_TAB_TOKEN: TOKEN }, CWD, io)).toBe(1)
    expect(out).toBe('')
    expect(err).toBe(`ccc: ${HOST_ONLY_TEXT}\n`)
    expect(seen.map((r) => [r.cmd, r.token, r.project])).toEqual([
      ['web.status', undefined, undefined],
      ['web.status', undefined, undefined],
      ['web.status', TOKEN, undefined]
    ])
  })

  it('prints what revoke and stop did', async () => {
    await fakeApp((r) => ({ ok: true, result: r.cmd === 'web.revoke' ? { revoked: 2 } : { stopping: true } }))
    expect(await run(['web', 'revoke', '--all'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(await run(['web', 'stop'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('revoked 2 device(s)\ncc-cockpit is stopping\n')
  })

  it('lists the core notices in status lines and --json, a new device beside its log entry, never in a desktop status', async () => {
    const notices: WebCliStatus['notices'] = [
      { kind: 'new-device', text: 'A new device signed in to web access: Phone\u001b[2J', at: 0, device: 'dev-1' },
      { kind: 'revoked', text: 'Plugin a.b was stopped: the marketplace index revoked it (the reason is on the Plugins page)', at: 1000 },
      { kind: 'update', text: 'A new cc-cockpit version is available: 1.2.3 (running 1.0.0)', at: 2000 }
    ]
    const text = formatWebStatus({ ...STATUS, notices }, (t) => String(t).split('\u001b').join(' '))
    expect(text).toContain('notices: 3\n')
    expect(text).toContain('  1970-01-01T00:00:00.000Z\tnew device\tA new device signed in to web access: Phone [2J\tdevice dev-1 (sign-in in web-access.log)')
    expect(text).toContain('  1970-01-01T00:00:01.000Z\tplugin revoked\tPlugin a.b was stopped:')
    expect(text).toContain('  1970-01-01T00:00:02.000Z\tupdate\tA new cc-cockpit version is available: 1.2.3 (running 1.0.0)')
    expect(text).not.toMatch(/https?:\/\/[^\s]*(#t=|token)/)
    expect(formatWebStatus(STATUS, String)).not.toContain('notices')

    await fakeApp(() => ({ ok: true, result: { ...STATUS, notices } }))
    expect(await runCommand({ kind: 'web-status', json: true }, { CC_COCKPIT_SOCK: sock }, CWD, io)).toBe(0)
    expect(JSON.parse(out)).toMatchObject({ notices })
  })

  it('prints the other-mode and replaced counts, and the credentials that cannot be read', () => {
    const text = formatWebStatus(
      { ...STATUS, server: false, gateway: { state: 'refused', reason: 'needs a confirm' }, secrets: { store: 'os', unavailable: 'no OS keyring', otherMode: 2, replaced: 1 }, accessLink: 'other-mode', password: 'replaced' },
      String
    )
    expect(text).toContain('server mode: no')
    expect(text).toContain('gateway: not listening: needs a confirm')
    expect(text).toContain('  unavailable: no OS keyring')
    expect(text).toContain("  2 stored value(s) belong to the other mode's store")
    expect(text).toContain('  1 stored value(s) were made under a replaced key file')
    expect(text).toContain("access link: stored by the other mode's secret store: regenerate it")
    expect(text).toContain('password: made under a replaced key file: set it again')
    expect(text).toContain('devices: none signed in')
  })
})

describe('ccc web part 2 (server-mode plan Task 12): the handlers called directly', () => {
  it('link, regenerate and add-device answer the link and log the command, never the link', async () => {
    const deps = recorder(true)
    const h = webHandlers(deps)
    expect(await h['web.link']!({}, HOST)).toEqual({ link: 'http://127.0.0.1:7330/#t=LINK' })
    expect(await h['web.link']!({ regenerate: true }, HOST)).toEqual({ link: 'http://127.0.0.1:7330/#t=LINK' })
    expect(h['web.add-device']!({}, HOST)).toEqual({ link: 'http://127.0.0.1:7330/#t=ONCE', expiresAt: 600_000 })
    expect(deps.calls).toEqual(['link', 'log ccc web link', 'regenerate', 'log ccc web link --regenerate', 'addDevice', 'log ccc web add-device'])
    await expect(Promise.resolve().then(() => h['web.link']!({ regenerate: 'yes' }, HOST))).rejects.toThrow(/regenerate is true or absent/)
    expect(() => h['web.add-device']!({ name: 'x' }, HOST)).toThrow(/unexpected field/)
  })

  it('a link that cannot be made says why; a failed regenerate is logged as an attempt', async () => {
    const deps = recorder(true)
    deps.link = async () => ({ ok: false, reason: 'links work only in the access-link mode' })
    deps.addDevice = () => ({ ok: false, reason: 'web access is not listening' })
    const h = webHandlers(deps)
    await expect(Promise.resolve().then(() => h['web.link']!({}, HOST))).rejects.toThrow('web link: links work only in the access-link mode')
    await expect(Promise.resolve().then(() => h['web.link']!({ regenerate: true }, HOST))).rejects.toThrow(/web link:/)
    expect(() => h['web.add-device']!({}, HOST)).toThrow('web add-device: web access is not listening')
    expect(deps.calls).toEqual(['log ccc web link --regenerate (failed: nothing may have changed)'])
  })

  it('password: text within the cap only, the reason never quotes it, the log line names the command only', async () => {
    const deps = recorder(true)
    const h = webHandlers(deps)
    for (const args of [{}, { password: '' }, { password: 7 }, { password: 'x'.repeat(1025) }, { password: 'hunter2hunter2', extra: 1 }]) {
      await expect(Promise.resolve().then(() => h['web.password']!(args, HOST)), JSON.stringify(args).slice(0, 40)).rejects.toThrow(/web password/)
    }
    expect(deps.calls).toEqual([])
    const failing = recorder(true)
    failing.setPassword = async () => ({ ok: false, reason: 'the password needs at least 8 characters' })
    const err = await Promise.resolve()
      .then(() => webHandlers(failing)['web.password']!({ password: 'short1' }, HOST))
      .catch((e: unknown) => String(e))
    expect(err).toContain('web password: the password needs at least 8 characters')
    expect(err).not.toContain('short1')
    expect(failing.calls).toEqual([])
    expect(await h['web.password']!({ password: 'hunter2hunter2' }, HOST)).toEqual({ set: true, mode: 'link' })
    expect(deps.calls).toEqual(['setPassword 14', 'log ccc web password', 'status'])
    expect(deps.calls.join(' ')).not.toContain('hunter2')
  })

  it('mode: link, password and none through set; none carries the shared-server warning; confirm is refused with the reason', async () => {
    const deps = recorder(true)
    const h = webHandlers(deps)
    expect(await h['web.mode']!({ mode: 'link' }, HOST)).toEqual({ mode: 'link' })
    expect(await h['web.mode']!({ mode: 'none', confirm: ['none-network'] }, HOST)).toEqual({ mode: 'none', warning: SERVER_NONE_WARNING })
    expect(SERVER_NONE_WARNING).toContain('every user of this machine')
    await expect(Promise.resolve().then(() => h['web.mode']!({ mode: 'confirm' }, HOST))).rejects.toThrow(SERVER_NO_CONFIRM_MODE)
    for (const args of [{}, { mode: 'open' }, { mode: 'none', confirm: ['all'] }, { mode: 'none', confirm: 'none-network' }, { mode: 'link', enabled: false }]) {
      await expect(Promise.resolve().then(() => h['web.mode']!(args, HOST)), JSON.stringify(args)).rejects.toThrow(/web mode/)
    }
    expect(deps.calls).toEqual([
      'set {"mode":"link"}',
      'log ccc web mode link',
      'set {"mode":"none","confirm":["none-network"]}',
      'log ccc web mode none --confirm none-network'
    ])
  })

  it('set: only the patch fields, TLS paths absolute, at least one field; enabled and mode are not settable here', async () => {
    const deps = recorder(true)
    const set = webHandlers(deps)['web.set']!
    for (const args of [
      {},
      { enabled: false },
      { mode: 'none' },
      { bind: '0.0.0.0', confirmed: ['none-network'] },
      { tls: { certPath: 'cert.pem', keyPath: '/k.pem' } },
      { tls: { certPath: '/c.pem', keyPath: '../k.pem' } },
      { tls: { certPath: '/c.pem' } },
      { tls: 'yes' },
      { confirm: ['everything'] }
    ]) {
      await expect(Promise.resolve().then(() => set(args, HOST)), JSON.stringify(args)).rejects.toThrow(/web set/)
    }
    expect(deps.calls).toEqual([])
    expect(await set({ bind: '0.0.0.0', port: 7400, hosts: ['box'], externalOrigin: '', tls: null, confirm: ['plain-http', 'plain-http'] }, HOST)).toEqual(STATUS)
    expect(await set({ tls: { certPath: '/etc/c.pem', keyPath: '/etc/k.pem' } }, HOST)).toEqual(STATUS)
    expect(deps.calls).toEqual([
      'set {"bind":"0.0.0.0","port":7400,"externalOrigin":"","hosts":["box"],"tls":null,"confirm":["plain-http"]}',
      'log ccc web set --bind --port --origin --host --no-tls --confirm plain-http',
      'status',
      'set {"tls":{"certPath":"/etc/c.pem","keyPath":"/etc/k.pem"}}',
      'log ccc web set --tls-cert/--tls-key',
      'status'
    ])
  })

  it('a change that needs a confirm is refused with the confirm text and the flags that give it, nothing logged', async () => {
    const deps = recorder(true)
    deps.set = async () => ({ needsConfirm: ['none-network', 'plain-http'] })
    const err = await Promise.resolve()
      .then(() => webHandlers(deps)['web.set']!({ bind: '0.0.0.0' }, HOST))
      .catch((e: unknown) => (e as Error).message)
    expect(err).toBe(confirmNeededText(['none-network', 'plain-http']))
    expect(err).toContain(WEB_RISK_TEXT['none-network'].title)
    expect(err).toContain(WEB_RISK_TEXT['plain-http'].paragraphs[0])
    expect(err).toContain('run the same command with --confirm none-network --confirm plain-http')
    expect(deps.calls).toEqual([])
  })
})

describe('ccc web part 2 through the real WebAccessService (server mode)', () => {
  let dir: string
  let stored: Record<string, unknown>
  let service: WebAccessService
  let auth: WebAuth
  let h: Record<string, Handler>
  let logFile: string

  beforeEach(() => {
    dir = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccw-p2-'))
    logFile = join(dir, 'logs', 'web-access.log')
    const accessLog = new AccessLog({ filePath: logFile })
    const devices = new DeviceStore({ filePath: join(dir, 'web-access.json'), accessLog })
    auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog, hasher: new PasswordHasher({ params: { N: 1024, r: 8, p: 1 } }), log: () => undefined })
    stored = { enabled: true, mode: 'link', bind: '127.0.0.1', port: 7330, hosts: [] }
    let status: GatewayStatus = { state: 'off' }
    // As the real gateway: the settings' mode reaches WebAuth, and a refused plan does not listen.
    const gateway: GatewayLike = {
      apply: async (settings) => {
        auth.setMode(settings.mode)
        const plan = listenPlanOf(settings)
        status = plan.ok ? { state: 'listening', bind: plan.bind, port: plan.port } : { state: 'refused', reason: plan.reason }
        return status
      },
      status: () => status,
      connections: () => new Map(),
      disconnectDevice: () => 0,
      onConnectionsChanged: () => () => undefined
    }
    service = new WebAccessService({
      gateway,
      auth,
      read: () => stored,
      write: (next) => {
        stored = storedWebAccess(stored as Partial<WebAccessSettings>, next) as Record<string, unknown>
      },
      emit: () => undefined,
      terminals: { start: () => undefined, drain: async () => undefined },
      server: true
    })
    // Wired as main/index.ts does.
    h = webHandlers({
      server: true,
      status: () => service.cliStatus({ store: 'fake', unavailable: null, otherMode: 0, replaced: 0 }),
      revoke: (id) => service.revoke(id, { reason: SHELL_REVOKE_REASON }),
      revokeAll: () => service.revokeAll({ reason: SHELL_REVOKE_REASON }),
      stop: () => undefined,
      link: (regenerate) => (regenerate ? service.regenerate() : service.link()),
      addDevice: () => service.addDevice(),
      setPassword: (password) => service.setPassword(password),
      set: (patch) => service.set(patch),
      logShell: (detail) => accessLog.write({ event: 'shell', detail })
    })
  })
  afterEach(() => {
    service.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const tokenOf = (link: string): string => new URL(link).hash.slice('#t='.length)
  const call = async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => h[cmd]!(args, HOST)
  const refusal = (cmd: string, args: Record<string, unknown> = {}): Promise<string> =>
    Promise.resolve()
      .then(() => h[cmd]!(args, HOST))
      .then(
        () => 'no refusal',
        (e: unknown) => (e as Error).message
      )
  const logText = (): string => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '')

  it('an add-device link signs in once; the access link is made on first use and a regenerate kills it and its devices', async () => {
    await service.apply()
    const once = (await call('web.add-device')) as { link: string; expiresAt: number }
    expect(once.link.startsWith('http://127.0.0.1:7330/#t=')).toBe(true)
    expect(await auth.signInWithToken({ token: tokenOf(once.link), name: 'Phone' })).toMatchObject({ ok: true })
    expect(await auth.signInWithToken({ token: tokenOf(once.link), name: 'Thief' })).toMatchObject({ ok: false, status: 401 })

    expect(service.cliStatus({ store: 'fake', unavailable: null, otherMode: 0, replaced: 0 }).accessLink).toBe('unset')
    const first = (await call('web.link')) as { link: string }
    expect(((await call('web.link')) as { link: string }).link).toBe(first.link)
    expect(await auth.signInWithToken({ token: tokenOf(first.link), name: 'Laptop' })).toMatchObject({ ok: true })
    expect(auth.devices.list().map((d) => d.name).sort()).toEqual(['Laptop', 'Phone'])
    const second = (await call('web.link', { regenerate: true })) as { link: string }
    expect(second.link).not.toBe(first.link)
    expect(await auth.signInWithToken({ token: tokenOf(first.link) })).toMatchObject({ ok: false, status: 401 })
    // The one-time link's device stays: it never had the token.
    expect(auth.devices.list().map((d) => d.name)).toEqual(['Phone'])

    const log = logText()
    for (const link of [once.link, first.link, second.link]) expect(log).not.toContain(tokenOf(link))
    expect(log).toContain('"event":"shell","detail":"ccc web add-device"')
    expect(log).toContain('"detail":"ccc web link --regenerate"')
  })

  it('no link when the gateway does not listen or the mode is not link, with server wording', async () => {
    expect(await refusal('web.link')).toMatch(/web link: web access is not listening.*ccc web status/)
    expect(await refusal('web.add-device')).toMatch(/not listening/)
    stored = { ...stored, mode: 'password' }
    await service.apply()
    expect(await refusal('web.add-device')).toBe('web add-device: links work only in the access-link mode: `ccc web mode link` switches to it')
  })

  it('password: set off-thread, signs in after a mode switch; never in the reply, an error or the log', async () => {
    await service.apply()
    const password = 'Tr0ub4dor&3-secret'
    expect(await refusal('web.mode', { mode: 'password' })).toBe('set a password first')
    const short = await refusal('web.password', { password: 'abc' })
    expect(short).toMatch(/at least 8 characters/)
    expect(short).not.toContain('abc')
    const reply = await call('web.password', { password })
    expect(reply).toEqual({ set: true, mode: 'link' })
    expect(await call('web.mode', { mode: 'password' })).toEqual({ mode: 'password' })
    expect(stored.mode).toBe('password')
    expect(await auth.signInWithPassword({ password, name: 'Phone' })).toMatchObject({ ok: true })
    expect(JSON.stringify(reply)).not.toContain(password)
    const log = logText()
    expect(log).toContain('"detail":"ccc web password"')
    expect(log).toContain('"event":"password","detail":"set"')
    expect(log).toContain('"detail":"ccc web mode password"')
    expect(log).not.toContain(password)
    expect(readFileSync(join(dir, 'web-access.json'), 'utf8')).not.toContain(password)
  })

  it('confirm mode and turning off are refused, and the record is unchanged', async () => {
    await service.apply()
    const before = JSON.stringify(stored)
    expect(await refusal('web.mode', { mode: 'confirm' })).toBe(SERVER_NO_CONFIRM_MODE)
    expect(await refusal('web.set', { enabled: false })).toMatch(/web set: unexpected field "enabled"/)
    // Even straight through the service (the Settings page's path), server mode refuses off.
    await expect(service.set({ enabled: false })).rejects.toThrow(SERVER_ONLY_WAY_IN)
    expect(JSON.stringify(stored)).toBe(before)
  })

  it('a §4.3 risk is refused with its text and the record unchanged, then applies with its --confirm', async () => {
    await service.apply()
    const before = JSON.stringify(stored)
    const err = await refusal('web.set', { bind: '0.0.0.0' })
    expect(err).toBe(confirmNeededText(['plain-http']))
    expect(JSON.stringify(stored)).toBe(before)
    const status = (await call('web.set', { bind: '0.0.0.0', confirm: ['plain-http'] })) as WebCliStatus
    expect(stored).toMatchObject({ bind: '0.0.0.0', confirmed: ['plain-http'] })
    expect(status.gateway).toMatchObject({ state: 'listening', bind: '0.0.0.0' })
    // None on that bind brings in the other risk, which needs its own confirm.
    expect(await refusal('web.mode', { mode: 'none' })).toBe(confirmNeededText(['none-network']))
    expect(await call('web.mode', { mode: 'none', confirm: ['none-network'] })).toEqual({ mode: 'none', warning: SERVER_NONE_WARNING })
    expect(stored).toMatchObject({ mode: 'none', confirmed: ['none-network', 'plain-http'] })
  })

  it('serverConfirmCommand applies a stored unconfirmed bind with both risks, as start prints it', async () => {
    stored = { ...stored, bind: '0.0.0.0', mode: 'none' }
    await service.apply()
    expect(service.cliStatus({ store: 'fake', unavailable: null, otherMode: 0, replaced: 0 }).gateway.state).toBe('refused')
    const line = serverConfirmCommand(stored as unknown as WebAccessSettings) as string
    expect(line).toBe('ccc web set --bind 0.0.0.0 --confirm none-network --confirm plain-http')
    const parsed = parseArgs(line.split(' ').slice(1))
    const request = buildRequest(parsed as Parameters<typeof buildRequest>[0], {}, CWD) as Request
    const status = (await call(request.cmd, request.args)) as WebCliStatus
    expect(status.gateway.state).toBe('listening')
  })

  it('TLS: a relative path is refused by main; the CLI sends absolute ones', async () => {
    await service.apply()
    const before = JSON.stringify(stored)
    expect(await refusal('web.set', { tls: { certPath: 'c.pem', keyPath: 'k.pem' } })).toBe('web set: --tls-cert and --tls-key take absolute paths')
    expect(JSON.stringify(stored)).toBe(before)
    const request = buildRequest({ kind: 'web-set', tls: { cert: 'c.pem', key: '../keys/k.pem' }, confirm: [] }, {}, CWD) as Request
    expect(request.args).toEqual({ tls: { certPath: '/work/dir/c.pem', keyPath: '/work/keys/k.pem' } })
    await call(request.cmd, request.args)
    expect(stored.tls).toEqual({ certPath: '/work/dir/c.pem', keyPath: '/work/keys/k.pem' })
  })
})

describe('ccc web part 2: the CLI', () => {
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
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccwc2-'))
    sock = join(root, 's.sock')
    servers = []
    out = ''
    err = ''
  })
  afterEach(() => {
    for (const s of servers) s.close()
    rmSync(root, { recursive: true, force: true })
  })

  function fakeApp(answer: (r: Request) => { ok: true; result: unknown } | { ok: false; error: string }): Promise<Request[]> {
    const seen: Request[] = []
    const server = createServer((socket: Socket) => {
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const line of framer.push(chunk)) {
          const request = parseRequest(line)
          seen.push(request)
          socket.write(encodeReply({ id: request.id, ...answer(request) }))
        }
      })
      socket.on('error', () => {})
    })
    servers.push(server)
    return new Promise((resolve) => server.listen(sock, () => resolve(seen)))
  }

  /** A terminal stdin: keys arrive as `chunks` once raw mode is on; records the raw-mode switches. */
  function fakeTty(chunks: string[]): Readable & { isTTY: boolean; raw: boolean[]; setRawMode(mode: boolean): void } {
    const stream = new Readable({ read() {} }) as Readable & { isTTY: boolean; raw: boolean[]; setRawMode(mode: boolean): void }
    stream.isTTY = true
    stream.raw = []
    stream.setRawMode = (mode) => {
      stream.raw.push(mode)
      if (mode) {
        const next = chunks.shift()
        if (next !== undefined) setTimeout(() => stream.emit('data', Buffer.from(next)), 0)
      }
    }
    return stream
  }

  it('sends each new subcommand as its request, with no project', () => {
    expect(buildRequest({ kind: 'web-link', regenerate: false }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.link', args: {} })
    expect(buildRequest({ kind: 'web-link', regenerate: true }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.link', args: { regenerate: true } })
    expect(buildRequest({ kind: 'web-add-device' }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.add-device', args: {} })
    expect(buildRequest({ kind: 'web-password', password: 'pw-pw-pw-pw' }, {}, CWD)).toEqual({ v: 1, id: 1, cmd: 'web.password', args: { password: 'pw-pw-pw-pw' } })
    expect(buildRequest({ kind: 'web-mode', mode: 'none', confirm: ['none-network'] }, {}, CWD)).toEqual({
      v: 1,
      id: 1,
      cmd: 'web.mode',
      args: { mode: 'none', confirm: ['none-network'] }
    })
    expect(buildRequest({ kind: 'web-set', bind: '::', port: 7400, origin: '', hosts: ['a'], tls: null, confirm: ['plain-http'] }, { APP_TAB_TOKEN: TOKEN }, CWD)).toEqual({
      v: 1,
      id: 1,
      cmd: 'web.set',
      args: { bind: '::', port: 7400, externalOrigin: '', hosts: ['a'], tls: null, confirm: ['plain-http'] },
      token: TOKEN
    })
  })

  it('with the app not running each new subcommand prints "cc-cockpit is not running" and exits 1', async () => {
    for (const argv of [['web', 'link'], ['web', 'add-device'], ['web', 'mode', 'link'], ['web', 'set', '--port', '7400'], ['web', 'password']]) {
      out = ''
      err = ''
      expect(await run(argv, { CC_COCKPIT_SOCK: sock }, Readable.from(['pw-pw-pw-pw\n']), io, CWD), argv.join(' ')).toBe(1)
      expect(out).toBe('')
      expect(err).toBe(`ccc: ${NOT_RUNNING}\n`)
    }
  })

  it('password from a pipe: one line, sent only in the request args; never in argv, stdout or stderr', async () => {
    const password = 'pipe-Secret-123'
    const seen = await fakeApp(() => ({ ok: true, result: { set: true, mode: 'link' } }))
    expect(await run(['web', 'password'], { CC_COCKPIT_SOCK: sock }, Readable.from([`${password}\n`]), io, CWD)).toBe(0)
    expect(seen.map((r) => [r.cmd, r.args])).toEqual([['web.password', { password }]])
    expect(out).toBe('password set; sign-in is not by password yet: ccc web mode password switches to it\n')
    expect(out + err).not.toContain(password)
    for (const [input, message] of [
      ['', 'no password on stdin'],
      ['\n', 'no password on stdin'],
      ['two\nlines\n', 'the password on stdin must be one line'],
      ['x'.repeat(2000), 'the password on stdin is over 1100 bytes']
    ] as const) {
      out = ''
      err = ''
      expect(await run(['web', 'password'], { CC_COCKPIT_SOCK: sock }, Readable.from([input]), io, CWD), input.slice(0, 10)).toBe(1)
      expect(err).toContain(`ccc: web password: ${message}`)
      expect(err).not.toContain('lines')
    }
    expect(seen).toHaveLength(1)
  })

  it('password on a terminal: asked twice with echo off, Backspace honoured, nothing echoed; a mismatch sends nothing', async () => {
    const seen = await fakeApp(() => ({ ok: true, result: { set: true, mode: 'password' } }))
    const tty = fakeTty(['typed-pwX\u007f\u001b[A!\r', 'typed-pw!\r'])
    expect(await run(['web', 'password'], { CC_COCKPIT_SOCK: sock }, tty, io, CWD)).toBe(0)
    expect(seen.map((r) => r.args)).toEqual([{ password: 'typed-pw!' }])
    expect(tty.raw).toEqual([true, false, true, false])
    expect(err).toBe('New web access password: \nType it again: \n')
    expect(out).toBe('password set\n')
    err = ''
    out = ''
    expect(await run(['web', 'password'], { CC_COCKPIT_SOCK: sock }, fakeTty(['first-one\r', 'second-one\r']), io, CWD)).toBe(1)
    expect(err).toContain('ccc: web password: the two passwords differ; nothing changed')
    expect(err).not.toContain('first-one')
    err = ''
    expect(await run(['web', 'password'], { CC_COCKPIT_SOCK: sock }, fakeTty(['abc\u0003']), io, CWD)).toBe(1)
    expect(err).toContain('ccc: web password: cancelled')
    expect(seen).toHaveLength(1)
  })

  it('the prompt has a deadline of its own', async () => {
    const tty = fakeTty([])
    const read = await readHidden(tty, () => undefined, 'pw: ', 20, 256)
    expect(read).toEqual({ error: 'no password typed within 0 minutes' })
    expect(tty.raw).toEqual([true, false])
    const pipe = await readPassword(new Readable({ read() {} }), () => undefined, { maxChars: 256, stdinTimeoutMs: 20, readCapped: readStdinCapped })
    expect(pipe).toEqual({ error: 'stdin was not closed within 0 s' })
  })

  it('in a tab, web password reads nothing and gets the host-only refusal', async () => {
    const seen = await fakeApp((r) => (r.token !== undefined ? { ok: false, error: HOST_ONLY_TEXT } : { ok: true, result: null }))
    // A stdin that never ends: reading it would hang the test.
    const never = new Readable({ read() {} })
    expect(await run(['web', 'password'], { CC_COCKPIT_SOCK: sock, APP_TAB_TOKEN: TOKEN }, never, io, CWD)).toBe(1)
    expect(err).toBe(`ccc: ${HOST_ONLY_TEXT}\n`)
    expect(seen.map((r) => [r.cmd, r.args, r.token])).toEqual([['web.password', {}, TOKEN]])
  })

  it('prints a link alone on stdout, what it is on stderr; None its warning; set the address and the gateway; a confirm refusal whole', async () => {
    await fakeApp((r) => {
      switch (r.cmd) {
        case 'web.link':
        case 'web.add-device':
          return { ok: true, result: { link: 'http://127.0.0.1:7330/#t=abc\u001b[2J' } }
        case 'web.mode':
          return { ok: true, result: { mode: 'none', warning: SERVER_NONE_WARNING } }
        case 'web.set':
          return r.args.confirm === undefined
            ? { ok: false, error: confirmNeededText(['plain-http']) }
            : { ok: true, result: { ...STATUS, bind: '0.0.0.0', port: 7400, gateway: { state: 'failed', reason: 'port 7400 is in use' } } }
        default:
          return { ok: false, error: 'unexpected' }
      }
    })
    expect(await run(['web', 'link'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('http://127.0.0.1:7330/#t=abc [2J\n')
    expect(err).toBe('')
    out = ''
    expect(await run(['web', 'link', '--regenerate'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(err).toContain('signed out')
    out = ''
    err = ''
    expect(await run(['web', 'add-device'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('http://127.0.0.1:7330/#t=abc [2J\n')
    expect(err).toBe('ccc: works once, expires in 10 minutes\n')
    out = ''
    err = ''
    expect(await run(['web', 'mode', 'none'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('sign-in mode: none\n')
    expect(err).toBe(`ccc: warning: ${SERVER_NONE_WARNING}\n`)
    out = ''
    err = ''
    expect(await run(['web', 'set', '--bind', '0.0.0.0', '--port', '7400'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(1)
    expect(out).toBe('')
    expect(err).toBe(`ccc: ${confirmNeededText(['plain-http'])}\n`)
    expect(err).toContain('\n\nto do it anyway, run the same command with --confirm plain-http')
    err = ''
    expect(await run(['web', 'set', '--bind', '0.0.0.0', '--port', '7400', '--confirm', 'plain-http'], { CC_COCKPIT_SOCK: sock }, Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('saved\naddress: 0.0.0.0:7400\ngateway: not listening: port 7400 is in use\n')
  })
})
