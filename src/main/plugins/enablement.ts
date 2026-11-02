// Whether a plugin is on for a project. `enabledPlugins` alone cannot say "the user turned a
// default-on plugin off", so the record also keeps `disabledPlugins`: on = listed in
// `enabledPlugins`, or default-on (bundled `enabledByDefault`) and not listed in `disabledPlugins`.
// Record files are user-writable, so a damaged list counts as empty instead of throwing.

interface EnablementRecord {
  enabledPlugins?: unknown
  disabledPlugins?: unknown
}

function has(list: unknown, id: string): boolean {
  return Array.isArray(list) && list.includes(id)
}

export function pluginEnabledIn(record: EnablementRecord | undefined, plugin: { id: string; enabledByDefault?: boolean }): boolean {
  if (record === undefined) return false
  if (has(record.enabledPlugins, plugin.id)) return true
  return plugin.enabledByDefault === true && !has(record.disabledPlugins, plugin.id)
}

/**
 * The ids on for the project: `enabledPlugins` first (kept order), then default-on ones, no repeats.
 * A default-on id counts only when `installed` lists it, i.e. its entry exists in the index.
 */
export function enabledPluginIds(
  record: EnablementRecord | undefined,
  installed: readonly { id: string; enabledByDefault?: boolean }[]
): string[] {
  if (record === undefined) return []
  const out = new Set<string>(Array.isArray(record.enabledPlugins) ? (record.enabledPlugins as string[]) : [])
  for (const p of installed) if (pluginEnabledIn(record, p)) out.add(p.id)
  return [...out]
}
