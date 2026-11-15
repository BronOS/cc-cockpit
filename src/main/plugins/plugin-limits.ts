// The per-plugin caps the person sets (design-rooms.md §6), main's side: the stored overrides (`app.json` ›
// `pluginLimits[id]`) read with every value clamped, an edit checked and stored, and `limits(pluginId)`, which HostApi
// (sessions.open / openShell / openCommand / rooms.open, sessions.send) and the room delivery call on every send or
// open, so a change applies to the next call without a host restart.
//
// Who writes: only the person, through Settings › Plugins (`plugins.limits.set`, router.ts; a browser only in server
// mode) and `ccc plugin limits <id> key=value...` from a shell outside cockpit (`plugin.limits.set`, in
// HOST_ONLY_COMMANDS). Never plugin.json, the plugin's own settings, `ccc plugin config` or anything a plugin host can
// reach through the API. Not a boundary: a tab's process or a plugin host is the same OS user and can drop its token,
// run `ccc plugin limits` as a shell would, or edit app.json; it keeps a prompted Claude from raising its own
// plugin's caps as a side effect, and a plugin that is honest about the API from finding a setter.
//
// The file is user-writable, so a read never trusts it: an override that is not a whole number from 1 up is ignored
// (the default applies) and one above the ceiling reads as the ceiling, so a typo in app.json cannot unbound a cap. An
// edit is stricter: a value outside 1..ceiling is refused, naming the range, so the person sees the typo.
//
// Uninstalling a plugin drops its overrides (`forget`, called by the installer beside its secrets): raised caps must
// not carry over to a different plugin that later takes the id (a link of another folder). A reinstall starts at the
// defaults.
import {
  DEFAULT_PLUGIN_LIMITS,
  isPluginLimitKey,
  limitSpec,
  MAX_PLUGIN_LIMIT_EDITS,
  PLUGIN_LIMIT_KEYS,
  PLUGIN_LIMIT_SPECS,
  type PluginLimitKey,
  type PluginLimits,
  type PluginLimitsView
} from '../../shared/plugin-limits'
import { isPlainObject } from '../../shared/guards'

/** The stored overrides of one plugin (`app.json` › `pluginLimits[id]`). */
export interface PluginLimitsStorage {
  /** As stored (user-writable, so anything); undefined when the plugin has none. */
  get(pluginId: string): unknown
  /**
   * Store the cleaned overrides; undefined (no override left) removes the plugin's entry. Throws when app.json cannot
   * be written at all (read-only); otherwise it is queued like every app.json write (debounced, flushed on quit).
   */
  set(pluginId: string, overrides: Partial<PluginLimits> | undefined): void
}

/** The slice of the app.json file (ProjectRegistry.app, a JsonFile) the overrides live in. */
export interface AppLimitsFile {
  readonly data: { pluginLimits?: Record<string, unknown> }
  /** The file loaded read-only (EACCES, or a newer schemaVersion): a write would be lost, so a set refuses. */
  readonly readOnly?: boolean
  update(mutate: (app: { pluginLimits?: Record<string, unknown> }) => void): void
}

/** `app.json` › `pluginLimits[id]` as the storage: own properties only, and an emptied map leaves the file. */
export function appJsonLimitsStorage(app: AppLimitsFile): PluginLimitsStorage {
  return {
    get: (pluginId) => {
      const all: unknown = app.data.pluginLimits
      return isPlainObject(all) && Object.hasOwn(all, pluginId) ? all[pluginId] : undefined
    },
    set: (pluginId, overrides) => {
      // Like forgetPluginRepo: a value that would only be lost at restart is refused now, not reported as set.
      if (app.readOnly === true) throw new Error('the limits cannot be saved: app.json cannot be written (see the log)')
      app.update((a) => {
        // app.json is user-writable: a damaged top level is replaced rather than written into.
        if (!isPlainObject(a.pluginLimits)) a.pluginLimits = {}
        if (overrides === undefined) delete a.pluginLimits[pluginId]
        else a.pluginLimits[pluginId] = { ...overrides }
        if (Object.keys(a.pluginLimits).length === 0) delete a.pluginLimits
      })
    }
  }
}

export interface PluginLimitsDeps {
  storage: PluginLimitsStorage
  /** The plugin is installed (any source, bundled included). A read or an edit for any other id is refused. */
  known(pluginId: string): boolean
}

/** A stored value as it applies: a whole number from 1 up, at most the ceiling; anything else is no override. */
function clampStored(key: PluginLimitKey, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined
  return Math.min(value, limitSpec(key).ceiling)
}

/** The overrides that apply from what is stored (own properties of the known keys only, each clamped). */
export function storedOverrides(stored: unknown): Partial<PluginLimits> {
  const out: Partial<PluginLimits> = {}
  if (!isPlainObject(stored)) return out
  for (const key of PLUGIN_LIMIT_KEYS) {
    if (!Object.hasOwn(stored, key)) continue
    const value = clampStored(key, stored[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

/** The caps in effect: each override where one applies, else the default. */
export function effectiveLimits(stored: unknown): PluginLimits {
  return { ...DEFAULT_PLUGIN_LIMITS, ...storedOverrides(stored) }
}

export function limitsView(id: string, stored: unknown): PluginLimitsView {
  const overrides = storedOverrides(stored)
  return {
    id,
    limits: PLUGIN_LIMIT_SPECS.map((s) => ({
      ...s,
      value: overrides[s.key] ?? s.default,
      overridden: overrides[s.key] !== undefined
    }))
  }
}

const KEYS_TEXT = PLUGIN_LIMIT_KEYS.join(', ')

function keyOf(key: unknown): PluginLimitKey {
  if (!isPluginLimitKey(key)) {
    throw new Error(`unknown limit: ${typeof key === 'string' ? key.slice(0, 64) : String(key)} (the limits are ${KEYS_TEXT})`)
  }
  return key
}

/**
 * A value of an edit: a number (the settings page) or the decimal text of `key=value` (the CLI), a whole number from
 * 1 to the ceiling. Digits only, read character by character: no sign, exponent, fraction or spaces.
 */
export function parseLimitValue(key: PluginLimitKey, value: unknown): number {
  const { ceiling } = limitSpec(key)
  const refuse = (): never => {
    throw new Error(`${key} must be a whole number from 1 to ${ceiling}`)
  }
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string' && value.length > 0 && value.length <= 6) {
    for (const ch of value) if (ch < '0' || ch > '9') refuse()
    n = Number(value)
  } else return refuse()
  if (!Number.isInteger(n) || n < 1 || n > ceiling) refuse()
  return n
}

/**
 * Apply an edit to the stored overrides: `set` pairs replace a key's override, `reset` keys drop theirs. Checked
 * whole before anything is stored: an unknown key, a bad value, a key both set and reset or named twice, or an
 * empty edit refuses it all. Returns the new overrides (only the known keys, clamped).
 */
export function applyLimitsEdit(stored: unknown, set: unknown, reset: unknown): Partial<PluginLimits> {
  const pairs = set === undefined ? [] : set
  const resets = reset === undefined ? [] : reset
  if (!Array.isArray(pairs) || !Array.isArray(resets)) throw new Error('set is a list of [key, value] pairs and reset a list of keys')
  if (pairs.length + resets.length === 0) throw new Error('nothing to change: give key=value or a key to reset')
  if (pairs.length + resets.length > MAX_PLUGIN_LIMIT_EDITS) throw new Error(`at most ${MAX_PLUGIN_LIMIT_EDITS} changes at once`)
  const seen = new Set<PluginLimitKey>()
  const once = (key: PluginLimitKey): void => {
    if (seen.has(key)) throw new Error(`${key} is named twice`)
    seen.add(key)
  }
  const next = storedOverrides(stored)
  for (const pair of pairs as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('each change is a [key, value] pair')
    const key = keyOf(pair[0])
    once(key)
    next[key] = parseLimitValue(key, pair[1])
  }
  for (const k of resets as unknown[]) {
    const key = keyOf(k)
    once(key)
    delete next[key]
  }
  return next
}

/** The store: what HostApi, the room delivery, Settings › Plugins and `ccc plugin limits` go through. */
export class PluginLimitsStore {
  constructor(private readonly deps: PluginLimitsDeps) {}

  /**
   * The caps in effect for a plugin, read from the in-memory app.json on every call (an edit made here applies to the
   * next open or send; a hand edit of the file while the app runs is not seen, and the next save overwrites it).
   * Never throws: an unknown id or a damaged entry gets the defaults.
   */
  limits(pluginId: string): PluginLimits {
    try {
      return effectiveLimits(this.deps.storage.get(pluginId))
    } catch {
      return { ...DEFAULT_PLUGIN_LIMITS }
    }
  }

  /**
   * Drop a plugin's overrides (it was uninstalled). Takes any id, installed or not, and does nothing when there is no
   * entry, so an uninstall never needs a writable app.json for a plugin that had no caps set.
   */
  forget(pluginId: string): void {
    const stored: unknown = this.deps.storage.get(pluginId)
    if (stored === undefined) return
    this.deps.storage.set(pluginId, undefined)
  }

  view(pluginId: unknown): PluginLimitsView {
    const id = this.known(pluginId)
    return limitsView(id, this.deps.storage.get(id))
  }

  /** Check and store an edit; the new view. Nothing is stored when any part is refused. */
  set(pluginId: unknown, set: unknown, reset: unknown): PluginLimitsView {
    const id = this.known(pluginId)
    const next = applyLimitsEdit(this.deps.storage.get(id), set, reset)
    this.deps.storage.set(id, Object.keys(next).length > 0 ? next : undefined)
    return limitsView(id, next)
  }

  private known(pluginId: unknown): string {
    if (typeof pluginId !== 'string' || pluginId === '' || pluginId.length > 128) throw new Error('needs a plugin id')
    if (!this.deps.known(pluginId)) throw new Error(`${pluginId} is not installed`)
    return pluginId
  }
}
