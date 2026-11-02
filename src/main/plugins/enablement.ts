// Whether a plugin is on for a project. `enabledPlugins` alone cannot say "the user turned a
// default-on plugin off", so the record also keeps `disabledPlugins`: on = listed in
// `enabledPlugins`, or default-on (bundled `enabledByDefault`) and not listed in `disabledPlugins`.
// Above both sits the app-wide switch of a bundled plugin (`AppSettings.disabledBundled`, "Off in all
// projects"): a bundled plugin listed there is off in every project whatever the record says, and the
// record's own choice comes back unchanged once it is taken out of that list.
// Record files and app.json are user-writable, so a damaged list counts as empty instead of throwing.

interface EnablementRecord {
  enabledPlugins?: unknown
  disabledPlugins?: unknown
}

/** What the rule needs from a plugin: its id, default-on, and whether it ships with the app. */
export interface EnablementPlugin {
  id: string
  enabledByDefault?: boolean
  source?: { kind: string }
}

function has(list: unknown, id: string): boolean {
  return Array.isArray(list) && list.includes(id)
}

/**
 * Off in all projects: a bundled plugin listed in `disabledBundled`. Only a bundled source counts:
 * the list is user-writable, and a third-party id in it must not turn that plugin off behind the
 * per-project switches (third-party plugins are per project by design, design.md §5).
 */
export function offAppWide(plugin: EnablementPlugin, disabledBundled: unknown): boolean {
  return plugin.source?.kind === 'bundled' && has(disabledBundled, plugin.id)
}

/** The project record's own answer, before the app-wide switch (what the This project switch remembers). */
function onInRecord(record: EnablementRecord, plugin: EnablementPlugin): boolean {
  if (has(record.enabledPlugins, plugin.id)) return true
  return plugin.enabledByDefault === true && !has(record.disabledPlugins, plugin.id)
}

export function pluginEnabledIn(
  record: EnablementRecord | undefined,
  plugin: EnablementPlugin,
  disabledBundled?: unknown
): boolean {
  if (record === undefined) return false
  if (offAppWide(plugin, disabledBundled)) return false
  return onInRecord(record, plugin)
}

/**
 * The project record turns the plugin on, ignoring the app-wide switch: whether "Off in all projects"
 * changes anything for this project (the hosts to restart when it flips).
 */
export function pluginOnInRecord(record: EnablementRecord | undefined, plugin: EnablementPlugin): boolean {
  return record !== undefined && onInRecord(record, plugin)
}

/**
 * The ids on for the project: `enabledPlugins` first (kept order), then default-on ones, no repeats.
 * A default-on id counts only when `installed` lists it, i.e. its entry exists in the index. A bundled
 * plugin that is off app-wide is left out even when `enabledPlugins` names it.
 */
export function enabledPluginIds(
  record: EnablementRecord | undefined,
  installed: readonly EnablementPlugin[],
  disabledBundled?: unknown
): string[] {
  if (record === undefined) return []
  const out = new Set<string>(Array.isArray(record.enabledPlugins) ? (record.enabledPlugins as string[]) : [])
  for (const p of installed) {
    if (offAppWide(p, disabledBundled)) out.delete(p.id)
    else if (pluginEnabledIn(record, p)) out.add(p.id)
  }
  return [...out]
}
