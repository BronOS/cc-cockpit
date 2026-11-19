import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GUEST_LIFETIMES, GUEST_NAME_MAX, type GuestInviteRequest } from '../../shared/guests'
import type { TabInfo } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { approvalStack } from '../notices/approval-model'
import { isServerView } from '../shell-kind'
import { useShellLayer } from '../zones/use-shell-layer'
import { copyText } from './copy-text'
import {
  emptyInviteForm,
  inviteConfirmTitle,
  inviteBlockedText,
  inviteDismiss,
  inviteErrorText,
  inviteProblem,
  inviteRequest,
  inviteTabRows,
  LIFETIME_LABEL,
  LINK_ONCE_TEXT,
  LOOPBACK_WARNING_TEXT,
  NO_SHARED_PLUGINS_TEXT,
  ROLE_LABEL,
  SCROLLBACK_LINE,
  sharedPluginNames,
  writeWarning,
  type InviteForm
} from './invite-model'

/** The made invite: the link is shown once, in this dialog's state only, and gone with it. */
interface Made {
  name: string
  link: string
  loopbackOnly: boolean
}

/**
 * The owner's invite dialog (design-guests §10, acceptance 1): name, role, all or selected tabs, lifetime
 * (D-12), the plugins guests see with a way to Settings, the write warning when the role is write, and
 * always the scrollback line (D-13). On success the link is shown once with Copy; main keeps only its
 * hash, so closing the dialog loses it for good (revoke and invite again).
 *
 * Modal like the web access risk confirm (RiskConfirmDialog): portalled out of #root, which goes inert
 * while it is up, so no key typed into the name field reaches a terminal behind. Esc and Cancel close it
 * (not a click outside: a half-filled form is not dropped by a stray click), but not while the invite is
 * being made, and once the link shows only Done does (the link is shown once). Under sign-in None the
 * dialog says so as it opens and Create stays off (D-1). In a server's browser the
 * invite is a widening of access from a remote view, so it goes through the armed approval (D-11,
 * ApprovalDialog: never the default, live after a second); main decides by its own flag either way.
 */
export function InviteDialog(props: { onClose: () => void; onOpenSettings: () => void }): React.JSX.Element {
  const { onClose } = props
  const [form, setForm] = useState<InviteForm>(emptyInviteForm)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [plugins, setPlugins] = useState<string[] | null>(null)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Made | null>(null)
  const [copied, setCopied] = useState<boolean | undefined>(undefined)
  // The request waiting for the armed confirm (a server's browser only).
  const [confirming, setConfirming] = useState<GuestInviteRequest | null>(null)
  // Sign-in None (D-1): said as the dialog opens, Create disabled (main refuses `none-mode` anyway).
  const [blocked, setBlocked] = useState<string | undefined>(undefined)
  const titleId = useId()
  const mounted = useRef(true)
  // A webview panel's native view would paint over the dialog (shell-layers.ts).
  useShellLayer(true)

  useEffect(() => {
    mounted.current = true
    window.cockpit.invoke('tabs.list').then(
      (list) => {
        if (mounted.current) setTabs(list)
      },
      () => undefined
    )
    window.cockpit.invoke('settings.webAccess').then(
      (view) => {
        if (mounted.current) setBlocked(inviteBlockedText(view.form.mode))
      },
      () => undefined
    )
    window.cockpit.invoke('settings.plugins').then(
      (list) => {
        if (mounted.current) setPlugins(sharedPluginNames(list))
      },
      () => undefined
    )
    return () => {
      mounted.current = false
    }
  }, [])

  // #root inert while the dialog is up, the focus back where it was after; Esc closes (not while an
  // approval is up over it: that Esc is the approval's Cancel, heard on the approval itself; not while
  // the invite is being made, nor once the link shows: inviteDismiss).
  const dismiss = inviteDismiss({ busy, linkShown: made !== null })
  const closeRef = useRef(onClose)
  const escRef = useRef(dismiss.esc)
  useEffect(() => {
    closeRef.current = onClose
    escRef.current = dismiss.esc
  })
  useEffect(() => {
    const root = document.getElementById('root')
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root?.setAttribute('inert', '')
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || approvalStack.size > 0) return
      // Swallowed even when it closes nothing: an Esc must not reach a terminal or the page behind.
      e.preventDefault()
      e.stopPropagation()
      if (escRef.current) closeRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      root?.removeAttribute('inert')
      if (before?.isConnected && root?.contains(before)) before.focus()
    }
  }, [])

  const rows = inviteTabRows(tabs)
  const set = (patch: Partial<InviteForm>): void => {
    setProblem(undefined)
    setForm((f) => ({ ...f, ...patch }))
  }

  const send = (request: GuestInviteRequest): void => {
    setBusy(true)
    window.cockpit
      .invoke('guests.invite', request)
      .then(
        (answer) => {
          if (!mounted.current) return
          if (answer.ok) setMade({ name: request.name, link: answer.link, loopbackOnly: answer.warning === 'loopback-only' })
          else setProblem(inviteErrorText(answer.error, request.name))
        },
        (err: unknown) => {
          if (mounted.current) setProblem(ipcErrorMessage(err))
        }
      )
      .finally(() => {
        if (mounted.current) setBusy(false)
      })
  }

  const submit = (): void => {
    const request = inviteRequest(form, rows.map((r) => r.id))
    if (request === undefined) {
      setProblem(inviteProblem({ ...form, selected: form.selected.filter((id) => rows.some((r) => r.id === id)) }))
      return
    }
    if (isServerView()) setConfirming(request)
    else send(request)
  }

  const warning = writeWarning(form.name)
  return createPortal(
    <div className="confirm-backdrop guest-dialog-backdrop">
      <div className="confirm-dialog guest-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="guest-invite-dialog">
        {made === null ? (
          <form
            className="guest-invite-form"
            onSubmit={(e) => {
              e.preventDefault()
              // Enter in the form again while the armed confirm is up (it takes no focus) asks nothing twice.
              if (!busy && blocked === undefined && confirming === null) submit()
            }}
          >
            <h2 id={titleId} className="confirm-title">
              Invite a guest
            </h2>
            <label className="guest-field">
              <span className="guest-field-label">Name</span>
              <input
                autoFocus
                value={form.name}
                maxLength={GUEST_NAME_MAX}
                placeholder="Who you invite"
                aria-describedby={problem !== undefined ? `${titleId}-problem` : undefined}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <fieldset className="guest-field guest-choices">
              <legend className="guest-field-label">Role</legend>
              {(['read', 'write'] as const).map((role) => (
                <label key={role}>
                  <input type="radio" name="guest-role" checked={form.role === role} onChange={() => set({ role })} />
                  {ROLE_LABEL[role]}
                </label>
              ))}
            </fieldset>
            {form.role === 'write' && (
              <p className="guest-warning" data-testid="guest-write-warning">
                <strong>{warning.headline}</strong> {warning.body}
              </p>
            )}
            <fieldset className="guest-field guest-choices">
              <legend className="guest-field-label">Tabs</legend>
              <label>
                <input type="radio" name="guest-tabs" checked={form.tabs === 'all'} onChange={() => set({ tabs: 'all' })} />
                All tabs, now and later
              </label>
              <label>
                <input type="radio" name="guest-tabs" checked={form.tabs === 'selected'} onChange={() => set({ tabs: 'selected' })} />
                Selected tabs
              </label>
            </fieldset>
            {form.tabs === 'selected' && (
              <div className="guest-tab-list" role="group" aria-label="Tabs to share">
                {rows.length === 0 && <p className="guest-note">This project has no tabs.</p>}
                {rows.map((row) => (
                  <label key={row.id}>
                    <input
                      type="checkbox"
                      checked={form.selected.includes(row.id)}
                      onChange={(e) =>
                        set({ selected: e.target.checked ? [...form.selected, row.id] : form.selected.filter((id) => id !== row.id) })
                      }
                    />
                    {row.label}
                  </label>
                ))}
              </div>
            )}
            <label className="guest-field">
              <span className="guest-field-label">Access lasts</span>
              <select value={form.lifetime} onChange={(e) => set({ lifetime: GUEST_LIFETIMES.find((l) => l === e.target.value) ?? form.lifetime })}>
                {GUEST_LIFETIMES.map((l) => (
                  <option key={l} value={l}>
                    {LIFETIME_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <div className="guest-field">
              <span className="guest-field-label">Plugins guests see</span>
              <p className="guest-note">
                {plugins === null ? '…' : plugins.length === 0 ? NO_SHARED_PLUGINS_TEXT : plugins.join(', ')}{' '}
                <button
                  type="button"
                  className="guest-link-button"
                  disabled={!dismiss.cancel}
                  onClick={() => {
                    onClose()
                    props.onOpenSettings()
                  }}
                >
                  Change in Settings
                </button>
              </p>
            </div>
            <p className="guest-note">{SCROLLBACK_LINE}</p>
            {blocked !== undefined && (
              <p role="alert" className="guest-error" data-testid="guest-invite-blocked">
                {blocked}
              </p>
            )}
            {problem !== undefined && (
              <p id={`${titleId}-problem`} role="alert" className="guest-error">
                {problem}
              </p>
            )}
            <div className="confirm-buttons">
              <button type="button" disabled={!dismiss.cancel} onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="guest-primary" disabled={busy || blocked !== undefined}>
                Create invite
              </button>
            </div>
          </form>
        ) : (
          <>
            <h2 id={titleId} className="confirm-title">
              Invite link for {made.name}
            </h2>
            <div className="guest-link-row">
              <code className="guest-link" data-testid="guest-invite-link">
                {made.link}
              </code>
              <button type="button" onClick={() => setCopied(copyText(made.link))}>
                {copied === undefined ? 'Copy' : copied ? 'Copied' : 'Copy failed'}
              </button>
            </div>
            <p className="guest-note">{LINK_ONCE_TEXT}</p>
            {made.loopbackOnly && (
              <p className="guest-warning" role="alert">
                {LOOPBACK_WARNING_TEXT}
              </p>
            )}
            <div className="confirm-buttons">
              <button type="button" autoFocus onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
      {confirming !== null && (
        <ApprovalDialog
          title={inviteConfirmTitle(confirming.name, confirming.role)}
          allowLabel="Create invite"
          denyLabel="Cancel"
          testIds={{ dialog: 'guest-invite-confirm' }}
          onAnswer={(allow) => {
            const request = confirming
            setConfirming(null)
            if (allow) send(request)
          }}
        >
          {confirming.role === 'write' && (
            <p>
              <strong>{writeWarning(confirming.name).headline}</strong> {writeWarning(confirming.name).body}
            </p>
          )}
          <p>{SCROLLBACK_LINE}</p>
        </ApprovalDialog>
      )}
    </div>,
    document.body
  )
}
