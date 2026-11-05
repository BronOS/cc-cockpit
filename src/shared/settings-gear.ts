// The panel gear's target (design-next §5.3): This Project at the plugin when it has project
// settings (a `project` schema, or an html page with the project scope), else its global page
// (an `app` schema or a page with the app scope), else no gear. One rule for main (it stamps
// `PanelInfo.settings`) and the tests.
import type { PluginManifest } from './manifest'
import type { PanelSettingsTarget } from './ipc'

export function settingsGearOf(manifest: Pick<PluginManifest, 'contributes'>): PanelSettingsTarget | undefined {
  const settings = manifest.contributes?.settings
  if (settings === undefined) return undefined
  if (settings.project !== undefined || settings.page?.scopes.includes('project') === true) return 'project'
  if (settings.app !== undefined || settings.page?.scopes.includes('app') === true) return 'app'
  return undefined
}
