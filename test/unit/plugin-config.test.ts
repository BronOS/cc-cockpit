// `ccc plugin config` (friction round 1, Task 6): argument parsing, the request the CLI builds,
// its output; main's view and set on the REAL settings services (so a set takes the Settings
// form's save: same validation, same announce), and the socket handler (the project is the
// caller's, never one from the args).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from '../../src/cli/args'
import { buildRequest, run, type Output } from '../../src/cli/client'
import type { InstalledPlugin } from '../../src/main/plugins/installer'
import { appSettingKey, projectSettingKey } from '../../src/main/secrets/plugin-secrets'
import { pluginConfigView, setPluginConfig, type PluginConfigDeps } from '../../src/main/settings/plugin-config'
import { ProjectSettingsService } from '../../src/main/settings/project-settings-service'
import { SettingsService, type SettingsDeps } from '../../src/main/settings/settings-service'
import { pluginConfigHandler, registerPluginConfigHandler, type PluginConfigOptions } from '../../src/main/socket/handlers'
import type { Caller } from '../../src/main/socket/socket-server'
import { defaultLayout } from '../../src/shared/layout'
import type { PluginManifest } from '../../src/shared/manifest'
import { formatPluginConfig, parseConfigValue, type PluginConfigView } from '../../src/shared/plugin-config'
import { encodeReply, LineFramer, parseRequest, type Request } from '../../src/shared/protocol'
import type { ProjectRecord, ProjectView } from '../../src/shared/types'

const P = 'aaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbb'
const TOKEN = 'c'.repeat(64)
const CWD = '/work/dir'
const POSIX = process.platform !== 'win32'

describe('parseArgs: plugin config', () => {
  it('prints with an id, --json and --project', () => {
    expect(parseArgs(['plugin', 'config', 'acme.x'])).toEqual({ kind: 'plugin-config', id: 'acme.x', json: false, set: [] })
    expect(parseArgs(['plugin', 'config', '--project', '/p', 'acme.x', '--json'])).toEqual({
      kind: 'plugin-config',
      id: 'acme.x',
      json: true,
      set: [],
      project: '/p'
    })
  })

  it('sets key=value pairs, each value JSON or else text, split at the first =', () => {
    expect(parseArgs(['plugin', 'config', 'acme.x', 'limit=5', 'on=true', 'name=hi', 'quoted="5"', 'url=https://a/?b=c', 'empty=', 'list=[1,2]'])).toEqual({
      kind: 'plugin-config',
      id: 'acme.x',
      json: false,
      set: [
        ['limit', 5],
        ['on', true],
        ['name', 'hi'],
        ['quoted', '5'],
        ['url', 'https://a/?b=c'],
        ['empty', ''],
        ['list', [1, 2]]
      ]
    })
    expect(parseArgs(['plugin', 'config', 'acme.x', '--scope', 'project', 'board=dev'])).toMatchObject({ scope: 'project', set: [['board', 'dev']] })
    expect(parseConfigValue('null')).toBeNull()
    expect(parseConfigValue('{"a":1}')).toEqual({ a: 1 })
  })

  it.each([
    [['plugin', 'config']],
    [['plugin', 'config', 'Not An Id']],
    [['plugin', 'config', 'acme.x', 'novalue']],
    [['plugin', 'config', 'acme.x', '=5']],
    [['plugin', 'config', 'acme.x', '--scope', 'global', 'a=1']],
    [['plugin', 'config', 'acme.x', '--scope', 'app']], // --scope goes with values
    [['plugin', 'config', 'acme.x', '--scope']],
    [['plugin', 'config', 'acme.x', '--app', 'a=1']], // --project is the folder; the scope is --scope
    [['plugin', 'config', 'acme.x', ...Array.from({ length: 65 }, (_, i) => `k${i}=1`)]]
  ])('refuses %j as a usage error', (argv) => {
    expect(parseArgs(argv)).toMatchObject({ kind: 'usage' })
  })

  it('a misplaced --project says where it goes', () => {
    expect(parseArgs(['--project', '/p', 'plugin', 'config', 'acme.x'])).toMatchObject({
      kind: 'usage',
      message: expect.stringContaining('link|unlink|list|config --project')
    })
  })
})

describe('buildRequest: plugin config', () => {
  it('sends the id (and set/scope) and routes by token or --project; never a project in args', () => {
    const inTab = buildRequest({ kind: 'plugin-config', id: 'acme.x', json: false, set: [], project: '/elsewhere' }, { APP_TAB_TOKEN: TOKEN }, CWD) as Request
    expect(inTab).toMatchObject({ cmd: 'plugin.config', token: TOKEN, args: { id: 'acme.x' } })
    expect(inTab.project).toBeUndefined()
    expect(inTab.args).toEqual({ id: 'acme.x' })
    const outside = buildRequest(
      { kind: 'plugin-config', id: 'acme.x', json: false, scope: 'app', set: [['limit', 5]], project: 'rel' },
      {},
      CWD
    ) as Request
    expect(outside).toMatchObject({ cmd: 'plugin.config', project: '/work/dir/rel' })
    expect(outside.args).toEqual({ id: 'acme.x', set: [['limit', 5]], scope: 'app' })
    expect(buildRequest({ kind: 'plugin-config', id: 'acme.x', json: false, set: [] }, {}, CWD)).toEqual({
      error: expect.stringMatching(/--project/)
    })
  })
})

describe('formatPluginConfig', () => {
  it('prints scope key = JSON lines, secrets and missing values as bare words, extras and the problem after', () => {
    const view: PluginConfigView = {
      id: 'acme.x',
      app: { fields: ['greeting', 'limit', 'token', 'note'], values: { greeting: 'hello', limit: 10, extra: [1] }, secrets: { token: true }, problem: 'limit is bad' },
      project: { fields: ['board', 'key'], values: { board: 'main' }, secrets: { key: false } }
    }
    expect(formatPluginConfig(view, (t) => t)).toBe(
      [
        'app greeting = "hello"',
        'app limit = 10',
        'app token = set',
        'app note = not set',
        'app extra = [1]',
        '# app: the stored settings fail the schema, the plugin stays off: limit is bad',
        'project board = "main"',
        'project key = not set',
        ''
      ].join('\n')
    )
  })
})

describe('the CLI against a fake app', () => {
  let root: string
  let sock: string
  let server: Server | undefined
  let out: string
  let err: string
  const io: Output = { stdout: (t) => void (out += t), stderr: (t) => void (err += t) }
  beforeEach(() => {
    root = mkdtempSync(join(POSIX ? '/tmp' : process.env.TEMP!, 'ccpc-'))
    sock = join(root, 's.sock')
    out = ''
    err = ''
  })
  afterEach(() => {
    server?.close()
    rmSync(root, { recursive: true, force: true })
  })
  const app = (answer: (r: Request) => { ok: true; result: unknown } | { ok: false; error: string }): Promise<void> =>
    new Promise((resolve) => {
      server = createServer((socket: Socket) => {
        const framer = new LineFramer()
        socket.on('data', (chunk: Buffer) => {
          for (const line of framer.push(chunk)) {
            const r = parseRequest(line)
            socket.write(encodeReply({ id: r.id, ...answer(r) }))
          }
        })
        socket.on('error', () => {})
      })
      server.listen(sock, () => resolve())
    })
  const env = (): Record<string, string> => ({ APP_TAB_TOKEN: TOKEN, CC_COCKPIT_SOCK: sock })
  const view: PluginConfigView = { id: 'acme.x', app: { fields: ['limit', 'token'], values: { limit: 3 }, secrets: { token: false } } }

  it('prints text, or the reply as JSON with --json; a set prints the stored lines', async () => {
    await app((r) => ({ ok: true, result: r.args.set === undefined ? view : { id: 'acme.x', scope: 'app', values: { limit: 5 } } }))
    expect(await run(['plugin', 'config', 'acme.x'], env(), Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('app limit = 3\napp token = not set\n')
    out = ''
    expect(await run(['plugin', 'config', 'acme.x', '--json'], env(), Readable.from([]), io, CWD)).toBe(0)
    expect(JSON.parse(out)).toEqual(view)
    out = ''
    expect(await run(['plugin', 'config', 'acme.x', 'limit=5'], env(), Readable.from([]), io, CWD)).toBe(0)
    expect(out).toBe('app limit = 5\n')
    expect(err).toBe('')
  })

  it('a refusal is exit 1 with the reason; a usage error exit 2', async () => {
    await app(() => ({ ok: false, error: 'acme.x: nothing was stored, the app settings fail the schema: limit must be >= 1' }))
    expect(await run(['plugin', 'config', 'acme.x', 'limit=0'], env(), Readable.from([]), io, CWD)).toBe(1)
    expect(err).toBe('ccc: acme.x: nothing was stored, the app settings fail the schema: limit must be >= 1\n')
    err = ''
    expect(await run(['plugin', 'config', 'acme.x', 'limit'], env(), Readable.from([]), io, CWD)).toBe(2)
    expect(err).toContain('expected key=value')
  })
})

// ---------------------------------------------------------------------------------------------
// main: the real services, fakes below them
// ---------------------------------------------------------------------------------------------

function plugin(id: string, contributes: PluginManifest['contributes']): InstalledPlugin {
  return {
    id,
    version: '1.0.0',
    source: { kind: 'linked', path: `/dev/${id}` },
    state: { ok: true },
    dir: `/dev/${id}`,
    themes: [],
    manifest: { id, name: id, version: '1.0.0', api: 1, contributes }
  }
}

function projectView(id: string): ProjectView {
  return {
    schemaVersion: 1,
    id,
    path: `/work/${id}`,
    name: id,
    enabledPlugins: [],
    pluginSettings: {},
    layout: defaultLayout(),
    tabs: [],
    lastOpenedAt: 1,
    missing: false
  }
}

function rig() {
  const calls: string[] = []
  const projects = new Map([P, OTHER].map((id) => [id, projectView(id)]))
  const plugins = [
    // The settings-ui e2e fixture's schemas, plus a field both scopes declare.
    plugin('test.settingsui', {
      settings: {
        app: {
          type: 'object',
          properties: {
            greeting: { type: 'string', default: 'hello' },
            limit: { type: 'integer', minimum: 1, default: 10 },
            token: { type: 'string', format: 'secret' },
            shared: { type: 'string' }
          },
          required: ['token']
        },
        project: {
          type: 'object',
          properties: {
            board: { type: 'string', default: 'main' },
            pageSize: { type: 'integer', minimum: 1, default: 20 },
            key: { type: 'string', format: 'secret' },
            shared: { type: 'string' }
          }
        }
      }
    }),
    plugin('test.plain', {}),
    plugin('test.apponly', { settings: { app: { type: 'object', properties: { site: { type: 'string' } } } } })
  ]
  const appSettings = new Map<string, unknown>()
  const storedSecrets = new Set<string>([appSettingKey('token')])
  const secretWrites: Array<Map<string, string | null>> = []
  const secrets = {
    hasSetting: (_pluginId: string, key: string) => storedSecrets.has(key),
    settingsGuard: () => ({ removals: undefined, forgets: new Map() }),
    checkSettingsGuard: () => {},
    writeSettings: async (_pluginId: string, changes: Map<string, string | null>) => {
      secretWrites.push(new Map(changes))
    }
  }
  const settings = new SettingsService({
    projects: { list: () => [...projects.values()], get: (id) => projects.get(id), relink: () => projectView(P), forget: () => {}, update: () => {} },
    hasWindow: () => true,
    openProjectPath: () => {},
    pickFolder: async () => undefined,
    plugins: {
      list: () => plugins,
      get: (id: string) => plugins.find((p) => p.id === id),
      install: async () => plugins[0]!,
      link: async () => plugins[0]!,
      update: async () => plugins[0]!,
      uninstall: async () => {},
      applyRevocations: async () => {}
    },
    marketplace: { list: () => [], refresh: async () => {}, revocationFor: () => null, revocationWarnings: () => [], prune: () => {} },
    setMarketplaceUrls: () => {},
    pluginRepos: { get: () => undefined, set: () => {} },
    disableEverywhere: () => {},
    enabledInAProject: () => false,
    appPluginSettings: { get: (id) => appSettings.get(id), set: (id, value) => void appSettings.set(id, value) },
    pluginSettingsChanged: async () => void calls.push('app settings announced'),
    secrets
  } as SettingsDeps)
  const projectSettings = new ProjectSettingsService({
    projects: {
      get: (id) => projects.get(id),
      update: (id, mutate) => {
        const p = projects.get(id)
        if (p) mutate(p as ProjectRecord)
      }
    },
    plugins: { list: () => plugins, get: (id) => plugins.find((p) => p.id === id) },
    checkSettings: () => ({ ok: true }),
    enabledChanged: async () => {},
    settingsChanged: async (projectId, pluginId) => void calls.push(`project settings announced ${projectId} ${pluginId}`),
    layouts: { view: () => undefined, move: () => undefined },
    secrets
  })
  const deps: PluginConfigDeps = {
    appSettings: (id) => settings.pluginAppSettings(id),
    projectSettings: (projectId, id) => projectSettings.pluginProjectSettings(projectId, id),
    saveApp: (id, values) => settings.savePluginSettings(id, values),
    saveProject: (projectId, id, values) => projectSettings.saveSettings(projectId, id, values)
  }
  return { deps, calls, projects, appSettings, storedSecrets, secretWrites }
}

describe('pluginConfigView', () => {
  it('shows both scopes with defaults, and secret fields only as set or not', () => {
    const { deps } = rig()
    const view = pluginConfigView(deps, P, 'test.settingsui')
    expect(view).toEqual({
      id: 'test.settingsui',
      app: { fields: ['greeting', 'limit', 'token', 'shared'], values: { greeting: 'hello', limit: 10 }, secrets: { token: true } },
      project: { fields: ['board', 'pageSize', 'key', 'shared'], values: { board: 'main', pageSize: 20 }, secrets: { key: false } }
    })
    expect(formatPluginConfig(view, (t) => t)).toContain('app token = set\n')
    expect(formatPluginConfig(view, (t) => t)).toContain('project key = not set\n')
  })

  it('never shows a secret value, even one a hand-edited file put among the plain values', () => {
    const { deps, appSettings } = rig()
    appSettings.set('test.settingsui', { greeting: 'hi', token: 'leaked-in-json' })
    expect(JSON.stringify(pluginConfigView(deps, P, 'test.settingsui'))).not.toContain('leaked-in-json')
  })

  it('reports stored values that fail the schema', () => {
    const { deps, appSettings } = rig()
    appSettings.set('test.settingsui', { limit: 0 })
    expect(pluginConfigView(deps, P, 'test.settingsui').app).toMatchObject({ values: { limit: 0 }, problem: expect.stringContaining('limit') })
  })

  it('refuses an unknown plugin and one without settings', () => {
    const { deps } = rig()
    expect(() => pluginConfigView(deps, P, 'test.nope')).toThrow('unknown plugin: test.nope')
    expect(() => pluginConfigView(deps, P, 'test.plain')).toThrow('test.plain declares no settings')
  })
})

describe('setPluginConfig', () => {
  it('sets an app field through the form save: validated, merged with the rest, announced, secrets untouched', async () => {
    const { deps, calls, appSettings, secretWrites, storedSecrets } = rig()
    appSettings.set('test.settingsui', { greeting: 'yo', limit: 3 })
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['limit', 7]])).resolves.toEqual({
      id: 'test.settingsui',
      scope: 'app',
      values: { limit: 7 }
    })
    expect(appSettings.get('test.settingsui')).toEqual({ greeting: 'yo', limit: 7 })
    expect(calls).toEqual(['app settings announced'])
    // No secret edits went to the store: the stored token stays as it was.
    expect(secretWrites.map((m) => m.size)).toEqual([0])
    expect(storedSecrets.has(appSettingKey('token'))).toBe(true)
  })

  it('sets a project field in the given project only, and announces it to that project', async () => {
    const { deps, calls, projects } = rig()
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['board', 'dev'], ['pageSize', 50]])).resolves.toEqual({
      id: 'test.settingsui',
      scope: 'project',
      values: { board: 'dev', pageSize: 50 }
    })
    expect(projects.get(P)?.pluginSettings['test.settingsui']).toEqual({ board: 'dev', pageSize: 50 })
    expect(projects.get(OTHER)?.pluginSettings['test.settingsui']).toBeUndefined()
    expect(calls).toEqual([`project settings announced ${P} test.settingsui`])
  })

  it('refuses a value the schema rejects with its reasons, and stores nothing', async () => {
    const { deps, calls, appSettings } = rig()
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['limit', 0]])).rejects.toThrow(
      /nothing was stored, the app settings fail the schema: .*limit/
    )
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['limit', 'many']])).rejects.toThrow(/integer/)
    expect(appSettings.has('test.settingsui')).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses secret fields with a pointer to Settings, and passes nothing on', async () => {
    const { deps, secretWrites, calls } = rig()
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['token', 'abc']])).rejects.toThrow(
      'token is a secret field: ccc never handles secret values, set it in Settings > Plugins'
    )
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['key', 'abc']])).rejects.toThrow(/set it in Settings > This project/)
    // A secret among plain fields refuses the whole call.
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['limit', 5], ['token', 'abc']])).rejects.toThrow(/secret field/)
    expect(secretWrites).toEqual([])
    expect(calls).toEqual([])
  })

  it('refuses an unknown plugin, an unknown field and a reserved key, naming what exists', async () => {
    const { deps } = rig()
    await expect(setPluginConfig(deps, P, 'test.nope', [['a', 1]])).rejects.toThrow('unknown plugin: test.nope')
    await expect(setPluginConfig(deps, P, 'test.plain', [['a', 1]])).rejects.toThrow('test.plain declares no settings')
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['colour', 'red']])).rejects.toThrow(
      'test.settingsui has no setting colour (its app settings are greeting, limit, token, shared; its project settings are board, pageSize, key, shared)'
    )
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['__proto__', 1]])).rejects.toThrow(/not allowed/)
    await expect(setPluginConfig(deps, P, 'test.settingsui', [])).rejects.toThrow(/at least one/)
  })

  it('picks the declaring scope; a key both declare needs --scope; --scope must declare the key; one scope per call', async () => {
    const { deps, appSettings, projects } = rig()
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['shared', 'x']])).rejects.toThrow(/both an app and a project setting.*--scope/)
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['shared', 'x']], 'project')).resolves.toMatchObject({ scope: 'project' })
    expect(projects.get(P)?.pluginSettings['test.settingsui']).toMatchObject({ shared: 'x' })
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['shared', 'y']], 'app')).resolves.toMatchObject({ scope: 'app' })
    expect(appSettings.get('test.settingsui')).toMatchObject({ shared: 'y' })
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['board', 'x']], 'app')).rejects.toThrow(
      'board is not an app setting of test.settingsui (its app settings are greeting, limit, token, shared)'
    )
    await expect(setPluginConfig(deps, P, 'test.apponly', [['site', 'x']], 'project')).rejects.toThrow(/declares no project settings/)
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['limit', 2], ['board', 'x']])).rejects.toThrow(
      'limit is an app setting and board a project setting: set them in two calls'
    )
  })

  it('a set can repair stored values that fail the schema (the plugin then starts, as after a form save)', async () => {
    const { deps, appSettings, calls } = rig()
    appSettings.set('test.settingsui', { limit: 0, greeting: 'kept' })
    await expect(setPluginConfig(deps, P, 'test.settingsui', [['limit', 4]])).resolves.toMatchObject({ values: { limit: 4 } })
    expect(appSettings.get('test.settingsui')).toEqual({ limit: 4, greeting: 'kept' })
    expect(calls).toEqual(['app settings announced'])
  })

  it('reads a project secret by the project main resolved', () => {
    const { deps, storedSecrets } = rig()
    storedSecrets.add(projectSettingKey(P, 'key'))
    expect(pluginConfigView(deps, P, 'test.settingsui').project?.secrets).toEqual({ key: true })
    expect(pluginConfigView(deps, OTHER, 'test.settingsui').project?.secrets).toEqual({ key: false })
  })
})

describe('the plugin.config socket handler', () => {
  const seen: Array<{ op: string; projectId: string; pluginId: string; edits?: unknown; scope?: unknown }> = []
  const options: PluginConfigOptions = {
    view: (projectId, pluginId) => {
      seen.push({ op: 'view', projectId, pluginId })
      return { id: pluginId }
    },
    set: async (projectId, pluginId, edits, scope) => {
      seen.push({ op: 'set', projectId, pluginId, edits, scope })
      return { id: pluginId, scope: scope ?? 'app', values: {} }
    }
  }
  const handler = pluginConfigHandler(options)
  beforeEach(() => {
    seen.length = 0
  })

  it('is registered as plugin.config', () => {
    const names: string[] = []
    registerPluginConfigHandler({ handle: (cmd) => void names.push(cmd) }, options)
    expect(names).toEqual(['plugin.config'])
  })

  it('takes the project from the caller, never from the args', async () => {
    const tab: Caller = { kind: 'session', tabId: 't1', projectId: P }
    await handler({ id: 'acme.x', project: OTHER, projectId: OTHER }, tab)
    await handler({ id: 'acme.x', set: [['limit', 5]], scope: 'app', project: OTHER }, { kind: 'window', projectId: P })
    await handler({ id: 'acme.x' }, { kind: 'project', path: '/work/p', projectId: P })
    expect(seen).toEqual([
      { op: 'view', projectId: P, pluginId: 'acme.x' },
      { op: 'set', projectId: P, pluginId: 'acme.x', edits: [['limit', 5]], scope: 'app' },
      { op: 'view', projectId: P, pluginId: 'acme.x' }
    ])
  })

  it('refuses a caller with no project, and a --project folder with no record', async () => {
    await expect(Promise.resolve().then(() => handler({ id: 'acme.x' }, { kind: 'anonymous' }))).rejects.toThrow(/tab token or --project/)
    await expect(Promise.resolve().then(() => handler({ id: 'acme.x' }, { kind: 'project', path: '/new', projectId: undefined }))).rejects.toThrow(
      /not open/
    )
    expect(seen).toEqual([])
  })

  it.each<[Record<string, unknown>, RegExp]>([
    [{}, /needs a plugin id/],
    [{ id: '../x' }, /needs a plugin id/],
    [{ id: 'acme.x', scope: 'global', set: [['a', 1]] }, /scope is app or project/],
    [{ id: 'acme.x', scope: 'app' }, /scope goes with values/],
    [{ id: 'acme.x', set: [] }, /1 to 64/],
    [{ id: 'acme.x', set: { a: 1 } }, /1 to 64/],
    [{ id: 'acme.x', set: [['a']] }, /\[key, value\] pair/],
    [{ id: 'acme.x', set: [['', 1]] }, /\[key, value\] pair/],
    [{ id: 'acme.x', set: [[1, 1]] }, /\[key, value\] pair/]
  ])('checks the args main-side: %j', async (args, message) => {
    await expect(Promise.resolve().then(() => handler(args, { kind: 'window', projectId: P }))).rejects.toThrow(message)
    expect(seen).toEqual([])
  })
})
