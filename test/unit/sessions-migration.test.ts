// The one-time move of app.json's sessionFilesShown to cockpit.sessions' app setting (design-next §4.2).
import { describe, expect, it } from 'vitest'
import { migrateSessionFilesShown, needsSessionFilesMigration } from '../../src/main/settings/sessions-migration'

type App = { sessionFilesShown?: unknown; pluginSettings: Record<string, unknown> }
const run = (app: App): App => {
  migrateSessionFilesShown(app as never)
  return app
}

describe('sessionFilesShown migration', () => {
  it('copies a valid value to the plugin and drops the old key', () => {
    const app = run({ sessionFilesShown: 25, pluginSettings: { 'cockpit.files': { hideHidden: true } } })
    expect(app).toEqual({ pluginSettings: { 'cockpit.files': { hideHidden: true }, 'cockpit.sessions': { filesShown: 25 } } })
    expect(needsSessionFilesMigration(app as never)).toBe(false)
  })

  it('keeps the other plugin settings it already has', () => {
    const app = run({ sessionFilesShown: 3, pluginSettings: { 'cockpit.sessions': { other: 1 } } })
    expect(app.pluginSettings['cockpit.sessions']).toEqual({ other: 1, filesShown: 3 })
  })

  it("never overwrites the plugin's own filesShown, and still drops the old key", () => {
    const app = run({ sessionFilesShown: 3, pluginSettings: { 'cockpit.sessions': { filesShown: 40 } } })
    expect(app).toEqual({ pluginSettings: { 'cockpit.sessions': { filesShown: 40 } } })
  })

  it('drops a damaged value without copying it (the default applies)', () => {
    for (const bad of [0, 501, 2.5, '10', null]) {
      const app = run({ sessionFilesShown: bad, pluginSettings: {} })
      expect(app).toEqual({ pluginSettings: {} })
    }
  })

  it('replaces a damaged pluginSettings top level', () => {
    const app = run({ sessionFilesShown: 7, pluginSettings: 'junk' as never })
    expect(app.pluginSettings).toEqual({ 'cockpit.sessions': { filesShown: 7 } })
  })

  it('does nothing without the old key', () => {
    const app: App = { pluginSettings: { x: 1 } }
    expect(needsSessionFilesMigration(app as never)).toBe(false)
    expect(run(app)).toEqual({ pluginSettings: { x: 1 } })
  })
})
