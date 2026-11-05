// A plugin's html settings page (design-next §5.4), the bits main, the host and the renderer share.
// The manifest side (`contributes.settings.page`, the scopes) is in manifest.ts.
import { SETTINGS_PAGE_SCOPES, type SettingsPageScope } from './manifest'

/**
 * The key a settings page's port travels under on the panels' channel (main -> window, the
 * renderer's port bus unchanged), like a slot frame's `@slot/<id>`: `@` never starts a plugin id,
 * so it cannot collide with a panel key. One per plugin: a window shows one page per plugin at a time.
 */
export function settingsPagePortKey(pluginId: string): string {
  return `@settings/${pluginId}`
}

export function isSettingsPageScope(v: unknown): v is SettingsPageScope {
  return typeof v === 'string' && (SETTINGS_PAGE_SCOPES as readonly string[]).includes(v)
}

/** Main-minted id of one open page (one load of the iframe): `p<n>`. */
export const SETTINGS_PAGE_ID_PATTERN = /^p[0-9]{1,15}$/
