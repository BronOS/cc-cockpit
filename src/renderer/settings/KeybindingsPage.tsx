import { useEffect, useRef, useState } from 'react'
import type { AppearanceView, KeyBindingRow } from '../../shared/ipc'
import { chordFromEvent } from '../../shared/keys'
import { captureKeys, displayChord, fuzzyFilter } from '../commands/keybindings'
import { SearchIcon } from './icons'
import { Empty, Group, PageHeader } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

// The key table travels in the appearance view (main/settings/appearance-service.ts): one query
// answers General, Appearance and this page, so main has no second handler to keep in step.
const loadKeys = (): Promise<AppearanceView> => window.cockpit.invoke('settings.appearance')

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

/**
 * Settings › Keybindings (design-next §5.1): the list of core, plugin and new-tab-entry commands with
 * their keys, a filter, overrides, conflicts, Unbind and Reset. A key is changed by pressing the new
 * chord in a field that records it; main validates the chord, stores it, and sends the new table to
 * the windows. A chord that two commands claim is allowed and shown as a conflict with the one that
 * does not get it.
 */
export function KeybindingsPage(): React.JSX.Element {
  const { data, error: loadError, reload } = useLoaded(loadKeys)
  const { busy, error, run } = useAction()
  const [filter, setFilter] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  // The list follows the window's key table: a new-tab menu entry added, renamed or removed (on
  // General, This Project, or in another window) and a plugin command coming or going all change
  // it, and main sends the new table as `commands.updated`.
  useEffect(() => window.cockpit.on('commands.updated', reload), [reload])

  const rows = data ? fuzzyFilter(data.keys, filter) : []
  const conflicts = data ? data.keys.filter((k) => k.conflictsWith.length > 0) : []

  return (
    <section aria-label="Keybindings">
      <PageHeader
        title="Keybindings"
        description="App-wide: the keyboard shortcuts of every window. Press Change on a command, then the new keys. Hover a row for its actions."
      />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      {data && (
        <Group title="Commands">
          {conflicts.length > 0 && (
            <p role="alert" className="settings-alert warn">
              {conflicts.length === 1 ? '1 command shares' : `${conflicts.length} commands share`} a key with another. A
              chord that your own override and a default both claim goes to your override; otherwise it fires
              neither.
            </p>
          )}
          <div className="settings-card">
            <label className="settings-search">
              <SearchIcon size={14} />
              <input
                type="text"
                aria-label="Filter commands"
                placeholder="Filter commands"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                spellCheck={false}
              />
            </label>
            {rows.length === 0 ? (
              <Empty>No command matches.</Empty>
            ) : (
              <ul className="settings-list" aria-label="Keybindings">
                {rows.map((row) => (
                  <KeyRow
                    key={row.id}
                    row={row}
                    busy={busy}
                    recording={recording === row.id}
                    setRecording={(on) => setRecording(on ? row.id : null)}
                    run={run}
                    reload={reload}
                  />
                ))}
              </ul>
            )}
          </div>
        </Group>
      )}
    </section>
  )
}

function KeyRow(props: {
  row: KeyBindingRow
  busy: string | null
  recording: boolean
  setRecording: (on: boolean) => void
  run: ReturnType<typeof useAction>['run']
  reload: () => void
}): React.JSX.Element {
  const { row, busy, recording, setRecording, run, reload } = props
  const input = useRef<HTMLInputElement>(null)
  const change = useRef<HTMLButtonElement>(null)
  // Set when recording ends from the keyboard (a chord, or Esc): the field that held the focus is
  // unmounted, and the focus would fall to body, outside the settings root, where Esc reaches
  // nothing. Not set by a blur: the user clicked elsewhere and that keeps the focus.
  const refocus = useRef(false)

  // While recording, no bound chord may fire its command (the chord pressed is probably one).
  useEffect(() => {
    if (!recording) {
      if (refocus.current) {
        refocus.current = false
        // The Change button is disabled while a new chord is saved: then the screen's root.
        const button = change.current
        if (button && !button.disabled) button.focus()
        else button?.closest<HTMLElement>('[role="dialog"]')?.focus()
      }
      return
    }
    input.current?.focus()
    return captureKeys()
  }, [recording])

  const set = (chord: string | null): void => {
    void run(`key ${row.id}`, () => window.cockpit.invoke('settings.keySet', { commandId: row.id, chord })).then(reload)
  }
  const show = (chord: string): string => displayChord(chord, mac())

  return (
    <li className={recording ? 'settings-item key-row recording' : 'settings-item key-row'} data-command={row.id}>
      <div className="settings-item-main">
        <div className="settings-item-title">
          {row.title}
          {row.overridden && <span className="settings-badge accent">custom</span>}
        </div>
        <div className="settings-item-meta mono">{row.id}</div>
        {row.conflictsWith.length > 0 && (
          <div className={row.inactive ? 'settings-error' : 'settings-sub warn'}>
            Also bound to {row.conflictsWith.join(', ')}
            {row.inactive ? ': this one does not fire.' : '.'}
          </div>
        )}
      </div>
      <div className="settings-item-actions">
        {recording ? (
          <input
            ref={input}
            type="text"
            readOnly
            className="settings-key-capture"
            aria-label={`New key for ${row.title}`}
            placeholder="Press the new keys (Esc cancels)"
            onBlur={() => setRecording(false)}
            onKeyDown={(e) => {
              // Everything typed here is the answer, not a shortcut: keep it from the screen's own Esc.
              e.preventDefault()
              e.stopPropagation()
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                refocus.current = true
                setRecording(false)
                return
              }
              const chord = chordFromEvent(e.nativeEvent)
              if (!chord) return // a modifier alone: wait for the key
              refocus.current = true
              setRecording(false)
              set(chord)
            }}
          />
        ) : (
          <>
            {/* Change / Unbind / Reset show on the row's hover or focus (styles.css): forty rows of
                three buttons each would drown the keys themselves. They keep their room, so the
                row does not jump, and a keyboard user tabbing in brings them up. */}
            <span className="key-row-buttons">
              <button ref={change} type="button" className="quiet" disabled={busy !== null} onClick={() => setRecording(true)}>
                Change
              </button>
              <button type="button" className="quiet" disabled={busy !== null || row.key === undefined} onClick={() => set('')}>
                Unbind
              </button>
              {row.overridden && (
                <button
                  type="button"
                  className="quiet"
                  disabled={busy !== null}
                  title={row.defaultKey ? `Default: ${show(row.defaultKey)}` : 'Default: unbound'}
                  onClick={() => set(null)}
                >
                  Reset
                </button>
              )}
            </span>
            <kbd className={row.key ? undefined : 'unbound'} aria-label={`Key of ${row.title}`}>
              {row.key ? show(row.key) : 'unbound'}
            </kbd>
          </>
        )}
      </div>
    </li>
  )
}
