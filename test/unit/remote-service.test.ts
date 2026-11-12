// RemoteService (main/remote/remote-service.ts): what the picker's remote.* channels do. The real
// RemoteServerStore over an in-memory app.json and the fake secret store; fakes for the ssh side,
// the tunnel and the windows, so the order of every step is visible.
import { describe, expect, it } from 'vitest'
import { RemoteServerStore, type RemoteServersApp } from '../../src/main/remote/remote-servers'
import { connectionOf, notifyingStore, RemoteService, tunnelOrigin, type RemoteSsh, type RemoteTunnel, type RemoteTunnelHooks } from '../../src/main/remote/remote-service'
import type { RemoteOpenRequest } from '../../src/main/remote/remote-windows'
import type { RemoteStatus, TunnelState } from '../../src/main/remote/ssh-tunnel'
import { SshError } from '../../src/main/remote/ssh-tunnel'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import type { AppSettings, WebAccessMode } from '../../src/shared/types'

class FakeTunnel implements RemoteTunnel {
  state: TunnelState = { state: 'stopped' }
  users = 0
  starts: Array<{ remote: number; preferred?: number }> = []
  disposed = false
  /** The local port the next start settles on. */
  nextPort = 41000
  /** The next start rejects with this. */
  failWith: string | undefined

  constructor(
    readonly host: string,
    readonly hooks: RemoteTunnelHooks,
    private readonly steps: string[]
  ) {}

  get port(): number | undefined {
    return this.state.state === 'up' ? this.state.localPort : undefined
  }

  acquire(): void {
    this.users++
    this.steps.push('acquire')
  }

  release(): void {
    this.users--
    this.steps.push('release')
  }

  async start(remote: number, preferred?: number): Promise<number> {
    this.starts.push(preferred === undefined ? { remote } : { remote, preferred })
    this.steps.push(`tunnel ${remote}`)
    if (this.failWith !== undefined) throw new SshError(this.failWith)
    const port = preferred ?? this.nextPort
    this.hooks.onPort(port)
    this.up(port)
    return port
  }

  up(port: number): void {
    this.state = { state: 'up', localPort: port }
    this.hooks.onState(this.state)
  }

  dispose(): void {
    this.disposed = true
    this.steps.push('tunnel dispose')
    this.state = { state: 'stopped' }
  }
}

class FakeSsh implements RemoteSsh {
  mode: WebAccessMode = 'link'
  gatewayPort = 8765
  statusError: string | undefined
  tokens = 0
  tunnels: FakeTunnel[] = []
  /** Every tunnel made from now on fails to start with this. */
  tunnelFailWith: string | undefined

  constructor(private readonly steps: string[]) {}

  async status(host: string, ccc?: string): Promise<RemoteStatus> {
    this.steps.push(`status ${host}${ccc === undefined ? '' : ` ${ccc}`}`)
    if (this.statusError !== undefined) throw new SshError(this.statusError)
    return { port: this.gatewayPort, mode: this.mode, version: '0.17.0' }
  }

  async addDevice(host: string): Promise<string> {
    this.steps.push(`add-device ${host}`)
    return `tok${++this.tokens}`
  }

  tunnel(host: string, hooks: RemoteTunnelHooks): RemoteTunnel {
    const t = new FakeTunnel(host, hooks, this.steps)
    t.failWith = this.tunnelFailWith
    this.tunnels.push(t)
    return t
  }
}

class FakeWindows {
  opens: Array<{ serverId: string } & RemoteOpenRequest> = []
  origins: Array<{ serverId: string; origin: string }> = []
  counts = new Map<string, number>()
  titled: string[] = []
  forgotten: string[] = []
  /** Called for a server's last window closing (RemoteWindows' onAllClosed). */
  allClosed: (serverId: string) => void = () => {}

  constructor(private readonly steps: string[]) {}

  async open(serverId: string, request: RemoteOpenRequest): Promise<void> {
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

function setup(): {
  service: RemoteService
  store: RemoteServerStore
  app: RemoteServersApp & { data: AppSettings }
  ssh: FakeSsh
  windows: FakeWindows
  steps: string[]
  opened: { count: number }
  changes: { count: number }
} {
  const steps: string[] = []
  const app = {
    data: {} as AppSettings,
    update(mutate: (data: AppSettings) => void) {
      mutate(app.data)
    }
  }
  let ids = 0
  const store = new RemoteServerStore({ app, secrets: fakeSecretStore(), newId: () => `srv${++ids}` })
  const ssh = new FakeSsh(steps)
  const windows = new FakeWindows(steps)
  const opened = { count: 0 }
  const changes = { count: 0 }
  const service = new RemoteService({
    store,
    windows,
    ssh,
    ready: async () => {
      steps.push('ready')
    },
    clearSession: async (serverId) => {
      steps.push(`clear ${serverId}`)
    },
    opened: () => opened.count++,
    onChanged: () => changes.count++,
    log: () => {}
  })
  windows.allClosed = (serverId) => service.allClosed(serverId)
  return { service, store, app, ssh, windows, steps, opened, changes }
}

describe('RemoteService: SSH', () => {
  it('connect in link mode with no cookie: status, add-device, tunnel, then the window with the token', async () => {
    const { service, store, ssh, windows, steps, opened } = setup()
    const answer = await service.connect({ kind: 'ssh', host: 'devbox', name: 'Dev box' })
    expect(answer).toEqual({ ok: true, serverId: 'srv1' })
    expect(steps).toEqual(['ready', 'status devbox', 'add-device devbox', 'tunnel 8765', `window ${tunnelOrigin(41000)} #t=tok1`, 'acquire'])
    // The settled port is the server's preferred one from now on.
    expect(store.get('srv1')).toMatchObject({ name: 'Dev box', via: { kind: 'ssh', host: 'devbox' }, localPort: 41000 })
    expect(windows.opens[0]).toEqual({ serverId: 'srv1', origin: 'http://127.0.0.1:41000', token: 'tok1' })
    expect(ssh.tunnels).toHaveLength(1)
    expect(ssh.tunnels[0]!.users).toBe(1)
    // The picker closes once the window is there.
    expect(opened.count).toBe(1)
  })

  it('a typed user@host is saved split and given back to ssh whole', async () => {
    const { service, store, steps } = setup()
    expect(await service.connect({ kind: 'ssh', host: 'me@devbox' })).toEqual({ ok: true, serverId: 'srv1' })
    expect(store.get('srv1')?.via).toEqual({ kind: 'ssh', host: 'devbox', user: 'me' })
    expect(steps.slice(0, 3)).toEqual(['ready', 'status me@devbox', 'add-device me@devbox'])
  })

  it('refuses, without running ssh, a record the spawned ssh cannot express (a port, a sign-in, My own tunnel)', async () => {
    const { service, app, steps } = setup()
    app.data.remoteServers = [
      { id: 'p', name: 'p', via: { kind: 'ssh', host: 'devbox', port: 2222 }, recent: [] },
      { id: 'k', name: 'k', via: { kind: 'ssh', host: 'devbox', auth: { kind: 'password' } }, recent: [] },
      { id: 't', name: 't', via: { kind: 'tunnel', localPort: 7331, remotePort: 7330 }, recent: [] }
    ]
    for (const id of ['p', 'k']) expect(await service.open(id)).toEqual({ ok: false, error: expect.stringContaining('built-in SSH') })
    expect(await service.open('t')).toEqual({ ok: false, error: expect.stringContaining('My own tunnel') })
    expect(steps).toEqual([])
  })

  it('passes the ccc override to every remote command', async () => {
    const { service, steps } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox', ccc: '/opt/cc/ccc' })
    expect(steps.slice(0, 2)).toEqual(['ready', 'status devbox /opt/cc/ccc'])
  })

  it('a saved cookie needs no token, and the saved local port is asked for', async () => {
    const { service, store, ssh, steps, windows } = setup()
    const server = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    store.setLocalPort(server.id, 42424)
    await store.setCookie(server.id, 'ccc_device=abc')
    const answer = await service.open(server.id, 'p1')
    expect(answer).toEqual({ ok: true, serverId: server.id })
    expect(steps).not.toContain('add-device devbox')
    expect(ssh.tunnels[0]!.starts).toEqual([{ remote: 8765, preferred: 42424 }])
    expect(windows.opens[0]).toEqual({ serverId: server.id, origin: 'http://127.0.0.1:42424', projectId: 'p1' })
  })

  it.each(['password', 'confirm', 'none'] as const)('mode %s mints no token', async (mode) => {
    const { service, ssh, steps, windows } = setup()
    ssh.mode = mode
    await service.connect({ kind: 'ssh', host: 'devbox' })
    expect(steps).not.toContain('add-device devbox')
    expect(windows.opens[0]!.token).toBeUndefined()
  })

  it('an up tunnel skips the status and the token; the tunnel is held once per server', async () => {
    const { service, ssh, steps, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    steps.length = 0
    await service.open('srv1', 'p2')
    expect(steps).toEqual(['ready', 'window http://127.0.0.1:41000 p2'])
    expect(ssh.tunnels[0]!.users).toBe(1)
    expect(windows.opens.at(-1)).toEqual({ serverId: 'srv1', origin: 'http://127.0.0.1:41000', projectId: 'p2' })
  })

  it('the last window closing releases the tunnel; the next open holds it again', async () => {
    const { service, ssh, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    const tunnel = ssh.tunnels[0]!
    windows.closeAll('srv1')
    expect(tunnel.users).toBe(0)
    // A second notice for the same server releases nothing more.
    service.allClosed('srv1')
    expect(tunnel.users).toBe(0)
    await service.open('srv1')
    expect(tunnel.users).toBe(1)
  })

  it('a reconnect in the same run after a token sign-in mints no second device (no keyring keeps nothing)', async () => {
    const { service, ssh, steps, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    windows.closeAll('srv1')
    // The tunnel stopped after its idle time.
    ssh.tunnels[0]!.state = { state: 'stopped' }
    steps.length = 0
    await service.open('srv1')
    expect(steps).toEqual(['ready', 'status devbox', 'tunnel 8765', 'window http://127.0.0.1:41000', 'acquire'])
  })

  it('a tunnel that comes back on another port moves the windows there and saves the port', async () => {
    const { service, store, ssh, windows } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    ssh.tunnels[0]!.hooks.onPort(43000)
    expect(store.get('srv1')?.localPort).toBe(43000)
    expect(windows.origins).toEqual([
      // The first start's notice (no window yet: RemoteWindows ignores it), then the move.
      { serverId: 'srv1', origin: 'http://127.0.0.1:41000' },
      { serverId: 'srv1', origin: 'http://127.0.0.1:43000' }
    ])
  })

  it('an ssh failure is text for the form, and a server saved by that connect is forgotten again', async () => {
    const { service, store, ssh, windows, steps } = setup()
    ssh.statusError = 'ssh could not verify the host key of devbox. Run `ssh devbox` once in a terminal.'
    const answer = await service.connect({ kind: 'ssh', host: 'devbox' })
    expect(answer).toEqual({ ok: false, error: ssh.statusError })
    expect(await store.list()).toEqual([])
    // No window ever opened, so no partition to clear.
    expect(steps.some((s) => s.startsWith('clear'))).toBe(false)
    expect(windows.opens).toEqual([])
  })

  it('a tunnel failure of an already saved server keeps the server', async () => {
    const { service, store, ssh } = setup()
    const server = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    ssh.tunnelFailWith = 'ssh to devbox failed (exit code 255)'
    const answer = await service.open(server.id)
    expect(answer).toEqual({ ok: false, error: 'ssh to devbox failed (exit code 255)' })
    // Connecting to the same host again finds the saved record (not new): kept on failure too.
    const again = await service.connect({ kind: 'ssh', host: 'devbox' })
    expect(again.ok).toBe(false)
    expect((await store.list()).map((s) => s.id)).toEqual([server.id])
  })

  it('refuses a bad host or ccc path before any ssh runs', async () => {
    const { service, steps, store } = setup()
    expect(await service.connect({ kind: 'ssh', host: '-oProxyCommand=sh' })).toEqual({ ok: false, error: 'a host cannot start with "-"' })
    expect(await service.connect({ kind: 'ssh', host: 'a b' })).toMatchObject({ ok: false })
    expect(await service.connect({ kind: 'ssh', host: 'devbox', ccc: "/x'y" })).toMatchObject({ ok: false, error: expect.stringContaining('ccc path') })
    expect(steps).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it('one connect or open per server at a time: the second waits (one add-device token at a time)', async () => {
    const { service, steps } = setup()
    const a = service.connect({ kind: 'ssh', host: 'devbox' })
    const b = service.connect({ kind: 'ssh', host: 'devbox' })
    await Promise.all([a, b])
    // The second found the tunnel up: no second status, no second token.
    expect(steps.filter((s) => s.startsWith('add-device'))).toHaveLength(1)
    expect(steps.filter((s) => s.startsWith('status'))).toHaveLength(1)
  })

  it('mintToken is for SSH servers only and waits for the login env', async () => {
    const { service, store, steps } = setup()
    const sshServer = store.add({ via: { kind: 'ssh', host: 'devbox' } })
    await expect(service.mintToken(sshServer)).resolves.toBe('tok1')
    expect(steps).toEqual(['ready', 'add-device devbox'])
    const direct = store.add({ via: { kind: 'direct', origin: 'https://box.example' } })
    await expect(service.mintToken(direct)).rejects.toThrow(/new link/)
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
    // No ssh, no tunnel.
    expect(steps).toEqual(['window https://box.example:8765 #t=secret'])
    expect(opened.count).toBe(1)
  })

  it('open of a saved Direct server loads the page with no token (its own sign-in shows when needed)', async () => {
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

describe('RemoteService: list, rename, forget', () => {
  it('lists servers with no cookie text or port, with window counts and the tunnel state', async () => {
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

  it('maps the tunnel states for the picker', () => {
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

  it('forget: windows, then the partition, then the tunnel, then the record', async () => {
    const { service, store, ssh, steps } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    await store.setCookie('srv1', 'ccc_device=abc')
    steps.length = 0
    await service.forget('srv1')
    expect(steps).toEqual(['windows forget', 'release', 'clear srv1', 'tunnel dispose'])
    expect(ssh.tunnels[0]!.disposed).toBe(true)
    expect(store.get('srv1')).toBeUndefined()
    expect(store.hasCookie('srv1')).toBe(false)
    // A later open is refused as text.
    expect(await service.open('srv1')).toEqual({ ok: false, error: 'this server is not saved any more' })
  })

  it('tells the picker when the list changes', async () => {
    const { service, changes } = setup()
    await service.connect({ kind: 'direct', link: 'https://box.example' })
    const after = changes.count
    expect(after).toBeGreaterThan(0)
    service.rename('srv1', 'Home')
    expect(changes.count).toBe(after + 1)
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
    expect(store.get(server.id)?.recent).toEqual([{ projectId: 'p1', name: 'Project', at: 5 }])
  })

  it('dispose stops every tunnel and refuses later connects', async () => {
    const { service, ssh } = setup()
    await service.connect({ kind: 'ssh', host: 'devbox' })
    service.dispose()
    expect(ssh.tunnels[0]!.disposed).toBe(true)
    expect(await service.open('srv1')).toEqual({ ok: false, error: 'the app is quitting' })
  })
})
