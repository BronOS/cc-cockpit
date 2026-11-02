// Plugin services: the one rule for "which plugin answers service X in this project" and the
// problems it can have. Pure and shared on purpose: the host registry (runtime, src/host) and main
// (Plugins page warnings) both call these over the same list of plugins, so a warning on the page
// and the error a call throws cannot disagree. Neither keeps its own copy of the rule.
import type { PluginManifest } from './manifest'

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
      const sel = selectProvider(u.service, plugins, choices, { id: p.id, version: u.version })
      if (!sel.ok) problems.push(sel.problem)
    }
    return { id: p.id, provides, uses, problems }
  })
  const services = [...names].sort().map((service): ServiceInfo => {
    const sel = selectProvider(service, plugins, choices)
    return { service, candidates: providersOf(service, plugins), selected: sel.ok ? sel.provider : null }
  })
  return { plugins: statuses, services }
}
