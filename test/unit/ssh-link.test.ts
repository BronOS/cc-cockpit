// SshLink (src/main/remote/ssh-link.ts) against ssh2's own Server, in-process on a random loopback port
// with generated keys. Each test gets a temp home (its own ~/.ssh/config, known_hosts and key files) and
// an env with no SSH_AUTH_SOCK unless it starts a fake agent there: nothing reads the real ~/.ssh or
// talks to the person's agent. The link's own clock (redial backoff, idle stop) is a manual one; the
// sockets and ssh2's timers are real.
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProtocol, Server, utils, type AuthContext, type Connection, type ParsedKey } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint, keyBlobType } from '../../src/main/remote/known-hosts'
import { REMOTE_CCC_MISSING, type RemoteHostKey, type RemoteSecretName, type RemoteServerRecord, type SshAuth } from '../../src/shared/remote-servers'
import { dial, type DialOptions } from '../../src/main/remote/ssh-client'
import {
  AGENT_READY_TIMEOUT_MS,
  IDLE_STOP_MS,
  READY_TIMEOUT_MS,
  SshLink,
  agentSocketOf,
  type LinkState,
  type LinkTimers,
  type SshLinkOptions
} from '../../src/main/remote/ssh-link'

const USER = 'alice'
const PASSWORD = 'correct horse'
const ed25519Host = utils.generateKeyPairSync('ed25519')
const otherHost = utils.generateKeyPairSync('ed25519')
const ecdsaHost = utils.generateKeyPairSync('ecdsa', { bits: 256 })
const clientKey = utils.generateKeyPairSync('ed25519', { comment: 'test@client' })
const lockedKey = utils.generateKeyPairSync('ed25519', { passphrase: 'open sesame', cipher: 'aes256-ctr', rounds: 2 })
const lockedPublic = utils.parseKey(lockedKey.private, 'open sesame') as ParsedKey

/** The raw public blob of an OpenSSH public key line. */
function blobOf(publicLine: string): Buffer {
  return Buffer.from(publicLine.split(' ')[1] ?? '', 'base64')
}

function hostKeyOf(publicLine: string): RemoteHostKey {
  const blob = blobOf(publicLine)
  return { type: keyBlobType(blob) as string, sha256: fingerprint(blob) }
}

const HOST_KEY = hostKeyOf(ed25519Host.public)

// ---------------------------------------------------------------------------------------------
// Fixtures

interface TestServer {
  port: number
  attempts: string[]
  commands: string[]
  clients: Connection[]
  /** Client connections that closed. */
  closedClients: number
  /** The gateway port `web status` reports (changeable between calls). */
  gateway: number
  close(): Promise<void>
}

interface ServerOptions {
  port?: number
  hostKeys?: (string | Buffer)[]
  methods?: AuthContext['method'][]
  password?: string
  /** Keys `publickey` accepts (OpenSSH public lines). */
  publicKeys?: string[]
  kbdRounds?: { prompt: string; echo: boolean }[][]
  checkKbd?: (answers: string[][]) => boolean
  /** Off: no `tcpip` listener, so ssh2 refuses `direct-tcpip` as administratively prohibited (AllowTcpForwarding no). */
  forwarding?: boolean
  gateway: number
  /** Replaces the `ccc` answers. */
  onCommand?: (command: string) => { stdout: string; code: number }
}

const servers: TestServer[] = []
const netServers: (NetServer | HttpServer)[] = []
const links: SshLink[] = []
const tmp: string[] = []

afterEach(async () => {
  for (const l of links.splice(0)) l.dispose()
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const n of netServers.splice(0)) n.close()
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

function statusLine(gateway: number, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    server: true,
    version: '0.17.0',
    scheme: 'http',
    enabled: true,
    mode: 'link',
    gateway: { state: 'listening', port: gateway },
    ...over
  })
}

async function startServer(opts: ServerOptions): Promise<TestServer> {
  const methods = opts.methods ?? (['password', 'publickey'] as AuthContext['method'][])
  const password = opts.password ?? PASSWORD
  const allowed = (opts.publicKeys ?? [clientKey.public]).map((k) => utils.parseKey(k) as ParsedKey)
  const state: TestServer = { port: 0, attempts: [], commands: [], clients: [], closedClients: 0, gateway: opts.gateway, close: async () => {} }
  const server = new Server({ hostKeys: opts.hostKeys ?? [ed25519Host.private] }, (client) => {
    state.clients.push(client)
    client.on('error', () => {})
    client.on('close', () => {
      state.closedClients += 1
    })
    const kbdAnswers: string[][] = []
    client.on('authentication', (ctx) => {
      state.attempts.push(ctx.method)
      if (ctx.username !== USER || !methods.includes(ctx.method)) return ctx.reject(methods)
      if (ctx.method === 'password') {
        const ok = ctx.password.length === password.length && timingSafeEqual(Buffer.from(ctx.password), Buffer.from(password))
        return ok ? ctx.accept() : ctx.reject(methods)
      }
      if (ctx.method === 'publickey') {
        const key = allowed.find((k) => k.type === ctx.key.algo && k.getPublicSSH().equals(ctx.key.data))
        if (!key) return ctx.reject(methods)
        if (!ctx.signature || !ctx.blob) return ctx.accept()
        return key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(methods)
      }
      if (ctx.method === 'keyboard-interactive' && opts.kbdRounds) {
        const rounds = opts.kbdRounds
        const ask = (i: number): void => {
          const round = rounds[i]
          if (!round) return opts.checkKbd?.(kbdAnswers) ? ctx.accept() : ctx.reject(methods)
          ctx.prompt(round, (answers) => {
            kbdAnswers.push(answers)
            ask(i + 1)
          })
        }
        return ask(0)
      }
      ctx.reject(methods)
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          stream.resume()
          state.commands.push(info.command)
          let answer: { stdout: string; code: number }
          if (opts.onCommand) answer = opts.onCommand(info.command)
          else if (info.command.includes("'add-device'")) answer = { stdout: `http://127.0.0.1:${state.gateway}/#t=tok-123\n`, code: 0 }
          else answer = { stdout: `motd\n${statusLine(state.gateway)}\n`, code: 0 }
          stream.write(answer.stdout)
          stream.exit(answer.code)
          stream.end()
        })
      })
      if (opts.forwarding !== false) {
        client.on('tcpip', (accept, reject, info) => {
          if (info.destIP !== '127.0.0.1') return reject()
          const sock = netConnect(info.destPort, '127.0.0.1')
          sock.once('error', () => reject())
          sock.once('connect', () => {
            const channel = accept()
            channel.pipe(sock).pipe(channel)
            channel.on('close', () => sock.destroy())
          })
        })
      }
    })
  })
  await new Promise<void>((done) => server.listen(opts.port ?? 0, '127.0.0.1', done))
  state.port = (server.address() as AddressInfo).port
  state.close = () =>
    new Promise<void>((done) => {
      for (const c of state.clients) c.end()
      server.close(() => done())
    })
  servers.push(state)
  return state
}

/** A tiny HTTP server standing in for the cockpit gateway: answers its name. */
async function startGateway(name: string): Promise<number> {
  const http = createHttpServer((_req, res) => res.end(name))
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
  netServers.push(http)
  return (http.address() as AddressInfo).port
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => (body += d.toString()))
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A fake ssh-agent on a unix socket holding `key`. */
async function startAgent(dir: string, key = clientKey.private): Promise<string> {
  const path = join(dir, `agent-${Math.random().toString(16).slice(2)}.sock`)
  const parsed = utils.parseKey(key) as ParsedKey
  const srv = createNetServer((sock) => {
    sock.on('error', () => {})
    const proto = new AgentProtocol(false)
    sock.pipe(proto).pipe(sock)
    proto.on('identities', (req) => proto.getIdentitiesReply(req, [parsed]))
    proto.on('sign', (req, _pub, data) => proto.signReply(req, parsed.sign(data) as Buffer))
  })
  await new Promise<void>((done) => srv.listen(path, done))
  netServers.push(srv)
  return path
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'ssh-link-home-'))
  tmp.push(home)
  mkdirSync(join(home, '.ssh'))
  return home
}

/** The link's clock: nothing fires until a test says so. */
class ManualTimers implements LinkTimers {
  private t = 0
  private next = 1
  readonly tasks = new Map<number, { at: number; fn: () => void; ms: number }>()
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++
    this.tasks.set(id, { at: this.t + ms, fn, ms })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }
  now(): number {
    return this.t
  }
  /** Delays of the pending tasks. */
  pending(): number[] {
    return [...this.tasks.values()].map((t) => t.ms)
  }
  /** Moves the clock by `ms` and runs what is due. */
  advance(ms: number): void {
    this.t += ms
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.t) {
        this.tasks.delete(id)
        task.fn()
      }
    }
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

interface LinkSetup {
  link: SshLink
  record: RemoteServerRecord
  secrets: Partial<Record<RemoteSecretName, string>>
  dials: DialOptions[]
  timers: ManualTimers
  states: LinkState[]
  home: string
}

function makeLink(
  server: { port: number },
  over: {
    auth?: SshAuth
    host?: string
    port?: number | null
    user?: string | null
    hostKey?: RemoteHostKey | null
    secrets?: Partial<Record<RemoteSecretName, string>>
    env?: Record<string, string>
    home?: string
    localPort?: number
    options?: Partial<SshLinkOptions>
  } = {}
): LinkSetup {
  const home = over.home ?? tempHome()
  const record: RemoteServerRecord = {
    id: 'srv1',
    name: 'devbox',
    via: {
      kind: 'ssh',
      host: over.host ?? '127.0.0.1',
      ...(over.port === null ? {} : { port: over.port ?? server.port }),
      ...(over.user === null ? {} : { user: over.user ?? USER }),
      auth: over.auth ?? { kind: 'password' }
    },
    recent: [],
    ...(over.hostKey === null ? {} : { hostKey: over.hostKey ?? HOST_KEY }),
    ...(over.localPort === undefined ? {} : { localPort: over.localPort })
  }
  const secrets = { ...(over.secrets ?? {}) }
  const dials: DialOptions[] = []
  const timers = new ManualTimers()
  const states: LinkState[] = []
  const link = new SshLink({
    serverId: 'srv1',
    store: {
      get: (id) => (id === record.id ? record : undefined),
      getSecret: async (id, name) => (id === record.id ? secrets[name] : undefined)
    },
    home,
    env: () => over.env ?? {},
    localUser: () => 'nobody-local',
    dial: (o) => {
      dials.push(o)
      return dial(o)
    },
    timers,
    ...over.options
  })
  link.onState((s) => states.push(s))
  links.push(link)
  return { link, record, secrets, dials, timers, states, home }
}

// ---------------------------------------------------------------------------------------------

describe('sign-in', () => {
  it('password: asks when nothing is known, then signs in with the answer once and reports it as accepted', async () => {
    const s = await startServer({ gateway: 1 })
    const { link, secrets } = makeLink(s)
    expect(await link.status()).toEqual({ ok: false, need: { need: 'password' } })
    // Nothing went to the server but the method probe.
    expect(s.attempts).toEqual(['none'])
    const r = await link.status({ password: PASSWORD })
    expect(r).toEqual({ ok: true, value: { port: 1, mode: 'link', version: '0.17.0' }, accepted: { password: true } })
    expect(s.attempts).toEqual(['none', 'none', 'password'])
    // Nothing was saved by the link.
    expect(secrets).toEqual({})
  })

  it('password: a stored secret signs in with nothing accepted; readyTimeout is 10 s with no agent', async () => {
    const s = await startServer({ gateway: 1 })
    const { link, dials } = makeLink(s, { secrets: { password: PASSWORD } })
    const r = await link.status()
    expect(r.ok && r.accepted).toEqual({})
    expect(dials[0]?.readyTimeout).toBe(READY_TIMEOUT_MS)
    expect(dials[0]?.username).toBe(USER)
  })

  it('password: a wrong one asks again, sent once, never through keyboard-interactive too', async () => {
    const s = await startServer({ gateway: 1, methods: ['password', 'keyboard-interactive'] })
    const { link } = makeLink(s)
    expect(await link.status({ password: 'wrong' })).toEqual({ ok: false, need: { need: 'password', again: true } })
    expect(s.attempts).toEqual(['none', 'password'])
  })

  it('keyboard-interactive with one password prompt when password is not offered', async () => {
    const s = await startServer({
      gateway: 1,
      methods: ['keyboard-interactive'],
      kbdRounds: [[{ prompt: 'Password: ', echo: false }]],
      checkKbd: (a) => a[0]?.[0] === PASSWORD
    })
    const r = await makeLink(s).link.status({ password: PASSWORD })
    expect(r.ok).toBe(true)
    expect(s.attempts).toEqual(['none', 'keyboard-interactive'])
  })

  it('keyboard-interactive: a zero-prompt round after the password is answered with nothing', async () => {
    const s = await startServer({
      gateway: 1,
      methods: ['keyboard-interactive'],
      kbdRounds: [[{ prompt: 'Password: ', echo: false }], []],
      checkKbd: (a) => a[0]?.[0] === PASSWORD && a[1]?.length === 0
    })
    expect((await makeLink(s).link.status({ password: PASSWORD })).ok).toBe(true)
  })

  it('keyboard-interactive: the password prompt again means wrong, never resent', async () => {
    const answers: string[][] = []
    const s = await startServer({
      gateway: 1,
      methods: ['keyboard-interactive'],
      kbdRounds: [[{ prompt: 'Password: ', echo: false }], [{ prompt: 'Password: ', echo: false }]],
      checkKbd: (a) => {
        answers.push(...a)
        return false
      }
    })
    expect(await makeLink(s).link.status({ password: 'wrong' })).toEqual({ ok: false, need: { need: 'password', again: true } })
    // The second round was never answered: the dial ended there.
    expect(answers).toEqual([])
  })

  it('keyboard-interactive: any other prompt (a 2FA code) is an error naming it', async () => {
    const s = await startServer({
      gateway: 1,
      methods: ['keyboard-interactive'],
      kbdRounds: [[{ prompt: 'Password: ', echo: false }], [{ prompt: 'Verification code: ', echo: false }]],
      checkKbd: () => true
    })
    const r = await makeLink(s).link.status({ password: PASSWORD })
    expect(r.ok === false && 'error' in r && r.error).toBe('127.0.0.1 asks for more than a password ("Verification code:"): use My own tunnel.')
  })

  it('password: a server that takes no password says so', async () => {
    const s = await startServer({ gateway: 1, methods: ['publickey'] })
    const r = await makeLink(s).link.status({ password: PASSWORD })
    expect(r.ok === false && 'error' in r && r.error).toContain('does not take a password (it offers: publickey)')
  })

  it('key: an unencrypted key file signs in; a missing one is an error before any dial', async () => {
    const s = await startServer({ gateway: 1 })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'work'), clientKey.private, { mode: 0o600 })
    const { link } = makeLink(s, { home, auth: { kind: 'key', path: '~/.ssh/work' } })
    const r = await link.status()
    expect(r.ok && r.accepted).toEqual({})
    expect(s.attempts).toEqual(['none', 'publickey', 'publickey'])
    const missing = makeLink(s, { home, auth: { kind: 'key', path: '~/.ssh/nope' } })
    expect(await missing.link.status()).toEqual({ ok: false, error: 'The key file ~/.ssh/nope does not exist.' })
    expect(missing.dials).toHaveLength(0)
  })

  it('key: a locked key asks for its passphrase, a wrong one asks again, the right one is accepted', async () => {
    const s = await startServer({ gateway: 1, publicKeys: [`${lockedPublic.type} ${lockedPublic.getPublicSSH().toString('base64')}`] })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'locked'), lockedKey.private, { mode: 0o600 })
    const { link, dials } = makeLink(s, { home, auth: { kind: 'key', path: '~/.ssh/locked' } })
    expect(await link.status()).toEqual({ ok: false, need: { need: 'passphrase', path: '~/.ssh/locked' } })
    expect(await link.status({ passphrase: 'nope' })).toEqual({ ok: false, need: { need: 'passphrase', path: '~/.ssh/locked', again: true } })
    // Neither needed a dial: the key is parsed first.
    expect(dials).toHaveLength(0)
    const r = await link.status({ passphrase: 'open sesame' })
    expect(r.ok && r.accepted).toEqual({ passphrase: true })
  })

  it('key: not a private key is said so', async () => {
    const s = await startServer({ gateway: 1 })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'pub'), clientKey.public)
    const r = await makeLink(s, { home, auth: { kind: 'key', path: '~/.ssh/pub' } }).link.status()
    expect(r.ok === false && 'error' in r && r.error).toContain('is not a private key this app can read')
  })

  it('auto: the agent from the login env, with the 30 s timeout', async () => {
    const s = await startServer({ gateway: 1, methods: ['publickey'] })
    const home = tempHome()
    const sock = await startAgent(home)
    const { link, dials } = makeLink(s, { home, auth: { kind: 'auto' }, env: { SSH_AUTH_SOCK: sock } })
    const r = await link.status()
    expect(r.ok).toBe(true)
    expect(dials[0]?.readyTimeout).toBe(AGENT_READY_TIMEOUT_MS)
  })

  it('auto: IdentityAgent in ~/.ssh/config wins over SSH_AUTH_SOCK', async () => {
    const s = await startServer({ gateway: 1, methods: ['publickey'] })
    const home = tempHome()
    const sock = await startAgent(home)
    writeFileSync(join(home, '.ssh', 'config'), `Host devbox\n  HostName 127.0.0.1\n  Port ${s.port}\n  User ${USER}\n  IdentityAgent ${sock}\n`)
    const { link } = makeLink(s, { home, host: 'devbox', port: null, user: null, auth: { kind: 'auto' }, env: { SSH_AUTH_SOCK: join(home, 'nothing.sock') } })
    expect((await link.status()).ok).toBe(true)
  })

  it('auto: a default key file after the agent; a locked key is skipped and named', async () => {
    const s = await startServer({ gateway: 1, methods: ['publickey'] })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'id_ed25519'), lockedKey.private, { mode: 0o600 })
    const { link } = makeLink(s, { home, auth: { kind: 'auto' } })
    const r = await link.status()
    expect(r.ok === false && 'error' in r && r.error).toBe(
      'No SSH agent and no usable key in ~/.ssh to sign in to 127.0.0.1 with: choose Password or Key file. ~/.ssh/id_ed25519 needs a passphrase: choose Key file.'
    )
    writeFileSync(join(home, '.ssh', 'id_ecdsa'), clientKey.private, { mode: 0o600 })
    expect((await link.status()).ok).toBe(true)
  })

  it('auto: an agent that cannot be reached and no key say both', async () => {
    const s = await startServer({ gateway: 1, methods: ['publickey'] })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'id_rsa'), utils.generateKeyPairSync('ed25519').private, { mode: 0o600 })
    const r = await makeLink(s, { home, auth: { kind: 'auto' }, env: { SSH_AUTH_SOCK: join(home, 'gone.sock') } }).link.status()
    expect(r.ok === false && 'error' in r && r.error).toMatch(/^127\.0\.0\.1 accepted none of your keys\. the SSH agent could not be used/)
  })

  it('agentSocketOf: none, an env name, a path, else SSH_AUTH_SOCK; empty is none', () => {
    const env = { SSH_AUTH_SOCK: '/a', OTHER: '/b', EMPTY: '' }
    expect(agentSocketOf(undefined, env)).toBe('/a')
    expect(agentSocketOf({ kind: 'none' }, env)).toBeUndefined()
    expect(agentSocketOf({ kind: 'env', name: 'OTHER' }, env)).toBe('/b')
    expect(agentSocketOf({ kind: 'env', name: 'EMPTY' }, env)).toBeUndefined()
    expect(agentSocketOf({ kind: 'path', path: '/c' }, env)).toBe('/c')
    expect(agentSocketOf(undefined, {})).toBeUndefined()
  })

  it('refuses a host the config sends through a jump host, without dialling', async () => {
    const s = await startServer({ gateway: 1 })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'config'), 'Host devbox\n  ProxyJump bastion\n')
    const { link, dials } = makeLink(s, { home, host: 'devbox' })
    expect(await link.status({ password: PASSWORD })).toEqual({
      ok: false,
      error: 'This host goes through a jump host (ProxyJump or ProxyCommand in ~/.ssh/config): use My own tunnel.'
    })
    expect(dials).toHaveLength(0)
  })
})

describe('host keys', () => {
  it('first use asks with the fingerprint; only an answer equal to the key seen lets it through', async () => {
    const s = await startServer({ gateway: 1 })
    const { link } = makeLink(s, { hostKey: null })
    const need = { ok: false, need: { need: 'hostKey', type: 'ssh-ed25519', sha256: HOST_KEY.sha256, address: `127.0.0.1:${s.port}` } }
    expect(await link.status({ password: PASSWORD })).toEqual(need)
    expect(s.attempts).toEqual([])
    expect(await link.status({ password: PASSWORD, hostKey: hostKeyOf(otherHost.public).sha256 })).toEqual(need)
    const r = await link.status({ password: PASSWORD, hostKey: HOST_KEY.sha256 })
    expect(r.ok && r.accepted).toEqual({ hostKey: HOST_KEY, password: true })
  })

  it('the host key is asked before the password', async () => {
    const s = await startServer({ gateway: 1 })
    const { link } = makeLink(s, { hostKey: null })
    expect(await link.status()).toMatchObject({ ok: false, need: { need: 'hostKey' } })
    expect(await link.status({ hostKey: HOST_KEY.sha256 })).toEqual({ ok: false, need: { need: 'password' } })
  })

  it('known_hosts vouches by the resolved HostName and [host]:port: no question, reported as accepted', async () => {
    const s = await startServer({ gateway: 1, hostKeys: [ecdsaHost.private, ed25519Host.private] })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'config'), `Host devbox\n  HostName 127.0.0.1\n  Port ${s.port}\n`)
    writeFileSync(join(home, '.ssh', 'known_hosts'), `[127.0.0.1]:${s.port} ${ecdsaHost.public}\n`)
    const { link, dials } = makeLink(s, { home, host: 'devbox', port: null, hostKey: null })
    const r = await link.status({ password: PASSWORD })
    const ecdsa = hostKeyOf(ecdsaHost.public)
    expect(r.ok && r.accepted).toEqual({ hostKey: ecdsa, password: true })
    // The known type was offered first, so the server showed the key the file vouches for.
    expect(dials[0]?.preferredHostKeyTypes).toEqual(['ecdsa-sha2-nistp256'])
  })

  it('a known_hosts line with another key refuses, even with an answer equal to the key seen', async () => {
    const s = await startServer({ gateway: 1 })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'known_hosts'), `[127.0.0.1]:${s.port} ${otherHost.public}\n`)
    const r = await makeLink(s, { home, hostKey: null }).link.status({ password: PASSWORD, hostKey: HOST_KEY.sha256 })
    expect(r.ok === false && 'error' in r && r.error).toContain('does not match the one in ~/.ssh/known_hosts')
    expect(s.attempts).toEqual([])
  })

  it('a @revoked key refuses whatever the record says', async () => {
    const s = await startServer({ gateway: 1 })
    const home = tempHome()
    writeFileSync(join(home, '.ssh', 'known_hosts'), `@revoked * ${ed25519Host.public}\n`)
    const r = await makeLink(s, { home }).link.status({ password: PASSWORD })
    expect(r.ok === false && 'error' in r && r.error).toContain('marked @revoked')
  })

  it("the record's key decides alone: a match goes on with nothing accepted, a change refuses even an equal answer", async () => {
    const s = await startServer({ gateway: 1 })
    const same = makeLink(s)
    const r = await same.link.status({ password: PASSWORD })
    expect(r.ok && r.accepted).toEqual({ password: true })
    expect(same.dials[0]?.preferredHostKeyTypes).toEqual(['ssh-ed25519'])
    const changed = makeLink(s, { hostKey: hostKeyOf(otherHost.public) })
    expect(await changed.link.status({ password: PASSWORD, hostKey: HOST_KEY.sha256 })).toEqual({
      ok: false,
      error: 'The host key of 127.0.0.1 changed. If the server was reinstalled, Forget the trusted key in Edit.'
    })
  })

  it('stops reporting a host key once the record holds it', async () => {
    const s = await startServer({ gateway: 1 })
    const setup = makeLink(s, { hostKey: null })
    const r = await setup.link.status({ password: PASSWORD, hostKey: HOST_KEY.sha256 })
    expect(r.ok && r.accepted.hostKey).toEqual(HOST_KEY)
    setup.record.hostKey = HOST_KEY
    const again = await setup.link.addDevice()
    expect(again).toEqual({ ok: true, value: 'tok-123', accepted: { password: true } })
  })
})

describe('commands', () => {
  it('status and addDevice run the quoted ccc commands over one connection', async () => {
    const s = await startServer({ gateway: 4242 })
    const { link, dials } = makeLink(s, { secrets: { password: PASSWORD } })
    expect(await link.status()).toMatchObject({ ok: true, value: { port: 4242, mode: 'link' } })
    expect(await link.addDevice()).toMatchObject({ ok: true, value: 'tok-123' })
    expect(dials).toHaveLength(1)
    expect(s.commands).toHaveLength(2)
    expect(s.commands[0]).toContain("'web' 'status' '--json'")
    expect(s.commands[1]).toContain("'web' 'add-device'")
  })

  it('parse failures come back as errors: ccc missing, https, not server mode', async () => {
    const answers = [
      { stdout: `${REMOTE_CCC_MISSING}\n`, code: 127 },
      { stdout: statusLine(1, { scheme: 'https' }), code: 0 },
      { stdout: statusLine(1, { server: false }), code: 0 }
    ]
    const s = await startServer({ gateway: 1, onCommand: () => answers.shift() ?? { stdout: '', code: 0 } })
    const { link } = makeLink(s, { secrets: { password: PASSWORD } })
    const texts: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await link.status()
      texts.push(r.ok === false && 'error' in r ? r.error : 'ok')
    }
    expect(texts[0]).toContain("cc-cockpit's ccc was not found on 127.0.0.1")
    expect(texts[1]).toContain('serves https')
    expect(texts[2]).toContain('is not a cc-cockpit server in server mode')
    expect(texts[3]).toBe('cc-cockpit is not installed on 127.0.0.1, or the server is not running.')
  })

  it('a refused connection is a plain line', async () => {
    const s = await startServer({ gateway: 1 })
    const port = s.port
    await s.close()
    servers.splice(servers.indexOf(s), 1)
    const r = await makeLink({ port }, { secrets: { password: PASSWORD } }).link.status()
    expect(r).toEqual({ ok: false, error: 'Could not reach 127.0.0.1: the connection was refused.' })
  })
})

describe('the tunnel', () => {
  it('acquire opens the listener on the saved port when free and pipes pages to the gateway', async () => {
    const gateway = await startGateway('gateway A')
    const s = await startServer({ gateway })
    const free = await startGateway('placeholder')
    // A port that was free a moment ago: close the placeholder and offer its port as the saved one.
    netServers.pop()?.close()
    await new Promise((r) => setTimeout(r, 20))
    const { link, states } = makeLink(s, { secrets: { password: PASSWORD }, localPort: free })
    const r = await link.acquire()
    expect(r).toEqual({ ok: true, value: free, accepted: {} })
    expect(link.port).toBe(free)
    expect(await get(free)).toBe('gateway A')
    expect(states.at(-1)).toEqual({ state: 'up', localPort: free })
  })

  it('a taken saved port falls back to a fresh one, reported', async () => {
    const gateway = await startGateway('gateway A')
    const taken = await startGateway('someone else')
    const s = await startServer({ gateway })
    const { link } = makeLink(s, { secrets: { password: PASSWORD }, localPort: taken })
    const r = await link.acquire()
    expect(r.ok && r.value).not.toBe(taken)
    expect(await get(link.port as number)).toBe('gateway A')
  })

  it('refuses a server with TCP forwarding disabled before any window loads', async () => {
    const gateway = await startGateway('gateway A')
    const s = await startServer({ gateway, forwarding: false })
    const { link } = makeLink(s, { secrets: { password: PASSWORD } })
    expect(await link.acquire()).toEqual({ ok: false, error: 'TCP forwarding is disabled on 127.0.0.1 (AllowTcpForwarding in its sshd_config).' })
  })

  it('redials with the listener kept, follows the new gateway port, and closes sockets while down', async () => {
    const gatewayA = await startGateway('gateway A')
    const gatewayB = await startGateway('gateway B')
    const s1 = await startServer({ gateway: gatewayA })
    const { link, timers, dials } = makeLink(s1, { secrets: { password: PASSWORD } })
    const r = await link.acquire()
    const port = r.ok ? r.value : 0
    expect(await get(port)).toBe('gateway A')

    await s1.close()
    servers.splice(servers.indexOf(s1), 1)
    await until(() => link.state.state === 'down')
    expect(link.state).toMatchObject({ state: 'down', retryInMs: 1000 })
    expect(link.port).toBe(port)
    // While down, a page's connection is closed at once.
    await expect(get(port)).rejects.toThrow()

    // The server comes back on the same SSH port, its gateway on another port.
    await startServer({ port: s1.port, gateway: gatewayB })
    timers.advance(1000)
    await until(() => link.state.state === 'up')
    expect(dials).toHaveLength(2)
    expect(link.port).toBe(port)
    expect(link.state).toEqual({ state: 'up', localPort: port })
    expect(await get(port)).toBe('gateway B')
  })

  it('follows a gateway that moved while SSH stayed up: a refused page channel re-runs web status, at most every 5 s', async () => {
    const gatewayA = await startGateway('gateway A')
    const httpA = netServers.at(-1) as HttpServer
    const s = await startServer({ gateway: gatewayA })
    const { link, timers, dials } = makeLink(s, { secrets: { password: PASSWORD } })
    const r = await link.acquire()
    const port = r.ok ? r.value : 0
    expect(await get(port)).toBe('gateway A')
    const statusRuns = (): number => s.commands.filter((c) => c.includes("'web' 'status'")).length
    expect(statusRuns()).toBe(1)

    // The server's cockpit restarts on another gateway port; the SSH connection stays up.
    httpA.closeAllConnections()
    httpA.close()
    const gatewayB = await startGateway('gateway B')
    const httpB = netServers.at(-1) as HttpServer
    s.gateway = gatewayB
    // The refused channel re-runs `web status` and the same page request is retried on the new port.
    expect(await get(port)).toBe('gateway B')
    expect(statusRuns()).toBe(2)
    expect(dials).toHaveLength(1)
    expect(link.state).toEqual({ state: 'up', localPort: port })

    // Again within 5 s: no second `web status` (a page retrying in a loop is not a command stream).
    httpB.closeAllConnections()
    httpB.close()
    const gatewayC = await startGateway('gateway C')
    s.gateway = gatewayC
    await expect(get(port)).rejects.toThrow()
    expect(statusRuns()).toBe(2)
    timers.advance(5000)
    expect(await get(port)).toBe('gateway C')
    expect(statusRuns()).toBe(3)
  })

  it('backs off 1, 2, 4 s while the server stays away', async () => {
    const gateway = await startGateway('gateway A')
    const s = await startServer({ gateway })
    const { link, timers } = makeLink(s, { secrets: { password: PASSWORD } })
    await link.acquire()
    await s.close()
    servers.splice(servers.indexOf(s), 1)
    await until(() => link.state.state === 'down')
    expect(timers.pending()).toEqual([1000])
    timers.advance(1000)
    await until(() => timers.pending().includes(2000))
    expect(link.state).toMatchObject({ state: 'down', retryInMs: 2000, error: 'Could not reach 127.0.0.1: the connection was refused.' })
    timers.advance(2000)
    await until(() => timers.pending().includes(4000))
  })

  it('a redial refused at sign-in stops and says why, with no retry', async () => {
    const gateway = await startGateway('gateway A')
    const s1 = await startServer({ gateway })
    const { link, timers } = makeLink(s1, { secrets: { password: PASSWORD } })
    await link.acquire()
    await s1.close()
    servers.splice(servers.indexOf(s1), 1)
    await until(() => link.state.state === 'down')
    await startServer({ port: s1.port, gateway, password: 'changed on the server' })
    timers.advance(1000)
    await until(() => link.state.state === 'down' && !('retryInMs' in link.state))
    expect(link.state).toEqual({ state: 'down', error: '127.0.0.1 needs the password again: open the server from the picker.' })
    expect(timers.pending()).toEqual([])
  })

  it('a redial meeting a changed host key stops too', async () => {
    const gateway = await startGateway('gateway A')
    const s1 = await startServer({ gateway })
    const { link, timers } = makeLink(s1, { secrets: { password: PASSWORD } })
    await link.acquire()
    await s1.close()
    servers.splice(servers.indexOf(s1), 1)
    await until(() => link.state.state === 'down')
    await startServer({ port: s1.port, gateway, hostKeys: [otherHost.private] })
    timers.advance(1000)
    await until(() => link.state.state === 'down' && !('retryInMs' in link.state))
    expect(link.state).toMatchObject({ state: 'down', error: expect.stringContaining('The host key of 127.0.0.1 changed') })
  })

  it('release keeps the link 30 s; acquire in between cancels the stop; then connection and listener go', async () => {
    const gateway = await startGateway('gateway A')
    const s = await startServer({ gateway })
    const { link, timers } = makeLink(s, { secrets: { password: PASSWORD } })
    const r = await link.acquire()
    const port = r.ok ? r.value : 0
    expect(timers.pending()).toEqual([])
    link.release()
    expect(timers.pending()).toEqual([IDLE_STOP_MS])
    timers.advance(IDLE_STOP_MS - 1)
    expect((await link.acquire()).ok).toBe(true)
    expect(timers.pending()).toEqual([])
    link.release()
    link.release()
    timers.advance(IDLE_STOP_MS)
    expect(link.state).toEqual({ state: 'stopped' })
    expect(link.port).toBeUndefined()
    await until(() => s.closedClients === s.clients.length)
    await expect(get(port)).rejects.toThrow()
  })

  it('commands alone end the connection 30 s after the last one', async () => {
    const s = await startServer({ gateway: 1 })
    const { link, timers, dials } = makeLink(s, { secrets: { password: PASSWORD } })
    await link.status()
    expect(timers.pending()).toEqual([IDLE_STOP_MS])
    timers.advance(IDLE_STOP_MS)
    expect(link.state).toEqual({ state: 'stopped' })
    await link.status()
    expect(dials).toHaveLength(2)
  })

  it('a failed acquire counts no user', async () => {
    const gateway = await startGateway('gateway A')
    const s = await startServer({ gateway, forwarding: false })
    const { link, timers } = makeLink(s, { secrets: { password: PASSWORD } })
    expect((await link.acquire()).ok).toBe(false)
    expect(timers.pending()).toEqual([IDLE_STOP_MS])
  })

  it('dispose ends connection and listener at once; later calls fail', async () => {
    const gateway = await startGateway('gateway A')
    const s = await startServer({ gateway })
    const { link, timers } = makeLink(s, { secrets: { password: PASSWORD } })
    const r = await link.acquire()
    const port = r.ok ? r.value : 0
    link.dispose()
    expect(link.state).toEqual({ state: 'stopped' })
    expect(timers.pending()).toEqual([])
    await expect(get(port)).rejects.toThrow()
    expect(await link.status()).toEqual({ ok: false, error: 'the connection to 127.0.0.1 was closed' })
    expect(await link.acquire()).toEqual({ ok: false, error: 'the connection to 127.0.0.1 was closed' })
  })
})
