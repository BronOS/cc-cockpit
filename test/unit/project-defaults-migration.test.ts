// design-next §5.2 migration: stored project values equal to their schema default become "use
// global" (dropped), every other value stays an override; runs once.
import { describe, expect, it } from 'vitest'
import { dropDefaultValues, migrateProjectDefaults } from '../../src/main/settings/project-defaults-migration'
import { defaultLayout } from '../../src/shared/layout'
import type { JsonSchema } from '../../src/shared/manifest'
import type { AppSettings, ProjectRecord, ProjectView } from '../../src/shared/types'

const schema: JsonSchema = {
  type: 'object',
  properties: {
    board: { type: 'string', default: 'main' },
    limit: { type: 'integer', default: 10 },
    tags: { type: 'array', items: { type: 'string' }, default: ['a', 'b'] },
    note: { type: 'string' }
  }
}

function record(id: string, pluginSettings: Record<string, unknown>): ProjectView {
  return {
    schemaVersion: 1,
    id,
    path: `/work/${id}`,
    name: id,
    enabledPlugins: [],
    pluginSettings,
    layout: defaultLayout(),
    tabs: [],
    lastOpenedAt: 1,
    missing: false
  }
}

function rig(records: ProjectView[]) {
  const app: { data: AppSettings } = {
    data: { schemaVersion: 1, openProjects: [], recentProjects: [], keyOverrides: {}, pluginSettings: {} }
  }
  const updates: string[] = []
  const map = new Map(records.map((r) => [r.id, r]))
  const deps = {
    app: { data: app.data, update: (mutate: (a: AppSettings) => void) => mutate(app.data) },
    projects: {
      list: () => [...map.values()].map((r) => structuredClone(r)),
      update: (id: string, mutate: (r: ProjectRecord) => void) => {
        updates.push(id)
        const r = map.get(id)
        if (r) mutate(r)
      }
    },
    projectSchemaOf: (pluginId: string) => (pluginId === 'test.jira' ? schema : undefined)
  }
  return { deps, app, map, updates }
}

describe('dropDefaultValues', () => {
  it('drops values deep-equal to their default and keeps the rest', () => {
    const stored = { board: 'main', limit: 5, tags: ['a', 'b'], note: 'x', extra: 1 }
    expect(dropDefaultValues(schema, stored)).toBe(true)
    expect(stored).toEqual({ limit: 5, note: 'x', extra: 1 })
    expect(dropDefaultValues(schema, stored)).toBe(false)
    expect(dropDefaultValues({ type: 'object' }, { a: 1 })).toBe(false)
  })
})

describe('migrateProjectDefaults', () => {
  it('drops default values per project and installed plugin, keeps overrides, and runs once', () => {
    const { deps, app, map, updates } = rig([
      record('p1', { 'test.jira': { board: 'main', limit: 10, note: 'kept' }, 'test.gone': { board: 'main' } }),
      record('p2', { 'test.jira': { board: 'dev' } }),
      record('p3', { 'test.jira': 'damaged' })
    ])
    migrateProjectDefaults(deps)
    expect(map.get('p1')!.pluginSettings).toEqual({ 'test.jira': { note: 'kept' }, 'test.gone': { board: 'main' } })
    expect(map.get('p2')!.pluginSettings).toEqual({ 'test.jira': { board: 'dev' } })
    expect(map.get('p3')!.pluginSettings).toEqual({ 'test.jira': 'damaged' })
    // Only the record that changed is written.
    expect(updates).toEqual(['p1'])
    expect(app.data.projectDefaultsMigrated).toBe(true)

    // A second start changes nothing, even a value that now equals a default.
    map.get('p2')!.pluginSettings['test.jira'] = { board: 'main' }
    migrateProjectDefaults(deps)
    expect(map.get('p2')!.pluginSettings).toEqual({ 'test.jira': { board: 'main' } })
    expect(updates).toEqual(['p1'])
  })
})
