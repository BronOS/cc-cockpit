// The marketplace indexes: fetch, validate, cache (plan: plugin marketplace, Task 3).
//
// Per configured URL the service keeps the last GOOD index. A failed or invalid fetch records an
// error and leaves that index in place, so listings and, above all, revocations keep working
// offline or while a host misbehaves. The cache is read synchronously at start (`loadCache`) so
// revocations can apply before any plugin activates. Pure Node, so unit tests load it.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { isPlainObject } from '../../shared/guards'
import {
  DEFAULT_MARKETPLACE_URL,
  MAX_PREVIEW_BYTES,
  STALE_AFTER_MS,
  previewPngProblem,
  parseMarketplaceIndex,
  previewPath,
  type MarketplaceIndex
} from '../../shared/marketplace'
import type { PluginRevocation } from '../plugins/plugin-index'
import { isTestRun } from '../test-run'
import { checkMarketplaceUrl, type IndexFetcher, type PreviewFetcher } from './fetch-index'

// How often the timer asks; only a stale index is fetched. Shorter than STALE_AFTER_MS, or the tick
// that lands just before an index turns an hour old would leave it for a second hour.
const STALE_CHECK_MS = 15 * 60_000

/**
 * A preview that could not be had (offline, a 404, a bad hash) is asked again only after this long:
 * the card asks each time it scrolls into view, and a broken image must not cost a fetch every time.
 */
export const PREVIEW_RETRY_MS = 10 * 60_000

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
  /** Gets a preview's bytes; without one no preview is ever shown (each card shows its placeholder). */
  previewFetcher?: PreviewFetcher
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
  private readonly previewDir: string
  /** One fetch per preview hash: the cards of two windows (or a re-render) share it. */
  private readonly previewsInFlight = new Map<string, Promise<Uint8Array | null>>()
  /** When a preview last failed, by hash (PREVIEW_RETRY_MS). */
  private readonly previewFailedAt = new Map<string, number>()

  constructor(private readonly options: MarketplaceServiceOptions) {
    this.cacheDir = join(options.dataDir, 'marketplaces')
    this.previewDir = join(options.dataDir, 'marketplace', 'previews')
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

  /**
   * The preview of one listing (design-next §6.1), or null when it has none or it cannot be had. The
   * renderer names the listing only (`indexUrl` + `id`); the hash, commit and URL come from main's own
   * validated index, and the URL is the index's own folder (`previews/<id>/<commit>.png`), never one
   * the renderer or the entry spells. The bytes must hash to the entry's sha256 and pass the PNG framing
   * check (`previewPngProblem`: a third-party index controls bytes and hash, so the app does not lean on
   * the index CI); then they
   * are cached under `<data>/marketplace/previews/<sha256>.png`, re-hashed on every read, so a
   * changed or truncated cache file is fetched again rather than shown.
   */
  async preview(indexUrl: unknown, id: unknown): Promise<Uint8Array | null> {
    if (typeof indexUrl !== 'string' || typeof id !== 'string') return null
    // Configured indexes only: the page shows no other, and an authority kept for its revocations alone is no listing.
    if (!this.options.urls().includes(indexUrl)) return null
    const entry = this.states.get(indexUrl)?.index?.plugins.find((p) => p.id === id)
    const sha256 = entry?.preview?.sha256
    if (entry === undefined || sha256 === undefined || this.options.previewFetcher === undefined) return null
    const cached = this.readPreviewCache(sha256)
    if (cached !== null) return cached
    const failed = this.previewFailedAt.get(sha256)
    if (failed !== undefined && this.now() - failed < PREVIEW_RETRY_MS && this.now() >= failed) return null
    const running = this.previewsInFlight.get(sha256)
    if (running) return running
    const p = this.fetchPreview(indexUrl, entry.id, entry.commit, sha256).finally(() => this.previewsInFlight.delete(sha256))
    this.previewsInFlight.set(sha256, p)
    return p
  }

  private previewFile(sha256: string): string {
    // sha256 passed SHA256_PATTERN in parseEntry: 64 lowercase hex, no path in it.
    return join(this.previewDir, `${sha256}.png`)
  }

  /** The cached bytes when they are still exactly the preview of that hash; a bad file is removed. */
  private readPreviewCache(sha256: string): Uint8Array | null {
    const file = this.previewFile(sha256)
    try {
      const st = statSync(file)
      if (!st.isFile() || st.size > MAX_PREVIEW_BYTES) throw new Error('not a usable cache file')
      const bytes = readFileSync(file)
      if (isPreviewOf(bytes, sha256)) return bytes
      throw new Error('the cached preview does not match its hash')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      try {
        // A folder in its place is left alone (rmSync refuses it); the fetch then fails to write and logs.
        rmSync(file, { force: true })
      } catch {
        this.options.log?.('cannot remove a bad marketplace preview from the cache')
      }
      return null
    }
  }

  private async fetchPreview(indexUrl: string, id: string, commit: string, sha256: string): Promise<Uint8Array | null> {
    const folder = new URL('./', indexUrl).href
    const url = new URL(previewPath(id, commit), folder).href
    // id and commit were checked by parseEntry (no `/`, `..` or `%`), so this holds; it stays as the rule's own check.
    if (!url.startsWith(folder)) return null
    let bytes: Uint8Array
    try {
      bytes = await this.options.previewFetcher!(url)
      if (!isPreviewOf(bytes, sha256)) throw new Error('the preview does not match the hash in the index')
    } catch (err) {
      this.previewFailedAt.set(sha256, this.now())
      this.options.log?.(`marketplace preview of ${id}: ${err instanceof Error ? err.message : 'failed'}`)
      return null
    }
    this.previewFailedAt.delete(sha256)
    this.writePreviewCache(sha256, bytes)
    return bytes
  }

  /**
   * tmp + rename, then drop every cached preview no index lists any more: the folder holds at most the
   * previews of the listings shown, and an old version's image does not stay for good.
   */
  private writePreviewCache(sha256: string, bytes: Uint8Array): void {
    const file = this.previewFile(sha256)
    const tmp = `${file}.tmp`
    try {
      mkdirSync(this.previewDir, { recursive: true, mode: 0o700 })
      writeFileSync(tmp, bytes, { mode: 0o600 })
      renameSync(tmp, file)
    } catch {
      this.options.log?.('cannot write a marketplace preview to the cache')
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* nothing to clean */
      }
      return
    }
    const listed = new Set<string>()
    for (const s of this.states.values()) for (const e of s.index?.plugins ?? []) if (e.preview) listed.add(e.preview.sha256)
    try {
      for (const name of readdirSync(this.previewDir)) {
        const hash = name.endsWith('.png') ? name.slice(0, -'.png'.length) : null
        if (hash !== null && listed.has(hash)) continue
        // A stray `.tmp` belongs to a write that is not running now: writes are synchronous.
        rmSync(join(this.previewDir, name), { force: true })
      }
    } catch {
      this.options.log?.('cannot prune the marketplace preview cache')
    }
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

/**
 * The bytes are the preview the index pinned: its sha256, and sound PNG framing. A third-party index
 * controls both bytes and hash, so the hash alone proves nothing about size: the framing check
 * (IHDR size in range, no APNG, not truncated; nothing is decoded) keeps a decompression bomb from
 * reaching the shell renderer, on the fetch and on every cache read.
 */
function isPreviewOf(bytes: Uint8Array, sha256: string): boolean {
  return bytes.length <= MAX_PREVIEW_BYTES && previewPngProblem(bytes) === null && createHash('sha256').update(bytes).digest('hex') === sha256
}
