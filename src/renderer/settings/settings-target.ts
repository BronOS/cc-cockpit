// The panel gear (design-next §5.3) asks the window to open Settings at one plugin. The gear sits
// deep in the zones and the screen is owned by TabsPane, so the request travels as a window event
// instead of a prop chain through Zones, Zone and PanelArea.
import type { PanelSettingsTarget } from '../../shared/ipc'

export const OPEN_PLUGIN_SETTINGS_EVENT = 'cc-open-plugin-settings'

/** The page and plugin the gear opens: This Project (`project`) or the plugin's global page under Plugins (`app`). */
export interface SettingsTarget {
  scope: PanelSettingsTarget
  pluginId: string
}

export function openPluginSettings(target: SettingsTarget): void {
  window.dispatchEvent(new CustomEvent<SettingsTarget>(OPEN_PLUGIN_SETTINGS_EVENT, { detail: target }))
}

/** Plugin ids are `[a-z0-9._-]`-shaped, but an event detail is any object: check before use. */
export function targetOf(event: Event): SettingsTarget | null {
  const d = (event as CustomEvent<unknown>).detail
  if (typeof d !== 'object' || d === null) return null
  const { scope, pluginId } = d as Record<string, unknown>
  if ((scope !== 'project' && scope !== 'app') || typeof pluginId !== 'string' || pluginId === '') return null
  return { scope, pluginId }
}
