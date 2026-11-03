import { useEffect, useId, useRef, useState } from 'react'
import type { AppearanceView, CccCommandView, KeyBindingRow, UpdateState } from '../../shared/ipc'
import type { TabCloseSide, TabExitBehavior } from '../../shared/types'
import { chordFromEvent } from '../../shared/keys'
import { captureKeys, displayChord, fuzzyFilter } from '../commands/keybindings'
import { SearchIcon } from './icons'
import { TabCommandsEditor } from './TabCommandsEditor'
import { TerminalFontSettings } from './TerminalFontSettings'
import { WindowBackgroundSettings } from './WindowBackgroundSettings'
import { Empty, Group, PageHeader, Row, Select, Switch } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

const loadAppearance = (): Promise<AppearanceView> => window.cockpit.invoke('settings.appearance')

const loadCcc = (): Promise<CccCommandView> => window.cockpit.invoke('settings.cccStatus')

const loadUpdates = (): Promise<UpdateState> => window.cockpit.invoke('updates.state')

const mac = (): boolean => navigator.platform.toLowerCase().includes('mac')

/**
 * Settings › Appearance and keys (design §6): the app-wide theme, the see-through window background
 * (WindowBackgroundSettings), what a tab does when its process
 * exits, whether a project that opens empty gets a Claude tab, whether Haiku writes a gist of each
 * Claude session, whether closing a running tab asks first, which end of a tab its close button sits at, the app-wide entries of the new-tab menu, the
 * terminals' font (TerminalFontSettings), and the keybinding list with overrides. A theme change goes through main, which tells every window (and so every plugin
 * panel and terminal). A key is changed by pressing the new chord in a field that records it; main
 * validates the chord, stores it, and sends the new table to the windows. A chord that two
 * commands claim is allowed and shown as a conflict with the one that does not get it.
 */
export function AppearancePage(): React.JSX.Element {
  const { data, error: loadError, reload } = useLoaded(loadAppearance)
  const { busy, error, run, setError } = useAction()
  const ccc = useLoaded(loadCcc)
  const updates = useLoaded(loadUpdates)
  // A toggle flipped in another window arrives as an event; re-read instead of showing it stale.
  const reloadUpdates = updates.reload
  useEffect(() => window.cockpit.on('updates.changed', () => void reloadUpdates()), [reloadUpdates])
  const [filter, setFilter] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const id = useId()
  // The keybinding list follows the window's key table: a new-tab menu entry added, renamed or
  // removed (here, on This project, or in another window) and a plugin command coming or going
  // all change it, and main sends the new table as `commands.updated`.
  useEffect(() => window.cockpit.on('commands.updated', reload), [reload])

  const rows = data ? fuzzyFilter(data.keys, filter) : []
  const conflicts = data ? data.keys.filter((k) => k.conflictsWith.length > 0) : []

  return (
    <section aria-label="Appearance and keys">
      <PageHeader
        title="Appearance and keys"
        description="App-wide: the theme, the window background, how tabs behave, the terminal font and the keyboard shortcuts of every window."
      />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      {data && (
        <>
          <Group title="Theme">
            <div className="settings-card">
              <Row
                label="Theme"
                htmlFor={`${id}-theme`}
                help={`Showing ${data.themes.find((t) => t.id === data.current)?.name ?? data.current}.`}
              >
                <Select
                  id={`${id}-theme`}
                  aria-label="Theme"
                  value={data.selected ?? ''}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const id = e.target.value === '' ? null : e.target.value
                    void run('theme', () => window.cockpit.invoke('settings.themeSet', { id })).then(reload)
                  }}
                >
                  <option value="">Follow the system</option>
                  {/* A pick whose theme is gone (plugin uninstalled; main keeps the id): without its own
                      option the browser shows "Follow the system", and choosing that fires no change. */}
                  {data.selected !== null && !data.themes.some((t) => t.id === data.selected) && (
                    <option value={data.selected}>{data.selected} (not installed)</option>
                  )}
                  {data.themes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.kind})
                    </option>
                  ))}
                </Select>
              </Row>
            </div>
          </Group>

          <WindowBackgroundSettings
            value={data.windowBackground}
            blurSupport={data.blurSupport}
            busy={busy}
            run={run}
            setError={setError}
            reload={reload}
          />

          <Group title="Tabs">
            <div className="settings-card">
              <Row
                label="When a tab's process exits"
                htmlFor={`${id}-exit`}
                help={
                  <>
                    Claude and command tabs close on exit code 0 (<code>/exit</code>, a command that finishes); a
                    failure keeps the tab with Restart and Close. A terminal closes on any exit code, since a shell
                    reports its last command; it stays only if it was killed or ended within a second of starting.
                  </>
                }
              >
                <Select
                  id={`${id}-exit`}
                  aria-label="When a tab's process exits"
                  value={data.tabExit}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.value as TabExitBehavior
                    void run('tabExit', () => window.cockpit.invoke('settings.tabExitSet', { value })).then(reload)
                  }}
                >
                  <option value="close-clean">Close the tab when it ends normally</option>
                  <option value="keep">Keep the tab open</option>
                </Select>
              </Row>
              <Row
                label="Open a Claude tab when a project opens with no tabs"
                htmlFor={`${id}-claude-tab`}
                help="When a project window opens and nothing was restored into it. Closing the last tab later does not open another."
              >
                <Switch
                  id={`${id}-claude-tab`}
                  checked={data.claudeTabOnOpen}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.checked
                    void run('claudeTabOnOpen', () =>
                      window.cockpit.invoke('settings.claudeTabOnOpenSet', { value })
                    ).then(reload)
                  }}
                />
              </Row>
              <Row
                label="Ask before closing a tab that is still running"
                htmlFor={`${id}-confirm-close`}
                help="Applies to the close button, Close Tab (keys or palette) and the tab menu. A tab whose process already ended closes at once."
              >
                <Switch
                  id={`${id}-confirm-close`}
                  checked={data.confirmTabClose}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.checked
                    void run('confirmTabClose', () =>
                      window.cockpit.invoke('settings.confirmTabCloseSet', { value })
                    ).then(reload)
                  }}
                />
              </Row>
              <Row
                label="Close button position"
                htmlFor={`${id}-close-side`}
                help="Which end of each tab the × sits at, in every window."
              >
                <Select
                  id={`${id}-close-side`}
                  aria-label="Close button position"
                  value={data.tabCloseSide}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.value as TabCloseSide
                    void run('tabCloseSide', () => window.cockpit.invoke('settings.tabCloseSideSet', { value })).then(reload)
                  }}
                >
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </Select>
              </Row>
            </div>
          </Group>

          <Group title="Claude sessions">
            <div className="settings-card">
              <Row
                label="Session gist (Haiku)"
                htmlFor={`${id}-session-gist`}
                help="A one-line summary of what each Claude session is about, written by Claude Haiku after a turn ends and shown in the Sessions panel in place of the last prompt. Uses your Claude Code login; each gist is one small Haiku request, at most one a minute per tab."
              >
                <Switch
                  id={`${id}-session-gist`}
                  checked={data.sessionGist}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.checked
                    void run('sessionGist', () => window.cockpit.invoke('settings.sessionGistSet', { value })).then(reload)
                  }}
                />
              </Row>
            </div>
          </Group>

          <Group
            title="Commands in the new-tab menu"
            description={
              <>
                Each entry runs its command line in your login shell (<code>$SHELL -l -i -c</code>, as if typed in a
                terminal) in the project folder, in a new tab named after the label. Listed in every project after
                Claude and Shell; a project adds its own under This project. Tabs restored at launch wait for Restart.
              </>
            }
          >
            <TabCommandsEditor level="app" name="App-wide commands" entries={data.tabCommands} busy={busy} run={run} reload={reload} />
          </Group>

          <TerminalFontSettings font={data.terminalFont} busy={busy} run={run} reload={reload} />

          <Group title="Command line">
            {ccc.error && <p role="alert" className="settings-alert">{ccc.error}</p>}
            {ccc.data && (
              <div className="settings-card">
                <Row
                  data-testid="ccc-command"
                  label={
                    <>
                      The <code>ccc</code> command
                      {ccc.data.state === 'installed' && <span className="settings-badge accent">installed</span>}
                    </>
                  }
                  help={
                    <>
                      Links {ccc.data.linkPath} to the app&apos;s launcher.
                      {ccc.data.state === 'installed' && !ccc.data.onPath && (
                        <span className="warn"> {ccc.data.binDir} is not on your shell&apos;s PATH; add it to use <code>ccc</code> there.</span>
                      )}
                      {ccc.data.state === 'foreign' && (
                        <span className="settings-error"> {ccc.data.linkPath} is already something else; it is left alone.</span>
                      )}
                    </>
                  }
                >
                  <button
                    type="button"
                    disabled={busy !== null || ccc.data.state !== 'missing'}
                    onClick={() => {
                      void run('ccc', () => window.cockpit.invoke('settings.cccInstall')).then(ccc.reload)
                    }}
                  >
                    Install <code>ccc</code> command
                  </button>
                </Row>
                <Row
                  label="Offer to install at start-up"
                  htmlFor={`${id}-ccc-offer`}
                  help={<>Ask once at launch whether to install <code>ccc</code> when it is missing.</>}
                >
                  <Switch
                    id={`${id}-ccc-offer`}
                    checked={ccc.data.offerAtStart}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const value = e.target.checked
                      void run('ccc', () => window.cockpit.invoke('settings.cccOfferSet', { value })).then(ccc.reload)
                    }}
                  />
                </Row>
              </div>
            )}
          </Group>

          {updates.data && (
            <Group title="Updates">
              <div className="settings-card">
                <Row
                  label="Check for new versions"
                  htmlFor={`${id}-updates`}
                  help={`You have cc-cockpit ${updates.data.current}. Once a day the app asks GitHub whether a newer release exists; it never downloads or installs anything.`}
                >
                  <Switch
                    id={`${id}-updates`}
                    checked={updates.data.enabled}
                    disabled={busy !== null}
                    onChange={(e) => {
                      const value = e.target.checked
                      void run('updates', () => window.cockpit.invoke('updates.setEnabled', { value })).then(updates.reload)
                    }}
                  />
                </Row>
              </div>
            </Group>
          )}

          <Group
            title="Keybindings"
            description="Press Change on a command, then the new keys. Hover a row for its actions."
          >
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
        </>
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
