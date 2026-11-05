// Task 33: "This project" in main: enabling plugins per project (the host restarts), the project
// settings form validated against the manifest, and the panel zone. Fakes for the registry,
// installer and layouts; the real settings validation (ajv).
import { describe, expect, it } from 'vitest'
import type { InstalledPlugin } from '../../src/main/plugins/installer'
import { ProjectSettingsService, type ProjectSettingsDeps } from '../../src/main/settings/project-settings-service'
import type { LayoutView } from '../../src/shared/ipc'
import { defaultLayout, type LayoutState } from '../../src/shared/layout'
import type { PluginManifest } from '../../src/shared/manifest'
import type { ProjectRecord, ProjectView } from '../../src/shared/types'

const P = 'aaaaaaaaaaaaaaaa'

function plugin(id: string, manifest: Partial<PluginManifest>, ok = true): InstalledPlugin {
  return {
    id,
    version: '1.0.0',
    source: { kind: 'linked', path: `/dev/${id}` },
    state: ok ? { ok: true } : { ok: false, reason: 'bad manifest' },
    dir: `/dev/${id}`,
    themes: [],
    ...(ok ? { manifest: { id, name: `Name of ${id}`, version: '1.0.0', api: 1, ...manifest } } : {})
  }
}

function rig() {
  const calls: string[] = []
  const record: ProjectView = {
    schemaVersion: 1,
    id: P,
    path: '/work/alpha',
    name: 'alpha',
    enabledPlugins: [],
    pluginSettings: {},
    layout: defaultLayout(),
    tabs: [],
    lastOpenedAt: 1,
    missing: false
  }
  const plugins = [
    plugin('test.jira', {
      contributes: {
        settings: {
          project: { type: 'object', properties: { board: { type: 'string', default: 'main' }, limit: { type: 'integer', minimum: 1 } } }
        }
      }
    }),
    plugin('test.mail', { contributes: {} }),
    plugin('test.broken', {}, false)
  ]
  let layoutView: LayoutView = {
    layout: {
      ...defaultLayout(),
      zones: {
        ...defaultLayout().zones,
        right: { collapsed: false, size: 320, panels: [{ panelKey: 'core/sessions', open: false, size: 240 }] }
      }
    },
    panels: [{ panelKey: 'core/sessions', title: 'Sessions', icon: 'S' }]
  }
  const settingsCheck: { value: { ok: true } | { ok: false; reason: string } } = { value: { ok: true } }
  // `app.json` › `pluginProjectDefaults`: the global values of project fields.
  const globals = new Map<string, unknown>()
  const deps: ProjectSettingsDeps = {
    projects: {
      get: (id) => (id === P ? record : undefined),
      update: (id, mutate) => {
        if (id !== P) return
        mutate(record as ProjectRecord)
        calls.push('update')
      }
    },
    plugins: { list: () => plugins, get: (id) => plugins.find((p) => p.id === id) },
    disabledBundled: () => undefined,
    checkSettings: () => settingsCheck.value,
    enabledChanged: async (id) => {
      calls.push(`enabledChanged ${id} [${record.enabledPlugins.join(',')}]`)
    },
    settingsChanged: async (id, pluginId) => {
      calls.push(`settingsChanged ${id} ${pluginId}`)
    },
    colorChanged: (id) => {
      calls.push(`colorChanged ${id} ${record.color ?? 'none'}`)
    },
    layouts: {
      view: () => layoutView,
      move: (id, panelKey, zone) => {
        calls.push(`move ${id} ${panelKey} ${String(zone)}`)
        return layoutView
      }
    },
    // Secret fields have their own tests (secret-settings.test.ts); none of these schemas has one.
    secrets: { hasSetting: () => false, settingsGuard: () => ({ removals: undefined, forgets: new Map() }), checkSettingsGuard: () => {}, writeSettings: async () => {} },
    projectDefaults: (id) => globals.get(id)
  }
  return {
    service: new ProjectSettingsService(deps),
    calls,
    record,
    globals,
    settingsCheck,
    setLayout: (layout: LayoutState, panels: LayoutView['panels']) => {
      layoutView = { layout, panels }
    }
  }
}

describe('view', () => {
  it('lists every installed plugin with whether this project runs it', () => {
    const { service, record } = rig()
    record.enabledPlugins = ['test.jira']
    const view = service.view(P)
    expect(view.name).toBe('alpha')
    expect(view.plugins.map((p) => [p.id, p.enabled, p.state.ok])).toEqual([
      ['test.jira', true, true],
      ['test.mail', false, true],
      ['test.broken', false, false]
    ])
    expect(view.plugins[2]!.state).toEqual({ ok: false, reason: 'bad manifest' })
  })

  it('carries no account data, even for a record that still holds old account choices', () => {
    const { service, record } = rig()
    record.enabledPlugins = ['test.jira']
    // A project file written before accounts left core: the key stays on disk, unread.
    ;(record as unknown as Record<string, unknown>).accounts = { 'test.jira/atlassian': 'atlassian:work' }
    for (const p of service.view(P).plugins) expect(p).not.toHaveProperty('accounts')
  })

  it('shows the project settings form with defaults filled in, and why stored values are invalid', () => {
    const { service, record } = rig()
    expect(service.view(P).plugins[0]!.projectSettings).toEqual({
      schema: expect.objectContaining({ type: 'object' }),
      values: { board: 'main' },
      overrides: []
    })
    record.pluginSettings['test.jira'] = { limit: 0 }
    const view = service.view(P).plugins[0]!.projectSettings!
    expect(view.values).toEqual({ limit: 0 })
    expect(view.problem).toContain('limit')
    expect(service.view(P).plugins[1]!.projectSettings).toBeUndefined()
  })

  it('says why an enabled plugin does not run, and only for an enabled one', () => {
    const { service, record, settingsCheck } = rig()
    settingsCheck.value = { ok: false, reason: 'invalid project settings: limit' }
    expect(service.view(P).plugins[0]!.problem).toBeUndefined()
    record.enabledPlugins = ['test.jira']
    expect(service.view(P).plugins[0]!.problem).toBe('invalid project settings: limit')
  })

  it('lists the panels with their zone, hidden ones as hidden', () => {
    const { service, setLayout } = rig()
    expect(service.view(P).panels).toEqual([{ panelKey: 'core/sessions', title: 'Sessions', zone: 'right' }])
    setLayout({ ...defaultLayout(), hidden: ['core/sessions'] }, [{ panelKey: 'core/sessions', title: 'Sessions' }])
    expect(service.view(P).panels[0]!.zone).toBe('hidden')
  })

  it("lists the project's new-tab menu entries, dropping damaged ones", () => {
    const { service, record } = rig()
    expect(service.view(P).tabCommands).toEqual([])
    ;(record as { tabCommands?: unknown }).tabCommands = [
      { id: 'd', label: 'Dev', command: 'npm run dev' },
      { id: 'n', label: 'Nul', command: 'echo \0' }
    ]
    expect(service.view(P).tabCommands).toEqual([{ id: 'd', label: 'Dev', command: 'npm run dev' }])
  })

  it('refuses a project whose record is gone', () => {
    expect(() => rig().service.view('ffffffffffffffff')).toThrow('record is gone')
  })
})

describe('setEnabled', () => {
  it('stores the plugin in the record and restarts the host with the new set', async () => {
    const { service, record, calls } = rig()
    await service.setEnabled(P, 'test.jira', true)
    expect(record.enabledPlugins).toEqual(['test.jira'])
    expect(calls).toEqual(['update', 'enabledChanged ' + P + ' [test.jira]'])
    await service.setEnabled(P, 'test.mail', true)
    await service.setEnabled(P, 'test.jira', false)
    expect(record.enabledPlugins).toEqual(['test.mail'])
    expect(calls.at(-1)).toBe(`enabledChanged ${P} [test.mail]`)
  })

  it('does nothing, and does not restart, when the state is already as asked', async () => {
    const { service, calls } = rig()
    await service.setEnabled(P, 'test.jira', false)
    expect(calls).toEqual([])
  })

  it('does not list a plugin twice', async () => {
    const { service, record } = rig()
    record.enabledPlugins = ['test.jira', 'test.jira']
    await service.setEnabled(P, 'test.jira', false)
    expect(record.enabledPlugins).toEqual([])
  })

  it('refuses to enable a plugin whose manifest is invalid, but can switch a stale one off', async () => {
    const { service, record } = rig()
    await expect(service.setEnabled(P, 'test.broken', true)).rejects.toThrow('cannot be enabled: bad manifest')
    expect(record.enabledPlugins).toEqual([])
    record.enabledPlugins = ['test.broken']
    await service.setEnabled(P, 'test.broken', false)
    expect(record.enabledPlugins).toEqual([])
  })

  it('refuses an unknown plugin and a payload of the wrong shape', async () => {
    const { service } = rig()
    await expect(service.setEnabled(P, 'no.such', true)).rejects.toThrow('unknown plugin')
    await expect(service.setEnabled(P, 5, true)).rejects.toThrow('give the plugin')
    await expect(service.setEnabled(P, 'test.jira', 'yes')).rejects.toThrow('give the plugin')
  })
})

describe('saveSettings', () => {
  it('validates against the manifest, stores only the overrides (no defaults filled in) and tells the host', async () => {
    const { service, record, calls } = rig()
    const result = await service.saveSettings(P, 'test.jira', { limit: 5 })
    expect(result).toEqual({ ok: true, values: { board: 'main', limit: 5 } })
    expect(record.pluginSettings['test.jira']).toEqual({ limit: 5 })
    expect(calls).toEqual(['update', `settingsChanged ${P} test.jira`])
  })

  it('merges the overrides over the global values: effective = override, else global, else default', async () => {
    const { service, record, globals } = rig()
    globals.set('test.jira', { board: 'team', limit: 3 })
    expect(service.view(P).plugins[0]!.projectSettings).toMatchObject({ values: { board: 'team', limit: 3 }, overrides: [] })
    const result = await service.saveSettings(P, 'test.jira', { limit: 9 })
    expect(result).toEqual({ ok: true, values: { board: 'team', limit: 9 } })
    expect(record.pluginSettings['test.jira']).toEqual({ limit: 9 })
    expect(service.view(P).plugins[0]!.projectSettings).toMatchObject({ values: { board: 'team', limit: 9 }, overrides: ['limit'] })
    // An object field is overridden whole, and a key the schema does not declare is no override.
    record.pluginSettings['test.jira'] = { extra: 1 }
    expect(service.view(P).plugins[0]!.projectSettings).toMatchObject({ values: { board: 'team', limit: 3, extra: 1 }, overrides: [] })
    expect(service.pluginProjectOverrides(P, 'test.jira')).toEqual({ extra: 1 })
  })

  it('checks the overrides merged with the global value, so a bad global value is refused through them too', async () => {
    const { service, record, globals } = rig()
    // Damaged global value: an override that does not replace it still fails the merged check.
    globals.set('test.jira', { limit: 0 })
    const result = await service.saveSettings(P, 'test.jira', { board: 'x' })
    expect(result.ok).toBe(false)
    expect(record.pluginSettings).toEqual({})
    // Overriding the bad field makes the effective values valid.
    await expect(service.saveSettings(P, 'test.jira', { limit: 2 })).resolves.toMatchObject({ ok: true, values: { board: 'main', limit: 2 } })
  })

  it('stores nothing and lists the reasons for values the schema refuses', async () => {
    const { service, record, calls } = rig()
    const result = await service.saveSettings(P, 'test.jira', { limit: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('limit')
    expect(record.pluginSettings).toEqual({})
    expect(calls).toEqual([])
  })

  it('replaces a damaged settings object in the record instead of writing into it', async () => {
    const { service, record } = rig()
    ;(record as { pluginSettings: unknown }).pluginSettings = ['x']
    await service.saveSettings(P, 'test.jira', { board: 'b' })
    expect(record.pluginSettings).toEqual({ 'test.jira': { board: 'b' } })
  })

  it('refuses a plugin without project settings, an unknown one, and values that are not an object', async () => {
    const { service } = rig()
    await expect(service.saveSettings(P, 'test.mail', {})).rejects.toThrow('declares no project settings')
    await expect(service.saveSettings(P, 'no.such', {})).rejects.toThrow('unknown plugin')
    await expect(service.saveSettings(P, 'test.jira', [1])).rejects.toThrow('must be an object')
    await expect(service.saveSettings(P, 'test.jira', 'x')).rejects.toThrow('must be an object')
  })

  it('refuses settings that are too large', async () => {
    const { service } = rig()
    await expect(service.saveSettings(P, 'test.jira', { board: 'x'.repeat(300_000) })).rejects.toThrow('too large')
  })
})

describe('movePanel', () => {
  it('asks the layouts to move the panel of this project', () => {
    const { service, calls } = rig()
    service.movePanel(P, 'core/sessions', 'bottom')
    expect(calls).toEqual([`move ${P} core/sessions bottom`])
  })

  it('refuses a payload that is not a panel key', () => {
    const { service } = rig()
    expect(() => service.movePanel(P, 4, 'left')).toThrow('give the panel')
  })

  it('refuses a project whose record is gone', () => {
    expect(() => rig().service.movePanel('ffffffffffffffff', 'core/sessions', 'left')).toThrow('record is gone')
  })
})

describe('setColor', () => {
  it('stores a palette colour or a hex (in lower case), clears with null, and tells the windows each time', () => {
    const { service, calls, record } = rig()
    expect(service.view(P)).not.toHaveProperty('color')
    expect(service.setColor(P, 'blue')).toBe('blue')
    expect(service.view(P).color).toBe('blue')
    expect(service.setColor(P, '#12ABef')).toBe('#12abef')
    expect(record.color).toBe('#12abef')
    expect(service.setColor(P, null)).toBeNull()
    expect(record).not.toHaveProperty('color')
    expect(calls).toEqual(['update', `colorChanged ${P} blue`, 'update', `colorChanged ${P} #12abef`, 'update', `colorChanged ${P} none`])
  })

  it('refuses anything else with the reason, and stores nothing', () => {
    const { service, calls, record } = rig()
    record.color = 'green'
    for (const bad of ['Blue', 'pink', '#fff', '#12abefaa', ' #12abef', '#12abeg', 'rgb(1,2,3)', 'var(--x)', '', 7, true, {}, undefined]) {
      expect(() => service.setColor(P, bad), String(bad)).toThrow(/project colour|palette colour/)
    }
    expect(record.color).toBe('green')
    expect(calls).toEqual([])
  })

  it('shows a damaged stored value as none', () => {
    const { service, record } = rig()
    record.color = 'url(evil)' as never
    expect(service.view(P)).not.toHaveProperty('color')
  })

  it('refuses a project whose record is gone', () => {
    const { service } = rig()
    expect(() => service.setColor('bbbbbbbbbbbbbbbb', 'red')).toThrow(/record is gone/)
  })
})
