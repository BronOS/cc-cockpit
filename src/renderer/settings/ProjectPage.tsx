import { useId, useState } from 'react'
import type { ProjectPanelView, ProjectPluginView, ProjectSettingsView } from '../../shared/ipc'
import { ZONE_IDS, type ZoneId } from '../../shared/layout'
import { BUILTIN_VIEWER, OPEN_FILE_PICK, type PluginServicesView } from '../../shared/services'
import { SLOT_NONE, slotPickKey } from '../../shared/slots'
import { BlocksIcon, PanelIcon } from './icons'
import { PluginSettingsForm } from './PluginSettingsForm'
import { PluginSettingsPage } from './PluginSettingsPage'
import { ProjectColorSettings } from './ProjectColorSettings'
import { TabCommandsEditor } from './TabCommandsEditor'
import { Empty, Group, PageHeader, Row, Select, Switch } from './ui'
import { useAction } from './use-action'
import { useLoaded } from './use-loaded'

const loadProject = (): Promise<ProjectSettingsView> => window.cockpit.invoke('settings.project')

// Services are this project's: main answers for the window's project and only over the plugins its
// host runs. A failure must not break the rest of the page: the picks just do not show.
const loadServices = (): Promise<PluginServicesView | null> => window.cockpit.invoke('settings.pluginServices').catch(() => null)

const ZONE_LABEL: Record<ZoneId, string> = { left: 'Left', right: 'Right', bottom: 'Bottom' }

/**
 * Settings › This Project (design-next §5.1): the project's colour, the plugins this project runs and
 * their project-level settings (a form rendered from the manifest's schema, or the plugin's html
 * page), the project's own entries of the new-tab menu, the zone of each panel, and the slot and
 * service picks. Every call acts on this window's own project; main decides which (nothing here
 * names a project) and validates again.
 */
export function ProjectPage(): React.JSX.Element {
  const project = useLoaded(loadProject)
  const services = useLoaded(loadServices)
  const { data, error: loadError } = project
  // A plugin switched on or off changes the candidates of every pick, and a pick changes nothing
  // else here but is cheap to re-read: both reload together.
  const reload = (): void => {
    project.reload()
    services.reload()
  }
  const { busy, error, run, setError } = useAction()

  return (
    <section aria-label="This Project">
      <PageHeader
        title="This Project"
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
          <Group title="Panels" description="The side of the window each plugin panel docks to.">
            <PanelZones panels={data.panels} busy={busy} run={run} reload={reload} />
          </Group>
          <ServicePicks
            services={services.data}
            nameOf={(id) => data.plugins.find((p) => p.id === id)?.name ?? id}
            busy={busy}
            run={run}
            reload={reload}
          />
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
  // A plugin that cannot run can still be switched off (a stale entry), never on. A bundled plugin
  // off in all projects (Settings > Plugins) cannot be turned on here either: main refuses it.
  const offAll = plugin.offInAllProjects === true
  const canToggle = busy === null && !offAll && (plugin.state.ok || plugin.enabled)

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
          {offAll && (
            <div className="settings-item-meta" data-testid="off-in-all-projects">
              Off in all projects. Turn that off under Plugins to use this switch.
            </div>
          )}
          {plugin.problem !== undefined && (
            <div role="alert" className="settings-error">Not running: {plugin.problem}</div>
          )}
        </div>
        <div className="settings-item-actions">
          {((plugin.enabled && plugin.projectSettings) || plugin.settingsPage) && (
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
      {/* The plugin's html page for the project scope (design-next §5.4); off here, it says to enable the plugin. */}
      {plugin.settingsPage && showSettings && <PluginSettingsPage pluginId={plugin.id} pluginName={plugin.name} scope="project" />}
    </li>
  )
}

/**
 * The project's picks (design-next §5.1: on This Project, not Plugins, since each is the project's
 * own choice): a service two enabled plugins provide, the plugin that opens files, and the plugin
 * that draws each slot type. All are kept in the project record's `serviceProviders` (the open-file
 * pick under `@open-file`, a slot under `@slot:<type>`); main checks the pick again.
 */
function ServicePicks(props: {
  services: PluginServicesView | null
  nameOf: (id: string) => string
  busy: string | null
  run: ReturnType<typeof useAction>['run']
  reload: () => void
}): React.JSX.Element | null {
  const { services, nameOf, busy, run, reload } = props
  // A service only collectors read (`useAll`) has no pick: every provider is read.
  const shared = (services?.services ?? []).filter((s) => s.candidates.length >= 2 && !s.collectedOnly)
  // The open-file pick: shown as soon as one plugin offers to open files, since the built-in viewer
  // is always the other choice.
  const openFile = services?.openFile
  const showOpenFile = openFile !== undefined && openFile.candidates.length > 0
  // Slot picks (design-next §2), under `@slot:<type>`: a row as soon as one plugin draws the type,
  // since "None" (turn it off for the project) is always the other choice.
  const slots = (services?.slots ?? []).filter((sl) => sl.candidates.length > 0)
  if (shared.length === 0 && !showOpenFile && slots.length === 0) return null
  const pickProvider = (service: string, pluginId: string | null): void => {
    void run('provider', () => window.cockpit.invoke('settings.pluginServiceProvider', { service, pluginId })).then(reload)
  }
  return (
    <Group title="Services" description="Where this project has a choice of plugin, the one picked answers.">
      <div className="settings-card" data-testid="service-picks">
        {showOpenFile && (
          <Row label="Plugin used to open files" help="A click on a changed file in the Sessions panel." htmlFor="open-file-pick">
            <Select
              id="open-file-pick"
              wide
              disabled={busy !== null}
              value={openFile.selected ?? ''}
              onChange={(e) => pickProvider(OPEN_FILE_PICK, e.target.value === '' ? null : e.target.value)}
            >
              {openFile.selected === null && <option value="">Pick one (built-in viewer until then)</option>}
              {openFile.candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.title} (${nameOf(c.id)})`}
                </option>
              ))}
              <option value={BUILTIN_VIEWER}>Built-in viewer</option>
            </Select>
          </Row>
        )}
        {shared.map((svc) => (
          <Row key={svc.service} label={`Plugin used for ${svc.service}`} htmlFor={`service-pick-${svc.service}`}>
            <Select
              id={`service-pick-${svc.service}`}
              wide
              disabled={busy !== null}
              value={svc.selected ?? ''}
              onChange={(e) => pickProvider(svc.service, e.target.value === '' ? null : e.target.value)}
            >
              {svc.selected === null && <option value="">Pick one</option>}
              {svc.candidates.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
            </Select>
          </Row>
        ))}
        {slots.map((sl) => (
          <Row
            key={sl.type}
            label={`Plugin drawing the ${sl.type} slot`}
            help={
              sl.selected === null
                ? 'Several plugins draw this slot: nothing is drawn until one is picked.'
                : 'Where a panel (or the app) places this slot, the plugin picked draws it.'
            }
            htmlFor={`slot-pick-${sl.type}`}
          >
            <Select
              id={`slot-pick-${sl.type}`}
              wide
              disabled={busy !== null}
              value={sl.selected ?? ''}
              onChange={(e) => pickProvider(slotPickKey(sl.type), e.target.value === '' ? null : e.target.value)}
            >
              {sl.selected === null && <option value="">Pick one (nothing drawn until then)</option>}
              {sl.candidates.map((id) => (
                <option key={id} value={id}>
                  {nameOf(id)}
                </option>
              ))}
              <option value={SLOT_NONE}>None</option>
            </Select>
          </Row>
        ))}
      </div>
    </Group>
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
