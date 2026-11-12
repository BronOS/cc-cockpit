// The saved remote servers (design-remote-desktop.md §2, §8 "Credentials"): a store over `app.json` ›
// `remoteServers` and the encryption of the credentials kept beside each record (the device cookie,
// the built-in SSH client's password or key passphrase) through the `SecretStore`. No Electron
// import: unit tests load it in plain Node with a fake store.
//
// Rules:
//  - `app.json` is user-writable, so every operation starts from `validateRemoteServers` of what is
//    there and writes the repaired list back; a damaged entry never reaches a caller.
//  - Credentials are only ever kept as `SecretStore.encrypt` returned them, in the server's own
//    record, and never leave the store in a record: `get`, `add` and `list` strip the cookie and the
//    secrets alike (`RemoteServerRecord`); `getCookie` / `getSecret` are the only ways to read one.
//    When the store refuses (Linux with no keyring), no cookie is kept, any older one is dropped (it
//    may be the revoked one), and the caller is told so: the picker says "not remembered", and every
//    launch pairs again. A password or passphrase is then held in this store's memory for the app's
//    life (design §2 "Remember or ask"), as one the person chose not to remember is.
//  - `forget` drops the record and with it the cookie, the secrets and the host key, and the memory
//    copies of its secrets; there is no other copy to clean.
//  - Errors and logs name a server by id at most: never a credential, encrypted or not.
import { randomBytes } from 'node:crypto'
import type { AppSettings } from '../../shared/types'
import {
  MAX_REMOTE_RECENT,
  MAX_REMOTE_SECRET,
  MAX_REMOTE_SERVERS,
  checkCccOverride,
  checkKeyPath,
  checkSshHost,
  checkSshUser,
  defaultServerName,
  hostKeyOf,
  isLocalPort,
  parseRemoteLink,
  recentEntryOf,
  secretNameOf,
  serverNameOf,
  splitSshTarget,
  sshAuthOf,
  validateRemoteServers,
  type RemoteHostKey,
  type RemoteSecretName,
  type RemoteServer,
  type RemoteServerRecord,
  type RemoteVia,
  type SshAuth
} from '../../shared/remote-servers'
import type { SecretStore } from '../secrets/secret-store'

/** The slice of `JsonFile<AppSettings>` the store uses (the registry's `app`). */
export interface RemoteServersApp {
  readonly data: Pick<AppSettings, 'remoteServers'>
  update(mutate: (data: AppSettings) => void): void
}

/**
 * A server as the picker's list is built from it: no credential, only whether one is saved and
 * whether one can be kept.
 */
export type RemoteServerView = RemoteServerRecord & {
  /** A device cookie is saved (so the next connect needs no new pairing). */
  cookieSaved: boolean
  /** The secret store can keep a cookie right now; false is the "not remembered: no keyring" row. */
  cookieKept: boolean
  /** Which secrets are saved encrypted (a key present only when true); never a value. Memory-held ones do not count. */
  remembered: Partial<Record<RemoteSecretName, true>>
}

/** What `setSecret` did with a password or passphrase. */
export interface SecretResult {
  /** Saved encrypted in the record (false: held in memory for the app's life). */
  remembered: boolean
  /** Remember was asked for and the secret store refused: why, as it said (never the secret). */
  reason?: string
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
  /**
   * Secrets not remembered (the person's choice, or no keyring), by server id: main's memory only,
   * for the app's life, so a reconnect never asks again (design §2). Never written anywhere.
   */
  private readonly held = new Map<string, Partial<Record<RemoteSecretName, string>>>()

  constructor(options: RemoteServerStoreOptions) {
    this.app = options.app
    this.secrets = options.secrets
    this.newId = options.newId ?? (() => randomBytes(12).toString('hex'))
  }

  /** Every saved server (validated), with the credentials left out. */
  async list(): Promise<RemoteServerView[]> {
    const cookieKept = (await this.secrets.unavailableReason()) === null
    return this.read().map((s) => ({
      ...withoutSecrets(s),
      cookieSaved: s.cookie !== undefined,
      cookieKept,
      remembered: {
        ...(s.secrets?.password === undefined ? {} : { password: true as const }),
        ...(s.secrets?.passphrase === undefined ? {} : { passphrase: true as const })
      }
    }))
  }

  /** One server's record without its credentials, or undefined. */
  get(id: string): RemoteServerRecord | undefined {
    const found = this.read().find((s) => s.id === id)
    return found === undefined ? undefined : withoutSecrets(found)
  }

  /**
   * Save a server. `via` is checked here (the host, user and key path allowlists, the ports, the
   * `ccc` path, the link's origin); the name defaults to the host. The same server already saved
   * (`sameVia`: SSH host, user and port; a tunnel's local port; the origin) answers that record
   * instead of adding a second one. A tunnel whose local port another tunnel already uses with
   * other settings is refused: both would load the same origin, so one's cookie would be sent to
   * the other's server.
   */
  add(input: { name?: string; via: RemoteVia }): RemoteServerRecord {
    const prepared = this.prepare(input)
    return prepared.saved ? prepared.record : this.insert(prepared.record)
  }

  /**
   * `add` without the write (design §5.4, "nothing saved before success"): the same server already
   * saved (`saved: true`), or a new record with a fresh id that nothing holds yet. The connect dials
   * with that record and `insert`s it only once the window opens. `via` is the input as checked (a
   * saved record keeps its own settings: compare with `sameSettings`). Throws as `add` does.
   */
  prepare(input: { name?: string; via: RemoteVia }): { record: RemoteServerRecord; saved: boolean; via: RemoteVia } {
    const via = this.checkedVia(input.via)
    const servers = this.read()
    const same = this.sameSaved(servers, via)
    if (same !== undefined) return { record: withoutSecrets(same), saved: true, via }
    const name = this.newName(servers, input.name, via)
    const ids = new Set(servers.map((s) => s.id))
    let id = this.newId()
    while (ids.has(id)) id = this.newId()
    const server: RemoteServer = { id, name, via, recent: [] }
    // The validator is the one reader: a made-up id (a test seam) it would drop is refused here, not lost silently.
    if (validateRemoteServers([server]).length !== 1) throw new RemoteServerError('the server record is not valid')
    return { record: server, saved: false, via }
  }

  /**
   * Save a record `prepare` made. Checked again (the list may have changed meanwhile): a same server
   * saved since, a clash, the cap. Only the id, name and `via` are taken; the rest starts empty.
   */
  insert(record: RemoteServerRecord): RemoteServerRecord {
    const servers = this.read()
    if (servers.some((s) => s.id === record.id)) throw new RemoteServerError('this server is saved already')
    const via = this.checkedVia(record.via)
    const same = this.sameSaved(servers, via)
    if (same !== undefined) throw new RemoteServerError(`this server was saved meanwhile as "${same.name}"`)
    const server: RemoteServer = { id: record.id, name: this.newName(servers, record.name, via), via, recent: [] }
    if (validateRemoteServers([server]).length !== 1) throw new RemoteServerError('the server record is not valid')
    this.write([...servers, server])
    return withoutSecrets(server)
  }

  /**
   * Edit a saved server's settings (the picker's Edit, design §3): its name (absent or empty: kept)
   * and `via`, of the same kind (another kind is another server). The device cookie is kept, with
   * one exception: a Direct origin that changed (the cookie would be sent to that other origin). An
   * SSH host or port that changed drops the trusted host key (another machine may answer there, and
   * its key must be confirmed again); a host, user, port or sign-in that changed drops the password
   * or passphrase, stored and in memory (it was for that account or that key). A `via` another saved
   * server already has is refused, as `add` refuses a tunnel's used local port.
   */
  edit(id: string, input: { name?: string; via: RemoteVia; forgetHostKey?: boolean }): { viaChanged: boolean; renamed: boolean } {
    const servers = this.read()
    const server = servers.find((s) => s.id === id)
    if (server === undefined) throw new RemoteServerError('unknown server')
    const via = this.checkedVia(input.via)
    if (via.kind !== server.via.kind) throw new RemoteServerError('Edit cannot change how a server is reached: connect it as a new server')
    const other = servers.find((s) => s.id !== id && sameVia(s.via, via))
    if (other !== undefined) throw new RemoteServerError(`"${other.name}" is already saved with these settings`)
    let name = server.name
    if (input.name !== undefined && input.name.trim() !== '') {
      const clean = serverNameOf(input.name)
      if (clean === undefined) throw new RemoteServerError('the name must be 1 to 100 characters with no control characters')
      name = clean
    }
    const before = server.via
    let viaChanged = !sameSettings(before, via)
    if (before.kind === 'ssh' && via.kind === 'ssh') {
      const address = before.host !== via.host || (before.port ?? 0) !== (via.port ?? 0)
      const account = address || (before.user ?? '') !== (via.user ?? '') || JSON.stringify(sshAuthOf(before)) !== JSON.stringify(sshAuthOf(via))
      // Edit's "Forget the trusted host key" (the changed-key refusal points there: a reinstalled
      // server). It counts as a changed connection, so the live link, made under the old key, ends.
      if (input.forgetHostKey === true && server.hostKey !== undefined) {
        delete server.hostKey
        viaChanged = true
      }
      if (address) delete server.hostKey
      if (account) {
        delete server.secrets
        this.held.delete(id)
      }
    }
    if (before.kind === 'direct' && via.kind === 'direct' && before.origin !== via.origin) delete server.cookie
    const renamed = name !== server.name
    server.name = name
    server.via = via
    this.write(servers)
    return { viaChanged, renamed }
  }

  rename(id: string, name: string): void {
    const clean = serverNameOf(name)
    if (clean === undefined) throw new RemoteServerError('the name must be 1 to 100 characters with no control characters')
    this.change(id, (s) => {
      s.name = clean
    })
  }

  /**
   * Drop the record, and with it the encrypted cookie and secrets, the trusted host key, recents and
   * saved port, and any secret held in memory for it. Unknown ids are a no-op (memory is cleared anyway).
   */
  forget(id: string): boolean {
    this.held.delete(id)
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
   * Keep the password or passphrase the server's sign-in uses (design §2 "Remember or ask"):
   * `remember` encrypts it into the record and drops a memory copy; otherwise, or when the secret
   * store refuses, it is held in memory for the app's life and a stored one is dropped (the person
   * unticked Remember, or the stored one is stale: this one just replaced it). Refused for a secret
   * the record's `auth` does not use (auto uses none), so no credential sits where nothing reads it.
   */
  async setSecret(id: string, name: RemoteSecretName, value: string, options: { remember: boolean }): Promise<SecretResult> {
    const server = this.get(id)
    if (server === undefined) throw new RemoteServerError('unknown server')
    if (server.via.kind !== 'ssh' || secretNameOf(sshAuthOf(server.via)) !== name) {
      throw new RemoteServerError(`this server does not sign in with a ${name}`)
    }
    if (typeof value !== 'string' || value.length === 0) throw new RemoteServerError(`enter the ${name}`)
    if (value.length > MAX_REMOTE_SECRET) throw new RemoteServerError(`the ${name} is too long`)
    let stored: string | undefined
    let reason: string | undefined
    if (options.remember) {
      try {
        reason = (await this.secrets.unavailableReason()) ?? undefined
        if (reason === undefined) stored = await this.secrets.encrypt(value)
      } catch (err) {
        reason = err instanceof Error ? err.message : 'the secret store failed'
      }
    }
    // The record may have been forgotten (or its sign-in changed) while the keychain answered: then
    // nothing is kept, in the record or in memory.
    let kept = false
    this.change(id, (s) => {
      if (s.via.kind !== 'ssh' || secretNameOf(sshAuthOf(s.via)) !== name) return
      kept = true
      if (stored === undefined) {
        if (s.secrets !== undefined) delete s.secrets[name]
        if (s.secrets !== undefined && Object.keys(s.secrets).length === 0) delete s.secrets
      } else {
        s.secrets = { ...s.secrets, [name]: stored }
      }
    }, false)
    if (!kept) return { remembered: false, ...(options.remember ? { reason: 'the server was changed or forgotten meanwhile' } : {}) }
    const memory = this.held.get(id) ?? {}
    if (stored === undefined) memory[name] = value
    else delete memory[name]
    if (Object.keys(memory).length > 0) this.held.set(id, memory)
    else this.held.delete(id)
    if (stored !== undefined) return { remembered: true }
    return options.remember ? { remembered: false, reason: reason ?? 'the secret store failed' } : { remembered: false }
  }

  /**
   * The password or passphrase for the server's sign-in: the memory copy (this run's answer), else
   * the stored one decrypted; undefined when there is none or it cannot be decrypted (the picker asks).
   */
  async getSecret(id: string, name: RemoteSecretName): Promise<string | undefined> {
    const server = this.read().find((s) => s.id === id)
    // A memory copy from before the sign-in was changed is not this sign-in's secret.
    if (server === undefined || server.via.kind !== 'ssh' || secretNameOf(sshAuthOf(server.via)) !== name) return undefined
    const memory = this.held.get(id)?.[name]
    if (memory !== undefined) return memory
    const stored = server.secrets?.[name]
    if (stored === undefined) return undefined
    try {
      return await this.secrets.decrypt(stored)
    } catch {
      return undefined
    }
  }

  /** Drop a password or passphrase, stored and in memory (a wrong one: the next connect asks again). */
  clearSecret(id: string, name: RemoteSecretName): void {
    const memory = this.held.get(id)
    if (memory !== undefined) {
      delete memory[name]
      if (Object.keys(memory).length === 0) this.held.delete(id)
    }
    this.change(id, (s) => {
      if (s.secrets === undefined) return
      delete s.secrets[name]
      if (Object.keys(s.secrets).length === 0) delete s.secrets
    }, false)
  }

  /** Trust a host key for a built-in SSH server (design §5.3: confirmed by the person, or vouched for by `known_hosts`). */
  setHostKey(id: string, key: RemoteHostKey): void {
    const clean = hostKeyOf(key)
    if (clean === undefined) throw new RemoteServerError('not a usable host key fingerprint')
    this.change(id, (s) => {
      if (s.via.kind !== 'ssh') throw new RemoteServerError('only an SSH server has a host key')
      s.hostKey = clean
    })
  }

  /** Forget the trusted host key (Edit: the server was reinstalled, or its host or port changed). */
  clearHostKey(id: string): void {
    this.change(id, (s) => {
      delete s.hostKey
    }, false)
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

  /** Keep the built-in client's listener port so the page's origin stays the same next time (SSH servers only). */
  setLocalPort(id: string, port: number): void {
    if (!isLocalPort(port)) throw new RemoteServerError('not a usable port')
    this.change(id, (s) => {
      if (s.via.kind !== 'ssh') throw new RemoteServerError('only an SSH server keeps a listener port')
      s.localPort = port
    })
  }

  /** The saved server `via` names, or undefined; a tunnel on a used local port with other settings throws. */
  private sameSaved(servers: RemoteServer[], via: RemoteVia): RemoteServer | undefined {
    const same = servers.find((s) => sameVia(s.via, via))
    if (same !== undefined && via.kind === 'tunnel' && !sameTunnel(same.via, via)) {
      throw new RemoteServerError(`local port ${via.localPort} is already used by the tunnel of "${same.name}"; choose another local port`)
    }
    return same
  }

  /** A new server's name (the cap checked first: there is no room for one more). */
  private newName(servers: RemoteServer[], name: string | undefined, via: RemoteVia): string {
    if (servers.length >= MAX_REMOTE_SERVERS) {
      throw new RemoteServerError(`at most ${MAX_REMOTE_SERVERS} servers can be saved; forget one first`)
    }
    const clean = name === undefined || name.trim() === '' ? defaultServerName(via) : serverNameOf(name)
    if (clean === undefined) throw new RemoteServerError('the name is too long or has control characters')
    return clean
  }

  private checkedVia(via: RemoteVia): RemoteVia {
    if (via.kind === 'ssh') {
      // A typed `user@host` is split as ssh does; beside a User field it is ambiguous.
      const target = splitSshTarget(via.host.trim())
      const typedUser = via.user?.trim() ?? ''
      if (target.user !== undefined && typedUser !== '') throw new RemoteServerError('give the user in the User field or in the host, not both')
      const hostProblem = checkSshHost(target.host)
      if (hostProblem !== undefined) throw new RemoteServerError(hostProblem)
      const out: Extract<RemoteVia, { kind: 'ssh' }> = { kind: 'ssh', host: target.host }
      const user = target.user ?? typedUser
      if (user !== '') {
        const userProblem = checkSshUser(user)
        if (userProblem !== undefined) throw new RemoteServerError(userProblem)
        out.user = user
      }
      if (via.port !== undefined) {
        if (!isLocalPort(via.port)) throw new RemoteServerError('the SSH port must be a number from 1 to 65535')
        out.port = via.port
      }
      if (via.auth !== undefined) out.auth = this.checkedAuth(via.auth)
      if (via.ccc !== undefined && via.ccc !== '') {
        const cccProblem = checkCccOverride(via.ccc)
        if (cccProblem !== undefined) throw new RemoteServerError(cccProblem)
        out.ccc = via.ccc
      }
      return out
    }
    if (via.kind === 'tunnel') {
      if (!isLocalPort(via.localPort)) throw new RemoteServerError('the local port must be a number from 1 to 65535')
      if (!isLocalPort(via.remotePort)) throw new RemoteServerError('the server port must be a number from 1 to 65535')
      const out: RemoteVia = { kind: 'tunnel', localPort: via.localPort, remotePort: via.remotePort }
      const sshHost = via.sshHost?.trim() ?? ''
      if (sshHost !== '') {
        // Printed into a command the person pastes into a shell: the same allowlist as a dialled host.
        const hostProblem = checkSshHost(sshHost)
        if (hostProblem !== undefined) throw new RemoteServerError(hostProblem)
        out.sshHost = sshHost
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

  private checkedAuth(auth: SshAuth): SshAuth {
    if (auth.kind === 'auto' || auth.kind === 'password') return { kind: auth.kind }
    if (auth.kind === 'key') {
      const path = auth.path.trim()
      const problem = checkKeyPath(path)
      if (problem !== undefined) throw new RemoteServerError(problem)
      return { kind: 'key', path }
    }
    throw new RemoteServerError('unknown way to sign in')
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

/** The record as it leaves the store: no cookie and no secrets, encrypted or not (design §2). */
function withoutSecrets(server: RemoteServer): RemoteServerRecord {
  const copy: RemoteServer = { ...server }
  delete copy.cookie
  delete copy.secrets
  return copy
}

/**
 * The same server (design §2, `add` dedupes): SSH by host, user and port (an empty user or port is
 * its own value: "the config's", which may differ from any explicit one); a tunnel by its local
 * port (the origin, so the cookie jar's key); Direct by origin. Sign-in, `ccc` and a tunnel's other
 * fields are settings of that server, not its identity.
 */
function sameVia(a: RemoteVia, b: RemoteVia): boolean {
  if (a.kind === 'ssh' && b.kind === 'ssh') return a.host === b.host && (a.user ?? '') === (b.user ?? '') && (a.port ?? 0) === (b.port ?? 0)
  if (a.kind === 'tunnel' && b.kind === 'tunnel') return a.localPort === b.localPort
  return a.kind === 'direct' && b.kind === 'direct' && a.origin === b.origin
}

/** Two `via`s with the same settings (sign-in, `ccc` and a tunnel's printed host included), not only the same identity. */
export function sameSettings(a: RemoteVia, b: RemoteVia): boolean {
  return JSON.stringify(canonicalVia(a)) === JSON.stringify(canonicalVia(b))
}

/** `via` with its fields in one order and the defaults spelled out, so two can be compared as JSON. */
function canonicalVia(via: RemoteVia): unknown {
  if (via.kind === 'ssh') return ['ssh', via.host, via.user ?? '', via.port ?? 0, sshAuthOf(via), via.ccc ?? '']
  if (via.kind === 'tunnel') return ['tunnel', via.localPort, via.remotePort, via.sshHost ?? '']
  return ['direct', via.origin]
}

/** Two tunnels on one local port with the same settings (a repeated Connect), as opposed to a clash. */
function sameTunnel(a: RemoteVia, b: RemoteVia): boolean {
  return a.kind === 'tunnel' && b.kind === 'tunnel' && a.localPort === b.localPort && a.remotePort === b.remotePort && (a.sshHost ?? '') === (b.sshHost ?? '')
}
