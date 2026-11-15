// The per-plugin caps the person sets (design-rooms.md §6): the keys, their defaults and hard ceilings, the wire
// shapes of `plugin.limits` / `plugin.limits.set` (the CLI), `plugins.limits.get` / `plugins.limits.set` (Settings ›
// Plugins) and `plugins.globalLimits.get` / `plugins.globalLimits.set` (Settings › General), and the CLI's plain-text
// form. Pure: the CLI and the renderer bundle it, so no Node or Electron import. Main's side (reading the stored
// values, clamping, checking an edit, storing it) is main/plugins/plugin-limits.ts.
//
// Each cap has a global value (every plugin without its own) and a per-plugin override: a plugin's cap is its
// override, else the global value, else the built-in default. Counting stays per plugin: each plugin gets its own
// budget of that number.
//
// Edit args: `{ id, set?, reset? }`, or `{ global: true, set?, reset? }` for the global values. `set` is a list of
// `[key, value]` pairs, not an object (a key is the caller's text and must never become a property of a live object
// before main checked it, as in shared/plugin-config.ts); `reset` lists keys whose value is dropped (`--default`,
// "Use global" on a plugin, "Use default" on the global values).

export type PluginLimitKey = 'opensPerMinute' | 'sendsPerMinute' | 'roomSendsPerMember' | 'roomSendsPerRoom' | 'roomsPerProject' | 'membersPerRoom'

/** The caps in effect for one plugin: its override where the person set one, else the global value, else the default. */
export type PluginLimits = Record<PluginLimitKey, number>

export interface PluginLimitSpec {
  key: PluginLimitKey
  /** What one unit counts, for the page and `ccc plugin limits` ("tabs opened a minute"). */
  label: string
  default: number
  /** The hard ceiling in main, for a global value and an override alike: above it is refused (a hand-edited app.json is clamped to it). */
  ceiling: number
}

/** In display order. The first four count over one minute; the last two are standing counts (rooms not ended, members in a room). The unit is in the label. */
export const PLUGIN_LIMIT_SPECS: readonly PluginLimitSpec[] = Object.freeze([
  { key: 'opensPerMinute', label: 'tabs opened a minute (sessions.open, openShell, openCommand, rooms.open)', default: 5, ceiling: 60 },
  { key: 'sendsPerMinute', label: 'texts sent a minute (sessions.send)', default: 30, ceiling: 300 },
  { key: 'roomSendsPerMember', label: 'room messages a minute by one member', default: 20, ceiling: 120 },
  { key: 'roomSendsPerRoom', label: 'room messages a minute in one room, every sender together', default: 60, ceiling: 600 },
  { key: 'roomsPerProject', label: 'rooms not ended at once in a project (rooms.create)', default: 5, ceiling: 20 },
  { key: 'membersPerRoom', label: 'members in one room (rooms.open, ccc room join)', default: 20, ceiling: 50 }
])

export const PLUGIN_LIMIT_KEYS: readonly PluginLimitKey[] = PLUGIN_LIMIT_SPECS.map((s) => s.key)

export const DEFAULT_PLUGIN_LIMITS: Readonly<PluginLimits> = Object.freeze(
  Object.fromEntries(PLUGIN_LIMIT_SPECS.map((s) => [s.key, s.default])) as PluginLimits
)

export function isPluginLimitKey(key: unknown): key is PluginLimitKey {
  return typeof key === 'string' && (PLUGIN_LIMIT_KEYS as readonly string[]).includes(key)
}

export function limitSpec(key: PluginLimitKey): PluginLimitSpec {
  return PLUGIN_LIMIT_SPECS.find((s) => s.key === key) as PluginLimitSpec
}

/** Where a cap's value comes from: the plugin's own override, the global value, or the built-in default. */
export type PluginLimitSource = 'plugin' | 'global' | 'default'

/** One cap as the person sees it. */
export interface PluginLimitView extends PluginLimitSpec {
  /** What applies now: in a plugin's view its override, else the global value, else the default; in the global view the global value, else the default. */
  value: number
  /** The view's own level has a value (it may equal what it would inherit): the plugin's override, or the global value. */
  overridden: boolean
  /** Where `value` comes from. A plugin's view uses all three; the global view only `global` and `default`. */
  source: PluginLimitSource
  /** What applies without the view's own value: for a plugin the global value, else the default; globally the default. */
  inherited: number
}

/** `plugin.limits { id }` and `plugins.limits.get { id }`; the edits answer the new view. */
export interface PluginLimitsView {
  id: string
  limits: PluginLimitView[]
}

/** `plugin.limits { global: true }` and `plugins.globalLimits.get`: the values every plugin without its own gets. */
export interface GlobalPluginLimitsView {
  global: true
  limits: PluginLimitView[]
}

/** Most `key=value` pairs plus `--default` keys one edit takes (there are six caps). */
export const MAX_PLUGIN_LIMIT_EDITS = 16

const SOURCES: readonly string[] = ['plugin', 'global', 'default'] satisfies readonly PluginLimitSource[]

/**
 * `ccc plugin limits <id>` and `--global`: one `key = value` line per cap, where the value comes from in brackets
 * (`plugin`, `global` or `default`), then the default and the ceiling. The global view's heading is `# global (...)`. The
 * reply is read field by field (an older or broken app may send anything; one with no `source` gets `(set)` on an
 * override, as before) and `plain` makes its text safe for a terminal.
 */
export function formatPluginLimits(view: unknown, plain: (text: unknown) => string): string {
  const v = (typeof view === 'object' && view !== null ? view : {}) as Partial<Record<keyof PluginLimitsView | 'global', unknown>>
  const rows = (Array.isArray(v.limits) ? v.limits : []).filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
  const keys = rows.map((l) => plain(l.key))
  const width = Math.max(0, ...keys.map((k) => k.length))
  // `plain` keeps strings only: the numbers are printed here, anything else as `?`.
  const num = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '?')
  const lines = rows.map((l, i) => {
    const source = typeof l.source === 'string' && SOURCES.includes(l.source) ? l.source : undefined
    const mark = source !== undefined ? ` (${source})` : l.overridden === true ? ' (set)' : ''
    return `${(keys[i] as string).padEnd(width)} = ${num(l.value)}${mark}  default ${num(l.default)}, at most ${num(l.ceiling)}: ${plain(l.label)}\n`
  })
  const heading = v.global === true ? 'global (every plugin without its own value)' : plain(v.id)
  return `# ${heading}\n${lines.join('')}`
}
