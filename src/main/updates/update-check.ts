// The "a new version exists" check (plan: distribution, Task 4). Notice only: nothing is
// downloaded or replaced, because an update under running Claude sessions would restart them.
//
// The response is untrusted text from a third party's API. Only `tag_name` is read, and only
// when it is exactly `v<major>.<minor>.<patch>`; the release link is built here from a fixed
// base and that validated version. `html_url` and `body` are never read, so a hostile or
// compromised response cannot put a URL or text in front of the user.
// Any failure is silent (a private repo answers 404; offline is normal): logged at most.
// Pure Node, so unit tests load it (fetcher, clock and timers are injected).
import { compareVersions } from '../../shared/marketplace'
import { readLimited } from '../marketplace/fetch-index'

export const LATEST_RELEASE_API = 'https://api.github.com/repos/BronOS/cc-cockpit/releases/latest'
export const RELEASE_URL_BASE = 'https://github.com/BronOS/cc-cockpit/releases/tag/'
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
export const UPDATE_FETCH_TIMEOUT_MS = 15_000
/** A release object is a few KB; anything near this is not one. */
export const MAX_RELEASE_BYTES = 256 * 1024

const TAG = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/

/** `1.2.3` from the tag `v1.2.3`, or undefined for anything else (prereleases, junk, wrong types). */
export function versionOfTag(tag: unknown): string | undefined {
  if (typeof tag !== 'string' || tag.length > 40) return undefined
  const m = TAG.exec(tag)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : undefined
}

/** Gets the text of the latest-release response, or throws. */
export type ReleaseFetcher = () => Promise<string>

export interface ReleaseFetcherOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxBytes?: number
}

export function createReleaseFetcher(options: ReleaseFetcherOptions = {}): ReleaseFetcher {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? UPDATE_FETCH_TIMEOUT_MS
  const max = options.maxBytes ?? MAX_RELEASE_BYTES
  return async () => {
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      // redirect:'error' and no credentials: the request goes to one fixed host and nowhere else.
      const res = await doFetch(LATEST_RELEASE_API, {
        redirect: 'error',
        signal: timeout,
        credentials: 'omit',
        headers: { Accept: 'application/vnd.github+json' }
      })
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new Error(`HTTP ${res.status}`)
      }
      return await readLimited(res, max)
    } catch (err) {
      if (timeout.aborted) throw new Error('no answer in time', { cause: err })
      throw err
    }
  }
}

/** The version the response announces, or undefined when it is not a well-formed stable release. */
export function parseLatestRelease(text: string): string | undefined {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  return versionOfTag((body as { tag_name?: unknown }).tag_name)
}

export function releaseUrl(version: string): string {
  return RELEASE_URL_BASE + 'v' + version
}

export interface AvailableUpdate {
  version: string
  url: string
}

export interface UpdateCheckDeps {
  /** The running app's version. */
  current: string
  fetchRelease: ReleaseFetcher
  /** `AppSettings.updateCheck`, read at each tick: anything but `false` is on. */
  enabled(): boolean
  /** `AppSettings.updateDismissed`. */
  dismissed(): string | undefined
  setDismissed(version: string): void
  /** The available update changed (or was cleared). */
  onChange?(update: AvailableUpdate | undefined): void
  now?: () => number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
  intervalMs?: number
  log?: (message: string) => void
}

export class UpdateChecker {
  private latest: string | undefined
  private timer: unknown
  /** Generation of the request in flight: a stop() makes it stale, so a new check may start beside it. */
  private inFlight: number | undefined
  /** Bumped by stop(): a reply requested before it is stale. */
  private generation = 0
  private started = false
  /** Epoch ms of the last attempt that reached the network layer; for tests and diagnostics. */
  lastCheckedAt: number | undefined

  constructor(private readonly deps: UpdateCheckDeps) {}

  /** The update to show now: newer than this app and not the one the user dismissed. */
  available(): AvailableUpdate | undefined {
    const v = this.latest
    if (v === undefined || compareVersions(v, this.deps.current) <= 0) return undefined
    const d = this.deps.dismissed()
    if (d !== undefined && versionOfTag('v' + d) !== undefined && compareVersions(v, d) <= 0) return undefined
    return { version: v, url: releaseUrl(v) }
  }

  /** Check at once and then every interval. Off in Settings makes no request, now or later. */
  start(): void {
    if (this.started) return
    this.started = true
    const every = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
    this.timer = every(() => void this.check(), this.deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS)
    // A timer must not keep the app alive on its own.
    ;(this.timer as { unref?: () => void } | undefined)?.unref?.()
    void this.check()
  }

  stop(): void {
    this.started = false
    this.generation++
    if (this.timer !== undefined) (this.deps.clearInterval ?? ((h) => clearInterval(h as never)))(this.timer)
    this.timer = undefined
  }

  /** The setting changed: off clears the notice and stops asking, on checks at once. */
  settingChanged(): void {
    if (this.deps.enabled()) {
      this.stop()
      this.start()
    } else {
      this.stop()
      this.setLatest(undefined)
    }
  }

  /** One check. Resolves when done; never rejects. */
  async check(): Promise<void> {
    const generation = this.generation
    if (!this.deps.enabled() || this.inFlight === generation) return
    this.inFlight = generation
    try {
      this.lastCheckedAt = (this.deps.now ?? Date.now)()
      const version = parseLatestRelease(await this.deps.fetchRelease())
      // Switched off or stopped while the request was out: say nothing.
      if (version !== undefined && this.deps.enabled() && generation === this.generation) this.setLatest(version)
    } catch (err) {
      this.deps.log?.(`update check failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.inFlight === generation) this.inFlight = undefined
    }
  }

  /** The user dismissed what `available()` showed; a newer release shows again. */
  dismiss(): void {
    const a = this.available()
    if (!a) return
    this.deps.setDismissed(a.version)
    this.deps.onChange?.(this.available())
  }

  private setLatest(version: string | undefined): void {
    const before = this.available()
    this.latest = version
    const after = this.available()
    if (before?.version !== after?.version) this.deps.onChange?.(after)
  }
}
