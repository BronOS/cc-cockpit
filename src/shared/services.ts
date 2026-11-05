// Plugin services: the one rule for "which plugin answers service X in this project" and the
// problems it can have. Pure and shared on purpose: the host registry (runtime, src/host) and main
// (Plugins page warnings) both call these over the same list of plugins, so a warning on the page
// and the error a call throws cannot disagree. Neither keeps its own copy of the rule.
import type { PluginManifest } from './manifest'
import { SLOT_NONE, slotPickKey } from './slots'

/** What the rule needs from a plugin: its id and the manifest's `services` field. */
export interface ServicePlugin {
  id: string
  services?: PluginManifest['services']
}

/** The project's picks, `{ [service]: pluginId }` (project record `serviceProviders`). */
export type ServiceChoices = Readonly<Record<string, string>>

/** A consumer asking for a service at a version (its `uses` entry). */
export interface ServiceConsumer {
  id: string
  version: number
}

export type ServiceProblem =
  | { kind: 'missing'; service: string }
  | { kind: 'ambiguous'; service: string; candidates: string[] }
  | { kind: 'version-mismatch'; service: string; consumer: string; usesVersion: number; provider: string; providesVersion: number }
  // A collector reads every provider at its own major (useAll); this one provides the name at another
  // major, so useAll skips it and its items would be silently absent.
  | { kind: 'collected-major'; service: string; consumer: string; usesVersion: number; provider: string; providesVersion: number }

export type ProviderSelection =
  | { ok: true; provider: string; version: number }
  | { ok: false; problem: ServiceProblem }

// Declarations come from untrusted manifests, and `constructor` is a valid service name: read every
// map with hasOwn so `provides["constructor"]` never answers with Object's own member.
function declared(map: Record<string, number> | undefined, name: string): number | undefined {
  return map !== undefined && Object.hasOwn(map, name) ? map[name] : undefined
}

/** The plugins that provide `service`, in the order given (so messages are stable). */
export function providersOf(service: string, plugins: readonly ServicePlugin[]): string[] {
  return plugins.filter((p) => declared(p.services?.provides, service) !== undefined).map((p) => p.id)
}

/**
 * The plugin that answers `service`: the only provider, or the project's pick among several.
 * A pick naming a plugin that is not a provider in this set (disabled, uninstalled, dropped from
 * the host's specs, or no longer declaring it after an update) is a stale choice and counts as no
 * choice, not an error: nothing cleans choices up, so they outlive their plugins by design. With
 * `consumer`, a major-version difference is reported too (selection still names no provider then:
 * a call must not reach a provider of another major).
 */
export function selectProvider(
  service: string,
  plugins: readonly ServicePlugin[],
  choices: ServiceChoices,
  consumer?: ServiceConsumer
): ProviderSelection {
  const candidates = providersOf(service, plugins)
  let provider: string | undefined
  if (candidates.length === 1) provider = candidates[0]
  else if (candidates.length > 1) {
    const pick = Object.hasOwn(choices, service) ? choices[service] : undefined
    if (pick !== undefined && candidates.includes(pick)) provider = pick
  }
  if (candidates.length === 0) return { ok: false, problem: { kind: 'missing', service } }
  if (provider === undefined) return { ok: false, problem: { kind: 'ambiguous', service, candidates } }
  const plugin = plugins.find((p) => p.id === provider)
  const version = declared(plugin?.services?.provides, service) as number
  if (consumer !== undefined && consumer.version !== version) {
    return {
      ok: false,
      problem: { kind: 'version-mismatch', service, consumer: consumer.id, usesVersion: consumer.version, provider, providesVersion: version }
    }
  }
  return { ok: true, provider, version }
}

/** Whether the plugin reads `service` from every provider (`services.collects`). */
export function collectsName(p: ServicePlugin, service: string): boolean {
  const list = p.services?.collects
  return Array.isArray(list) && list.includes(service)
}

/** `A`, `A and B`, `A, B and C`. */
function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The message for a problem; the runtime throws it and the Plugins page shows it, so the wording
 * lives here. `nameOf` lets the page say plugin names where the runtime says ids.
 */
export function serviceProblemMessage(problem: ServiceProblem, nameOf: (id: string) => string = (id) => id): string {
  switch (problem.kind) {
    case 'missing':
      return `no enabled plugin in this project provides service "${problem.service}"`
    case 'ambiguous':
      return `plugins ${joinNames(problem.candidates.map(nameOf))} both provide service "${problem.service}"; pick one in Settings > Plugins`
    case 'version-mismatch':
      return `"${problem.service}": ${nameOf(problem.consumer)} uses version ${problem.usesVersion}, ${nameOf(problem.provider)} provides version ${problem.providesVersion}`
    case 'collected-major':
      return `${nameOf(problem.provider)} provides ${problem.service} ${problem.providesVersion}, ${nameOf(problem.consumer)} reads ${problem.usesVersion}: update ${nameOf(problem.provider)}`
  }
}

export interface PluginServiceStatus {
  id: string
  provides: { service: string; version: number }[]
  uses: { service: string; version: number }[]
  /** Problems of the services this plugin uses (a provider has none of its own). */
  problems: ServiceProblem[]
}

export interface ServiceInfo {
  service: string
  /**
   * Every plugin of the project that uses the name collects it (`services.collects`, read with
   * `useAll`), and one does: no call resolves a single provider, so there is nothing to pick and
   * several providers are not a problem (Chat, Gmail and Jira all provide `inbox-feed`).
   */
  collectedOnly: boolean
  /** Provider ids in plugin order. */
  candidates: string[]
  /** The provider calls reach, or null (no provider, or several with no valid pick). */
  selected: string | null
}

export interface ServicesStatus {
  plugins: PluginServiceStatus[]
  /** Every service some plugin provides or uses, sorted by name. */
  services: ServiceInfo[]
}

/**
 * Per plugin what it provides and uses plus the problems of what it uses; per service the
 * candidates and the selected provider. Plain arrays and objects, so main can send it over IPC.
 */
export function serviceStatus(plugins: readonly ServicePlugin[], choices: ServiceChoices): ServicesStatus {
  const names = new Set<string>()
  const entries = (m: Record<string, number> | undefined): { service: string; version: number }[] =>
    Object.entries(m ?? {}).map(([service, version]) => ({ service, version }))
  const statuses = plugins.map((p): PluginServiceStatus => {
    const provides = entries(p.services?.provides)
    const uses = entries(p.services?.uses)
    for (const e of [...provides, ...uses]) names.add(e.service)
    const problems: ServiceProblem[] = []
    for (const u of uses) {
      // A collected name reads every provider: none or several is not a problem (useAll lists the
      // providers of its major). A provider at another major is: useAll skips it, so its items
      // would be silently absent; the collector gets one warning per such provider (the host and the
      // Plugins page share this rule). The plugin itself is skipped: it may provide and collect a name.
      if (collectsName(p, u.service)) {
        for (const other of plugins) {
          const v = other.id === p.id ? undefined : declared(other.services?.provides, u.service)
          if (v !== undefined && v !== u.version) {
            problems.push({ kind: 'collected-major', service: u.service, consumer: p.id, usesVersion: u.version, provider: other.id, providesVersion: v })
          }
        }
        continue
      }
      const sel = selectProvider(u.service, plugins, choices, { id: p.id, version: u.version })
      if (!sel.ok) problems.push(sel.problem)
    }
    return { id: p.id, provides, uses, problems }
  })
  const services = [...names].sort().map((service): ServiceInfo => {
    const sel = selectProvider(service, plugins, choices)
    const users = plugins.filter((p) => p.services?.uses !== undefined && Object.hasOwn(p.services.uses, service))
    const collectedOnly = users.length > 0 && users.every((p) => collectsName(p, service))
    return { service, candidates: providersOf(service, plugins), selected: sel.ok ? sel.provider : null, collectedOnly }
  })
  return { plugins: statuses, services }
}

// ---------------------------------------------------------------------------------------------
// "Open file" (friction round 1, Task 12): which plugin takes a click on a changed file in core's
// Sessions panel. Not a service, but the same question ("which of several plugins answers here"),
// so it goes through selectProvider with the plugins that declare `contributes.openFile` standing
// in as providers of one reserved name. The pick is stored next to the service picks
// (`serviceProviders`), under a key no service can have, and the Plugins page shows it with them.

/** The key of the open-file pick in `serviceProviders`: `@` never starts a service name. */
export const OPEN_FILE_PICK = '@open-file'
/** The pick value that means core's own viewer (the pager): `@` never starts a plugin id. */
export const BUILTIN_VIEWER = '@builtin'

/** What the rule needs from a plugin: its id and the manifest's `contributes.openFile`. */
export interface OpenFilePlugin {
  id: string
  openFile?: { title: string }
}

export interface OpenFileStatus {
  /** The plugins that declare `contributes.openFile`, in plugin order, with the title they gave. */
  candidates: { id: string; title: string }[]
  /**
   * Where a click goes: a candidate's id, BUILTIN_VIEWER (picked, or no candidate at all), or null
   * (several candidates and no valid pick; the click opens the built-in viewer until one is picked).
   */
  selected: string | null
}

/** The Plugins page's view of the project's picks: the services, the open-file pick and the slot picks. */
export interface PluginServicesView extends ServicesStatus {
  openFile: OpenFileStatus
  slots: SlotPickStatus[]
}

/** The open-file selection in selectProvider's terms (a candidate provides OPEN_FILE_PICK v1). */
function openFileSelection(plugins: readonly OpenFilePlugin[], choices: ServiceChoices): ProviderSelection {
  const asProviders = plugins.map((p): ServicePlugin => (p.openFile !== undefined ? { id: p.id, services: { provides: { [OPEN_FILE_PICK]: 1 } } } : { id: p.id }))
  return selectProvider(OPEN_FILE_PICK, asProviders, choices)
}

const pickedBuiltin = (choices: ServiceChoices): boolean =>
  Object.hasOwn(choices, OPEN_FILE_PICK) && choices[OPEN_FILE_PICK] === BUILTIN_VIEWER

/**
 * The plugin a click on a changed file goes to, or null for the built-in viewer: no plugin declares
 * `openFile`, the project picked the built-in viewer, or several do and none (valid) is picked. A
 * stale pick (a plugin since disabled or no longer declaring it) counts as none, as for services.
 */
export function selectOpenFile(plugins: readonly OpenFilePlugin[], choices: ServiceChoices): string | null {
  if (pickedBuiltin(choices)) return null
  const sel = openFileSelection(plugins, choices)
  return sel.ok ? sel.provider : null
}

/** The candidates and the current selection, for the Plugins page (plain data, sent over IPC). */
export function openFileStatus(plugins: readonly OpenFilePlugin[], choices: ServiceChoices): OpenFileStatus {
  const candidates = plugins.flatMap((p) => (p.openFile !== undefined ? [{ id: p.id, title: p.openFile.title }] : []))
  if (candidates.length === 0 || pickedBuiltin(choices)) return { candidates, selected: BUILTIN_VIEWER }
  const sel = openFileSelection(plugins, choices)
  return { candidates, selected: sel.ok ? sel.provider : null }
}

// ---------------------------------------------------------------------------------------------
// Slots (design-next §2): which plugin draws the slots of a type in this project. Like the
// open-file pick, not a service but the same question, so it goes through selectProvider with the
// plugins that declare the type in `contributes.slots` standing in as providers of the reserved
// name `@slot:<type>`, which is also the pick's key in `serviceProviders`. One candidate draws;
// several with no valid pick draw nothing (the Plugins page shows the row as a problem, decided
// question 4); SLOT_NONE turns the type off for the project; a stale pick counts as none.

/** What the rule needs from a plugin: its id and the types of its `contributes.slots`. */
export interface SlotPlugin {
  id: string
  slots?: readonly { type: string }[]
}

export interface SlotPickStatus {
  type: string
  /** The plugins that declare the type, in plugin order. */
  candidates: string[]
  /**
   * Who draws: a candidate's id, SLOT_NONE (the project turned the type off), or null (several
   * candidates and no valid pick: nothing draws until one is picked).
   */
  selected: string | null
}

const declaresSlot = (p: SlotPlugin, type: string): boolean => Array.isArray(p.slots) && p.slots.some((sl) => sl.type === type)

const pickedNone = (type: string, choices: ServiceChoices): boolean => {
  const key = slotPickKey(type)
  return Object.hasOwn(choices, key) && choices[key] === SLOT_NONE
}

/** The slot selection in selectProvider's terms (a candidate provides `@slot:<type>` v1). */
function slotSelection(type: string, plugins: readonly SlotPlugin[], choices: ServiceChoices): ProviderSelection {
  const key = slotPickKey(type)
  const asProviders = plugins.map((p): ServicePlugin => (declaresSlot(p, type) ? { id: p.id, services: { provides: { [key]: 1 } } } : { id: p.id }))
  return selectProvider(key, asProviders, choices)
}

/** The plugin that draws slots of `type` in this project, or null: none declares it, it is off, or several and no valid pick. */
export function selectSlotProvider(type: string, plugins: readonly SlotPlugin[], choices: ServiceChoices): string | null {
  if (pickedNone(type, choices)) return null
  const sel = slotSelection(type, plugins, choices)
  return sel.ok ? sel.provider : null
}

/** One row per slot type some plugin of the set provides, sorted by type (plain data, sent over IPC). */
export function slotStatus(plugins: readonly SlotPlugin[], choices: ServiceChoices): SlotPickStatus[] {
  const types = new Set<string>()
  for (const p of plugins) for (const sl of Array.isArray(p.slots) ? p.slots : []) types.add(sl.type)
  return [...types].sort().map((type): SlotPickStatus => {
    const candidates = plugins.filter((p) => declaresSlot(p, type)).map((p) => p.id)
    if (pickedNone(type, choices)) return { type, candidates, selected: SLOT_NONE }
    const sel = slotSelection(type, plugins, choices)
    return { type, candidates, selected: sel.ok ? sel.provider : null }
  })
}
