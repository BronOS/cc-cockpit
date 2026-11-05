// `ctx.settings` and `ctx.onSettingsChange` (design §5). Main validates the values against the
// plugin's manifest schemas (defaults applied; the project values are the effective ones, the
// project's overrides over the global values, design-next §5.2) and sends them at activation and
// on every change;
// the host only holds the latest snapshot and tells listeners. Nothing is validated again here:
// the host is not the authority, and a snapshot that fails main's check is never sent (main
// restarts the host without that plugin instead, see HostManager.settingsChanged).
import type { Disposer, JsonValue, PluginSettings } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { isPlainObject } from '../../shared/guards'

/** Frozen all the way down: a plugin mutating its snapshot must not change what listeners see. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/**
 * One settings object (`project` or `app`) from main. Only the top level is checked; the claim
 * that its values are JSON is trusted, not verified: main read them from a JSON file, checked them
 * against the plugin's schemas and sent them over a JSON channel. The loader uses it too.
 */
export function isSettingsRecord(v: unknown): v is Record<string, JsonValue> {
  return isPlainObject(v)
}

/** The settings snapshot of one plugin plus its change listeners. */
export class SettingsHolder {
  private snapshot: PluginSettings
  private readonly listeners = new Set<(settings: PluginSettings) => void>()

  constructor(
    initial: { project: Record<string, JsonValue>; app: Record<string, JsonValue> },
    private readonly log: (message: string) => void
  ) {
    // Copied: the spec object belongs to the loader, and freezing it in place would freeze that.
    this.snapshot = deepFreeze({
      project: structuredClone(initial.project),
      app: structuredClone(initial.app)
    })
  }

  get current(): PluginSettings {
    return this.snapshot
  }

  /** Main pushed new values (`{ project, app }`). A malformed push is dropped and logged. */
  update(raw: unknown): void {
    const project = (raw as { project?: unknown } | null)?.project
    const app = (raw as { app?: unknown } | null)?.app
    if (!isSettingsRecord(project) || !isSettingsRecord(app)) {
      this.log('settings update dropped: project and app must be objects')
      return
    }
    this.snapshot = deepFreeze({ project: structuredClone(project), app: structuredClone(app) })
    const snapshot = this.snapshot
    // A listener that throws must not keep the others from hearing about the change.
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch (err) {
        this.log(`onSettingsChange listener threw: ${errorText(err)}`)
      }
    }
  }

  onChange(listener: (settings: PluginSettings) => void): Disposer {
    if (typeof listener !== 'function') throw new TypeError('onSettingsChange needs a function')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
