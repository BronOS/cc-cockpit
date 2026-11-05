// A one-time data migration (design-next §4.2): the "Changed files shown per session" setting moved
// from core (`app.json` › `sessionFilesShown`) to the bundled `cockpit.sessions` plugin's app setting
// `filesShown`. Main copies it once at start, as plain data in app.json: the plugin gets no runtime
// privilege for it (the bundled-plugins rule), it simply finds its own setting already stored.
//
// Pure over the app.json object so it is unit-tested without a store; index.ts runs it inside
// `registry.app.update` only when the old key is there.
import { isPlainObject } from '../../shared/guards'
import type { AppSettings } from '../../shared/types'

export const SESSIONS_PLUGIN_ID = 'cockpit.sessions'

/** The old core setting's range, which is also the plugin's schema (`filesShown`, plugins/sessions/plugin.json). */
const FILES_SHOWN_RANGE = { min: 1, max: 500 } as const

/** True when `app` has the old key, i.e. the migration has something to do. */
export function needsSessionFilesMigration(app: Pick<AppSettings, 'sessionFilesShown'>): boolean {
  return Object.hasOwn(app, 'sessionFilesShown')
}

/**
 * Move `sessionFilesShown` to `pluginSettings['cockpit.sessions'].filesShown`, in place. The value is
 * copied only when it is a valid one (an integer 1-500: app.json is user-writable, and the plugin's
 * schema would refuse anything else) and the plugin has no `filesShown` of its own yet (a value the
 * person set in the plugin's form wins). The old key goes in every case: once the plugin's setting
 * exists it is the only one, and a stale copy would be migrated over nothing at the next start.
 */
export function migrateSessionFilesShown(app: Pick<AppSettings, 'sessionFilesShown' | 'pluginSettings'>): void {
  if (!needsSessionFilesMigration(app)) return
  const value = app.sessionFilesShown
  delete app.sessionFilesShown
  const valid =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= FILES_SHOWN_RANGE.min &&
    value <= FILES_SHOWN_RANGE.max
  if (!valid) return
  // A damaged top level is replaced rather than written into (as the settings form's save does).
  if (!isPlainObject(app.pluginSettings)) app.pluginSettings = {}
  const own: unknown = Object.hasOwn(app.pluginSettings, SESSIONS_PLUGIN_ID) ? app.pluginSettings[SESSIONS_PLUGIN_ID] : undefined
  if (own !== undefined && !isPlainObject(own)) return // not ours to repair: the old value is dropped with the old key, the form shows the damaged one as a problem
  if (own !== undefined && Object.hasOwn(own, 'filesShown')) return
  app.pluginSettings[SESSIONS_PLUGIN_ID] = { ...(own ?? {}), filesShown: value }
}
