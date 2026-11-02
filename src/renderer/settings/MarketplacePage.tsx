import { useEffect, useRef, useState } from 'react'
import type { MarketplaceEntryView, MarketplaceIndexView, MarketplaceView } from '../../shared/ipc'
import { STALE_AFTER_MS } from '../../shared/marketplace'
import { ipcErrorMessage } from '../ipc-error'
import { BlocksIcon } from './icons'
import { Empty, Group, PageHeader } from './ui'
import { useAction } from './use-action'

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

/**
 * Settings › Marketplace: browse the plugins the configured indexes list, install or update one,
 * and manage the index URLs. Everything in an entry is the index's own text and is untrusted: it is
 * rendered as React text only (never HTML), and the repo is shown as given, not made a link (a deliberate
 * change from the plan's https link; it is safer and recorded in the plan). The install and update calls
 * send `indexUrl` + `id` and, as an expectation only, the repo and commit shown; main looks the pin up in its
 * own state and refuses when it differs.
 * "Listed" means an index names this commit, not that anyone reviewed the code: the confirmation says so.
 */
export function MarketplacePage(props: {
  /** Switch Settings to This project, where an installed plugin is enabled. */
  onOpenProject: () => void
}): React.JSX.Element {
  const [view, setView] = useState<MarketplaceView | null>(null)
  const [filter, setFilter] = useState('')
  // `repo` + `commit` are what the open prompt displays: a view that changes either closes the prompt.
  const [confirming, setConfirming] = useState<{ indexUrl: string; id: string; repo: string; commit: string } | null>(null)
  const [installed, setInstalled] = useState<{ indexUrl: string; id: string } | null>(null)
  const { busy, error, run, setError } = useAction()

  /** Show a fresh view; it closes a prompt whose entry lost its button or moved to another repo or commit. */
  const applyView = (v: MarketplaceView): void => {
    setView(v)
    setConfirming((c) => {
      if (c === null) return null
      const e = v.entries.find((x) => x.indexUrl === c.indexUrl && x.id === c.id)
      return e !== undefined && e.action !== null && e.repo === c.repo && e.commit === c.commit ? c : null
    })
    setInstalled(null)
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
            (fresh) => live && applyView(fresh),
            () => {}
          )
        }
      },
      (err: unknown) => {
        if (live) setError(ipcErrorMessage(err))
      }
    )
    return () => {
      live = false
    }
  }, [setError])

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
        // The call failed (or the follow-up read did): main's state may have moved on, so the row
        // must not keep offering the old button and facts.
        window.cockpit.invoke('settings.marketplace').then(applyView, () => {})
      }
    })
  }
  const refresh = (): void => {
    setConfirming(null)
    void run('refresh', () => window.cockpit.invoke('settings.marketplaceRefresh')).then((v) => v && applyView(v))
  }
  // Resolves true when the list was saved. `adding` names which button is working.
  const setUrls = (urls: string[], adding: boolean): Promise<boolean> =>
    run(adding ? 'urls:add' : 'urls:remove', () => window.cockpit.invoke('settings.marketplaceSetUrls', { urls })).then((v) => {
      if (v) applyView(v)
      return Boolean(v)
    })

  const needle = filter.trim().toLowerCase()
  const entries = (view?.entries ?? []).filter(
    (e) => needle === '' || [e.name, e.id, e.description, e.author].some((t) => t.toLowerCase().includes(needle))
  )

  return (
    <section aria-label="Marketplace">
      <PageHeader
        title="Marketplace"
        description="Plugins listed by a marketplace index. A plugin runs with full access to this computer; listed does not mean reviewed."
      />
      {error && <p role="alert" className="settings-alert">{error}</p>}
      {view !== null && <MarketplaceNotices view={view} />}
      <Group
        title="Plugins"
        actions={
          <button type="button" disabled={busy !== null} onClick={refresh}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      >
        <div className="settings-card">
          <div className="settings-row">
            <input
              type="search"
              className="settings-grow"
              aria-label="Filter plugins"
              placeholder="Filter by name, id, author or description"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                // A prompt on a row the filter hides would reopen, stealing focus, when the row returns.
                setConfirming(null)
              }}
              spellCheck={false}
            />
          </div>
          {view !== null && entries.length === 0 ? (
            <Empty>{needle !== '' ? 'No plugin matches the filter.' : 'No plugins are listed.'}</Empty>
          ) : (
            <ul className="settings-list" aria-label="Listed plugins">
              {entries.map((e) => (
                <EntryItem
                  key={`${e.indexUrl}|${e.id}`}
                  entry={e}
                  busy={busy}
                  confirming={confirming?.indexUrl === e.indexUrl && confirming.id === e.id}
                  justInstalled={installed?.indexUrl === e.indexUrl && installed.id === e.id && (e.status === 'installed' || e.status === 'update')}
                  onAsk={() => {
                    setError(null)
                    setInstalled(null)
                    setConfirming({ indexUrl: e.indexUrl, id: e.id, repo: e.repo, commit: e.commit })
                  }}
                  onCancel={() => setConfirming(null)}
                  onConfirm={() => act(e)}
                  onOpenProject={props.onOpenProject}
                />
              ))}
            </ul>
          )}
        </div>
      </Group>
      <IndexesGroup indexes={view?.indexes ?? null} error={error} busy={busy} onSetUrls={setUrls} />
    </section>
  )
}

function MarketplaceNotices({ view }: { view: MarketplaceView }): React.JSX.Element {
  const offline = view.indexes.length > 0 && view.indexes.every((i) => i.error !== null)
  // First run with no network: nothing was ever saved, so there is no list and no revocation to show.
  const hasSaved = view.indexes.some((i) => i.fetchedAt > 0)
  return (
    <>
      {offline && (
        <p className="settings-alert warn" data-testid="marketplace-offline">
          {hasSaved
            ? 'Could not reach any marketplace index. Showing the last saved lists; revocations still apply.'
            : 'Could not reach any marketplace index, and no list was saved yet.'}
        </p>
      )}
      {view.warnings.map((w) => (
        <p key={`${w.pluginId}|${w.source}`} className="settings-alert warn" data-testid="marketplace-warning">
          {w.source} says {w.pluginName} ({w.pluginId}) is revoked: {w.reason}. This index has no say over that plugin, so this does
          not stop it.
        </p>
      ))}
    </>
  )
}

function IndexesGroup(props: {
  /** Null until the first view arrived. */
  indexes: MarketplaceIndexView[] | null
  error: string | null
  busy: string | null
  onSetUrls: (urls: string[], adding: boolean) => Promise<boolean>
}): React.JSX.Element {
  const { indexes, error, busy } = props
  const [newUrl, setNewUrl] = useState('')
  // The box keeps its text when the add fails or a Remove succeeds.
  const add = (current: MarketplaceIndexView[]): void => {
    void props.onSetUrls([...current.map((i) => i.url), newUrl.trim()], true).then((saved) => {
      if (saved) setNewUrl('')
    })
  }
  return (
    <Group title="Indexes" description="Each marketplace is a list of plugins somebody maintains.">
      <div className="settings-card">
        {indexes === null ? (
          <Empty>{error === null ? 'Loading…' : 'The marketplace could not be loaded.'}</Empty>
        ) : indexes.length === 0 ? (
          <Empty>No marketplace is configured.</Empty>
        ) : (
          <ul className="settings-list" aria-label="Marketplace indexes">
            {indexes.map((i) => (
              <li key={i.url} className="settings-item column" data-index={i.url}>
                <div className="settings-item-head">
                  <div className="settings-item-main">
                    <div className="settings-item-title mono">{i.url}</div>
                    <div className="settings-item-meta">
                      {i.fetchedAt > 0 ? `last fetched ${new Date(i.fetchedAt).toLocaleString()}` : 'never fetched'}
                      {i.skippedEntries > 0 && ` · ${i.skippedEntries} ${i.skippedEntries === 1 ? 'entry' : 'entries'} skipped`}
                      {i.skippedRevocations > 0 &&
                        ` · ${i.skippedRevocations} ${i.skippedRevocations === 1 ? 'revocation' : 'revocations'} skipped`}
                      {i.incompatible > 0 && ` · ${i.incompatible} incompatible with this app`}
                    </div>
                    {i.error !== null && <div className="settings-error">{i.error}</div>}
                  </div>
                  <div className="settings-item-actions">
                    <button
                      type="button"
                      className="quiet"
                      aria-label={`Remove ${i.url}`}
                      disabled={busy !== null}
                      onClick={() => void props.onSetUrls(indexes.filter((o) => o.url !== i.url).map((o) => o.url), false)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="settings-row settings-install"
          aria-label="Add a marketplace"
          onSubmit={(e) => {
            e.preventDefault()
            // Without a loaded list this would replace the stored one with the single new URL.
            if (indexes !== null) add(indexes)
          }}
        >
          <input
            type="text"
            className="settings-grow mono"
            aria-label="Marketplace URL"
            placeholder="https://… or file://… index.json"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" disabled={busy !== null || indexes === null || newUrl.trim() === ''}>
            {busy === 'urls:add' ? 'Adding…' : 'Add'}
          </button>
        </form>
        <p className="settings-row-help settings-note warn">
          Only add a marketplace you trust: an index can offer any plugin, and a plugin runs with full access to this computer.
        </p>
      </div>
    </Group>
  )
}

function EntryItem(props: {
  entry: MarketplaceEntryView
  busy: string | null
  confirming: boolean
  justInstalled: boolean
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
  onOpenProject: () => void
}): React.JSX.Element {
  const { entry: e, busy, confirming } = props
  const verb = e.action === 'update' ? (e.status === 'revoked' ? 'Move to this version' : 'Update') : 'Install'
  const working = busy === `entry:${e.indexUrl}|${e.id}`
  const askRef = useRef<HTMLButtonElement>(null)
  const wasConfirming = useRef(false)
  // Cancel (the focused element) unmounts with the prompt; hand focus back to the row's button.
  useEffect(() => {
    if (wasConfirming.current && !confirming) askRef.current?.focus()
    wasConfirming.current = confirming
  }, [confirming])
  const promptId = `confirm-${e.indexUrl}|${e.id}`.replace(/[^A-Za-z0-9_-]/g, '_')

  return (
    <li className="settings-item column" data-plugin={e.id} data-index={e.indexUrl}>
      <div className="settings-item-head">
        <BlocksIcon className="settings-item-glyph" />
        <div className="settings-item-main">
          <div className="settings-item-title">
            {e.name}
            {e.status !== 'available' && e.status !== 'installed' && (
              <span className={e.status === 'revoked' ? 'settings-badge warn' : 'settings-badge'}>{STATUS_TEXT[e.status]}</span>
            )}
          </div>
          <div className="settings-item-meta">
            <span className="mono">{e.id}</span> · {e.version} · by {e.author}
            {e.installedVersion !== undefined && e.installedVersion !== e.version && ` · installed ${e.installedVersion}`}
          </div>
          <div className="settings-item-meta">{e.description}</div>
          <div className="settings-item-meta">
            from <span className="mono">{e.indexUrl}</span>
          </div>
          {e.revokedReason !== undefined && <div className="settings-error">Revoked: {e.revokedReason}</div>}
          {e.note !== undefined && <div className="settings-item-meta">{e.note}</div>}
          {props.justInstalled && (
            <div className="settings-item-meta" role="status" data-testid="marketplace-done">
              Done. A plugin is switched on per project; if this one is not on yet, enable it there.{' '}
              <button type="button" className="quiet" onClick={props.onOpenProject}>
                Enable in This project
              </button>
            </div>
          )}
        </div>
        <div className="settings-item-actions">
          {e.action !== null ? (
            <button type="button" ref={askRef} disabled={busy !== null || confirming} onClick={props.onAsk}>
              {verb}
            </button>
          ) : e.status === 'installed' ? (
            <button type="button" disabled>
              Installed
            </button>
          ) : null}
        </div>
      </div>
      {confirming && e.action !== null && (
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
            <button type="button" className="danger" disabled={busy !== null} onClick={props.onConfirm}>
              {working ? 'Working…' : `Yes, ${verb.toLowerCase()}`}
            </button>
            <span role="status" className="visually-hidden">
              {working ? 'Working' : ''}
            </span>
          </div>
        </div>
      )}
    </li>
  )
}
