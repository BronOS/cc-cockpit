import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { MarketplaceEntryView, MarketplaceIndexView, MarketplaceView, PluginView } from '../../shared/ipc'
import { MARKETPLACE_CATEGORIES, STALE_AFTER_MS, type MarketplaceCategory } from '../../shared/marketplace'
import { serviceProblemMessage, type PluginServiceStatus, type PluginServicesView } from '../../shared/services'
import { GearIcon } from './icons'
import { IndexesSection, MarketplaceNotices } from './MarketplaceIndexes'
import {
  buildCards,
  CATEGORY_LABELS,
  clampPage,
  FILTER_LABELS,
  filterCards,
  pageCount,
  pageOf,
  pageSlice,
  PLUGIN_FILTERS,
  updateAllEntries,
  updateAllStillShown,
  type PluginCard,
  type PluginFilter
} from './plugin-list-model'
import { PluginPreview } from './PluginPreview'
import { PluginSettingsForm } from './PluginSettingsForm'
import { PluginSettingsPage } from './PluginSettingsPage'
import { Empty, PageHeader, Select, Switch } from './ui'
import { UpdateAll, type UpdateAllOutcome } from './UpdateAll'
import { useAction, type Action } from './use-action'
import { useLoaded } from './use-loaded'

const loadPlugins = (): Promise<PluginView[]> => window.cockpit.invoke('settings.plugins')

// Services are this project's: main answers for the window's project and only over the plugins its host runs.
// Only each card's provides / uses / problems are shown here; the picks themselves are on This Project.
const loadServices = (): Promise<PluginServicesView | null> => window.cockpit.invoke('settings.pluginServices').catch(() => null)

/** The page itself refreshes such an index when it opens: `settings.marketplace` is a snapshot and fetches nothing. */
const stale = (i: MarketplaceIndexView): boolean => i.fetchedAt === 0 || i.error !== null || Date.now() - i.fetchedAt >= STALE_AFTER_MS

const STATUS_TEXT: Record<MarketplaceEntryView['status'], string> = {
  available: 'available',
  installed: 'installed',
  'built-in': 'built in',
  linked: 'linked',
  update: 'update available',
  revoked: 'revoked',
  'repo-changed': 'repository changed'
}

/** A listing's open install / update prompt; `repo` + `commit` are what it displays, so a view that changes either closes it. */
interface Confirming {
  indexUrl: string
  id: string
  repo: string
  commit: string
}

/**
 * Settings › Plugins (design-next §6.3): one list of cards for the installed plugins and the plugins the
 * configured marketplace indexes list, searched, filtered and paged in the renderer (plugin-list-model.ts).
 * Install or update from a listing, install from a git URL or link a folder ("Add plugin…"), uninstall,
 * switch a bundled plugin off everywhere, and open a plugin's global settings (the gear). Index management
 * is the collapsible section at the bottom.
 *
 * Everything in a listing is the index's own untrusted text: React text only (never HTML), and the repo is
 * shown as given, not made a link. The install and update calls send `indexUrl` + `id` and, as an
 * expectation only, the repo and commit shown; main looks the pin up in its own state and refuses when it
 * differs. "Listed" means an index names this commit, not that anyone reviewed the code: the prompt says so.
 * The page touches the network only through the marketplace fetch (`settings.marketplaceRefresh`).
 */
export function PluginsPage(props: {
  /**
   * Switch Settings to This Project, where a plugin is enabled per project. Each installed card offers it:
   * the manual test of the bundled browser went looking for an enable switch here and found none.
   */
  onOpenProject: () => void
  /** The panel gear opened Settings here: this plugin's card shows its settings and scrolls into view. */
  openPlugin?: string | undefined
}): React.JSX.Element {
  const plugins = useLoaded(loadPlugins)
  const reloadPlugins = plugins.reload
  const services = useLoaded(loadServices)
  const [view, setView] = useState<MarketplaceView | null>(null)
  // The marketplace is a courtesy here: an index that cannot be read must not break the installed list.
  const [marketFailed, setMarketFailed] = useState(false)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [installed, setInstalled] = useState<{ indexUrl: string; id: string } | null>(null)
  const { busy, error, run } = useAction()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<PluginFilter>('all')
  const [category, setCategory] = useState<MarketplaceCategory | null>(null)
  const [page, setPage] = useState(0)
  const [updateAllShown, setUpdateAllShown] = useState<MarketplaceEntryView[] | null>(null)
  const [updateAllOutcome, setUpdateAllOutcome] = useState<UpdateAllOutcome | null>(null)

  /** Show a fresh view; it closes a prompt whose entry lost its button or moved to another repo or commit. */
  const applyView = (v: MarketplaceView): void => {
    setView(v)
    setMarketFailed(false)
    setConfirming((c) => {
      if (c === null) return null
      const e = v.entries.find((x) => x.indexUrl === c.indexUrl && x.id === c.id)
      return e !== undefined && e.action !== null && e.repo === c.repo && e.commit === c.commit ? c : null
    })
    setUpdateAllShown((shown) => (shown !== null && updateAllStillShown(shown, v) ? shown : null))
    setInstalled(null)
  }
  const reloadMarket = (): void => {
    window.cockpit.invoke('settings.marketplace').then(applyView, () => {})
  }
  const reload = (): void => {
    plugins.reload()
    services.reload()
    reloadMarket()
  }

  useEffect(() => {
    let live = true
    window.cockpit.invoke('settings.marketplace').then(
      (v) => {
        if (!live) return
        applyView(v)
        // Show the saved list at once, then fetch and show what came back; offline this cannot stall the page.
        if (v.indexes.some(stale)) {
          void window.cockpit.invoke('settings.marketplaceRefresh').then(
            (fresh) => {
              if (!live) return
              applyView(fresh)
              reloadPlugins()
            },
            () => {}
          )
        }
      },
      () => {
        if (live) setMarketFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [reloadPlugins])

  const cards = useMemo(() => buildCards(plugins.data, view), [plugins.data, view])
  const shown = useMemo(() => filterCards(cards, { search, filter, category }), [cards, search, filter, category])
  const current = clampPage(page, shown.length)
  const pages = pageCount(shown.length)

  // Opened by a panel's gear: start on the page that holds the plugin (installed cards come first, so
  // the plugins list alone decides it). Once only, so paging away afterwards is not undone.
  const placed = useRef(false)
  useEffect(() => {
    if (placed.current || plugins.data === null || props.openPlugin === undefined) return
    placed.current = true
    setPage(pageOf(cards, props.openPlugin))
  }, [plugins.data, cards, props.openPlugin])

  const nameOf = (id: string): string => plugins.data?.find((p) => p.id === id)?.name ?? id
  /** A new search or filter starts at page 1; a prompt on a card it hides would reopen, stealing focus, when the card returns. */
  const narrow = (apply: () => void): void => {
    apply()
    setPage(0)
    setConfirming(null)
  }
  /** Paging hides cards too, so it drops an open prompt the same way. */
  const goTo = (n: number): void => {
    setPage(n)
    setConfirming(null)
  }

  const act = (e: MarketplaceEntryView): void => {
    const call = e.action === 'update' ? 'settings.marketplaceUpdate' : 'settings.marketplaceInstall'
    void run(`entry:${e.indexUrl}|${e.id}`, async () => {
      await window.cockpit.invoke(call, { indexUrl: e.indexUrl, id: e.id, expect: { repo: e.repo, commit: e.commit } })
      return window.cockpit.invoke('settings.marketplace')
    }).then((v) => {
      setConfirming(null)
      if (v) {
        applyView(v)
        setInstalled({ indexUrl: e.indexUrl, id: e.id })
      } else {
        // The call failed (or the follow-up read did): main's state may have moved on, so the card
        // must not keep offering the old button and facts.
        reloadMarket()
      }
      plugins.reload()
      services.reload()
    })
  }
  /** Send exactly what the open prompt lists; main checks each one as a single update and reports each failure. */
  const updateAll = (): void => {
    const shown = updateAllShown
    if (shown === null) return
    const items = shown.map((e) => ({ indexUrl: e.indexUrl, id: e.id, expect: { repo: e.repo, commit: e.commit } }))
    void run('update-all', () => window.cockpit.invoke('settings.marketplaceUpdateAll', { items })).then((r) => {
      setUpdateAllShown(null)
      if (r) {
        const nameOfListed = (id: string): string => shown.find((e) => e.id === id)?.name ?? id
        setUpdateAllOutcome({ updated: r.updated.length, failed: r.failed.map((f) => ({ ...f, name: nameOfListed(f.id) })) })
      }
      // Successes changed the installed list even when others failed; a refused call may mean main moved on.
      reload()
    })
  }
  const refresh = (): void => {
    setConfirming(null)
    setUpdateAllShown(null)
    void run('refresh', () => window.cockpit.invoke('settings.marketplaceRefresh')).then((v) => {
      if (v) applyView(v)
      // A fetch can revoke an installed plugin (main stops it): its card's own state must follow.
      plugins.reload()
      services.reload()
    })
  }
  // Resolves true when the list was saved. `adding` names which button is working.
  const setUrls = (urls: string[], adding: boolean): Promise<boolean> =>
    run(adding ? 'urls:add' : 'urls:remove', () => window.cockpit.invoke('settings.marketplaceSetUrls', { urls })).then((v) => {
      if (v) {
        applyView(v)
        plugins.reload()
      }
      return Boolean(v)
    })

  return (
    <section aria-label="Plugins">
      <PageHeader
        title="Plugins"
        description="Installed plugins and the ones your marketplace indexes list. A plugin runs with full access to this computer; listed does not mean reviewed. Enable a plugin per project, and pick between plugins, under This Project."
      />
      {(error ?? plugins.error) && <p role="alert" className="settings-alert">{error ?? plugins.error}</p>}
      {view !== null && <MarketplaceNotices view={view} />}
      <UpdateAll
        offered={updateAllEntries(view)}
        shown={updateAllShown}
        outcome={updateAllOutcome}
        busy={busy}
        onAsk={() => {
          setConfirming(null)
          setUpdateAllOutcome(null)
          setUpdateAllShown(updateAllEntries(view))
        }}
        onCancel={() => setUpdateAllShown(null)}
        onConfirm={updateAll}
        onDismiss={() => setUpdateAllOutcome(null)}
      />
      <AddPlugin busy={busy} run={run} reload={reload} />
      <div className="settings-group">
        <div className="settings-plugin-filters">
          <input
            type="search"
            className="settings-grow"
            aria-label="Search plugins"
            placeholder="Search by name, id, author or description"
            value={search}
            onChange={(e) => narrow(() => setSearch(e.target.value))}
            spellCheck={false}
          />
          <div role="group" aria-label="Show" className="settings-plugin-chips">
            {PLUGIN_FILTERS.map((f) => (
              <button key={f} type="button" className="cc-chip" aria-pressed={filter === f} onClick={() => narrow(() => setFilter(f))}>
                {FILTER_LABELS[f]}
              </button>
            ))}
          </div>
          <Select
            aria-label="Category"
            value={category ?? ''}
            onChange={(e) => {
              const v = e.target.value
              narrow(() => setCategory(v === '' ? null : (v as MarketplaceCategory)))
            }}
          >
            <option value="">All categories</option>
            {MARKETPLACE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>
        {plugins.data === null ? null : cards.length === 0 ? (
          <div className="settings-card">
            <Empty>No plugins installed.</Empty>
          </div>
        ) : shown.length === 0 ? (
          <div className="settings-card">
            <Empty>No plugin matches the filter.</Empty>
          </div>
        ) : (
          <ul className="settings-card settings-list" aria-label="Plugin list">
            {pageSlice(shown, current).map((card) => {
              const e = card.listing
              return (
                <PluginCardItem
                  key={card.key}
                  card={card}
                  busy={busy}
                  services={services.data?.plugins.find((p) => p.id === card.id)}
                  nameOf={nameOf}
                  run={run}
                  reload={reload}
                  onOpenProject={props.onOpenProject}
                  open={props.openPlugin === card.id}
                  confirming={e !== undefined && confirming?.indexUrl === e.indexUrl && confirming.id === e.id}
                  justInstalled={
                    e !== undefined &&
                    installed?.indexUrl === e.indexUrl &&
                    installed.id === e.id &&
                    (e.status === 'installed' || e.status === 'update')
                  }
                  onAsk={(entry) => {
                    setInstalled(null)
                    setUpdateAllShown(null)
                    setConfirming({ indexUrl: entry.indexUrl, id: entry.id, repo: entry.repo, commit: entry.commit })
                  }}
                  onCancel={() => setConfirming(null)}
                  onConfirm={act}
                />
              )
            })}
          </ul>
        )}
        {pages > 1 && (
          <div role="group" aria-label="Pages" className="settings-pager">
            <button type="button" className="quiet" disabled={current === 0} onClick={() => goTo(current - 1)}>
              Previous
            </button>
            <span className="settings-item-meta" data-testid="plugin-page">
              Page {current + 1} of {pages}
            </span>
            <button type="button" className="quiet" disabled={current >= pages - 1} onClick={() => goTo(current + 1)}>
              Next
            </button>
          </div>
        )}
      </div>
      <IndexesSection indexes={view?.indexes ?? null} loadFailed={marketFailed} busy={busy} onRefresh={refresh} onSetUrls={setUrls} />
    </section>
  )
}

/** "Add plugin…": install from a git URL at a tag, or link a local folder. Folded until asked for. */
function AddPlugin(props: { busy: string | null; run: Action['run']; reload: () => void }): React.JSX.Element {
  const { busy, run, reload } = props
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [tag, setTag] = useState('')
  const bodyId = useId()
  const install = (): void => {
    void run('install', () => window.cockpit.invoke('settings.pluginInstall', { url, tag })).then((plugin) => {
      if (plugin) {
        setUrl('')
        setTag('')
      }
      reload()
    })
  }
  const link = (): void => {
    void run('link', () => window.cockpit.invoke('settings.pluginLink')).then(reload)
  }
  return (
    <div className="settings-group">
      <div className="settings-plugin-add">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
          Add plugin…
        </button>
      </div>
      {open && (
        <form
          id={bodyId}
          className="settings-card"
          aria-label="Install a plugin"
          onSubmit={(e) => {
            e.preventDefault()
            install()
          }}
        >
          <div className="settings-row settings-install">
            <input
              type="text"
              className="settings-grow mono"
              aria-label="Git URL"
              placeholder="https://… or git@… or file://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
            <input
              type="text"
              className="settings-tag mono"
              aria-label="Tag"
              placeholder="tag, e.g. v1.0.0"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              spellCheck={false}
            />
            <button type="submit" className="primary" disabled={busy !== null || url.trim() === '' || tag.trim() === ''}>
              {busy === 'install' ? 'Installing…' : 'Install'}
            </button>
          </div>
          <div className="settings-row">
            <div className="settings-row-text">
              <span className="settings-row-label">Local folder</span>
              <div className="settings-row-help">Link a plugin you are working on; it runs from that folder.</div>
            </div>
            <div className="settings-row-control">
              <button type="button" disabled={busy !== null} onClick={link}>
                Link folder…
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}

function sourceLine(card: PluginCard): string {
  const p = card.plugin
  if (p === undefined) return card.listing?.repo ?? ''
  return p.source.kind === 'git' ? `git ${p.source.url} @ ${p.source.tag}` : p.source.kind === 'linked' ? `linked ${p.source.path}` : 'built in'
}

/**
 * The listing's status badge. An installed card already says built in / linked in its source line and
 * revoked in its own badge, so those are not repeated (one badge per state, which the specs rely on).
 */
function listingBadge(card: PluginCard): MarketplaceEntryView['status'] | null {
  const e = card.listing
  if (e === undefined || e.status === 'available' || e.status === 'installed') return null
  if (card.plugin === undefined) return e.status
  if (e.status === 'built-in' || e.status === 'linked') return null
  if (e.status === 'revoked' && !card.plugin.state.ok) return null
  return e.status
}

function PluginCardItem(props: {
  card: PluginCard
  busy: string | null
  /** What the plugin provides and uses here; absent when it is not enabled in this project or has no host. */
  services: PluginServiceStatus | undefined
  nameOf: (id: string) => string
  run: Action['run']
  reload: () => void
  onOpenProject: () => void
  /** Opened by a panel's gear: start with the settings shown and bring the card into view. */
  open: boolean
  /** The listing's install / update prompt is open. */
  confirming: boolean
  justInstalled: boolean
  onAsk: (e: MarketplaceEntryView) => void
  onCancel: () => void
  onConfirm: (e: MarketplaceEntryView) => void
}): React.JSX.Element {
  const { card, busy, run, reload, confirming } = props
  const { plugin, listing: e } = card
  const [updateTag, setUpdateTag] = useState('')
  const [uninstalling, setUninstalling] = useState(false)
  const [showSettings, setShowSettings] = useState(props.open)
  const row = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (props.open) row.current?.scrollIntoView?.({ block: 'start' })
  }, [props.open])
  const offId = useId()
  const askRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  // Cancel (the focused element) unmounts with the prompt; hand focus back to the card's button.
  useEffect(() => {
    if (wasConfirming.current && !confirming) askRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  // Bundled plugins only (main sends the field for no other source): off in every project at once,
  // over each project's own switch, which comes back when this is undone.
  const offAll = plugin?.offInAllProjects
  const action = e?.action ?? null
  const verb = action === 'update' ? (e?.status === 'revoked' ? 'Move to safe version' : 'Update') : 'Install'
  const working = e !== undefined && busy === `entry:${e.indexUrl}|${e.id}`
  const badge = listingBadge(card)
  const version = plugin?.version ?? e?.version ?? ''
  const preview =
    e?.preview === true
      ? ({ kind: 'listing', indexUrl: e.indexUrl, id: e.id } as const)
      : plugin?.preview === true
        ? ({ kind: 'own', id: plugin.id } as const)
        : null
  const promptId = `confirm-${e?.indexUrl ?? ''}|${card.id}`.replace(/[^A-Za-z0-9_-]/g, '_')

  return (
    <li ref={row} className="settings-item column" data-plugin={card.id} data-index={plugin === undefined ? e?.indexUrl : undefined}>
      <div className="settings-item-head">
        <PluginPreview name={card.name} source={preview} />
        <div className="settings-item-main">
          <div className="settings-item-title">
            {card.name}
            {plugin !== undefined && !plugin.state.ok && (
              <span className="settings-badge warn">{plugin.state.revoked ? 'revoked' : 'disabled'}</span>
            )}
            {badge !== null && <span className={badge === 'revoked' ? 'settings-badge warn' : 'settings-badge'}>{STATUS_TEXT[badge]}</span>}
          </div>
          <div className="settings-item-meta">
            <span className="mono">{card.id}</span> · {version}
            {e !== undefined && ` · by ${e.author}`}
            {plugin !== undefined && action === 'update' && e !== undefined && ` · listed ${e.version}`}
            {plugin === undefined && e?.installedVersion !== undefined && e.installedVersion !== e.version && ` · installed ${e.installedVersion}`}
          </div>
          {e !== undefined && e.description !== '' && <div className="settings-item-meta">{e.description}</div>}
          <div className="settings-item-meta">{sourceLine(card)}</div>
          {e !== undefined && (
            <div className="settings-item-meta">
              from <span className="mono">{e.indexUrl}</span>
            </div>
          )}
          {plugin !== undefined && !plugin.state.ok && <div role="alert" className="settings-error">{plugin.state.reason}</div>}
          {e?.revokedReason !== undefined && (plugin === undefined || plugin.state.ok) && (
            <div className="settings-error">Revoked: {e.revokedReason}</div>
          )}
          {e?.note !== undefined && <div className="settings-item-meta" data-testid="marketplace-note">{e.note}</div>}
          {offAll === true && (
            <div className="settings-item-meta" data-testid="off-in-all-projects">
              Off in all projects: it runs nowhere, whatever each project's switch says.
            </div>
          )}
          {plugin?.seesAllSessions === true && (
            <div className="settings-item-meta" data-testid="plugin-access-sessions">
              Sees the Claude sessions of every window: status, tool, title and project (never prompts, notes or files), and how many sessions each connected server has waiting or working.
            </div>
          )}
          {props.services !== undefined && props.services.provides.length > 0 && (
            <div className="settings-item-meta" data-testid="service-provides">
              Provides: {props.services.provides.map((s) => `${s.service} v${s.version}`).join(', ')}
            </div>
          )}
          {props.services !== undefined && props.services.uses.length > 0 && (
            <div className="settings-item-meta" data-testid="service-uses">
              Uses: {props.services.uses.map((s) => `${s.service} v${s.version}`).join(', ')}
            </div>
          )}
          {props.services?.problems.map((problem, i) => (
            <div key={i} className="settings-warning" data-testid="service-warning">
              {serviceProblemMessage(problem, props.nameOf)}
            </div>
          ))}
          {plugin?.appSettings?.problem !== undefined && (
            <div className="settings-error">Stored settings are invalid; the plugin stays disabled until they are fixed.</div>
          )}
          {props.justInstalled && (
            <div className="settings-item-meta" role="status" data-testid="marketplace-done">
              Done. A plugin is switched on per project; if this one is not on yet, enable it under This Project.
            </div>
          )}
        </div>
        <div className="settings-item-actions">
          {uninstalling && plugin !== undefined ? (
            <>
              <span className="settings-confirm">Uninstall?</span>
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() => {
                  setUninstalling(false)
                  void run('uninstall', () => window.cockpit.invoke('settings.pluginUninstall', { id: plugin.id })).then(reload)
                }}
              >
                Yes, uninstall
              </button>
              <button type="button" className="quiet" onClick={() => setUninstalling(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {e !== undefined && action !== null && (
                <button type="button" ref={askRef} disabled={busy !== null || confirming} onClick={() => props.onAsk(e)}>
                  {verb}
                </button>
              )}
              {/* A listing whose install main has recorded before the plugins list caught up. */}
              {plugin === undefined && action === null && e?.status === 'installed' && (
                <button type="button" disabled>
                  Installed
                </button>
              )}
              {plugin !== undefined && offAll !== undefined && (
                <label className="settings-inline-switch" htmlFor={offId}>
                  <Switch
                    id={offId}
                    checked={offAll}
                    disabled={busy !== null}
                    aria-label={`Off in all projects: ${plugin.name}`}
                    onChange={(ev) => {
                      const off = ev.target.checked
                      void run(`off ${plugin.id}`, () => window.cockpit.invoke('settings.pluginBundledOff', { id: plugin.id, off })).then(reload)
                    }}
                  />
                  Off in all projects
                </label>
              )}
              {plugin !== undefined && (
                <button type="button" className="quiet" onClick={props.onOpenProject}>
                  Enable in This Project
                </button>
              )}
              {/* The gear: the plugin's global page (design-next §5.1): app fields, the global values of project fields, its html page. */}
              {plugin !== undefined && (plugin.appSettings || plugin.projectDefaults || plugin.settingsPage) && (
                <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
                  <GearIcon size={14} />
                  Settings
                </button>
              )}
              {plugin !== undefined && plugin.source.kind !== 'bundled' && (
                <button type="button" className="quiet" disabled={busy !== null} onClick={() => setUninstalling(true)}>
                  Uninstall
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {confirming && e !== undefined && action !== null && (
        <div
          className="settings-subpanel"
          role="group"
          aria-label={`Confirm ${verb.toLowerCase()} of ${e.id}`}
          aria-describedby={`${promptId}-risk ${promptId}-repo`}
          onKeyDown={(ev) => {
            // Esc dismisses the prompt only; the overlay's own Esc handler honours defaultPrevented.
            if (ev.key === 'Escape') {
              ev.preventDefault()
              props.onCancel()
            }
          }}
        >
          <p id={`${promptId}-risk`} className="settings-alert warn">
            <strong>{e.name}</strong> will run with full access to this computer: your files, your accounts and the network. Listed
            means an index names this exact version; it does not mean anyone reviewed the code for safety.
          </p>
          {e.repoChangedFrom !== undefined && (
            <p id={`${promptId}-repo`} className="settings-alert" data-testid="marketplace-repo-warning">
              This id was last installed from <span className="mono">{e.repoChangedFrom}</span>, and this listing is not known to be
              the same repository. The plugin will stay off in every project until you enable it again.
            </p>
          )}
          <dl className="settings-facts">
            <dt>Author</dt>
            <dd>{e.author}</dd>
            <dt>Repository</dt>
            <dd className="mono">{e.repo}</dd>
            <dt>Tag</dt>
            <dd className="mono">{e.tag}</dd>
            <dt>Commit</dt>
            <dd className="mono">{e.commit}</dd>
            <dt>Index</dt>
            <dd className="mono">{e.indexUrl}</dd>
          </dl>
          <div className="settings-row-control">
            {/* Cancel first and focused: Enter or Space on the open prompt must not install. */}
            <button type="button" autoFocus disabled={working} onClick={props.onCancel}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={busy !== null} onClick={() => props.onConfirm(e)}>
              {working ? 'Working…' : `Yes, ${verb.toLowerCase()}`}
            </button>
            <span role="status" className="visually-hidden">
              {working ? 'Working' : ''}
            </span>
          </div>
        </div>
      )}
      {plugin?.source.kind === 'git' && (
        <form
          className="settings-item-foot"
          aria-label={`Update ${plugin.id}`}
          onSubmit={(ev) => {
            ev.preventDefault()
            void run('update', () => window.cockpit.invoke('settings.pluginUpdate', { id: plugin.id, tag: updateTag })).then((updated) => {
              if (updated) setUpdateTag('')
              reload()
            })
          }}
        >
          <span className="settings-item-meta">Update to</span>
          <input
            type="text"
            className="settings-tag mono"
            aria-label={`New tag for ${plugin.id}`}
            placeholder="newer tag"
            value={updateTag}
            onChange={(ev) => setUpdateTag(ev.target.value)}
            spellCheck={false}
          />
          <button type="submit" disabled={busy !== null || updateTag.trim() === ''}>
            Update
          </button>
        </form>
      )}
      {plugin !== undefined && <PluginSettings plugin={plugin} shown={showSettings} reload={reload} />}
    </li>
  )
}

/** The gear's global page under an installed card: app fields, the global values of project fields, the html page. */
function PluginSettings(props: { plugin: PluginView; shown: boolean; reload: () => void }): React.JSX.Element | null {
  const { plugin, shown, reload } = props
  if (!shown) return null
  return (
    <>
      {plugin.appSettings && plugin.projectDefaults && <h4 className="settings-form-heading">App-wide</h4>}
      {plugin.appSettings && (
        <div data-testid="app-settings-form">
          <PluginSettingsForm
            schema={plugin.appSettings.schema}
            values={plugin.appSettings.values}
            {...(plugin.appSettings.problem !== undefined ? { problem: plugin.appSettings.problem } : {})}
            {...(plugin.appSettings.secretFields !== undefined ? { secretFields: plugin.appSettings.secretFields } : {})}
            save={(values, secrets) => window.cockpit.invoke('settings.pluginSettingsSave', { id: plugin.id, values, secrets })}
            onSaved={reload}
          />
        </div>
      )}
      {/* The global values of the project fields (design-next §5.2): what every project that does not override a field gets. */}
      {plugin.projectDefaults && (
        <>
          <h4 className="settings-form-heading">Every project</h4>
          <p className="settings-item-meta settings-form-heading-note">
            The global value of each project setting. A project uses it unless it overrides the field under This Project.
          </p>
          <div data-testid="project-defaults-form">
            <PluginSettingsForm
              schema={plugin.projectDefaults.schema}
              values={plugin.projectDefaults.values}
              {...(plugin.projectDefaults.problem !== undefined ? { problem: plugin.projectDefaults.problem } : {})}
              {...(plugin.projectDefaults.secretFields !== undefined ? { secretFields: plugin.projectDefaults.secretFields } : {})}
              saveLabel="Save global values"
              save={(values, secrets) => window.cockpit.invoke('settings.pluginProjectDefaultsSave', { id: plugin.id, values, secrets })}
              onSaved={reload}
            />
          </div>
        </>
      )}
      {/* The plugin's html page for the app scope (design-next §5.4), under its forms. */}
      {plugin.settingsPage && <PluginSettingsPage pluginId={plugin.id} pluginName={plugin.name} scope="app" />}
    </>
  )
}
