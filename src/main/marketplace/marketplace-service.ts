// The marketplace indexes: fetch, validate, cache (plan: plugin marketplace, Task 3).
//
// Per configured URL the service keeps the last GOOD index. A failed or invalid fetch records an
// error and leaves that index in place, so listings and, above all, revocations keep working
// offline or while a host misbehaves. The cache is read synchronously at start (`loadCache`) so
// revocations can apply before any plugin activates. Pure Node, so unit tests load it.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../../shared/guards'
import { DEFAULT_MARKETPLACE_URL, STALE_AFTER_MS, parseMarketplaceIndex, type MarketplaceIndex } from '../../shared/marketplace'
import type { PluginRevocation } from '../plugins/plugin-index'
import { isTestRun } from '../test-run'
import { checkMarketplaceUrl, type IndexFetcher } from './fetch-index'

// How often the timer asks; only a stale index is fetched. Shorter than STALE_AFTER_MS, or the tick
// that lands just before an index turns an hour old would leave it for a second hour.
const STALE_CHECK_MS = 15 * 60_000

export interface MarketplaceState {
  url: string
  /** The last good index, or null before any fetch or cache succeeded. */
  index: MarketplaceIndex | null
  /** When `index` was fetched (epoch ms), 0 when there is none. */
  fetchedAt: number
  /** Why the latest attempt failed, or null. */
  error: string | null
  skippedEntries: number
  skippedRevocations: number
}

/**
 * The configured index URLs: `CC_COCKPIT_MARKETPLACE_URLS` (comma separated, may be empty) replaces
 * everything in a test run only; otherwise the app setting, else the official URL. Entries that are
 * not usable URLs are dropped (app.json is user-writable); URLs are normalized and duplicates collapse.
 */
export function marketplaceUrls(
  setting: unknown,
  env: Record<string, string | undefined>,
  isPackaged: boolean
): string[] {
  const override = env.CC_COCKPIT_MARKETPLACE_URLS
  const raw: unknown[] =
    isTestRun(env, isPackaged) && override !== undefined
      ? override.split(',').map((s) => s.trim())
      : Array.isArray(setting)
        ? setting
        : [DEFAULT_MARKETPLACE_URL]
  const out: string[] = []
  for (const u of raw) {
    const c = checkMarketplaceUrl(u)
    if ('url' in c && !out.includes(c.url)) out.push(c.url)
  }
  return out
}

export interface MarketplaceServiceOptions {
  dataDir: string
  /** The configured URLs, asked at each use so a settings change applies without a restart. */
  urls: () => string[]
  fetcher: IndexFetcher
  /**
   * Indexes recorded on installed plugins. They are read and fetched whatever the configured list
   * says, like the default index: they hold the revocations that are enforced, and removing one from
   * the list must not freeze them. Asked before the installer exists (`loadCache`), so it must answer
   * from the stored records.
   */
  authorities: () => string[]
  now?: () => number
  log?: (message: string) => void
  /** A refresh replaced at least one index, called once per refresh: revocations must be applied again. */
  onRefreshed?: () => void
}

/** A plugin as revocation sees it: a linked plugin has no commit and so is never asked about. */
export interface RevocationQuery {
  id: string
  commit: string
  /** The index recorded on the plugin. */
  marketplace?: string
  /** The index behind the revocation already recorded on the plugin, if any: its own copy can withdraw it. */
  recordedSource?: string
}

export class MarketplaceService {
  private readonly states = new Map<string, MarketplaceState>()
  private readonly cacheDir: string
  private readonly now: () => number
  /** One running refresh per URL: concurrent callers share it, so an older response cannot overwrite a newer one. */
  private readonly inFlight = new Map<string, Promise<void>>()
  private indexReplaced = false

  constructor(private readonly options: MarketplaceServiceOptions) {
    this.cacheDir = join(options.dataDir, 'marketplaces')
    this.now = options.now ?? Date.now
  }

  private cacheFile(url: string): string {
    return join(this.cacheDir, `${createHash('sha256').update(url).digest('hex')}.json`)
  }

  private stateOf(url: string): MarketplaceState {
    let s = this.states.get(url)
    if (!s) {
      s = { url, index: null, fetchedAt: 0, error: null, skippedEntries: 0, skippedRevocations: 0 }
      this.states.set(url, s)
    }
    return s
  }

  /**
   * Read the cache file of every URL a refresh fetches: an authority no longer on the configured list
   * must still answer, since taking an index off the list must not act as an override. Synchronous on
   * purpose: startup applies revocations from it before `plugins.load()`, not after the network
   * answers. The cached text is validated again, so a hand-edited or corrupt file is ignored rather
   * than trusted.
   */
  loadCache(): void {
    for (const url of this.fetchUrls()) this.readCache(url)
  }

  private readCache(url: string): void {
    const state = this.stateOf(url)
    try {
      const data: unknown = JSON.parse(readFileSync(this.cacheFile(url), 'utf8'))
      if (!isPlainObject(data) || typeof data.text !== 'string' || typeof data.fetchedAt !== 'number') return
      const parsed = parseMarketplaceIndex(data.text, { indexUrl: url })
      if (!parsed.ok) return
      state.index = parsed.index
      state.fetchedAt = data.fetchedAt
      state.skippedEntries = parsed.skippedEntries
      state.skippedRevocations = parsed.skippedRevocations
    } catch (err) {
      // A missing file is the normal first start; anything else (corrupt JSON) is only logged.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.options.log?.(`marketplace cache for ${url} is unusable`)
    }
  }

  /** `url`'s revocation of this commit in the last good index, if any. */
  private revocationIn(url: string, plugin: RevocationQuery): PluginRevocation | null {
    const hit = this.stateOf(url).index?.revoked.find((r) => r.id === plugin.id && r.commit === plugin.commit)
    return hit ? { reason: hit.reason, source: url } : null
  }

  /**
   * The revocation to enforce: only the default index or the one recorded on the plugin has that
   * authority, since commit hashes are public and any other added index could otherwise disable a
   * plugin of its choosing. Both are consulted even when no longer configured: an enforced revocation
   * has no override (`loadCache`, `fetchUrls`). Undefined when no hit and an authority has no usable
   * index (cache missing or corrupt, never fetched): "not revoked" is not known then. The exception: a
   * good copy of the index that issued the recorded revocation no longer lists it, so it is withdrawn;
   * another authority with no index must not keep it in force for good. Withdrawing is the issuer's
   * alone: a revocation from an index with no usable copy stays, whoever else is reachable.
   */
  revocationFor(plugin: RevocationQuery): PluginRevocation | null | undefined {
    const authorities = [...(plugin.marketplace !== undefined ? [plugin.marketplace] : []), DEFAULT_MARKETPLACE_URL]
    let unknown = false
    for (const url of authorities) {
      const hit = this.revocationIn(url, plugin)
      if (hit !== null) return hit
      if (this.stateOf(url).index === null) unknown = true
    }
    if (!unknown) return null
    const issuer = plugin.recordedSource
    return issuer !== undefined && authorities.includes(issuer) && this.stateOf(issuer).index !== null ? null : undefined
  }

  /** Revocations from configured indexes without authority over this plugin: a warning only, never enforced. */
  revocationWarnings(plugin: RevocationQuery): PluginRevocation[] {
    return this.options
      .urls()
      .filter((url) => url !== plugin.marketplace && url !== DEFAULT_MARKETPLACE_URL)
      .flatMap((url) => this.revocationIn(url, plugin) ?? [])
  }

  /** Every URL a refresh fetches: the configured ones plus the authorities (default index, recorded indexes). */
  private fetchUrls(): string[] {
    const out = [...this.options.urls()]
    for (const u of [DEFAULT_MARKETPLACE_URL, ...this.options.authorities()]) {
      const c = checkMarketplaceUrl(u)
      if ('url' in c && !out.includes(c.url)) out.push(c.url)
    }
    return out
  }

  /**
   * Drop the state and cache file of every URL that is neither configured nor an authority: a
   * removed index must not keep a stale listing (or its fetchedAt) to come back when a fetch fails.
   * Its running fetch is forgotten too: re-adding the URL before it answers must start a new one, or
   * the visible index would wait on a response that only updates the state dropped here.
   */
  prune(): void {
    const keep = new Set(this.fetchUrls())
    for (const url of [...this.states.keys()]) {
      if (keep.has(url)) continue
      this.states.delete(url)
      this.inFlight.delete(url)
      try {
        rmSync(this.cacheFile(url), { force: true })
      } catch {
        this.options.log?.(`cannot remove the marketplace cache for ${url}`)
      }
    }
  }

  /** The state of each configured URL, in configured order (URLs no longer configured are not shown). */
  list(): MarketplaceState[] {
    return this.options.urls().map((u) => ({ ...this.stateOf(u) }))
  }

  /** Fetch every configured index. Never throws: a failure lands in that URL's `error`. */
  async refresh(): Promise<void> {
    await Promise.all(this.fetchUrls().map((u) => this.refreshOne(u)))
    this.reportRefreshed()
  }

  /** Refresh only the indexes that were never fetched or are older than an hour (or whose last try failed). */
  async refreshIfStale(): Promise<void> {
    const now = this.now()
    const stale = this.fetchUrls().filter((u) => {
      const s = this.stateOf(u)
      return s.index === null || s.error !== null || s.fetchedAt > now || now - s.fetchedAt >= STALE_AFTER_MS
    })
    await Promise.all(stale.map((u) => this.refreshOne(u)))
    this.reportRefreshed()
  }

  /**
   * Keep the indexes fresh while the app stays open: a revocation must reach somebody who leaves it
   * running for days. Returns how to stop. Unref'd, so the timer alone keeps nothing alive.
   */
  startPeriodicRefresh(): () => void {
    const timer = setInterval(() => void this.refreshIfStale(), STALE_CHECK_MS)
    timer.unref()
    return () => clearInterval(timer)
  }

  private reportRefreshed(): void {
    if (!this.indexReplaced) return
    this.indexReplaced = false
    this.options.onRefreshed?.()
  }

  private refreshOne(url: string): Promise<void> {
    const running = this.inFlight.get(url)
    if (running) return running
    // Only its own slot: after a prune and re-add the slot holds a newer fetch that callers must still share.
    const p: Promise<void> = this.doRefresh(url).finally(() => {
      if (this.inFlight.get(url) === p) this.inFlight.delete(url)
    })
    this.inFlight.set(url, p)
    return p
  }

  private async doRefresh(url: string): Promise<void> {
    const state = this.stateOf(url)
    const checked = checkMarketplaceUrl(url)
    if ('problem' in checked) {
      state.error = checked.problem
      return
    }
    let text: string
    try {
      text = await this.options.fetcher(url)
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'the index could not be fetched'
      return
    }
    const parsed = parseMarketplaceIndex(text, { indexUrl: url })
    if (!parsed.ok) {
      // The last good index (and its revocations) stays.
      state.error = parsed.error
      return
    }
    // Pruned while fetching: this state is gone and its index removed, so nothing may be recorded, and
    // above all no cache file that a later start would read back.
    if (this.states.get(url) !== state) return
    const fetchedAt = this.now()
    state.index = parsed.index
    state.fetchedAt = fetchedAt
    state.error = null
    state.skippedEntries = parsed.skippedEntries
    state.skippedRevocations = parsed.skippedRevocations
    this.indexReplaced = true
    this.writeCache(url, text, fetchedAt)
  }

  // tmp + rename: a crash mid-write must not leave a half file that would drop the cached revocations.
  private writeCache(url: string, text: string, fetchedAt: number): void {
    const file = this.cacheFile(url)
    const tmp = `${file}.tmp`
    try {
      mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 })
      writeFileSync(tmp, JSON.stringify({ url, fetchedAt, text }), { mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      this.options.log?.(`cannot write the marketplace cache for ${url}`)
      try {
        unlinkSync(tmp)
      } catch {
        /* nothing to clean */
      }
    }
  }
}
