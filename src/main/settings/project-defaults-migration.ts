// One-time migration to global values of project fields (design-next §5.2). Before it, a project
// form's save stored every field with the schema's defaults filled in, so each stored value would
// now be an override of the global value. At the first start with global values, for each project
// and installed plugin, a stored top-level value equal to its field's schema `default` is dropped:
// the field then "uses global", and the global value starts as that default (nothing stored), so
// what the plugin sees does not change. Every other value stays an override; secret fields are
// never in the JSON (secrets.json keeps them as project overrides).
//
// Runs once (`app.json` › `projectDefaultsMigrated`), after the plugins loaded (the manifests say
// what a default is). A host that started on the old record meanwhile sees the same values: the
// effective value of a dropped field is that same default.
//
// Accepted trade-off: a plugin that is not installed or not valid at that start (no schema to say
// what a default is) is skipped, and the migration is still marked done, so its stored values stay
// overrides for good. Re-running it later would drop values the person has since set on purpose to
// the default (an override that happens to equal it), which is worse. Such a field is set back to
// "uses global" by hand (Settings > This Project, or `ccc plugin config --use-global`). Only a
// failure of the run itself is retried (index.ts).
import { isDeepStrictEqual } from 'node:util'
import { isPlainObject } from '../../shared/guards'
import type { JsonSchema } from '../../shared/manifest'
import type { AppSettings, ProjectRecord, ProjectView } from '../../shared/types'

/** Drop, in place, the values of `stored` equal to their field's schema default. True when one went. */
export function dropDefaultValues(schema: JsonSchema, stored: Record<string, unknown>): boolean {
  if (!isPlainObject(schema.properties)) return false
  let dropped = false
  for (const [field, property] of Object.entries(schema.properties)) {
    if (!isPlainObject(property) || !Object.hasOwn(property, 'default') || !Object.hasOwn(stored, field)) continue
    if (!isDeepStrictEqual(stored[field], property.default)) continue
    delete stored[field]
    dropped = true
  }
  return dropped
}

export interface ProjectDefaultsMigrationDeps {
  app: { data: Pick<AppSettings, 'projectDefaultsMigrated'>; update(mutate: (a: AppSettings) => void): void }
  projects: { list(): ProjectView[]; update(id: string, mutate: (record: ProjectRecord) => void): void }
  /** The `settings.project` schema of an installed, valid plugin; undefined otherwise. */
  projectSchemaOf(pluginId: string): JsonSchema | undefined
}

/** Run the migration unless it ran already; marks it done either way. */
export function migrateProjectDefaults(deps: ProjectDefaultsMigrationDeps): void {
  if (deps.app.data.projectDefaultsMigrated === true) return
  for (const project of deps.projects.list()) {
    if (!isPlainObject(project.pluginSettings)) continue
    const touched = Object.entries(project.pluginSettings).filter(([pluginId, stored]) => {
      const schema = deps.projectSchemaOf(pluginId)
      // A copy: the view is the registry's copy, but the record is changed through update() only.
      return schema !== undefined && isPlainObject(stored) && dropDefaultValues(schema, { ...stored })
    })
    if (touched.length === 0) continue
    deps.projects.update(project.id, (r) => {
      if (!isPlainObject(r.pluginSettings)) return
      for (const [pluginId] of touched) {
        const stored = r.pluginSettings[pluginId]
        const schema = deps.projectSchemaOf(pluginId)
        if (schema !== undefined && isPlainObject(stored)) dropDefaultValues(schema, stored)
      }
    })
  }
  deps.app.update((a) => {
    a.projectDefaultsMigrated = true
  })
}
