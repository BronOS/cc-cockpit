// The device cookie of a remote server's window partition (design-remote-desktop.md §2). No Electron
// import: the partition's cookie jar is passed in (electron-remote-window.ts adapts
// `session.cookies`), so unit tests drive it with a fake jar.
//
// Why the cookie is handled at all, instead of letting the partition keep it: the partition is
// `persist:` (the web client's `localStorage`, zone sizes, survives a relaunch), and Chromium writes
// a cookie with an expiry to the partition's `Cookies` database, which Electron does not encrypt
// (the app has no cookie-encryption fuse). The device cookie is a credential (a signed-in device is
// the person with a shell on the server), so it lives only encrypted in the server's record
// (`RemoteServerStore.setCookie`) and, in the partition, only as a SESSION cookie (no expiry), which
// Chromium keeps in memory and never writes to disk. So:
//  - `restore()` sets it from the record, without an expiry, before the first page load;
//  - a `ccc_device` the server sets on a sign-in (it always carries Max-Age, auth.ts) is saved to
//    the record and set again at once without an expiry, replacing the one Chromium would persist;
//  - the second `changed` that re-set causes is not a sign-in: a session cookie (no expiry) is ours,
//    never the server's, and an overwrite is a replacement with its add to follow. That is the loop
//    guard; the value check below only stops a repeat of the same sign-in being saved twice;
//  - a removal that is not a replacement (expired, evicted, cleared, the server's expired
//    overwrite) clears the record: the cookie is gone, a stale encrypted copy would only be sent
//    again at the next launch to be refused.
// The cookie text never reaches a log line.

/** The device cookie's name (main/web/auth.ts DEVICE_COOKIE; the server's, read here as data). */
export const REMOTE_DEVICE_COOKIE = 'ccc_device'

/** The fields of a changed cookie this module reads (Electron's `Cookie`). */
export interface JarCookie {
  name: string
  value: string
  domain?: string
  /** Seconds since the epoch; absent for a session cookie. */
  expirationDate?: number
}

/** What `set` takes (a subset of Electron's `CookiesSetDetails`); never an `expirationDate`. */
export interface JarSetDetails {
  url: string
  name: string
  value: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict'
}

/** One partition's cookie jar, as the adapter hands it over. */
export interface RemoteCookieJar {
  set(details: JarSetDetails): Promise<void>
  /** Every cookie change of the partition: Electron's `cookies.on('changed')` arguments, event left out. */
  onChanged(listener: (cookie: JarCookie, cause: string, removed: boolean) => void): void
}

/** The store's cookie half (RemoteServerStore). */
export interface RemoteCookieStore {
  getCookie(id: string): Promise<string | undefined>
  setCookie(id: string, cookie: string): Promise<{ kept: boolean; reason?: string }>
  clearCookie(id: string): void
}

export interface RemoteCookieOptions {
  serverId: string
  jar: RemoteCookieJar
  store: RemoteCookieStore
  /** The server's current origin (`scheme://host[:port]`); undefined while it has none (the tunnel is down). */
  origin(): string | undefined
  /** A sign-in landed a new device cookie (re-pair waits for it, remote-windows.ts). */
  onSignedIn?(): void
  log(message: string): void
}

/** Removal causes that replace the cookie (an add follows): not a removal of the device. */
const REPLACED = new Set(['overwrite', 'inserted', 'inserted-no-change-overwrite', 'inserted-no-value-change-overwrite'])

/** `host` of an origin with IPv6 brackets dropped, as a cookie's domain names it; undefined when it does not parse. */
function hostOfOrigin(origin: string): string | undefined {
  try {
    const host = new URL(origin).hostname
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  } catch {
    return undefined
  }
}

/** A cookie's domain as a host: a leading dot (a domain cookie) and IPv6 brackets dropped. */
function hostOfDomain(domain: string): string {
  const bare = domain.startsWith('.') ? domain.slice(1) : domain
  return bare.startsWith('[') && bare.endsWith(']') ? bare.slice(1, -1) : bare
}

export class RemoteCookie {
  private readonly options: RemoteCookieOptions
  /** The value last saved to the record: the same sign-in reported twice is saved once. */
  private saved: string | undefined
  /** Saves and clears run one at a time, in event order, so a late save never undoes a later clear. */
  private chain: Promise<void> = Promise.resolve()

  constructor(options: RemoteCookieOptions) {
    this.options = options
    options.jar.onChanged((cookie, cause, removed) => this.changed(cookie, cause, removed))
  }

  /**
   * Set the saved cookie as a session cookie on the server's origin, before the first page load.
   * Nothing saved, or the store cannot read it: nothing is set, and the page shows its sign-in
   * (SSH re-pairs, remote-windows.ts). Never throws: a failed set is a log line and a sign-in.
   */
  async restore(): Promise<void> {
    const origin = this.options.origin()
    if (origin === undefined) return
    let value: string | undefined
    try {
      value = await this.options.store.getCookie(this.options.serverId)
    } catch (err) {
      this.options.log(`remote ${this.options.serverId}: reading the saved device cookie failed: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (value === undefined || value === '') return
    this.saved = value
    await this.setSession(origin, value)
  }

  /** Settles once every save or clear the events so far started is done (tests, and quit). */
  idle(): Promise<void> {
    return this.chain
  }

  private changed(cookie: JarCookie, cause: string, removed: boolean): void {
    if (cookie.name !== REMOTE_DEVICE_COOKIE) return
    const origin = this.options.origin()
    if (origin === undefined) return
    const host = hostOfOrigin(origin)
    // Another host's cookie of the same name (a page cannot set one for another host, but a jar may
    // hold one from an older origin of the same server, a Direct server whose address changed).
    if (host === undefined || cookie.domain === undefined || hostOfDomain(cookie.domain) !== host) return
    if (removed) {
      if (REPLACED.has(cause)) return
      this.saved = undefined
      this.queue(async () => {
        this.options.store.clearCookie(this.options.serverId)
      })
      return
    }
    // A session cookie: our own restore or re-set (the server's always has an expiry). The loop guard.
    if (cookie.expirationDate === undefined) return
    const value = cookie.value
    if (value === '') return
    // A sign-in. First take the persistent copy out of the jar (the same name, host and path, so
    // Chromium replaces it), then keep it encrypted. The re-set's own `changed` events stop above.
    void this.setSession(origin, value)
    if (value !== this.saved) {
      this.saved = value
      this.queue(async () => {
        const result = await this.options.store.setCookie(this.options.serverId, value)
        if (!result.kept) {
          this.options.log(`remote ${this.options.serverId}: the device cookie is not remembered (${result.reason ?? 'no reason given'}); the next launch pairs again`)
        }
      })
    }
    this.options.onSignedIn?.()
  }

  /** The cookie as a session cookie (no `expirationDate`) on `origin`, as the gateway sets it otherwise. */
  private async setSession(origin: string, value: string): Promise<void> {
    try {
      await this.options.jar.set({
        url: `${origin}/`,
        name: REMOTE_DEVICE_COOKIE,
        value,
        path: '/',
        httpOnly: true,
        secure: origin.startsWith('https:'),
        sameSite: 'strict'
      })
    } catch (err) {
      this.options.log(`remote ${this.options.serverId}: setting the device cookie failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private queue(step: () => Promise<void>): void {
    this.chain = this.chain.then(step).catch((err: unknown) => {
      this.options.log(`remote ${this.options.serverId}: keeping the device cookie failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
}
