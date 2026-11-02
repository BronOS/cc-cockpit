// Bundled plugins (Claude-operable foundation, Task 9): indexed at every start from a fixed
// allowlist, validated like any plugin, never copied or uninstalled, default-on per project with a
// stored opt-out, first in the CLI name-clash order. Real installer over temp dirs; no Electron.
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUNDLED_PLUGINS, bundledPluginSpecs, bundledRoot, type BundledPluginSpec } from '../../src/main/plugins/bundled'
import { enabledPluginIds, pluginEnabledIn } from '../../src/main/plugins/enablement'
import { PluginInstaller, type InstalledPlugin } from '../../src/main/plugins/installer'
import { PluginIndex } from '../../src/main/plugins/plugin-index'
import { ProjectSettingsService, type ProjectSettingsDeps } from '../../src/main/settings/project-settings-service'
import { ThemeService } from '../../src/main/themes/theme-service'
import { defaultLayout } from '../../src/shared/layout'
import type { ProjectRecord, ProjectView } from '../../src/shared/types'

const FIXTURES = join(__dirname, '..', 'fixtures', 'plugins')
const BID = 'cockpit.browser'

let dataDir: string
let work: string[]
let logs: string[]

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-bundled-')))
  work = []
  logs = []
})
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  for (const w of work) rmSync(w, { recursive: true, force: true })
})

/** A bundled folder: the `good` fixture under `id`, optionally declaring cli names and a version. */
function bundledFolder(id = BID, cli: string[] = [], version = '1.0.0'): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-bundled-src-')))
  work.push(folder)
  cpSync(join(FIXTURES, 'good'), folder, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(folder, 'plugin.json'), 'utf8')) as Record<string, unknown>
  writeFileSync(
    join(folder, 'plugin.json'),
    JSON.stringify({
      ...manifest,
      id,
      version,
      contributes: { cli: cli.map((name) => ({ name, summary: `the ${name} command` })) }
    })
  )
  return folder
}

function spec(dir: string, id = BID, enabledByDefault = true): BundledPluginSpec {
  return { id, dir, enabledByDefault }
}

function newInstaller(bundled: BundledPluginSpec[] | undefined): { installer: PluginInstaller; index: PluginIndex } {
  const index = new PluginIndex({ filePath: join(dataDir, 'plugins.json'), log: (m) => logs.push(m) })
  const installer = new PluginInstaller({
    dataDir,
    index,
    themes: new ThemeService({ settings: { data: {}, save: () => {} }, isDark: () => false, onChange: () => {} }),
    env: () => ({}),
    log: (m) => logs.push(m),
    ...(bundled !== undefined ? { bundled } : {})
  })
  return { installer, index }
}

/** A fresh process: new index and installer over the same data dir. */
async function restart(bundled: BundledPluginSpec[] | undefined) {
  const r = newInstaller(bundled)
  await r.installer.load()
  return r
}

function linkedFolder(id: string, cli: string[]): string {
  return bundledFolder(id, cli)
}

describe('allowlist and the test switch', () => {
  it('ships the browser, reviewer and editor plugins, on by default', () => {
    const all = [
      { id: BID, dir: 'browser', enabledByDefault: true },
      { id: 'cockpit.reviewer', dir: 'reviewer', enabledByDefault: true },
      { id: 'cockpit.editor', dir: 'editor', enabledByDefault: true }
    ]
    expect(BUNDLED_PLUGINS).toEqual(all)
    expect(bundledPluginSpecs('/r', {}, false)).toEqual(all.map((p) => ({ ...p, dir: join('/r', p.dir) })))
  })

  it('finds the folder in the repo (dev) or in resources (packaged)', () => {
    expect(bundledRoot(false, '/repo', '/res')).toBe(join('/repo', 'plugins'))
    expect(bundledRoot(true, '/App/app.asar', '/res')).toBe(join('/res', 'plugins'))
  })

  it('CC_COCKPIT_NO_BUNDLED=1 turns them off only in a test run', () => {
    const off = { CC_COCKPIT_TEST: '1', CC_COCKPIT_NO_BUNDLED: '1' }
    expect(bundledPluginSpecs('/r', off, false)).toEqual([])
    // Without CC_COCKPIT_TEST the switch means nothing, and a packaged app ignores it too.
    expect(bundledPluginSpecs('/r', { CC_COCKPIT_NO_BUNDLED: '1' }, false)).toHaveLength(BUNDLED_PLUGINS.length)
    expect(bundledPluginSpecs('/r', off, true)).toHaveLength(BUNDLED_PLUGINS.length)
    expect(bundledPluginSpecs('/r', { CC_COCKPIT_TEST: '1' }, false)).toHaveLength(BUNDLED_PLUGINS.length)
  })
})

describe('indexing', () => {
  it('records a bundled plugin at every start, validated, never copied', async () => {
    const dir = bundledFolder()
    const { installer, index } = await restart([spec(dir)])
    const entry = index.get(BID)
    expect(entry).toMatchObject({
      id: BID,
      version: '1.0.0',
      source: { kind: 'bundled', path: dir },
      state: { ok: true },
      enabledByDefault: true
    })
    const got = installer.get(BID)
    expect(got?.dir).toBe(dir)
    expect(got?.manifest?.id).toBe(BID)
    // Nothing was copied into <data>/plugins.
    expect(() => readFileSync(join(dataDir, 'plugins', `${BID}@1.0.0`, 'plugin.json'))).toThrow()
    // And it is in plugins.json for the next start.
    expect(new PluginIndex({ filePath: join(dataDir, 'plugins.json'), log: () => {} }).get(BID)?.enabledByDefault).toBe(true)
  })

  it('follows the folder: a new app version moves the recorded version', async () => {
    const dir = bundledFolder()
    await restart([spec(dir)])
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...manifest, version: '2.0.0' }))
    const { index } = await restart([spec(dir)])
    expect(index.get(BID)).toMatchObject({ version: '2.0.0', state: { ok: true } })
  })

  it('keeps a bundled plugin whose manifest is invalid as a disabled entry with the reason', async () => {
    const dir = bundledFolder()
    writeFileSync(join(dir, 'plugin.json'), '{ not json')
    const { installer } = await restart([spec(dir)])
    const got = installer.get(BID)
    expect(got?.state.ok).toBe(false)
    expect(got?.manifest).toBeUndefined()
    expect(logs.join('\n')).toMatch(/disabled/)
    // It can be repaired by the next start.
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id: BID, name: 'B', version: '1.0.1', api: 1 }))
    expect((await restart([spec(dir)])).installer.get(BID)?.state).toEqual({ ok: true })
  })

  it('disables a bundled folder that declares another id', async () => {
    const dir = bundledFolder('test.other')
    const { installer } = await restart([spec(dir)])
    const state = installer.get(BID)?.state
    expect(state?.ok === false && state.reason).toMatch(/plugin\.json now has id "test\.other"/)
  })

  it('skips a missing folder and drops entries of bundled plugins no longer shipped', async () => {
    const dir = bundledFolder()
    await restart([spec(dir)])
    // Not shipped any more (or switched off by the test switch): the entry goes.
    expect((await restart([])).index.get(BID)).toBeUndefined()
    await restart([spec(dir)])
    expect((await restart([spec(join(dataDir, 'nowhere'))])).index.get(BID)).toBeUndefined()
    expect(logs.join('\n')).toMatch(/is missing/)
  })

  it('load survives a stale bundled entry whose removal failed (read-only plugins.json)', async () => {
    const dir = bundledFolder()
    await restart([spec(dir)])
    const { installer, index } = newInstaller([])
    index.remove = () => {
      throw new Error('EROFS')
    }
    await expect(installer.load()).resolves.toBeUndefined()
    expect(index.get(BID)).toBeDefined()
  })

  it('does not take an id a person installed another way', async () => {
    const mine = linkedFolder(BID, [])
    const first = newInstaller(undefined)
    await first.installer.load()
    await first.installer.link(mine)
    const dir = bundledFolder()
    const { index } = await restart([spec(dir)])
    expect(index.get(BID)?.source).toEqual({ kind: 'linked', path: mine })
    expect(logs.join('\n')).toMatch(/already installed from a linked source/)
  })
})

describe('enabledByDefault', () => {
  it('is only honoured for a bundled source', () => {
    const file = join(dataDir, 'plugins.json')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          { id: 'test.git', version: '1.0.0', source: { kind: 'git', url: 'https://x.invalid/a.git', tag: 'v1' }, state: { ok: true }, enabledByDefault: true },
          { id: 'test.linked', version: '1.0.0', source: { kind: 'linked', path: '/dev/a' }, state: { ok: true }, enabledByDefault: true },
          { id: BID, version: '1.0.0', source: { kind: 'bundled', path: '/app/browser' }, state: { ok: true }, enabledByDefault: true }
        ]
      })
    )
    const index = new PluginIndex({ filePath: file, log: () => {} })
    expect(index.get('test.git')).not.toHaveProperty('enabledByDefault')
    expect(index.get('test.linked')).not.toHaveProperty('enabledByDefault')
    expect(index.get(BID)?.enabledByDefault).toBe(true)
  })

  it('a manifest cannot claim it: only the allowlist decides', async () => {
    const dir = bundledFolder()
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as Record<string, unknown>
    writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ ...manifest, enabledByDefault: true }))
    const { index } = await restart([spec(dir, BID, false)])
    expect(index.get(BID)?.enabledByDefault).toBeUndefined()
  })

  it('a linked entry holding a bundled id gets no default-on', async () => {
    const first = newInstaller(undefined)
    await first.installer.load()
    await first.installer.link(linkedFolder(BID, []))
    const { index } = await restart([spec(bundledFolder())])
    const entry = index.get(BID)
    expect(entry?.enabledByDefault).toBeUndefined()
    expect(pluginEnabledIn({ enabledPlugins: [] }, { id: BID, enabledByDefault: entry?.enabledByDefault })).toBe(false)
  })

  it('on for a record that never heard of it, off once listed in disabledPlugins, on again when enabled', () => {
    const p = { id: BID, enabledByDefault: true }
    const plain = { id: 'test.jira' }
    expect(pluginEnabledIn({ enabledPlugins: [] }, p)).toBe(true)
    expect(pluginEnabledIn({ enabledPlugins: [], disabledPlugins: [BID] }, p)).toBe(false)
    expect(pluginEnabledIn({ enabledPlugins: [BID], disabledPlugins: [BID] }, p)).toBe(true)
    expect(pluginEnabledIn({ enabledPlugins: [] }, plain)).toBe(false)
    expect(pluginEnabledIn({ enabledPlugins: ['test.jira'] }, plain)).toBe(true)
    expect(pluginEnabledIn(undefined, p)).toBe(false)
    // A damaged record file counts as empty lists.
    expect(pluginEnabledIn({ enabledPlugins: 'x', disabledPlugins: 7 }, p)).toBe(true)
    expect(enabledPluginIds({ enabledPlugins: ['test.jira'], disabledPlugins: [] }, [p, plain])).toEqual(['test.jira', BID])
    expect(enabledPluginIds({ enabledPlugins: [BID], disabledPlugins: [] }, [p])).toEqual([BID])
    expect(enabledPluginIds({ enabledPlugins: [], disabledPlugins: [BID] }, [p])).toEqual([])
  })
})

describe('uninstall and update', () => {
  it('refuses to uninstall or update a bundled plugin, and nothing changes', async () => {
    const { installer, index } = await restart([spec(bundledFolder())])
    await expect(installer.uninstall(BID)).rejects.toThrow(/built in/)
    await expect(installer.update(BID, 'v2')).rejects.toThrow(/updates with the app/)
    expect(index.get(BID)).toBeDefined()
    expect(installer.get(BID)?.manifest).toBeDefined()
  })
})

describe('CLI name clashes: bundled first', () => {
  it('a bundled plugin keeps its name against a plugin linked earlier in the index', async () => {
    // The linked plugin is indexed first (a previous run), the bundled one is added by this run.
    const first = newInstaller(undefined)
    await first.installer.load()
    await first.installer.link(linkedFolder('test.mine', ['browser']))
    const { installer, index } = await restart([spec(bundledFolder(BID, ['browser']))])
    expect(index.list().map((e) => e.id)).toEqual(['test.mine', BID])
    expect(installer.get(BID)?.state).toEqual({ ok: true })
    const mine = installer.get('test.mine')?.state
    expect(mine?.ok === false && mine.reason).toBe(`cli command "browser" is already provided by plugin ${BID}`)
    // Stable across restarts.
    const again = await restart([spec(bundledFolder(BID, ['browser']))])
    expect(again.installer.get(BID)?.state).toEqual({ ok: true })
    expect(again.installer.get('test.mine')?.state.ok).toBe(false)
  })

  it('a linked plugin that takes a bundled name later is refused at link time, naming the owner', async () => {
    const { installer } = await restart([spec(bundledFolder(BID, ['browser']))])
    await expect(installer.link(linkedFolder('test.mine', ['browser']))).rejects.toThrow(
      new RegExp(`already provided by plugin ${BID.replace('.', '\\.')}`)
    )
  })

  it('the loser wins its name back when the bundled plugin is no longer shipped', async () => {
    const first = newInstaller(undefined)
    await first.installer.load()
    await first.installer.link(linkedFolder('test.mine', ['browser']))
    await restart([spec(bundledFolder(BID, ['browser']))])
    const { installer } = await restart([])
    expect(installer.get('test.mine')?.state).toEqual({ ok: true })
  })
})

describe('turning a default-on plugin off and on (ProjectSettingsService)', () => {
  const P = 'aaaaaaaaaaaaaaaa'

  function bundledPlugin(): InstalledPlugin {
    return {
      id: BID,
      version: '1.0.0',
      source: { kind: 'bundled', path: '/app/plugins/browser' },
      state: { ok: true },
      enabledByDefault: true,
      dir: '/app/plugins/browser',
      themes: [],
      manifest: { id: BID, name: 'Browser', version: '1.0.0', api: 1 }
    }
  }

  /** A project record kept as JSON between calls, the way registry.json keeps it across a restart. */
  function rig(stored?: string) {
    let json =
      stored ??
      JSON.stringify({
        schemaVersion: 1,
        id: P,
        path: '/work/alpha',
        name: 'alpha',
        enabledPlugins: [],
        pluginSettings: {},
        layout: defaultLayout(),
        tabs: [],
        lastOpenedAt: 1
      })
    const restarts: string[] = []
    const load = (): ProjectView => ({ ...(JSON.parse(json) as ProjectRecord), missing: false })
    const deps: ProjectSettingsDeps = {
      projects: {
        get: () => load(),
        update: (_id, mutate) => {
          const r = JSON.parse(json) as ProjectRecord
          mutate(r)
          json = JSON.stringify(r)
        }
      },
      plugins: { list: () => [bundledPlugin()], get: (id) => (id === BID ? bundledPlugin() : undefined) },
      checkSettings: () => ({ ok: true }),
      enabledChanged: async () => {
        restarts.push('restart')
      },
      settingsChanged: async () => {},
      layouts: { view: () => undefined, move: () => undefined },
      secrets: {
        hasSetting: () => false,
        settingsGuard: () => ({ removals: undefined, forgets: new Map() }),
        checkSettingsGuard: () => {},
        writeSettings: async () => {}
      }
    }
    return { service: new ProjectSettingsService(deps), restarts, json: () => json }
  }

  it('is on in a project whose record predates disabledPlugins', () => {
    const { service } = rig()
    expect(service.view(P).plugins[0]).toMatchObject({ id: BID, enabled: true })
  })

  it('off sticks across a restart, and on again sticks too', async () => {
    const a = rig()
    await a.service.setEnabled(P, BID, false)
    expect(a.restarts).toHaveLength(1)
    // "Restart": a new service over the same stored record.
    const b = rig(a.json())
    expect(b.service.view(P).plugins[0]!.enabled).toBe(false)
    expect(enabledPluginIds(JSON.parse(a.json()) as ProjectRecord, [bundledPlugin()])).toEqual([])
    await b.service.setEnabled(P, BID, true)
    const c = rig(b.json())
    expect(c.service.view(P).plugins[0]!.enabled).toBe(true)
    expect((JSON.parse(b.json()) as ProjectRecord).disabledPlugins).toEqual([])
    // Switching a default-on plugin off twice changes nothing and does not restart the host again.
    await c.service.setEnabled(P, BID, true)
    expect(c.restarts).toHaveLength(0)
  })
})
