// Whether a plugin is on for a project. `enabledPlugins` alone cannot say "the user turned a
// default-on plugin off", so the record also keeps `disabledPlugins`: on = listed in
// `enabledPlugins`, or default-on (bundled `enabledByDefault`) and not listed in `disabledPlugins`.
// Above both sits the app-wide switch of a bundled plugin (`AppSettings.disabledBundled`, "Off in all
// projects"): a bundled plugin listed there is off in every project whatever the record says, and the
// record's own choice comes back unchanged once it is taken out of that list.
// Record files and app.json are user-writable, so a damaged list counts as empty instead of throwing.

export interface EnablementRecord {
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
  if (offAppWide(plugin, disabledBundled)) return false
  return pluginOnInRecord(record, plugin)
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
    else if (onInRecord(record, p)) out.add(p.id)
  }
  return [...out]
}

/**
 * Why a plugin's rooms in a project end now (design-rooms.md §1: a room ends when its plugin is disabled, removed or
 * revoked), or undefined while the plugin is on there. `plugin` is the installed plugin (undefined once it is
 * uninstalled), `revoked` its marketplace revocation, `record` the project's record: undefined for a project whose
 * record is gone (forgotten), 'unknown' for one this run cannot read, which keeps the rooms (ProjectRegistry
 * enablementRecord: an ended room never comes back, and the file may). An invalid manifest is not a reason: the
 * plugin is still the person's, as for a saved command tab (index.ts pluginAvailable), and a linked folder mid-edit
 * must not end a room. The one rule for both the sweep and main's refusal of a rooms call (rooms-plugin-gate.ts).
 */
export function roomEndReason(
  record: EnablementRecord | 'unknown' | undefined,
  plugin: EnablementPlugin | undefined,
  revoked: boolean,
  disabledBundled?: unknown
): 'plugin removed' | 'plugin revoked' | 'plugin disabled' | 'project removed' | undefined {
  if (plugin === undefined) return 'plugin removed'
  if (revoked) return 'plugin revoked'
  if (record === 'unknown') return undefined
  if (record === undefined) return 'project removed'
  return pluginEnabledIn(record, plugin, disabledBundled) ? undefined : 'plugin disabled'
}
