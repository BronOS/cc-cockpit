// ctx.secrets (plan "accounts to plugins" Task 3): the per-plugin encrypted store in main
// (plugin-secrets.ts), its host API requests (host-api.ts) and the host-side ctx.secrets, plus the
// cleanup on project forget (registry.ts). Temp data dirs and the test-only fake secret store, or a
// safeStorage stand-in that reports encryption unavailable; nothing touches the real keychain.
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { HostApi, MAX_SECRET_WRITES_PER_WINDOW, type HostApiDeps } from '../../src/main/plugins/host-api'
import { ProjectRegistry } from '../../src/main/projects/registry'
import {
  MAX_SECRET_KEYS,
  MAX_SECRET_VALUE_BYTES,
  PluginSecrets,
  type PluginSecretsOptions
} from '../../src/main/secrets/plugin-secrets'
import { keyFileSecretStore, REPLACED_KEY_TEXT } from '../../src/main/secrets/key-file-store'
import {
  FAKE_PREFIX,
  fakeSecretStore,
  safeStorageSecretStore,
  STORED_BY_KEY_FILE,
  STORED_BY_KEYCHAIN,
  type SecretStore
} from '../../src/main/secrets/secret-store'
import type { FsOps } from '../../src/main/store/json-file'
import { hostSpec } from '../fakes/host-spec'
import { unusedOAuth } from '../fakes/unused-host-services'

const ONE = 'test.one'
const TWO = 'test.two'
const PROJ_A = 'aaaaaaaaaaaaaaaa'
const PROJ_B = 'bbbbbbbbbbbbbbbb'

let dataDir: string
let file: string
let logs: string[]

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-secrets-')))
  file = join(dataDir, 'secrets.json')
  logs = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function open(overrides: Partial<PluginSecretsOptions> = {}): PluginSecrets {
  return new PluginSecrets({ dataDir, store: fakeSecretStore(), log: (m) => logs.push(m), ...overrides })
}

/** Write secrets.json as a previous run (or main's secret settings fields) left it. */
async function preload(plugins: Record<string, Record<string, string>>): Promise<void> {
  const fake = fakeSecretStore()
  const out: Record<string, Record<string, string>> = {}
  for (const [id, entry] of Object.entries(plugins)) {
    out[id] = {}
    for (const [k, v] of Object.entries(entry)) out[id][k] = await fake.encrypt(v)
  }
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, plugins: out }))
}

const onDisk = (): string => readFileSync(file, 'utf8')

describe('PluginSecrets', () => {
  it('round-trips get / set / delete / keys, encrypted on disk and written at once', async () => {
    const s = open()
    expect(await s.get(ONE, 'token')).toBeNull()
    expect(await s.keys(ONE)).toEqual([])
    await s.set(ONE, 'token', 'hunter2-plaintext')
    await s.set(ONE, 'a:first', 'x')
    expect(await s.get(ONE, 'token')).toBe('hunter2-plaintext')
    expect(await s.keys(ONE)).toEqual(['a:first', 'token'])
    // On disk without waiting for a debounce, as the store's output, never as plaintext.
    expect(onDisk()).toContain(FAKE_PREFIX)
    expect(onDisk()).not.toContain('hunter2-plaintext')
    expect(nodeFs.statSync(file).mode & 0o777).toBe(0o600)
    // A new instance (an app restart) reads it back.
    expect(await open().get(ONE, 'token')).toBe('hunter2-plaintext')

    await s.delete(ONE, 'token')
    await s.delete(ONE, 'never-set')
    expect(await s.get(ONE, 'token')).toBeNull()
    expect(await open().keys(ONE)).toEqual(['a:first'])
  })

  it('keeps one store per plugin id', async () => {
    const s = open()
    await s.set(ONE, 'k', 'one')
    await s.set(TWO, 'k', 'two')
    expect(await s.get(ONE, 'k')).toBe('one')
    expect(await s.get(TWO, 'k')).toBe('two')
    await s.delete(ONE, 'k')
    expect(await s.keys(ONE)).toEqual([])
    expect(await s.get(TWO, 'k')).toBe('two')
  })

  it('refuses keys outside the pattern without echoing them', async () => {
    const s = open()
    const bad: unknown[] = ['', '-lead', '.lead', 'has space', 'slash/no', 'x'.repeat(129), '__proto__', 42, null, undefined]
    for (const key of bad) {
      for (const call of [() => s.set(ONE, key, 'v'), () => s.get(ONE, key), () => s.delete(ONE, key)]) {
        const err = await call().then(
          () => null,
          (e: unknown) => e as Error
        )
        expect(err?.message).toMatch(/a key is 1 to 128/)
        if (typeof key === 'string' && key !== '') expect(err?.message).not.toContain(key)
      }
    }
    await s.set(ONE, 'A' + 'x'.repeat(127), 'v')
    await s.set(ONE, '0.a_b:c-d', 'v')
    expect(await s.keys(ONE)).toHaveLength(2)
    expect(existsSync(file)).toBe(true)
  })

  it('looks keys up as own properties only', async () => {
    const s = open()
    expect(await s.get(ONE, 'constructor')).toBeNull()
    expect(await s.get(ONE, 'toString')).toBeNull()
    await s.set(ONE, 'constructor', 'fine')
    expect(await s.get(ONE, 'constructor')).toBe('fine')
    expect(await s.get(TWO, 'constructor')).toBeNull()
  })

  it('limits a value to 64 KiB of UTF-8 and to strings, and never echoes it', async () => {
    const s = open()
    await s.set(ONE, 'max', 'x'.repeat(MAX_SECRET_VALUE_BYTES))
    // 'é' is two bytes: under the limit in characters, over it in bytes.
    const big = 'é'.repeat(MAX_SECRET_VALUE_BYTES / 2 + 1)
    const err = await s.set(ONE, 'big', big).catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/64 KiB/)
    expect((err as Error).message).not.toContain('éé')
    await expect(s.set(ONE, 'num', 5)).rejects.toThrow(/must be a string/)
    await expect(s.set(ONE, 'obj', { a: 1 })).rejects.toThrow(/must be a string/)
    expect(await s.keys(ONE)).toEqual(['max'])
  })

  it(`caps a plugin at ${MAX_SECRET_KEYS} keys, not counting setting: keys, and still lets one be replaced`, async () => {
    const settingKeys: Record<string, string> = {}
    for (let i = 0; i < 5; i++) settingKeys[`setting:app:f${i}`] = 'secret-setting'
    await preload({ [ONE]: settingKeys })
    const s = open()
    for (let i = 0; i < MAX_SECRET_KEYS; i++) await s.set(ONE, `k${i}`, 'v')
    await expect(s.set(ONE, 'one-more', 'v')).rejects.toThrow(/at most 100 secrets/)
    await s.set(ONE, 'k0', 'replaced')
    expect(await s.get(ONE, 'k0')).toBe('replaced')
    // Another plugin's budget is its own.
    await s.set(TWO, 'k', 'v')
    await s.delete(ONE, 'k1')
    await s.set(ONE, 'one-more', 'v')
    expect(await s.keys(ONE)).toHaveLength(MAX_SECRET_KEYS)
  })

  it('checks the cap again after encrypting, so racing sets cannot pass it together', async () => {
    const s = open()
    for (let i = 0; i < MAX_SECRET_KEYS - 1; i++) await s.set(ONE, `k${i}`, 'v')
    const results = await Promise.allSettled([s.set(ONE, 'race-a', 'v'), s.set(ONE, 'race-b', 'v')])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await s.keys(ONE)).toHaveLength(MAX_SECRET_KEYS)
  })

  it('reserves setting: keys: readable, but never set, deleted or listed through the plugin calls', async () => {
    await preload({ [ONE]: { 'setting:app:token': 'from-the-form', mine: 'm' } })
    const s = open()
    await expect(s.set(ONE, 'setting:app:token', 'x')).rejects.toThrow(/reserved/)
    await expect(s.set(ONE, 'setting:new', 'x')).rejects.toThrow(/reserved/)
    await expect(s.delete(ONE, 'setting:app:token')).rejects.toThrow(/reserved/)
    expect(await s.keys(ONE)).toEqual(['mine'])
    expect(await s.get(ONE, 'setting:app:token')).toBe('from-the-form')
  })

  it('stores nothing when the OS cannot encrypt', async () => {
    const unavailable = safeStorageSecretStore(
      {
        isAsyncEncryptionAvailable: async () => false,
        encryptStringAsync: async () => {
          throw new Error('must not be called')
        },
        decryptStringAsync: async () => {
          throw new Error('must not be called')
        }
      },
      'darwin'
    )
    const s = open({ store: unavailable })
    const err = await s.set(ONE, 'token', 'plain-value').catch((e: unknown) => e as Error)
    expect((err as Error).message).toMatch(/keychain is not available/)
    expect((err as Error).message).not.toContain('plain-value')
    expect(existsSync(file)).toBe(false)
    expect(await s.keys(ONE)).toEqual([])
  })

  it('rejects (does not answer null) for a stored value that will not decrypt', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, plugins: { [ONE]: { token: 'bm90LWZha2U=' } } }))
    const s = open()
    await expect(s.get(ONE, 'token')).rejects.toThrow(/not stored by the fake store/)
    expect(await s.keys(ONE)).toEqual(['token'])
  })

  it('fails a set whose write fails, and keeps nothing of it', async () => {
    await preload({ [ONE]: { old: 'kept' } })
    const before = onDisk()
    let failRename = false
    const fs: FsOps = {
      ...nodeFs,
      renameSync: (from, to) => {
        if (failRename) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
        nodeFs.renameSync(from, to)
      }
    }
    const s = open({ fs })
    failRename = true
    const err = await s.set(ONE, 'token', 'new-plain').catch((e: unknown) => e as Error)
    expect((err as Error).message).toMatch(/could not be written/)
    expect((err as Error).message).not.toContain('new-plain')
    expect(await s.get(ONE, 'token')).toBeNull()
    expect(onDisk()).toBe(before)
    expect(logs.join('\n')).not.toContain('new-plain')
    // The disk recovers: the next set writes, and the failed one does not come back with it.
    failRename = false
    await s.set(ONE, 'other', 'v')
    expect(await open().keys(ONE)).toEqual(['old', 'other'])
  })

  it('never overwrites a secrets.json from a newer app', async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, plugins: {} }))
    const before = onDisk()
    const s = open()
    await expect(s.set(ONE, 'token', 'v')).rejects.toThrow(/cannot be written/)
    expect(() => s.removePlugin(ONE)).not.toThrow() // nothing to remove: no write attempted
    expect(onDisk()).toBe(before)
  })

  it('drops damaged entries of a hand-edited file instead of handing them out', async () => {
    const good = await fakeSecretStore().encrypt('ok')
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        plugins: { [ONE]: { good, num: 5, '-bad': good, empty: '' }, 'Not An Id': { k: good }, [TWO]: 'nope' }
      })
    )
    const s = open()
    expect(await s.keys(ONE)).toEqual(['good'])
    expect(await s.get(ONE, 'good')).toBe('ok')
    expect(await s.keys(TWO)).toEqual([])
  })

  it('refuses an id that is not a plugin id', async () => {
    const s = open()
    await expect(s.set('../evil', 'k', 'v')).rejects.toThrow(/unknown plugin/)
    await expect(s.keys('__proto__')).rejects.toThrow(/unknown plugin/)
  })

  it('removePlugin drops the plugin’s whole store, setting: keys included', async () => {
    await preload({ [ONE]: { a: '1', 'setting:app:x': '2' }, [TWO]: { b: '3' } })
    const s = open()
    s.removePlugin(ONE)
    s.removePlugin('test.never')
    const again = open()
    expect(await again.keys(ONE)).toEqual([])
    expect(await again.get(ONE, 'setting:app:x')).toBeNull()
    expect(await again.get(TWO, 'b')).toBe('3')
  })

  it('refuses a set whose encrypt resolves after the plugin was uninstalled, and leaves nothing behind', async () => {
    const fake = fakeSecretStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // The real keychain can hold an encrypt for as long as its prompt stays open.
    const s = open({ store: { ...fake, encrypt: async (v: string) => gate.then(() => fake.encrypt(v)) } })
    const pending = s.set(ONE, 'token', 'orphan').catch((e: unknown) => e as Error)
    s.removePlugin(ONE)
    release()
    const err = await pending
    expect((err as Error).message).toMatch(/uninstalled/)
    expect((err as Error).message).not.toContain('orphan')
    expect(await s.keys(ONE)).toEqual([])
    expect(existsSync(file)).toBe(false)
    // A reinstall stores again.
    await s.set(ONE, 'token', 'fresh')
    expect(await open().get(ONE, 'token')).toBe('fresh')
  })

  it('forgetProject drops that project’s setting:project keys of every plugin, nothing else', async () => {
    await preload({
      [ONE]: { [`setting:project:${PROJ_A}:token`]: 'a1', [`setting:project:${PROJ_B}:token`]: 'b1', 'setting:app:t': 'app' },
      [TWO]: { [`setting:project:${PROJ_A}:x`]: 'a2', [`project:${PROJ_A}:mine`]: 'plugin-set' }
    })
    const s = open()
    s.forgetProject(PROJ_A)
    const again = open()
    expect(await again.get(ONE, `setting:project:${PROJ_A}:token`)).toBeNull()
    expect(await again.get(TWO, `setting:project:${PROJ_A}:x`)).toBeNull()
    expect(await again.get(ONE, `setting:project:${PROJ_B}:token`)).toBe('b1')
    expect(await again.get(ONE, 'setting:app:t')).toBe('app')
    // A plugin's own key that merely looks similar is the plugin's business.
    expect(await again.get(TWO, `project:${PROJ_A}:mine`)).toBe('plugin-set')
  })
})

describe('secrets of the other mode (design-web.md §9.5)', () => {
  const KEYCHAIN_VALUE = 'djExQUJDREVGR0g='
  const keyFile = (name: string): SecretStore =>
    keyFileSecretStore({ path: join(dataDir, name), storedValues: () => [], log: (m) => logs.push(m) })
  const keychain = (): SecretStore =>
    safeStorageSecretStore(
      {
        isAsyncEncryptionAvailable: async () => false,
        encryptStringAsync: async () => Buffer.alloc(0),
        decryptStringAsync: async () => ({ result: '', shouldReEncrypt: false })
      },
      'darwin'
    )
  const write = (values: Record<string, string>): void => writeFileSync(file, JSON.stringify({ schemaVersion: 1, plugins: { [ONE]: values } }))

  it('ctx.secrets.get rejects with the keychain value\'s text under the key file, and a set replaces it', async () => {
    write({ token: KEYCHAIN_VALUE })
    const s = open({ store: keyFile('a.key') })
    await expect(s.get(ONE, 'token')).rejects.toThrow(STORED_BY_KEYCHAIN)
    expect(await s.keys(ONE)).toEqual(['token'])
    await s.set(ONE, 'token', 'fresh')
    expect(await s.get(ONE, 'token')).toBe('fresh')
  })

  it('rejects a key file value under the desktop keychain with the key file text', async () => {
    const value = await keyFile('made.key').encrypt('x')
    write({ token: value })
    await expect(open({ store: keychain() }).get(ONE, 'token')).rejects.toThrow(STORED_BY_KEY_FILE)
  })

  it('rejects a value of a replaced key file, and the text names the remedy', async () => {
    const old = await keyFile('old.key').encrypt('x')
    write({ token: old })
    const s = open({ store: keyFile('new.key') })
    await expect(s.get(ONE, 'token')).rejects.toThrow(REPLACED_KEY_TEXT)
    // Not "not set": a plugin must not quietly ask for a sign-in over a broken store.
    expect(await s.keys(ONE)).toEqual(['token'])
  })

  it('never carries the stored value in the error', async () => {
    write({ token: KEYCHAIN_VALUE })
    const err = await open({ store: keyFile('a.key') })
      .get(ONE, 'token')
      .catch((e: Error) => e)
    expect((err as Error).message).not.toContain(KEYCHAIN_VALUE)
  })

  it('settingState tells set, unset and both unreadable kinds', async () => {
    const old = await keyFile('old.key').encrypt('x')
    write({ 'setting:app:a': KEYCHAIN_VALUE, 'setting:app:b': old, 'setting:app:c': await keyFile('new.key').encrypt('y') })
    const s = open({ store: keyFile('new.key') })
    expect(s.settingState(ONE, 'setting:app:a')).toBe('other-mode')
    expect(s.settingState(ONE, 'setting:app:b')).toBe('replaced')
    expect(s.settingState(ONE, 'setting:app:c')).toBe('set')
    expect(s.settingState(ONE, 'setting:app:d')).toBe('unset')
    // A plugin key is not a setting: never reported.
    expect(s.settingState(ONE, 'token')).toBe('unset')
  })
})

describe('project forget', () => {
  it('drops the project’s secret settings through the registry, whichever way it is forgotten', async () => {
    const work = join(dataDir, 'work')
    mkdirSync(work)
    // `secrets` is read only when forget runs, after the preload below created its file.
    const reg = new ProjectRegistry({ dataDir, log: (m) => logs.push(m), onForget: (pid) => secrets.forgetProject(pid) })
    const { id } = reg.openPath(work)
    await preload({ [ONE]: { [`setting:project:${id}:token`]: 'x', keep: 'y' } })
    const secrets = open()
    reg.forget(id)
    expect(await open().get(ONE, `setting:project:${id}:token`)).toBeNull()
    expect(await open().get(ONE, 'keep')).toBe('y')
    reg.flushAll()
  })

  it('still forgets the project when the cleanup throws', () => {
    const work = join(dataDir, 'work')
    mkdirSync(work)
    const reg = new ProjectRegistry({
      dataDir,
      log: (m) => logs.push(m),
      onForget: () => {
        throw new Error('disk full')
      }
    })
    const { id } = reg.openPath(work)
    reg.markOpen(id)
    expect(() => reg.forget(id)).not.toThrow()
    expect(reg.get(id)).toBeUndefined()
    expect(reg.app.data.openProjects).toEqual([])
    expect(logs.join('\n')).toMatch(/cleanup failed: Error: disk full/)
    reg.flushAll()
  })

  it('does not call the cleanup for a malformed id', () => {
    const onForget = vi.fn()
    const reg = new ProjectRegistry({ dataDir, log: (m) => logs.push(m), onForget })
    reg.forget('../../etc')
    expect(onForget).not.toHaveBeenCalled()
  })
})

describe('host API secrets.*', () => {
  const unused = (): never => {
    throw new Error('not used here')
  }
  function api(secrets: PluginSecrets): HostApi {
    const deps: HostApiDeps = {
      listSessions: () => [],
      session: () => undefined,
      send: unused,
      onSessionsChange: () => () => {},
      openTab: unused,
      setBadge: () => true,
      openOverlay: unused,
      secrets,
      oauth: unusedOAuth,
      log: (m) => logs.push(m)
    }
    return new HostApi(
      deps,
      {
        projectId: PROJ_A,
        windowId: 1,
        projectDir: dataDir,
        plugins: [
          { id: ONE, dir: dataDir, panels: [] },
          { id: TWO, dir: dataDir, panels: [] }
        ]
      },
      () => {}
    )
  }

  /** A request as the host's RPC endpoint makes it: a throw inside a handler becomes a rejection. */
  const rpc =
    (a: HostApi) =>
    (method: string, params: unknown): Promise<unknown> =>
      Promise.resolve().then(() => a.handlers[method]!(params))

  it('serves the plugins of this host', async () => {
    const h = rpc(api(open()))
    expect(await h('secrets.set', { pluginId: ONE, key: 'k', value: 'v' })).toBeNull()
    expect(await h('secrets.get', { pluginId: ONE, key: 'k' })).toBe('v')
    expect(await h('secrets.keys', { pluginId: ONE })).toEqual(['k'])
    // Each id has its own store; the host may name any plugin it runs (design §6 trust boundary).
    expect(await h('secrets.get', { pluginId: TWO, key: 'k' })).toBeNull()
    expect(await h('secrets.delete', { pluginId: ONE, key: 'k' })).toBeNull()
    expect(await h('secrets.keys', { pluginId: ONE })).toEqual([])
  })

  it("reads app-wide and this project's secret settings, not another project's", async () => {
    await preload({
      [ONE]: { 'setting:app:t': 'app', [`setting:project:${PROJ_A}:t`]: 'mine', [`setting:project:${PROJ_B}:t`]: 'theirs' }
    })
    const h = rpc(api(open()))
    expect(await h('secrets.get', { pluginId: ONE, key: 'setting:app:t' })).toBe('app')
    expect(await h('secrets.get', { pluginId: ONE, key: `setting:project:${PROJ_A}:t` })).toBe('mine')
    for (const key of [`setting:project:${PROJ_B}:t`, `setting:project:${PROJ_A}x:t`, 'setting:project:']) {
      const err = await h('secrets.get', { pluginId: ONE, key }).catch((e: unknown) => e as Error)
      expect((err as Error).message, key).toMatch(/another project's secret settings are not readable/)
      // The refusal does not echo the key.
      expect((err as Error).message).not.toContain(PROJ_B)
    }
  })

  it('refuses a plugin id this host does not run, and stores nothing', async () => {
    const secrets = open()
    await secrets.set('test.other', 'k', 'theirs')
    const h = rpc(api(secrets))
    for (const pluginId of ['test.other', undefined, 42, '']) {
      await expect(h('secrets.get', { pluginId, key: 'k' })).rejects.toThrow(/secrets.get: unknown plugin/)
      await expect(h('secrets.set', { pluginId, key: 'k', value: 'x' })).rejects.toThrow(/unknown plugin/)
      await expect(h('secrets.delete', { pluginId, key: 'k' })).rejects.toThrow(/unknown plugin/)
      await expect(h('secrets.keys', { pluginId })).rejects.toThrow(/unknown plugin/)
    }
    expect(await secrets.get('test.other', 'k')).toBe('theirs')
  })

  it(`refuses a plugin's set or delete past ${MAX_SECRET_WRITES_PER_WINDOW} writes per window, other plugins unaffected`, async () => {
    const h = rpc(api(open()))
    for (let i = 0; i < MAX_SECRET_WRITES_PER_WINDOW / 2; i++) {
      await h('secrets.set', { pluginId: ONE, key: 'k', value: `v${i}` })
      await h('secrets.delete', { pluginId: ONE, key: 'k' })
    }
    await expect(h('secrets.set', { pluginId: ONE, key: 'k', value: 'x' })).rejects.toThrow(/secrets.set: more than/)
    await expect(h('secrets.delete', { pluginId: ONE, key: 'k' })).rejects.toThrow(/secrets.delete: more than/)
    expect(await h('secrets.keys', { pluginId: ONE })).toEqual([])
    // Reads are not limited, and each plugin has its own budget.
    expect(await h('secrets.get', { pluginId: ONE, key: 'k' })).toBeNull()
    expect(await h('secrets.set', { pluginId: TWO, key: 'k', value: 'v' })).toBeNull()
  })

  it('answers while the host deactivates, not once it is gone', async () => {
    const a = api(open())
    a.revoke()
    await rpc(a)('secrets.set', { pluginId: ONE, key: 'refreshed', value: 'v' })
    expect(await open().get(ONE, 'refreshed')).toBe('v')
    a.dispose()
    await expect(rpc(a)('secrets.get', { pluginId: ONE, key: 'refreshed' })).rejects.toThrow(/gone/)
  })
})

describe('ctx.secrets (host side)', () => {
  it('asks main with the plugin’s own id and no timeout, and stops after deactivate', async () => {
    const calls: { method: string; params: unknown; options: unknown }[] = []
    const answers: Record<string, unknown> = { 'secrets.get': 'v', 'secrets.keys': ['a', 'b'], 'secrets.set': null, 'secrets.delete': null }
    const contexts = new HostContexts({
      log: () => {},
      call: async (method, params, options) => {
        calls.push({ method, params, options })
        return answers[method]
      }
    })
    const ctx = contexts.create(hostSpec({ id: ONE, dir: dataDir, main: 'host.js' }))
    expect(await ctx.secrets.get('k')).toBe('v')
    expect(await ctx.secrets.set('k', 'value')).toBeUndefined()
    expect(await ctx.secrets.delete('k')).toBeUndefined()
    expect(await ctx.secrets.keys()).toEqual(['a', 'b'])
    expect(calls).toEqual([
      { method: 'secrets.get', params: { pluginId: ONE, key: 'k' }, options: { timeoutMs: Infinity } },
      { method: 'secrets.set', params: { pluginId: ONE, key: 'k', value: 'value' }, options: { timeoutMs: Infinity } },
      { method: 'secrets.delete', params: { pluginId: ONE, key: 'k' }, options: { timeoutMs: Infinity } },
      { method: 'secrets.keys', params: { pluginId: ONE }, options: { timeoutMs: Infinity } }
    ])
    expect(Object.isFrozen(ctx.secrets)).toBe(true)
    contexts.dispose(ONE)
    await expect(ctx.secrets.get('k')).rejects.toThrow(/deactivated/)
    expect(calls).toHaveLength(4)
  })
})
