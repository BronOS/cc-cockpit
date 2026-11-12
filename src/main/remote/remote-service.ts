// The remote desktop's coordinator (design-remote-desktop.md §3, §5, §6, §7): what the picker's
// `remote.*` channels do. It ties the saved servers (remote-servers.ts), each built-in SSH server's
// link (ssh-link.ts), My own tunnel's probe (tunnel-probe.ts) and the windows (remote-windows.ts)
// together. No Electron import: every part comes in through an interface, so unit tests drive it
// with fakes (test/unit/remote-service.test.ts).
//
// The order of a connect, and why:
//  - Built-in SSH: `ccc web status` first (it gates the version and TLS before anything else runs,
//    §8, §5.8, and names the gateway's port), then, in link mode with no device cookie, one
//    `ccc web add-device` for a token, then `acquire` (the tunnel's listener on the saved local port,
//    so the page's origin and its localStorage stay the same), then the window at
//    `http://127.0.0.1:<L>`. A saved cookie means no token: the window loads with it, and a revoked
//    one is RemoteWindows' re-pair (`mintToken`). An up link skips the status and the token.
//  - Asking the person (§5.4): every link call takes the connect's answers and may end with a
//    `need`, which goes back to the picker as is; the picker asks and calls again with all of its
//    answers. Main keeps no state across those calls but the link itself, and saves NOTHING (a new
//    record, a host key, a secret, the listener's port) until the dial and the pairing worked and the
//    window is about to open: a `need` halfway or a cancelled connect leaves nothing behind. A new
//    server is a draft record (`prepare`) the link reads through `linkStore` until then.
//  - A failed connect or open disposes the server's link unless windows hold it: a connection
//    trusted on an answer that was never saved must not live on, and a draft's link is nobody's.
//  - My own tunnel: the link's token only (an https link is refused, §5.8); the local port is probed
//    first (no cookie): something that is not a cc-cockpit gateway refuses before anything is saved;
//    nothing answering still opens the window, on main's waiting page (RemoteWindows' gate).
//  - Direct: the link is parsed (`parseRemoteLink`), only its origin is saved, and its token is used
//    once for the window's sign-in. Direct never re-pairs by itself (§7).
//  - One connect or open per server at a time: the server keeps one add-device token at a time
//    (auth.ts addDeviceLink), so two at once could void each other's. Connects of new servers also go
//    one at a time, so two Connects of one new host cannot save it twice.
//  - Errors are text for the form, never a throw at the picker.
//  - The background never asks: RemoteWindows' re-pair (`mintToken`) and the link's own redial run
//    with no answers, and a `need` there is an error with what to do.
//
// Link ownership: the server's open windows hold it once (acquire on the first window, release in
// RemoteWindows' onAllClosed); the link then stops by itself 30 s later. Its listener stays bound
// while windows hold it (across redials), so the origin cannot move under them.
import { join } from 'node:path'
import { errorText } from '../../shared/error-text'
import type { RemoteConnectAnswer, RemoteConnectionState, RemoteConnectRequest, RemoteEditRequest, RemoteServerInfo, RemoteServerSettings } from '../../shared/ipc'
import {
  checkCccOverride,
  checkSshHost,
  parseRemoteLink,
  type RemoteAnswers,
  type RemoteHostKey,
  type RemoteNeed,
  type RemoteSecretName,
  type RemoteServerRecord,
  type RemoteVia
} from '../../shared/remote-servers'
import { warnLog } from '../warn-log'
import { sameSettings, type RemoteServerView, type SecretResult } from './remote-servers'
import type { RemoteOpenRequest, RemoteWindowsStore } from './remote-windows'
import type { LinkAccepted, LinkAnswers, LinkResult, LinkState, RemoteLink, SshLinkStore } from './ssh-link'
import { probeTunnel, tunnelProbeError, type TunnelProbeResult } from './tunnel-probe'

/** A saved server without its credentials (what every reader outside the store gets). */
export type { RemoteServerRecord }

/** The slice of RemoteServerStore the coordinator uses. */
export interface RemoteServiceStore {
  list(): Promise<RemoteServerView[]>
  get(id: string): RemoteServerRecord | undefined
  prepare(input: { name?: string; via: RemoteVia }): { record: RemoteServerRecord; saved: boolean; via: RemoteVia }
  insert(record: RemoteServerRecord): RemoteServerRecord
  edit(id: string, input: { name?: string; via: RemoteVia }): { viaChanged: boolean; renamed: boolean }
  rename(id: string, name: string): void
  forget(id: string): boolean
  setLocalPort(id: string, port: number): void
  hasCookie(id: string): boolean
  getSecret(id: string, name: RemoteSecretName): Promise<string | undefined>
  setSecret(id: string, name: RemoteSecretName, value: string, options: { remember: boolean }): Promise<SecretResult>
  setHostKey(id: string, key: RemoteHostKey): void
}

/** The slice of RemoteWindows the coordinator uses. */
export interface RemoteServiceWindows {
  open(serverId: string, request: RemoteOpenRequest): Promise<void>
  setOrigin(serverId: string, origin: string): Promise<void>
  countOf(serverId: string): number
  refreshTitles(serverId: string): void
  forget(serverId: string): void
}

export interface RemoteServiceOptions {
  store: RemoteServiceStore
  windows: RemoteServiceWindows
  /**
   * A built-in SSH server's link (SshLink in the app: `home` os.homedir(), env the login env). It
   * reads the record and secrets only through `store`, which also serves a server not saved yet.
   */
  link(serverId: string, store: SshLinkStore): RemoteLink
  /** My own tunnel's probe of a local port (tunnel-probe.ts `probeTunnel` by default). */
  probe?(localPort: number): Promise<TunnelProbeResult>
  /**
   * Awaited before a link's first call: the login env (index.ts), which carries the person's
   * `SSH_AUTH_SOCK` (a GUI start may have none in `process.env`).
   */
  ready?(): Promise<void>
  /** Empty a forgotten server's partition (ElectronRemoteWindowFactory.clearSession). */
  clearSession(serverId: string): Promise<void>
  /** The native open dialog (dialogs/electron-dialog.ts), a sheet on window `parentWindowId`; undefined when cancelled. */
  pickFile?(parentWindowId: number, defaultPath: string): Promise<string | undefined>
  /** The person's home: the key file dialog starts in `<home>/.ssh`. */
  home?: string
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

/** The page origin through a tunnel on local port `port` (either kind). */
export function tunnelOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** A link's state as the picker row shows it (no port: the picker has no use for it). */
export function connectionOf(state: LinkState | undefined): RemoteConnectionState {
  if (state === undefined || state.state === 'stopped') return { state: 'stopped' }
  if (state.state === 'connecting') return { state: 'connecting' }
  if (state.state === 'up') return { state: 'up' }
  return { state: 'down', error: state.error, retrying: state.retryInMs !== undefined }
}

/** A `need` met where nobody can be asked (a re-pair in the background): what to do instead. */
export function backgroundNeedText(need: RemoteNeed, server: RemoteServerRecord): string {
  if (need.need === 'hostKey') return `the host key of ${server.name} is not trusted yet: open the server from the project picker`
  if (need.need === 'password') return `${server.name} needs its password again: open the server from the project picker`
  return `the key ${need.path} needs its passphrase again: open the server from the project picker`
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

/** A request's settings checked into a `via`, the name, and a token to sign in with once. */
interface Parsed {
  via: RemoteVia
  name?: string
  token?: string
}

/**
 * The form's settings as a `via` (the store checks every field again when saving): the SSH host and
 * `ccc` path before any dial; a tunnel's link reduced to its token (https refused, §5.8); Direct's
 * link to its origin and token.
 */
function parseSettings(request: RemoteServerSettings): Parsed | Failure {
  const named = request.name === undefined || request.name.trim() === '' ? {} : { name: request.name }
  if (request.kind === 'direct') {
    const link = parseRemoteLink(request.link)
    if ('error' in link) return fail(link.error)
    return { via: { kind: 'direct', origin: link.origin }, ...named, ...(link.token === undefined ? {} : { token: link.token }) }
  }
  if (request.kind === 'tunnel') {
    const via: RemoteVia = { kind: 'tunnel', localPort: request.localPort, remotePort: request.remotePort }
    const sshHost = request.sshHost?.trim() ?? ''
    if (sshHost !== '') via.sshHost = sshHost
    const text = request.link?.trim() ?? ''
    if (text === '') return { via, ...named }
    const link = parseRemoteLink(text)
    if ('error' in link) return fail(link.error)
    if (link.origin.startsWith('https:')) {
      return fail('this server serves https; connect with Link and its address, or turn TLS off on the server: the SSH tunnel encrypts already')
    }
    // Only the token: the link's own origin is the server's view of itself, not reachable from here.
    return { via, ...named, ...(link.token === undefined ? {} : { token: link.token }) }
  }
  const host = request.host.trim()
  const hostProblem = checkSshHost(host)
  if (hostProblem !== undefined) return fail(hostProblem)
  const ccc = request.ccc?.trim() ?? ''
  if (ccc !== '') {
    const cccProblem = checkCccOverride(ccc)
    if (cccProblem !== undefined) return fail(`the ccc path: ${cccProblem}`)
  }
  const user = request.user?.trim() ?? ''
  const via: RemoteVia = {
    kind: 'ssh',
    host,
    ...(user === '' ? {} : { user }),
    ...(request.port === undefined ? {} : { port: request.port }),
    ...(request.auth === undefined ? {} : { auth: request.auth }),
    ...(ccc === '' ? {} : { ccc })
  }
  return { via, ...named }
}

/** The answers a link call takes (the secrets for that call only; `remember` is the service's). */
function linkAnswersOf(answers: RemoteAnswers): LinkAnswers {
  return {
    ...(answers.hostKey === undefined ? {} : { hostKey: answers.hostKey }),
    ...(answers.password === undefined ? {} : { password: answers.password }),
    ...(answers.passphrase === undefined ? {} : { passphrase: answers.passphrase })
  }
}

interface LinkEntry {
  link: RemoteLink
  unsubscribe: () => void
}

export class RemoteService {
  private readonly options: RemoteServiceOptions
  private readonly log: (message: string) => void
  private readonly probe: (localPort: number) => Promise<TunnelProbeResult>
  private readonly links = new Map<string, LinkEntry>()
  /** New servers being connected: the link reads these until the record is saved. */
  private readonly drafts = new Map<string, RemoteServerRecord>()
  /** SSH servers whose link their open windows hold (acquired once, released when the last closes). */
  private readonly held = new Set<string>()
  /**
   * Servers that signed in with a token in this run. With no keyring nothing is saved, but the
   * partition still holds the session cookie until quit: a reopen then needs no new device (and a
   * cookie that stopped working is RemoteWindows' re-pair).
   */
  private readonly signedIn = new Set<string>()
  /** The last connect, open, edit or forget of each server (and `connect` for new ones); the next waits for it. */
  private readonly queues = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: RemoteServiceOptions) {
    this.options = options
    this.log = options.log ?? warnLog
    this.probe = options.probe ?? ((port) => probeTunnel(port))
  }

  /** The saved servers for the picker: no credential, no port; window counts and the link's state. */
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
        remembered: s.remembered,
        windows: this.options.windows.countOf(s.id)
      }
      if (s.via.kind === 'ssh') info.connection = connectionOf(this.links.get(s.id)?.link.state)
      return info
    })
  }

  /** The Connect to server form: connect (a new server is saved only once its window opens), then open its web picker. */
  async connect(request: RemoteConnectRequest): Promise<RemoteConnectAnswer> {
    if (this.disposed) return fail('the app is quitting')
    const parsed = parseSettings(request)
    if ('error' in parsed) return parsed
    const answers = request.kind === 'ssh' ? (request.answers ?? {}) : {}
    return this.run('connect', async () => {
      let prepared: ReturnType<RemoteServiceStore['prepare']>
      try {
        prepared = this.options.store.prepare({ ...(parsed.name === undefined ? {} : { name: parsed.name }), via: parsed.via })
      } catch (err) {
        return fail(errorText(err))
      }
      const id = prepared.record.id
      if (prepared.saved) {
        // Connect never rewrites a saved server's settings behind the person's back: Edit does.
        if (!sameSettings(prepared.record.via, prepared.via)) {
          return fail(`this server is saved already as "${prepared.record.name}" with other settings; use Edit to change them`)
        }
        return this.run(id, () => this.openNow(id, undefined, parsed.token, answers))
      }
      this.drafts.set(id, prepared.record)
      try {
        return await this.run(id, () => this.openNow(id, undefined, parsed.token, answers))
      } finally {
        this.drafts.delete(id)
      }
    })
  }

  /** Open (or focus) a saved server's project, or its web picker when `projectId` is absent. */
  async open(serverId: string, projectId?: string, answers: RemoteAnswers = {}): Promise<RemoteConnectAnswer> {
    if (this.disposed) return fail('the app is quitting')
    if (this.options.store.get(serverId) === undefined) return fail('this server is not saved any more')
    return this.run(serverId, () => this.openNow(serverId, projectId, undefined, answers))
  }

  /**
   * Edit a saved server (design §3): its settings change in place (the store says what that drops).
   * A changed connection ends the server's SSH link (it was made with the old settings; the next
   * open dials again) and moves the windows of a tunnel or Direct server to the new origin. A link
   * with a token signs in with it, opening the server's web picker; otherwise nothing dials.
   */
  async edit(request: RemoteEditRequest): Promise<RemoteConnectAnswer> {
    if (this.disposed) return fail('the app is quitting')
    const { serverId } = request
    const parsed = parseSettings(request)
    if ('error' in parsed) return parsed
    return this.run(serverId, async () => {
      if (this.disposed) return fail('the app is quitting')
      if (this.options.store.get(serverId) === undefined) return fail('this server is not saved any more')
      let result: { viaChanged: boolean; renamed: boolean }
      try {
        result = this.options.store.edit(serverId, { ...(parsed.name === undefined ? {} : { name: parsed.name }), via: parsed.via })
      } catch (err) {
        return fail(errorText(err))
      }
      if (result.viaChanged) {
        this.dropLink(serverId)
        this.signedIn.delete(serverId)
        const via = this.options.store.get(serverId)?.via
        const origin = via?.kind === 'tunnel' ? tunnelOrigin(via.localPort) : via?.kind === 'direct' ? via.origin : undefined
        if (origin !== undefined) {
          await this.options.windows
            .setOrigin(serverId, origin)
            .catch((err: unknown) => this.log(`remote ${serverId}: moving its windows to the new address failed: ${errorText(err)}`))
        }
      }
      if (result.renamed) this.options.windows.refreshTitles(serverId)
      this.changed()
      if (parsed.token !== undefined) return this.openNow(serverId, undefined, parsed.token, {})
      return { ok: true, serverId }
    })
  }

  /** The key file Browse button: the native dialog in `~/.ssh`. */
  async pickKey(parentWindowId: number): Promise<string | null> {
    if (this.options.pickFile === undefined) return null
    const start = this.options.home === undefined ? '' : join(this.options.home, '.ssh')
    return (await this.options.pickFile(parentWindowId, start)) ?? null
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
   * Forget a server: its windows close, its partition is emptied, its link ends, then the record goes
   * (with the encrypted cookie and secrets, its host key and the secrets held in memory). Waits for
   * a connect or open of it that is under way.
   */
  forget(serverId: string): Promise<void> {
    return this.run(serverId, async () => {
      // Windows first (their pages stop using the partition and the link), then the partition, then
      // the link, then the record: a failure on the way leaves a record the person can forget again.
      this.options.windows.forget(serverId)
      this.held.delete(serverId)
      this.signedIn.delete(serverId)
      try {
        await this.options.clearSession(serverId)
      } catch (err) {
        this.log(`remote ${serverId}: clearing its window data failed: ${errorText(err)}`)
      }
      this.dropLink(serverId)
      this.options.store.forget(serverId)
      this.changed()
    })
  }

  /**
   * RemoteWindows' re-pair: one add-device token over the server's link (built-in SSH only). It runs
   * in the background, so it never asks: a `need` is an error saying what to do.
   */
  async mintToken(server: RemoteServerRecord): Promise<string> {
    if (server.via.kind !== 'ssh') throw new Error('this server signs in with a new link from the server')
    await this.options.ready?.()
    if (this.disposed) throw new Error('the app is quitting')
    const result = await this.linkOf(server.id).addDevice()
    if (!result.ok) throw new Error('need' in result ? backgroundNeedText(result.need, server) : result.error)
    this.signedIn.add(server.id)
    return result.value
  }

  /** RemoteWindows' onAllClosed: the server's last window closed, so its link may stop (30 s later). */
  allClosed(serverId: string): void {
    if (this.held.delete(serverId)) this.links.get(serverId)?.link.release()
    this.changed()
  }

  /** Tell the picker (`remote.changed`). */
  changed(): void {
    this.options.onChanged?.()
  }

  /** Quit: every link ended now; no connect starts after this. */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.links.keys()]) this.dropLink(id)
    this.held.clear()
  }

  // -------------------------------------------------------------------------------------------

  /** Server `serverId` (saved, or the draft of the connect under way) as the link and the steps see it. */
  private record(serverId: string): RemoteServerRecord | undefined {
    return this.options.store.get(serverId) ?? this.drafts.get(serverId)
  }

  private async openNow(serverId: string, projectId: string | undefined, token: string | undefined, answers: RemoteAnswers): Promise<RemoteConnectAnswer> {
    try {
      if (this.disposed) return fail('the app is quitting')
      const server = this.record(serverId)
      if (server === undefined) return fail('this server is not saved any more')
      const page = { ...(projectId === undefined ? {} : { projectId }), ...(token === undefined ? {} : { token }) }
      if (server.via.kind === 'direct') {
        await this.showWindow(server, { origin: server.via.origin, ...page })
        return { ok: true, serverId }
      }
      if (server.via.kind === 'tunnel') {
        // Nothing answering is no refusal: the window waits on main's page with the command (RemoteWindows'
        // gate probes again before it loads). Something else answering refuses before anything is saved.
        const problem = tunnelProbeError(server.via, await this.probe(server.via.localPort))
        if (problem !== undefined) return fail(problem)
        await this.showWindow(server, { origin: tunnelOrigin(server.via.localPort), ...page })
        return { ok: true, serverId }
      }
      return await this.openSsh(server, projectId, answers)
    } catch (err) {
      const text = errorText(err)
      this.log(`remote ${serverId}: connecting failed: ${text}`)
      return fail(text)
    }
  }

  /**
   * Built-in SSH (design §5.6): status, a token when one is needed, the tunnel, then save what the
   * connection rests on and open the window. Every call carries the connect's answers.
   */
  private async openSsh(server: RemoteServerRecord, projectId: string | undefined, answers: RemoteAnswers): Promise<RemoteConnectAnswer> {
    const id = server.id
    await this.options.ready?.()
    if (this.disposed) return fail('the app is quitting')
    const link = this.linkOf(id)
    const linkAnswers = linkAnswersOf(answers)
    // Every call's `accepted` is merged: the connection rests on all of them.
    const accepted: LinkAccepted = {}
    const step = <T>(result: LinkResult<T>): { value: T } | { answer: RemoteConnectAnswer } => {
      if (result.ok) {
        if (result.accepted.hostKey !== undefined) accepted.hostKey = result.accepted.hostKey
        if (result.accepted.password) accepted.password = true
        if (result.accepted.passphrase) accepted.passphrase = true
        return { value: result.value }
      }
      this.failedOn(id)
      return { answer: 'need' in result ? { ok: false, need: result.need } : fail(result.error) }
    }
    let token: string | undefined
    if (link.state.state !== 'up') {
      const status = step(await link.status(linkAnswers))
      if ('answer' in status) return status.answer
      // Link mode only: in password mode the server's own page asks the person once; confirm and
      // none have nothing a token would fix. A saved cookie (or one this run already got) loads as
      // is; RemoteWindows re-pairs when the server no longer takes it.
      if (status.value.mode === 'link' && !this.options.store.hasCookie(id) && !this.signedIn.has(id)) {
        const minted = step(await link.addDevice(linkAnswers))
        if ('answer' in minted) return minted.answer
        token = minted.value
      }
    }
    // Every open acquires (a link that is down with windows open gets this call's answers); a server
    // its windows hold already gives this one back at once.
    const acquired = step(await link.acquire(linkAnswers))
    if ('answer' in acquired) return acquired.answer
    const port = acquired.value
    const isDraft = this.drafts.has(id) && this.options.store.get(id) === undefined
    try {
      if (this.disposed) throw new Error('the app is quitting')
      // Dial and pairing worked: now, and only now, what the connection rests on is saved (§5.4).
      if (isDraft) this.options.store.insert(server)
      await this.saveAccepted(server, accepted, answers, port)
      await this.options.windows.open(id, { origin: tunnelOrigin(port), ...(projectId === undefined ? {} : { projectId }), ...(token === undefined ? {} : { token }) })
    } catch (err) {
      link.release()
      if (isDraft && this.options.windows.countOf(id) === 0) this.options.store.forget(id)
      this.failedOn(id)
      throw err
    }
    if (this.held.has(id) || this.options.windows.countOf(id) === 0) link.release()
    else this.held.add(id)
    if (token !== undefined) this.signedIn.add(id)
    this.options.opened?.()
    this.changed()
    return { ok: true, serverId: id }
  }

  /**
   * Save what the live connection rests on that the store lacks (ssh-link.ts `LinkAccepted`): the
   * host key trusted from an answer or vouched for by known_hosts, the secrets that came from this
   * connect's answers (encrypted when Remember was on, else in memory), and the listener's port.
   * A secret the store refuses is logged, never the reason a connect that worked fails.
   */
  private async saveAccepted(server: RemoteServerRecord, accepted: LinkAccepted, answers: RemoteAnswers, port: number): Promise<void> {
    const id = server.id
    if (accepted.hostKey !== undefined) this.options.store.setHostKey(id, accepted.hostKey)
    const remember = answers.remember === true
    const secrets: Array<[RemoteSecretName, string | undefined, boolean | undefined]> = [
      ['password', answers.password, accepted.password],
      ['passphrase', answers.passphrase, accepted.passphrase]
    ]
    for (const [name, value, used] of secrets) {
      if (!used || value === undefined || value === '') continue
      try {
        const kept = await this.options.store.setSecret(id, name, value, { remember })
        if (remember && !kept.remembered) this.log(`remote ${id}: the ${name} is kept in memory only: ${kept.reason ?? 'the secret store refused'}`)
      } catch (err) {
        this.log(`remote ${id}: keeping the ${name} failed: ${errorText(err)}`)
      }
    }
    if (this.options.store.get(id)?.localPort !== port) {
      try {
        this.options.store.setLocalPort(id, port)
      } catch (err) {
        this.log(`remote ${id}: saving the tunnel's port failed: ${errorText(err)}`)
      }
    }
  }

  /** A connect or open failed: the link goes unless windows hold it (see the header). */
  private failedOn(serverId: string): void {
    if (!this.held.has(serverId)) this.dropLink(serverId)
  }

  private linkOf(serverId: string): RemoteLink {
    const known = this.links.get(serverId)
    if (known !== undefined) return known.link
    const store: SshLinkStore = {
      get: (id) => this.record(id),
      getSecret: (id, name) => this.options.store.getSecret(id, name)
    }
    const link = this.options.link(serverId, store)
    const unsubscribe = link.onState(() => this.changed())
    this.links.set(serverId, { link, unsubscribe })
    return link
  }

  private dropLink(serverId: string): void {
    const entry = this.links.get(serverId)
    if (entry === undefined) return
    this.links.delete(serverId)
    this.held.delete(serverId)
    entry.unsubscribe()
    entry.link.dispose()
  }

  private async showWindow(server: RemoteServerRecord, request: RemoteOpenRequest): Promise<void> {
    const isDraft = this.drafts.has(server.id) && this.options.store.get(server.id) === undefined
    if (isDraft) this.options.store.insert(server)
    try {
      await this.options.windows.open(server.id, request)
    } catch (err) {
      if (isDraft && this.options.windows.countOf(server.id) === 0) this.options.store.forget(server.id)
      throw err
    }
    this.options.opened?.()
    this.changed()
  }

  /** Run `work` after the previous work queued under `key` (a server id, or `connect`) has settled. */
  private run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    const next = previous.then(work)
    const settled = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return next
  }
}
