// The remote desktop's coordinator (design-remote-desktop.md §3, §5.2, §6): what the picker's
// `remote.*` channels do. It ties the saved servers (remote-servers.ts), each SSH server's tunnel
// (ssh-tunnel.ts) and the windows (remote-windows.ts) together. No Electron import: every part comes
// in through an interface, so unit tests drive it with fakes (test/unit/remote-service.test.ts).
//
// The order of a connect, and why:
//  - SSH: `ccc web status` first (it gates the version and TLS before anything else runs, §8, §5.4,
//    and names the gateway's port), then, in link mode with no device cookie, one `ccc web add-device`
//    for a token, then the tunnel to that port on the saved local port (the page's origin, and with
//    it the web client's localStorage, stays the same), then the window at `http://127.0.0.1:<L>`.
//    A saved cookie means no token: the window loads with the cookie, and a revoked one is
//    RemoteWindows' re-pair. An up tunnel skips the status and the token (another window of the
//    server is open, or one closed less than 30 s ago).
//  - Direct: the link is parsed (`parseRemoteLink`), only its origin is saved, and its token is used
//    once for the window's sign-in. Opening a saved Direct server later has no token: the page shows
//    the server's own sign-in when the cookie is gone (Direct never re-pairs by itself, §6).
//  - One connect or open per server at a time: the server keeps one add-device token at a time
//    (auth.ts addDeviceLink), so two at once could void each other's.
//  - A connect that fails before any window of a server it just saved opened forgets that server
//    again: the form shows the error and the list keeps no half-made entry (a typo in a host).
//  - Errors are text for the form, never a throw at the picker: ssh's own words mapped by
//    ssh-tunnel.ts, the store's refusals, "unknown server".
//
// Tunnel ownership: the server's open windows hold it once (acquire on the first window, release in
// RemoteWindows' onAllClosed); the tunnel then stops by itself 30 s later. A tunnel that comes back
// on another local port (the saved one was taken meanwhile) moves the windows there (`setOrigin`)
// and is saved as the new preferred port.
import { errorText } from '../../shared/error-text'
import type { RemoteConnectAnswer, RemoteConnectRequest, RemoteConnectionState, RemoteServerInfo } from '../../shared/ipc'
import { checkCccOverride, checkSshHost, parseRemoteLink, type RemoteServer, type RemoteVia } from '../../shared/remote-servers'
import { warnLog } from '../warn-log'
import type { RemoteServerView } from './remote-servers'
import type { RemoteOpenRequest, RemoteWindowsStore } from './remote-windows'
import type { SshSpawn } from './ssh-process'
import { addDeviceToken, serverStatus, SshTunnel, type RemoteStatus, type TunnelState } from './ssh-tunnel'

/** A saved server without its cookie (what every reader outside the store gets). */
export type RemoteServerRecord = Omit<RemoteServer, 'cookie'>

/** The slice of RemoteServerStore the coordinator uses. */
export interface RemoteServiceStore {
  list(): Promise<RemoteServerView[]>
  get(id: string): RemoteServerRecord | undefined
  add(input: { name?: string; via: RemoteVia }): RemoteServerRecord
  rename(id: string, name: string): void
  forget(id: string): boolean
  setLocalPort(id: string, port: number): void
  hasCookie(id: string): boolean
}

/** The slice of RemoteWindows the coordinator uses. */
export interface RemoteServiceWindows {
  open(serverId: string, request: RemoteOpenRequest): Promise<void>
  setOrigin(serverId: string, origin: string): Promise<void>
  countOf(serverId: string): number
  refreshTitles(serverId: string): void
  forget(serverId: string): void
}

/** The slice of SshTunnel the coordinator uses. */
export interface RemoteTunnel {
  readonly state: TunnelState
  /** The local port while up, else undefined. */
  readonly port: number | undefined
  acquire(): void
  release(): void
  start(remotePort: number, preferred?: number): Promise<number>
  dispose(): void
}

export interface RemoteTunnelHooks {
  onState(state: TunnelState): void
  onPort(port: number): void
}

/** The SSH side: the two `ccc web` commands and the tunnel. `sshOver` in the app, fakes in tests. */
export interface RemoteSsh {
  status(host: string, ccc?: string): Promise<RemoteStatus>
  addDevice(host: string, ccc?: string): Promise<string>
  tunnel(host: string, hooks: RemoteTunnelHooks): RemoteTunnel
}

/** The real SSH side over the person's `ssh` (ssh-process.ts `createSshSpawn`). */
export function sshOver(spawn: SshSpawn): RemoteSsh {
  return {
    status: (host, ccc) => serverStatus(spawn, host, ccc),
    addDevice: (host, ccc) => addDeviceToken(spawn, host, ccc),
    tunnel: (host, hooks) => new SshTunnel({ host, spawn, onState: hooks.onState, onPort: hooks.onPort })
  }
}

export interface RemoteServiceOptions {
  store: RemoteServiceStore
  windows: RemoteServiceWindows
  ssh: RemoteSsh
  /**
   * Awaited before any ssh runs: the login env (index.ts), which carries the person's
   * `SSH_AUTH_SOCK` and a PATH that finds their `ssh`. A connect right after start waits for it.
   */
  ready?(): Promise<void>
  /** Empty a forgotten server's partition (ElectronRemoteWindowFactory.clearSession). */
  clearSession(serverId: string): Promise<void>
  /** A window was opened or focused from the picker: the picker closes (WindowManager.remoteWindowOpened). */
  opened?(): void
  /** What `list` answers changed (the picker's `remote.changed`). */
  onChanged?(): void
  log?(message: string): void
}

type Failure = { ok: false; error: string }

function fail(error: string): Failure {
  return { ok: false, error }
}

/** The page origin through a tunnel on local port `port`. */
export function tunnelOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** A tunnel's state as the picker row shows it (no port: the picker has no use for it). */
export function connectionOf(state: TunnelState | undefined): RemoteConnectionState {
  if (state === undefined || state.state === 'stopped') return { state: 'stopped' }
  if (state.state === 'connecting') return { state: 'connecting' }
  if (state.state === 'up') return { state: 'up' }
  return { state: 'down', error: state.error, retrying: state.retryInMs !== undefined }
}

/**
 * The store as RemoteWindows writes it (a recent project, a cookie landing or dropped), telling the
 * picker after each write: those change what `remote.list` answers.
 */
export function notifyingStore(store: RemoteWindowsStore, changed: () => void): RemoteWindowsStore {
  return {
    get: (id) => store.get(id),
    recordRecent: (id, projectId, name, at) => {
      store.recordRecent(id, projectId, name, at)
      changed()
    },
    getCookie: (id) => store.getCookie(id),
    setCookie: async (id, cookie) => {
      try {
        return await store.setCookie(id, cookie)
      } finally {
        changed()
      }
    },
    clearCookie: (id) => {
      store.clearCookie(id)
      changed()
    }
  }
}

export class RemoteService {
  private readonly options: RemoteServiceOptions
  private readonly log: (message: string) => void
  private readonly tunnels = new Map<string, RemoteTunnel>()
  /** SSH servers whose tunnel their open windows hold (acquired once, released when the last closes). */
  private readonly held = new Set<string>()
  /**
   * Servers that signed in with a token in this run. With no keyring nothing is saved, but the
   * partition still holds the session cookie until quit: a reopen then needs no new device (and a
   * cookie that stopped working is RemoteWindows' re-pair).
   */
  private readonly signedIn = new Set<string>()
  /** The last connect, open or forget of each server; the next one waits for it. */
  private readonly queues = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: RemoteServiceOptions) {
    this.options = options
    this.log = options.log ?? warnLog
  }

  /** The saved servers for the picker: no cookie, no port; window counts and the tunnel's state. */
  async list(): Promise<RemoteServerInfo[]> {
    const servers = await this.options.store.list()
    return servers.map((s) => {
      const info: RemoteServerInfo = {
        id: s.id,
        name: s.name,
        via: s.via,
        recent: s.recent,
        cookieSaved: s.cookieSaved,
        cookieKept: s.cookieKept,
        windows: this.options.windows.countOf(s.id)
      }
      if (s.via.kind === 'ssh') info.connection = connectionOf(this.tunnels.get(s.id)?.state)
      return info
    })
  }

  /** The Connect to server form: save (or find) the server, then open its web picker. */
  async connect(request: RemoteConnectRequest): Promise<RemoteConnectAnswer> {
    if (this.disposed) return fail('the app is quitting')
    let via: RemoteVia
    let token: string | undefined
    if (request.kind === 'direct') {
      const link = parseRemoteLink(request.link)
      if ('error' in link) return fail(link.error)
      via = { kind: 'direct', origin: link.origin }
      token = link.token
    } else {
      // Checked before any ssh runs; the store checks the same again when saving.
      const host = request.host.trim()
      const hostProblem = checkSshHost(host)
      if (hostProblem !== undefined) return fail(hostProblem)
      const ccc = request.ccc?.trim() ?? ''
      if (ccc !== '') {
        const cccProblem = checkCccOverride(ccc)
        if (cccProblem !== undefined) return fail(`the ccc path: ${cccProblem}`)
      }
      via = ccc === '' ? { kind: 'ssh', host } : { kind: 'ssh', host, ccc }
    }
    let server: RemoteServerRecord
    let isNew: boolean
    try {
      const before = new Set((await this.options.store.list()).map((s) => s.id))
      server = this.options.store.add(request.name === undefined ? { via } : { name: request.name, via })
      isNew = !before.has(server.id)
    } catch (err) {
      return fail(errorText(err))
    }
    if (isNew) this.changed()
    const id = server.id
    const answer = await this.run(id, () => this.openNow(id, undefined, token))
    // Nothing of a server that never opened stays behind (unless a window of it opened meanwhile).
    // No window of it ever opened, so its partition was never made: nothing to clear there.
    if (!answer.ok && isNew && this.options.windows.countOf(id) === 0) await this.run(id, () => this.forgetNow(id, false))
    return answer
  }

  /** Open (or focus) a saved server's project, or its web picker when `projectId` is absent. */
  async open(serverId: string, projectId?: string): Promise<RemoteConnectAnswer> {
    if (this.disposed) return fail('the app is quitting')
    if (this.options.store.get(serverId) === undefined) return fail('this server is not saved any more')
    return this.run(serverId, () => this.openNow(serverId, projectId, undefined))
  }

  rename(serverId: string, name: string): { ok: true } | Failure {
    try {
      this.options.store.rename(serverId, name)
    } catch (err) {
      return fail(errorText(err))
    }
    this.options.windows.refreshTitles(serverId)
    this.changed()
    return { ok: true }
  }

  /**
   * Forget a server: its windows close, its partition is emptied, its tunnel stops, then the record
   * goes (with the encrypted cookie). Waits for a connect or open of it that is under way.
   */
  forget(serverId: string): Promise<void> {
    return this.run(serverId, () => this.forgetNow(serverId, true))
  }

  /** RemoteWindows' re-pair: one add-device token over the person's ssh (SSH servers only). */
  async mintToken(server: RemoteServerRecord): Promise<string> {
    if (server.via.kind !== 'ssh') throw new Error('a Direct server signs in with a new link from the server')
    await this.options.ready?.()
    const token = await this.options.ssh.addDevice(server.via.host, server.via.ccc)
    this.signedIn.add(server.id)
    return token
  }

  /** RemoteWindows' onAllClosed: the server's last window closed, so its tunnel may stop (30 s later). */
  allClosed(serverId: string): void {
    if (this.held.delete(serverId)) this.tunnels.get(serverId)?.release()
    this.changed()
  }

  /** Tell the picker (`remote.changed`). */
  changed(): void {
    this.options.onChanged?.()
  }

  /** Quit: every tunnel stopped now (SIGTERM, its process group); no connect starts after this. */
  dispose(): void {
    this.disposed = true
    for (const tunnel of this.tunnels.values()) tunnel.dispose()
    this.tunnels.clear()
    this.held.clear()
  }

  // -------------------------------------------------------------------------------------------

  private async openNow(serverId: string, projectId: string | undefined, token: string | undefined): Promise<RemoteConnectAnswer> {
    try {
      if (this.disposed) return fail('the app is quitting')
      const server = this.options.store.get(serverId)
      if (server === undefined) return fail('this server is not saved any more')
      if (server.via.kind === 'direct') {
        await this.showWindow(server, { origin: server.via.origin, ...(projectId === undefined ? {} : { projectId }), ...(token === undefined ? {} : { token }) })
        return { ok: true, serverId }
      }
      const { host, ccc } = server.via
      await this.options.ready?.()
      if (this.disposed) return fail('the app is quitting')
      const tunnel = this.tunnelOf(serverId, host)
      let port = tunnel.port
      let pairToken: string | undefined
      if (port === undefined) {
        const status = await this.options.ssh.status(host, ccc)
        // Link mode only: in password mode the server's own page asks the person once; confirm and
        // none have nothing a token would fix. A saved cookie (or one this run already got) loads as
        // is; RemoteWindows re-pairs when the server no longer takes it.
        if (status.mode === 'link' && !this.options.store.hasCookie(serverId) && !this.signedIn.has(serverId)) {
          pairToken = await this.options.ssh.addDevice(host, ccc)
        }
        port = await tunnel.start(status.port, server.localPort)
      }
      if (this.disposed) return fail('the app is quitting')
      await this.showWindow(server, {
        origin: tunnelOrigin(port),
        ...(projectId === undefined ? {} : { projectId }),
        ...(pairToken === undefined ? {} : { token: pairToken })
      })
      if (pairToken !== undefined) this.signedIn.add(serverId)
      return { ok: true, serverId }
    } catch (err) {
      const text = errorText(err)
      this.log(`remote ${serverId}: connecting failed: ${text}`)
      return fail(text)
    }
  }

  private async showWindow(server: RemoteServerRecord, request: RemoteOpenRequest): Promise<void> {
    await this.options.windows.open(server.id, request)
    // The window is there (the close event of one cannot have run yet: it is a later task), so the
    // tunnel is held for it, once per server.
    if (server.via.kind === 'ssh' && !this.held.has(server.id) && this.options.windows.countOf(server.id) > 0) {
      const tunnel = this.tunnels.get(server.id)
      if (tunnel !== undefined) {
        tunnel.acquire()
        this.held.add(server.id)
      }
    }
    this.options.opened?.()
    this.changed()
  }

  private async forgetNow(serverId: string, clear: boolean): Promise<void> {
    // Windows first (their pages stop using the partition and the tunnel), then the partition, then
    // the tunnel, then the record: a failure on the way leaves a record the person can forget again.
    this.options.windows.forget(serverId)
    this.held.delete(serverId)
    this.signedIn.delete(serverId)
    if (clear) {
      try {
        await this.options.clearSession(serverId)
      } catch (err) {
        this.log(`remote ${serverId}: clearing its window data failed: ${errorText(err)}`)
      }
    }
    const tunnel = this.tunnels.get(serverId)
    this.tunnels.delete(serverId)
    tunnel?.dispose()
    this.options.store.forget(serverId)
    this.changed()
  }

  private tunnelOf(serverId: string, host: string): RemoteTunnel {
    const known = this.tunnels.get(serverId)
    if (known !== undefined) return known
    const tunnel = this.options.ssh.tunnel(host, {
      onState: () => this.changed(),
      onPort: (port) => this.tunnelPort(serverId, port)
    })
    this.tunnels.set(serverId, tunnel)
    return tunnel
  }

  /**
   * The tunnel settled on `port` (a first start, or a restart that found the saved port taken):
   * kept as the preferred port, and open windows move to the new origin. On a first start no window
   * exists yet and `setOrigin` does nothing; the window opens on this origin.
   */
  private tunnelPort(serverId: string, port: number): void {
    if (this.tunnels.get(serverId) === undefined) return
    const server = this.options.store.get(serverId)
    if (server === undefined) return
    if (server.localPort !== port) {
      try {
        this.options.store.setLocalPort(serverId, port)
      } catch (err) {
        this.log(`remote ${serverId}: saving the tunnel's port failed: ${errorText(err)}`)
      }
    }
    void this.options.windows
      .setOrigin(serverId, tunnelOrigin(port))
      .catch((err: unknown) => this.log(`remote ${serverId}: moving its windows to the new port failed: ${errorText(err)}`))
  }

  /** Run `work` after the server's previous connect, open or forget has settled. */
  private run<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(serverId) ?? Promise.resolve()
    const next = previous.then(work)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(serverId, settled)
    void settled.then(() => {
      if (this.queues.get(serverId) === settled) this.queues.delete(serverId)
    })
    return next
  }
}
