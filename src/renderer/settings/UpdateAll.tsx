import type { MarketplaceEntryView } from '../../shared/ipc'

/** What the last "Update all" did, for the note under its button; `name` is the listing's, from the prompt. */
export interface UpdateAllOutcome {
  updated: number
  failed: { id: string; name: string; error: string }[]
}

/**
 * "Update all" on the Plugins page (design-next §6.4): a button while at least one installed plugin has a
 * newer listed version from its recorded index (plugin-list-model.ts `updateAllEntries`), one confirmation
 * listing every plugin with its current and new version, repo and commit, and after the run the failures
 * with their reasons. Everything shown is the index's own text: React text only, the repo never a link.
 * The prompt is what gets sent: main updates the listed plugins only, each checked against what it shows.
 */
export function UpdateAll(props: {
  offered: MarketplaceEntryView[]
  /** The open prompt's plugins, as shown when it opened; null when closed. */
  shown: MarketplaceEntryView[] | null
  outcome: UpdateAllOutcome | null
  busy: string | null
  onAsk: () => void
  onCancel: () => void
  onConfirm: () => void
  onDismiss: () => void
}): React.JSX.Element | null {
  const { offered, shown, outcome, busy } = props
  if (offered.length === 0 && shown === null && outcome === null) return null
  const working = busy === 'update-all'
  return (
    <div className="settings-group">
      {shown === null && offered.length > 0 && (
        <div className="settings-plugin-add">
          <button type="button" disabled={busy !== null} onClick={props.onAsk}>
            Update all ({offered.length})
          </button>
        </div>
      )}
      {shown !== null && (
        <div
          className="settings-subpanel settings-update-all"
          role="group"
          aria-label="Confirm update of all plugins"
          aria-describedby="update-all-risk"
          onKeyDown={(ev) => {
            // Esc dismisses the prompt only; the overlay's own Esc handler honours defaultPrevented.
            if (ev.key === 'Escape') {
              ev.preventDefault()
              props.onCancel()
            }
          }}
        >
          <p id="update-all-risk" className="settings-alert warn">
            These plugins will be updated one at a time, each to exactly the version listed here. Each runs with full access to this
            computer; listed means an index names this exact version, not that anyone reviewed the code. A failed update does not undo
            the others.
          </p>
          <ul className="settings-update-list" aria-label="Plugins to update">
            {shown.map((e) => (
              <li key={`${e.indexUrl}|${e.id}`} data-testid="update-all-item">
                <div>
                  <strong>{e.name}</strong> <span className="mono settings-item-meta">{e.id}</span>{' '}
                  <span className="mono">
                    {e.installedVersion ?? '?'} → {e.version}
                  </span>
                </div>
                <dl className="settings-facts">
                  <dt>Repository</dt>
                  <dd className="mono">{e.repo}</dd>
                  <dt>Commit</dt>
                  <dd className="mono">{e.commit}</dd>
                </dl>
              </li>
            ))}
          </ul>
          <div className="settings-row-control">
            {/* Cancel first and focused: Enter or Space on the open prompt must not update. */}
            <button type="button" autoFocus disabled={working} onClick={props.onCancel}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={busy !== null} onClick={props.onConfirm}>
              {working ? 'Updating…' : `Yes, update ${shown.length === 1 ? 'it' : `all ${shown.length}`}`}
            </button>
            <span role="status" className="visually-hidden">
              {working ? 'Working' : ''}
            </span>
          </div>
        </div>
      )}
      {outcome !== null && (
        <div className="settings-subpanel settings-update-all" data-testid="update-all-outcome">
          <p role="status" className="settings-page-note">
            Updated {outcome.updated} {outcome.updated === 1 ? 'plugin' : 'plugins'}.
            {outcome.failed.length > 0 && ` ${outcome.failed.length} could not be updated:`}
          </p>
          {outcome.failed.length > 0 && (
            <ul role="alert" className="settings-alert settings-update-list" aria-label="Updates that failed">
              {outcome.failed.map((f) => (
                <li key={f.id}>
                  <strong>{f.name}</strong>: {f.error}
                </li>
              ))}
            </ul>
          )}
          <div className="settings-row-control">
            <button type="button" className="quiet" onClick={props.onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
