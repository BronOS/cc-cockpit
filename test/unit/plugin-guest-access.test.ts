// Task 04 (design-guests §6, §16.1, §16.2): which plugins guests see. The values live in app.json and the
// project records (a real ProjectRegistry in a temp dir); the rule is shared/guest-access.ts, fed by
// PluginGuestAccessStore; the settings service shows it on each plugin row, stores it and drops it on
// uninstall.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstalledPlugin } from '../../src/main/plugins/installer'
import { ProjectRegistry } from '../../src/main/projects/registry'
import { PluginGuestAccessStore } from '../../src/main/settings/plugin-guest-access'
import { SettingsService, type SettingsDeps } from '../../src/main/settings/settings-service'
import type { PluginManifest } from '../../src/shared/manifest'

let root: string
let registry: ProjectRegistry
let p1: string
let p2: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-guest-access-')))
  registry = new ProjectRegistry({ dataDir: join(root, 'data'), log: () => {} })
  for (const name of ['one', 'two']) mkdirSync(join(root, name))
  p1 = registry.openPath(join(root, 'one')).id
  p2 = registry.openPath(join(root, 'two')).id
})

afterEach(() => {
  registry.flushAll()
  rmSync(root, { recursive: true, force: true })
})

function plugin(id: string, manifest: Partial<PluginManifest> = {}, source: InstalledPlugin['source'] = { kind: 'linked', path: `/dev/${id}` }): InstalledPlugin {
  return {
    id,
    version: '1.0.0',
    source,
    state: { ok: true },
    dir: `/dev/${id}`,
    themes: [],
    manifest: { id, name: id, version: '1.0.0', api: 1, ...manifest }
  }
}

const PLUGINS = [
  plugin('test.mail'),
  plugin('test.team', { guests: { aware: true } }),
  plugin('cockpit.files', {}, { kind: 'bundled', path: '/app/plugins/files' }),
  plugin('test.all', { access: { sessions: 'all-windows' } })
]

function store(): PluginGuestAccessStore {
  return new PluginGuestAccessStore({
    records: registry,
    installed: (id) => PLUGINS.find((p) => p.id === id),
    knownProject: (id) => registry.get(id) !== undefined
  })
}

describe('PluginGuestAccessStore', () => {
  it('hides every plugin by default, bundled ones included; app value, then project override', () => {
    const s = store()
    expect(s.visible(p1, 'test.mail')).toBe(false)
    expect(s.visible(p1, 'cockpit.files')).toBe(false)
    expect(s.view('cockpit.files', p1)).toEqual({ effective: 'hidden', source: 'default', aware: false })
    expect(s.set('test.mail', 'app', 'shown')).toBe(true)
    expect(s.visible(p1, 'test.mail')).toBe(true)
    expect(s.visible(p2, 'test.mail')).toBe(true)
    expect(s.set('test.mail', 'project', 'hidden', p2)).toBe(true)
    expect(s.visible(p2, 'test.mail')).toBe(false)
    expect(s.view('test.mail', p2)).toEqual({ effective: 'hidden', source: 'project', aware: false, appValue: 'shown', projectValue: 'hidden' })
    // null: back to the global value.
    expect(s.set('test.mail', 'project', null, p2)).toBe(true)
    expect(s.visible(p2, 'test.mail')).toBe(true)
  })

  it('gives read guests a one-way port unless the plugin is guest-aware; write guests full; hidden none', () => {
    const s = store()
    expect(s.port(p1, 'test.mail', 'read')).toBe('none')
    s.set('test.mail', 'app', 'shown')
    s.set('test.team', 'app', 'shown')
    expect(s.port(p1, 'test.mail', 'read')).toBe('oneWay')
    expect(s.port(p1, 'test.mail', 'write')).toBe('full')
    expect(s.port(p1, 'test.team', 'read')).toBe('full')
    expect(s.port(p1, 'test.unknown', 'write')).toBe('none')
  })

  it('keeps a plugin that sees every window hidden whatever the owner sets', () => {
    const s = store()
    expect(s.set('test.all', 'app', 'shown')).toBe(true)
    expect(s.visible(p1, 'test.all')).toBe(false)
    expect(s.view('test.all', p1)).toMatchObject({ effective: 'hidden', blocked: 'all-windows', appValue: 'shown' })
  })

  it('refuses an unknown plugin, project or value; tells listeners only of a real change', () => {
    const s = store()
    let changes = 0
    s.onChange(() => changes++)
    expect(s.set('test.nope', 'app', 'shown')).toBe(false)
    expect(s.set('test.mail', 'project', 'shown', 'ffffffffffffffff')).toBe(false)
    expect(s.set('test.mail', 'project', 'shown')).toBe(false)
    expect(s.set('test.mail', 'app', 'public' as never)).toBe(false)
    expect(changes).toBe(0)
    s.set('test.mail', 'app', 'shown')
    s.set('test.mail', 'app', 'shown')
    expect(changes).toBe(1)
  })

  it('reads a damaged stored value as absent', () => {
    registry.app.update((a) => void (a.pluginGuestAccess = { 'test.mail': 'yes', 'test.team': 'shown' }))
    registry.update(p1, (r) => void (r.pluginGuestAccess = 'junk' as never))
    const s = store()
    expect(s.visible(p1, 'test.mail')).toBe(false)
    expect(s.visible(p1, 'test.team')).toBe(true)
  })

  it('drops the values everywhere on uninstall, so a reinstall starts hidden', () => {
    const s = store()
    s.set('test.mail', 'app', 'shown')
    s.set('test.mail', 'project', 'shown', p1)
    s.set('test.team', 'app', 'shown')
    s.drop('test.mail')
    expect(registry.pluginGuestAccess('app')).toEqual({ 'test.team': 'shown' })
    expect(registry.pluginGuestAccess({ projectId: p1 })).toEqual({})
    registry.flushAll()
    const reread = new ProjectRegistry({ dataDir: join(root, 'data'), log: () => {} })
    expect(reread.pluginGuestAccess('app')).toEqual({ 'test.team': 'shown' })
    expect(reread.get(p1)?.pluginGuestAccess).toBeUndefined()
  })
})

describe('SettingsService: guest visibility on the Plugins page', () => {
  function service(): { service: SettingsService; uninstalled: string[] } {
    const uninstalled: string[] = []
    const deps = {
      plugins: {
        list: () => PLUGINS,
        get: (id: string) => PLUGINS.find((p) => p.id === id),
        uninstall: async (id: string) => void uninstalled.push(id)
      },
      bundledOff: { get: () => undefined },
      appPluginSettings: { get: () => undefined },
      projectDefaults: { get: () => undefined },
      secrets: { settingState: () => 'unset' },
      pluginRepos: { get: () => undefined, set: () => {} },
      guestAccess: store()
    }
    return { service: new SettingsService(deps as unknown as SettingsDeps), uninstalled }
  }

  it("shows each row's visibility for the asking project, and stores a change from the row", () => {
    const { service: s } = service()
    expect(s.plugins(p1).find((p) => p.id === 'test.mail')?.guestAccess).toEqual({ effective: 'hidden', source: 'default', aware: false })
    const row = s.setPluginGuestAccess(p1, { pluginId: 'test.mail', target: 'project', value: 'shown' })
    expect(row.guestAccess).toEqual({ effective: 'shown', source: 'project', aware: false, projectValue: 'shown' })
    // The global page (no project): the app value only.
    expect(s.plugins().find((p) => p.id === 'test.mail')?.guestAccess).toEqual({ effective: 'hidden', source: 'default', aware: false })
    expect(s.plugins(p2).find((p) => p.id === 'test.mail')?.guestAccess?.effective).toBe('hidden')
  })

  it('refuses a malformed request', () => {
    const { service: s } = service()
    expect(() => s.setPluginGuestAccess(p1, { pluginId: 'test.mail', target: 'everywhere', value: 'shown' })).toThrow()
    expect(() => s.setPluginGuestAccess(p1, { pluginId: 'test.mail', target: 'app', value: 'visible' })).toThrow()
    expect(() => s.setPluginGuestAccess(p1, { pluginId: 'test.nope', target: 'app', value: 'shown' })).toThrow('unknown plugin')
    expect(() => s.setPluginGuestAccess(p1, null)).toThrow()
  })

  it('drops the value when the plugin is uninstalled', async () => {
    const { service: s, uninstalled } = service()
    s.setPluginGuestAccess(p1, { pluginId: 'test.mail', target: 'app', value: 'shown' })
    await s.uninstallPlugin('test.mail')
    expect(uninstalled).toEqual(['test.mail'])
    expect(registry.pluginGuestAccess('app')).toEqual({})
  })
})
