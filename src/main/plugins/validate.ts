// Plugin manifest and settings validation (Tasks 23+). A plugin folder is untrusted input: this
// module decides whether `plugin.json` is acceptable, whether every file it names really lives
// inside the folder, and whether the plugin's own settings schemas are safe to compile and
// valid against. Pure data in, reasons out; nothing here starts a plugin or touches app state.
// The caller (installer, linked-plugin reload) turns a failure into "plugin disabled: <reason>".
import { promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import { isPlainObject, own } from '../../shared/guards'
import { normalizeChord } from '../../shared/keys'
import {
  CONTRIBUTION_ID_PATTERN,
  MANIFEST_SCHEMA,
  RESERVED_CLI_NAMES,
  SUPPORTED_PLUGIN_API,
  relativePathProblem,
  type JsonSchema,
  type PluginManifest
} from '../../shared/manifest'
import { within } from '../path-within'
import { readVerified, verifiedProblemText, type VerifiedProblem } from '../verified-read'
import { readSkillFiles } from './skill-files'

export type ManifestValidation = { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] }

/** `plugin.json` is a few KiB; refuse to parse anything absurd. */
const MAX_MANIFEST_BYTES = 256 * 1024

// Limits for plugin-provided settings schemas. A real settings schema is a few hundred bytes.
const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_SCHEMA_DEPTH = 32
// The settings form (rjsf) fills an array up to its `minItems` with default entries and renders
// each one, in the trusted shell renderer: `"minItems": 100000000` would hang the window, and the
// byte and depth caps do not see it. No settings form needs more entries to start with.
const MAX_SCHEMA_MIN_ITEMS = 100
// That cap is per array only. Arrays nest (`minItems: 50` three deep is 125,000 entries from a 188-byte
// schema) and a `$ref` used twice in each of n definitions reaches 2^n objects, which ajv's
// `useDefaults` builds in main on every settings check as well as rjsf in the form. So the whole
// schema gets a budget: see `defaultExpansionProblem`. Exported for the tests.
export const MAX_SCHEMA_EXPANSION = 10_000
// `$ref` hops along one path of that walk (it also bounds the walk's recursion depth).
const MAX_SCHEMA_REF_DEPTH = 32
// Object keys that change prototypes rather than naming data. ajv writes a `default` into its
// generated code as an object literal, where `{"__proto__": {...}}` sets the prototype of the
// filled-in settings object (the value main validated would then differ from what structured clone
// hands the host). Refused anywhere in a schema and anywhere in a stored value.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * ajv's regex engine hook, set to refuse. A `pattern`/`patternProperties` regex would run in main
 * on every settings check, and a length cap does not stop catastrophic backtracking (`^(a+)+$` is
 * 7 characters; the plugin also controls `default`, so the manifest alone could hang main's event
 * loop, freezing every window on each launch). No linear-time engine ships with the app, so plugin
 * settings schemas get no regexes: the throw turns into "invalid settings schema". Hooking ajv
 * rather than spotting keywords ourselves refuses exactly the regexes ajv would run (a property
 * named `pattern` is fine). A plugin that needs a pattern checks it in its own host process.
 */
const refuseRegExp = Object.assign(
  (): never => {
    throw new Error('regular expressions (pattern, patternProperties) are not supported in plugin settings')
  },
  { code: 'refused' }
)

/** Ajv's own wording, one line per error; the synthetic `if` error of if/then adds only noise. */
function formatAjvErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  return (errors ?? [])
    .filter((e) => e.keyword !== 'if')
    .map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'is invalid'}`.trim())
}

// The manifest schema is ours and trusted, so one shared instance is fine. `strict` stays on: a
// typo in MANIFEST_SCHEMA should fail loudly in the first test, not validate nothing.
const manifestValidator: ValidateFunction = new Ajv({ allErrors: true, logger: false }).compile(MANIFEST_SCHEMA)

/**
 * Why a path is not a regular file inside a plugin folder. `root` (the path is the folder itself)
 * is kept apart from `outside` because the callers word it differently.
 */
export type InsideProblem = 'missing' | 'outside' | 'root' | 'not-file'

/** `dev`/`ino`: the file the check saw, for readVerified's `expect` (verified-read.ts). */
export type InsideResolution =
  | { ok: true; real: string; size: number; dev: number; ino: number }
  | { ok: false; problem: InsideProblem }

/**
 * `rel` resolved inside `realRoot` (which must be a realpath): the target's real path and size, or
 * why it is not acceptable. The target is realpath'd so a symlink pointing out of the folder is
 * caught; a file that does not exist is an error, not a pass. Every caller (manifest checks, the
 * installer's theme files, html overlays, the cc-plugin: protocol) runs this at its own boundary
 * and reads `real`, not the link. Note this is a check at one moment: whoever later serves or
 * loads the file re-resolves it (Task 28), and reads it with readInside (or readVerified), never by
 * name again: a swap between this check and the read must not reach a file outside the folder.
 */
export async function resolveInside(realRoot: string, rel: string): Promise<InsideResolution> {
  let real: string
  try {
    real = await fs.realpath(path.resolve(realRoot, rel))
  } catch {
    return { ok: false, problem: 'missing' }
  }
  if (!within(realRoot, real)) return { ok: false, problem: 'outside' }
  if (real === realRoot) return { ok: false, problem: 'root' }
  let stats: Stats
  try {
    stats = await fs.stat(real)
  } catch {
    return { ok: false, problem: 'missing' }
  }
  if (!stats.isFile()) return { ok: false, problem: 'not-file' }
  return { ok: true, real, size: stats.size, dev: stats.dev, ino: stats.ino }
}

export type InsideRead = { ok: true; real: string; data: Buffer } | { ok: false; problem: InsideProblem | VerifiedProblem }

/**
 * resolveInside, then the file's bytes through a verified descriptor (verified-read.ts): what is
 * read is the file the check passed, still inside the folder. At most `maxBytes` (`too-large`).
 * Throws only for an fs error other than the refusals.
 */
export async function readInside(realRoot: string, rel: string, maxBytes: number): Promise<InsideRead> {
  const target = await resolveInside(realRoot, rel)
  if (!target.ok) return target
  if (target.size > maxBytes) return { ok: false, problem: 'too-large' }
  const read = await readVerified(target.real, maxBytes, target)
  return read.ok ? { ok: true, real: target.real, data: read.data } : read
}

/** fileProblem's wording of an InsideProblem (manifest errors, installer refusals). */
export function fileProblemText(problem: InsideProblem): string {
  switch (problem) {
    case 'missing':
      return 'file not found'
    case 'outside':
      return 'resolves outside the plugin folder'
    // The folder itself is a directory.
    case 'root':
    case 'not-file':
      return 'is not a file'
  }
}

/**
 * A readInside refusal as the tail of a message about the file (`plugin.json` + this): the
 * resolveInside wording after a colon, the size cap, or what changed during the read.
 */
export function insideReadProblemText(problem: InsideProblem | VerifiedProblem, maxBytes: number): string {
  if (problem === 'too-large') return ` is larger than ${maxBytes} bytes`
  if (problem === 'outside' || problem === 'root' || problem === 'missing' || problem === 'not-file') return `: ${fileProblemText(problem)}`
  return ` ${verifiedProblemText(problem)}`
}

/** Why `rel` (already syntax-checked) is not an acceptable file inside `realRoot`, or null (resolveInside). */
export async function fileProblem(realRoot: string, rel: string): Promise<string | null> {
  const file = await resolveInside(realRoot, rel)
  return file.ok ? null : fileProblemText(file.problem)
}

/**
 * Manifest keys that were part of the API and are gone. `contributes.accounts` left core in
 * 2026-10 (design §1 "What belongs in core", §6): a plugin brings its own sign-in.
 */
function removedKeyErrors(raw: Record<string, unknown>): string[] {
  const contributes = raw.contributes
  if (isPlainObject(contributes) && Object.hasOwn(contributes, 'accounts')) {
    return [
      'contributes.accounts is no longer supported: a plugin brings its own sign-in with ctx.secrets, ' +
        'a "format": "secret" settings field or ctx.oauth (see design §6 "Plugin sign-ins and secrets")'
    ]
  }
  return []
}

/**
 * The panel `kind` conditional (manifest.ts) in words: ajv reports `then: { not: … }` as "must NOT
 * be valid", which does not tell an author that a webview panel takes no `entry`.
 */
function panelKindErrors(errors: readonly ErrorObject[] | null | undefined): ErrorObject[] {
  return (errors ?? []).map((e) =>
    e.keyword === 'not' && /^\/contributes\/panels\/\d+$/.test(e.instancePath)
      ? { ...e, message: 'is a "webview" panel: it has no "entry" (the page comes from ctx.webview.navigate)' }
      : e
  )
}

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const id of ids) (seen.has(id) ? dup : seen).add(id)
  return [...dup]
}

/**
 * Check untrusted `plugin.json` content against the plugin folder it came from. Returns every
 * problem found (a plugin author fixes them in one go) or the typed manifest. `pluginDir` is
 * resolved here, so a relative or symlinked path is fine.
 */
export async function validateManifest(raw: unknown, pluginDir: string): Promise<ManifestValidation> {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['plugin.json must be a JSON object'] }
  }
  // The api major first: a plugin for another major may legitimately not fit this schema, and
  // "unsupported api" is the useful reason, not a pile of schema errors.
  const api = (raw as { api?: unknown }).api
  if (typeof api === 'number' && Number.isInteger(api) && api !== SUPPORTED_PLUGIN_API) {
    return { ok: false, errors: [`unsupported plugin api ${api} (this app supports api ${SUPPORTED_PLUGIN_API})`] }
  }
  // Keys this app once understood and dropped: the schema tolerates unknown keys (a later minor may
  // add some), so without this a plugin still declaring one would load and silently lose the
  // feature. Reported alongside any schema errors, so the author sees the move in one go.
  const removed = removedKeyErrors(raw)
  if (!manifestValidator(raw)) {
    return { ok: false, errors: [...removed, ...formatAjvErrors(panelKindErrors(manifestValidator.errors))] }
  }
  const manifest = raw as unknown as PluginManifest
  const errors: string[] = [...removed]
  const c = manifest.contributes ?? {}

  const idLists: [string, string[]][] = [
    ['panel', (c.panels ?? []).map((p) => p.id)],
    ['command', (c.commands ?? []).map((x) => x.id)],
    ['theme', (c.themes ?? []).map((t) => t.id)],
    ['skill', (c.skills ?? []).map((k) => k.id)],
    ['cli command', (c.cli ?? []).map((k) => k.name)]
  ]
  for (const [what, ids] of idLists) {
    for (const id of duplicates(ids)) errors.push(`duplicate ${what} ${what === 'cli command' ? 'name' : 'id'} "${id}"`)
  }
  // A command name is typed after `ccc`; a core command (or a word kept for one) is never taken.
  for (const cli of c.cli ?? []) {
    if (RESERVED_CLI_NAMES.includes(cli.name)) errors.push(`cli command "${cli.name}" is reserved for the app`)
  }
  // Providing and using one name would make the plugin its own consumer: the call would resolve to
  // itself (or, with a second provider, be ambiguous), which is never what the author meant.
  const provided = Object.keys(manifest.services?.provides ?? {})
  for (const name of provided) {
    if (Object.hasOwn(manifest.services?.uses ?? {}, name)) {
      errors.push(`service "${name}" is both provided and used; a plugin cannot use a service it provides`)
    }
  }
  // The command is implemented by the plugin's host, which only starts from `main`.
  if ((c.cli ?? []).length > 0 && manifest.main === undefined) {
    errors.push('contributes.cli needs "main": a plugin\'s commands run in its host')
  }
  for (const cmd of c.commands ?? []) {
    if (cmd.key !== undefined && normalizeChord(cmd.key, 'darwin') === null) {
      errors.push(`command "${cmd.id}": "${cmd.key}" is not a valid key chord`)
    }
  }

  for (const scope of ['project', 'app'] as const) {
    const schema = c.settings?.[scope]
    if (schema === undefined) continue
    const result = compileSettingsSchema(schema)
    if (!result.ok) for (const e of result.errors) errors.push(`settings.${scope}: ${e}`)
  }

  // File references: syntax first (cheap, no fs), then containment against the real folder.
  const refs: { label: string; file: string }[] = []
  if (manifest.main !== undefined) refs.push({ label: 'main', file: manifest.main })
  for (const p of c.panels ?? []) {
    // A webview panel has no page of its own (the schema forbids `entry` there).
    if (p.entry !== undefined) refs.push({ label: `panel "${p.id}" entry`, file: p.entry })
    if (p.icon !== undefined) refs.push({ label: `panel "${p.id}" icon`, file: p.icon })
  }
  for (const t of c.themes ?? []) refs.push({ label: `theme "${t.id}" file`, file: t.file })

  let realRoot: string | null = null
  try {
    realRoot = await fs.realpath(path.resolve(pluginDir))
  } catch {
    errors.push('plugin folder not found')
  }
  for (const ref of refs) {
    const syntax = relativePathProblem(ref.file)
    if (syntax !== null) {
      errors.push(`${ref.label} "${ref.file}" ${syntax}`)
    } else if (realRoot !== null) {
      const problem = await fileProblem(realRoot, ref.file)
      if (problem !== null) errors.push(`${ref.label} "${ref.file}": ${problem}`)
    }
  }

  // Skills: the whole folder of each is read under the copy limits and its SKILL.md front matter
  // checked now, so a plugin whose skill would be refused at copy time is refused here with the
  // reason, at install or link, instead of quietly running without it. The copy (claude-plugins.ts)
  // reads it again the same way: the folder can change in between.
  if (realRoot !== null && (c.skills ?? []).length > 0) {
    const skills = readSkillFiles(realRoot, c.skills ?? [])
    if (!skills.ok) errors.push(skills.error)
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, manifest }
}

/** Read `<pluginDir>/plugin.json` (inside the folder, bounded size) and validate it. */
export async function loadManifest(pluginDir: string): Promise<ManifestValidation> {
  let realRoot: string
  try {
    realRoot = await fs.realpath(path.resolve(pluginDir))
  } catch {
    return { ok: false, errors: ['plugin folder not found'] }
  }
  let file: InsideRead
  try {
    // The real path, checked inside the folder, read through a verified descriptor (not the link).
    file = await readInside(realRoot, 'plugin.json', MAX_MANIFEST_BYTES)
  } catch (err) {
    return { ok: false, errors: [`plugin.json cannot be read: ${(err as Error).message}`] }
  }
  if (!file.ok) return { ok: false, errors: [`plugin.json${insideReadProblemText(file.problem, MAX_MANIFEST_BYTES)}`] }
  const text = file.data.toString('utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [`plugin.json is not valid JSON: ${(err as Error).message}`] }
  }
  return validateManifest(raw, realRoot)
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export type SchemaCompilation = { ok: true; validate: ValidateFunction } | { ok: false; errors: string[] }

/** Structural limits on a plugin settings schema, before ajv sees it. */
function schemaProblems(schema: unknown): string[] {
  const problems: string[] = []
  if (!isPlainObject(schema)) {
    return ['schema must be an object']
  }
  let size: number
  try {
    size = JSON.stringify(schema).length
  } catch {
    return ['schema is not JSON data']
  }
  if (size > MAX_SCHEMA_BYTES) return [`schema is larger than ${MAX_SCHEMA_BYTES} bytes`]
  if ((schema as { type?: unknown }).type !== 'object') {
    problems.push('the root schema must have "type": "object"')
  }
  const secrets = secretSites(schema, problems)
  /**
   * `data`: under a `default`/`enum`/`const`/`examples`, where `format` is a value, not a keyword.
   * `names`: the node is a NAME_MAPS map (`properties`, `definitions`, ...), so its keys are
   * property or definition names, not keywords: a property named `const` or `default` holds a
   * schema, and reading it as data would let a nested secret or a `$ref` to one through unchecked.
   */
  const walk = (node: unknown, depth: number, at: string, data = false, names = false): void => {
    if (problems.length >= 10) return
    if (depth > MAX_SCHEMA_DEPTH) {
      problems.push(`${at}: nested deeper than ${MAX_SCHEMA_DEPTH} levels`)
      return
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, depth + 1, `${at}/${i}`, data))
      return
    }
    if (typeof node !== 'object' || node === null) return
    // A secret anywhere but a top-level property would travel to the renderer inside the form's
    // `values` (only top-level secret properties are taken out of them) and be stored in plain
    // JSON: nested, under `items`, in an `allOf`/`anyOf`/`oneOf` branch, in a `$ref` target.
    const keywords = !data && !names
    if (keywords && own(node as Record<string, unknown>, 'format') === 'secret' && !secrets.nodes.has(node)) {
      problems.push(`${at}: "format": "secret" is allowed only on a top-level property of the settings object`)
    }
    for (const [key, value] of Object.entries(node)) {
      const where = `${at}/${key}`
      // Object.entries sees an own `__proto__` key (JSON.parse creates one), so this catches it in
      // `properties`, in `default` values and everywhere else.
      if (FORBIDDEN_KEYS.has(key)) {
        problems.push(`${where}: "${key}" is not allowed as a key`)
        continue
      }
      // A schema with secret fields has no references at all. Which properties are secret is read
      // from the schema as written (secretFieldsOf), and ajv and the form (rjsf) each resolve a
      // reference their own way: rjsf percent-decodes the whole fragment before splitting it, ajv
      // decodes each segment, ajv also resolves `#name` through `$anchor` and rjsf does not. Every
      // rule main kept for a ref (not at the root, not at a secret, not into a `default`, not
      // naming a secret from a root `allOf`) was one more reading to get the same, and reviews kept
      // finding the next one. With none of these keywords, main, ajv and the form see one schema.
      // Refused in every position, also as a property name or inside a `default`: over-refuses a
      // property called `$ref`, but needs no reading of where the key sits either.
      if (secrets.names.size > 0 && REFERENCE_KEYWORDS.has(key)) {
        problems.push(`${where}: "${key}" is not allowed in a schema with secret fields (write the schema out without references)`)
        continue
      }
      // Only string values are the keywords; an object under `properties.$id` is a property name.
      if (typeof value === 'string' && !names) {
        // $id/$schema would register or switch meta-schemas; every ref must stay in this document.
        if (key === '$id' || key === '$schema') problems.push(`${where}: "${key}" is not allowed`)
        else if (key === '$ref' && !value.startsWith('#')) problems.push(`${where}: only local "#..." refs are allowed`)
        // ajv and the form resolve a pointer through any value, so a ref into a `default` uses
        // that data as a schema, one the walk read as data: a `format: "secret"` there would
        // render as a secret field that main (secretFieldsOf) does not know, its value unredacted.
        else if (key === '$ref' && !data && refIntoData(value)) {
          problems.push(`${where}: a "$ref" must point at a schema, not into a "default", "enum", "const" or "examples" value`)
        }
      }
      // A number: an object here is a property named `minItems`.
      if (key === 'minItems' && typeof value === 'number' && value > MAX_SCHEMA_MIN_ITEMS) {
        problems.push(`${where}: "minItems" above ${MAX_SCHEMA_MIN_ITEMS} is not allowed`)
      }
      // `$async: true` compiles to a validator that returns a Promise, which is truthy: every stored
      // value would pass and an invalid one would surface as an unhandled rejection in main. An
      // object here is a property named `$async`.
      if (key === '$async' && (typeof value !== 'object' || value === null)) {
        problems.push(`${where}: "$async" is not allowed`)
      }
      // Data starts only at a keyword; a name map's entries are schemas again (a property named
      // `properties` holds a schema whose keys are keywords).
      walk(value, depth + 1, where, data || (!names && DATA_KEYWORDS.has(key)), keywords && NAME_MAPS.has(key))
    }
  }
  walk(schema, 0, '')
  // Only on a schema that passed the walk: depth is bounded and every `$ref` is local.
  if (problems.length === 0 && secrets.names.size > 0) {
    const named = rootSecretMention(schema, secrets.names)
    if (named !== null) problems.push(named)
  }
  if (problems.length === 0) {
    const expansion = defaultExpansionProblem(schema)
    if (expansion !== null) problems.push(expansion)
  }
  return problems
}

/** Keywords whose value is data, not schema: a `format: "secret"` key inside one is not a keyword. */
const DATA_KEYWORDS = new Set(['default', 'enum', 'const', 'examples'])

/** Keywords whose value maps names (of properties or definitions) to schemas or name lists. */
const NAME_MAPS = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependencies', 'dependentSchemas', 'dependentRequired'])

/**
 * Root keywords besides `properties`/`required` that apply to the settings object itself. The
 * values are checked without the secret fields (publicSchemaOf takes them out of the top-level
 * `properties` and `required` only), so one of these naming a secret would still act on the
 * stripped data: `allOf: [{ properties: { token: { default: "x" } } }]` has ajv fill a manifest
 * plaintext `token` back into the values, `allOf: [{ required: ["token"] }]` fails always.
 */
const ROOT_APPLICATORS = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependencies', 'dependentSchemas', 'dependentRequired']

/**
 * The keywords that make one part of a schema stand for another (or name a part so it can be
 * referenced). None is allowed in a schema with secret fields; see the walk in schemaProblems.
 */
const REFERENCE_KEYWORDS = new Set(['$ref', '$dynamicRef', '$recursiveRef', '$anchor', '$dynamicAnchor', '$recursiveAnchor', '$id'])

/** NAME_MAPS whose keys are definition names or patterns, not names of the object's properties. */
const NOT_PROPERTY_NAMES = new Set(['definitions', '$defs', 'patternProperties'])

/**
 * A problem when a root applicator (ROOT_APPLICATORS) names a secret field: as a key of a
 * `properties`/`dependencies`/`dependentSchemas`/`dependentRequired` map, or in a `required` or
 * `dependencies`/`dependentRequired` name list. Over-refuses a nested object's own property of the
 * same name under such a keyword (rare, and the message says how to fix it). Run after the walk:
 * depth is bounded, and the schema (it has secret fields) holds no reference, so what is written
 * under the applicators is all they apply.
 */
function rootSecretMention(schema: object, names: ReadonlySet<string>): string | null {
  const listsName = (v: unknown): boolean => Array.isArray(v) && v.some((s) => typeof s === 'string' && names.has(s))
  /** `node` is a schema (or an array of schemas). */
  const mentions = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(mentions)
    if (typeof node !== 'object' || node === null) return false
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue
      if (key === 'required') {
        if (listsName(value)) return true
      } else if (NAME_MAPS.has(key) && isPlainObject(value)) {
        for (const [name, entry] of Object.entries(value)) {
          if (!NOT_PROPERTY_NAMES.has(key) && names.has(name)) return true
          // A schema, or a name list under `dependencies`/`dependentRequired`.
          if (Array.isArray(entry) ? listsName(entry) : mentions(entry)) return true
        }
      } else if (mentions(value)) return true
    }
    return false
  }
  for (const key of ROOT_APPLICATORS) {
    // The keyword alone, as if it were the whole schema: the same rules as anywhere below it.
    if (Object.hasOwn(schema, key) && mentions({ [key]: (schema as Record<string, unknown>)[key] })) {
      return `/${key}: a secret field may be named only in the top-level "properties" and "required" (it is checked apart from the other values)`
    }
  }
  return null
}

/**
 * The decoded segments of a local `#/...` JSON pointer, or undefined when `ref` is not one or holds
 * a bad percent escape (a pointer ajv cannot resolve either: its compile fails on it).
 */
function pointerSegments(ref: string): string[] | undefined {
  if (!ref.startsWith('#/')) return undefined
  const segs: string[] = []
  for (const raw of ref.slice(2).split('/')) {
    try {
      segs.push(decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~'))
    } catch {
      return undefined
    }
  }
  return segs
}

/** The node a local `#...` ref points at in `root`, or undefined when it does not resolve. */
function localRefTarget(root: object, ref: string): unknown {
  if (ref === '#') return root
  const segs = pointerSegments(ref)
  if (segs === undefined) return undefined
  let node: unknown = root
  for (const seg of segs) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, seg)) return undefined
    node = (node as Record<string, unknown>)[seg]
  }
  return node
}

/**
 * A secret field's name becomes part of its secrets.json key, `setting:project:<16 hex>:<name>`
 * (plugin-secrets.ts SECRET_KEY_PATTERN, at most 128 characters): the contribution-id shape (no
 * `:`, so the key splits one way) keeps every legal name inside it.
 */
const SECRET_FIELD_NAME = CONTRIBUTION_ID_PATTERN

/** The top-level `properties` that are secret fields (`"format": "secret"`), as [name, schema]. */
function secretProperties(schema: object): [string, Record<string, unknown>][] {
  const props = own(schema as Record<string, unknown>, 'properties')
  if (!isPlainObject(props)) return []
  const out: [string, Record<string, unknown>][] = []
  for (const [name, prop] of Object.entries(props)) {
    if (isPlainObject(prop) && own(prop, 'format') === 'secret') out.push([name, prop])
  }
  return out
}

/**
 * The top-level secret fields of a schema: `properties.<name>` with `"format": "secret"`. Each one
 * must be `"type": "string"` (exactly: a secret is stored as one string), have no `default` (a
 * default is plaintext in the manifest and would be filled into the values the renderer gets) and
 * no other keyword than SECRET_FIELD_KEYWORDS.
 * Problems go to `problems`; `nodes` are the property schemas where the walk accepts the format.
 */
function secretSites(schema: object, problems: string[]): { nodes: Set<object>; names: Set<string> } {
  const nodes = new Set<object>()
  const names = new Set<string>()
  for (const [name, prop] of secretProperties(schema)) {
    nodes.add(prop)
    names.add(name)
    const at = `/properties/${name}`
    if (!SECRET_FIELD_NAME.test(name)) {
      problems.push(`${at}: a secret field's name is 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit`)
    }
    if (own(prop, 'type') !== 'string') problems.push(`${at}: a secret field must have "type": "string"`)
    if (Object.hasOwn(prop, 'default')) problems.push(`${at}: a secret field may not have a "default"`)
    // The value is taken out of validation (it is stored apart from the other settings), so a
    // `minLength`, `enum` or `allOf` here would be accepted and silently never checked.
    for (const key of Object.keys(prop)) {
      // `default` was reported on the line above; do not say it twice.
      if (key !== 'default' && !SECRET_FIELD_KEYWORDS.has(key)) {
        problems.push(`${at}: a secret field allows only "type", "format", "title", "description" and "$comment", not "${key}" (its value is not validated)`)
      }
    }
  }
  return { nodes, names }
}

/** What a secret field's schema may hold: the shape and the form's labels, nothing to validate. */
const SECRET_FIELD_KEYWORDS = new Set(['type', 'format', 'title', 'description', '$comment'])

/**
 * The segments of a local `#/...` pointer as the settings form reads it: rjsf (findSchemaDefinition)
 * percent-decodes the whole fragment and only then splits it, so `x%2Fdefault` is two segments
 * there and one (a property named `x/default`) for ajv and pointerSegments.
 */
function formPointerSegments(ref: string): string[] | undefined {
  if (!ref.startsWith('#/')) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(ref.slice(2))
  } catch {
    return undefined
  }
  return decoded.split('/').map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/**
 * A local ref whose pointer enters a DATA_KEYWORDS value, read the way the walk reads the schema:
 * a segment after a NAME_MAPS keyword is a name (a property called `default` is a schema), any
 * other segment is a keyword or an array index. Both readings of the pointer are checked, ajv's
 * and the form's: with `x/default` and `x.default` both defined, `#/properties/x%2Fdefault` is a
 * schema to ajv and the data of `x`'s `default` to the form.
 */
function refIntoData(ref: string): boolean {
  const enters = (segs: string[] | undefined): boolean => {
    if (segs === undefined) return false
    let names = false
    for (const seg of segs) {
      if (!names && DATA_KEYWORDS.has(seg)) return true
      names = !names && NAME_MAPS.has(seg)
    }
    return false
  }
  return enters(pointerSegments(ref)) || enters(formPointerSegments(ref))
}

/**
 * An upper bound on what filling in defaults can build from `schema`, refused past
 * MAX_SCHEMA_EXPANSION. Two consumers fill in defaults: ajv (`useDefaults`, in main, on every
 * settings check) and the settings form (rjsf, which also fills each array up to `minItems`). The
 * bound over-approximates both rather than modelling either: every JSON value in the schema
 * counts (keywords, `default` values, unused definitions), weighted by how many copies of it can
 * be built, which is the product of the `minItems` of the arrays whose `items`/`additionalItems`/
 * `prefixItems` it sits under. A local `$ref` is followed where it is used, so a definition counts
 * once per use; a cycle is followed twice (rjsf resolves one level of a recursive `$ref` before it
 * stops), and ajv on a cycle whose every step has a default overflows the stack, which
 * validateSettings already turns into an error. Every visit adds at least 1, so the walk itself
 * stops after MAX_SCHEMA_EXPANSION visits however the refs fan out.
 *
 * Which `minItems` applies to an `items` is not only its own object's: rjsf merges an `anyOf`/
 * `oneOf` option into the schema that holds it, and a `$ref` target with the ref's siblings, so
 * `{minItems: 50, anyOf: [{items: …}]}` and `{items: …, anyOf: [{minItems: 50}]}` both build 50
 * entries (three such levels in 221 bytes built 127,552 values in the form, while a walk reading
 * `minItems` from the object holding `items` alone saw a multiplier of 1). So each object's multiplier is the largest `minItems` of its merge group: the
 * object, everything reachable from it through MERGE_KEYWORDS and `$ref`, and the groups it was
 * itself merged into (passed down as `inherited`). The largest over all branches, whichever rjsf
 * or ajv would pick, keeps this an upper bound; `properties` and the item keywords start a new
 * group, as they hold a different value, not more of the same one.
 */
function defaultExpansionProblem(root: object): string | null {
  const ITEM_KEYWORDS = new Set(['items', 'additionalItems', 'prefixItems'])
  // Keywords whose subschemas describe the SAME value as the object holding them (merged into it
  // by rjsf, or applied to it by ajv): arrays of schemas, single schemas, and maps of schemas.
  // (`not` builds nothing: neither rjsf nor ajv fills defaults from it.)
  const MERGE_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf', 'if', 'then', 'else', 'dependentSchemas', 'dependencies'])
  const MERGE_MAPS = new Set(['dependentSchemas', 'dependencies'])
  // A ref string resolves the same way every time; resolving it once keeps a long pointer used
  // thousands of times from costing its length on each use.
  const resolved = new Map<string, unknown>()
  const resolve = (ref: string): unknown => {
    if (resolved.has(ref)) return resolved.get(ref)
    const node = localRefTarget(root, ref)
    resolved.set(ref, node)
    return node
  }
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const ownMin = (n: Record<string, unknown>): number => (typeof n.minItems === 'number' && n.minItems > 1 ? n.minItems : 1)
  /** The subschemas merged into `n` (MERGE_KEYWORDS and its `$ref` target). */
  const mergedInto = (n: Record<string, unknown>): unknown[] => {
    const out: unknown[] = []
    for (const key of MERGE_KEYWORDS) {
      const v = n[key]
      if (Array.isArray(v)) out.push(...v)
      else if (MERGE_MAPS.has(key) && isObject(v)) out.push(...Object.values(v))
      else out.push(v)
    }
    if (typeof n.$ref === 'string') out.push(resolve(n.$ref))
    return out
  }
  // The largest `minItems` in an object's merge group, per object. The group is walked with its own
  // `seen` set, so a `$ref` cycle ends and the result does not depend on the order of calls; each
  // object is walked once (cached), and a group holds at most every object of a schema that is
  // already capped at MAX_SCHEMA_BYTES.
  const groupMins = new Map<object, number>()
  const groupMin = (start: Record<string, unknown>): number => {
    const cached = groupMins.get(start)
    if (cached !== undefined) return cached
    let max = 1
    const seen = new Set<object>()
    const stack: unknown[] = [start]
    while (stack.length > 0) {
      const n = stack.pop()
      if (!isObject(n) || seen.has(n)) continue
      seen.add(n)
      max = Math.max(max, ownMin(n))
      stack.push(...mergedInto(n))
    }
    groupMins.set(start, max)
    return max
  }
  let total = 0
  let problem: string | null = null
  /**
   * `copies`: how many times the value `node` describes can be built. `inherited`: the largest
   * `minItems` of the groups `node` was merged into (1 when it starts a group of its own).
   */
  const visit = (node: unknown, copies: number, refs: readonly string[], inherited: number): void => {
    if (problem !== null) return
    total += copies
    if (total > MAX_SCHEMA_EXPANSION) {
      problem = `filling in defaults could build more than ${MAX_SCHEMA_EXPANSION} values (nested "minItems" and repeated "$ref"s multiply); simplify the schema`
      return
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, copies, refs, inherited)
      return
    }
    if (!isObject(node)) return
    const minItems = Math.max(inherited, groupMin(node))
    for (const [key, value] of Object.entries(node)) {
      if (ITEM_KEYWORDS.has(key)) visit(value, copies * minItems, refs, 1)
      else if (MERGE_MAPS.has(key) && isObject(value)) {
        // The map itself counts once; its schemas are merged into `node` like an anyOf option.
        total += copies
        for (const v of Object.values(value)) visit(v, copies, refs, minItems)
      } else visit(value, copies, refs, MERGE_KEYWORDS.has(key) ? minItems : 1)
    }
    const ref = node.$ref
    if (typeof ref !== 'string') return
    if (refs.filter((r) => r === ref).length >= 2) return
    if (refs.length >= MAX_SCHEMA_REF_DEPTH) {
      problem = `"$ref"s nest more than ${MAX_SCHEMA_REF_DEPTH} deep`
      return
    }
    const target = resolve(ref)
    // The target is merged with the ref's siblings (rjsf), so it inherits this group's minItems.
    if (target !== undefined) visit(target, copies, [...refs, ref], minItems)
  }
  visit(root, 1, [], 1)
  return problem
}

// Compiled validators by schema object: the manifest object is kept for the plugin's lifetime, and
// settings are checked on every change.
const compiledSchemas = new WeakMap<object, SchemaCompilation>()

/**
 * Check a plugin-provided settings schema and compile it. Each schema gets its own Ajv instance
 * (no shared registry, so one plugin's refs can never reach another's), configured as:
 * `$data` off and no custom keywords or formats added (the manifest cannot bring code), no
 * `loadSchema` (a remote `$ref` cannot be fetched, it just fails to compile), `useDefaults` on so
 * defaults are filled in. The schema is meta-validated first and every ajv throw is caught: a bad
 * schema is a reason to disable the plugin, never a crash in main.
 */
export function compileSettingsSchema(schema: unknown): SchemaCompilation {
  const cacheable = typeof schema === 'object' && schema !== null
  if (cacheable) {
    const cached = compiledSchemas.get(schema)
    if (cached) return cached
  }
  const result = compileUncached(schema)
  if (cacheable) compiledSchemas.set(schema, result)
  return result
}

function compileUncached(schema: unknown): SchemaCompilation {
  const problems = schemaProblems(schema)
  if (problems.length > 0) return { ok: false, errors: problems }
  try {
    const ajv = new Ajv({
      allErrors: true,
      // Lenient on unknown keywords/formats so form-library hints (`title`, `ui:*`) do not fail a
      // plugin; the structural checks above and the meta-schema below are what matter.
      strict: false,
      validateFormats: false,
      logger: false,
      $data: false,
      useDefaults: true,
      addUsedSchema: false,
      // `required: ["constructor"]` must not be met by Object.prototype on `{}`.
      ownProperties: true,
      code: { regExp: refuseRegExp }
    })
    if (!ajv.validateSchema(schema as object)) {
      return { ok: false, errors: formatAjvErrors(ajv.errors).map((e) => `invalid settings schema: ${e}`) }
    }
    const validate = ajv.compile(schema as object)
    // Belt to the `$async` refusal above: validateSettings relies on a synchronous boolean.
    if ((validate as { $async?: unknown }).$async) return { ok: false, errors: ['invalid settings schema: async schemas are not allowed'] }
    return { ok: true, validate }
  } catch (err) {
    return { ok: false, errors: [`invalid settings schema: ${(err as Error).message}`] }
  }
}

export type SettingsValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: string[] }

/**
 * The names of a schema's secret fields (`"format": "secret"` on a top-level property; the
 * manifest check refused it anywhere else). Their values live in secrets.json under `setting:`
 * keys (plugin-secrets.ts), never in the settings JSON files, the form's values or a save result.
 */
export function secretFieldsOf(schema: JsonSchema | undefined): string[] {
  return schema === undefined ? [] : secretProperties(schema).map(([name]) => name)
}

/** A copy of `values` without the schema's secret fields (a hand-edited file may hold one). */
export function withoutSecretFields(schema: JsonSchema | undefined, values: Record<string, unknown>): Record<string, unknown> {
  const names = secretFieldsOf(schema)
  if (names.length === 0) return values
  const out = { ...values }
  for (const name of names) delete out[name]
  return out
}

// The schema the JSON values are checked against, by manifest schema object: the same object
// every time, so compileSettingsSchema's cache keeps working.
const publicSchemas = new WeakMap<object, JsonSchema>()

/**
 * `schema` with its secret fields taken out of `properties` and `required`: the stored JSON never
 * holds them, so a required secret that is not set yet must not fail the check and disable the
 * plugin (ctx.settings just lacks the field; the form shows it as "Not set").
 */
function publicSchemaOf(schema: JsonSchema): JsonSchema {
  const names = secretFieldsOf(schema)
  if (names.length === 0) return schema
  const cached = publicSchemas.get(schema)
  if (cached) return cached
  const properties = { ...(schema.properties as Record<string, unknown>) }
  for (const name of names) delete properties[name]
  const out: JsonSchema = { ...schema, properties }
  if (Array.isArray(schema.required)) out.required = schema.required.filter((r) => !names.includes(r as string))
  publicSchemas.set(schema, out)
  return out
}

/**
 * Validate stored settings against a plugin's schema and return a copy with defaults applied.
 * `undefined`/`null` count as "nothing stored yet" (defaults only). With no schema the plugin
 * declared no such settings and the value is `{}`. Secret fields are not part of the check and are
 * left out of the result (see publicSchemaOf).
 */
export function validateSettings(schema: JsonSchema | undefined, value: unknown): SettingsValidation {
  if (value !== undefined && value !== null && (typeof value !== 'object' || Array.isArray(value))) {
    return { ok: false, errors: ['settings must be an object'] }
  }
  if (schema === undefined) return { ok: true, value: {} }
  // The manifest's own schema first: its problems (a misplaced secret among them) are the reason.
  const full = compileSettingsSchema(schema)
  if (!full.ok) return { ok: false, errors: full.errors }
  const publicSchema = publicSchemaOf(schema)
  const c = publicSchema === schema ? full : compileSettingsSchema(publicSchema)
  if (!c.ok) return { ok: false, errors: c.errors }
  // Ajv fills defaults in place; never mutate the caller's stored object.
  const data = withoutSecretFields(schema, structuredClone((value ?? {}) as Record<string, unknown>))
  const badKey = forbiddenKeyPath(data)
  if (badKey !== null) return { ok: false, errors: [`${badKey} is not allowed as a key`] }
  let valid: boolean
  try {
    valid = c.validate(data) as boolean
  } catch (err) {
    // A schema that compiles can still throw here: `useDefaults` with a `$ref` cycle whose every
    // step has a `default` recurses until the stack overflows (RangeError). That is a broken
    // plugin, not a crash in main.
    return { ok: false, errors: [`settings cannot be validated: ${(err as Error).message}`] }
  }
  if (!valid) return { ok: false, errors: formatAjvErrors(c.validate.errors) }
  return { ok: true, value: data }
}

/** Path of the first `__proto__`/`constructor`/`prototype` own key in a stored value, or null. */
function forbiddenKeyPath(value: unknown): string | null {
  // The value came through structuredClone, which keeps cycles; `seen` stops the walk on them.
  const seen = new Set<object>()
  const walk = (node: unknown, at: string): string | null => {
    if (typeof node !== 'object' || node === null || seen.has(node)) return null
    seen.add(node)
    for (const [key, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.has(key)) return `${at}/${key}`
      const found = walk(v, `${at}/${key}`)
      if (found !== null) return found
    }
    return null
  }
  return walk(value, '')
}

export type PluginSettingsCheck =
  | { ok: true; app: Record<string, unknown>; project: Record<string, unknown> }
  | { ok: false; reason: string }

/**
 * Check both scopes for one plugin in one project. A failure carries the reason the plugin is
 * disabled with (shown next to it in Settings): which scope, and what is wrong.
 */
export function checkPluginSettings(
  manifest: PluginManifest,
  stored: { app?: unknown; project?: unknown }
): PluginSettingsCheck {
  const schemas = manifest.contributes?.settings
  const app = validateSettings(schemas?.app, stored.app)
  if (!app.ok) return { ok: false, reason: `invalid app settings: ${app.errors.slice(0, 5).join('; ')}` }
  const project = validateSettings(schemas?.project, stored.project)
  if (!project.ok) return { ok: false, reason: `invalid project settings: ${project.errors.slice(0, 5).join('; ')}` }
  return { ok: true, app: app.value, project: project.value }
}
