// The secret settings field (plan "accounts to plugins" Task 4): `"format": "secret"` on a
// top-level property of a plugin's settings schema. The schema walker's placement rule, validation
// without the secret fields, the renderer payloads that never carry a value, the settings services
// storing through PluginSecrets under `setting:` keys, the decrypted cache, and the host spec that
// gets the plaintext after a save and after an app restart. Temp data dirs and the test-only fake
// secret store (or a safeStorage stand-in that cannot encrypt); nothing touches the real keychain.
import * as nodeFs from 'node:fs'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RpcEndpoint } from '../../src/host/rpc'
import type { HostPluginSpec } from '../../src/host/loader'
import { HostManager, type HostProcess, type HostProcessFactory } from '../../src/main/plugins/host-manager'
import type { InstalledPlugin } from '../../src/main/plugins/installer'
import { checkPluginSettings, compileSettingsSchema, validateSettings } from '../../src/main/plugins/validate'
import { PluginSecrets, type PluginSecretsOptions } from '../../src/main/secrets/plugin-secrets'
import { FAKE_PREFIX, fakeSecretStore, safeStorageSecretStore, type SecretStore } from '../../src/main/secrets/secret-store'
import { checkFormSettings, checkSecretEdits, hostSettingsOf, settingsViewOf } from '../../src/main/settings/plugin-settings'
import { ProjectSettingsService } from '../../src/main/settings/project-settings-service'
import { SettingsService } from '../../src/main/settings/settings-service'
import { defaultLayout } from '../../src/shared/layout'
import type { JsonSchema, PluginManifest } from '../../src/shared/manifest'
import type { ProjectRecord, ProjectView } from '../../src/shared/types'
import { memoryPortPair } from '../fakes/memory-port'

const ID = 'test.secretui'
const P = 'aaaaaaaaaaaaaaaa'
const Q = 'bbbbbbbbbbbbbbbb'
const PLAIN = 'plaintext-token-123'

const appSchema: JsonSchema = {
  type: 'object',
  properties: {
    site: { type: 'string', default: 'example' },
    token: { type: 'string', format: 'secret', title: 'Token' }
  },
  // Required, and unset at first: must not disable the plugin.
  required: ['token']
}
const projectSchema: JsonSchema = {
  type: 'object',
  properties: { board: { type: 'string', default: 'main' }, key: { type: 'string', format: 'secret', title: 'Key' } }
}

const manifest: PluginManifest = {
  id: ID,
  name: 'Secret UI',
  version: '1.0.0',
  api: 1,
  main: 'host.js',
  contributes: { settings: { app: appSchema, project: projectSchema } }
}

let dataDir: string
let logs: string[]

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-secret-settings-')))
  logs = []
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function openSecrets(overrides: Partial<PluginSecretsOptions> = {}): PluginSecrets {
  return new PluginSecrets({ dataDir, store: fakeSecretStore(), log: (m) => logs.push(m), ...overrides })
}

const secretsFile = (): string => readFileSync(join(dataDir, 'secrets.json'), 'utf8')

const unavailableStore = (): SecretStore =>
  safeStorageSecretStore(
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

describe('schema walker', () => {
  const withProps = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}): JsonSchema => ({
    type: 'object',
    properties,
    ...extra
  })
  const errorsOf = (schema: JsonSchema): string => {
    const r = compileSettingsSchema(schema)
    return r.ok ? '' : r.errors.join('; ')
  }

  it('accepts a top-level string secret, required or not', () => {
    expect(compileSettingsSchema(appSchema).ok).toBe(true)
    expect(compileSettingsSchema(withProps({ a: { type: 'string', format: 'secret' }, b: { type: 'number' } })).ok).toBe(true)
  })

  it('refuses a secret anywhere but a top-level property', () => {
    const secret = { type: 'string', format: 'secret' }
    const cases: JsonSchema[] = [
      withProps({ nested: { type: 'object', properties: { token: secret } } }),
      withProps({ list: { type: 'array', items: secret } }),
      withProps({ a: { type: 'string' } }, { allOf: [{ properties: { token: secret } }] }),
      withProps({ a: { type: 'string' } }, { anyOf: [{ properties: { token: secret } }] }),
      withProps({ a: { oneOf: [secret, { type: 'number' }] } }),
      // A `$ref` target: the definition is not a top-level property, wherever it is used.
      withProps({ token: { $ref: '#/definitions/s' } }, { definitions: { s: secret } }),
      withProps({ extra: { type: 'string' } }, { additionalProperties: secret })
    ]
    for (const schema of cases) expect(errorsOf(schema), JSON.stringify(schema)).toMatch(/"format": "secret" is allowed only/)
  })

  it('refuses a secret with a default, of another type, or with a name that cannot be a key', () => {
    expect(errorsOf(withProps({ token: { type: 'string', format: 'secret', default: 'x' } }))).toMatch(/may not have a "default"/)
    expect(errorsOf(withProps({ token: { type: 'number', format: 'secret' } }))).toMatch(/"type": "string"/)
    expect(errorsOf(withProps({ token: { type: ['string', 'null'], format: 'secret' } }))).toMatch(/"type": "string"/)
    expect(errorsOf(withProps({ 'a:b': { type: 'string', format: 'secret' } }))).toMatch(/secret field's name/)
    expect(errorsOf(withProps({ ['x'.repeat(65)]: { type: 'string', format: 'secret' } }))).toMatch(/secret field's name/)
  })

  it('refuses every reference keyword anywhere in a schema with secret fields', () => {
    const secret = { type: 'string', format: 'secret' }
    const props = { token: secret, site: { type: 'string' } }
    const cases: Record<string, unknown>[] = [
      // A copy of the root, the properties or a secret, somewhere nothing takes it out of the values.
      ...['#', '#/properties', '#/properties/token', '#/properties/tok%65n'].map((ref) => ({ properties: { ...props, copy: { $ref: ref } } })),
      // Even a ref to a plain property: the rule does not read pointers.
      { properties: { ...props, copy: { $ref: '#/properties/site' } } },
      // The reviewers' cases: an anchor ajv resolves and main's pointer reading did not ...
      { allOf: [{ $ref: '#base' }], definitions: { b: { $anchor: 'base', properties: { token: { default: 'plain' } } } } },
      // ... and a pointer the form decodes as a whole (`x` / `default`) and ajv per segment.
      {
        properties: { ...props, x: { type: 'object', default: secret }, 'x/default': { type: 'string' }, y: { $ref: '#/properties/x%2Fdefault' } }
      },
      // Through a ref from the root, also from inside a combinator.
      { $ref: '#/definitions/base', definitions: { base: { required: ['token'] } } },
      { allOf: [{ $ref: '#/definitions/base' }], definitions: { base: { properties: { token: { minLength: 1 } } } } },
      // The other reference and identity keywords, and the keyword as a property name or in data.
      { definitions: { a: { $dynamicAnchor: 'a', type: 'string' } }, properties: { ...props, y: { $dynamicRef: '#a' } } },
      { properties: { ...props, y: { $recursiveRef: '#' } } },
      { properties: { ...props, y: { $recursiveAnchor: true, type: 'string' } } },
      { properties: { ...props, y: { $id: 'https://x.example/y', type: 'string' } } },
      { properties: { ...props, $ref: { type: 'string' } } },
      { properties: { ...props, y: { type: 'object', default: { $ref: '#/properties/token' } } } }
    ]
    for (const extra of cases) {
      const schema = { type: 'object', properties: props, ...extra }
      expect(errorsOf(schema), JSON.stringify(extra)).toMatch(/is not allowed in a schema with secret fields/)
    }
    // A schema without secret fields keeps its local refs and anchors.
    const plain = withProps({ a: { $ref: '#/definitions/b' }, c: { $ref: '#b' } }, { definitions: { b: { $anchor: 'b', type: 'string' } } })
    expect(compileSettingsSchema(plain).ok).toBe(true)
  })

  it('refuses a $ref into a default, enum, const or examples value, where a secret is data the walk does not check', () => {
    const secret = { type: 'string', format: 'secret' }
    const cases: JsonSchema[] = [
      withProps({ tok: { $ref: '#/definitions/d/default' } }, { definitions: { d: { type: 'object', default: secret } } }),
      withProps({ x: { type: 'object', examples: [secret] }, tok: { $ref: '#/properties/x/examples/0' } }),
      withProps({ x: { enum: [secret] }, tok: { $ref: '#/properties/x/enum/0' } }),
      withProps({ x: { const: secret }, tok: { $ref: '#/properties/x/const' } }),
      withProps({ x: { type: 'object', default: secret } }, { allOf: [{ properties: { tok: { $ref: '#/properties/x/def%61ult' } } }] }),
      // A schema (a property named `x/default`) to ajv, but `x`'s default to the form, which
      // percent-decodes the whole fragment before it splits it.
      withProps({ x: { type: 'object', default: secret }, 'x/default': { type: 'string' }, tok: { $ref: '#/properties/x%2Fdefault' } }),
      // Not only with a secret: whatever data the ref picks up would be used as a schema unchecked.
      withProps({ x: { type: 'object', default: { type: 'string' } }, y: { $ref: '#/properties/x/default' } })
    ]
    for (const schema of cases) expect(errorsOf(schema), JSON.stringify(schema)).toMatch(/must point at a schema, not into/)
    // A property or definition merely named like a data keyword is a schema, and may be referenced.
    expect(compileSettingsSchema(withProps({ default: { type: 'string' }, y: { $ref: '#/properties/default' } })).ok).toBe(true)
    expect(compileSettingsSchema(withProps({ y: { $ref: '#/definitions/examples' } }, { definitions: { examples: { type: 'string' } } })).ok).toBe(true)
  })

  it('reads "format" inside a default, enum or const as data, not as a misplaced secret', () => {
    const s = withProps({ opts: { type: 'object', default: { format: 'secret' } }, e: { enum: [{ format: 'secret' }] } })
    expect(compileSettingsSchema(s).ok).toBe(true)
    // A property named `default` is a schema; its own `default` keyword is data again.
    expect(compileSettingsSchema(withProps({ default: { type: 'object', default: { format: 'secret' } } })).ok).toBe(true)
  })

  it('reads a property or definition named like a data keyword as a schema, so a secret under it is still refused', () => {
    const secret = { type: 'string', format: 'secret' }
    for (const name of ['const', 'default', 'enum', 'examples']) {
      const nested = withProps({ [name]: { type: 'object', properties: { token: secret } } })
      expect(errorsOf(nested), name).toMatch(/"format": "secret" is allowed only/)
      const ref = withProps({ token: secret, [name]: { type: 'object', properties: { x: { $ref: '#/properties/token' } } } })
      expect(errorsOf(ref), name).toMatch(/"\$ref" is not allowed in a schema with secret fields/)
      const def = withProps({ a: { $ref: `#/definitions/${name}` } }, { definitions: { [name]: { type: 'object', properties: { token: secret } } } })
      expect(errorsOf(def), name).toMatch(/"format": "secret" is allowed only/)
    }
    // And never reaches the renderer as a plain value: the plugin is disabled instead.
    const bad = withProps({ const: { type: 'object', properties: { token: secret } } })
    expect(settingsViewOf(bad, { const: { token: PLAIN } }).problem).toMatch(/"format": "secret"/)
  })

  it('refuses a root combinator or dependency that names a secret field', () => {
    const secret = { type: 'string', format: 'secret' }
    const props = { site: { type: 'string' }, token: secret }
    const cases: Record<string, unknown>[] = [
      // ajv's useDefaults would fill the manifest's plaintext back into the values.
      { allOf: [{ properties: { token: { default: 'manifest-plain' } } }] },
      // Checked without the secret fields, these could never pass.
      { allOf: [{ required: ['token'] }] },
      { anyOf: [{ required: ['token'] }, { required: ['site'] }] },
      { if: { required: ['site'] }, then: { required: ['token'] } },
      { not: { required: ['token'] } },
      { dependencies: { site: ['token'] } },
      { dependentRequired: { site: ['token'] } },
      { dependencies: { site: { required: ['token'] } } }
    ]
    for (const extra of cases) expect(errorsOf(withProps(props, extra)), JSON.stringify(extra)).toMatch(/a secret field may be named only in the top-level/)
    // Combinators over the other fields are fine, and so are definitions nothing at the root applies.
    expect(compileSettingsSchema(withProps(props, { allOf: [{ properties: { site: { minLength: 1 } } }], required: ['token'] })).ok).toBe(true)
    expect(compileSettingsSchema(withProps(props, { definitions: { unused: { required: ['token'] } } })).ok).toBe(true)
    // The reviewer's case: no manifest plaintext reaches the values.
    expect(validateSettings(withProps(props, { allOf: [{ properties: { token: { default: 'manifest-plain' } } }] }), {}).ok).toBe(false)
  })

  it('refuses keywords on a secret field that would never be checked', () => {
    for (const extra of [{ minLength: 40 }, { maxLength: 4 }, { enum: ['a'] }, { const: 'a' }, { examples: ['a'] }, { allOf: [{ minLength: 1 }] }]) {
      const s = withProps({ token: { type: 'string', format: 'secret', ...extra } })
      expect(errorsOf(s), JSON.stringify(extra)).toMatch(/a secret field allows only "type", "format", "title", "description" and "\$comment"/)
    }
    expect(compileSettingsSchema(withProps({ token: { type: 'string', format: 'secret', title: 'T', description: 'D', $comment: 'c' } })).ok).toBe(true)
  })

  it('disables a plugin whose manifest misplaces a secret, with the reason', () => {
    const bad = { ...manifest, contributes: { settings: { app: withProps({ list: { type: 'array', items: { type: 'string', format: 'secret' } } }) } } }
    const r = checkPluginSettings(bad, {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/invalid app settings: .*"format": "secret"/)
  })
})

describe('validation and views without secret values', () => {
  it('validates without the secret fields: an unset required secret is fine, a stored one is dropped', () => {
    expect(validateSettings(appSchema, {})).toEqual({ ok: true, value: { site: 'example' } })
    // A hand-edited app.json that put a value there: never handed on.
    expect(validateSettings(appSchema, { token: 'from-json' })).toEqual({ ok: true, value: { site: 'example' } })
    expect(checkPluginSettings(manifest, {})).toEqual({ ok: true, app: { site: 'example' }, project: { board: 'main' } })
    // additionalProperties: false still holds for the other fields, and the secret is no "additional" one.
    const closed = { ...appSchema, additionalProperties: false }
    expect(validateSettings(closed, { token: 'x' }).ok).toBe(true)
    expect(validateSettings(closed, { other: 1 }).ok).toBe(false)
  })

  it('drops a secret the form put inside values instead of storing it', () => {
    expect(checkFormSettings(appSchema, { site: 's', token: PLAIN })).toEqual({ ok: true, value: { site: 's' } })
  })

  it('never puts a value in the view, also not in the raw values of a problem', () => {
    const ok = settingsViewOf(appSchema, { site: 's' }, (f) => f === 'token')
    expect(ok).toEqual({ schema: appSchema, values: { site: 's' }, secretFields: { token: { set: true } } })
    const bad = settingsViewOf(appSchema, { site: 5, token: PLAIN }, () => false)
    expect(bad.problem).toMatch(/site/)
    expect(bad.values).toEqual({ site: 5 })
    expect(JSON.stringify(bad)).not.toContain(PLAIN)
    expect(bad.secretFields).toEqual({ token: { set: false } })
    // No secret fields, no `secretFields`.
    expect(settingsViewOf({ type: 'object' }, {})).toEqual({ schema: { type: 'object' }, values: {} })
  })

  it('accepts secret edits only for the schema’s secret fields, as a non-empty string or null', () => {
    expect(checkSecretEdits(appSchema, undefined)).toEqual(new Map())
    expect(checkSecretEdits(appSchema, { token: 'v' })).toEqual(new Map([['token', 'v']]))
    expect(checkSecretEdits(appSchema, { token: null })).toEqual(new Map([['token', null]]))
    expect(() => checkSecretEdits(appSchema, { site: 'v' })).toThrow(/not a secret field/)
    expect(() => checkSecretEdits(appSchema, { [PLAIN]: 'v' })).toThrow(/^secrets: not a secret field of this plugin$/)
    expect(() => checkSecretEdits(appSchema, { token: '' })).toThrow(/non-empty string/)
    expect(() => checkSecretEdits(appSchema, { token: 5 })).toThrow(/non-empty string/)
    expect(() => checkSecretEdits(appSchema, ['token'])).toThrow(/object/)
  })
})

/** The two settings services over a real PluginSecrets and in-memory app/project stores. */
function services(secrets: PluginSecrets) {
  const installed: InstalledPlugin = {
    id: ID,
    version: '1.0.0',
    source: { kind: 'linked', path: '/dev/x' },
    state: { ok: true },
    dir: '/dev/x',
    themes: [],
    manifest
  }
  const appSettings = new Map<string, Record<string, unknown>>()
  const records = new Map<string, ProjectView>(
    [P, Q].map((id) => [
      id,
      {
        schemaVersion: 1,
        id,
        path: `/work/${id}`,
        name: id,
        enabledPlugins: [ID],
        pluginSettings: {},
        layout: defaultLayout(),
        tabs: [],
        lastOpenedAt: 1,
        missing: false
      }
    ])
  )
  const announced: string[] = []
  const host = (projectId: string) =>
    hostSettingsOf(manifest, { app: appSettings.get(ID), project: records.get(projectId)?.pluginSettings[ID] }, secrets, projectId)
  const app = new SettingsService({
    projects: { list: () => [], get: () => undefined, relink: () => { throw new Error('unused') }, forget: () => {}, update: () => {} },
    hasWindow: () => false,
    openProjectPath: () => {},
    pickFolder: async () => undefined,
    plugins: {
      applyRevocations: async () => {},
      list: () => [installed],
      get: (id) => (id === ID ? installed : undefined),
      install: async () => installed,
      link: async () => installed,
      update: async () => installed,
      uninstall: async () => {}
    },
    marketplace: { list: () => [], refresh: async () => {}, revocationFor: () => null, revocationWarnings: () => [], prune: () => {} },
    setMarketplaceUrls: () => {},
    pluginRepos: { get: () => undefined, set: () => {} },
    disableEverywhere: () => {},
    enabledInAProject: () => false,
    appPluginSettings: { get: (id) => appSettings.get(id), set: (id, v) => void appSettings.set(id, v) },
    // What the hosts would read right now (the cache must be current when this runs).
    pluginSettingsChanged: async () => void announced.push(`app ${JSON.stringify(host(P))}`),
    secrets
  })
  const project = new ProjectSettingsService({
    projects: {
      get: (id) => records.get(id),
      update: (id, mutate) => {
        const r = records.get(id)
        if (r) mutate(r as ProjectRecord)
      }
    },
    plugins: { list: () => [installed], get: (id) => (id === ID ? installed : undefined) },
    checkSettings: (projectId) => {
      const r = host(projectId)
      return r.ok ? { ok: true } : r
    },
    enabledChanged: async () => {},
    settingsChanged: async (projectId) => void announced.push(`project ${projectId} ${JSON.stringify(host(projectId))}`),
    layouts: { view: () => undefined, move: () => undefined },
    secrets
  })
  return { app, project, appSettings, records, announced, host }
}

describe('settings services', () => {
  it('stores an app-wide secret encrypted, never in app.json, the result or the view; the host gets the plaintext', async () => {
    const secrets = openSecrets()
    const { app, appSettings, announced, host } = services(secrets)
    // Required but unset: the plugin is not disabled, the form shows "Not set".
    expect(host(P)).toEqual({ ok: true, app: { site: 'example' }, project: { board: 'main' } })
    expect(app.plugins()[0]!.appSettings?.secretFields).toEqual({ token: { set: false } })

    const result = await app.savePluginSettings(ID, { site: 's', token: 'ignored-in-values' }, { token: PLAIN })
    expect(result).toEqual({ ok: true, values: { site: 's' }, secretFields: { token: { set: true } } })
    expect(appSettings.get(ID)).toEqual({ site: 's' })
    expect(secretsFile()).toContain('setting:app:token')
    expect(secretsFile()).toContain(FAKE_PREFIX)
    expect(secretsFile()).not.toContain(PLAIN)
    const views = JSON.stringify(app.plugins())
    expect(views).not.toContain(PLAIN)
    expect(app.plugins()[0]!.appSettings?.secretFields).toEqual({ token: { set: true } })
    // The hosts were told after the cache had the value.
    expect(announced).toEqual([`app ${JSON.stringify({ ok: true, app: { site: 's', token: PLAIN }, project: { board: 'main' } })}`])

    // Saving without an edit keeps it; a clear removes it from the store and the hosts' settings.
    await app.savePluginSettings(ID, { site: 't' }, {})
    expect(host(P)).toMatchObject({ app: { site: 't', token: PLAIN } })
    const cleared = await app.savePluginSettings(ID, { site: 't' }, { token: null })
    expect(cleared).toEqual({ ok: true, values: { site: 't' }, secretFields: { token: { set: false } } })
    expect(secretsFile()).not.toContain('setting:app:token')
    expect(host(P)).toEqual({ ok: true, app: { site: 't' }, project: { board: 'main' } })
  })

  it('runs overlapping saves of one plugin in call order, so one save’s secrets never pair with another’s values', async () => {
    const fake = fakeSecretStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    // The first save's encrypt waits (a keychain prompt); the second's would finish at once.
    const secrets = openSecrets({ store: { ...fake, encrypt: async (v: string) => (v === 'first' ? gate.then(() => fake.encrypt(v)) : fake.encrypt(v)) } })
    const { app, appSettings, host } = services(secrets)
    const one = app.savePluginSettings(ID, { site: 'one' }, { token: 'first' })
    const two = app.savePluginSettings(ID, { site: 'two' }, { token: 'second' })
    // The second waits for the first instead of overtaking it.
    await new Promise((r) => setTimeout(r, 10))
    expect(appSettings.get(ID)).toBeUndefined()
    release()
    await Promise.all([one, two])
    expect(appSettings.get(ID)).toEqual({ site: 'two' })
    expect(host(P)).toMatchObject({ app: { site: 'two', token: 'second' } })
    // A failed save does not block the next one.
    const failing = openSecrets({ store: { ...fake, encrypt: async () => Promise.reject(new Error('refused')) } })
    const svc = services(failing).app
    expect((await svc.savePluginSettings(ID, { site: 'x' }, { token: 'v' })).ok).toBe(false)
    expect((await svc.savePluginSettings(ID, { site: 'y' }, {})).ok).toBe(true)
  })

  it('refuses a save queued behind another when the plugin is uninstalled or the project forgotten meanwhile', async () => {
    // The first save's encrypt waits (a keychain prompt); the cleanup runs during it. The second
    // save starts only after it, and must not store the deleted credential again.
    const gated = () => {
      const fake = fakeSecretStore()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      const s = openSecrets({ store: { ...fake, encrypt: async (v: string) => (v === 'first' ? gate.then(() => fake.encrypt(v)) : fake.encrypt(v)) } })
      return { s, release, ...services(s) }
    }

    const removed = gated()
    const one = removed.app.savePluginSettings(ID, { site: 'one' }, { token: 'first' })
    const two = removed.app.savePluginSettings(ID, { site: 'two' }, { token: 'second' })
    removed.s.removePlugin(ID)
    removed.release()
    for (const result of await Promise.all([one, two])) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join(' ')).toMatch(/the plugin was uninstalled/)
    }
    expect(removed.s.hasSetting(ID, 'setting:app:token')).toBe(false)
    expect(removed.s.cachedSetting(ID, 'setting:app:token')).toBeUndefined()
    expect(removed.appSettings.get(ID)).toBeUndefined()
    expect(openSecrets().hasSetting(ID, 'setting:app:token')).toBe(false)

    const forgot = gated()
    const p1 = forgot.project.saveSettings(P, ID, { board: 'one' }, { key: 'first' })
    const p2 = forgot.project.saveSettings(P, ID, { board: 'two' }, { key: 'second' })
    forgot.s.forgetProject(P)
    forgot.release()
    for (const result of await Promise.all([p1, p2])) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join(' ')).toMatch(/the project was forgotten/)
    }
    expect(forgot.s.hasSetting(ID, `setting:project:${P}:key`)).toBe(false)
    expect(forgot.s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    // A save requested after the cleanup is a new request and goes through.
    expect((await forgot.app.savePluginSettings(ID, { site: 's' }, { token: 'after' })).ok).toBe(true)
  })

  it('refuses a plain-only save queued behind another across a project forget and reopen, or an uninstall', async () => {
    const gated = () => {
      const fake = fakeSecretStore()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      const s = openSecrets({ store: { ...fake, encrypt: async (v: string) => (v === 'first' ? gate.then(() => fake.encrypt(v)) : fake.encrypt(v)) } })
      return { s, release, ...services(s) }
    }

    // The second save edits no secret: it has no key of the project to be guarded by.
    const forgot = gated()
    const p1 = forgot.project.saveSettings(P, ID, { board: 'one' }, { key: 'first' })
    const p2 = forgot.project.saveSettings(P, ID, { board: 'old' }, {})
    forgot.s.forgetProject(P)
    // Opened again: a new record under the same id (registry ids come from the folder).
    const reopened = { ...forgot.records.get(P)!, pluginSettings: {} }
    forgot.records.set(P, reopened)
    forgot.release()
    for (const result of await Promise.all([p1, p2])) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join(' ')).toMatch(/the project was forgotten/)
    }
    expect(forgot.records.get(P)!.pluginSettings).toEqual({})
    expect(forgot.announced).toEqual([])
    // The reopened project's own saves go through.
    expect((await forgot.project.saveSettings(P, ID, { board: 'new' }, {})).ok).toBe(true)
    expect(forgot.records.get(P)!.pluginSettings[ID]).toEqual({ board: 'new' })

    const removed = gated()
    const a1 = removed.app.savePluginSettings(ID, { site: 'one' }, { token: 'first' })
    const a2 = removed.app.savePluginSettings(ID, { site: 'old' }, {})
    removed.s.removePlugin(ID)
    removed.release()
    for (const result of await Promise.all([a1, a2])) {
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.errors.join(' ')).toMatch(/the plugin was uninstalled/)
    }
    expect(removed.appSettings.get(ID)).toBeUndefined()
  })

  it('stores nothing, secret included, when the values are refused', async () => {
    const secrets = openSecrets()
    const { app, appSettings } = services(secrets)
    const result = await app.savePluginSettings(ID, { site: 5 }, { token: PLAIN })
    expect(result.ok).toBe(false)
    expect(secrets.hasSetting(ID, 'setting:app:token')).toBe(false)
    expect(appSettings.size).toBe(0)
    await expect(app.savePluginSettings(ID, {}, { site: 'x' })).rejects.toThrow(/not a secret field/)
  })

  it('stores nothing when the OS cannot encrypt, and the error carries no value', async () => {
    const secrets = openSecrets({ store: unavailableStore() })
    const { app, appSettings, announced } = services(secrets)
    const result = await app.savePluginSettings(ID, { site: 's' }, { token: PLAIN })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/could not be stored: .*keychain is not available/)
    expect(JSON.stringify(result)).not.toContain(PLAIN)
    expect(appSettings.size).toBe(0)
    expect(announced).toEqual([])
  })

  it('keys a project secret by the project main resolved; other projects do not see it', async () => {
    const secrets = openSecrets()
    const { project, records, announced, host } = services(secrets)
    const result = await project.saveSettings(P, ID, { board: 'b' }, { key: PLAIN })
    expect(result).toEqual({ ok: true, values: { board: 'b' }, secretFields: { key: { set: true } } })
    expect(records.get(P)!.pluginSettings[ID]).toEqual({ board: 'b' })
    expect(secrets.hasSetting(ID, `setting:project:${P}:key`)).toBe(true)
    expect(secretsFile()).not.toContain(PLAIN)
    expect(announced).toEqual([`project ${P} ${JSON.stringify({ ok: true, app: { site: 'example' }, project: { board: 'b', key: PLAIN } })}`])
    const view = project.view(P).plugins[0]!
    expect(view.projectSettings?.secretFields).toEqual({ key: { set: true } })
    expect(view.problem).toBeUndefined()
    expect(JSON.stringify(project.view(P))).not.toContain(PLAIN)
    expect(project.view(Q).plugins[0]!.projectSettings?.secretFields).toEqual({ key: { set: false } })
    expect(host(Q)).toEqual({ ok: true, app: { site: 'example' }, project: { board: 'main' } })

    await project.saveSettings(P, ID, { board: 'b' }, { key: null })
    expect(secrets.hasSetting(ID, `setting:project:${P}:key`)).toBe(false)
    expect(host(P)).toEqual({ ok: true, app: { site: 'example' }, project: { board: 'b' } })
  })
})

describe('the decrypted cache', () => {
  it('is filled by loadSettings after a restart, per project, and emptied on uninstall and forget', async () => {
    const first = openSecrets()
    await first.writeSettings(ID, new Map([['setting:app:token', 'app-value'], [`setting:project:${P}:key`, 'p-value'], [`setting:project:${Q}:key`, 'q-value']]))
    first.flush()

    const s = openSecrets()
    // Before the load the host would not have it (index.ts loads before every launch).
    expect(s.cachedSetting(ID, 'setting:app:token')).toBeUndefined()
    expect(s.hasSetting(ID, 'setting:app:token')).toBe(true)
    await s.loadSettings(ID, P)
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('app-value')
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBe('p-value')
    // Only the asking project's values are decrypted.
    expect(s.cachedSetting(ID, `setting:project:${Q}:key`)).toBeUndefined()

    s.forgetProject(P)
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('app-value')
    s.removePlugin(ID)
    expect(s.cachedSetting(ID, 'setting:app:token')).toBeUndefined()
    expect(s.hasSetting(ID, 'setting:app:token')).toBe(false)
  })

  it('keeps a value saved while a load was decrypting the old one', async () => {
    const first = openSecrets()
    await first.writeSettings(ID, new Map([['setting:app:token', 'old']]))
    const fake = fakeSecretStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const s = openSecrets({ store: { ...fake, decrypt: async (v: string) => gate.then(() => fake.decrypt(v)) } })
    const loading = s.loadSettings(ID, P)
    await s.writeSettings(ID, new Map([['setting:app:token', 'new']]))
    release()
    await loading
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('new')
  })

  it('leaves out a value that will not decrypt, logs it without the value, and does not reject', async () => {
    writeFileSync(
      join(dataDir, 'secrets.json'),
      JSON.stringify({ schemaVersion: 1, plugins: { [ID]: { 'setting:app:token': 'bm90LWZha2U=' } } })
    )
    const s = openSecrets()
    await expect(s.loadSettings(ID, P)).resolves.toBeUndefined()
    expect(s.cachedSetting(ID, 'setting:app:token')).toBeUndefined()
    expect(s.hasSetting(ID, 'setting:app:token')).toBe(true)
    expect(logs.join('\n')).toMatch(/setting:app:token cannot be decrypted/)
  })

  it('refuses a save whose encrypt resolves after its project was forgotten, and leaves nothing behind', async () => {
    const fake = fakeSecretStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    // The real keychain can hold an encrypt for as long as its prompt stays open.
    const s = openSecrets({ store: { ...fake, encrypt: async (v: string) => gate.then(() => fake.encrypt(v)) } })
    const pending = s.writeSettings(ID, new Map([[`setting:project:${P}:key`, PLAIN]])).catch((e: unknown) => e as Error)
    // Another project's forget does not get in the way.
    const other = s.writeSettings(ID, new Map([[`setting:project:${Q}:key`, 'q-value']]))
    s.forgetProject(P)
    release()
    const err = await pending
    expect((err as Error).message).toMatch(/the project was forgotten/)
    expect((err as Error).message).not.toContain(PLAIN)
    await other
    expect(s.hasSetting(ID, `setting:project:${P}:key`)).toBe(false)
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    expect(s.hasSetting(ID, `setting:project:${Q}:key`)).toBe(true)
  })

  it('refuses a save whose encrypt resolves after its plugin was uninstalled, and leaves nothing behind', async () => {
    const fake = fakeSecretStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const s = openSecrets({ store: { ...fake, encrypt: async (v: string) => gate.then(() => fake.encrypt(v)) } })
    const pending = s.writeSettings(ID, new Map([['setting:app:token', PLAIN]])).catch((e: unknown) => e as Error)
    s.removePlugin(ID)
    release()
    const err = await pending
    expect((err as Error).message).toMatch(/the plugin was uninstalled/)
    expect((err as Error).message).not.toContain(PLAIN)
    expect(s.hasSetting(ID, 'setting:app:token')).toBe(false)
    expect(s.cachedSetting(ID, 'setting:app:token')).toBeUndefined()
    expect(openSecrets().hasSetting(ID, 'setting:app:token')).toBe(false)
  })

  it('does not cache a value whose plugin was uninstalled or whose project was forgotten during the decrypt', async () => {
    const first = openSecrets()
    await first.writeSettings(ID, new Map([['setting:app:token', 'app-value'], [`setting:project:${P}:key`, 'p-value']]))
    first.flush()
    const gated = (): { s: PluginSecrets; release: () => void } => {
      const fake = fakeSecretStore()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      return { s: openSecrets({ store: { ...fake, decrypt: async (v: string) => gate.then(() => fake.decrypt(v)) } }), release }
    }

    const forgot = gated()
    const loadingP = forgot.s.loadSettings(ID, P)
    forgot.s.forgetProject(P)
    forgot.release()
    await loadingP
    expect(forgot.s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    // The app-wide value was not forgotten with the project.
    expect(forgot.s.cachedSetting(ID, 'setting:app:token')).toBe('app-value')

    const removed = gated()
    const loadingR = removed.s.loadSettings(ID, P)
    removed.s.removePlugin(ID)
    removed.release()
    await loadingR
    expect(removed.s.cachedSetting(ID, 'setting:app:token')).toBeUndefined()
    expect(removed.s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
  })

  it('evicts a closed project’s values from the cache but keeps the ciphertext and the app-wide values', async () => {
    const s = openSecrets()
    await s.writeSettings(ID, new Map([['setting:app:token', 'app-value'], [`setting:project:${P}:key`, 'p-value'], [`setting:project:${Q}:key`, 'q-value']]))
    s.evictProject(P)
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    expect(s.hasSetting(ID, `setting:project:${P}:key`)).toBe(true)
    expect(s.cachedSetting(ID, `setting:project:${Q}:key`)).toBe('q-value')
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('app-value')
    // Reopening the project loads it again.
    await s.loadSettings(ID, P)
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBe('p-value')
  })

  it('does not cache a closed project’s value whose decrypt finishes after the window closed', async () => {
    const first = openSecrets()
    await first.writeSettings(ID, new Map([['setting:app:token', 'app-value'], [`setting:project:${P}:key`, 'p-value']]))
    first.flush()
    const fake = fakeSecretStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const s = openSecrets({ store: { ...fake, decrypt: async (v: string) => gate.then(() => fake.decrypt(v)) } })
    const loading = s.loadSettings(ID, P)
    s.evictProject(P)
    release()
    await loading
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    // App-wide values are not the closed project's: other hosts use them.
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('app-value')
    // Reopened while the stale load was still decrypting: the new load's value is kept.
    let release2: () => void = () => {}
    const gate2 = new Promise<void>((resolve) => (release2 = resolve))
    const t = openSecrets({ store: { ...fake, decrypt: async (v: string) => gate2.then(() => fake.decrypt(v)) } })
    const stale = t.loadSettings(ID, P)
    t.evictProject(P)
    const reopened = t.loadSettings(ID, P)
    release2()
    await Promise.all([stale, reopened])
    expect(t.cachedSetting(ID, `setting:project:${P}:key`)).toBe('p-value')
  })

  it('does not cache a project closed before the load started, given the mark taken earlier', async () => {
    // index.ts hostPlugins takes the mark, then awaits the plugin index; the window closes then.
    const first = openSecrets()
    await first.writeSettings(ID, new Map([['setting:app:token', 'app-value'], [`setting:project:${P}:key`, 'p-value']]))
    first.flush()
    const decrypted: string[] = []
    const fake = fakeSecretStore()
    const s = openSecrets({ store: { ...fake, decrypt: async (v: string) => (decrypted.push(v), fake.decrypt(v)) } })
    const mark = s.evictionMark(P)
    s.evictProject(P)
    await s.loadSettings(ID, P, mark)
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('app-value')
    // The closed project's value is not even decrypted (no keychain prompt for it).
    expect(decrypted).toHaveLength(1)
    // A reopen takes a new mark and loads it.
    await s.loadSettings(ID, P, s.evictionMark(P))
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBe('p-value')
  })

  it('a save whose write fails stores and caches nothing, and its error carries no value', async () => {
    let failRename = false
    const fs: PluginSecretsOptions['fs'] = {
      ...nodeFs,
      renameSync: (from, to) => {
        if (failRename) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
        nodeFs.renameSync(from, to)
      }
    }
    const s = openSecrets({ fs })
    await s.writeSettings(ID, new Map([['setting:app:token', 'old']]))
    const before = secretsFile()
    failRename = true
    const err = await s
      .writeSettings(ID, new Map([['setting:app:token', PLAIN], [`setting:project:${P}:key`, PLAIN]]))
      .catch((e: unknown) => e as Error)
    expect((err as Error).message).toMatch(/could not be written/)
    expect((err as Error).message).not.toContain(PLAIN)
    expect(logs.join('\n')).not.toContain(PLAIN)
    expect(s.cachedSetting(ID, 'setting:app:token')).toBe('old')
    expect(s.hasSetting(ID, `setting:project:${P}:key`)).toBe(false)
    expect(s.cachedSetting(ID, `setting:project:${P}:key`)).toBeUndefined()
    expect(secretsFile()).toBe(before)
    // A forget whose write fails throws (registry.ts logs it) and the stored value stays as it was.
    failRename = false
    await s.writeSettings(ID, new Map([[`setting:project:${Q}:key`, 'q-value']]))
    failRename = true
    expect(() => s.forgetProject(Q)).toThrow(/could not be written/)
    expect(s.hasSetting(ID, `setting:project:${Q}:key`)).toBe(true)
  })

  it('writes all edits or none, and refuses keys that are not settings keys', async () => {
    const s = openSecrets()
    await expect(s.writeSettings(ID, new Map([['token', 'x']]))).rejects.toThrow(/not a settings key/)
    await expect(s.writeSettings(ID, new Map([['setting:app:a', 'x'], ['setting:app:b', 'y'.repeat(70 * 1024)]]))).rejects.toThrow(/larger than/)
    expect(s.hasSetting(ID, 'setting:app:a')).toBe(false)
    // Main's settings writes are not plugin writes: no 100-key cap for them.
    await s.writeSettings(ID, new Map(Array.from({ length: 120 }, (_, i) => [`setting:app:f${i}`, 'v'] as [string, string])))
    expect(await s.keys(ID)).toEqual([])
    expect(s.hasSetting(ID, 'setting:app:f119')).toBe(true)
  })
})

/** A host process whose activate records the specs main sent. */
class RecordingFactory implements HostProcessFactory {
  readonly specs: HostPluginSpec[][] = []
  spawn(): HostProcess {
    const [main, host] = memoryPortPair()
    const listeners: Array<(code: number) => void> = []
    const rpc = new RpcEndpoint({
      port: host,
      handlers: {
        activate: (p) => {
          const plugins = (p as { plugins: HostPluginSpec[] }).plugins
          this.specs.push(plugins)
          return plugins.map((x) => ({ id: x.id, state: 'active' }))
        },
        deactivate: () => null
      }
    })
    return {
      port: main,
      onExit: (l) => void listeners.push(l),
      kill: () => {
        rpc.close('killed')
        for (const l of listeners) queueMicrotask(() => l(-1))
      },
      transferPort: () => {}
    }
  }
}

describe('the host spec', () => {
  /** HostManager wired as index.ts wires it: `plugins` loads the cache, `settings` reads it. */
  function manager(secrets: PluginSecrets, stored: { app?: unknown; project?: unknown }) {
    const factory = new RecordingFactory()
    const hosts = new HostManager({
      factory,
      plugins: async (projectId) => {
        await secrets.loadSettings(ID, projectId)
        return [{ id: ID, dir: '/dev/x', main: 'host.js', panels: [] }]
      },
      env: () => ({}),
      projectPath: () => '/work/p',
      layouts: { setPluginPanels: () => {}, setError: () => true },
      pluginDataDir: () => join(dataDir, 'plugin-data'),
      pluginAppDataDir: (pluginId) => `/data/plugin-data/_app/${pluginId}`,
      settings: (projectId) => hostSettingsOf(manifest, stored, secrets, projectId)
    })
    return { hosts, factory }
  }

  it('carries the decrypted values after a save, and after an app restart over the same data dir', async () => {
    const before = openSecrets()
    const { app, project, appSettings, records } = services(before)
    await app.savePluginSettings(ID, { site: 's' }, { token: PLAIN })
    await project.saveSettings(P, ID, {}, { key: 'project-plain' })
    const stored = { app: appSettings.get(ID), project: records.get(P)!.pluginSettings[ID] }

    const running = manager(before, stored)
    await running.hosts.open(P, 1)
    expect(running.factory.specs[0]![0]!.settings).toEqual({ app: { site: 's', token: PLAIN }, project: { board: 'main', key: 'project-plain' } })
    running.hosts.disposeAll()
    before.flush()

    // A new PluginSecrets is what the next launch of the app builds: an empty cache.
    const after = manager(openSecrets(), stored)
    await after.hosts.open(P, 1)
    expect(after.factory.specs[0]![0]!.settings).toEqual({ app: { site: 's', token: PLAIN }, project: { board: 'main', key: 'project-plain' } })
    after.hosts.disposeAll()
  })
})
