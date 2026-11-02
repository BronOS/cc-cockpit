import { useId, useState } from 'react'
import type { ProjectPanelView, ProjectPluginView, ProjectSettingsView } from '../../shared/ipc'
import { ZONE_IDS, type ZoneId } from '../../shared/layout'
import { BlocksIcon, PanelIcon } from './icons'
import { PluginSettingsForm } from './PluginSettingsForm'
import { ProjectColorSettings } from './ProjectColorSettings'
import { TabCommandsEditor } from './TabCommandsEditor'
import { Empty, Group, PageHeader, Select, Switch } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

const loadProject = (): Promise<ProjectSettingsView> => window.cockpit.invoke('settings.project')

const ZONE_LABEL: Record<ZoneId, string> = { left: 'Left', right: 'Right', bottom: 'Bottom' }

/**
 * Settings › This project (design §6): the project's colour, the plugins this project runs, their project-level
 * settings (a form rendered from the manifest's schema) and the zone of each panel, and the
 * project's own entries of the new-tab menu. Every call acts on this window's own project; main
 * decides which (nothing here names a project) and validates again.
 */
export function ProjectPage(): React.JSX.Element {
  const { data, error: loadError, reload } = useLoaded(loadProject)
  const { busy, error, run, setError } = useAction()

  return (
    <section aria-label="This project">
      <PageHeader
        title="This project"
        description={
          data ? (
            <>
              Settings of <strong>{data.name}</strong>, for its windows only.
            </>
          ) : (
            'Settings of this window’s project, for its windows only.'
          )
        }
      />
      {(error ?? loadError) && <p role="alert" className="settings-alert">{error ?? loadError}</p>}
      {data && (
        <>
          <ProjectColorSettings value={data.color} busy={busy} run={run} setError={setError} reload={reload} />
          <Group title="Plugins" description="Which installed plugins run here, and their settings for this project.">
            {data.plugins.length === 0 ? (
              <div className="settings-card">
                <Empty>No plugins installed. Install one under Plugins.</Empty>
              </div>
            ) : (
              <ul className="settings-card settings-list">
                {data.plugins.map((plugin) => (
                  <ProjectPlugin key={plugin.id} plugin={plugin} busy={busy} run={run} reload={reload} />
                ))}
              </ul>
            )}
          </Group>
          <Group title="Panels" description="The side of the window each plugin panel docks to.">
            <PanelZones panels={data.panels} busy={busy} run={run} reload={reload} />
          </Group>
          <Group
            title="Commands in the new-tab menu"
            description="Listed after the app-wide commands, in this project's windows only. Each runs in your login shell in the project folder."
          >
            <TabCommandsEditor
              level="project"
              name="Project commands"
              entries={data.tabCommands}
              busy={busy}
              run={run}
              reload={reload}
            />
          </Group>
        </>
      )}
    </section>
  )
}

function ProjectPlugin(props: {
  plugin: ProjectPluginView
  busy: string | null
  run: ReturnType<typeof useAction>['run']
  reload: () => void
}): React.JSX.Element {
  const { plugin, busy, run, reload } = props
  const [showSettings, setShowSettings] = useState(false)
  const id = useId()
  // A plugin that cannot run can still be switched off (a stale entry), never on.
  const canToggle = busy === null && (plugin.state.ok || plugin.enabled)

  return (
    <li className="settings-item column" data-plugin={plugin.id}>
      <div className="settings-item-head">
        <BlocksIcon className="settings-item-glyph" />
        <div className="settings-item-main">
          <div className="settings-item-title">
            <label htmlFor={`${id}-enable`}>{plugin.name}</label>
          </div>
          <div className="settings-item-meta">
            <span className="mono">{plugin.id}</span> · {plugin.version}
            {busy === `enable ${plugin.id}` && <> · Restarting the plugin host…</>}
          </div>
          {!plugin.state.ok && (
            <div role="alert" className="settings-error">
              <span className="settings-badge warn">disabled</span> {plugin.state.reason}
            </div>
          )}
          {plugin.problem !== undefined && (
            <div role="alert" className="settings-error">Not running: {plugin.problem}</div>
          )}
        </div>
        <div className="settings-item-actions">
          {plugin.enabled && plugin.projectSettings && (
            <button type="button" aria-expanded={showSettings} onClick={() => setShowSettings((s) => !s)}>
              Settings
            </button>
          )}
          <Switch
            id={`${id}-enable`}
            checked={plugin.enabled}
            disabled={!canToggle}
            aria-label={`Enable ${plugin.name}`}
            onChange={(e) => {
              const enabled = e.target.checked
              void run(`enable ${plugin.id}`, () =>
                window.cockpit.invoke('settings.projectPluginEnable', { pluginId: plugin.id, enabled })
              ).then(reload)
            }}
          />
        </div>
      </div>
      {plugin.enabled && plugin.projectSettings && showSettings && (
        <PluginSettingsForm
          schema={plugin.projectSettings.schema}
          values={plugin.projectSettings.values}
          {...(plugin.projectSettings.problem !== undefined ? { problem: plugin.projectSettings.problem } : {})}
          {...(plugin.projectSettings.secretFields !== undefined ? { secretFields: plugin.projectSettings.secretFields } : {})}
          save={(values, secrets) => window.cockpit.invoke('settings.projectPluginSettingsSave', { pluginId: plugin.id, values, secrets })}
          onSaved={reload}
        />
      )}
    </li>
  )
}

function PanelZones(props: {
  panels: ProjectPanelView[]
  busy: string | null
  run: ReturnType<typeof useAction>['run']
  reload: () => void
}): React.JSX.Element {
  const { panels, busy, run, reload } = props
  if (panels.length === 0) {
    return (
      <div className="settings-card">
        <Empty>No panels. The panels of the plugins enabled here are listed once they run.</Empty>
      </div>
    )
  }
  return (
    <ul className="settings-card settings-list">
      {panels.map((panel) => (
        <li className="settings-item" key={panel.panelKey} data-panel={panel.panelKey}>
          <PanelIcon className="settings-item-glyph" />
          <div className="settings-item-main">
            <div className="settings-item-title">{panel.title}</div>
            <div className="settings-item-meta mono">{panel.panelKey}</div>
          </div>
          <div className="settings-item-actions">
            <Select
              aria-label={`Zone of ${panel.title}`}
              value={panel.zone}
              disabled={busy !== null}
              onChange={(e) => {
                const zone = e.target.value
                void run(`move ${panel.panelKey}`, () =>
                  window.cockpit.invoke('settings.projectPanelMove', { panelKey: panel.panelKey, zone: zone as ZoneId })
                ).then(reload)
              }}
            >
              {/* Hidden is where the strip's "..." menu keeps a panel; moving it to a zone brings it back. */}
              {panel.zone === 'hidden' && (
                <option value="hidden" disabled>
                  Hidden
                </option>
              )}
              {ZONE_IDS.map((zone) => (
                <option key={zone} value={zone}>
                  {ZONE_LABEL[zone]}
                </option>
              ))}
            </Select>
          </div>
        </li>
      ))}
    </ul>
  )
}
