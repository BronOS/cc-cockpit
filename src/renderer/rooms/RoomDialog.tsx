import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { IpcEventMap } from '../../shared/ipc'
import type { RoomView } from '../../shared/room-view'
import { ipcErrorMessage } from '../ipc-error'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { addSharedAsk, dropSharedAsk } from '../notices/notice-state'
import { isServerView, isWebShell } from '../shell-kind'
import {
  docRows,
  logRows,
  memberRows,
  NO_DOCS,
  NO_LOG,
  NO_MEMBERS,
  roomControls,
  type LiveStatuses
} from './room-view-model'

/** A doc open in the dialog's read-only viewer: its text, or why it could not be read. */
interface OpenDoc {
  path: string
  text?: string
  error?: string
  loading: boolean
}

/**
 * The room view (design-rooms.md §5), a core dialog from a member tab's "Room..." (TabsPane passes `onOpenRoom` to
 * the strip). Built like CccOfferDialog and shown by TabsPane the same way (zones inert, shell layer up, Esc and a
 * click outside close it): members with status, held count and coordinator, Remove; the docs, each opening read-only
 * in the dialog's own text viewer (`rooms.doc`; never the `less` overlay, whose `v` and `!` could write a doc behind
 * main); Reveal folder on the desktop only; the newest log events; Pause / Resume.
 *
 * Fresh data: the room is read again (`rooms.view`) on every `rooms.changed` for it, which main throttles per room
 * (250 ms); member status follows this window's sessions snapshot (`live`), since a status change is no room change.
 * An open doc is read on open and on Reload only, never from the event: the person's own `rooms.doc` read fires no
 * `rooms.changed`, and reading on the event would still re-read on every message.
 *
 * Every string from the room (title, names, paths, log fields, doc text) is the plugin's or a member's: React text
 * nodes only, never markup (room-view-model.ts).
 */
export function RoomDialog(props: { roomId: string; live?: LiveStatuses; onClose: () => void }): React.JSX.Element {
  const { roomId, onClose } = props
  const [view, setView] = useState<RoomView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [doc, setDoc] = useState<OpenDoc | null>(null)
  // The member whose Remove the desktop is confirming on screen, or waiting on (a server browser's approval).
  const [confirming, setConfirming] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  // Only the newest read lands: two `rooms.changed` close together start two reads, which may answer out of order.
  const readSeq = useRef(0)
  const docSeq = useRef(0)
  const mounted = useRef(true)

  const load = useCallback((): void => {
    const seq = ++readSeq.current
    window.cockpit.invoke('rooms.view', { roomId }).then(
      (next) => {
        if (!mounted.current || seq !== readSeq.current) return
        setView(next)
        setLoadError(null)
      },
      (err: unknown) => {
        if (!mounted.current || seq !== readSeq.current) return
        setLoadError(ipcErrorMessage(err))
      }
    )
  }, [roomId])

  useEffect(() => {
    mounted.current = true
    const off = window.cockpit.on('rooms.changed', (event) => {
      if (event.roomId === roomId) load()
    })
    load()
    return () => {
      mounted.current = false
      off()
    }
  }, [roomId, load])

  // Take the keyboard from the terminal behind (inert now, but it held the focus).
  useEffect(() => closeButton.current?.focus(), [])

  // Esc steps back out of what is open inside first (the remove question, then the doc viewer), then closes. Heard on
  // the document, not the dialog: a button that went away with its row (Remove) leaves the focus on <body>, where a
  // keydown on the dialog would never fire. Not for an Esc an approval took (the window's ApprovalDialog, portalled
  // over this one, answers Cancel with it).
  const escape = useRef<() => void>(onClose)
  useEffect(() => {
    escape.current = () => {
      if (confirming !== null) setConfirming(null)
      else if (doc !== null) setDoc(null)
      else onClose()
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (e.target instanceof Element && e.target.closest('[role="alertdialog"]')) return
      e.preventDefault()
      escape.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const openDoc = (path: string): void => {
    const seq = ++docSeq.current
    setDoc((prev) => ({ path, loading: true, ...(prev?.path === path && prev.text !== undefined ? { text: prev.text } : {}) }))
    window.cockpit.invoke('rooms.doc', { roomId, path }).then(
      (text) => {
        if (mounted.current && seq === docSeq.current) setDoc({ path, text, loading: false })
      },
      (err: unknown) => {
        if (mounted.current && seq === docSeq.current) setDoc({ path, error: ipcErrorMessage(err), loading: false })
      }
    )
  }

  const act = (p: Promise<unknown>): void => {
    setActionError(null)
    p.then(load, (err: unknown) => {
      if (mounted.current) setActionError(ipcErrorMessage(err))
    })
  }

  const remove = (name: string): void => {
    setConfirming(null)
    setRemoving(name)
    setActionError(null)
    window.cockpit
      .invoke('rooms.remove', { roomId, name })
      .then(
        () => load(),
        (err: unknown) => {
          if (mounted.current) setActionError(ipcErrorMessage(err))
        }
      )
      .finally(() => {
        if (mounted.current) setRemoving(null)
      })
  }

  const controls = view ? roomControls(view, { webShell: isWebShell(), serverView: isServerView() }) : null
  const members = view ? memberRows(view, props.live) : []
  const docs = view ? docRows(view) : []
  const log = view ? logRows(view) : []

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm-dialog room-dialog"
        data-testid="room-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="room-dialog-head">
          <h2 id={titleId} className="confirm-title">
            {view ? `Room “${view.title}”` : 'Room'}
          </h2>
          <button type="button" ref={closeButton} className="room-dialog-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {controls && (
          <div className="room-dialog-state">
            <span data-testid="room-state">{controls.stateText}</span>
            {controls.canPause && (
              <button type="button" onClick={() => act(window.cockpit.invoke('rooms.pause', { roomId }))}>
                Pause
              </button>
            )}
            {controls.canResume && (
              <button type="button" onClick={() => act(window.cockpit.invoke('rooms.resume', { roomId }))}>
                Resume
              </button>
            )}
            {controls.canReveal && (
              <button type="button" onClick={() => act(window.cockpit.invoke('rooms.reveal', { roomId }))}>
                Reveal folder
              </button>
            )}
          </div>
        )}
        {controls?.readOnlyNote && <p className="room-dialog-note">{controls.readOnlyNote}</p>}
        {(loadError ?? actionError) && (
          <p role="alert" className="room-dialog-error">
            {loadError ?? actionError}
          </p>
        )}
        {!view && !loadError && <p className="room-dialog-note">Loading…</p>}
        {view && doc && (
          <section className="room-dialog-doc" aria-label={`Doc ${doc.path}`}>
            <div className="room-dialog-doc-head">
              <code className="room-dialog-path">{doc.path}</code>
              <button type="button" disabled={doc.loading} onClick={() => openDoc(doc.path)}>
                Reload
              </button>
              <button type="button" onClick={() => setDoc(null)}>
                Back
              </button>
            </div>
            {doc.error !== undefined ? (
              <p role="alert" className="room-dialog-error">
                {doc.error}
              </p>
            ) : (
              <pre className="room-dialog-doc-text" data-testid="room-doc-text" tabIndex={0}>
                {doc.text ?? ''}
              </pre>
            )}
          </section>
        )}
        {view && !doc && (
          <div className="room-dialog-body">
            <section aria-label="Members">
              <h3>Members</h3>
              {members.length === 0 ? (
                <p className="room-dialog-note">{NO_MEMBERS}</p>
              ) : (
                <ul className="room-dialog-list">
                  {members.map((m) => (
                    <li key={m.name} className="room-dialog-member" data-testid="room-member">
                      <span className="room-dialog-name">{m.name}</span>
                      {m.coordinator && <span className="room-dialog-tag">coordinator</span>}
                      <span className={`room-dialog-status status-${m.status}`}>{m.statusText}</span>
                      {m.heldText && <span className="room-dialog-held">{m.heldText}</span>}
                      {controls?.canRemove &&
                        (confirming === m.name ? (
                          <span className="room-dialog-confirm" role="group" aria-label={`Remove ${m.name}?`}>
                            Remove {m.name}? Their tab stays open.
                            <button type="button" onClick={() => setConfirming(null)}>
                              Cancel
                            </button>
                            <button type="button" className="confirm-danger" onClick={() => remove(m.name)}>
                              Remove
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="room-dialog-remove"
                            aria-label={`Remove ${m.name}`}
                            disabled={removing !== null}
                            onClick={() => (controls.confirmRemove ? setConfirming(m.name) : remove(m.name))}
                          >
                            {removing === m.name ? 'Waiting…' : 'Remove'}
                          </button>
                        ))}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Docs">
              <h3>Docs</h3>
              {docs.length === 0 ? (
                <p className="room-dialog-note">{NO_DOCS}</p>
              ) : (
                <ul className="room-dialog-list">
                  {docs.map((d) => (
                    <li key={d.path}>
                      <button type="button" className="room-dialog-doc-link" onClick={() => openDoc(d.path)}>
                        {d.path}
                      </button>
                      <span className="room-dialog-size">{d.sizeText}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Log">
              <h3>Log</h3>
              {log.length === 0 ? (
                <p className="room-dialog-note">{NO_LOG}</p>
              ) : (
                <ol className="room-dialog-log" data-testid="room-log">
                  {log.map((row) => (
                    <li key={row.seq}>
                      <span className="room-dialog-time">{row.time}</span> {row.text}
                    </li>
                  ))}
                </ol>
              )}
              {view.logMore && <p className="room-dialog-note">Older events are not shown.</p>}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

type RoomRemoveAsk = IpcEventMap['rooms.removeAsk']

/**
 * `rooms.removeAsk`: a server's browser asked to remove a room member (main's router waits on it). Every view of the
 * window shows it, the first answer wins (`rooms.removeAnswer`) and `rooms.removeSettled` takes it down in the
 * others; a browser that connects meanwhile gets it replayed from `ready` (web/bridge.ts). The guarded ApprovalDialog
 * everywhere (as TrashConfirm): no focus taken from a terminal, Remove never the default, armed after a second. The
 * title and name are the plugin's text, shown as plain text.
 */
export function RoomRemoveConfirm(): React.JSX.Element | null {
  const [asks, setAsks] = useState<readonly RoomRemoveAsk[]>([])
  useEffect(() => {
    const offAsk = window.cockpit.on('rooms.removeAsk', (ask) => setAsks((prev) => addSharedAsk(prev, ask)))
    const offSettled = window.cockpit.on('rooms.removeSettled', ({ requestId }) => setAsks((prev) => dropSharedAsk(prev, requestId)))
    return () => {
      offAsk()
      offSettled()
    }
  }, [])
  const ask = asks[0]
  if (!ask) return null
  const onAnswer = (remove: boolean): void => {
    setAsks((prev) => dropSharedAsk(prev, ask.requestId))
    window.cockpit.invoke('rooms.removeAnswer', { requestId: ask.requestId, remove }).catch(() => {})
  }
  return (
    <ApprovalDialog
      key={ask.requestId}
      title={`Remove ${ask.name} from the room “${ask.title}”?`}
      allowLabel="Remove"
      denyLabel="Cancel"
      testIds={{ dialog: 'room-remove-ask' }}
      onAnswer={onAnswer}
    >
      <p>
        A browser asked to remove the member {ask.name}. Its tab stays open as an ordinary Claude tab; the messages
        waiting for it are dropped.
      </p>
    </ApprovalDialog>
  )
}
