// A plugin's settings form, app-wide (settings-service.ts) or per project
// (project-settings-service.ts): the same checks on what the renderer sends, the same save flow
// (saveSettingsForm) and the same view of what is stored. Each service passes the schema it took
// from its own record of the plugin's manifest, and its own scope's keys and stores.
//
// Secret fields (`"format": "secret"` on a top-level property, validate.ts) are kept out of every
// payload the renderer gets: the view's `values` (stored or, for a problem, raw) and the save
// result's echo never hold one; whether each is set travels in `secretFields`. A new value or a
// clear comes in once, in the save request's `secrets` map, and goes to secrets.json encrypted
// (plugin-secrets.ts); the JSON settings files never hold it.
import { errorText } from '../../shared/error-text'
import { isPlainObject } from '../../shared/guards'
import type { PluginAppSettingsView, PluginSettingsSaveResult, SecretFieldsView } from '../../shared/ipc'
import type { JsonSchema, PluginManifest } from '../../shared/manifest'
import {
  checkPluginSettings,
  secretFieldsOf,
  validateSettings,
  withoutSecretFields,
  type PluginSettingsCheck,
  type SettingsValidation
} from '../plugins/validate'
import { appSettingKey, projectSettingKey, type PluginSecrets } from '../secrets/plugin-secrets'

/** Bounds on renderer input. */
const MAX_SETTINGS_JSON = 256 * 1024
const MAX_ERRORS = 20

/** What a settings form's save needs of PluginSecrets (it also updates the hosts' decrypted cache). */
export type SecretSettingsStore = Pick<PluginSecrets, 'hasSetting' | 'settingsGuard' | 'checkSettingsGuard' | 'writeSettings'>

/** Whether a secret field of the form's scope is stored (by field name). */
export type SecretIsSet = (field: string) => boolean

/**
 * Check a settings form's values from the renderer against the plugin's schema (validate.ts: no
 * regexes, defaults applied). Throws for input no form sends (not an object, not plain data, too
 * large); values the schema rejects are a result listing at most MAX_ERRORS reasons. A secret
 * field inside `values` is dropped, never stored (the form sends those in `secrets`).
 */
export function checkFormSettings(schema: JsonSchema, values: unknown): SettingsValidation {
  if (!isPlainObject(values)) throw new Error('settings must be an object')
  let size: number
  try {
    size = JSON.stringify(values).length
  } catch {
    throw new Error('settings must be plain data')
  }
  if (size > MAX_SETTINGS_JSON) throw new Error('settings are too large')
  const checked = validateSettings(schema, values)
  return checked.ok ? checked : { ok: false, errors: checked.errors.slice(0, MAX_ERRORS) }
}

/**
 * The save request's `secrets`: per secret field of `schema`, a new value (a non-empty string) or
 * null to clear it; absent fields stay as they are. Throws for input no form sends: not an object,
 * a name that is not a secret field of this schema, an empty or non-string value.
 */
export function checkSecretEdits(schema: JsonSchema, secrets: unknown): Map<string, string | null> {
  const edits = new Map<string, string | null>()
  if (secrets === undefined) return edits
  if (!isPlainObject(secrets)) throw new Error('secrets must be an object')
  const fields = new Set(secretFieldsOf(schema))
  for (const [name, value] of Object.entries(secrets)) {
    // Not echoed: a form bug could have put a value where the name goes.
    if (!fields.has(name)) throw new Error('secrets: not a secret field of this plugin')
    if (value !== null && (typeof value !== 'string' || value === '')) throw new Error('secrets: a value is a non-empty string, or null to clear')
    edits.set(name, value)
  }
  return edits
}

/** One save of a plugin's settings form, app-wide or for one project. */
export interface SettingsFormSave {
  pluginId: string
  /** A project form's project (main resolved it for the sender); absent for the app-wide form. */
  projectId?: string
  /** The form's schema, from main's record of the manifest. */
  schema: JsonSchema
  /** From the renderer: the plain values and the secret edits (checkFormSettings, checkSecretEdits). */
  values: unknown
  secrets: unknown
  /** A secret field's `setting:` key in this form's scope (appSettingKey, or projectSettingKey for the project). */
  keyOf(field: string): string
  store: SecretSettingsStore
  /** Store the checked plain values (the settings JSON). */
  save(value: Record<string, unknown>): void
  /** Tell the hosts (after both halves are stored). */
  announce(): Promise<void>
}

/**
 * Saves in flight, per plugin id. A save writes the secrets (awaiting the encrypt, which may wait
 * on a keychain prompt) and then the plain values: two overlapping saves of the same plugin (two
 * windows, or the e2e hook and the form) could otherwise interleave so that one save's secrets and
 * the other's values win. Main is one process, so a module-level queue is the whole story.
 */
const saving = new Map<string, Promise<unknown>>()

/**
 * The save flow both settings services share: check the edits and the values (throws for input no
 * form sends; schema failures are a result and store nothing), store the secrets (encrypted
 * first: a keychain that refuses also stores nothing), then the values, then announce. Saves of
 * one plugin run one after another.
 *
 * Every save, with or without a secret edit, holds the lifecycle generations it was requested
 * under (PluginSecrets.settingsGuard: the plugin's uninstall count and, for a project form, its
 * project's forget count) and is refused, with nothing written, when either moved by the time it
 * runs. Without that, a save queued behind another's encrypt outlived an uninstall, or a project
 * forget and reopen, and wrote the old values into the plugin's or the new project record.
 */
export async function saveSettingsForm(form: SettingsFormSave): Promise<PluginSettingsSaveResult> {
  const edits = checkSecretEdits(form.schema, form.secrets)
  const checked = checkFormSettings(form.schema, form.values)
  if (!checked.ok) return { ok: false, errors: checked.errors }
  const changes = new Map([...edits].map(([field, value]) => [form.keyOf(field), value]))
  // Now, not when the save leaves the queue: an uninstall or project forget that runs while an
  // earlier save waits on its encrypt must refuse this one too, not take it for a later request.
  const guard = form.store.settingsGuard(form.pluginId, changes.keys(), form.projectId)
  const run = async (): Promise<PluginSettingsSaveResult> => {
    try {
      // The one check every save passes, plain values only included, before anything is written.
      // writeSettings checks again after its encrypt; from there to save() below nothing awaits a
      // task (an IPC request, so an uninstall or forget, cannot run in between).
      form.store.checkSettingsGuard(form.pluginId, guard)
    } catch (err) {
      return { ok: false, errors: [`the settings were not stored: ${errorText(err)}`] }
    }
    try {
      await form.store.writeSettings(form.pluginId, changes, guard)
    } catch (err) {
      // PluginSecrets and the secret store never put a value in an error.
      return { ok: false, errors: [`the secret settings could not be stored: ${errorText(err)}`] }
    }
    form.save(checked.value)
    await form.announce()
    const secretFields = secretFieldsView(form.schema, (f) => form.store.hasSetting(form.pluginId, form.keyOf(f)))
    return { ok: true, values: checked.value, ...(secretFields !== undefined ? { secretFields } : {}) }
  }
  const previous = saving.get(form.pluginId) ?? Promise.resolve()
  // After the previous save settles either way: one that failed must not block the next.
  const mine = previous.then(run, run)
  const tail = mine.catch(() => {})
  saving.set(form.pluginId, tail)
  try {
    return await mine
  } finally {
    // The last save of the plugin clears its entry; the map does not grow with every plugin saved.
    if (saving.get(form.pluginId) === tail) saving.delete(form.pluginId)
  }
}

/** Set or not, per secret field of `schema`; undefined when it has none. */
export function secretFieldsView(schema: JsonSchema, isSet: SecretIsSet): SecretFieldsView | undefined {
  const fields = secretFieldsOf(schema)
  if (fields.length === 0) return undefined
  return Object.fromEntries(fields.map((f) => [f, { set: isSet(f) }]))
}

/** The form's view of the stored settings; stored values that fail the schema come with a problem. */
export function settingsViewOf(schema: JsonSchema, stored: unknown, isSet: SecretIsSet = () => false): PluginAppSettingsView {
  const checked = validateSettings(schema, stored)
  const secretFields = secretFieldsView(schema, isSet)
  const view: PluginAppSettingsView = checked.ok
    ? { schema, values: checked.value }
    : {
        schema,
        // What is stored, so the user can see and fix it; the form fills in around it. Not a
        // secret field a hand-edited file put there.
        values: isPlainObject(stored) ? withoutSecretFields(schema, stored) : {},
        problem: checked.errors.slice(0, MAX_ERRORS).join('; ')
      }
  if (secretFields !== undefined) view.secretFields = secretFields
  return view
}

/** Reads the decrypted cache of secret settings values (PluginSecrets.cachedSetting). */
export interface SecretSettingsCache {
  cachedSetting(pluginId: string, key: string): string | undefined
}

/**
 * What a plugin's host gets as `ctx.settings`: the stored JSON checked against the manifest
 * (checkPluginSettings, secret fields left out of the check), then each secret field that is set
 * merged in as plaintext from main's decrypted cache. Synchronous: HostManager reads it while it
 * builds a spec or pushes a change; the cache was filled before (index.ts hostPlugins).
 */
export function hostSettingsOf(
  manifest: PluginManifest,
  stored: { app?: unknown; project?: unknown },
  secrets: SecretSettingsCache,
  projectId: string
): PluginSettingsCheck {
  const check = checkPluginSettings(manifest, stored)
  if (!check.ok) return check
  const schemas = manifest.contributes?.settings
  const merge = (values: Record<string, unknown>, schema: JsonSchema | undefined, keyOf: (field: string) => string): Record<string, unknown> => {
    for (const field of secretFieldsOf(schema)) {
      const plain = secrets.cachedSetting(manifest.id, keyOf(field))
      if (plain !== undefined) values[field] = plain
    }
    return values
  }
  return {
    ok: true,
    app: merge(check.app, schemas?.app, appSettingKey),
    project: merge(check.project, schemas?.project, (f) => projectSettingKey(projectId, f))
  }
}
