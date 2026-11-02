import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContext, formatLogArgs } from '../../src/host/ctx'
import { ACTIVATE_TIMEOUT_MS, clearRequireCache, parsePluginSpecs, PluginLoader, type HostPluginSpec } from '../../src/host/loader'
import type { PluginContext } from '../../src/sdk/types'
import { hostSpec } from '../fakes/host-spec'

const fakeCtx = (spec: HostPluginSpec): PluginContext => createContext(spec, { log: () => {} })

describe('PluginLoader with real plugin files', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccc-loader-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const plugin = (id: string, files: Record<string, string>): HostPluginSpec => {
    const dir = join(root, id)
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    return hostSpec({ id, dir, main: 'host.js' })
  }

  it('activates good plugins and isolates a throwing one, a broken require and a missing activate', async () => {
    const log = vi.fn()
    const loader = new PluginLoader({ makeContext: fakeCtx, log })
    const good = plugin('a.good', {
      'host.js': "const dep = require('./lib/dep'); exports.activate = (ctx) => { globalThis.__goodCtx = ctx.pluginId + dep }",
      'lib/dep.js': "module.exports = '!'"
    })
    const throws = plugin('a.throws', { 'host.js': "exports.activate = () => { throw new Error('boom') }" })
    const rejects = plugin('a.rejects', { 'host.js': "exports.activate = async () => { throw new Error('later boom') }" })
    const syntax = plugin('a.syntax', { 'host.js': 'this is not javascript' })
    const noActivate = plugin('a.noact', { 'host.js': 'exports.other = 1' })
    const esm = plugin('a.esm', { 'host.js': 'exports.default = { activate() { return { api: 42 } } }' })
    const states = await loader.activateAll([good, throws, rejects, syntax, noActivate, esm])
    expect(states.map((s) => [s.id, s.state])).toEqual([
      ['a.good', 'active'],
      ['a.throws', 'errored'],
      ['a.rejects', 'errored'],
      ['a.syntax', 'errored'],
      ['a.noact', 'errored'],
      ['a.esm', 'active']
    ])
    expect((globalThis as Record<string, unknown>).__goodCtx).toBe('a.good!')
    const byId = Object.fromEntries(states.map((s) => [s.id, s]))
    expect(byId['a.throws']).toMatchObject({ error: 'activate() failed: boom' })
    expect(byId['a.rejects']).toMatchObject({ error: 'activate() failed: later boom' })
    expect(byId['a.syntax']).toMatchObject({ error: expect.stringMatching(/^loading host.js failed:/) })
    expect(byId['a.noact']).toMatchObject({ error: 'host.js does not export an activate() function' })
    expect(log).toHaveBeenCalledWith('plugin a.throws: activate() failed: boom')
    expect(loader.states()).toEqual(states)
  })

  it('does not activate an already loaded id twice', async () => {
    const activate = vi.fn()
    const loader = new PluginLoader({ makeContext: fakeCtx, requireModule: () => ({ activate }) })
    const spec = hostSpec({ id: 'a.one', dir: root, main: 'x.js' })
    await loader.activateAll([spec])
    expect(await loader.activateAll([spec])).toEqual([])
    expect(activate).toHaveBeenCalledTimes(1)
  })

  it('refuses a relative plugin folder', async () => {
    const loader = new PluginLoader({ makeContext: fakeCtx, requireModule: () => ({ activate() {} }), log: () => {} })
    const [s] = await loader.activateAll([hostSpec({ id: 'a.rel', dir: 'relative', main: 'x.js' })])
    expect(s).toEqual({ id: 'a.rel', state: 'errored', error: 'bad plugin location' })
  })
})

describe('clearRequireCache', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-cache-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('drops only the modules inside the folder, by whole path segments', () => {
    const dir = join(root, 'plug')
    const cache: Record<string, unknown> = {
      [join(dir, 'host.js')]: 1,
      [join(dir, 'lib', 'dep.js')]: 2,
      [join(dir, 'node_modules', 'x', 'index.js')]: 3,
      [join(root, 'plug-other', 'host.js')]: 4,
      [join(root, 'plugin.js')]: 5,
      '/usr/lib/node/core.js': 6,
      [__filename]: 7
    }
    mkdirSync(dir)
    expect(clearRequireCache(dir, cache)).toBe(3)
    expect(Object.values(cache).sort()).toEqual([4, 5, 6, 7])
  })

  it('resolves a symlinked folder to its real path (cache keys are real paths)', () => {
    const real = join(root, 'real')
    mkdirSync(real)
    symlinkSync(real, join(root, 'link'))
    const cache: Record<string, unknown> = { [join(real, 'host.js')]: 1, [join(root, 'other.js')]: 2 }
    expect(clearRequireCache(join(root, 'link'), cache)).toBe(1)
    expect(Object.keys(cache)).toEqual([join(root, 'other.js')])
  })

  it('refuses a filesystem root, which would match every module', () => {
    const cache: Record<string, unknown> = { '/usr/lib/a.js': 1, [__filename]: 2 }
    expect(clearRequireCache('/', cache)).toBe(0)
    expect(Object.keys(cache)).toHaveLength(2)
  })

  it('does not touch this process\'s own modules when asked for a plugin folder', () => {
    const dir = join(root, 'plug')
    mkdirSync(dir)
    const before = Object.keys(createRequire(__filename).cache).length
    clearRequireCache(dir)
    expect(Object.keys(createRequire(__filename).cache).length).toBe(before)
  })
})

describe('PluginLoader.reload', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-reload-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const write = (dir: string, name: string, text: string): void => {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }

  it('deactivates the old code, forgets the plugin\'s modules and activates the new files; the others are untouched', async () => {
    const events: string[] = []
    ;(globalThis as Record<string, unknown>).__reloadEvents = events
    const code = (tag: string): string =>
      `const dep = require('./lib/dep'); exports.activate = () => { __reloadEvents.push('activate ${tag} ' + dep) }; exports.deactivate = () => { __reloadEvents.push('deactivate ${tag}') }`
    const dir = join(root, 'a.dev')
    write(dir, 'host.js', code('v1'))
    write(dir, 'lib/dep.js', "module.exports = 'dep1'")
    const otherDir = join(root, 'a.other')
    write(otherDir, 'host.js', "exports.activate = () => { __reloadEvents.push('activate other') }; exports.deactivate = () => { __reloadEvents.push('deactivate other') }")
    const released: string[] = []
    const loader = new PluginLoader({ makeContext: fakeCtx, release: (s) => void released.push(s.id), log: () => {} })
    const spec = hostSpec({ id: 'a.dev', dir, main: 'host.js' })
    await loader.activateAll([spec, hostSpec({ id: 'a.other', dir: otherDir, main: 'host.js' })])
    events.length = 0

    write(dir, 'host.js', code('v2'))
    write(dir, 'lib/dep.js', "module.exports = 'dep2'")
    expect(await loader.reload(spec)).toEqual({ id: 'a.dev', state: 'active' })
    // Order: the old copy deactivates first, then the new files (including the nested module) load.
    expect(events).toEqual(['deactivate v1', 'activate v2 dep2'])
    expect(released).toContain('a.dev')
    expect(released).not.toContain('a.other')
    expect(loader.states().map((s) => s.id)).toEqual(['a.other', 'a.dev'])
  })

  it('reports a syntax error in the new code as errored and recovers on the next reload', async () => {
    const dir = join(root, 'a.dev')
    write(dir, 'host.js', 'exports.activate = () => {}')
    const loader = new PluginLoader({ makeContext: fakeCtx, log: () => {} })
    const spec = hostSpec({ id: 'a.dev', dir, main: 'host.js' })
    await loader.activateAll([spec])
    write(dir, 'host.js', 'this is not javascript')
    expect(await loader.reload(spec)).toMatchObject({ id: 'a.dev', state: 'errored', error: expect.stringMatching(/^loading host.js failed/) })
    write(dir, 'host.js', 'exports.activate = () => {}')
    expect(await loader.reload(spec)).toEqual({ id: 'a.dev', state: 'active' })
  })

  it('activates a plugin that was never loaded, and survives a deactivate that throws', async () => {
    const dir = join(root, 'a.dev')
    write(dir, 'host.js', "exports.activate = () => {}; exports.deactivate = () => { throw new Error('bad bye') }")
    const log = vi.fn()
    const loader = new PluginLoader({ makeContext: fakeCtx, log })
    const spec = hostSpec({ id: 'a.dev', dir, main: 'host.js' })
    expect(await loader.reload(spec)).toEqual({ id: 'a.dev', state: 'active' })
    expect(await loader.reload(spec)).toEqual({ id: 'a.dev', state: 'active' })
    expect(log).toHaveBeenCalledWith('plugin a.dev: bad bye')
  })

  it('unload deactivates one plugin and forgets it', async () => {
    const dir = join(root, 'a.dev')
    write(dir, 'host.js', "exports.activate = () => {}; exports.deactivate = () => { globalThis.__unloaded = true }")
    const release = vi.fn()
    const loader = new PluginLoader({ makeContext: fakeCtx, release, log: () => {} })
    await loader.activateAll([hostSpec({ id: 'a.dev', dir, main: 'host.js' })])
    await loader.unload('a.dev')
    expect((globalThis as Record<string, unknown>).__unloaded).toBe(true)
    expect(release).toHaveBeenCalledTimes(1)
    expect(loader.states()).toEqual([])
    await loader.unload('a.dev')
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('PluginLoader timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks a plugin whose activate does not finish in 10 s errored, without holding back the others', async () => {
    const modules: Record<string, unknown> = {
      '/p/slow/host.js': { activate: () => new Promise(() => {}) },
      '/p/fine/host.js': { activate: () => new Promise((r) => setTimeout(r, 9_000)) }
    }
    const loader = new PluginLoader({
      makeContext: fakeCtx,
      requireModule: (path) => modules[path],
      log: () => {}
    })
    const done = loader.activateAll([
      hostSpec({ id: 'p.slow', dir: '/p/slow', main: 'host.js' }),
      hostSpec({ id: 'p.fine', dir: '/p/fine', main: 'host.js' })
    ])
    // Concurrent: both budgets run from t=0, so the whole call ends at 10 s, not 19 s.
    await vi.advanceTimersByTimeAsync(ACTIVATE_TIMEOUT_MS)
    expect(await done).toEqual([
      { id: 'p.slow', state: 'errored', error: 'activate() failed: activate() did not finish within 10 s' },
      { id: 'p.fine', state: 'active' }
    ])
  })

  it('deactivates active plugins only, each capped, and never rejects', async () => {
    const calls: string[] = []
    const modules: Record<string, unknown> = {
      '/p/a/host.js': { activate() {}, deactivate: () => void calls.push('a') },
      '/p/b/host.js': { activate() {}, deactivate: () => new Promise(() => calls.push('b')) },
      '/p/c/host.js': { activate() {}, deactivate: () => { calls.push('c'); throw new Error('no') } },
      '/p/d/host.js': { activate: () => { throw new Error('x') }, deactivate: () => void calls.push('d') }
    }
    const log = vi.fn()
    const loader = new PluginLoader({ makeContext: fakeCtx, requireModule: (p) => modules[p], log, deactivateTimeoutMs: 5000 })
    await loader.activateAll(['a', 'b', 'c', 'd'].map((id) => hostSpec({ id: `p.${id}`, dir: `/p/${id}`, main: 'host.js' })))
    const done = loader.deactivateAll()
    await vi.advanceTimersByTimeAsync(5000)
    await done
    expect(calls.sort()).toEqual(['a', 'b', 'c'])
    expect(log).toHaveBeenCalledWith('plugin p.b: deactivate() did not finish within 5 s')
    expect(log).toHaveBeenCalledWith('plugin p.c: no')
    expect(loader.states()).toEqual([])
  })

  it('releases a plugin\'s context when its activate fails and after its deactivate, even for one without deactivate', async () => {
    const released: string[] = []
    const modules: Record<string, unknown> = {
      '/p/ok/host.js': { activate() {}, deactivate() {} },
      '/p/plain/host.js': { activate() {} },
      '/p/bad/host.js': { activate: () => { throw new Error('x') } },
      '/p/nomod/host.js': {}
    }
    const log = vi.fn()
    const loader = new PluginLoader({
      makeContext: fakeCtx,
      requireModule: (p) => modules[p],
      release: (spec) => {
        released.push(spec.id)
        if (spec.id === 'p.ok') throw new Error('release bug')
      },
      log
    })
    await loader.activateAll(['ok', 'plain', 'bad', 'nomod'].map((id) => hostSpec({ id: `p.${id}`, dir: `/p/${id}`, main: 'host.js' })))
    // Failed activations are released at once: they get no deactivate.
    expect(released.sort()).toEqual(['p.bad', 'p.nomod'])
    await loader.deactivateAll()
    expect(released.sort()).toEqual(['p.bad', 'p.nomod', 'p.ok', 'p.plain', 'p.bad', 'p.nomod'].sort())
    // A throwing release is logged and does not stop the others.
    expect(log).toHaveBeenCalledWith('plugin p.ok: releasing its context failed: release bug')
  })

  it('lets an activate still running settle before deactivating, and skips one that then fails', async () => {
    const calls: string[] = []
    const modules: Record<string, unknown> = {
      '/p/ok/host.js': {
        activate: () => new Promise((r) => setTimeout(r, 1000)).then(() => calls.push('ok activated')),
        deactivate: () => void calls.push('ok deactivated')
      },
      '/p/bad/host.js': {
        activate: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 1000)),
        deactivate: () => void calls.push('bad deactivated')
      }
    }
    const loader = new PluginLoader({ makeContext: fakeCtx, requireModule: (p) => modules[p], log: () => {} })
    // The window closes while both are still activating.
    const activating = loader.activateAll(['ok', 'bad'].map((id) => hostSpec({ id: `p.${id}`, dir: `/p/${id}`, main: 'host.js' })))
    const done = loader.deactivateAll()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    await done
    await activating
    expect(calls).toEqual(['ok activated', 'ok deactivated'])
  })
})

describe('ctx basics', () => {
  it('has the api version, the plugin id and a working log', () => {
    const lines: unknown[] = []
    const ctx = createContext(hostSpec({ id: 'x.y', dir: '/d', main: 'm.js' }), { log: (...a) => lines.push(a) })
    expect(ctx.api).toBe(1)
    expect(ctx.pluginId).toBe('x.y')
    ctx.log.warn('count', 3, { a: 1 })
    expect(lines).toEqual([['x.y', 'warn', 'count 3 {"a":1}']])
  })

  it('rejects without main for what needs it', async () => {
    const ctx = createContext(hostSpec({ id: 'x.y', dir: '/d', main: 'm.js' }), { log: () => {} })
    await expect(ctx.notify('hi')).rejects.toThrow('no connection to the app')
    await expect(ctx.sessions.list()).rejects.toThrow('no connection to the app')
  })

  it('caps a log line', () => {
    expect(formatLogArgs(['x'.repeat(5000)]).length).toBe(4001)
  })
})

describe('parsePluginSpecs', () => {
  it('accepts main\'s plugin list and refuses a malformed one', () => {
    const good = hostSpec({ id: 'a.b', dir: '/d', main: 'm.js', commands: ['go'], cli: ['go'], webviewPanels: [] })
    expect(parsePluginSpecs({ plugins: [{ ...good, extra: 1 }] })).toEqual([good])
    expect(() => parsePluginSpecs({})).toThrow('plugins must be an array')
    expect(() => parsePluginSpecs({ plugins: [{ ...good, dir: 5 }] })).toThrow('plugin 0')
    expect(() => parsePluginSpecs({ plugins: [{ ...good, dataDir: undefined }] })).toThrow('projectDir, dataDir and storageFile')
    expect(() => parsePluginSpecs({ plugins: [{ ...good, commands: ['ok', 3] }] })).toThrow('commands must be an array of strings')
    expect(() => parsePluginSpecs({ plugins: [{ ...good, settings: { project: {} } }] })).toThrow('settings must have project and app')
    expect(() => parsePluginSpecs({ plugins: [{ ...good, panels: 'board' }] })).toThrow('panels must be an array of strings')
    // No panels at all is a plugin without panels.
    expect(parsePluginSpecs({ plugins: [{ ...good, panels: undefined }] })[0]?.panels).toEqual([])
    // The same for cli (a spec from a main before contributes.cli); present, it must be names.
    expect(parsePluginSpecs({ plugins: [{ ...good, cli: undefined }] })[0]?.cli).toEqual([])
    expect(() => parsePluginSpecs({ plugins: [{ ...good, cli: [1] }] })).toThrow('cli must be an array of strings')
    // And for webviewPanels (a spec from a main before webview panels).
    expect(parsePluginSpecs({ plugins: [{ ...good, webviewPanels: undefined }] })[0]?.webviewPanels).toEqual([])
    expect(() => parsePluginSpecs({ plugins: [{ ...good, webviewPanels: 'view' }] })).toThrow('webviewPanels must be an array of strings')
  })
})
