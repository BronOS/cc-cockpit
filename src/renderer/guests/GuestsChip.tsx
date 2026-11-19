import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GuestView } from '../../shared/guests'
import type { TabInfo } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { approvalStack } from '../notices/approval-model'
import { tabLabel } from '../tabs/tab-label'
import { useShellLayer } from '../zones/use-shell-layer'
import { downgradeWarning, guestRows, liveChip, projectGuests, upgradeTitle, type GuestRow } from './guest-list-model'
import { InviteDialog } from './InviteDialog'
import { writeWarning } from './invite-model'
import { canWidenGuests, useGuests, usePresence, useWebAccessOn } from './use-guests'

/**
 * The owner's guest entry in the top bar (design-guests §10): the "Live" chip while this project has
 * guests or invites, opening the guest list; with none, a small "Share" button that opens the invite
 * dialog, drawn only where this view may invite (the desktop page; a server's browser, D-11) and only
 * while web access is on, so a window that never shares looks as before. TopStrip draws it on owner
 * views only (never when the shell's guest hint is set); main refuses every guest channel to anyone
 * else whatever this draws.
 *
 * The list (a popover under the chip, portalled so the title bar's drag region and overflow do not
 * clip it): name, role, state, the tab each guest looks at and typing (presence), when access ends; a
 * Read-only / Write switch, Kick (Revoke invite for a pending one), and Invite…. Narrowing acts at
 * once (a downgrade that loses a guest's unsaved page edits says so first); an upgrade to write shows
 * the write warning in the armed approval (D-11: required in a server's browser, and the one place the
 * warning is read before a guest can type, so the desktop gets it too). An owner browser of a desktop
 * host may only narrow (no Write, no Invite…).
 */
export function GuestsChip(props: { projectId: string; inert: boolean | undefined; onOpenSettings: () => void }): React.JSX.Element | null {
  const all = useGuests(true)
  const presence = usePresence()
  const webOn = useWebAccessOn(props.inert)
  const canWiden = canWidenGuests()
  const guests = projectGuests(all, props.projectId)
  const chip = liveChip(guests, canWiden, webOn)
  // Where the open list hangs, under the chip, measured at the click (null: closed). Shown only while the
  // chip is: the last guest going takes the list down with it.
  const [openAt, setOpenAt] = useState<ListPlace | null>(null)
  const [inviting, setInviting] = useState(false)
  const close = useCallback(() => setOpenAt(null), [])
  // The chip went (the last guest left): the list goes with it, and does not pop up again with the next guest.
  if (chip.kind !== 'live' && openAt !== null) setOpenAt(null)

  if (chip.kind === 'none' && !inviting) return null
  return (
    <>
      {chip.kind === 'share' && (
        <button
          type="button"
          className="guest-chip guest-share"
          title="Invite a guest to this project"
          onClick={() => setInviting(true)}
        >
          Share
        </button>
      )}
      {chip.kind === 'live' && (
        <button
          type="button"
          className="guest-chip"
          data-live={chip.live > 0 || undefined}
          title={chip.title}
          aria-label={`Guests: ${chip.title}`}
          aria-haspopup="dialog"
          aria-expanded={openAt !== null}
          onClick={(e) => {
            // Else the window's click listener closes the list this opens.
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            setOpenAt(openAt === null ? { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) } : null)
          }}
        >
          <span className="guest-chip-dot" aria-hidden="true" />
          {chip.text}
        </button>
      )}
      {openAt !== null && chip.kind === 'live' && (
        <GuestList
          place={openAt}
          guests={guests}
          presence={presence}
          canWiden={canWiden}
          onInvite={() => {
            setOpenAt(null)
            setInviting(true)
          }}
          onClose={close}
        />
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onOpenSettings={props.onOpenSettings} />}
    </>
  )
}

/** The list's corner in the window: under the chip, its right edge on the chip's. */
interface ListPlace {
  top: number
  right: number
}

/** A question one row is asking: the downgrade warning (inline) or the upgrade's armed approval. */
type Asking = { kind: 'downgrade'; guestId: string; text: string } | { kind: 'upgrade'; guestId: string; name: string }

function GuestList(props: {
  place: ListPlace
  guests: readonly GuestView[]
  presence: ReturnType<typeof usePresence>
  canWiden: boolean
  onInvite: () => void
  onClose: () => void
}): React.JSX.Element {
  const { onClose } = props
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [asking, setAsking] = useState<Asking | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  // A webview panel's native view would paint over the list (shell-layers.ts).
  useShellLayer(true)

  // Tab labels for "looks at", read as the list opens; the "ends in" texts tick once a minute.
  useEffect(() => {
    let live = true
    window.cockpit.invoke('tabs.list').then(
      (list) => {
        if (live) setTabs(list)
      },
      () => undefined
    )
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  // Any click elsewhere or Escape closes the list (not an Escape an approval over it is answering).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && approvalStack.size === 0) onClose()
    }
    window.addEventListener('click', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const labelOf = (tabId: string): string | undefined => {
    const tab = tabs.find((t) => t.id === tabId)
    return tab ? tabLabel(tab) : undefined
  }
  const rows = guestRows(props.guests, props.presence, labelOf, now, props.canWiden)

  const act = (call: Promise<boolean>, failed: string): void => {
    setError(undefined)
    call.then(
      (ok) => {
        if (!ok) setError(failed)
      },
      (err: unknown) => setError(ipcErrorMessage(err))
    )
  }
  const setRole = (guestId: string, role: 'read' | 'write'): void =>
    act(window.cockpit.invoke('guests.setRole', { guestId, role }), 'The role did not change: the guest may have left.')
  const pickRole = (row: GuestRow, role: 'read' | 'write'): void => {
    if (role === row.role) return
    if (role === 'write') {
      setAsking({ kind: 'upgrade', guestId: row.id, name: row.name })
      return
    }
    const guest = props.guests.find((g) => g.id === row.id)
    const text = guest ? downgradeWarning(guest) : undefined
    if (text !== undefined) setAsking({ kind: 'downgrade', guestId: row.id, text })
    else setRole(row.id, 'read')
  }
  const end = (row: GuestRow): void => {
    if (row.end.kind === 'revoke') {
      act(window.cockpit.invoke('guests.revokeInvite', { inviteId: row.end.inviteId }), 'The invite was already used or gone.')
    } else act(window.cockpit.invoke('guests.kick', { guestId: row.id }), 'The guest was already gone.')
  }

  return createPortal(
    <div
      className="menu guest-list"
      role="dialog"
      aria-label="Guests"
      style={{ top: props.place.top, right: props.place.right }}
      // The window's click listener would close the list under the pointer (and under the approval,
      // whose clicks bubble here through the React tree).
      onClick={(e) => e.stopPropagation()}
    >
      <div className="menu-caption">Guests of this project</div>
      <ul className="guest-rows">
        {rows.map((row) => (
          <li key={row.id} className="guest-row" data-guest-id={row.id}>
            <div className="guest-row-head">
              <span className="guest-row-name">{row.name}</span>
              <span className="guest-row-state">{row.stateText}</span>
            </div>
            <div className="guest-row-meta">
              {row.roleText} · {row.scopeText} · {row.untilText}
              {row.tabText !== undefined && (
                <>
                  {' · '}
                  {row.typing ? 'typing in ' : 'on '}
                  {row.tabText}
                </>
              )}
            </div>
            {asking?.kind === 'downgrade' && asking.guestId === row.id ? (
              <div className="guest-row-ask" role="alert">
                <p>{asking.text}</p>
                <div className="guest-row-actions">
                  <button type="button" onClick={() => setAsking(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="guest-danger"
                    onClick={() => {
                      setAsking(null)
                      setRole(row.id, 'read')
                    }}
                  >
                    Make read-only
                  </button>
                </div>
              </div>
            ) : (
              <div className="guest-row-actions">
                <div className="guest-role-switch" role="radiogroup" aria-label={`${row.name}'s role`}>
                  <button type="button" role="radio" aria-checked={row.role === 'read'} onClick={() => pickRole(row, 'read')}>
                    Read-only
                  </button>
                  {row.canWrite && (
                    <button type="button" role="radio" aria-checked={row.role === 'write'} onClick={() => pickRole(row, 'write')}>
                      Write
                    </button>
                  )}
                </div>
                <button type="button" className="guest-danger" onClick={() => end(row)}>
                  {row.end.label}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {error !== undefined && (
        <p role="alert" className="guest-error">
          {error}
        </p>
      )}
      {props.canWiden && (
        <>
          <div role="separator" className="menu-separator" />
          <button type="button" onClick={props.onInvite}>
            Invite…
          </button>
        </>
      )}
      {asking?.kind === 'upgrade' && (
        <ApprovalDialog
          title={upgradeTitle(asking.name)}
          allowLabel="Allow write"
          denyLabel="Cancel"
          testIds={{ dialog: 'guest-upgrade-confirm' }}
          onAnswer={(allow) => {
            const guestId = asking.guestId
            setAsking(null)
            if (allow) setRole(guestId, 'write')
          }}
        >
          <p>
            <strong>{writeWarning(asking.name).headline}</strong> {writeWarning(asking.name).body}
          </p>
        </ApprovalDialog>
      )}
    </div>,
    document.body
  )
}
