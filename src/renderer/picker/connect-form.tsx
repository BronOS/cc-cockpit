// The picker's Connect to server form (design-remote-desktop.md §3, §5, §6): a modal card over the
// desktop picker. SSH host (the app's built-in SSH client runs `ccc web` on it and owns the tunnel;
// for now with the agent and key files only: the full form with prompts is remote SSH rev 2 Task 6) or Link (the access link or a one-time add-device link, as a browser would
// use it), an optional name, and under Advanced the `ccc` path on the server for SSH.
//
// Main checks everything again (`remote.connect`: the host allowlist, the link parser, the ccc
// path); this form only trims and leaves out empty optional fields. A failure comes back as text and
// shows in place (never thrown at the form); success opens the server's window and main closes the
// picker, this form with it.
import { useEffect, useId, useRef, useState } from 'react'
import { ipcErrorMessage } from '../ipc-error'
import { connectFailureText, connectRequest, type ConnectKind } from './picker-model'

export function ConnectForm(props: { onClose(): void; onConnected(serverId: string): void }): React.JSX.Element {
  const uid = useId()
  const [kind, setKind] = useState<ConnectKind>('ssh')
  const [host, setHost] = useState('')
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [ccc, setCcc] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstField = useRef<HTMLInputElement>(null)

  useEffect(() => {
    firstField.current?.focus()
  }, [kind])

  const target = kind === 'ssh' ? host : link
  const canConnect = !busy && target.trim() !== ''

  const submit = (): void => {
    if (!canConnect) return
    setBusy(true)
    setError(null)
    window.cockpit
      .invoke('remote.connect', connectRequest(kind, { host, link, name, ccc }))
      .then((answer) => {
        if (answer.ok) props.onConnected(answer.serverId)
        else setError(connectFailureText(answer))
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => setBusy(false))
  }

  // Esc closes (kept from the modal picker's own Esc); Tab stays inside (a modal dialog).
  const onDialogKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'Tab') {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary') ?? []
      ).filter((el) => el.offsetParent !== null)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const titleId = `${uid}-title`
  const errorId = `${uid}-error`
  return (
    <div
      className="picker-dialog-backdrop"
      onMouseDown={(e) => {
        // A press on the backdrop itself closes (nothing typed is precious); one that started inside does not.
        if (e.target === e.currentTarget && !busy) props.onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onDialogKey}
      >
        <h2 id={titleId}>Connect to server</h2>
        <form
          className="connect-form"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="connect-kind" role="radiogroup" aria-label="Connect with">
            {(
              [
                ['ssh', 'SSH host'],
                ['link', 'Link']
              ] as const
            ).map(([value, label]) => (
              <label key={value} className={kind === value ? 'selected' : undefined}>
                <input
                  type="radio"
                  name={`${uid}-kind`}
                  value={value}
                  checked={kind === value}
                  disabled={busy}
                  onChange={() => {
                    setKind(value)
                    setError(null)
                  }}
                />
                {label}
              </label>
            ))}
          </div>

          {kind === 'ssh' ? (
            <Field
              id={`${uid}-host`}
              label="SSH host"
              hint="Signs in with your SSH agent and keys, as ~/.ssh/config says. The server runs cc-cockpit in server mode."
              errorId={error !== null ? errorId : undefined}
            >
              {(attrs) => (
                <input
                  {...attrs}
                  ref={firstField}
                  placeholder="devbox or me@box.example.com"
                  value={host}
                  disabled={busy}
                  onChange={(e) => setHost(e.target.value)}
                />
              )}
            </Field>
          ) : (
            <Field
              id={`${uid}-link`}
              label="Link"
              hint="The access link, or a one-time link from “ccc web add-device” on the server."
              errorId={error !== null ? errorId : undefined}
            >
              {(attrs) => (
                <input
                  {...attrs}
                  ref={firstField}
                  placeholder="https://server.example.com/#t=…"
                  value={link}
                  disabled={busy}
                  onChange={(e) => setLink(e.target.value)}
                />
              )}
            </Field>
          )}

          <Field id={`${uid}-name`} label="Name (optional)">
            {(attrs) => <input {...attrs} maxLength={100} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />}
          </Field>

          {kind === 'ssh' && (
            <details className="connect-advanced">
              <summary>Advanced</summary>
              <Field
                id={`${uid}-ccc`}
                label="ccc path on the server"
                hint="An absolute path, only when ccc is not found on the server by itself."
              >
                {(attrs) => (
                  <input
                    {...attrs}
                    placeholder="/opt/cc-cockpit/bin/ccc"
                    value={ccc}
                    disabled={busy}
                    onChange={(e) => setCcc(e.target.value)}
                  />
                )}
              </Field>
            </details>
          )}

          {error !== null && (
            <p role="alert" id={errorId} className="picker-error">
              Cannot connect: {error}
            </p>
          )}

          <footer className="picker-dialog-foot">
            <button type="button" className="picker-cancel" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="picker-primary" disabled={!canConnect}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

/** The attributes every text field of the form shares; `Field` passes them to its input. */
interface FieldAttrs {
  id: string
  type: 'text'
  spellCheck: false
  autoComplete: 'off'
  'aria-describedby'?: string
}

/**
 * A labelled text field: the label names the input alone (the hint and an error describe it), so
 * a screen reader, and a spec, finds it by its label.
 */
function Field(props: {
  id: string
  label: string
  hint?: string
  errorId?: string | undefined
  children(attrs: FieldAttrs): React.ReactNode
}): React.JSX.Element {
  const hintId = `${props.id}-hint`
  const described = [props.hint === undefined ? undefined : hintId, props.errorId].filter((x) => x !== undefined).join(' ')
  return (
    <div className="connect-field">
      <label htmlFor={props.id}>{props.label}</label>
      {props.children({
        id: props.id,
        type: 'text',
        spellCheck: false,
        autoComplete: 'off',
        ...(described === '' ? {} : { 'aria-describedby': described })
      })}
      {props.hint !== undefined && <small id={hintId}>{props.hint}</small>}
    </div>
  )
}
