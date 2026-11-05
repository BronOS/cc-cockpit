// Task 32: what the settings overlay does in main: projects and plugins. The real settings
// validation (ajv) and fakes for the installer, the registry and the windows.
import { describe, expect, it } from 'vitest'
import type { InstalledPlugin } from '../../src/main/plugins/installer'
import { SettingsService, type SettingsDeps } from '../../src/main/settings/settings-service'
import { defaultLayout } from '../../src/shared/layout'
import type { PluginManifest } from '../../src/shared/manifest'
import type { ProjectRecord, ProjectView } from '../../src/shared/types'

function plugin(id: string, manifest: Partial<PluginManifest> & { contributes?: PluginManifest['contributes'] }, ok = true): InstalledPlugin {
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

function project(id: string, path: string, missing = false): ProjectView {
  return {
    schemaVersion: 1,
    id,
    path,
    name: path.split('/').pop() ?? path,
    enabledPlugins: [],
    pluginSettings: {},
    layout: defaultLayout(),
    tabs: [{ id: 't1', kind: 'shell', cwd: path }],
    lastOpenedAt: 1,
    missing
  }
}

interface Rig {
  service: SettingsService
  calls: string[]
  projects: Map<string, ProjectView>
  windowsOpen: Set<string>
  plugins: InstalledPlugin[]
  appSettings: Map<string, unknown>
  picked: { path: string | undefined; before?: () => void }
  deps: SettingsDeps
  bundledOff: { value: unknown }
}

function rig(): Rig {
  const calls: string[] = []
  const projects = new Map<string, ProjectView>([
    ['aaaaaaaaaaaaaaaa', project('aaaaaaaaaaaaaaaa', '/work/alpha')],
    ['bbbbbbbbbbbbbbbb', project('bbbbbbbbbbbbbbbb', '/work/gone', true)]
  ])
  const windowsOpen = new Set<string>(['aaaaaaaaaaaaaaaa'])
  const plugins: InstalledPlugin[] = [
    plugin('test.jira', {
      contributes: {
        settings: {
          app: { type: 'object', properties: { site: { type: 'string', default: 'example' }, pageSize: { type: 'integer', minimum: 1 } } }
        }
      }
    }),
    plugin('test.mail', { contributes: {} }),
    plugin('test.broken', { contributes: {} }, false)
  ]
  const appSettings = new Map<string, unknown>()
  const bundledOff: { value: unknown } = { value: undefined }
  const picked: Rig['picked'] = { path: '/work/new' }
  const deps: SettingsDeps = {
    projects: {
      list: () => [...projects.values()],
      get: (id) => projects.get(id),
      relink: (id, path) => {
        calls.push(`relink ${id} ${path}`)
        const p = projects.get(id)
        if (!p) throw new Error('unknown project')
        const next = { ...p, path, missing: false }
        projects.set(id, next)
        return next
      },
      forget: (id) => {
        calls.push(`forget ${id}`)
        projects.delete(id)
      },
      update: (id, mutate) => {
        const p = projects.get(id)
        if (!p) return
        const record: ProjectRecord = { ...p }
        mutate(record)
        calls.push(`update ${id} tabs=${record.tabs.length}`)
      }
    },
    hasWindow: (id) => windowsOpen.has(id),
    openProjectPath: (path) => {
      calls.push(`open ${path}`)
    },
    pickFolder: async () => {
      picked.before?.()
      return picked.path
    },
    plugins: {
      applyRevocations: async () => {},
      list: () => plugins,
      get: (id) => plugins.find((p) => p.id === id),
      install: async () => {
        throw new Error('unused')
      },
      link: async (folder: string) => {
        calls.push(`link ${folder}`)
        return plugins[0]!
      },
      update: async () => plugins[0]!,
      uninstall: async (id: string) => {
        calls.push(`uninstall ${id}`)
      }
    },
    marketplace: { list: () => [], refresh: async () => {}, revocationFor: () => null, revocationWarnings: () => [], prune: () => {}, preview: async () => null },
    setMarketplaceUrls: () => {},
    pluginRepos: { get: () => undefined, set: () => {} },
    disableEverywhere: () => {},
    enabledInAProject: () => false,
    appPluginSettings: {
      get: (id) => appSettings.get(id),
      set: (id, value) => {
        appSettings.set(id, value)
      }
    },
    bundledOff: {
      get: () => bundledOff.value,
      set: (ids) => {
        bundledOff.value = ids
        calls.push(`bundledOff [${ids.join(',')}]`)
      }
    },
    bundledOffChanged: async (id) => {
      calls.push(`bundledOffChanged ${id}`)
    },
    pluginSettingsChanged: async () => {
      calls.push('pluginSettingsChanged')
    },
    // Secret fields have their own tests (secret-settings.test.ts); none of these schemas has one.
    secrets: { hasSetting: () => false, settingsGuard: () => ({ removals: undefined, forgets: new Map() }), checkSettingsGuard: () => {}, writeSettings: async () => {} },
    projectDefaults: { get: () => undefined, set: () => {} },
    openProjectIds: () => [...windowsOpen],
    settingsFingerprint: () => '',
    projectSettingsChanged: async () => {}
  }
  return { service: new SettingsService(deps), calls, projects, windowsOpen, plugins, appSettings, picked, deps, bundledOff }
}

describe('projects', () => {
  it('lists every project with whether a window shows it', () => {
    const { service } = rig()
    expect(service.projects()).toEqual([
      { id: 'aaaaaaaaaaaaaaaa', name: 'alpha', path: '/work/alpha', missing: false, open: true },
      { id: 'bbbbbbbbbbbbbbbb', name: 'gone', path: '/work/gone', missing: true, open: false }
    ])
  })

  it('opens a project that exists and refuses a missing or unknown one', () => {
    const { service, calls } = rig()
    service.openProject('aaaaaaaaaaaaaaaa')
    expect(calls).toEqual(['open /work/alpha'])
    expect(() => service.openProject('bbbbbbbbbbbbbbbb')).toThrow(/missing/)
    expect(() => service.openProject('nope')).toThrow(/unknown project/)
    expect(() => service.openProject({ id: 'x' })).toThrow(/unknown project/)
  })

  it('relinks a missing project without a window and drops its saved tabs', async () => {
    const { service, calls } = rig()
    await expect(service.relinkProject(7, 'bbbbbbbbbbbbbbbb')).resolves.toBe(true)
    expect(calls).toEqual(['relink bbbbbbbbbbbbbbbb /work/new', 'update bbbbbbbbbbbbbbbb tabs=0'])
  })

  it('answers false when the folder dialog is cancelled and changes nothing', async () => {
    const { service, calls, picked } = rig()
    picked.path = undefined
    await expect(service.relinkProject(7, 'bbbbbbbbbbbbbbbb')).resolves.toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses to relink a project whose folder is fine or that has a window', async () => {
    const { service, windowsOpen, projects } = rig()
    await expect(service.relinkProject(7, 'aaaaaaaaaaaaaaaa')).rejects.toThrow(/not missing/)
    windowsOpen.add('bbbbbbbbbbbbbbbb')
    await expect(service.relinkProject(7, 'bbbbbbbbbbbbbbbb')).rejects.toThrow(/has a window/)
    expect(projects.get('bbbbbbbbbbbbbbbb')?.path).toBe('/work/gone')
  })

  it('looks again after the dialog: a window opened meanwhile blocks the relink', async () => {
    const { service, calls, windowsOpen, picked } = rig()
    picked.before = () => windowsOpen.add('bbbbbbbbbbbbbbbb')
    await expect(service.relinkProject(7, 'bbbbbbbbbbbbbbbb')).rejects.toThrow(/has a window/)
    expect(calls).toEqual([])
  })

  it('removes a project without a window; one with a window is refused', () => {
    const { service, calls } = rig()
    expect(() => service.removeProject('aaaaaaaaaaaaaaaa')).toThrow(/close it first/)
    service.removeProject('bbbbbbbbbbbbbbbb')
    expect(calls).toEqual(['forget bbbbbbbbbbbbbbbb'])
    expect(() => service.removeProject('bbbbbbbbbbbbbbbb')).toThrow(/unknown project/)
  })
})

describe('plugins', () => {
  it('lists plugins with the reason a disabled one is disabled and the app settings form data', () => {
    const { service } = rig()
    const list = service.plugins()
    const jira = list.find((p) => p.id === 'test.jira')!
    expect(jira.name).toBe('Name of test.jira')
    expect(jira.source).toEqual({ kind: 'linked', path: '/dev/test.jira' })
    // Defaults applied for the form.
    expect(jira.appSettings?.values).toEqual({ site: 'example' })
    expect(jira.appSettings?.problem).toBeUndefined()
    const broken = list.find((p) => p.id === 'test.broken')!
    expect(broken.state).toEqual({ ok: false, reason: 'bad manifest' })
    expect(broken.appSettings).toBeUndefined()
    expect(list.find((p) => p.id === 'test.mail')?.appSettings).toBeUndefined()
  })

  it('shows stored app settings that do not validate with the problem, not a crash', () => {
    const { service, appSettings } = rig()
    appSettings.set('test.jira', { pageSize: 0 })
    const jira = service.plugins().find((p) => p.id === 'test.jira')!
    expect(jira.appSettings?.values).toEqual({ pageSize: 0 })
    expect(jira.appSettings?.problem).toMatch(/pageSize/)
  })

  it('saves valid app settings with defaults applied and tells the hosts', async () => {
    const { service, appSettings, calls } = rig()
    const result = await service.savePluginSettings('test.jira', { pageSize: 25 })
    expect(result).toEqual({ ok: true, values: { site: 'example', pageSize: 25 } })
    expect(appSettings.get('test.jira')).toEqual({ site: 'example', pageSize: 25 })
    expect(calls).toEqual(['pluginSettingsChanged'])
  })

  it('rejects settings the manifest schema refuses and stores nothing', async () => {
    const { service, appSettings, calls } = rig()
    const result = await service.savePluginSettings('test.jira', { pageSize: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/pageSize/)
    // A form that sent the wrong type is refused by main whatever the renderer thought.
    const typed = await service.savePluginSettings('test.jira', { site: 5 })
    expect(typed.ok).toBe(false)
    expect(appSettings.size).toBe(0)
    expect(calls).toEqual([])
  })

  it('refuses settings for an unknown plugin, one without an app schema, and non-objects', async () => {
    const { service } = rig()
    await expect(service.savePluginSettings('nope', {})).rejects.toThrow(/unknown plugin/)
    await expect(service.savePluginSettings('test.broken', {})).rejects.toThrow(/unknown plugin/)
    await expect(service.savePluginSettings('test.mail', {})).rejects.toThrow(/no app-wide settings/)
    await expect(service.savePluginSettings('test.jira', [])).rejects.toThrow(/object/)
    await expect(service.savePluginSettings('test.jira', { big: 'x'.repeat(300_000) })).rejects.toThrow(/too large/)
    await expect(service.savePluginSettings(5, {})).rejects.toThrow(/unknown plugin/)
  })

  it('links the folder the dialog returned and does nothing when it is cancelled', async () => {
    const { service, calls, picked } = rig()
    await expect(service.linkPlugin(3)).resolves.toBe(true)
    picked.path = undefined
    await expect(service.linkPlugin(3)).resolves.toBe(false)
    expect(calls).toEqual(['link /work/new'])
  })

  it('checks the types of install, update and uninstall input before the installer sees it', async () => {
    const { service } = rig()
    await expect(service.installPlugin(5, 'v1')).rejects.toThrow(/git URL/)
    await expect(service.updatePlugin('test.jira', undefined)).rejects.toThrow(/tag/)
    await expect(service.uninstallPlugin({})).rejects.toThrow(/plugin/)
  })
})

describe('seesAllSessions (the access declaration)', () => {
  it('is on the view only for a valid plugin that declares access.sessions all-windows', () => {
    const r = rig()
    r.plugins.push(plugin('test.all', { access: { sessions: 'all-windows' } }))
    r.plugins.push(plugin('test.bad', { access: { sessions: 'all-windows' } }, false))
    expect(r.service.plugins().find((p) => p.id === 'test.all')?.seesAllSessions).toBe(true)
    expect(r.service.plugins().find((p) => p.id === 'test.mail')).not.toHaveProperty('seesAllSessions')
    expect(r.service.plugins().find((p) => p.id === 'test.bad')).not.toHaveProperty('seesAllSessions')
  })
})

describe('off in all projects (bundled plugins)', () => {
  const BID = 'cockpit.editor'
  function withBundled(): Rig {
    const r = rig()
    r.plugins.push({ ...plugin(BID, {}), source: { kind: 'bundled', path: '/app/plugins/editor' }, enabledByDefault: true })
    return r
  }

  it('the view carries the switch for a bundled plugin only', () => {
    const r = withBundled()
    expect(r.service.plugins().find((p) => p.id === BID)?.offInAllProjects).toBe(false)
    expect(r.service.plugins().find((p) => p.id === 'test.jira')).not.toHaveProperty('offInAllProjects')
    r.bundledOff.value = [BID]
    expect(r.service.plugins().find((p) => p.id === BID)?.offInAllProjects).toBe(true)
  })

  it('stores the list and restarts the affected hosts; the same value again does nothing', async () => {
    const r = withBundled()
    await r.service.setBundledOff(BID, true)
    expect(r.calls).toEqual([`bundledOff [${BID}]`, `bundledOffChanged ${BID}`])
    await r.service.setBundledOff(BID, true)
    expect(r.calls).toHaveLength(2)
    await r.service.setBundledOff(BID, false)
    expect(r.calls.slice(2)).toEqual(['bundledOff []', `bundledOffChanged ${BID}`])
    await r.service.setBundledOff(BID, false)
    expect(r.calls).toHaveLength(4)
  })

  it('keeps the other ids and drops what a hand-edited app.json put there that is not a string', async () => {
    const r = withBundled()
    r.bundledOff.value = ['cockpit.browser', 7, 'cockpit.browser', null]
    await r.service.setBundledOff(BID, true)
    expect(r.bundledOff.value).toEqual(['cockpit.browser', BID])
    r.bundledOff.value = 'damaged'
    await r.service.setBundledOff(BID, true)
    expect(r.bundledOff.value).toEqual([BID])
  })

  it('refuses a plugin that is not bundled, an unknown one and bad input, storing nothing', async () => {
    const r = withBundled()
    await expect(r.service.setBundledOff('test.jira', true)).rejects.toThrow(/not built in/)
    await expect(r.service.setBundledOff('nope.gone', true)).rejects.toThrow(/unknown plugin/)
    await expect(r.service.setBundledOff(BID, 'yes')).rejects.toThrow(/on or off/)
    await expect(r.service.setBundledOff(5, true)).rejects.toThrow(/on or off/)
    expect(r.calls).toEqual([])
    expect(r.bundledOff.value).toBeUndefined()
  })
})
