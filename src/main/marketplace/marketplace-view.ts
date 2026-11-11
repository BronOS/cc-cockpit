// What the Marketplace page shows (plan: plugin marketplace, Task 5): each index's listings with a
// status, computed from main's own validated index state and installed-plugin records. Pure, so unit
// tests drive it with plain objects. The same function answers "may this listing be installed or
// updated?" (`entries[].action`), so a button and the install call can never disagree.
import type { MarketplaceEntryView, MarketplaceIndexView, MarketplaceView, MarketplaceWarningView } from '../../shared/ipc'
import { compareVersions, plainDisplayText, type MarketplaceEntry } from '../../shared/marketplace'
import { SUPPORTED_PLUGIN_API } from '../../shared/manifest'
import type { InstalledPlugin } from '../plugins/installer'
import type { PluginRevocation } from '../plugins/plugin-index'
import type { MarketplaceState, RevocationQuery } from './marketplace-service'

const MAX_NOTICE_REASON = 200

/**
 * The notification for plugins that just became revoked. `reason` is an index's own text, a
 * notification is no React text, and a stored one may predate the parser's cleaning: plain and capped
 * here whatever came in. Id and source are checked values.
 */
export function revocationNotice(plugins: { id: string; revoked: PluginRevocation }[]): string {
  return plugins
    .map((p) => `Plugin ${p.id} was stopped: ${plainDisplayText(p.revoked.reason, MAX_NOTICE_REASON)} (revoked by ${p.revoked.source})`)
    .join('\n')
}

/**
 * The same notice for a server's stdout, one line per plugin and with none of the index's text: a
 * stdout line is read in a journal, and the reason an index gave (and the URL it came from) is
 * untrusted text the Plugins page shows instead. The id is a checked value.
 */
export function revocationNoticeLines(plugins: { id: string; revoked: PluginRevocation }[]): string[] {
  return plugins.map((p) => `Plugin ${p.id} was stopped: the marketplace index revoked it (the reason is on the Plugins page)`)
}

/** A listing together with what the view says about it; `entry` is the validated index data install uses. */
export interface ResolvedEntry {
  view: MarketplaceEntryView
  entry: MarketplaceEntry
}

export interface MarketplaceViewInput {
  states: MarketplaceState[]
  installed: InstalledPlugin[]
  /** The enforced revocation for this commit (default index or the plugin's own index), if any. */
  revocationFor(query: RevocationQuery): PluginRevocation | null | undefined
  revocationWarnings(query: RevocationQuery): PluginRevocation[]
  /** The git URL this id was last installed from, kept past an uninstall. */
  lastRepo(id: string): string | undefined
  /** Some project still has this id on (an uninstall leaves `enabledPlugins` alone), or may: a record that cannot be read counts. */
  enabledInAProject(id: string): boolean
}

/** What `repoChangedFrom` says for an id with a leftover enablement and no recorded repo. */
const UNRECORDED_REPO = 'an unrecorded repository'

/**
 * The repository `id` last came from, when a listing of `repo` is not known to be the same one; else
 * undefined. No record but still on somewhere: it was installed before records existed, or linked. Its
 * enablement and data are left over from code nobody can compare with this listing, so that counts as
 * a change too: the listing must not start enabled, with that data, unasked.
 */
export function repoChangeFrom(id: string, repo: string, input: Pick<MarketplaceViewInput, 'lastRepo' | 'enabledInAProject'>): string | undefined {
  const last = input.lastRepo(id)
  if (last !== undefined) return last !== repo ? last : undefined
  return input.enabledInAProject(id) ? UNRECORDED_REPO : undefined
}

/** What the view says about a listing; `resolveEntry` adds the listing's own facts. */
type EntryStatus = Pick<MarketplaceEntryView, 'status' | 'installedVersion' | 'note' | 'revokedReason' | 'repoChangedFrom'> & {
  action?: 'install' | 'update'
}

/** Case-insensitive: installer.ts refuses a version that differs only in case. */
const sameVersion = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const revocationFields = (revoked: PluginRevocation | undefined): Pick<MarketplaceEntryView, 'revokedReason'> =>
  revoked ? { revokedReason: revoked.reason } : {}

/**
 * This listing's commit is revoked, asked as if installed from this index: every caller has either no
 * plugin yet or one recorded from this very index.
 */
function listingRevocation(url: string, entry: MarketplaceEntry, input: MarketplaceViewInput): PluginRevocation | null | undefined {
  return input.revocationFor({ id: entry.id, commit: entry.commit, marketplace: url })
}

function resolveAvailable(url: string, entry: MarketplaceEntry, input: MarketplaceViewInput): EntryStatus {
  const revoked = listingRevocation(url, entry, input)
  if (revoked) return { status: 'revoked', revokedReason: revoked.reason, note: 'this version was revoked by the index' }
  const from = repoChangeFrom(entry.id, entry.repo, input)
  if (from !== undefined) {
    return {
      status: 'available',
      action: 'install',
      repoChangedFrom: from,
      note: `this id was last installed from ${from}; this listing is not known to be the same repository, and installing switches the plugin off in every project`
    }
  }
  return { status: 'available', action: 'install' }
}

function resolveInstalled(url: string, entry: MarketplaceEntry, installed: InstalledPlugin, input: MarketplaceViewInput): EntryStatus {
  // A bundled or linked id is shown as such with no button: syncBundled yields a bundled id to a
  // git install, so a listing could otherwise replace the built-in browser.
  if (installed.source.kind === 'bundled') {
    return { status: 'built-in', installedVersion: installed.version, note: 'built in; it updates with the app' }
  }
  if (installed.source.kind === 'linked') {
    return { status: 'linked', installedVersion: installed.version, note: 'linked from a folder; it updates from there' }
  }

  const installedRevocation = installed.state.ok === false ? installed.state.revoked : undefined
  const installedVersion = installed.version
  const git = installed.source
  // An update is offered from the index recorded on the plugin only; any other listing of the same
  // id is informational (its owner could otherwise take over a plugin).
  if (installed.marketplace !== url) {
    return {
      status: installedRevocation ? 'revoked' : 'installed',
      installedVersion,
      ...revocationFields(installedRevocation),
      note:
        installed.marketplace === undefined
          ? 'installed from a git URL; it updates from there'
          : 'installed from another marketplace index'
    }
  }
  if (git.kind === 'git' && git.url !== entry.repo) {
    return {
      status: 'repo-changed',
      installedVersion,
      ...revocationFields(installedRevocation),
      note: `the index now lists a different repository (${entry.repo}); uninstall and install it again to switch`
    }
  }
  const entryRevocation = listingRevocation(url, entry, input)
  if (entryRevocation) {
    return {
      status: 'revoked',
      installedVersion,
      revokedReason: entryRevocation.reason,
      note: 'this version was revoked by the index'
    }
  }
  if (installedRevocation) {
    // The one case that moves to an older version: uninstalling would wipe the plugin's secrets.
    const other = installed.commit !== entry.commit && !sameVersion(entry.version, installedVersion)
    return {
      status: 'revoked',
      installedVersion,
      revokedReason: installedRevocation.reason,
      ...(other ? { action: 'update' as const } : { note: 'no safe version is listed; uninstall it' })
    }
  }
  if (!sameVersion(entry.version, installedVersion) && compareVersions(entry.version, installedVersion) > 0) {
    return { status: 'update', installedVersion, action: 'update' }
  }
  return { status: 'installed', installedVersion }
}

function resolveEntry(url: string, entry: MarketplaceEntry, input: MarketplaceViewInput): ResolvedEntry {
  const installed = input.installed.find((p) => p.id === entry.id)
  const status = installed === undefined ? resolveAvailable(url, entry, input) : resolveInstalled(url, entry, installed, input)
  return {
    entry,
    view: {
      indexUrl: url,
      id: entry.id,
      name: entry.name,
      description: entry.description,
      author: entry.author,
      repo: entry.repo,
      tag: entry.tag,
      commit: entry.commit,
      version: entry.version,
      preview: entry.preview !== undefined,
      category: entry.category,
      action: null,
      ...status
    }
  }
}

export function resolveMarketplace(input: MarketplaceViewInput): { entries: ResolvedEntry[]; indexes: MarketplaceIndexView[] } {
  const entries: ResolvedEntry[] = []
  const indexes: MarketplaceIndexView[] = []
  for (const s of input.states) {
    let incompatible = 0
    for (const entry of s.index?.plugins ?? []) {
      // A plugin built for another API major cannot load here; it is counted, not listed.
      if (entry.api !== SUPPORTED_PLUGIN_API) {
        incompatible++
        continue
      }
      entries.push(resolveEntry(s.url, entry, input))
    }
    indexes.push({
      url: s.url,
      fetchedAt: s.fetchedAt,
      error: s.error,
      skippedEntries: s.skippedEntries,
      skippedRevocations: s.skippedRevocations,
      incompatible
    })
  }
  return { entries, indexes }
}

export function buildMarketplaceView(input: MarketplaceViewInput): MarketplaceView {
  const { entries, indexes } = resolveMarketplace(input)
  const warnings: MarketplaceWarningView[] = []
  for (const p of input.installed) {
    // A linked plugin has no commit and is never matched.
    if (p.source.kind !== 'git' || p.commit === undefined) continue
    const query: RevocationQuery = { id: p.id, commit: p.commit, ...(p.marketplace !== undefined ? { marketplace: p.marketplace } : {}) }
    for (const w of input.revocationWarnings(query)) {
      warnings.push({ pluginId: p.id, pluginName: p.manifest?.name ?? p.id, reason: w.reason, source: w.source })
    }
  }
  return { indexes, entries: entries.map((e) => e.view), warnings }
}
