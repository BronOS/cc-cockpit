// The per-plugin caps the person sets (design-rooms.md §6): the keys, their defaults and hard ceilings, the wire
// shapes of `plugin.limits` / `plugin.limits.set` (the CLI) and `plugins.limits.get` / `plugins.limits.set` (Settings ›
// Plugins), and the CLI's plain-text form. Pure: the CLI and the renderer bundle it, so no Node or Electron import.
// Main's side (reading the stored overrides, clamping, checking an edit, storing it) is main/plugins/plugin-limits.ts.
//
// Edit args: `{ id, set?, reset? }`. `set` is a list of `[key, value]` pairs, not an object (a key is the caller's
// text and must never become a property of a live object before main checked it, as in shared/plugin-config.ts);
// `reset` lists keys whose override is dropped (`--default`, "Use default").

export type PluginLimitKey = 'opensPerMinute' | 'sendsPerMinute' | 'roomSendsPerMember' | 'roomSendsPerRoom'

/** The caps in effect for one plugin: its override where the person set one, else the default. */
export type PluginLimits = Record<PluginLimitKey, number>

export interface PluginLimitSpec {
  key: PluginLimitKey
  /** What one unit counts, for the page and `ccc plugin limits` ("tabs opened a minute"). */
  label: string
  default: number
  /** The hard ceiling in main: an override above it is refused (a hand-edited app.json is clamped to it). */
  ceiling: number
}

/** In display order. Every cap counts over one minute. */
export const PLUGIN_LIMIT_SPECS: readonly PluginLimitSpec[] = Object.freeze([
  { key: 'opensPerMinute', label: 'tabs opened a minute (sessions.open, openShell, openCommand, rooms.open)', default: 5, ceiling: 60 },
  { key: 'sendsPerMinute', label: 'texts sent a minute (sessions.send)', default: 30, ceiling: 300 },
  { key: 'roomSendsPerMember', label: 'room messages a minute by one member', default: 20, ceiling: 120 },
  { key: 'roomSendsPerRoom', label: 'room messages a minute in one room, every sender together', default: 60, ceiling: 600 }
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

/** One cap as the person sees it. */
export interface PluginLimitView extends PluginLimitSpec {
  /** What applies now: the override, else the default. */
  value: number
  /** The person set an override (it may equal the default). */
  overridden: boolean
}

/** `plugin.limits { id }` and `plugins.limits.get { id }`; the edits answer the new view. */
export interface PluginLimitsView {
  id: string
  limits: PluginLimitView[]
}

/** Most `key=value` pairs plus `--default` keys one edit takes (there are four caps). */
export const MAX_PLUGIN_LIMIT_EDITS = 16

/**
 * `ccc plugin limits <id>`: one `key = value` line per cap, the default and the ceiling after it, `(set)` on an
 * override. The reply is read field by field (an older or broken app may send anything) and `plain` makes its text
 * safe for a terminal.
 */
export function formatPluginLimits(view: unknown, plain: (text: unknown) => string): string {
  const v = (typeof view === 'object' && view !== null ? view : {}) as Partial<Record<keyof PluginLimitsView, unknown>>
  const rows = (Array.isArray(v.limits) ? v.limits : []).filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
  const keys = rows.map((l) => plain(l.key))
  const width = Math.max(0, ...keys.map((k) => k.length))
  // `plain` keeps strings only: the numbers are printed here, anything else as `?`.
  const num = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '?')
  const lines = rows.map((l, i) => {
    const mark = l.overridden === true ? ' (set)' : ''
    return `${(keys[i] as string).padEnd(width)} = ${num(l.value)}${mark}  default ${num(l.default)}, at most ${num(l.ceiling)}: ${plain(l.label)}\n`
  })
  return `# ${plain(v.id)}\n${lines.join('')}`
}
