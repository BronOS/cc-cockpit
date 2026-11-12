// Fakes of a remote server's partition cookie jar and the store's cookie half
// (main/remote/remote-cookie.ts). The jar replays what Chromium reports for a set over an existing
// cookie: a removal with cause `overwrite`, then the add.
import type { JarCookie, JarSetDetails, RemoteCookieJar } from '../../src/main/remote/remote-cookie'

type Listener = (cookie: JarCookie, cause: string, removed: boolean) => void

export class FakeJar implements RemoteCookieJar {
  readonly sets: JarSetDetails[] = []
  readonly listeners: Listener[] = []
  /** name@host -> the cookie in the jar. */
  readonly cookies = new Map<string, JarCookie>()
  failSet = false

  async set(details: JarSetDetails): Promise<void> {
    if (this.failSet) throw new Error('jar refused')
    this.sets.push(details)
    const domain = new URL(details.url).hostname
    this.put({ name: details.name, value: details.value, domain })
  }

  onChanged(listener: Listener): void {
    this.listeners.push(listener)
  }

  /** A cookie lands (the server's Set-Cookie or our set): an overwrite removal first when one is there. */
  put(cookie: JarCookie): void {
    const key = `${cookie.name}@${cookie.domain}`
    const old = this.cookies.get(key)
    if (old !== undefined) this.emit(old, 'overwrite', true)
    this.cookies.set(key, cookie)
    this.emit(cookie, 'inserted', false)
  }

  remove(name: string, domain: string, cause: string): void {
    const key = `${name}@${domain}`
    const old = this.cookies.get(key)
    if (old === undefined) return
    this.cookies.delete(key)
    this.emit(old, cause, true)
  }

  emit(cookie: JarCookie, cause: string, removed: boolean): void {
    for (const l of this.listeners) l(cookie, cause, removed)
  }
}

export class FakeCookieStore {
  saved: string | undefined
  readonly setCalls: string[] = []
  clears = 0
  refuse = false

  async getCookie(): Promise<string | undefined> {
    return this.saved
  }
  async setCookie(_id: string, cookie: string): Promise<{ kept: boolean; reason?: string }> {
    this.setCalls.push(cookie)
    if (this.refuse) {
      this.saved = undefined
      return { kept: false, reason: 'no keyring' }
    }
    this.saved = cookie
    return { kept: true }
  }
  clearCookie(): void {
    this.clears++
    this.saved = undefined
  }
}
