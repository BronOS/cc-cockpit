// The ssh2 adapter (src/main/remote/ssh-client.ts) against ssh2's own Server, in-process on a random
// loopback port with generated keys. Nothing here reads ~/.ssh or talks to the person's agent: every
// key is generated, and the one agent path used is a socket that does not exist in a temp dir.
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect as netConnect, createServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { Server, utils, type AuthContext, type Connection, type ServerChannel, type ServerConfig } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dial,
  hostKeyAlgorithmOps,
  parseKey,
  type DialOptions,
  type SshAuthMethod,
  type SshConnection,
  type SshError
} from '../../src/main/remote/ssh-client'

const USER = 'alice'
const PASSWORD = 'correct horse'
const ed25519Host = utils.generateKeyPairSync('ed25519')
const ecdsaHost = utils.generateKeyPairSync('ecdsa', { bits: 256 })
const clientKey = utils.generateKeyPairSync('ed25519', { comment: 'test@client' })

/** The raw public key blob (what a host verifier gets) of an OpenSSH public key line. */
function blobOf(publicLine: string): Buffer {
  return Buffer.from(publicLine.split(' ')[1] ?? '', 'base64')
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('base64')
}

type ExecHandler = (command: string, stream: ServerChannel) => void

interface TestServer {
  port: number
  /** Every client connection's negotiated algorithms, in order. */
  handshakes: { serverHostKey: string; cs: { cipher: string } }[]
  /** Every auth attempt the server saw: method name, per connection. */
  attempts: string[]
  /** Server-side exec channels that closed (the client closed them or the command ended). */
  closedChannels: number
  clients: Connection[]
  close(): Promise<void>
}

interface ServerOptions {
  hostKeys?: ServerConfig['hostKeys']
  algorithms?: ServerConfig['algorithms']
  /** Methods the server advertises after a failed attempt. */
  methods?: string[]
  onExec?: ExecHandler
  /** keyboard-interactive: the prompts each round asks, in order; answers are checked by `checkKbd`. */
  kbdRounds?: { prompt: string; echo: boolean }[][]
  checkKbd?: (answers: string[][]) => boolean
}

const servers: TestServer[] = []
const netServers: NetServer[] = []
const streams: Duplex[] = []
const conns: SshConnection[] = []
const tmp: string[] = []

afterEach(async () => {
  for (const c of conns.splice(0)) c.end()
  for (const d of streams.splice(0)) d.destroy()
  for (const n of netServers.splice(0)) n.close()
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function startServer(opts: ServerOptions = {}): Promise<TestServer> {
  const methods = (opts.methods ?? ['password', 'publickey']) as AuthContext['method'][]
  const state: TestServer = {
    port: 0,
    handshakes: [],
    attempts: [],
    closedChannels: 0,
    clients: [],
    close: async () => {}
  }
  const server = new Server({ hostKeys: opts.hostKeys ?? [ed25519Host.private], algorithms: opts.algorithms }, (client) => {
    state.clients.push(client)
    client.on('handshake', (n) => state.handshakes.push(n as unknown as TestServer['handshakes'][number]))
    client.on('error', () => {})
    const kbdAnswers: string[][] = []
    client.on('authentication', (ctx) => {
      state.attempts.push(ctx.method)
      if (ctx.username !== USER) return ctx.reject(methods)
      if (ctx.method === 'password') {
        const ok = ctx.password.length === PASSWORD.length && timingSafeEqual(Buffer.from(ctx.password), Buffer.from(PASSWORD))
        return ok ? ctx.accept() : ctx.reject(methods)
      }
      if (ctx.method === 'publickey') {
        const allowed = utils.parseKey(clientKey.public)
        if (allowed instanceof Error || Array.isArray(allowed)) return ctx.reject(methods)
        if (ctx.key.algo !== allowed.type || !allowed.getPublicSSH().equals(ctx.key.data)) return ctx.reject(methods)
        // The first round asks whether the key would do; the second carries the signature.
        if (!ctx.signature || !ctx.blob) return ctx.accept()
        return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(methods)
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
          // ssh2 emits a server channel's close only after its readable side ended: keep it flowing.
          stream.resume()
          stream.on('close', () => {
            state.closedChannels += 1
          })
          if (opts.onExec) opts.onExec(info.command, stream)
          else {
            stream.write(`ran: ${info.command}\n`)
            stream.stderr.write('a warning\n')
            stream.exit(3)
            stream.end()
          }
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== '127.0.0.1') return reject()
        // As sshd does: the channel opens only once the server's own connect succeeded.
        const sock = netConnect(info.destPort, '127.0.0.1')
        sock.once('error', () => reject())
        sock.once('connect', () => {
          const channel = accept()
          channel.pipe(sock).pipe(channel)
          channel.on('close', () => sock.destroy())
        })
      })
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  state.port = (server.address() as AddressInfo).port
  state.close = () =>
    new Promise<void>((done) => {
      for (const c of state.clients) c.end()
      server.close(() => done())
    })
  servers.push(state)
  return state
}

/** A password sign-in as §5.1 does it: `none` first to learn the methods, then the password once. */
function passwordAuth(password = PASSWORD): DialOptions['authHandler'] {
  let sent = false
  return (left) => {
    if (left === null) return { type: 'none' }
    if (!sent && left.includes('password')) {
      sent = true
      return { type: 'password', password }
    }
    return false
  }
}

function options(port: number, over: Partial<DialOptions> = {}): DialOptions {
  return {
    host: '127.0.0.1',
    port,
    username: USER,
    authHandler: passwordAuth(),
    hostVerifier: () => true,
    readyTimeout: 5000,
    ...over
  }
}

async function connect(opts: DialOptions): Promise<SshConnection> {
  const c = await dial(opts)
  conns.push(c)
  return c
}

async function rejection(p: Promise<unknown>): Promise<SshError> {
  try {
    const value = await p
    if (value && typeof (value as SshConnection).end === 'function') (value as SshConnection).end()
  } catch (err) {
    return err as SshError
  }
  throw new Error('expected a rejection')
}

describe('dial', () => {
  it('signs in with a password and hands the verifier the raw host key blob', async () => {
    const s = await startServer()
    const seen: Buffer[] = []
    const lefts: (string[] | null)[] = []
    let sent = false
    const c = await connect(
      options(s.port, {
        hostVerifier: (key) => {
          seen.push(key)
          return true
        },
        authHandler: (left) => {
          lefts.push(left)
          if (left === null) return { type: 'none' }
          if (!sent) {
            sent = true
            return { type: 'password', password: PASSWORD }
          }
          return false
        }
      })
    )
    expect(seen).toHaveLength(1)
    expect(sha256(seen[0] as Buffer)).toBe(sha256(blobOf(ed25519Host.public)))
    // First call knows nothing; the second has what the server offered after `none`.
    expect(lefts[0]).toBeNull()
    expect(lefts[1]).toEqual(expect.arrayContaining(['password', 'publickey']))
    expect(s.attempts).toEqual(['none', 'password'])
    expect(s.handshakes[0]?.serverHostKey).toBe('ssh-ed25519')
    c.end()
  })

  it('accepts an async verifier and refuses when it says no, marking the error', async () => {
    const s = await startServer()
    await connect(options(s.port, { hostVerifier: async () => true }))
    const e = await rejection(dial(options(s.port, { hostVerifier: async () => false })))
    expect(e.level).toBe('handshake')
    expect(e.hostKeyRefused).toBe(true)
    // A throwing verifier refuses too, never accepts.
    const thrown = await rejection(
      dial(
        options(s.port, {
          hostVerifier: () => {
            throw new Error('boom')
          }
        })
      )
    )
    expect(thrown.hostKeyRefused).toBe(true)
  })

  it('a wrong password is a client-authentication error, and the password is sent once', async () => {
    const s = await startServer()
    const e = await rejection(dial(options(s.port, { authHandler: passwordAuth('wrong') })))
    expect(e.level).toBe('client-authentication')
    expect(e.message).not.toContain('wrong')
    expect(s.attempts.filter((a) => a === 'password')).toHaveLength(1)
  })

  it('signs in with a key parsed by parseKey', async () => {
    const s = await startServer()
    const parsed = parseKey(clientKey.private)
    if (parsed.kind !== 'ok') throw new Error(parsed.kind)
    expect(parsed.key.type).toBe('ssh-ed25519')
    const c = await connect(
      options(s.port, {
        authHandler: (left) => (left === null ? { type: 'none' } : left.includes('publickey') ? { type: 'publickey', key: parsed.key } : false)
      })
    )
    expect(s.attempts).toContain('publickey')
    c.end()
  })

  it('an unreachable agent does not end the dial: the next method runs and the agent error is kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ssh-client-agent-'))
    tmp.push(dir)
    const s = await startServer()
    const steps: SshAuthMethod[] = [{ type: 'agent', agent: join(dir, 'no-agent.sock') }, { type: 'password', password: PASSWORD }]
    const c = await connect(options(s.port, { authHandler: (left) => (left === null ? { type: 'none' } : (steps.shift() ?? false)) }))
    expect(s.attempts).toEqual(['none', 'password'])
    c.end()
    // When nothing else signs in, the agent's failure travels with the sign-in error.
    const only: SshAuthMethod[] = [{ type: 'agent', agent: join(dir, 'no-agent.sock') }]
    const e = await rejection(dial(options(s.port, { authHandler: (left) => (left === null ? { type: 'none' } : (only.shift() ?? false)) })))
    expect(e.level).toBe('client-authentication')
    expect(e.agentError).toBeTruthy()
  })

  it('keyboard-interactive: a round gets the prompts, answers go back, `fail` ends the dial with its text', async () => {
    const s = await startServer({
      methods: ['keyboard-interactive'],
      kbdRounds: [[{ prompt: 'Password: ', echo: false }], []],
      checkKbd: (answers) => answers[0]?.[0] === PASSWORD && answers[1]?.length === 0
    })
    const rounds: { prompt: string; echo: boolean }[][] = []
    const kbd = (onRound: (prompts: { prompt: string; echo: boolean }[]) => string[] | { fail: string }): DialOptions['authHandler'] => {
      let sent = false
      return (left) => {
        if (left === null) return { type: 'none' }
        if (sent || !left.includes('keyboard-interactive')) return false
        sent = true
        return {
          type: 'keyboard-interactive',
          onRound: (round) => {
            rounds.push(round.prompts)
            return onRound(round.prompts)
          }
        }
      }
    }
    const c = await connect(options(s.port, { authHandler: kbd(() => [PASSWORD]) }))
    // The second round (no prompts, PAM's usual follow-up) is answered by ssh2 itself.
    expect(rounds).toEqual([[{ prompt: 'Password: ', echo: false }]])
    c.end()
    const e = await rejection(dial(options(s.port, { authHandler: kbd(() => ({ fail: 'this server asks for more than a password' })) })))
    expect(e.level).toBe('client-authentication')
    expect(e.message).toBe('this server asks for more than a password')
  })

  it('a handler that throws ends the dial', async () => {
    const s = await startServer()
    const e = await rejection(
      dial(
        options(s.port, {
          authHandler: () => {
            throw new Error('no secret in memory')
          }
        })
      )
    )
    expect(e.level).toBe('auth-handler')
    expect(e.message).toBe('no secret in memory')
  })

  it('times out on a server that never speaks, and reports a refused port as a socket error', async () => {
    const silent = createServer(() => {})
    netServers.push(silent)
    await new Promise<void>((done) => silent.listen(0, '127.0.0.1', done))
    const port = (silent.address() as AddressInfo).port
    const e = await rejection(dial(options(port, { readyTimeout: 300 })))
    expect(e.level).toBe('client-timeout')

    const gone = createServer()
    await new Promise<void>((done) => gone.listen(0, '127.0.0.1', done))
    const freePort = (gone.address() as AddressInfo).port
    await new Promise<void>((done) => gone.close(() => done()))
    const refused = await rejection(dial(options(freePort)))
    expect(refused.level).toBe('client-socket')
  })

  it('refuses a server whose only host key algorithm is ssh-rsa (SHA-1)', async () => {
    const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 })
    const s = await startServer({ hostKeys: [rsa.private], algorithms: { serverHostKey: ['ssh-rsa'] } })
    let verified = false
    const e = await rejection(
      dial(
        options(s.port, {
          hostVerifier: () => {
            verified = true
            return true
          }
        })
      )
    )
    expect(e.level).toBe('handshake')
    expect(verified).toBe(false)
    // The same RSA key with SHA-2 signatures is fine.
    const ok = await startServer({ hostKeys: [rsa.private] })
    const c = await connect(options(ok.port))
    expect(ok.handshakes[0]?.serverHostKey).toBe('rsa-sha2-512')
    c.end()
  }, 20_000)

  it('offers the preferred host key types first, so the known key is the one compared', async () => {
    const s = await startServer({ hostKeys: [ed25519Host.private, ecdsaHost.private] })
    const seen: Buffer[] = []
    const verifier = (key: Buffer): boolean => {
      seen.push(key)
      return true
    }
    ;(await connect(options(s.port, { hostVerifier: verifier }))).end()
    ;(await connect(options(s.port, { hostVerifier: verifier, preferredHostKeyTypes: ['ecdsa-sha2-nistp256'] }))).end()
    expect(sha256(seen[0] as Buffer)).toBe(sha256(blobOf(ed25519Host.public)))
    expect(sha256(seen[1] as Buffer)).toBe(sha256(blobOf(ecdsaHost.public)))
    expect(s.handshakes.map((h) => h.serverHostKey)).toEqual(['ssh-ed25519', 'ecdsa-sha2-nistp256'])
  })

  it('reports the close, with the error when one ended it', async () => {
    const s = await startServer()
    const c = await dial(options(s.port))
    const closed = new Promise<SshError | undefined>((done) => c.onClose(done))
    for (const client of s.clients) client.end()
    expect(await closed).toBeUndefined()
    // After the close: a late listener still hears it, and end() is a no-op.
    expect(await new Promise((done) => c.onClose(() => done('late')))).toBe('late')
    c.end()
    // Unsubscribing keeps a listener from being called.
    const c2 = await dial(options(s.port))
    let called = false
    c2.onClose(() => {
      called = true
    })()
    const heard = new Promise<void>((done) => c2.onClose(() => done()))
    c2.end()
    await heard
    expect(called).toBe(false)
  })
})

describe('hostKeyAlgorithmOps', () => {
  it('always drops ssh-rsa; an RSA known type stands for the SHA-2 algorithms; unknown types are ignored', () => {
    expect(hostKeyAlgorithmOps()).toEqual({ remove: ['ssh-rsa'], prepend: [] })
    expect(hostKeyAlgorithmOps(['ssh-rsa', 'ssh-dss', 'sk-ssh-ed25519@openssh.com', 'ssh-ed25519', 'ssh-ed25519'])).toEqual({
      remove: ['ssh-rsa', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-ed25519'],
      prepend: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-ed25519']
    })
  })
})

describe('SshConnection', () => {
  it('exec returns stdout, stderr and the exit code', async () => {
    const s = await startServer()
    const c = await connect(options(s.port))
    const r = await c.exec("ccc web status --json", { maxBytes: 10_000, timeoutMs: 5000 })
    expect(r).toEqual({ stdout: 'ran: ccc web status --json\n', stderr: 'a warning\n', code: 3 })
    // A second command on the same connection.
    expect((await c.exec('again', { maxBytes: 10_000, timeoutMs: 5000 })).stdout).toBe('ran: again\n')
  })

  it('exec stops at the output cap and closes the channel', async () => {
    const s = await startServer({
      onExec: (_cmd, stream) => {
        stream.write('x'.repeat(600))
        stream.stderr.write('y'.repeat(600))
        // Never ends by itself: only the client's close ends it.
      }
    })
    const c = await connect(options(s.port))
    const e = await rejection(c.exec('flood', { maxBytes: 1000, timeoutMs: 5000 }))
    expect(e.level).toBe('exec-output-limit')
    await expect.poll(() => s.closedChannels).toBe(1)
  })

  it('exec stops at the deadline and closes the channel; the connection stays usable', async () => {
    let first = true
    const s = await startServer({
      onExec: (cmd, stream) => {
        if (first) {
          first = false
          return
        }
        stream.write(cmd)
        stream.exit(0)
        stream.end()
      }
    })
    const c = await connect(options(s.port))
    const started = Date.now()
    const e = await rejection(c.exec('hang', { maxBytes: 1000, timeoutMs: 300 }))
    expect(e.level).toBe('exec-timeout')
    expect(Date.now() - started).toBeLessThan(3000)
    await expect.poll(() => s.closedChannels).toBe(1)
    expect(await c.exec('ok', { maxBytes: 1000, timeoutMs: 5000 })).toEqual({ stdout: 'ok', stderr: '', code: 0 })
  })

  it('forwardOut reaches a port on the server loopback', async () => {
    const echo = createServer((sock) => sock.pipe(sock))
    netServers.push(echo)
    await new Promise<void>((done) => echo.listen(0, '127.0.0.1', done))
    const echoPort = (echo.address() as AddressInfo).port
    const s = await startServer()
    const c = await connect(options(s.port))
    const channel = await c.forwardOut(40000, echoPort)
    streams.push(channel)
    const got = new Promise<string>((done) => channel.once('data', (d: Buffer) => done(d.toString())))
    channel.write('ping')
    expect(await got).toBe('ping')
  })

  it('forwardOut to a port the server refuses rejects', async () => {
    const s = await startServer()
    const c = await connect(options(s.port))
    const gone = createServer()
    await new Promise<void>((done) => gone.listen(0, '127.0.0.1', done))
    const freePort = (gone.address() as AddressInfo).port
    await new Promise<void>((done) => gone.close(() => done()))
    const e = await rejection(c.forwardOut(40001, freePort))
    expect(e.level).toBe('forward-failed')
    // The connection itself is still fine.
    expect((await c.exec('still', { maxBytes: 100, timeoutMs: 5000 })).code).toBe(3)
  })

  it('exec and forwardOut fail once the connection is closed', async () => {
    const s = await startServer()
    const c = await dial(options(s.port))
    const closed = new Promise<void>((done) => c.onClose(() => done()))
    c.end()
    await closed
    expect((await rejection(c.exec('x', { maxBytes: 10, timeoutMs: 1000 }))).level).toBe('client-socket')
    expect((await rejection(c.forwardOut(1, 2))).level).toBe('client-socket')
  })
})

describe('parseKey', () => {
  it('accepts an unencrypted private key', () => {
    const r = parseKey(Buffer.from(clientKey.private))
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.key).toEqual({ type: 'ssh-ed25519', comment: 'test@client' })
  })

  it('tells an encrypted key without a passphrase from a wrong one and opens it with the right one', () => {
    const enc = utils.generateKeyPairSync('ed25519', { passphrase: 'open sesame', cipher: 'aes256-ctr', rounds: 2 })
    expect(parseKey(enc.private)).toEqual({ kind: 'needs-passphrase' })
    expect(parseKey(enc.private, '')).toEqual({ kind: 'needs-passphrase' })
    expect(parseKey(enc.private, 'nope')).toEqual({ kind: 'wrong-passphrase' })
    expect(parseKey(enc.private, 'open sesame').kind).toBe('ok')
  })

  it('does the same for an old-style encrypted PEM key', async () => {
    const { generateKeyPairSync } = await import('node:crypto')
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-128-cbc', passphrase: 'pem pass' }
    })
    expect(parseKey(privateKey)).toEqual({ kind: 'needs-passphrase' })
    expect(parseKey(privateKey, 'wrong')).toEqual({ kind: 'wrong-passphrase' })
    const ok = parseKey(privateKey, 'pem pass')
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.key.type).toBe('ssh-rsa')
  })

  it('a public key, garbage and an empty file are unsupported', () => {
    expect(parseKey(clientKey.public).kind).toBe('unsupported')
    expect(parseKey('not a key at all').kind).toBe('unsupported')
    expect(parseKey(Buffer.alloc(0)).kind).toBe('unsupported')
  })

  it('a key object parseKey did not make signs nothing', async () => {
    const s = await startServer()
    const fake = { type: 'ssh-ed25519', comment: '' }
    let step = 0
    const e = await rejection(
      dial(
        options(s.port, {
          authHandler: (left) => (left === null ? { type: 'none' } : step++ === 0 ? { type: 'publickey', key: fake } : false)
        })
      )
    )
    expect(e.level).toBe('client-authentication')
    expect(s.attempts).toEqual(['none'])
  })
})
