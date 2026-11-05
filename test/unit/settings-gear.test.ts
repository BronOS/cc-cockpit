import { describe, expect, it } from 'vitest'
import { settingsGearOf } from '../../src/shared/settings-gear'

const schema = { type: 'object' }

describe('settingsGearOf (the panel gear target, design-next §5.3)', () => {
  it('has no gear for a plugin without settings', () => {
    expect(settingsGearOf({})).toBeUndefined()
    expect(settingsGearOf({ contributes: { settings: {} } })).toBeUndefined()
  })
  it('opens This Project for a project schema or a page with the project scope', () => {
    expect(settingsGearOf({ contributes: { settings: { project: schema } } })).toBe('project')
    expect(settingsGearOf({ contributes: { settings: { app: schema, project: schema } } })).toBe('project')
    expect(settingsGearOf({ contributes: { settings: { page: { entry: 'a.html', scopes: ['app', 'project'] } } } })).toBe('project')
  })
  it('opens the global page when there is nothing at project level', () => {
    expect(settingsGearOf({ contributes: { settings: { app: schema } } })).toBe('app')
    expect(settingsGearOf({ contributes: { settings: { page: { entry: 'a.html', scopes: ['app'] } } } })).toBe('app')
  })
})
