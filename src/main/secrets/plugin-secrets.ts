// The per-plugin secret store behind `ctx.secrets` (design §6 "Plugin sign-ins and secrets").
//
// One file, `<data>/secrets.json`: `{ schemaVersion, plugins: { [pluginId]: { [key]: <stored> } } }`
// where <stored> is what `SecretStore.encrypt` returned (OS keychain ciphertext, or the marked fake
// in a test run). App-wide per plugin id: every project's host reaches the same store, so a plugin
// that wants per-project sign-ins names its keys itself. Written through JsonFile (tmp + fsync +
// rename, mode 0600) and FLUSHED after every change rather than debounced: a sign-in the plugin was
// told is stored must survive a crash a moment later, and secrets change rarely.
//
// Two tiers of callers:
//  - plugins (`get`/`set`/`delete`/`keys`, reached through host-api.ts): the key pattern, the value
//    size, the 100-key cap, and the reserved `setting:` prefix, which plugins may read (it is their
//    own data, and ctx.settings hands them the plaintext anyway; host-api.ts refuses another
//    project's `setting:project:*` keys) but not write or delete, and which `keys()` hides and the
//    cap does not count;
//  - main itself: `removePlugin` on uninstall, `forgetProject` on project forget, and the secret
//    settings fields (`"format": "secret"` in a settings schema, validate.ts), whose values the
//    settings services write under `setting:` keys with `writeSettings` (no rate limit, no key
//    cap: the user typed them into the plugin's own form).
//
// Secret settings reach the plugin host in plaintext inside `ctx.settings`, and the settings path
// to the host is synchronous (HostManager reads them while it builds a spec or pushes a change)
// while decrypt is async. So main keeps a DECRYPTED CACHE of the `setting:` values: filled
// (awaited) by `loadSettings` before a host launch or a dev reload builds a spec (index.ts
// hostPlugins), written through by `writeSettings` before the change is announced, and emptied by
// `removePlugin` and `forgetProject` together with the keys. A project's own entries also go when
// its window (and so its host) closes (`evictProject`): a closed project's secrets do not stay
// decrypted in main until quit; the next launch decrypts them again. App-wide entries stay, as
// other projects' hosts use them. It never feeds a renderer payload: the settings views ask
// `hasSetting`, which looks at the ciphertext only. A plugin update or dev reload that removes a
// secret field (or makes it plain) leaves its key and cache entry here until uninstall or forget
// (README known limitations); nothing hands it on, as the views and hostSettingsOf go by the
// current schema's secret fields.
//
// Errors never carry a value, stored or plain, and never echo a rejected key: a plugin that
// swapped the arguments (`set(token, 'name')`) would otherwise see its token in a log line.
// Lookups use own properties only: a key like `constructor` matches the key pattern and must not
// find Object.prototype's.
//
// No `electron` import: the SecretStore is passed in (index.ts selects it), so unit tests run this
// in plain Node with the fake store.
import { isPlainObject, own } from '../../shared/guards'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../../shared/manifest'
import { dataPaths } from '../paths'
import { JsonFile, type FsOps } from '../store/json-file'
import { storedValueState, type SecretStore } from './secret-store'
import type { SecretValueState } from '../../shared/ipc'
import { warnLog } from '../warn-log'

export const SECRET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** Per value, in UTF-8 bytes (what the keychain encrypts), not UTF-16 code units. */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024
/** Plugin-set keys per plugin; `setting:` keys (main's) do not count. */
export const MAX_SECRET_KEYS = 100
/**
 * Reserved for secret settings fields: `setting:app:<field>`, `setting:project:<projectId>:<field>`
 * (a project's override) and `setting:projectDefault:<field>` (the global value of a project field,
 * design-next §5.2). `projectDefault:` never matches the `project:` prefix (no `:` after `project`),
 * so no walk over a project's keys takes a global value for one.
 */
export const SETTING_KEY_PREFIX = 'setting:'

/** The secrets.json key of an app-wide secret settings field. */
export function appSettingKey(field: string): string {
  return `${SETTING_KEY_PREFIX}app:${field}`
}

/** The secrets.json key of the global value of a secret project field (design-next §5.2). */
export function projectDefaultSettingKey(field: string): string {
  return `${SETTING_KEY_PREFIX}projectDefault:${field}`
}

/** The secrets.json key of a project's secret settings field (its override of the global value). */
export function projectSettingKey(projectId: string, field: string): string {
  return `${SETTING_KEY_PREFIX}project:${projectId}:${field}`
}

interface SecretsFileData {
  schemaVersion: number
  plugins: Record<string, Record<string, string>>
}

/** What host-api.ts needs: the plugin-facing calls, for a plugin id main already checked. */
export interface PluginSecretsApi {
  get(pluginId: string, key: unknown): Promise<string | null>
  set(pluginId: string, key: unknown, value: unknown): Promise<void>
  delete(pluginId: string, key: unknown): Promise<void>
  keys(pluginId: string): Promise<string[]>
}

export interface PluginSecretsOptions {
  dataDir: string
  store: SecretStore
  /** Store-level fs, injectable for failure tests. */
  fs?: FsOps
  log?: (message: string) => void
}

/**
 * The cleanup counts a `writeSettings` must still see when it commits (`settingsGuard`). Taken
 * when the save is requested, not when it runs: a save queued behind another (plugin-settings.ts
 * saveSettingsForm) starts after an uninstall or forget that ran meanwhile, and counts taken then
 * would let it store the deleted credentials again.
 */
export interface SettingsWriteGuard {
  readonly removals: number | undefined
  readonly forgets: ReadonlyMap<string, number | undefined>
}

/** A refused or failed secrets request. The message never contains a secret. */
export class PluginSecretsError extends Error {
  override name = 'PluginSecretsError'
}

export class PluginSecrets implements PluginSecretsApi {
  private readonly file: JsonFile<SecretsFileData>
  private readonly store: SecretStore
  private readonly log: (message: string) => void
  /**
   * Bumped by `removePlugin`. A `set` waits on the encrypt (with the real keychain, as long as a
   * prompt stays open); an uninstall that runs meanwhile must not have the plugin's store
   * recreated when that encrypt resolves, so `set` refuses when the count moved under it.
   */
  private readonly removals = new Map<string, number>()
  /**
   * Bumped by `forgetProject`, per project id: the same guard for `writeSettings`, so a save whose
   * encrypt waits on a prompt while the user forgets the project does not write that project's
   * `setting:project:<id>:*` keys back (they would outlive the project until uninstall).
   */
  private readonly forgets = new Map<string, number>()
  /**
   * Bumped by `evictProject`, per project id: a `loadSettings` whose decrypt finishes after the
   * project's window closed does not cache its `setting:project:<id>:*` values (the ciphertext
   * stays, so the key check that covers forget does not see the close).
   */
  private readonly evictions = new Map<string, number>()
  /** Plaintext of `setting:` values, per plugin id and key (see the header: the decrypted cache). */
  private readonly settingsCache = new Map<string, Map<string, string>>()

  constructor(options: PluginSecretsOptions) {
    this.store = options.store
    this.log = options.log ?? warnLog
    this.file = new JsonFile<SecretsFileData>({
      filePath: dataPaths(options.dataDir).secretsJson,
      defaults: () => ({ schemaVersion: 1, plugins: {} }),
      fs: options.fs,
      log: this.log
    })
    // A hand-edited or damaged file: anything that is not plugin id -> key -> string is dropped
    // in memory (the next write leaves it out), never handed to decrypt or a plugin as is.
    this.file.data.plugins = cleanPlugins(this.file.data.plugins)
  }

  /** The value, or null when not set. Rejects when the stored value cannot be decrypted. */
  async get(pluginId: string, key: unknown): Promise<string | null> {
    checkPluginId(pluginId)
    checkKey(key)
    const stored = own(this.entry(pluginId), key)
    // Not null for a value that will not decrypt (a reset keychain): null means "not set", and a
    // plugin would then quietly ask the user to sign in again over a broken keychain.
    return stored === undefined ? null : this.store.decrypt(stored)
  }

  /** Encrypts and stores. Rejects (and stores nothing) when the OS cannot encrypt or the file cannot be written. */
  async set(pluginId: string, key: unknown, value: unknown): Promise<void> {
    checkPluginId(pluginId)
    checkKey(key)
    if (key.startsWith(SETTING_KEY_PREFIX)) throw new PluginSecretsError('secrets: keys starting with "setting:" are reserved')
    if (typeof value !== 'string') throw new PluginSecretsError('secrets: the value must be a string')
    if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
      throw new PluginSecretsError(`secrets: the value is larger than ${MAX_SECRET_VALUE_BYTES / 1024} KiB`)
    }
    // Before the encrypt (which may wait on a keychain prompt), so a refused call costs nothing...
    this.checkRoom(pluginId, key)
    this.checkWritable()
    const removals = this.removals.get(pluginId)
    const stored = await this.store.encrypt(value)
    // ...and again after it: two sets racing through the await could both have passed the first.
    this.checkRoom(pluginId, key)
    // An uninstall ran during the encrypt: writing now would leave an orphaned credential behind.
    if (this.removals.get(pluginId) !== removals) throw new PluginSecretsError('secrets: the plugin was uninstalled')
    this.mutate(() => this.apply(pluginId, key, stored))
  }

  /** Removes one plugin-set key; an unknown key is not an error. */
  async delete(pluginId: string, key: unknown): Promise<void> {
    checkPluginId(pluginId)
    checkKey(key)
    if (key.startsWith(SETTING_KEY_PREFIX)) throw new PluginSecretsError('secrets: keys starting with "setting:" are reserved')
    if (own(this.entry(pluginId), key) === undefined) return
    this.mutate(() => this.apply(pluginId, key, undefined))
  }

  /** The plugin-set keys, sorted; `setting:` keys are hidden. */
  async keys(pluginId: string): Promise<string[]> {
    checkPluginId(pluginId)
    return pluginKeys(this.entry(pluginId)).sort()
  }

  // -------------------------------------------------------------------------------------------
  // Secret settings fields (main only)
  // -------------------------------------------------------------------------------------------

  /** A `setting:` value is stored (whether or not it decrypts). For the settings views: no decrypt. */
  hasSetting(pluginId: string, key: string): boolean {
    return key.startsWith(SETTING_KEY_PREFIX) && own(this.entry(pluginId), key) !== undefined
  }

  /**
   * What the settings views show for a `setting:` value, without decrypting it: not stored, stored,
   * or stored but unreadable here because the other mode's store made it or the key file was
   * replaced (design-web.md §9.5). The form shows the last two as "enter it again", and a save
   * of a new value replaces the unreadable one like any other.
   */
  settingState(pluginId: string, key: string): SecretValueState {
    const stored = key.startsWith(SETTING_KEY_PREFIX) ? own(this.entry(pluginId), key) : undefined
    if (stored === undefined) return 'unset'
    const state = storedValueState(this.store, stored)
    return state === 'readable' ? 'set' : state
  }

  /** The decrypted `setting:` value, when stored and loaded (`loadSettings`, `writeSettings`). */
  cachedSetting(pluginId: string, key: string): string | undefined {
    return this.settingsCache.get(pluginId)?.get(key)
  }

  /**
   * Decrypt the plugin's app-wide (`app:` and `projectDefault:`) and `projectId`'s `setting:` values into the cache. Values
   * already there are kept (every change since went through writeSettings). Never rejects: a value
   * that will not decrypt (a reset keychain) is logged and left out, so the plugin runs without
   * that field while the form still shows it as set (the user can replace it there).
   *
   * `since` is the project's `evictionMark` from when the caller started: index.ts hostPlugins
   * awaits the plugin index first, and a window closed during that wait must not have its values
   * cached afterwards (no host starts for it, so nothing would evict them again).
   */
  async loadSettings(pluginId: string, projectId: string, since = this.evictionMark(projectId)): Promise<void> {
    const entry = this.entry(pluginId)
    if (!entry) return
    const app = `${SETTING_KEY_PREFIX}app:`
    // Global values of project fields are app-wide too: every project that uses global reads them.
    const projectDefault = `${SETTING_KEY_PREFIX}projectDefault:`
    const project = `${SETTING_KEY_PREFIX}project:${projectId}:`
    // Closed already: only the app-wide values are worth a decrypt (and a keychain prompt).
    const closed = this.evictionMark(projectId) !== since
    const keys = Object.keys(entry).filter(
      (k) => (k.startsWith(app) || k.startsWith(projectDefault) || (!closed && k.startsWith(project))) && this.cachedSetting(pluginId, k) === undefined
    )
    await Promise.all(
      keys.map(async (key) => {
        const stored = entry[key] as string
        let plain: string
        try {
          plain = await this.store.decrypt(stored)
        } catch (err) {
          // The store's errors carry no secret (secret-store.ts).
          this.log(`secrets: ${pluginId} ${key} cannot be decrypted, the plugin runs without it: ${(err as Error).message}`)
          return
        }
        // Replaced, cleared, uninstalled or forgotten during the decrypt: that change is the truth.
        if (own(this.entry(pluginId), key) !== stored || this.cachedSetting(pluginId, key) !== undefined) return
        // The project's window closed during the decrypt (a reopen's own load decrypts it again).
        if (key.startsWith(project) && this.evictionMark(projectId) !== since) return
        this.cacheSetting(pluginId, key, plain)
      })
    )
  }

  /**
   * The uninstall and forget counts that a later `writeSettings` of these keys, or
   * `checkSettingsGuard`, checks against: the plugin's, and those of the keys' projects and of
   * `projectId` (a project form's own project, which a save without a secret edit has no key of).
   * They are the lifecycle generations a settings save holds on to: a forget bumps its project's
   * count before the record goes, so a project forgotten and opened again under the same id has
   * a new one, and an uninstall bumps the plugin's before a reinstall can start.
   */
  settingsGuard(pluginId: string, keys: Iterable<string>, projectId?: string): SettingsWriteGuard {
    const forgets = new Map<string, number | undefined>()
    if (projectId !== undefined) forgets.set(projectId, this.forgets.get(projectId))
    for (const key of keys) {
      const keyProject = projectOfSettingKey(key)
      if (keyProject !== undefined) forgets.set(keyProject, this.forgets.get(keyProject))
    }
    return { removals: this.removals.get(pluginId), forgets }
  }

  /** Throws when the plugin was uninstalled, or a project of `guard` forgotten, since it was taken. */
  checkSettingsGuard(pluginId: string, guard: SettingsWriteGuard): void {
    if (this.removals.get(pluginId) !== guard.removals) throw new PluginSecretsError('secrets: the plugin was uninstalled')
    for (const [projectId, count] of guard.forgets) {
      if (this.forgets.get(projectId) !== count) throw new PluginSecretsError('secrets: the project was forgotten')
    }
  }

  /**
   * Set (a string) or clear (null) `setting:` values, all or none: every value is encrypted
   * before any is written, and the file is written once. Rejects (and stores nothing) when the OS
   * cannot encrypt or the file cannot be written, or when the plugin was uninstalled or a project
   * of the keys forgotten since `guard` was taken (by default, when this is called). The cache
   * follows before this resolves, so the caller can announce the change to the hosts right after.
   */
  async writeSettings(
    pluginId: string,
    changes: ReadonlyMap<string, string | null>,
    guard: SettingsWriteGuard = this.settingsGuard(pluginId, changes.keys())
  ): Promise<void> {
    checkPluginId(pluginId)
    for (const [key, value] of changes) {
      if (!key.startsWith(SETTING_KEY_PREFIX) || !SECRET_KEY_PATTERN.test(key)) throw new PluginSecretsError('secrets: not a settings key')
      if (value !== null && Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
        throw new PluginSecretsError(`secrets: the value is larger than ${MAX_SECRET_VALUE_BYTES / 1024} KiB`)
      }
    }
    if (changes.size === 0) return
    for (const key of changes.keys()) {
      const projectId = projectOfSettingKey(key)
      // A guard taken for other keys would not see this key's project forgotten.
      if (projectId !== undefined && !guard.forgets.has(projectId)) throw new PluginSecretsError('secrets: the guard does not cover a key')
    }
    this.checkWritable()
    // Before the encrypts too: a queued save whose plugin went meanwhile costs no keychain prompt.
    this.checkSettingsGuard(pluginId, guard)
    const encrypted = new Map<string, string | undefined>()
    for (const [key, value] of changes) encrypted.set(key, value === null ? undefined : await this.store.encrypt(value))
    this.checkSettingsGuard(pluginId, guard)
    this.mutate(() => {
      for (const [key, stored] of encrypted) this.apply(pluginId, key, stored)
    })
    for (const [key, value] of changes) {
      if (value === null) this.settingsCache.get(pluginId)?.delete(key)
      else this.cacheSetting(pluginId, key, value)
    }
  }

  /** Uninstall: the plugin's whole store goes (credentials must not outlive the plugin). */
  removePlugin(pluginId: string): void {
    // Even with nothing stored yet: a first `set` may be waiting on its encrypt.
    this.removals.set(pluginId, (this.removals.get(pluginId) ?? 0) + 1)
    this.settingsCache.delete(pluginId)
    if (!Object.hasOwn(this.file.data.plugins, pluginId)) return
    this.mutate(() => {
      delete this.file.data.plugins[pluginId]
    })
  }

  /**
   * The project's window closed: drop its decrypted `setting:project:<projectId>:*` values from
   * the cache (the ciphertext stays). The next host launch's loadSettings decrypts them again.
   */
  evictProject(projectId: string): void {
    this.evictions.set(projectId, (this.evictions.get(projectId) ?? 0) + 1)
    this.dropCachedProject(projectId)
  }

  /**
   * The project's eviction count, for a caller that must pass it to a later `loadSettings`. Never
   * undefined: loadSettings' `since` defaults to this, and an undefined argument would take that
   * default (the current count) instead of the one the caller held.
   */
  evictionMark(projectId: string): number {
    return this.evictions.get(projectId) ?? 0
  }

  /** Project forget: every plugin's `setting:project:<projectId>:*` keys go. */
  forgetProject(projectId: string): void {
    // Even with nothing stored yet: a first save of the project's form may be waiting on its encrypt.
    this.forgets.set(projectId, (this.forgets.get(projectId) ?? 0) + 1)
    this.dropCachedProject(projectId)
    const prefix = `${SETTING_KEY_PREFIX}project:${projectId}:`
    const hits: Array<[string, string]> = []
    for (const [pluginId, entry] of Object.entries(this.file.data.plugins)) {
      for (const key of Object.keys(entry)) if (key.startsWith(prefix)) hits.push([pluginId, key])
    }
    if (hits.length === 0) return
    this.mutate(() => {
      for (const [pluginId, key] of hits) this.dropKey(pluginId, key)
    })
  }

  /** Write anything pending (quit). Every change is flushed at once anyway; this covers a failed one. */
  flush(): void {
    this.file.flush()
  }

  // -------------------------------------------------------------------------------------------

  private entry(pluginId: string): Record<string, string> | undefined {
    return own(this.file.data.plugins, pluginId)
  }

  /** A new key past the cap is refused; replacing an existing key is always allowed. */
  private checkRoom(pluginId: string, key: string): void {
    const entry = this.entry(pluginId)
    if (entry && Object.hasOwn(entry, key)) return
    if (pluginKeys(entry).length >= MAX_SECRET_KEYS) {
      throw new PluginSecretsError(`secrets: a plugin may keep at most ${MAX_SECRET_KEYS} secrets`)
    }
  }

  /** A secrets.json from a newer app, or one that could not be read or quarantined, is never overwritten. */
  private checkWritable(): void {
    if (this.file.readOnly) throw new PluginSecretsError('secrets: secrets.json cannot be written (see the log)')
  }

  /** Store `stored` under the key, or drop the key (undefined). In memory only: callers wrap it in mutate. */
  private apply(pluginId: string, key: string, stored: string | undefined): void {
    if (stored === undefined) this.dropKey(pluginId, key)
    else this.putKey(pluginId, key, stored)
  }

  private putKey(pluginId: string, key: string, stored: string): void {
    let entry = this.entry(pluginId)
    if (!entry) {
      entry = {}
      this.file.data.plugins[pluginId] = entry
    }
    entry[key] = stored
  }

  private dropCachedProject(projectId: string): void {
    const prefix = `${SETTING_KEY_PREFIX}project:${projectId}:`
    for (const cache of this.settingsCache.values()) {
      for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key)
    }
  }

  private cacheSetting(pluginId: string, key: string, plain: string): void {
    let cache = this.settingsCache.get(pluginId)
    if (!cache) {
      cache = new Map()
      this.settingsCache.set(pluginId, cache)
    }
    cache.set(key, plain)
  }

  private dropKey(pluginId: string, key: string): void {
    const entry = this.entry(pluginId)
    if (!entry) return
    delete entry[key]
    if (Object.keys(entry).length === 0) delete this.file.data.plugins[pluginId]
  }

  /**
   * Apply `change` and write it now. JsonFile logs a failed write and stays dirty instead of
   * throwing; here the caller must hear it (a plugin must not believe a token is stored), so the
   * in-memory state goes back to what is on disk and the call fails.
   */
  private mutate(change: () => void): void {
    // JsonFile.save() on a read-only file only logs, and nothing would be pending afterwards: the
    // change would look written and vanish at the next launch.
    this.checkWritable()
    const before = structuredClone(this.file.data.plugins)
    change()
    this.file.save()
    this.file.flush()
    if (!this.file.pending) return
    this.file.data.plugins = before
    // The rollback equals the file on disk: nothing left to retry. (Another save() re-arms it.)
    this.file.flush()
    this.log('secrets: writing secrets.json failed; the change was not kept')
    throw new PluginSecretsError('secrets: secrets.json could not be written')
  }
}

/** The `PluginSecrets` refusal for a key outside the pattern, without echoing it. */
function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) {
    throw new PluginSecretsError('secrets: a key is 1 to 128 letters, digits, ".", "_", ":" or "-", starting with a letter or digit')
  }
}

/** Main checked the id against the host's plugins; this keeps a bad one from becoming a file key. */
function checkPluginId(pluginId: string): void {
  if (typeof pluginId !== 'string' || pluginId.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new PluginSecretsError('secrets: unknown plugin')
  }
}

/** The project id of a `setting:project:<projectId>:<field>` key (a field name has no `:`). */
function projectOfSettingKey(key: string): string | undefined {
  const prefix = `${SETTING_KEY_PREFIX}project:`
  if (!key.startsWith(prefix)) return undefined
  const rest = key.slice(prefix.length)
  const end = rest.lastIndexOf(':')
  return end > 0 ? rest.slice(0, end) : undefined
}

function pluginKeys(entry: Record<string, string> | undefined): string[] {
  return entry ? Object.keys(entry).filter((k) => !k.startsWith(SETTING_KEY_PREFIX)) : []
}

function cleanPlugins(raw: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  if (!isPlainObject(raw)) return out
  for (const [pluginId, entry] of Object.entries(raw)) {
    if (!PLUGIN_ID_PATTERN.test(pluginId) || !isPlainObject(entry)) continue
    const keys: Record<string, string> = {}
    for (const [key, value] of Object.entries(entry)) {
      if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string' && value !== '') keys[key] = value
    }
    if (Object.keys(keys).length > 0) out[pluginId] = keys
  }
  return out
}
