import { useEffect, useId, useRef, useState } from 'react'
import type { ClaudeCodeView } from '../../shared/ipc'
import { claudeOfferText } from './claude-offer-model'
import { CommandLine, InstallInTabButton } from './ClaudeInstallControls'

/**
 * "Claude Code was not found" at start-up, when `claude` is not on the PATH the Claude tabs get (main
 * decides, once per launch: main/hooks/claude-offer.ts). Built like CccOfferDialog and shown by TabsPane
 * the same way (zones inert, shell layer up, no key reaches a terminal): "Not now" has the focus, so
 * Enter alone declines; Esc and a click outside decline too. The app never installs Claude Code by
 * itself: the dialog shows main's install command with Copy, the setup docs (opened through
 * `app.openExternal`, a notice in a browser view) and the other ways as text.
 *
 * "Install in a new tab" (only when main says this host can, `installInTab`) sends the intent alone
 * (`claude.install`): main opens a command tab running its own constant, which the person watches and
 * can stop; the dialog then closes so the tab is in view. It is armed only after about a second of the
 * page being seen (ClaudeInstallControls), as an approval's Allow is. 'off-path' (the launcher is there, its folder
 * is not on PATH) shows the profile line instead, and no install. "Don't ask again" is saved
 * (`settings.claudeOfferSet`) on either answer.
 */
export function ClaudeOfferDialog(props: { view: ClaudeCodeView; onDone: () => void }): React.JSX.Element {
  const { view } = props
  const [dontAsk, setDontAsk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const textId = useId()
  const text = claudeOfferText(view)

  // Take the keyboard from the terminal behind (it is inert now, but it held the focus).
  useEffect(() => first.current?.focus(), [])

  const saveDontAsk = (): Promise<unknown> =>
    dontAsk ? window.cockpit.invoke('settings.claudeOfferSet', { value: false }).catch(() => undefined) : Promise.resolve()

  const decline = (): void => {
    void saveDontAsk().then(props.onDone)
  }

  const openDocs = (): void => {
    window.cockpit.invoke('app.openExternal', { url: view.docsUrl }).catch(() => undefined)
  }

  return (
    <div className="confirm-backdrop" onMouseDown={decline}>
      <div
        className="confirm-dialog claude-offer"
        data-testid="claude-offer"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            decline()
          }
        }}
      >
        <h2 id={titleId} className="confirm-title">
          {text.title}
        </h2>
        <p id={textId}>{text.lead}</p>
        {text.pathLine !== undefined && <CommandLine text={text.pathLine} label="the PATH line" testId="claude-offer-path" />}
        {view.state === 'missing' && (
          <>
            <CommandLine text={view.command} label="the install command" testId="claude-offer-command" />
            <p className="claude-offer-others">
              Other ways:{' '}
              {view.others.map((o, i) => (
                <span key={o.label}>
                  {i > 0 && '; '}
                  <code>{o.command}</code> ({o.label}
                  {o.note !== undefined && `, ${o.note}`})
                </span>
              ))}
              .
            </p>
          </>
        )}
        <p className="claude-offer-docs">
          <button type="button" className="link-button" onClick={openDocs}>
            Claude Code setup docs
          </button>
        </p>
        {error !== null && (
          <p role="alert" className="settings-alert">
            {error}
          </p>
        )}
        <label className="confirm-check">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          {" Don't ask again"}
        </label>
        <div className="confirm-buttons">
          <button type="button" ref={first} onClick={decline}>
            Not now
          </button>
          {view.installInTab && (
            <InstallInTabButton
              before={saveDontAsk}
              onOpened={props.onDone}
              onError={(message) => setError(message)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
