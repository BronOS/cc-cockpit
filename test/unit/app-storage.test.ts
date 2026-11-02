// ctx.appStorage / ctx.appDataDir (friction round 1, Task 5): main's app-wide store, the host → main
// RPC methods with their plugin check, the hosts of two windows writing at once, and the host-side
// ctx members end to end through HostApi. Temp dirs only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { MAX_RPC_MESSAGE_LENGTH } from '../../src/host/rpc'
import { AppStorage, appStorageFile } from '../../src/main/plugins/app-storage'
import { HostApi, type HostApiDeps, type HostScope } from '../../src/main/plugins/host-api'
import { APP_DATA_FOLDER, pluginAppDataDir, PROJECT_ID_PATTERN, projectId } from '../../src/main/paths'
import { ProjectRegistry } from '../../src/main/projects/registry'
import { PLUGIN_ID_MAX_LENGTH } from '../../src/shared/manifest'
import {
  MAX_APP_KEYS_LENGTH,
  MAX_APP_VALUE_LENGTH,
  MAX_KEY_LENGTH,
  MAX_TOTAL_LENGTH
} from '../../src/shared/plugin-storage'
import { hostSpec } from '../fakes/host-spec'
import { unusedOAuth, unusedSecrets } from '../fakes/unused-host-services'

const A = 'aaaaaaaaaaaaaaaa'
const B = 'bbbbbbbbbbbbbbbb'

let root: string
let store: AppStorage
const apis: HostApi[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-app-storage-')))
  store = new AppStorage({ dataDir: root, debounceMs: 5, log: () => {} })
})

afterEach(() => {
  for (const api of apis.splice(0)) api.dispose()
  store.flush()
  rmSync(root, { recursive: true, force: true })
})

/** HostApi deps with only app storage wired; everything else is unused here. */
function deps(appStorage: AppStorage | null = store): HostApiDeps {
  return {
    listSessions: () => [],
    session: () => undefined,
    send: () => {
      throw new Error('not used')
    },
    onSessionsChange: () => () => {},
    openTab: async () => {
      throw new Error('not used')
    },
    setBadge: () => false,
    openOverlay: async () => {
      throw new Error('not used')
    },
    secrets: unusedSecrets,
    oauth: unusedOAuth,
    ...(appStorage ? { appStorage } : {}),
    log: () => {}
  }
}

const scope = (projectId: string, windowId: number, plugins = ['acme.cap', 'acme.other']): HostScope => ({
  projectId,
  windowId,
  projectDir: root,
  plugins: plugins.map((id) => ({ id, dir: join(root, 'plugins', id), panels: [] }))
})

/** The handlers of one host process, called like the RPC endpoint does (a throw is a rejection). */
function host(s: HostScope, d: HostApiDeps = deps()): { call: (method: string, params?: unknown) => Promise<unknown>; api: HostApi } {
  const api = new HostApi(d, s, () => {})
  apis.push(api)
  const handlers = api.handlers
  return { api, call: (method, params) => Promise.resolve().then(() => handlers[method]!(params)) }
}

describe('AppStorage (main)', () => {
  it('stores JSON values, reads copies, lists and deletes keys; a stored null is not "not set"', () => {
    expect(store.get('acme.cap', 'missing')).toBeNull()
    store.set('acme.cap', 'n', 1)
    store.set('acme.cap', 'obj', { a: [1, { b: null }] })
    store.set('acme.cap', 'nothing', null)
    expect(store.keys('acme.cap')).toEqual(['n', 'obj', 'nothing'])
    expect(store.get('acme.cap', 'nothing')).toEqual({ value: null })
    const got = store.get('acme.cap', 'obj') as { value: { a: unknown[] } }
    got.value.a.push('x')
    expect(store.get('acme.cap', 'obj')).toEqual({ value: { a: [1, { b: null }] } })
    store.delete('acme.cap', 'n')
    store.delete('acme.cap', 'never-set')
    expect(store.keys('acme.cap')).toEqual(['obj', 'nothing'])
  })

  it('keeps one file per plugin under plugin-data/_app, written atomically, opened only on use', () => {
    store.get('acme.cap', 'k')
    store.keys('acme.other')
    // Reads create nothing.
    expect(existsSync(join(root, 'plugin-data'))).toBe(false)
    store.set('acme.cap', 'k', 'one')
    store.set('acme.other', 'k', 'two')
    store.flush()
    const file = appStorageFile(root, 'acme.cap')
    expect(file).toBe(join(root, 'plugin-data', '_app', 'acme.cap', 'storage.json'))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ schemaVersion: 1, values: { k: 'one' } })
    expect(JSON.parse(readFileSync(appStorageFile(root, 'acme.other'), 'utf8')).values).toEqual({ k: 'two' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // A new instance (the next app start) reads it back.
    expect(new AppStorage({ dataDir: root, log: () => {} }).get('acme.cap', 'k')).toEqual({ value: 'one' })
  })

  it('applies the key rules and limits of ctx.storage', () => {
    for (const key of ['', 5, undefined, null, {}]) {
      expect(() => store.get('acme.cap', key)).toThrow('appStorage key must be a non-empty string')
    }
    expect(() => store.set('acme.cap', 'k'.repeat(MAX_KEY_LENGTH + 1), 1)).toThrow('longer than')
    store.set('acme.cap', 'k'.repeat(MAX_KEY_LENGTH), 1)
    // Keys are object properties, never paths, and special names are plain keys.
    for (const key of ['__proto__', 'constructor', '../../x', 'a/b']) store.set('acme.cap', key, key)
    expect(store.get('acme.cap', '__proto__')).toEqual({ value: '__proto__' })
    expect(store.get('acme.cap', 'toString')).toBeNull()
    // Not JSON.
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const value of [undefined, () => 1, cyclic, 1n]) {
      expect(() => store.set('acme.cap', 'bad', value)).toThrow('appStorage value must be JSON')
    }
    // Per value: a little under ctx.storage's 1 MiB (one RPC message).
    expect(() => store.set('acme.cap', 'big', 'x'.repeat(MAX_APP_VALUE_LENGTH))).toThrow('larger than')
    store.set('acme.cap', 'big', 'x'.repeat(MAX_APP_VALUE_LENGTH - 2))
    expect(() => store.set('acme.cap', 'k', 1)).not.toThrow()
  })

  it('caps the total per plugin, counting a replaced value once', () => {
    const chunk = 'x'.repeat(MAX_APP_VALUE_LENGTH - 100)
    const fits = Math.floor(MAX_TOTAL_LENGTH / (MAX_APP_VALUE_LENGTH - 100))
    for (let i = 0; i < fits; i++) store.set('acme.cap', `k${i}`, chunk)
    expect(() => store.set('acme.cap', 'one-more', chunk)).toThrow(`exceed ${MAX_TOTAL_LENGTH}`)
    // Replacing an existing key does not count it twice; another plugin has its own budget.
    store.set('acme.cap', 'k0', chunk)
    store.set('acme.other', 'k0', chunk)
    store.delete('acme.cap', 'k1')
    store.set('acme.cap', 'one-more', chunk)
  })

  it('caps the key list so keys() always fits in one reply', () => {
    // Worst-case keys: control characters escape to six characters each in JSON.
    const key = (i: number): string => `${i}`.padStart(8, '0') + '\u0001'.repeat(MAX_KEY_LENGTH - 8)
    const perKey = JSON.stringify(key(0)).length + 1
    const fits = Math.floor((MAX_APP_KEYS_LENGTH - 2) / perKey)
    for (let i = 0; i < fits; i++) store.set('acme.cap', key(i), 0)
    expect(() => store.set('acme.cap', key(fits), 0)).toThrow('as a list')
    // Replacing a key adds nothing to the list.
    store.set('acme.cap', key(0), 1)
    expect(JSON.stringify(store.keys('acme.cap')).length).toBeLessThanOrEqual(MAX_APP_KEYS_LENGTH)
  })

  it('increments atomically: absent is 0, default 1, any finite step; refuses non-numbers clearly', () => {
    expect(store.increment('acme.cap', 'count', undefined)).toBe(1)
    expect(store.increment('acme.cap', 'count', 2.5)).toBe(3.5)
    expect(store.increment('acme.cap', 'count', -4)).toBe(-0.5)
    expect(store.get('acme.cap', 'count')).toEqual({ value: -0.5 })
    store.set('acme.cap', 'text', '5')
    expect(() => store.increment('acme.cap', 'text', 1)).toThrow('appStorage.increment: the stored value is not a number')
    store.set('acme.cap', 'nothing', null)
    expect(() => store.increment('acme.cap', 'nothing', 1)).toThrow('not a number')
    for (const by of [Number.NaN, Infinity, -Infinity, '1', null, {}]) {
      expect(() => store.increment('acme.cap', 'count', by)).toThrow('by must be a finite number')
    }
    store.set('acme.cap', 'huge', Number.MAX_VALUE)
    expect(() => store.increment('acme.cap', 'huge', Number.MAX_VALUE)).toThrow('not a finite number')
    // Refused calls changed nothing.
    expect(store.get('acme.cap', 'count')).toEqual({ value: -0.5 })
    expect(store.get('acme.cap', 'huge')).toEqual({ value: Number.MAX_VALUE })
  })

  it('refuses an id that is not a plugin id (it becomes a path segment)', () => {
    for (const id of ['../x', 'a/b.c', '', 'UPPER.case', '_app']) {
      expect(() => store.get(id, 'k')).toThrow('appStorage: not a plugin id')
    }
    expect(existsSync(join(root, 'plugin-data'))).toBe(false)
  })

  it('refuses writes to a file it must not overwrite (newer schemaVersion), keeping it intact', () => {
    const file = appStorageFile(root, 'acme.cap')
    mkdirSync(join(file, '..'), { recursive: true })
    const newer = JSON.stringify({ schemaVersion: 99, values: { k: 1 } })
    writeFileSync(file, newer)
    expect(() => store.set('acme.cap', 'k', 2)).toThrow('read-only')
    expect(() => store.increment('acme.cap', 'k', 1)).toThrow('read-only')
    store.flush()
    expect(readFileSync(file, 'utf8')).toBe(newer)
  })

  it('keeps a hand-edited file that has no values object usable', () => {
    const file = appStorageFile(root, 'acme.cap')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, values: [1, 2] }))
    expect(store.keys('acme.cap')).toEqual([])
    expect(store.increment('acme.cap', 'n', 1)).toBe(1)
  })

  it('fits the largest value and key list in one RPC message', () => {
    // The worst envelope: the largest id, the longest plugin id, a key escaped six times over.
    const pluginId = `${'a'.repeat(PLUGIN_ID_MAX_LENGTH - 2)}.b`
    const key = '\u0001'.repeat(MAX_KEY_LENGTH)
    const request = JSON.stringify({
      id: Number.MAX_SAFE_INTEGER,
      method: 'appStorage.increment',
      params: { pluginId, key, value: 'x'.repeat(MAX_APP_VALUE_LENGTH - 2) }
    })
    expect(request.length).toBeLessThanOrEqual(MAX_RPC_MESSAGE_LENGTH)
    const reply = JSON.stringify({ id: Number.MAX_SAFE_INTEGER, result: { value: 'x'.repeat(MAX_APP_VALUE_LENGTH - 2) } })
    expect(reply.length).toBeLessThanOrEqual(MAX_RPC_MESSAGE_LENGTH)
    expect(`{"id":${Number.MAX_SAFE_INTEGER},"result":}`.length + MAX_APP_KEYS_LENGTH).toBeLessThanOrEqual(MAX_RPC_MESSAGE_LENGTH)
  })
})

describe('appStorage.* (HostApi)', () => {
  it('two windows incrementing at once end at the exact sum, and see each other’s writes', async () => {
    const a = host(scope(A, 1))
    const b = host(scope(B, 2))
    const n = 500
    const calls: Promise<unknown>[] = []
    // Interleaved like two hosts' messages arriving at main; each call also reads in between.
    for (let i = 0; i < n; i++) {
      calls.push(a.call('appStorage.increment', { pluginId: 'acme.cap', key: 'month', by: 1 }))
      calls.push(b.call('appStorage.increment', { pluginId: 'acme.cap', key: 'month', by: 2 }))
      calls.push(b.call('appStorage.get', { pluginId: 'acme.cap', key: 'month' }))
    }
    const results = await Promise.all(calls)
    expect(await a.call('appStorage.get', { pluginId: 'acme.cap', key: 'month' })).toEqual({ value: 3 * n })
    // Every increment saw a distinct value: no two read the same before writing.
    const incremented = results.filter((_, i) => i % 3 !== 2) as number[]
    expect(new Set(incremented).size).toBe(2 * n)
    await a.call('appStorage.set', { pluginId: 'acme.cap', key: 'shared', value: { from: 'A' } })
    expect(await b.call('appStorage.get', { pluginId: 'acme.cap', key: 'shared' })).toEqual({ value: { from: 'A' } })
    expect(await b.call('appStorage.keys', { pluginId: 'acme.cap' })).toEqual(['month', 'shared'])
    await b.call('appStorage.delete', { pluginId: 'acme.cap', key: 'shared' })
    expect(await a.call('appStorage.get', { pluginId: 'acme.cap', key: 'shared' })).toBeNull()
    store.flush()
    expect(JSON.parse(readFileSync(appStorageFile(root, 'acme.cap'), 'utf8')).values).toEqual({ month: 3 * n })
  })

  it('refuses a plugin the host does not run, for every method', async () => {
    const b = host(scope(B, 2, ['acme.other']))
    for (const method of ['appStorage.get', 'appStorage.set', 'appStorage.delete', 'appStorage.keys', 'appStorage.increment']) {
      await expect(b.call(method, { pluginId: 'acme.cap', key: 'k', value: 1, by: 1 })).rejects.toThrow(`${method}: unknown plugin`)
      await expect(b.call(method, { key: 'k' })).rejects.toThrow('unknown plugin')
    }
    expect(store.keys('acme.cap')).toEqual([])
  })

  it('works while the host is stopping (a deactivate saving state), not once it is gone', async () => {
    const a = host(scope(A, 1))
    a.api.revoke()
    expect(await a.call('appStorage.increment', { pluginId: 'acme.cap', key: 'k' })).toBe(1)
    a.api.dispose()
    await expect(a.call('appStorage.get', { pluginId: 'acme.cap', key: 'k' })).rejects.toThrow('the plugin host is gone')
  })

  it('passes the store’s errors on, and is refused without a store', async () => {
    const a = host(scope(A, 1))
    await a.call('appStorage.set', { pluginId: 'acme.cap', key: 'text', value: 'x' })
    await expect(a.call('appStorage.increment', { pluginId: 'acme.cap', key: 'text', by: 1 })).rejects.toThrow('not a number')
    await expect(a.call('appStorage.set', { pluginId: 'acme.cap', key: 'k' })).rejects.toThrow('must be JSON')
    const none = host(scope(A, 3), deps(null))
    await expect(none.call('appStorage.keys', { pluginId: 'acme.cap' })).rejects.toThrow('app storage is not available')
  })
})

describe('ctx.appStorage and ctx.appDataDir (host)', () => {
  /** A ctx whose RPC goes straight to a HostApi of `projectId`, recording each method called. */
  function ctxFor(projectId: string, windowId: number) {
    const { call } = host(scope(projectId, windowId))
    const methods: string[] = []
    const contexts = new HostContexts({
      log: () => {},
      call: (method, params) => {
        methods.push(method)
        return call(method, params)
      }
    })
    const spec = hostSpec({ id: 'acme.cap', dir: join(root, 'plugins', 'acme.cap'), main: 'm.js', appDataDir: pluginAppDataDir(root, 'acme.cap') })
    return { ctx: contexts.create(spec), contexts, methods }
  }

  it('reaches main’s store: the same keys from two projects, increment with its default', async () => {
    const one = ctxFor(A, 1)
    const two = ctxFor(B, 2)
    expect(await one.ctx.appStorage.get('k')).toBeUndefined()
    await one.ctx.appStorage.set('k', { n: [1] })
    expect(await two.ctx.appStorage.get('k')).toEqual({ n: [1] })
    await two.ctx.appStorage.set('none', null)
    expect(await one.ctx.appStorage.get('none')).toBeNull()
    expect(await one.ctx.appStorage.increment('c')).toBe(1)
    expect(await two.ctx.appStorage.increment('c', 4)).toBe(5)
    expect(await one.ctx.appStorage.increment('c', -0.5)).toBe(4.5)
    expect(await two.ctx.appStorage.keys()).toEqual(['k', 'none', 'c'])
    await one.ctx.appStorage.delete('k')
    expect(await two.ctx.appStorage.keys()).toEqual(['none', 'c'])
    await expect(one.ctx.appStorage.increment('none')).rejects.toThrow('appStorage.increment: the stored value is not a number')
  })

  it('refuses a bad key, value or step before asking main', async () => {
    const { ctx, methods } = ctxFor(A, 1)
    await expect(ctx.appStorage.get('')).rejects.toThrow('appStorage key must be a non-empty string')
    await expect(ctx.appStorage.set('k'.repeat(MAX_KEY_LENGTH + 1), 1)).rejects.toThrow('longer than')
    await expect(ctx.appStorage.set('k', 'x'.repeat(MAX_APP_VALUE_LENGTH))).rejects.toThrow('larger than')
    await expect(ctx.appStorage.set('k', (() => 1) as never)).rejects.toThrow('must be JSON')
    await expect(ctx.appStorage.increment('k', Number.NaN)).rejects.toThrow('by must be a finite number')
    await expect(ctx.appStorage.increment('k', '2' as never)).rejects.toThrow('by must be a finite number')
    expect(methods).toEqual([])
  })

  it('rejects after deactivate', async () => {
    const { ctx, contexts } = ctxFor(A, 1)
    contexts.dispose('acme.cap')
    await expect(ctx.appStorage.keys()).rejects.toThrow('deactivated')
    await expect(ctx.appStorage.increment('k')).rejects.toThrow('deactivated')
  })

  it('creates appDataDir on first read, the same folder in every project', () => {
    const one = ctxFor(A, 1)
    const two = ctxFor(B, 2)
    const dir = pluginAppDataDir(root, 'acme.cap')
    expect(existsSync(dir)).toBe(false)
    expect(one.ctx.appDataDir).toBe(dir)
    expect(statSync(dir).isDirectory()).toBe(true)
    expect(two.ctx.appDataDir).toBe(dir)
    expect(dir).toBe(join(root, 'plugin-data', '_app', 'acme.cap'))
  })
})

describe('_app is never a project id', () => {
  it('is outside the project id pattern every project id matches', () => {
    expect(APP_DATA_FOLDER).toBe('_app')
    expect(PROJECT_ID_PATTERN.test(APP_DATA_FOLDER)).toBe(false)
    for (const path of ['/', '/Users/me/proj', '/home/x/_app', '_app']) expect(projectId(path)).toMatch(PROJECT_ID_PATTERN)
  })

  it('is not a project to the registry, and forgetting a project keeps the app data', () => {
    const registry = new ProjectRegistry({ dataDir: root, debounceMs: 5, log: () => {} })
    expect(registry.get(APP_DATA_FOLDER)).toBeUndefined()
    const proj = join(root, 'proj')
    mkdirSync(proj)
    const id = registry.openPath(proj).id
    store.set('acme.cap', 'k', 1)
    store.flush()
    const projectData = join(root, 'plugin-data', id, 'acme.cap')
    mkdirSync(projectData, { recursive: true })
    registry.forget(id)
    registry.forget(APP_DATA_FOLDER)
    registry.flushAll()
    expect(existsSync(appStorageFile(root, 'acme.cap'))).toBe(true)
    expect(existsSync(projectData)).toBe(true)
  })
})
