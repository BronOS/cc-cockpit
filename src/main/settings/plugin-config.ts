// `ccc plugin config` in main (friction round 1, Task 6): read a plugin's settings, or set some of
// its top-level fields, from the command line. The socket handler (socket/handlers.ts) resolves
// the project from the caller; this file only ever gets that id.
//
// One save path: reading goes through the same views the Settings pages show
// (SettingsService.pluginAppSettings, ProjectSettingsService.pluginProjectSettings), and a set
// goes through the same save the forms call (SettingsService.savePluginSettings,
// ProjectSettingsService.saveSettings, both on saveSettingsForm): the same schema validation (a
// failure stores nothing and returns the reasons), the same per-plugin save queue and lifecycle
// guard, the same announce, so `ctx.onSettingsChange` and the restart of a plugin that was off
// for invalid settings behave exactly as after a form save.
//
// Decisions:
//  - A set merges the edits into the scope's current values (what the page shows: stored, with
//    defaults) and saves the whole object, as the form does. Only declared top-level fields: a key
//    the schema does not name is refused, even where the schema would allow it.
//  - Scope: the one that declares the key. A key both scopes declare needs `--scope`; all keys of
//    one call must land in one scope (one save, so one validation decides for all of them).
//  - Secret fields are refused, never passed on: their values stay between the Settings form and
//    the keychain, and `secrets` is never sent, so a set leaves every stored secret as it is.
//  - This grants nothing new: the socket is the user's own, and any local process can already write
//    app.json or a project record (user-writable files) and so the same values.
import { isPlainObject } from '../../shared/guards'
import type { PluginAppSettingsView, PluginSettingsSaveResult } from '../../shared/ipc'
import type { PluginConfigScope, PluginConfigScopeView, PluginConfigSetResult, PluginConfigView } from '../../shared/plugin-config'
import { secretFieldsOf } from '../plugins/validate'

/** What the command needs of the two settings services (index.ts passes the real ones). */
export interface PluginConfigDeps {
  /** SettingsService.pluginAppSettings: throws 'unknown plugin'; undefined when it declares no app settings. */
  appSettings(pluginId: string): PluginAppSettingsView | undefined
  /** ProjectSettingsService.pluginProjectSettings, likewise for the project's settings. */
  projectSettings(projectId: string, pluginId: string): PluginAppSettingsView | undefined
  /** SettingsService.savePluginSettings (no secrets argument: they stay as they are). */
  saveApp(pluginId: string, values: Record<string, unknown>): Promise<PluginSettingsSaveResult>
  /** ProjectSettingsService.saveSettings, likewise. */
  saveProject(projectId: string, pluginId: string, values: Record<string, unknown>): Promise<PluginSettingsSaveResult>
}

/** Keys that would reach an object's prototype when assigned; never a settings field here. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Where a scope's secret fields are set by hand. */
const SECRET_HOME: Record<PluginConfigScope, string> = {
  app: 'Settings > Plugins',
  project: 'Settings > This project'
}

/** "an app setting", "a project setting". */
function aScope(scope: PluginConfigScope): string {
  return scope === 'app' ? 'an app setting' : 'a project setting'
}

function views(deps: PluginConfigDeps, projectId: string, pluginId: string): Record<PluginConfigScope, PluginAppSettingsView | undefined> {
  // App first: it throws 'unknown plugin' before the project view is asked.
  const app = deps.appSettings(pluginId)
  return { app, project: deps.projectSettings(projectId, pluginId) }
}

/** The schema's top-level fields, in declaration order. */
function fieldsOf(schema: Record<string, unknown>): string[] {
  return isPlainObject(schema.properties) ? Object.keys(schema.properties) : []
}

function scopeView(view: PluginAppSettingsView): PluginConfigScopeView {
  const secrets = Object.fromEntries(Object.entries(view.secretFields ?? {}).map(([field, s]) => [field, s.set]))
  return {
    fields: fieldsOf(view.schema),
    values: view.values,
    secrets,
    ...(view.problem !== undefined ? { problem: view.problem } : {})
  }
}

/** `ccc plugin config <id>`: both scopes the plugin declares, the project one for `projectId`. */
export function pluginConfigView(deps: PluginConfigDeps, projectId: string, pluginId: string): PluginConfigView {
  const v = views(deps, projectId, pluginId)
  if (v.app === undefined && v.project === undefined) throw new Error(`${pluginId} declares no settings`)
  const out: PluginConfigView = { id: pluginId }
  if (v.app !== undefined) out.app = scopeView(v.app)
  if (v.project !== undefined) out.project = scopeView(v.project)
  return out
}

/** The scope a key goes to, or the reason it cannot be set from here. */
function scopeFor(
  pluginId: string,
  key: string,
  v: Record<PluginConfigScope, PluginAppSettingsView | undefined>,
  requested: PluginConfigScope | undefined
): PluginConfigScope {
  const declares = (scope: PluginConfigScope): boolean => {
    const schema = v[scope]?.schema
    return schema !== undefined && isPlainObject(schema.properties) && Object.hasOwn(schema.properties, key)
  }
  const known = (scope: PluginConfigScope): string => {
    const fields = v[scope] === undefined ? [] : fieldsOf(v[scope].schema)
    return fields.length === 0 ? `${pluginId} declares no ${scope} settings` : `its ${scope} settings are ${fields.join(', ')}`
  }
  let scope: PluginConfigScope
  if (requested !== undefined) {
    if (!declares(requested)) throw new Error(`${key} is not ${aScope(requested)} of ${pluginId} (${known(requested)})`)
    scope = requested
  } else if (declares('app') && declares('project')) {
    throw new Error(`${key} is both an app and a project setting of ${pluginId}: add --scope app or --scope project`)
  } else if (declares('app')) scope = 'app'
  else if (declares('project')) scope = 'project'
  else {
    const all = (['app', 'project'] as const).filter((s) => v[s] !== undefined).map(known)
    throw new Error(`${pluginId} has no setting ${key} (${all.length === 0 ? `${pluginId} declares no settings` : all.join('; ')})`)
  }
  if (secretFieldsOf(v[scope]?.schema).includes(key)) {
    throw new Error(`${key} is a secret field: ccc never handles secret values, set it in ${SECRET_HOME[scope]}`)
  }
  return scope
}

/**
 * `ccc plugin config <id> [--scope app|project] key=value ...`: store the edits through the
 * Settings form's save. A value the schema refuses throws with the schema's reasons, and nothing
 * is stored. Returns the stored value of each key set (defaults never change a value given).
 */
export async function setPluginConfig(
  deps: PluginConfigDeps,
  projectId: string,
  pluginId: string,
  edits: ReadonlyArray<readonly [string, unknown]>,
  requested?: PluginConfigScope
): Promise<PluginConfigSetResult> {
  if (edits.length === 0) throw new Error('plugin config needs at least one key=value to set')
  const v = views(deps, projectId, pluginId)
  if (v.app === undefined && v.project === undefined) throw new Error(`${pluginId} declares no settings`)
  let scope: PluginConfigScope | undefined
  let first = ''
  for (const [key] of edits) {
    if (RESERVED_KEYS.has(key)) throw new Error(`${key} is not allowed as a key`)
    const s = scopeFor(pluginId, key, v, requested)
    if (scope !== undefined && s !== scope) {
      throw new Error(`${first} is ${aScope(scope)} and ${key} ${aScope(s)}: set them in two calls`)
    }
    scope = s
    if (first === '') first = key
  }
  if (scope === undefined) throw new Error('plugin config needs at least one key=value to set')
  const current = v[scope] as PluginAppSettingsView
  // A spread copy, then plain assignment of keys the schema declares (reserved ones refused above).
  const values: Record<string, unknown> = { ...current.values }
  for (const [key, value] of edits) values[key] = value
  const saved = scope === 'app' ? await deps.saveApp(pluginId, values) : await deps.saveProject(projectId, pluginId, values)
  if (!saved.ok) throw new Error(`${pluginId}: nothing was stored, the ${scope} settings fail the schema: ${saved.errors.join('; ')}`)
  const keys = new Set(edits.map(([key]) => key))
  return { id: pluginId, scope, values: Object.fromEntries([...keys].map((key) => [key, saved.values[key]])) }
}
