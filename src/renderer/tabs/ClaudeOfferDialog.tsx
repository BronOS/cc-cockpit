import { useEffect, useId, useRef, useState } from 'react'
import type { ClaudeCodeView } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { copyText } from '../guests/copy-text'
import { claudeOfferText } from './claude-offer-model'

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
 * can stop; the dialog then closes so the tab is in view. 'off-path' (the launcher is there, its folder
 * is not on PATH) shows the profile line instead, and no install. "Don't ask again" is saved
 * (`settings.claudeOfferSet`) on either answer.
 */
export function ClaudeOfferDialog(props: { view: ClaudeCodeView; onDone: () => void }): React.JSX.Element {
  const { view } = props
  const [dontAsk, setDontAsk] = useState(false)
  const [busy, setBusy] = useState(false)
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
    if (busy) return
    void saveDontAsk().then(props.onDone)
  }

  const install = (): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void saveDontAsk()
      .then(() => window.cockpit.invoke('claude.install'))
      .then(
        () => props.onDone(),
        (err: unknown) => setError(ipcErrorMessage(err))
      )
      .finally(() => setBusy(false))
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
          <button type="button" ref={first} disabled={busy} onClick={decline}>
            Not now
          </button>
          {view.installInTab && (
            <button type="button" disabled={busy} onClick={install}>
              Install in a new tab
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** One command, in monospace and selectable, with its Copy button (Copied for a moment), as the picker's. */
function CommandLine(props: { text: string; label: string; testId: string }): React.JSX.Element {
  const [copied, setCopied] = useState<boolean | null>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="connect-command">
      <code data-testid={props.testId}>{props.text}</code>
      <button type="button" className="picker-quiet" aria-label={`Copy ${props.label}`} onClick={() => setCopied(copyText(props.text))}>
        {copied === true ? 'Copied' : copied === false ? 'Select it to copy' : 'Copy'}
      </button>
    </div>
  )
}
