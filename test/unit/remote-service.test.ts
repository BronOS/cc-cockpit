// RemoteService (main/remote/remote-service.ts): what the picker's remote.* channels do. The real
// RemoteServerStore over an in-memory app.json and the fake secret store; a scripted fake link (a
// server that wants a host key and a password the way SshLink reports them), a fake tunnel probe and
// fake windows, so the order of every step and what is saved when is visible. One block runs the
// real SshLink against ssh2's own Server in-process, for the connect the plan's "nothing saved
// before success" is about.
import { timingSafeEqual } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http'
import { connect as netConnect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Server, utils, type Connection } from 'ssh2'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint, keyBlobType } from '../../src/main/remote/known-hosts'
import { RemoteServerStore, type RemoteServersApp } from '../../src/main/remote/remote-servers'
import { backgroundNeedText, connectionOf, notifyingStore, RemoteService, tunnelOrigin } from '../../src/main/remote/remote-service'
import type { RemoteOpenRequest } from '../../src/main/remote/remote-windows'
import type { RemoteStatus } from '../../src/main/remote/remote-status'
import { SshLink, type LinkAccepted, type LinkAnswers, type LinkResult, type LinkState, type RemoteLink, type SshLinkStore } from '../../src/main/remote/ssh-link'
import type { TunnelProbeResult } from '../../src/main/remote/tunnel-probe'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import type { RemoteHostKey } from '../../src/shared/remote-servers'
import type { AppSettings, WebAccessMode } from '../../src/shared/types'

const HOST_KEY: RemoteHostKey = { type: 'ssh-ed25519', sha256: `SHA256:${'K'.repeat(43)}` }
const PASSWORD = 'correct horse'

/**
 * What the fake server asks for, shared by every link the service makes (a link is per server and
 * may be made again after a failed connect): a host key nobody trusted yet, a password.
 */
class FakeWorld {
  hostKey: RemoteHostKey | undefined = undefined
  password: string | undefined = undefined
  mode: WebAccessMode = 'link'
  gatewayPort = 8765
  nextPort = 41000
  tokens = 0
  /** Every link call fails with this error text. */
  error: string | undefined
  links: FakeLink[] = []
}

class FakeLink implements RemoteLink {
  state: LinkState = { state: 'stopped' }
  port: number | undefined
  users = 0
  disposed = false
  calls: Array<[string, LinkAnswers]> = []
  private readonly listeners = new Set<(s: LinkState) => void>()
  /** What the live (fake) connection rests on, as SshLink reports it. */
  private accepted: LinkAccepted = {}
  private connected = false

  constructor(
    readonly id: string,
    readonly store: SshLinkStore,
    private readonly world: FakeWorld,
    private readonly steps: string[]
  ) {}

  private setState(s: LinkState): void {
    this.state = s
    for (const l of this.listeners) l(s)
  }

  /** The dial: host key, then password, with SshLink's rules (answers count only for this call). */
  private async connect(a: LinkAnswers): Promise<{ ok: false; need: never } | LinkResult<never> | undefined> {
    if (this.disposed) return { ok: false, error: 'closed' }
    if (this.world.error !== undefined) return { ok: false, error: this.world.error }
    if (this.connected) return undefined
    const accepted: LinkAccepted = {}
    const record = this.store.get(this.id)
    const key = this.world.hostKey
    if (key !== undefined && record?.hostKey?.sha256 !== key.sha256) {
      if (record?.hostKey !== undefined) return { ok: false, error: 'the host key changed' }
      if (a.hostKey !== key.sha256) return { ok: false, need: { need: 'hostKey', type: key.type, sha256: key.sha256, address: '127.0.0.1' } } as never
      accepted.hostKey = key
    }
    if (this.world.password !== undefined) {
      const given = a.password !== undefined && a.password !== '' ? a.password : undefined
      const secret = given ?? (await this.store.getSecret(this.id, 'password'))
      if (secret === undefined) return { ok: false, need: { need: 'password' } } as never
      if (secret !== this.world.password) return { ok: false, need: { need: 'password', again: true } } as never
      if (given !== undefined) accepted.password = true
    }
    this.accepted = accepted
    this.connected = true
    this.setState({ state: 'up' })
    return undefined
  }

  private ok<T>(value: T): LinkResult<T> {
    const accepted = { ...this.accepted }
    if (accepted.hostKey !== undefined && this.store.get(this.id)?.hostKey?.sha256 === accepted.hostKey.sha256) delete accepted.hostKey
    return { ok: true, value, accepted }
  }

  async status(a: LinkAnswers = {}): Promise<LinkResult<RemoteStatus>> {
    this.calls.push(['status', a])
    this.steps.push('status')
    const f = await this.connect(a)
    if (f !== undefined) return f
    return this.ok({ port: this.world.gatewayPort, mode: this.world.mode, version: '0.17.0' })
  }

  async addDevice(a: LinkAnswers = {}): Promise<LinkResult<string>> {
    this.calls.push(['addDevice', a])
    this.steps.push('add-device')
    const f = await this.connect(a)
    if (f !== undefined) return f
    return this.ok(`tok${++this.world.tokens}`)
  }

  async acquire(a: LinkAnswers = {}): Promise<LinkResult<number>> {
    this.calls.push(['acquire', a])
    this.steps.push('acquire')
    const f = await this.connect(a)
    if (f !== undefined) return f
    this.users++
    this.port ??= this.store.get(this.id)?.localPort ?? this.world.nextPort
    this.setState({ state: 'up', localPort: this.port })
    return this.ok(this.port)
  }

  release(): void {
    this.users--
    this.steps.push('release')
  }

  onState(listener: (s: LinkState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.steps.push('link dispose')
    this.setState({ state: 'stopped' })
  }

  /** The connection dropped and the background found it cannot go on by itself. */
  down(error: string): void {
    this.connected = false
    this.setState({ state: 'down', error })
  }
}

class FakeWindows {
  opens: Array<{ serverId: string } & RemoteOpenRequest> = []
  origins: Array<{ serverId: string; origin: string }> = []
  counts = new Map<string, number>()
  titled: string[] = []
  forgotten: string[] = []
  /** The next open throws this. */
  failWith: string | undefined
  /** Called for a server's last window closing (RemoteWindows' onAllClosed). */
  allClosed: (serverId: string) => void = () => {}

  constructor(private readonly steps: string[]) {}

  async open(serverId: string, request: RemoteOpenRequest): Promise<void> {
    if (this.failWith !== undefined) throw new Error(this.failWith)
    this.steps.push(`window ${request.origin}${request.projectId === undefined ? '' : ` ${request.projectId}`}${request.token === undefined ? '' : ` #t=${request.token}`}`)
    this.opens.push({ serverId, ...request })
    this.counts.set(serverId, (this.counts.get(serverId) ?? 0) + 1)
  }

  async setOrigin(serverId: string, origin: string): Promise<void> {
    this.origins.push({ serverId, origin })
  }

  countOf(serverId: string): number {
    return this.counts.get(serverId) ?? 0
  }

  refreshTitles(serverId: string): void {
    this.titled.push(serverId)
  }

  forget(serverId: string): void {
    this.steps.push('windows forget')
    this.forgotten.push(serverId)
    this.closeAll(serverId)
  }

  closeAll(serverId: string): void {
    if (this.countOf(serverId) === 0) return
    this.counts.set(serverId, 0)
    this.allClosed(serverId)
  }
}

interface Setup {
  service: RemoteService
  store: RemoteServerStore
  app: RemoteServersApp & { data: AppSettings }
  world: FakeWorld
  windows: FakeWindows
  steps: string[]
  writes: { count: number }
  opened: { count: number }
  changes: { count: number }
  probes: number[]
  probe: { result: TunnelProbeResult }
  picked: Array<[number, string]>
}

function setup(options: { link?: (id: string, store: SshLinkStore) => RemoteLink } = {}): Setup {
  const steps: string[] = []
  const writes = { count: 0 }
  const app = {
    data: {} as AppSettings,
    update(mutate: (data: AppSettings) => void) {
      writes.count++
      mutate(app.data)
    }
  }
  let ids = 0
  const store = new RemoteServerStore({ app, secrets: fakeSecretStore(), newId: () => `srv${++ids}` })
  const world = new FakeWorld()
  const windows = new FakeWindows(steps)
  const opened = { count: 0 }
  const changes = { count: 0 }
  const probes: number[] = []
  const probe = { result: 'cockpit' as TunnelProbeResult }
  const picked: Array<[number, string]> = []
  const service = new RemoteService({
    store,
    windows,
    link:
      options.link ??
      ((id, view) => {
        const link = new FakeLink(id, view, world, steps)
        world.links.push(link)
        return link
      }),
    probe: async (port) => {
      probes.push(port)
      steps.push(`probe ${port}`)
      return probe.result
    },
    ready: async () => {
      steps.push('ready')
    },
    clearSession: async (serverId) => {
      steps.push(`clear ${serverId}`)
    },
    pickFile: async (windowId, start) => {
      picked.push([windowId, start])
      return '/home/me/.ssh/id_work'
    },
    home: '/home/me',
    opened: () => opened.count++,
    onChanged: () => changes.count++,
    log: () => {}
  })
  windows.allClosed = (serverId) => service.allClosed(serverId)
  return { service, store, app, world, windows, steps, writes, opened, changes, probes, probe, picked }
}

const PW_SERVER = { kind: 'ssh' as const, host: 'devbox', user: 'me', auth: { kind: 'password' as const } }

describe('RemoteService: built-in SSH', () => {
  it('connect in link mode with no cookie: status, add-device, acquire, then the window with the token', async () => {
    const { service, store, world, windows, steps, opened } = setup()
    const answer = await service.connect({ kind: 'ssh', host: 'devbox', name: 'Dev box' })
    expect(answer).toEqual({ ok: true, serverId: 'srv1' })
    expect(steps).toEqual(['ready', 'status', 'add-device', 'acquire', `window ${tunnelOrigin(41000)} #t=tok1`])
    // The listener's port is the server's preferred one from now on.
    expect(store.get('srv1')).toMatchObject({ name: 'Dev box', via: { kind: 'ssh', host: 'devbox' }, localPort: 41000 })
    expect(windows.opens[0]).toEqual({ serverId: 'srv1', origin: 'http://127.0.0.1:41000', token: 'tok1' })
    expect(world.links).toHaveLength(1)
    // Held once for the window.
    expect(world.links[0]!.users).toBe(1)
    expect(opened.count).toBe(1)
  })

  it('a new server: hostKey, then password, then ok saves record, host key and secret once, at the end', async () => {
    const { service, store, app, world, writes, windows } = setup()
    world.hostKey = HOST_KEY
    world.password = PASSWORD
    const first = await service.connect(PW_SERVER)
    expect(first).toEqual({ ok: false, need: { need: 'hostKey', type: 'ssh-ed25519', sha256: HOST_KEY.sha256, address: '127.0.0.1' } })
    const second = await service.connect({ ...PW_SERVER, answers: { hostKey: HOST_KEY.sha256 } })
    expect(second).toEqual({ ok: false, need: { need: 'password' } })
    // Nothing written so far: no record, no host key, no secret; each failed link was ended.
    expect(writes.count).toBe(0)
    expect(app.data.remoteServers).toBeUndefined()
    expect(world.links.map((l) => l.disposed)).toEqual([true, true])
    const third = await service.connect({ ...PW_SERVER, answers: { hostKey: HOST_KEY.sha256, password: PASSWORD, remember: true } })
    expect(third).toEqual({ ok: true, serverId: expect.any(String) })
    const id = (third as { serverId: string }).serverId
    expect(store.get(id)).toMatchObject({ via: { kind: 'ssh', host: 'devbox', user: 'me', auth: { kind: 'password' } }, hostKey: HOST_KEY, localPort: 41000 })
    expect((await store.list())[0]?.remembered).toEqual({ password: true })
    expect(await store.getSecret(id, 'password')).toBe(PASSWORD)
    // Every call of the last connect carried all its answers.
    const last = world.links[2]!
    expect(last.calls.map(([name]) => name)).toEqual(['status', 'addDevice', 'acquire'])
    for (const [, a] of last.calls) expect(a).toEqual({ hostKey: HOST_KEY.sha256, password: PASSWORD })
    expect(windows.opens).toHaveLength(1)
    // Never in a list answer.
    expect(JSON.stringify(await service.list())).not.toContain(PASSWORD)
  })

  it('a password not remembered is held in memory for the app life, not in the record', async () => {
    const { service, store, app, world } = setup()
    world.password = PASSWORD
    const answer = await service.connect({ ...PW_SERVER, answers: { password: PASSWORD } })
    expect(answer.ok).toBe(true)
    expect(JSON.stringify(app.data.remoteServers)).not.toContain('secrets')
    expect((await store.list())[0]?.remembered).toEqual({})
    expect(await store.getSecret('srv1', 'password')).toBe(PASSWORD)
  })

  it('a cancel after the host key (no further call) leaves nothing: no record, no link', async () => {
    const { service, app, world, writes } = setup()
    world.hostKey = HOST_KEY
    world.password = PASSWORD
    await service.connect(PW_SERVER)
    expect(await service.connect({ ...PW_SERVER, answers: { hostKey: HOST_KEY.sha256 } })).toMatchObject({ need: { need: 'password' } })
    expect(writes.count).toBe(0)
    expect(app.data.remoteServers).toBeUndefined()
    expect(await service.list()).toEqual([])
    expect(world.links.every((l) => l.disposed)).toBe(true)
  })

  it('a wrong password asks again (once per call, nothing saved); the right one then signs in', async () => {
    const { service, app, world } = setup()
    world.password = PASSWORD
    expect(await service.connect({ ...PW_SERVER, answers: { password: 'wrong' } })).toEqual({ ok: false, need: { need: 'password', again: true } })
    expect(world.links[0]!.calls).toHaveLength(1)
    expect(app.data.remoteServers).toBeUndefined()
    expect((await service.connect({ ...PW_SERVER, answers: { password: PASSWORD } })).ok).toBe(true)
  })

  it('a saved server opened again needs no answers: the store has the host key and secret', async () => {
    const { service, world, windows } = setup()
    world.hostKey = HOST_KEY
    world.password = PASSWORD
    await service.connect({ ...PW_SERVER, answers: { hostKey: HOST_KEY.sha256, password: PASSWORD, remember: true } })
    windows.closeAll('srv1')
    // The link stopped after its idle time; a new one dials from the store alone.
    world.links[0]!.down('closed')
    expect(await service.open('srv1', 'p1')).toEqual({ ok: true, serverId: 'srv1' })
  })

  it('a host key or password needed on open comes back as a need; an open with the answer saves it', async () => {
    const { service, store, world } = setup()
    const server = store.add({ via: PW_SERVER })
    world.password = PASSWORD
    expect(await service.open(server.id)).toEqual({ ok: false, need: { need: 'password' } })
    expect(await service.open(server.id, undefined, { password: PASSWORD })).toEqual({ ok: true, serverId: server.id })
    expect(await store.getSecret(server.id, 'password')).toBe(PASSWORD)
  })

  it('a connect to a saved server with the same settings opens it; other settings are refused (Edit changes them)', async () => {
    const { service, store } = setup()
    const server = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    expect(await service.connect({ kind: 'ssh', host: 'devbox' })).toEqual({ ok: true, serverId: server.id })
    expect(await service.connect({ kind: 'ssh', host: 'devbox', auth: { kind: 'password' } })).toEqual({ ok: false, error: expect.stringContaining('use Edit') })
    expect((await store.list()).map((s) => s.id)).toEqual([server.id])
  })

  it('a saved cookie needs no token, and the saved local port is used', async () => {
    const { service, store, steps, windows } = setup()
    const server = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    store.setLocalPort(server.id, 42424)
    await store.setCookie(server.id, 'ccc_device=abc')
    expect(await service.open(server.id, 'p1')).toEqual({ ok: true, serverId: server.id })
    expect(steps).not.toContain('add-device')
    expect(windows.opens[0]).toEqual({ serverId: server.id, origin: 'http://127.0.0.1:42424', projectId: 'p1' })
  })

  it.each(['password', 'confirm', 'none'] as const)('mode %s mints no token', async (mode) => {
    const { service, world, steps, windows } = setup()
    world.mode = mode
    await service.connect({ kind: 'ssh', host: 'devbox' })
    expect(steps).not.toContain('add-device')
    expect(windows.opens[0]!.token).toBeUndefined()
  })

  it('an up link skips status and token; a second window does not hold the link twice', async () => {
    const { service, world, steps } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    steps.length = 0
    await service.open('srv1', 'p2')
    expect(steps).toEqual(['ready', 'acquire', 'window http://127.0.0.1:41000 p2', 'release'])
    expect(world.links[0]!.users).toBe(1)
  })

  it('the last window closing releases the link; the next open holds it again', async () => {
    const { service, world, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    const link = world.links[0]!
    windows.closeAll('srv1')
    expect(link.users).toBe(0)
    service.allClosed('srv1')
    expect(link.users).toBe(0)
    await service.open('srv1')
    expect(link.users).toBe(1)
  })

  it('a reconnect in the same run after a token sign-in mints no second device (no keyring keeps nothing)', async () => {
    const { service, world, steps, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    windows.closeAll('srv1')
    world.links[0]!.down('idle')
    steps.length = 0
    await service.open('srv1')
    expect(steps).toEqual(['ready', 'status', 'acquire', 'window http://127.0.0.1:41000'])
  })

  it('an error is text for the form; a new server is not saved and its link is ended', async () => {
    const { service, store, world, windows } = setup()
    world.error = 'Could not reach devbox: the connection was refused.'
    expect(await service.connect({ kind: 'ssh', host: 'devbox' })).toEqual({ ok: false, error: world.error })
    expect(await store.list()).toEqual([])
    expect(windows.opens).toEqual([])
    expect(world.links[0]!.disposed).toBe(true)
  })

  it('a window that cannot open undoes a new server and releases the link', async () => {
    const { service, store, world, windows } = setup()
    windows.failWith = 'no window'
    expect(await service.connect({ kind: 'ssh', host: 'devbox' })).toEqual({ ok: false, error: 'no window' })
    expect(await store.list()).toEqual([])
    expect(world.links[0]!.users).toBe(0)
    expect(world.links[0]!.disposed).toBe(true)
  })

  it('a failure of a saved server keeps the server; a link its windows hold is kept too', async () => {
    const { service, store, world } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    const link = world.links[0]!
    link.down('dropped')
    world.error = 'Could not reach devbox'
    expect(await service.open('srv1', 'p9')).toEqual({ ok: false, error: 'Could not reach devbox' })
    expect(link.disposed).toBe(false)
    expect((await store.list()).map((s) => s.id)).toEqual(['srv1'])
  })

  it('refuses a bad host or ccc path before any dial', async () => {
    const { service, steps, store } = setup()
    expect(await service.connect({ kind: 'ssh', host: '-oProxyCommand=sh' })).toEqual({ ok: false, error: 'a host cannot start with "-"' })
    expect(await service.connect({ kind: 'ssh', host: 'a b' })).toMatchObject({ ok: false })
    expect(await service.connect({ kind: 'ssh', host: 'devbox', ccc: "/x'y" })).toMatchObject({ ok: false, error: expect.stringContaining('ccc path') })
    expect(await service.connect({ kind: 'ssh', host: 'devbox', port: 70000 })).toMatchObject({ ok: false, error: expect.stringContaining('port') })
    expect(steps).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it('one connect at a time: a second Connect of the same new host finds the first one saved', async () => {
    const { service, steps, store } = setup()
    const [a, b] = await Promise.all([service.connect({ kind: 'ssh', host: 'devbox' }), service.connect({ kind: 'ssh', host: 'devbox' })])
    expect(a).toEqual({ ok: true, serverId: 'srv1' })
    expect(b).toEqual({ ok: true, serverId: 'srv1' })
    expect(steps.filter((s) => s === 'add-device')).toHaveLength(1)
    expect((await store.list()).map((s) => s.id)).toEqual(['srv1'])
  })

  it('mintToken (the background re-pair) never asks: no answers, and a need is an error saying what to do', async () => {
    const { service, store, world } = setup()
    const server = store.add({ via: PW_SERVER })
    world.password = PASSWORD
    await expect(service.mintToken(server)).rejects.toThrow('devbox needs its password again: open the server from the project picker')
    expect(world.links[0]!.calls).toEqual([['addDevice', {}]])
    await store.setSecret(server.id, 'password', PASSWORD, { remember: false })
    await expect(service.mintToken(server)).resolves.toBe('tok1')
    const direct = store.add({ via: { kind: 'direct', origin: 'https://box.example' } })
    await expect(service.mintToken(direct)).rejects.toThrow(/new link/)
  })

  it('the link state is the row state; a change tells the picker', async () => {
    const { service, world, changes } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    const before = changes.count
    world.links[0]!.down('devbox needs its password again')
    expect(changes.count).toBe(before + 1)
    expect((await service.list())[0]?.connection).toEqual({ state: 'down', error: 'devbox needs its password again', retrying: false })
  })

  it('backgroundNeedText names what to do', () => {
    const server = { id: 's', name: 'devbox', via: PW_SERVER, recent: [] }
    expect(backgroundNeedText({ need: 'hostKey', type: 't', sha256: 's', address: 'a' }, server)).toContain('not trusted yet')
    expect(backgroundNeedText({ need: 'passphrase', path: '~/.ssh/k' }, server)).toContain('~/.ssh/k needs its passphrase')
  })
})

describe('RemoteService: My own tunnel', () => {
  const TUNNEL = { kind: 'tunnel' as const, localPort: 7331, remotePort: 7330, sshHost: 'devbox' }

  it('a cockpit answering: saved, the window signs in with the token of the pasted link (its origin unused)', async () => {
    const { service, store, windows, steps, probes } = setup()
    const answer = await service.connect({ ...TUNNEL, link: 'http://127.0.0.1:7330/#t=pair-me' })
    expect(answer).toEqual({ ok: true, serverId: 'srv1' })
    expect(store.get('srv1')?.via).toEqual({ kind: 'tunnel', localPort: 7331, remotePort: 7330, sshHost: 'devbox' })
    expect(JSON.stringify(store.get('srv1'))).not.toContain('pair-me')
    expect(windows.opens).toEqual([{ serverId: 'srv1', origin: 'http://127.0.0.1:7331', token: 'pair-me' }])
    expect(probes).toEqual([7331])
    expect(steps).not.toContain('ready')
  })

  it('nothing answering still opens the window (it waits on main page); something else or an old server refuses and saves nothing', async () => {
    const { service, store, probe, windows } = setup()
    probe.result = 'other'
    expect(await service.connect(TUNNEL)).toEqual({ ok: false, error: expect.stringContaining('Something else is listening on 127.0.0.1:7331') })
    probe.result = 'old'
    expect(await service.connect(TUNNEL)).toEqual({ ok: false, error: expect.stringContaining('update cc-cockpit on the server') })
    expect(await store.list()).toEqual([])
    probe.result = 'nothing'
    expect(await service.connect(TUNNEL)).toEqual({ ok: true, serverId: expect.any(String) })
    expect(windows.opens).toHaveLength(1)
  })

  it('an https link is refused (the tunnel encrypts; TLS cannot match 127.0.0.1); a bad one too', async () => {
    const { service, store } = setup()
    expect(await service.connect({ ...TUNNEL, link: 'https://box.example/#t=x' })).toEqual({ ok: false, error: expect.stringContaining('serves https') })
    expect(await service.connect({ ...TUNNEL, link: 'ftp://x' })).toMatchObject({ ok: false })
    expect(await store.list()).toEqual([])
  })

  it('a second tunnel on a used local port is refused', async () => {
    const { service } = setup()
    await service.connect(TUNNEL)
    expect(await service.connect({ ...TUNNEL, remotePort: 9999 })).toEqual({ ok: false, error: expect.stringContaining('already used by the tunnel') })
  })
})

describe('RemoteService: Direct', () => {
  it('connect parses the link, saves the origin only and signs in with the token once', async () => {
    const { service, store, windows, steps, opened } = setup()
    const answer = await service.connect({ kind: 'direct', link: 'https://box.example:8765/#t=secret' })
    expect(answer).toEqual({ ok: true, serverId: 'srv1' })
    expect(store.get('srv1')?.via).toEqual({ kind: 'direct', origin: 'https://box.example:8765' })
    expect(JSON.stringify(store.get('srv1'))).not.toContain('secret')
    expect(windows.opens).toEqual([{ serverId: 'srv1', origin: 'https://box.example:8765', token: 'secret' }])
    expect(steps).toEqual(['window https://box.example:8765 #t=secret'])
    expect(opened.count).toBe(1)
  })

  it('open of a saved Direct server loads the page with no token', async () => {
    const { service, windows } = setup()
    await service.connect({ kind: 'direct', link: 'http://192.168.1.5:8765' })
    await service.open('srv1', 'p1')
    expect(windows.opens.at(-1)).toEqual({ serverId: 'srv1', origin: 'http://192.168.1.5:8765', projectId: 'p1' })
  })

  it('a bad link is text for the form and saves nothing', async () => {
    const { service, store } = setup()
    expect(await service.connect({ kind: 'direct', link: 'ftp://box' })).toEqual({ ok: false, error: 'only http and https links work' })
    expect(await service.connect({ kind: 'direct', link: 'https://box/path' })).toMatchObject({ ok: false })
    expect(await store.list()).toEqual([])
  })
})

describe('RemoteService: Edit', () => {
  it('keeps the cookie; a port change clears the host key and ends the link', async () => {
    const { service, store, world } = setup()
    world.hostKey = HOST_KEY
    await service.connect({ kind: 'ssh', host: 'devbox', answers: { hostKey: HOST_KEY.sha256 } })
    await store.setCookie('srv1', 'ccc_device=abc')
    expect(store.get('srv1')?.hostKey).toEqual(HOST_KEY)
    // The ccc path only: host key and link stay.
    expect(await service.edit({ serverId: 'srv1', kind: 'ssh', host: 'devbox', ccc: '/opt/ccc' })).toEqual({ ok: true, serverId: 'srv1' })
    expect(store.get('srv1')?.hostKey).toEqual(HOST_KEY)
    expect(world.links[0]!.disposed).toBe(true)
    // The port: the host key goes, the cookie stays; nothing dials.
    const links = world.links.length
    expect(await service.edit({ serverId: 'srv1', kind: 'ssh', host: 'devbox', port: 2222, name: 'Dev' })).toEqual({ ok: true, serverId: 'srv1' })
    expect(store.get('srv1')).toMatchObject({ name: 'Dev', via: { port: 2222 } })
    expect(store.get('srv1')?.hostKey).toBeUndefined()
    expect(store.hasCookie('srv1')).toBe(true)
    expect(world.links).toHaveLength(links)
    // The next open asks for the key again.
    expect(await service.open('srv1')).toMatchObject({ ok: false, need: { need: 'hostKey' } })
  })

  it('Forget the trusted host key: the key goes, the link ends, the next open asks Trust again', async () => {
    const { service, store, world } = setup()
    world.hostKey = HOST_KEY
    await service.connect({ kind: 'ssh', host: 'devbox', answers: { hostKey: HOST_KEY.sha256 } })
    expect(store.get('srv1')?.hostKey).toEqual(HOST_KEY)
    expect(await service.edit({ serverId: 'srv1', kind: 'ssh', host: 'devbox', forgetHostKey: true })).toEqual({ ok: true, serverId: 'srv1' })
    expect(store.get('srv1')?.hostKey).toBeUndefined()
    expect(world.links[0]!.disposed).toBe(true)
    expect(await service.open('srv1')).toMatchObject({ ok: false, need: { need: 'hostKey' } })
  })

  it('a name alone refreshes the titles and keeps the link', async () => {
    const { service, world, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    expect(await service.edit({ serverId: 'srv1', kind: 'ssh', host: 'devbox', name: 'Home' })).toEqual({ ok: true, serverId: 'srv1' })
    expect(windows.titled).toEqual(['srv1'])
    expect(world.links[0]!.disposed).toBe(false)
  })

  it('signs in with a link: My own tunnel with its token (windows moved to a new local port), Direct with a new one', async () => {
    const { service, store, windows } = setup()
    await service.connect({ kind: 'tunnel', localPort: 7331, remotePort: 7330 })
    await store.setCookie('srv1', 'old-cookie')
    const answer = await service.edit({ serverId: 'srv1', kind: 'tunnel', localPort: 7332, remotePort: 7330, link: 'http://127.0.0.1:7330/#t=again' })
    expect(answer).toEqual({ ok: true, serverId: 'srv1' })
    expect(windows.origins).toEqual([{ serverId: 'srv1', origin: 'http://127.0.0.1:7332' }])
    expect(windows.opens.at(-1)).toEqual({ serverId: 'srv1', origin: 'http://127.0.0.1:7332', token: 'again' })
    expect(store.hasCookie('srv1')).toBe(true)
    await service.connect({ kind: 'direct', link: 'https://box.example' })
    expect(await service.edit({ serverId: 'srv2', kind: 'direct', link: 'https://box.example/#t=fresh' })).toEqual({ ok: true, serverId: 'srv2' })
    expect(windows.opens.at(-1)).toEqual({ serverId: 'srv2', origin: 'https://box.example', token: 'fresh' })
  })

  it('refuses another kind, an unknown server and bad settings, changing nothing', async () => {
    const { service, store } = setup()
    await service.connect({ kind: 'direct', link: 'https://box.example' })
    expect(await service.edit({ serverId: 'srv1', kind: 'ssh', host: 'devbox' })).toEqual({ ok: false, error: expect.stringContaining('cannot change how a server is reached') })
    expect(await service.edit({ serverId: 'nope', kind: 'direct', link: 'https://x.example' })).toEqual({ ok: false, error: 'this server is not saved any more' })
    expect(await service.edit({ serverId: 'srv1', kind: 'direct', link: 'ftp://x' })).toMatchObject({ ok: false })
    expect(store.get('srv1')?.via).toEqual({ kind: 'direct', origin: 'https://box.example' })
  })
})

describe('RemoteService: list, rename, forget, pickKey', () => {
  it('lists servers with no cookie text, secret or port, with window counts and the link state', async () => {
    const { service, store } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    await store.setCookie('srv1', 'ccc_device=abc')
    await service.connect({ kind: 'direct', link: 'https://box.example' })
    const list = await service.list()
    expect(list).toEqual([
      { id: 'srv1', name: 'devbox', via: { kind: 'ssh', host: 'devbox' }, recent: [], cookieSaved: true, cookieKept: true, remembered: {}, windows: 1, connection: { state: 'up' } },
      { id: 'srv2', name: 'box.example', via: { kind: 'direct', origin: 'https://box.example' }, recent: [], cookieSaved: false, cookieKept: true, remembered: {}, windows: 1 }
    ])
    expect(JSON.stringify(list)).not.toContain('localPort')
  })

  it('maps the link states for the picker', () => {
    expect(connectionOf(undefined)).toEqual({ state: 'stopped' })
    expect(connectionOf({ state: 'up', localPort: 5 })).toEqual({ state: 'up' })
    expect(connectionOf({ state: 'down', error: 'gone', retryInMs: 1000 })).toEqual({ state: 'down', error: 'gone', retrying: true })
    expect(connectionOf({ state: 'down', error: 'gone' })).toEqual({ state: 'down', error: 'gone', retrying: false })
  })

  it('rename refreshes the titles; a bad name is text', async () => {
    const { service, store, windows } = setup()
    await service.connect({ kind: 'direct', link: 'https://box.example' })
    expect(service.rename('srv1', 'Home')).toEqual({ ok: true })
    expect(store.get('srv1')?.name).toBe('Home')
    expect(windows.titled).toEqual(['srv1'])
    expect(service.rename('srv1', '')).toMatchObject({ ok: false })
    expect(service.rename('nope', 'x')).toEqual({ ok: false, error: 'unknown server' })
  })

  it('forget: windows, then the partition, then the link, then the record with its secrets (memory too)', async () => {
    const { service, store, world, steps } = setup()
    world.password = PASSWORD
    await service.connect({ ...PW_SERVER, answers: { password: PASSWORD } })
    await store.setCookie('srv1', 'ccc_device=abc')
    steps.length = 0
    await service.forget('srv1')
    expect(steps).toEqual(['windows forget', 'release', 'clear srv1', 'link dispose'])
    expect(world.links[0]!.disposed).toBe(true)
    expect(store.get('srv1')).toBeUndefined()
    expect(store.hasCookie('srv1')).toBe(false)
    expect(await store.getSecret('srv1', 'password')).toBeUndefined()
    expect(await service.open('srv1')).toEqual({ ok: false, error: 'this server is not saved any more' })
  })

  it('pickKey opens the dialog in ~/.ssh on the picker window', async () => {
    const { service, picked } = setup()
    expect(await service.pickKey(13)).toBe('/home/me/.ssh/id_work')
    expect(picked).toEqual([[13, '/home/me/.ssh']])
  })

  it('notifyingStore tells after RemoteWindows writes a recent project or a cookie', async () => {
    const { store } = setup()
    const server = store.add({ via: { kind: 'direct', origin: 'https://box.example' } })
    let told = 0
    const wrapped = notifyingStore(store, () => told++)
    wrapped.recordRecent(server.id, 'p1', 'Project', 5)
    await wrapped.setCookie(server.id, 'c')
    wrapped.clearCookie(server.id)
    expect(told).toBe(3)
  })

  it('dispose ends every link and refuses later connects', async () => {
    const { service, world } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    service.dispose()
    expect(world.links[0]!.disposed).toBe(true)
    expect(await service.open('srv1')).toEqual({ ok: false, error: 'the app is quitting' })
  })
})

// ---------------------------------------------------------------------------------------------
// The real SshLink against ssh2's Server in-process: a password server with a host key nobody
// trusts yet, `ccc web` answered from the test, forwarding to a local HTTP gateway.

describe('RemoteService with the real SshLink', () => {
  const hostPair = utils.generateKeyPairSync('ed25519')
  const blob = Buffer.from(hostPair.public.split(' ')[1] ?? '', 'base64')
  const realKey: RemoteHostKey = { type: keyBlobType(blob) as string, sha256: fingerprint(blob) }
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c()
  })

  async function startSsh(gateway: number): Promise<{ port: number; attempts: string[]; clients: Connection[]; closed: () => number }> {
    const attempts: string[] = []
    const clients: Connection[] = []
    let closed = 0
    const server = new Server({ hostKeys: [hostPair.private] }, (client) => {
      clients.push(client)
      client.on('error', () => {})
      client.on('close', () => closed++)
      client.on('authentication', (ctx) => {
        attempts.push(ctx.method)
        if (ctx.method !== 'password') return ctx.reject(['password'])
        const ok = ctx.password.length === PASSWORD.length && timingSafeEqual(Buffer.from(ctx.password), Buffer.from(PASSWORD))
        return ok ? ctx.accept() : ctx.reject(['password'])
      })
      client.on('ready', () => {
        client.on('session', (accept) => {
          accept().on('exec', (acceptExec, _reject, info) => {
            const stream = acceptExec()
            stream.resume()
            const out = info.command.includes("'add-device'")
              ? `http://127.0.0.1:${gateway}/#t=minted\n`
              : `${JSON.stringify({ server: true, version: '0.17.0', scheme: 'http', enabled: true, mode: 'link', gateway: { state: 'listening', port: gateway } })}\n`
            stream.write(out)
            stream.exit(0)
            stream.end()
          })
        })
        client.on('tcpip', (accept, reject, info) => {
          const sock = netConnect(info.destPort, '127.0.0.1')
          sock.once('error', () => reject())
          sock.once('connect', () => {
            const channel = accept()
            channel.pipe(sock).pipe(channel)
          })
        })
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          for (const c of clients) c.end()
          server.close(() => done())
        })
    )
    return { port: (server.address() as AddressInfo).port, attempts, clients, closed: () => closed }
  }

  async function startGateway(): Promise<number> {
    const http: HttpServer = createHttpServer((_req, res) => res.end('the gateway'))
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
    cleanups.push(() => {
      http.closeAllConnections()
      http.close()
    })
    return (http.address() as AddressInfo).port
  }

  function realSetup(): Setup & { links: SshLink[]; home: string } {
    const home = mkdtempSync(join(tmpdir(), 'remote-service-home-'))
    mkdirSync(join(home, '.ssh'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const links: SshLink[] = []
    const s = setup({
      link: (serverId, store) => {
        const link = new SshLink({ serverId, store, home, env: () => ({}), localUser: () => 'nobody' })
        links.push(link)
        return link
      }
    })
    cleanups.push(() => s.service.dispose())
    return { ...s, links, home }
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

  it('hostKey, then password, then ok: saved once at the end, and the tunnel reaches the gateway', async () => {
    const gateway = await startGateway()
    const ssh = await startSsh(gateway)
    const { service, store, app, writes, windows, links } = realSetup()
    const request = { kind: 'ssh' as const, host: '127.0.0.1', port: ssh.port, user: 'alice', auth: { kind: 'password' as const } }
    expect(await service.connect(request)).toEqual({ ok: false, need: { need: 'hostKey', type: realKey.type, sha256: realKey.sha256, address: `127.0.0.1:${ssh.port}` } })
    expect(await service.connect({ ...request, answers: { hostKey: realKey.sha256 } })).toEqual({ ok: false, need: { need: 'password' } })
    expect(writes.count).toBe(0)
    expect(app.data.remoteServers).toBeUndefined()
    const done = await service.connect({ ...request, answers: { hostKey: realKey.sha256, password: PASSWORD, remember: false } })
    expect(done).toEqual({ ok: true, serverId: expect.any(String) })
    const id = (done as { serverId: string }).serverId
    const saved = store.get(id)
    expect(saved).toMatchObject({ hostKey: realKey, via: { host: '127.0.0.1', port: ssh.port, user: 'alice' } })
    expect(windows.opens[0]).toEqual({ serverId: id, origin: `http://127.0.0.1:${saved?.localPort}`, token: 'minted' })
    expect(await get(saved?.localPort as number)).toBe('the gateway')
    // Not remembered: memory only, never in app.json.
    expect(JSON.stringify(app.data)).not.toContain(PASSWORD)
    expect(await store.getSecret(id, 'password')).toBe(PASSWORD)
    // The password went over the wire once per dial that had it, never twice in one.
    expect(ssh.attempts.filter((m) => m === 'password')).toHaveLength(1)
    // The two failed connects' links were ended.
    expect(links.length).toBe(3)
  })

  it('a cancel after the host key leaves nothing, and no connection lives on', async () => {
    const gateway = await startGateway()
    const ssh = await startSsh(gateway)
    const { service, app, writes } = realSetup()
    const request = { kind: 'ssh' as const, host: '127.0.0.1', port: ssh.port, user: 'alice', auth: { kind: 'password' as const } }
    await service.connect(request)
    expect(await service.connect({ ...request, answers: { hostKey: realKey.sha256 } })).toMatchObject({ need: { need: 'password' } })
    expect(writes.count).toBe(0)
    expect(app.data.remoteServers).toBeUndefined()
    const end = Date.now() + 5000
    while (ssh.closed() < ssh.clients.length && Date.now() < end) await new Promise((r) => setTimeout(r, 10))
    expect(ssh.closed()).toBe(ssh.clients.length)
  })

  it('a host the config sends through a jump host is refused with what to use instead, nothing saved', async () => {
    const { service, app, home } = realSetup()
    writeFileSync(join(home, '.ssh', 'config'), 'Host devbox\n  ProxyJump bastion\n')
    expect(await service.connect({ kind: 'ssh', host: 'devbox' })).toEqual({ ok: false, error: expect.stringContaining('goes through a jump host') })
    expect((await service.connect({ kind: 'ssh', host: 'devbox' })) as { error: string }).toMatchObject({ error: expect.stringContaining('use My own tunnel') })
    expect(app.data.remoteServers).toBeUndefined()
  })

  it('a wrong password asks again and sends it once', async () => {
    const gateway = await startGateway()
    const ssh = await startSsh(gateway)
    const { service, app } = realSetup()
    const request = { kind: 'ssh' as const, host: '127.0.0.1', port: ssh.port, user: 'alice', auth: { kind: 'password' as const } }
    expect(await service.connect({ ...request, answers: { hostKey: realKey.sha256, password: 'wrong' } })).toEqual({ ok: false, need: { need: 'password', again: true } })
    expect(ssh.attempts.filter((m) => m === 'password')).toHaveLength(1)
    expect(app.data.remoteServers).toBeUndefined()
  })
})
