// The saved remote servers (design-remote-desktop.md §2): a store over `app.json` › `remoteServers`
// and the device cookie's encryption through the `SecretStore`. No Electron import: unit tests load
// it in plain Node with a fake store.
//
// Rules:
//  - `app.json` is user-writable, so every operation starts from `validateRemoteServers` of what is
//    there and writes the repaired list back; a damaged entry never reaches a caller.
//  - The cookie is a credential and is only ever kept as `SecretStore.encrypt` returned it, in the
//    server's own record. When the store refuses (Linux with no keyring), nothing is kept, any older
//    cookie is dropped (it may be the revoked one), and the caller is told so: the picker says "not
//    remembered", and every launch pairs again.
//  - `forget` drops the record and with it the cookie; there is no second copy to clean.
//  - Errors and logs name a server by id at most: never a cookie, encrypted or not.
import { randomBytes } from 'node:crypto'
import type { AppSettings } from '../../shared/types'
import {
  MAX_REMOTE_RECENT,
  MAX_REMOTE_SERVERS,
  checkCccOverride,
  checkSshHost,
  defaultServerName,
  isLocalPort,
  parseRemoteLink,
  recentEntryOf,
  serverNameOf,
  validateRemoteServers,
  type RemoteServer,
  type RemoteVia
} from '../../shared/remote-servers'
import type { SecretStore } from '../secrets/secret-store'

/** The slice of `JsonFile<AppSettings>` the store uses (the registry's `app`). */
export interface RemoteServersApp {
  readonly data: Pick<AppSettings, 'remoteServers'>
  update(mutate: (data: AppSettings) => void): void
}

/** A server as the picker sees it: no cookie text, only whether there is one and whether one can be kept. */
export type RemoteServerView = Omit<RemoteServer, 'cookie'> & {
  /** A device cookie is saved (so the next connect needs no new pairing). */
  cookieSaved: boolean
  /** The secret store can keep a cookie right now; false is the "not remembered: no keyring" row. */
  cookieKept: boolean
}

export interface CookieResult {
  /** The cookie was encrypted and saved. */
  kept: boolean
  /** Why not, as the secret store said it (never the cookie). */
  reason?: string
}

export interface RemoteServerStoreOptions {
  app: RemoteServersApp
  secrets: SecretStore
  /** Test seam: the ids. Default: 12 random bytes, hex. */
  newId?: () => string
}

/** A refused request (a bad host, the cap, an unknown id): the text is shown to the person. */
export class RemoteServerError extends Error {
  override name = 'RemoteServerError'
}

export class RemoteServerStore {
  private readonly app: RemoteServersApp
  private readonly secrets: SecretStore
  private readonly newId: () => string

  constructor(options: RemoteServerStoreOptions) {
    this.app = options.app
    this.secrets = options.secrets
    this.newId = options.newId ?? (() => randomBytes(12).toString('hex'))
  }

  /** Every saved server (validated), with the cookie text left out. */
  async list(): Promise<RemoteServerView[]> {
    const cookieKept = (await this.secrets.unavailableReason()) === null
    return this.read().map((s) => ({ ...withoutCookie(s), cookieSaved: s.cookie !== undefined, cookieKept }))
  }

  /** One server's record without its cookie, or undefined. */
  get(id: string): RemoteServer | undefined {
    const found = this.read().find((s) => s.id === id)
    return found === undefined ? undefined : withoutCookie(found)
  }

  /**
   * Save a server. `via` is checked here (the host allowlist, the `ccc` path, the link's origin); the
   * name defaults to the host. The same SSH host and `ccc` path, or the same origin, answers the
   * record that is already saved instead of adding a second one.
   */
  add(input: { name?: string; via: RemoteVia }): RemoteServer {
    const via = this.checkedVia(input.via)
    const servers = this.read()
    const same = servers.find((s) => sameVia(s.via, via))
    if (same !== undefined) return withoutCookie(same)
    if (servers.length >= MAX_REMOTE_SERVERS) {
      throw new RemoteServerError(`at most ${MAX_REMOTE_SERVERS} servers can be saved; forget one first`)
    }
    const name = input.name === undefined || input.name.trim() === '' ? defaultServerName(via) : serverNameOf(input.name)
    if (name === undefined) throw new RemoteServerError('the name is too long or has control characters')
    const ids = new Set(servers.map((s) => s.id))
    let id = this.newId()
    while (ids.has(id)) id = this.newId()
    const server: RemoteServer = { id, name, via, recent: [] }
    // The validator is the one reader: a made-up id (a test seam) it would drop is refused here, not lost silently.
    if (validateRemoteServers([server]).length !== 1) throw new RemoteServerError('the server record is not valid')
    this.write([...servers, server])
    return server
  }

  rename(id: string, name: string): void {
    const clean = serverNameOf(name)
    if (clean === undefined) throw new RemoteServerError('the name must be 1 to 100 characters with no control characters')
    this.change(id, (s) => {
      s.name = clean
    })
  }

  /** Drop the record, and with it the encrypted cookie, recents and saved port. Unknown ids are a no-op. */
  forget(id: string): boolean {
    const servers = this.read()
    const rest = servers.filter((s) => s.id !== id)
    if (rest.length === servers.length) return false
    this.write(rest)
    return true
  }

  /**
   * Keep a device cookie, encrypted. When the secret store refuses nothing is kept and an older
   * cookie is dropped too (a fresh sign-in just replaced it, so the old one is stale or revoked);
   * the result says so for the picker.
   */
  async setCookie(id: string, cookie: string): Promise<CookieResult> {
    if (this.get(id) === undefined) throw new RemoteServerError('unknown server')
    let stored: string | undefined
    let reason: string | undefined
    try {
      reason = (await this.secrets.unavailableReason()) ?? undefined
      if (reason === undefined) stored = await this.secrets.encrypt(cookie)
    } catch (err) {
      reason = err instanceof Error ? err.message : 'the secret store failed'
    }
    // The record may have been forgotten while the keychain answered.
    this.change(id, (s) => {
      if (stored === undefined) delete s.cookie
      else s.cookie = stored
    }, false)
    return stored === undefined ? { kept: false, reason: reason ?? 'the secret store failed' } : { kept: true }
  }

  clearCookie(id: string): void {
    this.change(id, (s) => {
      delete s.cookie
    }, false)
  }

  /** A device cookie is saved for this server (encrypted; whether it still decrypts is `getCookie`'s). */
  hasCookie(id: string): boolean {
    return this.read().find((s) => s.id === id)?.cookie !== undefined
  }

  /** The decrypted device cookie, or undefined: none saved, or the store cannot read it (the caller pairs again). */
  async getCookie(id: string): Promise<string | undefined> {
    const stored = this.read().find((s) => s.id === id)?.cookie
    if (stored === undefined) return undefined
    try {
      return await this.secrets.decrypt(stored)
    } catch {
      return undefined
    }
  }

  /**
   * Note a remote project the person opened: newest first, one entry per project id, the last 8. The
   * name comes from the server, so it is plain text and capped here; an unusable one is not recorded.
   */
  recordRecent(id: string, projectId: string, name: string, at: number): void {
    const entry = recentEntryOf(projectId, name, at)
    if (entry === undefined) return
    this.change(id, (s) => {
      s.recent = [entry, ...s.recent.filter((r) => r.projectId !== entry.projectId)].slice(0, MAX_REMOTE_RECENT)
    })
  }

  /** Keep the tunnel's local port so the page's origin stays the same next time. */
  setLocalPort(id: string, port: number): void {
    if (!isLocalPort(port)) throw new RemoteServerError('not a usable port')
    this.change(id, (s) => {
      s.localPort = port
    })
  }

  private checkedVia(via: RemoteVia): RemoteVia {
    if (via.kind === 'ssh') {
      const host = via.host.trim()
      const hostProblem = checkSshHost(host)
      if (hostProblem !== undefined) throw new RemoteServerError(hostProblem)
      const out: RemoteVia = { kind: 'ssh', host }
      if (via.ccc !== undefined && via.ccc !== '') {
        const cccProblem = checkCccOverride(via.ccc)
        if (cccProblem !== undefined) throw new RemoteServerError(cccProblem)
        out.ccc = via.ccc
      }
      return out
    }
    if (via.kind === 'direct') {
      // Only an origin is kept: the link's token and anything else never reach the record.
      const link = parseRemoteLink(via.origin)
      if ('error' in link) throw new RemoteServerError(link.error)
      return { kind: 'direct', origin: link.origin }
    }
    throw new RemoteServerError('unknown kind of server')
  }

  private read(): RemoteServer[] {
    return validateRemoteServers(this.app.data.remoteServers)
  }

  private write(servers: RemoteServer[]): void {
    this.app.update((a) => {
      if (servers.length > 0) a.remoteServers = servers
      else delete a.remoteServers
    })
  }

  /** Apply `mutate` to one server and write the list back; an unknown id throws, or is skipped when `strict` is off. */
  private change(id: string, mutate: (s: RemoteServer) => void, strict = true): void {
    const servers = this.read()
    const server = servers.find((s) => s.id === id)
    if (server === undefined) {
      if (strict) throw new RemoteServerError('unknown server')
      return
    }
    mutate(server)
    this.write(servers)
  }
}

function withoutCookie(server: RemoteServer): Omit<RemoteServer, 'cookie'> {
  const copy: RemoteServer = { ...server }
  delete copy.cookie
  return copy
}

function sameVia(a: RemoteVia, b: RemoteVia): boolean {
  if (a.kind === 'ssh' && b.kind === 'ssh') return a.host === b.host && (a.ccc ?? '') === (b.ccc ?? '')
  return a.kind === 'direct' && b.kind === 'direct' && a.origin === b.origin
}
