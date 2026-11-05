// `ccc plugin config` (friction round 1, Task 6): the wire shapes of `plugin.config` between the
// CLI and main (main/settings/plugin-config.ts), and the CLI's plain-text form of them. Pure: the
// CLI bundles it, so no Node or Electron import.
//
// Request args: `{ id, scope?, set?, useGlobal? }`. No `set` and no `useGlobal` prints; `set` is a
// list of `[key, value]` pairs (a list, not an object: a key is the caller's text and must never
// become a property of a live object before main checked it against the schema); `useGlobal` lists
// project fields whose override this project drops. The project is never in the args: main takes
// it from the socket caller (a tab's token or `--project`).
//
// Scopes (design-next §5.2): `app` (app-wide fields), `global` (the global value of a project
// field, what every project without an override gets) and `project` (this project's override).

export type PluginConfigScope = 'app' | 'global' | 'project'

/** In print order. */
export const PLUGIN_CONFIG_SCOPES: readonly PluginConfigScope[] = ['app', 'global', 'project']

/** Most `key=value` edits one call takes; a settings form has a handful of top-level fields. */
export const MAX_PLUGIN_CONFIG_EDITS = 64

/** One scope of a plugin's settings, as `ccc plugin config <id> --json` prints it. */
export interface PluginConfigScopeView {
  /** The schema's top-level fields, in declaration order (secret ones included). */
  fields: string[]
  /** Stored values with the schema's defaults applied (as stored when they fail it). Never a secret field. */
  values: Record<string, unknown>
  /** Each secret field: whether a value is stored. The value itself never leaves main. */
  secrets: Record<string, boolean>
  /** Why the stored values fail the schema; the plugin is disabled until they pass. */
  problem?: string
  /**
   * `project` only: the fields this project overrides (declaration order). `values` and `secrets`
   * are then the effective ones; every other field uses the global value.
   */
  overrides?: string[]
}

/**
 * `plugin.config` without `set`: the scopes the plugin declares, `global` and `project` (for the
 * caller's project) when it declares project settings.
 */
export interface PluginConfigView {
  id: string
  app?: PluginConfigScopeView
  global?: PluginConfigScopeView
  project?: PluginConfigScopeView
}

/** `plugin.config` with `set`: the scope that was written and the stored value of each key set. */
export interface PluginConfigSetResult {
  id: string
  scope: PluginConfigScope
  values: Record<string, unknown>
}

/**
 * A `key=value` argument's value: JSON when it parses (`5`, `true`, `null`, `"5"`, `[1,2]`,
 * `{"a":1}`), else the text itself as a string (`hello`, `https://x`, an empty value).
 */
export function parseConfigValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** One `scope key = value` line; `plain` makes untrusted text (keys and values come from a manifest or a file) terminal-safe. */
function line(scope: string, key: string, value: string, plain: (text: string) => string): string {
  return `${plain(`${scope} ${key} = ${value}`)}\n`
}

/**
 * The text of `ccc plugin config <id>`: one `scope key = JSON` line per field, app first, then the
 * global values of the project fields, then this project's effective values with a `# project:`
 * line naming its overrides. A secret
 * field reads `set` or `not set`, and so does a plain field with no value and no default; neither is
 * JSON (a string value prints quoted), so a script can tell them apart. A field stored but not
 * declared (a schema that allows more) follows the declared ones. Stored values that fail the
 * schema add a `# scope: ...` line with the reason.
 */
export function formatPluginConfig(view: PluginConfigView, plain: (text: string) => string): string {
  let out = ''
  for (const scope of PLUGIN_CONFIG_SCOPES) {
    const s = view[scope]
    if (s === undefined) continue
    const declared = new Set(s.fields)
    for (const field of s.fields) {
      if (Object.hasOwn(s.secrets, field)) out += line(scope, field, s.secrets[field] === true ? 'set' : 'not set', plain)
      else if (Object.hasOwn(s.values, field)) out += line(scope, field, JSON.stringify(s.values[field]), plain)
      else out += line(scope, field, 'not set', plain)
    }
    for (const [key, value] of Object.entries(s.values)) {
      if (!declared.has(key)) out += line(scope, key, JSON.stringify(value), plain)
    }
    if (s.overrides !== undefined) {
      out += `${plain(s.overrides.length === 0 ? `# ${scope}: no overrides, every field uses the global value` : `# ${scope}: overrides ${s.overrides.join(', ')}; the rest use the global value`)}\n`
    }
    if (s.problem !== undefined) out += `${plain(`# ${scope}: the stored settings fail the schema, the plugin stays off: ${s.problem}`)}\n`
  }
  return out
}

/** The text of a successful set: the stored value of each key set, as `scope key = JSON` lines. */
export function formatPluginConfigSet(result: PluginConfigSetResult, plain: (text: string) => string): string {
  return Object.entries(result.values)
    .map(([key, value]) => line(result.scope, key, JSON.stringify(value), plain))
    .join('')
}
