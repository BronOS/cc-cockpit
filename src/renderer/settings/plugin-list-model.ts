// The one Plugins page's list (design-next §6.2, §6.3): installed plugins and marketplace listings
// merged into cards, then searched, filtered and paged here in the renderer. Pure, so the paging and
// search rules are unit-tested without a page. Nothing here fetches: the page has the whole index
// already (main caps it at 5 MiB and 2000 entries), so a new page or a new search is no new request.
import type { MarketplaceEntryView, MarketplaceView, PluginView } from '../../shared/ipc'
import type { MarketplaceCategory } from '../../shared/marketplace'

export const PAGE_SIZE = 20

export const PLUGIN_FILTERS = ['all', 'installed', 'available', 'updates'] as const
export type PluginFilter = (typeof PLUGIN_FILTERS)[number]

export const FILTER_LABELS: Record<PluginFilter, string> = {
  all: 'All',
  installed: 'Installed',
  available: 'Available',
  updates: 'Updates'
}

export const CATEGORY_LABELS: Record<MarketplaceCategory, string> = {
  sources: 'Sources',
  views: 'Views',
  tools: 'Tools',
  themes: 'Themes',
  claude: 'Claude',
  other: 'Other'
}

export interface PluginCard {
  /** Stable React key: the id for an installed plugin, `indexUrl|id` for a listing alone. */
  key: string
  id: string
  name: string
  /** Installed: the plugin as main reports it. */
  plugin?: PluginView
  /**
   * The marketplace listing shown on the card: for an installed plugin the one from its recorded index
   * (the only one that may offer an update), else the first listing of its id (text only); for a
   * plugin not installed, the listing itself.
   */
  listing?: MarketplaceEntryView
  /** The listing's category; an installed plugin with no listing reads as `other` (absent = other). */
  category: MarketplaceCategory
}

/**
 * Installed plugins first, in main's order, then every listing of an id not installed, one card per
 * index and id (the same plugin offered by two indexes is two choices: each installs from its own).
 * Other indexes' listings of an installed id add no card: they could offer nothing but their text.
 */
export function buildCards(plugins: PluginView[] | null, view: MarketplaceView | null): PluginCard[] {
  const entries = view?.entries ?? []
  const cards: PluginCard[] = []
  const installed = new Set<string>()
  for (const plugin of plugins ?? []) {
    installed.add(plugin.id)
    const same = entries.filter((e) => e.id === plugin.id)
    // The recorded index is authoritative (marketplace-view.ts gives only it an action); a git-URL,
    // linked or bundled plugin has none, so the first listing lends its description and category.
    const listing =
      (plugin.marketplace !== undefined ? same.find((e) => e.indexUrl === plugin.marketplace) : undefined) ?? same[0]
    cards.push({
      key: plugin.id,
      id: plugin.id,
      name: plugin.name,
      plugin,
      ...(listing !== undefined ? { listing } : {}),
      category: listing?.category ?? 'other'
    })
  }
  for (const e of entries) {
    if (installed.has(e.id)) continue
    cards.push({ key: `${e.indexUrl}|${e.id}`, id: e.id, name: e.name, listing: e, category: e.category })
  }
  return cards
}

/** An installed plugin its recorded index offers a newer (or, when revoked, a safe) version of. */
export const hasUpdate = (c: PluginCard): boolean => c.plugin !== undefined && c.listing?.action === 'update'

/**
 * Case-insensitive substring over name, id, author and description: no regex, so a typed `(`
 * or `.*` is just text. An empty (or blank) query matches everything.
 */
export function matchesSearch(c: PluginCard, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const texts = [c.name, c.id, c.listing?.author ?? '', c.listing?.description ?? '']
  return texts.some((t) => t.toLowerCase().includes(needle))
}

export function matchesFilter(c: PluginCard, filter: PluginFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'installed':
      return c.plugin !== undefined
    case 'available':
      return c.plugin === undefined
    case 'updates':
      return hasUpdate(c)
  }
}

export interface ListQuery {
  search: string
  filter: PluginFilter
  /** `null`: every category. */
  category: MarketplaceCategory | null
}

export function filterCards(cards: PluginCard[], q: ListQuery): PluginCard[] {
  return cards.filter((c) => matchesFilter(c, q.filter) && (q.category === null || c.category === q.category) && matchesSearch(c, q.search))
}

/** At least one page, so an empty result still reads "page 1 of 1". */
export const pageCount = (total: number): number => Math.max(1, Math.ceil(total / PAGE_SIZE))

/** A page number (0-based) kept inside the list: a search that shrinks it lands on its last page. */
export function clampPage(page: number, total: number): number {
  if (!Number.isFinite(page)) return 0
  return Math.min(Math.max(0, Math.floor(page)), pageCount(total) - 1)
}

export function pageSlice<T>(items: T[], page: number): T[] {
  const p = clampPage(page, items.length)
  return items.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE)
}

/** The page holding the card of this id (the panel gear opens the page there), or 0 when none does. */
export function pageOf(cards: PluginCard[], id: string): number {
  const i = cards.findIndex((c) => c.id === id)
  return i < 0 ? 0 : Math.floor(i / PAGE_SIZE)
}

/**
 * What "Update all" offers (design-next §6.4): each listing that is a plain newer version from the
 * installed plugin's recorded index. marketplace-view.ts gives `status: 'update'` only there, so linked,
 * git-URL and bundled plugins never appear, and a revoked plugin's move to a safe version (status
 * `revoked`, maybe a downgrade) stays a decision on its own card. Main applies the same rule again.
 */
export function updateAllEntries(view: MarketplaceView | null): MarketplaceEntryView[] {
  return (view?.entries ?? []).filter((e) => e.status === 'update' && e.action === 'update')
}

/**
 * The open "Update all" prompt still shows what main would update: every listed plugin is still offered
 * at the same repo and commit. A refresh that moved one closes the prompt rather than send a pin the
 * person did not see (main would refuse it anyway). New updates that appeared meanwhile are not in the
 * prompt, and so not sent: it updates only what it lists.
 */
export function updateAllStillShown(shown: MarketplaceEntryView[], view: MarketplaceView): boolean {
  const now = updateAllEntries(view)
  return shown.every((s) => now.some((e) => e.indexUrl === s.indexUrl && e.id === s.id && e.repo === s.repo && e.commit === s.commit))
}
