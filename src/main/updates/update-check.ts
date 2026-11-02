// The "a new version exists" check (plan: distribution, Task 4). Notice only: nothing is
// downloaded or replaced, because an update under running Claude sessions would restart them.
//
// The response is untrusted text from a third party's API. Only `tag_name` is read, and only
// when it is exactly `v<major>.<minor>.<patch>`; the release link is built here from a fixed
// base and that validated version. `html_url` and `body` are never read, so a hostile or
// compromised response cannot put a URL or text in front of the user.
// Any failure is silent (a private repo answers 404; offline is normal): logged at most.
// Pure Node, so unit tests load it (the fetcher is injected, the timer is faked).
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

export function createReleaseFetcher(doFetch: typeof fetch = globalThis.fetch.bind(globalThis)): ReleaseFetcher {
  return async () => {
    // redirect:'error' and no credentials: the request goes to one fixed host and nowhere else.
    // The timeout also covers reading the body: a stalled stream aborts the read.
    const res = await doFetch(LATEST_RELEASE_API, {
      redirect: 'error',
      signal: AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
      credentials: 'omit',
      headers: { Accept: 'application/vnd.github+json' }
    })
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`HTTP ${res.status}`)
    }
    return await readLimited(res, MAX_RELEASE_BYTES)
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
  log?: (message: string) => void
}

export class UpdateChecker {
  private latest: string | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  /** The request in flight. stop() forgets it: its reply is dropped, and a new check may start beside it. */
  private inFlight: object | undefined

  constructor(private readonly deps: UpdateCheckDeps) {}

  /** The update to show now: newer than this app and not the one the user dismissed. */
  available(): AvailableUpdate | undefined {
    const v = this.latest
    if (v === undefined || compareVersions(v, this.deps.current) <= 0) return undefined
    const d = this.deps.dismissed()
    // Validated (a string first: app.json can hold an array, which a tag check coerces): app.json can be damaged, and compareVersions reads a malformed value as equal, which would
    // hide every update for good.
    if (typeof d === 'string' && versionOfTag('v' + d) !== undefined && compareVersions(v, d) <= 0) return undefined
    return { version: v, url: releaseUrl(v) }
  }

  /** Check at once and then every interval. Off in Settings makes no request, now or later. */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.check(), UPDATE_CHECK_INTERVAL_MS)
    // A timer must not keep the app alive on its own.
    this.timer.unref()
    void this.check()
  }

  stop(): void {
    this.inFlight = undefined
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** The setting changed: off clears the notice and stops asking, on checks at once. One onChange either way. */
  settingChanged(): void {
    this.stop()
    if (this.deps.enabled()) this.start()
    else this.latest = undefined
    this.deps.onChange?.(this.available())
  }

  /** One check. Resolves when done; never rejects. */
  async check(): Promise<void> {
    if (!this.deps.enabled() || this.inFlight !== undefined) return
    const request = {}
    this.inFlight = request
    try {
      const version = parseLatestRelease(await this.deps.fetchRelease())
      // Switched off or stopped while the request was out: say nothing.
      if (version !== undefined && this.deps.enabled() && this.inFlight === request) this.setLatest(version)
    } catch (err) {
      this.deps.log?.(`update check failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      if (this.inFlight === request) this.inFlight = undefined
    }
  }

  /**
   * The user dismissed `version`, the one their window shows; a newer release shows again.
   * Recorded only when it is what main offers now: a check can land while the click is on its way,
   * and recording the current offer instead would hide, in every window and for good, a release
   * nobody saw. The renderer's value is untrusted, so anything else writes nothing; the window that
   * sent a stale version gets the new one through its own `updates.changed`.
   */
  dismiss(version: string): void {
    const a = this.available()
    if (!a || a.version !== version) return
    this.deps.setDismissed(a.version)
    this.deps.onChange?.(this.available())
  }

  private setLatest(version: string): void {
    const before = this.available()
    this.latest = version
    const after = this.available()
    if (before?.version !== after?.version) this.deps.onChange?.(after)
  }
}
