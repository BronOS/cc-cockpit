import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { IpcEventMap } from '../../shared/ipc'
import type { RoomView } from '../../shared/room-view'
import { ipcErrorMessage } from '../ipc-error'
import { ApprovalDialog } from '../notices/ApprovalDialog'
import { allowClickCounts, ApprovalArm, approvalStack } from '../notices/approval-model'
import { addSharedAsk, dropSharedAsk } from '../notices/notice-state'
import { isServerView, isWebShell } from '../shell-kind'
import {
  docRows,
  isRoomGone,
  logRows,
  memberRows,
  NO_DOCS,
  NO_LOG,
  NO_MEMBERS,
  ROOM_GONE_TEXT,
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
  const [gone, setGone] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  // The element to focus once the next render has put it in place: a button that unmounts (Remove turning into the
  // question, a doc button, Back) drops the focus to <body>, so the one that should have it is found after the render.
  const focusNext = useRef<((root: HTMLElement) => HTMLElement | null) | null>(null)
  useEffect(() => {
    const find = focusNext.current
    if (!find) return
    focusNext.current = null
    if (dialogRef.current) find(dialogRef.current)?.focus()
  })
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
        setGone(false)
        setLoadError(null)
      },
      (err: unknown) => {
        if (!mounted.current || seq !== readSeq.current) return
        const message = ipcErrorMessage(err)
        // The plugin deleted the room: nothing here can act on it any more, so the last read goes too.
        if (isRoomGone(message)) {
          setView(null)
          setDoc(null)
          setConfirming(null)
          setGone(true)
          setLoadError(null)
          return
        }
        setLoadError(message)
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

  const byData = (attr: string, value: string) => (root: HTMLElement): HTMLElement | null =>
    [...root.querySelectorAll<HTMLElement>(`[${attr}]`)].find((el) => el.getAttribute(attr) === value) ?? null
  const toRemoveButton = (name: string): void => {
    focusNext.current = byData('data-remove-for', name)
  }
  const toDocLink = (path: string): void => {
    focusNext.current = byData('data-doc-path', path)
  }
  const backFromDoc = (path: string): void => {
    toDocLink(path)
    setDoc(null)
  }

  // Esc steps back out of what is open inside first (the remove question, then the doc viewer), then closes. Heard on
  // the document, not the dialog: a button that went away with its row (Remove) leaves the focus on <body>, where a
  // keydown on the dialog would never fire. Not for an Esc an approval took (the window's ApprovalDialog, portalled
  // over this one, answers Cancel with it).
  const escape = useRef<() => void>(onClose)
  useEffect(() => {
    escape.current = () => {
      if (confirming !== null) {
        toRemoveButton(confirming)
        setConfirming(null)
      } else if (doc !== null) backFromDoc(doc.path)
      else onClose()
    }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (e.target instanceof Element && e.target.closest('[role="alertdialog"]')) return
      // An approval is up over this dialog (a server browser's remove ask takes no focus, so the focus is still here):
      // an Esc is meant for it, which answers only from a click or its own focus. It must not also close this one.
      if (approvalStack.size > 0 || document.querySelector('[role="alertdialog"]')) return
      e.preventDefault()
      escape.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const openDoc = (path: string, fromList = false): void => {
    if (fromList) focusNext.current = (root) => root.querySelector<HTMLElement>('[data-doc-back]')
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
    // The question and the clicked button are about to go: the dialog's Close is the one steady stop.
    focusNext.current = () => closeButton.current
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
        ref={dialogRef}
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
        {gone && <p className="room-dialog-note">{ROOM_GONE_TEXT}</p>}
        {!view && !loadError && !gone && <p className="room-dialog-note">Loading…</p>}
        {view && doc && (
          <section className="room-dialog-doc" aria-label={`Doc ${doc.path}`}>
            <div className="room-dialog-doc-head">
              <code className="room-dialog-path">{doc.path}</code>
              <button type="button" disabled={doc.loading} onClick={() => openDoc(doc.path)}>
                Reload
              </button>
              <button type="button" data-doc-back="" onClick={() => backFromDoc(doc.path)}>
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
                      <span className={`room-dialog-status room-dialog-status-${m.status}`}>{m.statusText}</span>
                      {m.heldText && <span className="room-dialog-held">{m.heldText}</span>}
                      {controls?.canRemove &&
                        (confirming === m.name ? (
                          <RemoveQuestion
                            name={m.name}
                            onCancel={() => {
                              toRemoveButton(m.name)
                              setConfirming(null)
                            }}
                            onRemove={() => remove(m.name)}
                          />
                        ) : (
                          <button
                            type="button"
                            className="room-dialog-remove"
                            data-remove-for={m.name}
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
                      <button
                        type="button"
                        className="room-dialog-doc-link"
                        data-doc-path={d.path}
                        onClick={() => openDoc(d.path, true)}
                      >
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

/**
 * The desktop's own question after Remove (main asks nothing for the desktop, so this is its only guard). It is
 * built so a double click on Remove cannot answer it: Cancel sits where the row's Remove was (the right edge), the
 * question's Remove comes first, looks like a danger button, and takes no click for about a second after the question
 * appears (ApprovalArm, as the approval dialogs; a press that began before arming does not count either). Cancel gets
 * the focus.
 */
function RemoveQuestion(props: { name: string; onCancel: () => void; onRemove: () => void }): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const cancel = useRef<HTMLButtonElement>(null)
  // How the last press began: armed or not (undefined: no press seen).
  const pressArmed = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const arm = new ApprovalArm(setArmed)
    arm.visible(true)
    cancel.current?.focus()
    return () => arm.dispose()
  }, [])
  return (
    <span
      className="room-dialog-confirm"
      role="group"
      aria-label={`Remove ${props.name}?`}
      onPointerDownCapture={() => {
        pressArmed.current = armed
      }}
    >
      Remove {props.name}? Their tab stays open.
      <button
        type="button"
        className="confirm-danger"
        disabled={!armed}
        onClick={() => {
          if (allowClickCounts(armed, pressArmed.current)) props.onRemove()
        }}
      >
        Remove
      </button>
      <button type="button" ref={cancel} onClick={props.onCancel}>
        Cancel
      </button>
    </span>
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
