// The desktop picker's Servers section (design-remote-desktop.md §3): each saved remote server with
// its `via` label, connection state and notes, its recent remote projects as picker rows with a
// server badge, and a menu (Open server's picker, Rename, Forget). Everything goes to main through
// the picker-only `remote.*` channels; main decides, and the picker closes when a window opens.
//
// Every string here that came from a server or the person's ssh (a project name, an error, the
// server's name as the person typed it) is rendered as React text, never markup.
import { useEffect, useRef, useState } from 'react'
import type { RemoteServerInfo } from '../../shared/ipc'
import { ipcErrorMessage } from '../ipc-error'
import { ServerGlyph } from './icons'
import { PickerEmpty, PickerSection, ProjectRow } from './parts'
import { groupServers, openedAgo, type ServerGroup } from './picker-model'

export function ServersSection(props: {
  /** null until the first `remote.list` answer. */
  servers: RemoteServerInfo[] | null
  /** When the list was read: the rows' "3 days ago" are as of then. */
  loadedAt: number
  onConnect(): void
  /** Something changed that `remote.changed` may not cover (a refused call): read the list again. */
  reload(): void
}): React.JSX.Element {
  const groups = props.servers === null ? null : groupServers(props.servers)
  return (
    <PickerSection
      id="picker-servers-title"
      title="Servers"
      className="picker-servers"
      action={
        <button type="button" className="picker-quiet" onClick={props.onConnect}>
          Connect to server…
        </button>
      }
    >
      {groups === null ? null : groups.length === 0 ? (
        <PickerEmpty>No servers yet. Connect to a cc-cockpit running in server mode on another machine.</PickerEmpty>
      ) : (
        <ul className="picker-list" aria-label="Servers">
          {groups.map((g, i) => (
            <ServerItem key={g.server.id} group={g} index={i} loadedAt={props.loadedAt} reload={props.reload} />
          ))}
        </ul>
      )}
    </PickerSection>
  )
}

type Mode = 'idle' | 'rename' | 'forget'

function ServerItem(props: { group: ServerGroup; index: number; loadedAt: number; reload(): void }): React.JSX.Element {
  const { server, via, state, notes, projects } = props.group
  const id = `picker-server-${props.index}`
  const [mode, setMode] = useState<Mode>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The ⋯ button, by id: the focus goes back to it after Rename or a cancelled Forget.
  const menuId = `${id}-menu`
  const focusMenu = (): void => document.getElementById(menuId)?.focus()

  /** remote.open: the server's own picker, or one of its projects. On success main closes this picker. */
  const open = (projectId?: string): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    window.cockpit
      .invoke('remote.open', projectId === undefined ? { serverId: server.id } : { serverId: server.id, projectId })
      .then((answer) => {
        if (!answer.ok) setError(answer.error)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => setBusy(false))
  }

  const forget = (): void => {
    setBusy(true)
    setError(null)
    window.cockpit
      .invoke('remote.forget', { serverId: server.id })
      .then(() => setMode('idle'))
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => {
        setBusy(false)
        props.reload()
      })
  }

  const stateId = `${id}-state`
  return (
    <li className="picker-server" aria-labelledby={`${id}-name`}>
      <div className="picker-row picker-server-row">
        {mode === 'rename' ? (
          <RenameForm
            server={server}
            onDone={() => {
              setMode('idle')
              focusMenu()
            }}
          />
        ) : (
          <button
            type="button"
            id={id}
            className="picker-open"
            disabled={busy}
            aria-labelledby={`${id}-name`}
            aria-describedby={`${id}-via ${stateId}`}
            title={`Open ${server.name}'s picker`}
            onClick={() => open()}
          >
            <ServerGlyph />
            <span className="picker-row-text">
              <span className="picker-row-line">
                <span className="picker-row-name" id={`${id}-name`}>
                  {server.name}
                </span>
                {notes.map((note) => (
                  <span key={note} className="picker-badge picker-server-note">
                    {note}
                  </span>
                ))}
              </span>
              <span className="picker-row-path">
                <span id={`${id}-via`}>{via}</span>
                <span id={stateId} className={state ? `picker-server-state ${state.tone}` : 'picker-server-state'} title={state?.text}>
                  {state ? ` · ${state.text}` : ''}
                </span>
              </span>
            </span>
          </button>
        )}
        {mode !== 'rename' && (
          <span className="picker-row-actions">
            <ServerMenu
              id={menuId}
              name={server.name}
              disabled={busy}
              onOpenPicker={() => open()}
              onRename={() => {
                setError(null)
                setMode('rename')
              }}
              onForget={() => {
                setError(null)
                setMode('forget')
              }}
            />
          </span>
        )}
      </div>
      {mode === 'forget' && (
        <ForgetConfirm
          name={server.name}
          busy={busy}
          onConfirm={forget}
          onCancel={() => {
            setMode('idle')
            focusMenu()
          }}
        />
      )}
      {error !== null && (
        <p role="alert" className="picker-server-error">
          {error}
        </p>
      )}
      {projects.length > 0 && (
        <ul className="picker-server-projects" aria-label={`Recent projects on ${server.name}`}>
          {projects.map((p, i) => (
            <ProjectRow
              key={p.projectId}
              rowId={`${id}-project-${i}`}
              name={p.name}
              path={via}
              title={`${p.name} on ${server.name}`}
              missing={false}
              highlighted={false}
              disabled={busy}
              badge={server.name}
              meta={openedAgo(p.at, props.loadedAt)}
              onOpen={() => open(p.projectId)}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The server's ⋯ menu: Open server's picker, Rename…, Forget…. Drawn `position: fixed` from the
 * button's box (the panel scrolls and clips), above it when the window has no room below (the
 * Servers section sits at the bottom). Keyboard: opens with its first item focused, ↑/↓ move, Esc
 * closes back to the button (and is kept from the modal picker's own Esc), Tab or a click outside
 * closes.
 */
function ServerMenu(props: {
  id: string
  name: string
  disabled: boolean
  onOpenPicker(): void
  onRename(): void
  onForget(): void
}): React.JSX.Element {
  const [pos, setPos] = useState<React.CSSProperties | null>(null)
  const root = useRef<HTMLSpanElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const open = pos !== null

  useEffect(() => {
    if (!open) return
    list.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const dismiss = (e: MouseEvent): void => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return
      setPos(null)
    }
    // The window losing the focus (another app, a remote window opening) closes it too.
    const blur = (): void => setPos(null)
    window.addEventListener('mousedown', dismiss, true)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('blur', blur)
    }
  }, [open])

  const close = (refocus: boolean): void => {
    setPos(null)
    if (refocus) button.current?.focus()
  }
  const pick = (action: () => void): void => {
    close(false)
    action()
  }
  const onKey = (e: React.KeyboardEvent<HTMLUListElement>): void => {
    const items = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)
      items[next]?.focus()
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  return (
    <span className="picker-server-menu" ref={root}>
      <button
        type="button"
        id={props.id}
        ref={button}
        className="picker-quiet picker-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for ${props.name}`}
        disabled={props.disabled}
        onClick={(e) => {
          if (open) {
            setPos(null)
            return
          }
          const rect = e.currentTarget.getBoundingClientRect()
          const right = window.innerWidth - rect.right
          // About three items' height: below when it fits, else above the button.
          setPos(
            rect.bottom + 120 <= window.innerHeight ? { right, top: rect.bottom + 4 } : { right, bottom: window.innerHeight - rect.top + 4 }
          )
        }}
      >
        ⋯
      </button>
      {pos && (
        <ul ref={list} className="menu picker-menu" role="menu" aria-label={`${props.name} menu`} style={pos} onKeyDown={onKey}>
          <li role="none">
            <button type="button" role="menuitem" onClick={() => pick(props.onOpenPicker)}>
              Open server’s picker
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" onClick={() => pick(props.onRename)}>
              Rename…
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" onClick={() => pick(props.onForget)}>
              Forget…
            </button>
          </li>
        </ul>
      )}
    </span>
  )
}

/** Rename in place: the name field takes the row; Enter saves, Esc cancels, main's refusal shows under it. */
function RenameForm(props: { server: RemoteServerInfo; onDone(): void }): React.JSX.Element {
  const [name, setName] = useState(props.server.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorId = `picker-rename-${props.server.id}-error`
  const save = (): void => {
    const next = name.trim()
    if (next === props.server.name) {
      props.onDone()
      return
    }
    setBusy(true)
    setError(null)
    window.cockpit
      .invoke('remote.rename', { serverId: props.server.id, name: next })
      .then((answer) => {
        if (answer.ok) props.onDone()
        else setError(answer.error)
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => setBusy(false))
  }
  return (
    <form
      className="picker-rename"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <ServerGlyph />
      <span className="picker-rename-field">
        <input
          type="text"
          aria-label={`New name for ${props.server.name}`}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          autoFocus
          spellCheck={false}
          maxLength={100}
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Kept from the modal picker's own Esc (it would close the picker).
              e.preventDefault()
              props.onDone()
            }
          }}
        />
        {error !== null && (
          <span role="alert" id={errorId} className="picker-server-error">
            {error}
          </span>
        )}
      </span>
      <span className="picker-row-actions">
        <button type="submit" className="picker-quiet" disabled={busy || name.trim() === ''}>
          Save
        </button>
        <button type="button" className="picker-quiet" onClick={props.onDone}>
          Cancel
        </button>
      </span>
    </form>
  )
}

/**
 * Forget's confirm, in the server's row: it drops the entry, its cookie and its window data here,
 * and says what it does not do (design §3). Cancel takes the focus, so an Enter does not forget.
 */
function ForgetConfirm(props: { name: string; busy: boolean; onConfirm(): void; onCancel(): void }): React.JSX.Element {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <div
      className="picker-server-confirm"
      role="group"
      aria-label={`Forget ${props.name}?`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          props.onCancel()
        }
      }}
    >
      <p className="picker-confirm-text">
        Forget {props.name}? Its windows close and this app forgets how to reach it. This machine stays in the server’s device list until
        you revoke it there.
      </p>
      <span className="picker-row-actions">
        <button type="button" className="picker-quiet picker-danger" disabled={props.busy} onClick={props.onConfirm}>
          Forget
        </button>
        <button type="button" className="picker-quiet" ref={cancel} onClick={props.onCancel}>
          Cancel
        </button>
      </span>
    </div>
  )
}
