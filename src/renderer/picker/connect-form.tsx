// The picker's Connect to server form, and Edit (design-remote-desktop.md §3, §5, §6, §7): a modal
// card over the desktop picker with three tabs.
//  - SSH: the app's built-in SSH client signs in (agent and keys, a password, or one key file), runs
//    `ccc web` on the server and owns the tunnel. Passwords and passphrases are never typed here:
//    they come through the prompts (remote-prompts.tsx) when main asks for them, so a remembered,
//    a forgotten and a wrong secret all take the one path.
//  - My own tunnel: the person runs the two commands shown (built live from the fields) and pastes
//    the add-device link; the app connects to 127.0.0.1:<local port>.
//  - Link: the access link or a one-time add-device link, as a browser would use it.
// Edit opens the same form prefilled for a saved server, its tab locked (Edit cannot change how a
// server is reached).
//
// Main checks everything again (the host allowlist, the link parser, the ccc and key paths); this
// form only trims, reads the ports and leaves out empty optional fields. A failure comes back as
// text and shows in place (never thrown at the form); success opens the server's window and main
// closes the picker, this form with it (an SSH Edit opens nothing: the form closes).
import { useEffect, useId, useRef, useState } from 'react'
import type { RemoteConnectAnswer, RemoteServerInfo } from '../../shared/ipc'
import type { RemoteAnswers } from '../../shared/remote-servers'
import { ipcErrorMessage } from '../ipc-error'
import {
  canConnect,
  connectSettings,
  editFields,
  emptyConnectFields,
  tabOf,
  tunnelCommands,
  type ConnectAuth,
  type ConnectFields,
  type ConnectTab
} from './picker-model'
import { useRemotePrompts } from './remote-prompts'

const TABS: ReadonlyArray<readonly [ConnectTab, string]> = [
  ['ssh', 'SSH'],
  ['tunnel', 'My own tunnel'],
  ['link', 'Link']
]

const AUTHS: ReadonlyArray<readonly [ConnectAuth, string]> = [
  ['auto', 'Agent and my keys'],
  ['password', 'Password'],
  ['key', 'Key file']
]

export function ConnectForm(props: {
  /** A saved server to edit: the form starts with its settings, on its own tab, locked. */
  edit?: RemoteServerInfo
  onClose(): void
  /** Connected, or the edit was saved (and, for a link with a token, signed in). */
  onDone(serverId: string): void
}): React.JSX.Element {
  const uid = useId()
  const editing = props.edit
  const [tab, setTab] = useState<ConnectTab>(editing ? tabOf(editing.via) : 'ssh')
  const [fields, setFields] = useState<ConnectFields>(() => (editing ? editFields(editing) : emptyConnectFields()))
  const [forgetHostKey, setForgetHostKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const { run, prompt } = useRemotePrompts()

  useEffect(() => {
    firstField.current?.focus()
  }, [tab])

  const set = <K extends keyof ConnectFields>(key: K, value: ConnectFields[K]): void => setFields((f) => ({ ...f, [key]: value }))
  const ready = !busy && canConnect(tab, fields)

  const submit = (): void => {
    if (!ready) return
    const settings = connectSettings(tab, fields)
    if ('error' in settings) {
      setError(settings.error)
      return
    }
    setBusy(true)
    setError(null)
    const call = (answers: RemoteAnswers | undefined): Promise<RemoteConnectAnswer> => {
      if (editing === undefined) {
        // Answers ride on an SSH connect only (the other kinds never ask).
        return window.cockpit.invoke('remote.connect', settings.kind === 'ssh' && answers !== undefined ? { ...settings, answers } : settings)
      }
      // Edit saves; a `need` after it (a link signing in) is answered by opening the saved server
      // with the answers, which is what Edit's own sign-in would have done (plan Task 5, IPC note).
      if (answers !== undefined) return window.cockpit.invoke('remote.open', { serverId: editing.id, answers })
      return window.cockpit.invoke('remote.edit', {
        ...settings,
        serverId: editing.id,
        ...(settings.kind === 'ssh' && forgetHostKey ? { forgetHostKey: true } : {})
      })
    }
    run(call, editing === undefined ? {} : { canRemember: editing.cookieKept })
      .then((answer) => {
        if (answer.ok) props.onDone(answer.serverId)
        else if ('error' in answer) setError(answer.error)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => setBusy(false))
  }

  const browse = (): void => {
    window.cockpit
      .invoke('remote.pickKey')
      .then((path) => {
        if (path !== null) set('keyPath', path)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
  }

  // Esc closes (kept from the modal picker's own Esc); Tab stays inside (a modal dialog).
  const onDialogKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      props.onClose()
    } else if (e.key === 'Tab') {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary') ?? []
      ).filter((el) => el.offsetParent !== null && el.tabIndex >= 0)
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

  // The tab strip's arrow keys (WAI-ARIA tabs): ←/→ move and select; a locked Edit has one tab only.
  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (editing || busy || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
    e.preventDefault()
    const at = TABS.findIndex(([t]) => t === tab)
    const next = TABS[(at + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]![0]
    setTab(next)
    setError(null)
    document.getElementById(`${uid}-tab-${next}`)?.focus()
  }

  const titleId = `${uid}-title`
  const errorId = `${uid}-error`
  const errorRef = error !== null ? errorId : undefined
  const commands = tab === 'tunnel' ? tunnelCommands(fields) : undefined
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
        <h2 id={titleId}>{editing ? `Edit ${editing.name}` : 'Connect to server'}</h2>
        <form
          className="connect-form"
          aria-busy={busy}
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="connect-tabs" role="tablist" aria-label="Connect with">
            {TABS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                id={`${uid}-tab-${value}`}
                data-testid={`connect-tab-${value}`}
                aria-selected={tab === value}
                aria-controls={`${uid}-panel`}
                tabIndex={tab === value ? 0 : -1}
                // Edit keeps the server's kind: the other tabs show what exists but do not open.
                disabled={busy || (editing !== undefined && tab !== value)}
                onKeyDown={onTabKey}
                onClick={() => {
                  setTab(value)
                  setError(null)
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div id={`${uid}-panel`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`} className="connect-panel">
            {tab === 'ssh' && (
              <>
                <Field
                  id={`${uid}-host`}
                  label="Host"
                  testId="connect-ssh-host"
                  hint="A host name, address or ~/.ssh/config alias. The server runs cc-cockpit in server mode."
                  errorId={errorRef}
                >
                  {(attrs) => (
                    <input
                      {...attrs}
                      ref={firstField}
                      placeholder="devbox or me@box.example.com"
                      value={fields.host}
                      disabled={busy}
                      onChange={(e) => set('host', e.target.value)}
                    />
                  )}
                </Field>
                <div className="connect-row">
                  <Field id={`${uid}-user`} label="User" testId="connect-ssh-user" hint="Empty: as ~/.ssh/config says, else yours.">
                    {(attrs) => <input {...attrs} value={fields.user} disabled={busy} onChange={(e) => set('user', e.target.value)} />}
                  </Field>
                  <Field id={`${uid}-port`} label="Port" testId="connect-ssh-port" hint="Empty: the config’s, else 22." narrow>
                    {(attrs) => (
                      <input {...attrs} inputMode="numeric" placeholder="22" value={fields.port} disabled={busy} onChange={(e) => set('port', e.target.value)} />
                    )}
                  </Field>
                </div>
                <div className="connect-field">
                  <span className="connect-label" id={`${uid}-auth`}>
                    Sign in with
                  </span>
                  <div className="connect-kind" role="radiogroup" aria-labelledby={`${uid}-auth`}>
                    {AUTHS.map(([value, label]) => (
                      <label key={value} className={fields.auth === value ? 'selected' : undefined}>
                        <input
                          type="radio"
                          name={`${uid}-auth`}
                          value={value}
                          data-testid={`connect-ssh-auth-${value}`}
                          checked={fields.auth === value}
                          disabled={busy}
                          onChange={() => set('auth', value)}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                  <small>
                    {fields.auth === 'auto'
                      ? 'Your SSH agent, then the keys ~/.ssh/config names or the default ones.'
                      : fields.auth === 'password'
                        ? 'The app asks for the password when it connects.'
                        : 'The app asks for the passphrase when the key has one.'}
                  </small>
                </div>
                {fields.auth === 'key' && (
                  <Field id={`${uid}-key`} label="Key file" testId="connect-ssh-key-path">
                    {(attrs) => (
                      <span className="connect-with-button">
                        <input
                          {...attrs}
                          placeholder="~/.ssh/id_ed25519"
                          value={fields.keyPath}
                          disabled={busy}
                          onChange={(e) => set('keyPath', e.target.value)}
                        />
                        <button type="button" className="picker-quiet" data-testid="connect-ssh-key-browse" disabled={busy} onClick={browse}>
                          Browse…
                        </button>
                      </span>
                    )}
                  </Field>
                )}
                {editing !== undefined && (
                  <label className="connect-check">
                    <input
                      type="checkbox"
                      data-testid="connect-forget-host-key"
                      checked={forgetHostKey}
                      disabled={busy}
                      onChange={(e) => setForgetHostKey(e.target.checked)}
                    />
                    <span>
                      Forget the trusted host key
                      <small>Only after the server was reinstalled: the next connect asks “Trust this host?” again.</small>
                    </span>
                  </label>
                )}
              </>
            )}

            {tab === 'tunnel' && (
              <>
                <Field
                  id={`${uid}-ssh-host`}
                  label="SSH host"
                  testId="connect-tunnel-ssh-host"
                  hint="Only for the commands below: the app does not connect to it."
                  errorId={errorRef}
                >
                  {(attrs) => (
                    <input {...attrs} ref={firstField} placeholder="devbox" value={fields.sshHost} disabled={busy} onChange={(e) => set('sshHost', e.target.value)} />
                  )}
                </Field>
                <div className="connect-row">
                  <Field id={`${uid}-remote-port`} label="Server port" testId="connect-tunnel-remote-port" hint="The server’s web access port." narrow>
                    {(attrs) => (
                      <input {...attrs} inputMode="numeric" value={fields.remotePort} disabled={busy} onChange={(e) => set('remotePort', e.target.value)} />
                    )}
                  </Field>
                  <Field id={`${uid}-local-port`} label="Local port" testId="connect-tunnel-local-port" hint="Where the tunnel listens here." narrow>
                    {(attrs) => (
                      <input {...attrs} inputMode="numeric" value={fields.localPort} disabled={busy} onChange={(e) => set('localPort', e.target.value)} />
                    )}
                  </Field>
                </div>
                {commands === undefined ? (
                  <p className="connect-note">Enter both ports to see the commands.</p>
                ) : (
                  <div className="connect-commands">
                    <p className="connect-note">In a terminal, start the tunnel and keep it running:</p>
                    <CommandLine text={commands.tunnel} testId="connect-tunnel-command" label="the tunnel command" />
                    <p className="connect-note">Then make a sign-in link for this app:</p>
                    <CommandLine text={commands.addDevice} testId="connect-add-device-command" label="the add-device command" />
                    <p className="connect-note">
                      On the server, <code>ccc</code> may be at <code>~/.config/cc-cockpit/bin/ccc</code>.
                    </p>
                  </div>
                )}
                <Field
                  id={`${uid}-tunnel-link`}
                  label="Add-device link"
                  testId="connect-tunnel-link"
                  hint={editing ? 'A new link signs this app in again (after the device was revoked).' : 'The link the second command printed.'}
                >
                  {(attrs) => (
                    <input
                      {...attrs}
                      placeholder="http://127.0.0.1:7330/#t=…"
                      value={fields.tunnelLink}
                      disabled={busy}
                      onChange={(e) => set('tunnelLink', e.target.value)}
                    />
                  )}
                </Field>
              </>
            )}

            {tab === 'link' && (
              <Field
                id={`${uid}-link`}
                label="Link"
                testId="connect-link"
                hint="The access link, or a one-time link from “ccc web add-device” on the server."
                errorId={errorRef}
              >
                {(attrs) => (
                  <input
                    {...attrs}
                    ref={firstField}
                    placeholder="https://server.example.com/#t=…"
                    value={fields.link}
                    disabled={busy}
                    onChange={(e) => set('link', e.target.value)}
                  />
                )}
              </Field>
            )}

            <Field id={`${uid}-name`} label="Name (optional)" testId="connect-name">
              {(attrs) => <input {...attrs} maxLength={100} value={fields.name} disabled={busy} onChange={(e) => set('name', e.target.value)} />}
            </Field>

            {tab === 'ssh' && (
              <details className="connect-advanced" open={editing !== undefined && fields.ccc !== '' ? true : undefined}>
                <summary>Advanced</summary>
                <Field
                  id={`${uid}-ccc`}
                  label="ccc path on the server"
                  testId="connect-ssh-ccc"
                  hint="An absolute path, only needed when the server's ccc is not at ~/.config/cc-cockpit/bin/ccc: for example a machine running both the desktop app and a server with its own data dir (then <data dir>/bin/ccc)."
                >
                  {(attrs) => (
                    <input {...attrs} placeholder="/opt/cc-cockpit/bin/ccc" value={fields.ccc} disabled={busy} onChange={(e) => set('ccc', e.target.value)} />
                  )}
                </Field>
              </details>
            )}
          </div>

          {error !== null && (
            <p role="alert" id={errorId} className="picker-error" data-testid="connect-error">
              {editing ? 'Edit failed' : 'Cannot connect'}: {error}
            </p>
          )}

          <footer className="picker-dialog-foot">
            <button type="button" className="picker-cancel" data-testid="connect-cancel" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="picker-primary" data-testid="connect-submit" disabled={!ready}>
              {busy ? (editing ? 'Saving…' : 'Connecting…') : editing ? 'Save' : 'Connect'}
            </button>
          </footer>
        </form>
      </div>
      {prompt}
    </div>
  )
}

/**
 * Copy text with the selection and the editing command: the page has no clipboard permission
 * (main/windows/permissions.ts grants the app page none, so `navigator.clipboard.writeText` is
 * refused), and a copy run inside the click is the person's own gesture.
 */
function copyText(text: string): boolean {
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'visually-hidden'
  document.body.append(area)
  area.select()
  let ok: boolean
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  back?.focus()
  return ok
}

/** One command to run, in monospace and selectable, with its Copy button (which says Copied for a moment). */
function CommandLine(props: { text: string; testId: string; label: string }): React.JSX.Element {
  // What was copied and whether it worked; a new command (a field changed) is not the one copied.
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const shown = copied !== null && copied.text === props.text ? copied.ok : undefined
  return (
    <div className="connect-command">
      <code data-testid={props.testId}>{props.text}</code>
      <button
        type="button"
        className="picker-quiet"
        data-testid={`${props.testId}-copy`}
        aria-label={`Copy ${props.label}`}
        onClick={() => setCopied({ text: props.text, ok: copyText(props.text) })}
      >
        {shown === true ? 'Copied' : shown === false ? 'Select it to copy' : 'Copy'}
      </button>
    </div>
  )
}

/** The attributes every text field of the form shares; `Field` passes them to its input. */
interface FieldAttrs {
  id: string
  type: 'text'
  spellCheck: false
  autoComplete: 'off'
  'data-testid'?: string
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
  testId?: string
  errorId?: string | undefined
  /** A short field (a port) that shares a row. */
  narrow?: boolean
  children(attrs: FieldAttrs): React.ReactNode
}): React.JSX.Element {
  const hintId = `${props.id}-hint`
  const described = [props.hint === undefined ? undefined : hintId, props.errorId].filter((x) => x !== undefined).join(' ')
  return (
    <div className={props.narrow ? 'connect-field connect-narrow' : 'connect-field'}>
      <label htmlFor={props.id}>{props.label}</label>
      {props.children({
        id: props.id,
        type: 'text',
        spellCheck: false,
        autoComplete: 'off',
        ...(props.testId === undefined ? {} : { 'data-testid': props.testId }),
        ...(described === '' ? {} : { 'aria-describedby': described })
      })}
      {props.hint !== undefined && <small id={hintId}>{props.hint}</small>}
    </div>
  )
}
