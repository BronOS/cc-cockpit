// `ccc web` part 1 (server-mode plan Task 11, design-web.md §9.4): the host-only handlers of
// main/socket/web-handlers.ts called directly and over a real socket, the status that never carries
// a secret, the desktop's narrowing, the drift between the handlers and HOST_ONLY_COMMANDS, and the
// CLI side (the request each subcommand sends, what it prints, "not running" as exit 1).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildRequest, NOT_RUNNING, run, runCommand, type Output } from '../../src/cli/client'
import { formatWebStatus } from '../../src/cli/web-format'
import { fakeSecretStore, KEYFILE_PREFIX, unreadableCounts, type SecretStore } from '../../src/main/secrets/secret-store'
import { SocketServer, type Caller, type Handler } from '../../src/main/socket/socket-server'
import { DESKTOP_REFUSAL, registerWebHandlers, webHandlers, type WebHandlerDeps } from '../../src/main/socket/web-handlers'
import { connect } from '../../src/main/socket/transport'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAccessService, type GatewayLike } from '../../src/main/web/access-service'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import type { GatewayStatus } from '../../src/main/web/gateway'
import { PasswordHasher } from '../../src/main/web/password'
import { storedWebAccess } from '../../src/main/web/settings'
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
import type { WebCliStatus } from '../../src/shared/web-access'

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
  devices: []
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
    }
  }
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

  it('tokenless: status, revoke and stop answer; the five of Task 12 are unknown commands', async () => {
    const deps = await serve(true)
    expect(await ask({ cmd: 'web.status' })).toEqual({ id: 1, ok: true, result: STATUS })
    expect(await ask({ cmd: 'web.revoke', args: { id: 'dev-1' } })).toEqual({ id: 1, ok: true, result: { revoked: 1 } })
    expect(await ask({ cmd: 'web.stop' })).toEqual({ id: 1, ok: true, result: { stopping: true } })
    for (const cmd of ['web.link', 'web.add-device', 'web.password', 'web.mode', 'web.set']) {
      expect(await ask({ cmd }), cmd).toEqual({ id: 1, ok: false, error: `unknown command: ${cmd}` })
    }
    expect(deps.calls).toEqual(['status', 'revoke dev-1', 'stop'])
  })

  it('outside server mode only status and revoke are answered', async () => {
    const deps = await serve(false)
    expect(await ask({ cmd: 'web.status' })).toMatchObject({ ok: true })
    expect(await ask({ cmd: 'web.revoke', args: { all: true } })).toMatchObject({ ok: true, result: { revoked: 3 } })
    expect(await ask({ cmd: 'web.stop' })).toEqual({ id: 1, ok: false, error: DESKTOP_REFUSAL })
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
      devices: [expect.objectContaining({ id: signedIn.device.id, name: 'Phone', mode: 'link', connected: true })]
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
