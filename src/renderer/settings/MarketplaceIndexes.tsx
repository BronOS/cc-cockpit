import { useId, useState } from 'react'
import type { MarketplaceIndexView, MarketplaceView } from '../../shared/ipc'
import { Empty, Group } from './ui'

/**
 * The page-wide marketplace notices over the Plugins list: every index unreachable, and revocations
 * from an index that has no say over the plugin they name (shown, never enforced).
 */
export function MarketplaceNotices({ view }: { view: MarketplaceView }): React.JSX.Element {
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

/**
 * Index management at the bottom of the Plugins page (design-next §6.3): add, remove, refresh, and
 * each index's fetch error and skipped counts. Collapsed by default, since it is set up once; Refresh
 * stays in its heading so a new version can be fetched without opening it, and the heading counts the
 * indexes that failed so an error is not hidden by the fold.
 */
export function IndexesSection(props: {
  /** Null until the first view arrived. */
  indexes: MarketplaceIndexView[] | null
  /** The marketplace view could not be loaded at all. */
  loadFailed: boolean
  busy: string | null
  onRefresh: () => void
  onSetUrls: (urls: string[], adding: boolean) => Promise<boolean>
}): React.JSX.Element {
  const { indexes, busy } = props
  const [open, setOpen] = useState(false)
  const [newUrl, setNewUrl] = useState('')
  const bodyId = useId()
  const failing = indexes?.filter((i) => i.error !== null).length ?? 0
  // The box keeps its text when the add fails or a Remove succeeds.
  const add = (current: MarketplaceIndexView[]): void => {
    void props.onSetUrls([...current.map((i) => i.url), newUrl.trim()], true).then((saved) => {
      if (saved) setNewUrl('')
    })
  }
  const summary =
    indexes === null
      ? undefined
      : `${indexes.length} configured${failing > 0 ? `, ${failing} could not be fetched` : ''}. Each marketplace is a list of plugins somebody maintains.`
  return (
    <Group
      title="Marketplace indexes"
      description={summary}
      actions={
        <>
          <button type="button" disabled={busy !== null} onClick={props.onRefresh}>
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </button>
          <button type="button" className="quiet" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Manage'}
          </button>
        </>
      }
    >
      {open && (
        <div className="settings-card" id={bodyId}>
          {indexes === null ? (
            <Empty>{props.loadFailed ? 'The marketplace could not be loaded.' : 'Loading…'}</Empty>
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
      )}
    </Group>
  )
}
