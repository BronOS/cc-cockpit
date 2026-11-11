// "This Project" in the settings overlay (design §6): which plugins are enabled for the
// project, the plugins' project-level settings, the zone of each panel, and the project's new-tab
// menu entries (shown here; saved by TabCommandsService, main/tabs/tab-commands.ts). Plain
// TypeScript over injected pieces, like settings-service.ts; the router
// resolves the asking window's project from `event.sender` and passes only that id.
//
// Authority and decisions:
//  - Every method acts on the project main resolved for the sender. A plugin id or panel key in a
//    payload is only looked up in main's own tables (installed plugins, the project's layout);
//    nothing from the payload reaches a path or argv.
//  - Enabling is refused for a plugin whose manifest did not validate (the host would skip it
//    silently). Disabling needs no such check, so a stale entry can always be turned off.
//  - Project settings are validated here against the manifest's `settings.project` schema
//    (validate.ts: no regexes, defaults applied), whatever the renderer's form thought, and a
//    failure stores nothing. The renderer's form has no validator of its own.
//  - The project's colour is checked strictly here (shared/project-color.ts checkProjectColor: a
//    palette name or `#rrggbb`, nothing else) and refused with the reason; reading it back is
//    lenient (the registry repairs a damaged stored value to none).
//  - Secret fields are stored encrypted under `setting:project:<projectId>:<field>` (keyed by the
//    project main resolved, never one from the payload); the renderer only learns whether each is set.
//  - What this page stores are the project's OVERRIDES of the plugin's global values (design-next
//    §5.2, plugin-settings.ts effectiveProjectValues): a save names only the fields it overrides, the
//    schema checks them merged with the global values, and a field left out (or a secret cleared)
//    uses the global value again. The view shows the effective values and which fields are overrides.
import type {
  LayoutView,
  PluginAppSettingsView,
  PluginSettingsSaveResult,
  ProjectPanelView,
  ProjectPluginView,
  ProjectSettingsView,
  SecretValueState
} from '../../shared/ipc'
import { isPlainObject } from '../../shared/guards'
import { checkDiscussPrompt, discussPromptOf } from '../../shared/discuss'
import { checkProjectColor, projectColorOf, type ProjectColor } from '../../shared/project-color'
import { zoneOf } from '../../shared/layout'
import type { ProjectRecord, ProjectView } from '../../shared/types'
import type { InstalledPlugin, PluginInstaller } from '../plugins/installer'
import { offAppWide, pluginEnabledIn } from '../plugins/enablement'
import { tabCommandsOf } from '../tabs/tab-commands'
import { projectDefaultSettingKey, projectSettingKey } from '../secrets/plugin-secrets'
import { effectiveProjectValues, overriddenFields, saveSettingsForm, settingsViewOf, type SecretSettingsStore } from './plugin-settings'

export interface ProjectSettingsDeps {
  projects: {
    get(id: string): ProjectView | undefined
    update(id: string, mutate: (record: ProjectRecord) => void): void
  }
  plugins: Pick<PluginInstaller, 'list' | 'get'>
  /**
   * `app.json` › `disabledBundled` as stored (user-writable, so anything): the bundled plugins off in
   * all projects, which win over this project's switch (enablement.ts).
   */
  disabledBundled(): unknown
  /** The plugin's stored app and project settings against its manifest, as the host checks them. */
  checkSettings(projectId: string, pluginId: string): { ok: true } | { ok: false; reason: string }
  /** The enabled set changed: restart the project's plugin host with it (HostManager.enabledChanged). */
  enabledChanged(projectId: string): Promise<void>
  /** One plugin's project settings changed: push them to it alone (HostManager.settingsChanged). */
  settingsChanged(projectId: string, pluginId: string): Promise<void>
  layouts: {
    view(projectId: string): LayoutView | undefined
    move(projectId: string, panelKey: string, zone: unknown): LayoutView | undefined
  }
  /** Where secret fields are stored (PluginSecrets; it also updates the hosts' decrypted cache). */
  secrets: SecretSettingsStore
  /**
   * `app.json` › `pluginProjectDefaults[pluginId]` as stored (user-writable, so anything): the global
   * values of the plugin's project fields, which every field this project does not override uses.
   */
  projectDefaults(pluginId: string): unknown
  /**
   * The project's colour was stored (changed or not): tell the windows (its own window's title
   * bar, every other window's strip, an open picker). Not awaited; a failed push stores nothing less.
   */
  colorChanged?(projectId: string): void
}

export class ProjectSettingsService {
  constructor(private readonly deps: ProjectSettingsDeps) {}

  view(projectId: string): ProjectSettingsView {
    const project = this.project(projectId)
    const appOff = this.deps.disabledBundled()
    const plugins = this.deps.plugins.list().map((p) => this.pluginView(project, p, pluginEnabledIn(project, p, appOff), offAppWide(p, appOff)))
    const layout = this.deps.layouts.view(projectId)
    const panels: ProjectPanelView[] = (layout?.panels ?? []).map((info) => ({
      panelKey: info.panelKey,
      title: info.title,
      zone: layout ? (zoneOf(layout.layout, info.panelKey) ?? 'hidden') : 'hidden'
    }))
    const view: ProjectSettingsView = { name: project.name, plugins, panels, tabCommands: tabCommandsOf(project.tabCommands) }
    const color = projectColorOf(project.color)
    if (color !== undefined) view.color = color
    const discussPrompt = discussPromptOf(project.discussPrompt)
    if (discussPrompt !== undefined) view.discussPrompt = discussPrompt
    return view
  }

  /**
   * Set the project's colour, or clear it with null. A value that is not a palette name or a
   * `#rrggbb` throws and stores nothing; a hex is stored in lower case. Returns what is stored.
   */
  setColor(projectId: string, value: unknown): ProjectColor | null {
    this.project(projectId)
    const color = checkProjectColor(value)
    this.deps.projects.update(projectId, (r) => {
      if (color === null) delete r.color
      else r.color = color
    })
    this.deps.colorChanged?.(projectId)
    return color
  }

  /**
   * Set this project's own Discuss prompt ('' = off here), or null to use the global one again
   * (the key is removed). Anything else, or text over the cap, throws and stores nothing.
   */
  setDiscussPrompt(projectId: string, value: unknown): void {
    this.project(projectId)
    const text = value === null ? null : checkDiscussPrompt(value)
    this.deps.projects.update(projectId, (r) => {
      if (text === null) delete r.discussPrompt
      else r.discussPrompt = text
    })
  }

  /** Enable or disable an installed plugin; the host restarts with the new set. */
  async setEnabled(projectId: string, pluginId: unknown, enabled: unknown): Promise<void> {
    if (typeof pluginId !== 'string' || typeof enabled !== 'boolean') throw new Error('give the plugin and on or off')
    const plugin = this.deps.plugins.get(pluginId)
    if (!plugin) throw new Error('unknown plugin')
    if (enabled && !(plugin.manifest && plugin.state.ok)) {
      const why = plugin.state.ok ? 'it has no valid manifest' : plugin.state.reason
      throw new Error(`${pluginId} cannot be enabled: ${why}`)
    }
    const appOff = this.deps.disabledBundled()
    // Off in all projects wins over this switch: storing "on" would change nothing the user can see
    // (pluginEnabledIn still says off) and then turn the plugin on later, unasked, when the app-wide
    // switch is undone. Turning it off here is allowed and is a no-op below (already off).
    if (enabled && offAppWide(plugin, appOff)) {
      throw new Error(`${pluginId} is off in all projects; turn that off under Settings > Plugins first`)
    }
    const project = this.project(projectId)
    if (pluginEnabledIn(project, plugin, appOff) === enabled) return
    this.deps.projects.update(projectId, (r) => {
      const list = Array.isArray(r.enabledPlugins) ? r.enabledPlugins.filter((id) => id !== pluginId) : []
      if (enabled) list.push(pluginId)
      r.enabledPlugins = list
      // A default-on plugin is off only while listed here: turning it off adds the id, turning it
      // back on removes it, and either way the choice outlives a restart (it is in the record).
      const off = Array.isArray(r.disabledPlugins) ? r.disabledPlugins.filter((id) => id !== pluginId) : []
      if (!enabled && plugin.enabledByDefault === true) off.push(pluginId)
      if (off.length > 0 || r.disabledPlugins !== undefined) r.disabledPlugins = off
    })
    await this.deps.enabledChanged(projectId)
  }

  /**
   * Store the plugin's project-level overrides: `values` holds only the fields this project
   * overrides (the rest use the global value), checked merged with the global values. A failure
   * stores nothing and lists the reasons; `secrets` sets or clears secret overrides (encrypted
   * first: a keychain that refuses also stores nothing; a cleared one uses the global value). On
   * success the running plugin hears of it (or a plugin disabled for invalid settings starts).
   */
  async saveSettings(projectId: string, pluginId: unknown, values: unknown, secrets?: unknown): Promise<PluginSettingsSaveResult> {
    this.project(projectId)
    const plugin = typeof pluginId === 'string' ? this.deps.plugins.get(pluginId) : undefined
    if (!plugin?.manifest) throw new Error('unknown plugin')
    const schema = plugin.manifest.contributes?.settings?.project
    if (schema === undefined) throw new Error(`${plugin.id} declares no project settings`)
    return saveSettingsForm({
      pluginId: plugin.id,
      // Refused once this project is forgotten (a reopen makes a new record under the same id).
      projectId,
      schema,
      values,
      secrets,
      // Keyed by the project main resolved for the sender, never one from the payload.
      keyOf: (field) => projectSettingKey(projectId, field),
      store: this.deps.secrets,
      // Read in the plugin's queue: a global save queued ahead of this one has stored by then.
      effective: (overrides) => effectiveProjectValues(this.deps.projectDefaults(plugin.id), overrides),
      secretState: (field) => this.secretState(plugin.id, projectId, field),
      save: (value) =>
        this.deps.projects.update(projectId, (r) => {
          // The record file is user-writable: a damaged top level is replaced rather than written into.
          if (!isPlainObject(r.pluginSettings)) r.pluginSettings = {}
          r.pluginSettings[plugin.id] = value
        }),
      announce: () => this.deps.settingsChanged(projectId, plugin.id)
    })
  }

  /** Move a panel of the project to a zone. */
  movePanel(projectId: string, panelKey: unknown, zone: unknown): void {
    this.project(projectId)
    if (typeof panelKey !== 'string') throw new Error('give the panel')
    this.deps.layouts.move(projectId, panelKey, zone)
  }

  private project(projectId: string): ProjectView {
    const project = this.deps.projects.get(projectId)
    if (!project) throw new Error('the project record is gone')
    return project
  }

  private pluginView(project: ProjectView, p: InstalledPlugin, enabled: boolean, appOff: boolean): ProjectPluginView {
    const view: ProjectPluginView = {
      id: p.id,
      name: p.manifest?.name ?? p.id,
      version: p.version,
      enabled,
      state: p.state
    }
    if (appOff) view.offInAllProjects = true
    const manifest = p.manifest
    if (!manifest || !p.state.ok) return view
    if (enabled) {
      const check = this.deps.checkSettings(project.id, p.id)
      if (!check.ok) view.problem = check.reason
    }
    const projectSettings = this.projectSettingsView(project, p)
    if (projectSettings !== undefined) view.projectSettings = projectSettings
    if (manifest.contributes?.settings?.page?.scopes.includes('project') === true) view.settingsPage = true
    return view
  }

  /**
   * The plugin's settings for this project as the This Project page shows them (the effective
   * values with defaults, secret fields as set or not, the overridden fields); undefined when it
   * declares none. `ccc plugin config`
   * reads this (main/settings/plugin-config.ts), so both show the same thing.
   */
  pluginProjectSettings(projectId: string, pluginId: unknown): PluginAppSettingsView | undefined {
    const project = this.project(projectId)
    const plugin = typeof pluginId === 'string' ? this.deps.plugins.get(pluginId) : undefined
    if (!plugin?.manifest) throw new Error(`unknown plugin: ${String(pluginId)}`)
    return this.projectSettingsView(project, plugin)
  }

  /**
   * The project's stored overrides of the plugin's project fields, as stored (user-writable, so
   * anything; undefined when none). `ccc plugin config` merges its edits into these, never into the
   * effective values (which would turn every field into an override).
   */
  pluginProjectOverrides(projectId: string, pluginId: string): unknown {
    return this.storedOverrides(this.project(projectId), pluginId)
  }

  private storedOverrides(project: ProjectView, pluginId: string): unknown {
    return isPlainObject(project.pluginSettings) && Object.hasOwn(project.pluginSettings, pluginId) ? project.pluginSettings[pluginId] : undefined
  }

  /** A secret project field's state for the project: its own value's when it has one, else the global one's. */
  private secretState(pluginId: string, projectId: string, field: string): SecretValueState {
    const own = this.deps.secrets.settingState(pluginId, projectSettingKey(projectId, field))
    return own !== 'unset' ? own : this.deps.secrets.settingState(pluginId, projectDefaultSettingKey(field))
  }

  private projectSettingsView(project: ProjectView, p: InstalledPlugin): PluginAppSettingsView | undefined {
    const schema = p.manifest?.contributes?.settings?.project
    if (schema === undefined) return undefined
    const stored = this.storedOverrides(project, p.id)
    const view = settingsViewOf(schema, effectiveProjectValues(this.deps.projectDefaults(p.id), stored), (f) => this.secretState(p.id, project.id, f))
    view.overrides = overriddenFields(schema, stored, (f) => this.deps.secrets.hasSetting(p.id, projectSettingKey(project.id, f)))
    // What "Use global" shows for a field before the save: the global value (defaults applied).
    const global = settingsViewOf(schema, this.deps.projectDefaults(p.id), (f) => this.deps.secrets.settingState(p.id, projectDefaultSettingKey(f)))
    view.globalValues = global.values
    if (global.secretFields !== undefined) view.globalSecretFields = global.secretFields
    return view
  }
}
