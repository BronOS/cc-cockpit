import { useEffect, useId } from 'react'
import type { AppearanceView, CccCommandView, NotificationSoundGroup, UpdateState } from '../../shared/ipc'
import type { TabExitBehavior } from '../../shared/types'
import { MIN_TERMINAL_WIDTH_RANGE } from '../../shared/zone-auto-hide'
import { loadSoundGroups, SoundOptions, usePlaySound } from './sound-options'
import { TabCommandsEditor } from './TabCommandsEditor'
import { NumberField } from './TerminalFontSettings'
import { Group, PageHeader, Row, Select, Switch } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

// The same view as Appearance and Keybindings (main/settings/appearance-service.ts): one query for
// the app-wide values, so main keeps a single handler.
const loadAppearance = (): Promise<AppearanceView> => window.cockpit.invoke('settings.appearance')

const loadCcc = (): Promise<CccCommandView> => window.cockpit.invoke('settings.cccStatus')

const loadUpdates = (): Promise<UpdateState> => window.cockpit.invoke('updates.state')

/**
 * Settings › General (design-next §5.1): how the app behaves, app-wide. What a tab does when its
 * process exits, whether a project that opens empty gets a Claude tab, whether closing a running tab
 * asks first, whether the side zones give way to a narrow terminal and at what width, whether Haiku
 * writes a gist of each Claude session, whether plugin notifications ring a sound and which
 * (NotificationSoundRow), the app-wide entries of the new-tab menu, the `ccc` command line, and the
 * update notice. How the window looks is Appearance; the keys are Keybindings.
 */
export function GeneralPage(): React.JSX.Element {
  const { data, error: loadError, reload } = useLoaded(loadAppearance)
  const { busy, error, run } = useAction()
  const ccc = useLoaded(loadCcc)
  const updates = useLoaded(loadUpdates)
  const sounds = useLoaded(loadSoundGroups)
  const playSound = usePlaySound()
  // A toggle flipped in another window arrives as an event; re-read instead of showing it stale.
  const reloadUpdates = updates.reload
  useEffect(() => window.cockpit.on('updates.changed', () => void reloadUpdates()), [reloadUpdates])
  const id = useId()

  return (
    <section aria-label="General">
      <PageHeader
        title="General"
        description="App-wide: how tabs behave, notifications, Claude sessions, the new-tab menu, the command line and updates."
      />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      {data && (
        <>
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
            </div>
          </Group>

          <Group title="Side panels">
            <div className="settings-card">
              <Row
                label="Auto-hide side panels when the terminal gets narrow"
                htmlFor={`${id}-zone-auto-hide`}
                help="When the window gets too narrow for the terminal, the right zone's panels hide first, then the left one's, and they come back as the window widens. A click on an icon shows a hidden zone again; a zone you close yourself stays closed."
              >
                <Switch
                  id={`${id}-zone-auto-hide`}
                  checked={data.zoneAutoHide}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.checked
                    void run('zoneAutoHide', () => window.cockpit.invoke('settings.zoneAutoHideSet', { value })).then(reload)
                  }}
                />
              </Row>
              <NumberField
                label="Minimum terminal width"
                help="How wide the terminal stays before a side zone gives way."
                unit="px"
                ariaLabel="Minimum terminal width (px)"
                range={MIN_TERMINAL_WIDTH_RANGE}
                step={1}
                value={data.minTerminalWidth}
                disabled={busy !== null || !data.zoneAutoHide}
                onCommit={(value) => {
                  void run('minTerminalWidth', () => window.cockpit.invoke('settings.minTerminalWidthSet', { value })).then(reload)
                }}
              />
            </div>
          </Group>

          <Group title="Claude sessions">
            <div className="settings-card">
              <Row
                label="Session gist (Haiku)"
                htmlFor={`${id}-session-gist`}
                help="A one-line summary of what each Claude session is about, written by Claude Haiku after a turn ends and shown in place of the last prompt (the Sessions panel of the bundled Sessions plugin, and any plugin that reads it). Uses your Claude Code login; each gist is one small Haiku request, at most one a minute per tab."
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

          <Group title="Notifications">
            <div className="settings-card">
              <Row
                label="Notification sounds"
                htmlFor={`${id}-notification-sounds`}
                help="A short sound from the window (the one picked below, or the one a plugin's own settings pick) when a plugin's notification asks for a sound (a meeting reminder), at most one every 5 seconds. Off: such notifications show without any sound."
              >
                <Switch
                  id={`${id}-notification-sounds`}
                  checked={data.notificationSounds}
                  disabled={busy !== null}
                  onChange={(e) => {
                    const value = e.target.checked
                    void run('notificationSounds', () =>
                      window.cockpit.invoke('settings.notificationSoundsSet', { value })
                    ).then(reload)
                  }}
                />
              </Row>
              <NotificationSoundRow
                id={`${id}-notification-sound`}
                value={data.notificationSound}
                groups={sounds.data}
                disabled={busy !== null || !data.notificationSounds}
                onChange={(value) => {
                  void run('notificationSound', () => window.cockpit.invoke('settings.notificationSoundSet', { value })).then(
                    () => {
                      reload()
                      // A file may have gone since the list was read: show the folders as they are now.
                      sounds.reload()
                    }
                  )
                }}
                onPlay={() => playSound(data.notificationSound)}
              />
            </div>
          </Group>

          <Group
            title="Commands in the new-tab menu"
            description={
              <>
                Each entry runs its command line in your login shell (<code>$SHELL -l -i -c</code>, as if typed in a
                terminal) in the project folder, in a new tab named after the label. Listed in every project after
                Claude and Shell; a project adds its own under This Project. Tabs restored at launch wait for Restart.
              </>
            }
          >
            <TabCommandsEditor level="app" name="App-wide commands" entries={data.tabCommands} busy={busy} run={run} reload={reload} />
          </Group>

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
        </>
      )}
    </section>
  )
}

/**
 * The notification "Sound" dropdown and its Play button: Built-in, then a group per OS sound folder
 * (main lists them; names only; sound-options.tsx, shared with a plugin's `"format": "sound"`
 * field). A picked system sound that is gone keeps its own option, marked missing; it rings the
 * Chime meanwhile.
 */
function NotificationSoundRow(props: {
  id: string
  value: string
  groups: NotificationSoundGroup[] | null
  disabled: boolean
  onChange: (value: string) => void
  onPlay: () => void
}): React.JSX.Element {
  return (
    <Row
      label="Sound"
      htmlFor={props.id}
      help={`The app's sound: what a notification that asks for a sound rings, and the "App default" of a plugin's own sound setting. A built-in tone, or a sound file from the system's sound folders. A file that goes away rings the Chime.`}
    >
      <Select
        id={props.id}
        aria-label="Sound"
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
      >
        <SoundOptions value={props.value} groups={props.groups} />
      </Select>
      <button type="button" className="quiet" disabled={props.disabled} onClick={props.onPlay}>
        <span aria-hidden="true">▶</span> Play
      </button>
    </Row>
  )
}
