import { useState } from 'react'
import type { SessionDetail } from '../../shared/ipc'
import { StatusDot } from '../status/StatusDot'
import { statusLabel } from '../status/strip-order'
import { useSessions } from '../status/use-sessions'
import { FileGlyph } from '../window-icons'

/**
 * The built-in Sessions panel (`core/sessions`): this window's Claude tabs with what main knows of
 * each, taken from the per-window snapshot (never another project's tabs). A changed file is a
 * button; a click asks main to open its diff in a terminal overlay and sends nothing but the tab
 * id and the file string main itself reported: no argv, no cwd (main/sessions/open-diff.ts).
 * Everything shown is text from a hook or a CLI call, so it is rendered as plain text only.
 */
export function SessionsPanel(): React.JSX.Element {
  const { snapshot } = useSessions()
  if (snapshot.own.length === 0) {
    return <p className="sessions-empty">No Claude sessions in this window.</p>
  }
  return (
    <ul className="sessions-list">
      {snapshot.own.map((session, i) => (
        <SessionItem key={session.tabId} session={session} index={i + 1} />
      ))}
    </ul>
  )
}

/**
 * The Sessions panel header's count ("2 in this window"), beside its title (PanelArea). Nothing
 * when there are none: the panel body says so in words.
 */
export function SessionsMeta(): React.JSX.Element | null {
  const { snapshot } = useSessions()
  const n = snapshot.own.length
  if (n === 0) return null
  return <span className="panel-meta">{n} in this window</span>
}

/** A changed file split at its last slash, so the name can stand out from its folder. */
function splitPath(file: string): { dir: string; name: string } {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1
  return { dir: file.slice(0, cut), name: file.slice(cut) }
}

function SessionItem(props: { session: SessionDetail; index: number }): React.JSX.Element {
  const { session } = props
  const { steps } = session
  // The file whose last click main refused (the tab closed, the file left the record), so the
  // click does not just do nothing. Cleared by the next click.
  const [refused, setRefused] = useState<string | undefined>()
  return (
    <li className="session-item" data-tab-id={session.tabId} data-status={session.status}>
      <div className="session-head">
        <StatusDot status={session.status} tool={session.tool} />
        {/* N is the position among this window's Claude tabs (tab titles carry no number, so
            nothing stabler matches them); the click jumps to the tab, which main resolves from
            its own registry (sessions.focus). */}
        <button
          type="button"
          className="session-title"
          title="Go to this tab"
          onClick={() => {
            window.cockpit.invoke('sessions.focus', { tabId: session.tabId }).catch(() => {})
          }}
        >
          Claude {props.index}
        </button>
        <span className="session-status">
          {statusLabel(session.status)}
          {session.tool ? ` · ${session.tool}` : ''}
        </span>
        {steps && (
          <span className="session-steps" title="Steps done">
            {steps.done}/{steps.total}
            {/* The same fraction as a bar (no text: the count above is the text). Tinted while
                the session works, so a moving bar reads as live. A total of 0 is an empty bar,
                and a done past the total (the CLI takes both as given) a full one. */}
            <span className="session-steps-bar" aria-hidden="true">
              <span
                style={{
                  width: `${steps.total > 0 ? Math.min(100, Math.max(0, (steps.done / steps.total) * 100)) : 0}%`
                }}
              />
            </span>
          </span>
        )}
      </div>
      {session.lastPrompt !== undefined && (
        <p className="session-prompt" title={session.lastPrompt}>
          {session.lastPrompt}
        </p>
      )}
      {session.notes.length > 0 && (
        <ul className="session-notes" aria-label="Notes">
          {session.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
      {session.files.length > 0 && (
        <div className="session-files-box">
        {/* The record's file count; hidden from assistive tech, which gets the list's own
            label and its length. */}
        <div className="session-files-caption" aria-hidden="true">
          {session.files.length} changed {session.files.length === 1 ? 'file' : 'files'}
        </div>
        <ul className="session-files" aria-label="Changed files">
          {session.files.map((file) => (
            <li key={file}>
              <button
                type="button"
                className="session-file"
                title={file}
                // The name is the file string exactly: the folder and the name sit in flex items,
                // which the accessible-name computation would otherwise join with a space.
                aria-label={file}
                onClick={() => {
                  // A refusal (the tab is gone, the file is not one main recorded) is false. A
                  // second click on a diff already open is answered true by main without a
                  // second overlay (open-diff.ts `shown`).
                  setRefused(undefined)
                  window.cockpit
                    .invoke('sessions.openFile', { tabId: session.tabId, file })
                    .then((ok) => setRefused(ok ? undefined : file))
                    .catch(() => setRefused(file))
                }}
              >
                <FileGlyph size={13} />
                {/* Text content stays the file string itself (the button's name). The folder
                    gives way (ellipsis) before the name does: Claude reports absolute paths,
                    and a cut name would leave every row reading the same. */}
                <span className="session-file-path">
                  <span className="session-file-dir">{splitPath(file).dir}</span>
                  <span className="session-file-name">{splitPath(file).name}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        </div>
      )}
      {refused !== undefined && (
        <p className="session-error" role="status">
          Could not open {refused}
        </p>
      )}
    </li>
  )
}
