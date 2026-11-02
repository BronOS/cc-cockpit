// Loads and activates the plugins of one plugin host (one project window).
//
// Each plugin is isolated from the others as far as one Node process allows: a `require` that
// throws, a module without `activate`, an `activate` that throws or rejects, and one that does not
// settle within 10 s each mark THAT plugin errored (main shows ⚠ on its panel icons) while the rest
// activate normally. Activations run concurrently, so one slow plugin does not hold back the
// others' 10 s budgets. What one process cannot isolate (a synchronous endless loop, a crash) is
// the host manager's job: it restarts the process.
//
// The plugin folders and `main` paths come from main; nothing here derives a path from plugin input.
// `main` was checked to resolve inside the plugin folder when the manifest loaded
// (src/main/plugins/validate.ts) and is NOT re-checked here: a linked dev folder can swap it for a
// symlink out of the folder afterwards, and that is accepted. Containment is manifest hygiene, not
// a boundary: once required, plugin code can `require` any path it likes anyway.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { JsonValue, PluginContext, PluginModule } from '../sdk/types'
import type { PluginManifest } from '../shared/manifest'
import { errorText, toError } from '../shared/error-text'
import { isSettingsRecord } from './ctx/settings'
import { ServiceRegistry } from './services'

export const ACTIVATE_TIMEOUT_MS = 10_000
export const DEACTIVATE_TIMEOUT_MS = 5_000

/** What main sends for each plugin to run. */
export interface HostPluginSpec {
  id: string
  /** Absolute plugin folder. */
  dir: string
  /** Plugin-relative path of the host entry (manifest `main`). */
  main: string
  // Everything below is decided by main, never derived from plugin input: the host takes these
  // paths and lists as given (CLAUDE.md: main is the only authority).
  /** The project folder: the default cwd of `ctx.exec`. */
  projectDir: string
  /** `ctx.dataDir`: `<data>/plugin-data/<projectId>/<pluginId>/` (created on first use). */
  dataDir: string
  /** The plugin's KV file (`ctx.storage`), inside `dataDir`. */
  storageFile: string
  /** Command ids the manifest declares; `ctx.commands.register` accepts only these. */
  commands: string[]
  /** Panel ids the manifest declares; `ctx.badge` and `ctx.panels.*` accept only these. */
  panels: string[]
  /**
   * The ids in `panels` whose manifest `kind` is `webview`: the only ones `ctx.webview` drives, and
   * the ones `ctx.panels.post` refuses (no page of the plugin's to receive it). Absent is none.
   */
  webviewPanels?: string[]
  /** CLI command names the manifest declares (`contributes.cli`); `ctx.cli.register` accepts only these. */
  cli?: string[]
  /**
   * The manifest's `services` field as main validated it (`ctx.services` accepts only these names).
   * Absent is none.
   */
  services?: PluginManifest['services']
  /**
   * Set by `parsePluginSpecs`, never sent by main: why this plugin's spec cannot run (a malformed
   * `services` field). The loader marks only this plugin errored; the rest of the batch activates.
   */
  invalid?: string
  /** The validated settings with defaults applied (main checked them against the schemas). */
  settings: { project: Record<string, JsonValue>; app: Record<string, JsonValue> }
}

/** Validate main's plugin list; main built it, but a malformed one must fail loudly, not half-run. */
export function parsePluginSpecs(params: unknown): HostPluginSpec[] {
  const plugins = (params as { plugins?: unknown } | null)?.plugins
  if (!Array.isArray(plugins)) throw new Error('activate: plugins must be an array')
  return plugins.map((p: unknown, i) => {
    const { id, dir, main, projectDir, dataDir, storageFile, commands, panels, webviewPanels, cli, services, settings } = (p ?? {}) as Record<
      string,
      unknown
    >
    if (typeof id !== 'string' || typeof dir !== 'string' || typeof main !== 'string') {
      throw new Error(`activate: plugin ${i} must have string id, dir and main`)
    }
    if (typeof projectDir !== 'string' || typeof dataDir !== 'string' || typeof storageFile !== 'string') {
      throw new Error(`activate: plugin ${i} must have string projectDir, dataDir and storageFile`)
    }
    if (!Array.isArray(commands) || commands.some((c) => typeof c !== 'string')) {
      throw new Error(`activate: plugin ${i} commands must be an array of strings`)
    }
    // Absent means none (a plugin without panels); present, it must be a list of ids.
    if (panels !== undefined && (!Array.isArray(panels) || panels.some((c) => typeof c !== 'string'))) {
      throw new Error(`activate: plugin ${i} panels must be an array of strings`)
    }
    if (webviewPanels !== undefined && (!Array.isArray(webviewPanels) || webviewPanels.some((c) => typeof c !== 'string'))) {
      throw new Error(`activate: plugin ${i} webviewPanels must be an array of strings`)
    }
    // Same rule: absent is none (a spec from before contributes.cli existed).
    if (cli !== undefined && (!Array.isArray(cli) || cli.some((c) => typeof c !== 'string'))) {
      throw new Error(`activate: plugin ${i} cli must be an array of strings`)
    }
    // Absent is none (a plugin without services, or a spec from before the field existed). Main
    // validated the manifest; this only keeps a malformed spec from reaching the registry. Unlike
    // the fields above (main builds those itself), this one is the plugin's own manifest content, so
    // a bad one errors that plugin alone: the batch is validated before anything activates, and a
    // throw here would keep every plugin of the project from running.
    const parsed = services === undefined ? undefined : parseServicesField(services)
    const { project, app } = (settings ?? {}) as Record<string, unknown>
    if (!isSettingsRecord(project) || !isSettingsRecord(app)) {
      throw new Error(`activate: plugin ${i} settings must have project and app objects`)
    }
    return {
      id,
      dir,
      main,
      projectDir,
      dataDir,
      storageFile,
      commands: commands as string[],
      panels: (panels as string[] | undefined) ?? [],
      webviewPanels: (webviewPanels as string[] | undefined) ?? [],
      cli: (cli as string[] | undefined) ?? [],
      ...(parsed?.services !== undefined ? { services: parsed.services } : {}),
      ...(parsed?.invalid !== undefined ? { invalid: parsed.invalid } : {}),
      settings: { project, app }
    }
  })
}

/**
 * The project's provider picks main sends with `activate` (`serviceProviders: { [service]: pluginId }`).
 * Absent is none; a malformed value fails like a malformed plugin list.
 */
export function parseServiceProviders(params: unknown): Record<string, string> {
  const raw = (params as { serviceProviders?: unknown } | null)?.serviceProviders
  if (raw === undefined) return {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.values(raw).some((v) => typeof v !== 'string')) {
    throw new Error('activate: serviceProviders must be an object of strings')
  }
  return { ...(raw as Record<string, string>) }
}

/**
 * `{ provides?: {name: int}, uses?: {name: int} }`: the shape only; main checked names and ranges.
 * Other keys are ignored, not refused (main refuses them in the manifest; one that still arrives,
 * from an older main or a later field, must not stop the plugin). A malformed provides or uses
 * gives `invalid` instead of services.
 */
function parseServicesField(v: unknown): { services?: NonNullable<PluginManifest['services']>; invalid?: string } {
  const invalid = { invalid: 'invalid spec: services must be an object of provides/uses maps of integers' }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return invalid
  const out: NonNullable<PluginManifest['services']> = {}
  for (const key of ['provides', 'uses'] as const) {
    if (!Object.hasOwn(v, key)) continue
    const map: unknown = (v as Record<string, unknown>)[key]
    if (map === undefined) continue
    if (typeof map !== 'object' || map === null || Array.isArray(map)) return invalid
    if (Object.values(map).some((n) => !Number.isInteger(n))) return invalid
    out[key] = map as Record<string, number>
  }
  return { services: out }
}

export type PluginRunState = { id: string; state: 'active' } | { id: string; state: 'errored'; error: string }

export interface LoaderOptions {
  makeContext(spec: HostPluginSpec): PluginContext
  /** Load a module by absolute path (tests pass a fake; default: Node's require). */
  requireModule?: (absPath: string) => unknown
  activateTimeoutMs?: number
  deactivateTimeoutMs?: number
  /**
   * Called when a plugin is done for good: its activate() failed, or its deactivate() ran (or was
   * skipped because it never activated). The host drops the plugin's schedules, running children
   * and open files here. Idempotent on the caller's side; a throw is logged and ignored.
   */
  release?: (spec: HostPluginSpec) => void
  /**
   * Forget the modules loaded from a plugin folder, so the next require reads the files again
   * (reload of a linked dev plugin). Default: clearRequireCache on Node's cache.
   */
  clearModules?: (dir: string) => void
  log?: (message: string) => void
  /** A line in a plugin's own log (ctx.log): dropped service emits and throwing event listeners. */
  pluginLog?: (pluginId: string, text: string) => void
}

interface Loaded {
  spec: HostPluginSpec
  module?: PluginModule
  state: PluginRunState
  /**
   * The activation under way or done (never rejects). `state` reads 'active' until it settles, so
   * a deactivate that arrives meanwhile (the window closed, a restart) awaits this first.
   */
  activation?: Promise<PluginRunState>
  /** `activation` has settled (set in its own chain, so it is true by the time an awaiter resumes). */
  settled?: boolean
}

/** A reload under way: its promise settles with the new copy's activation. */
interface Reloading {
  promise: Promise<PluginRunState>
  settle(state: PluginRunState): void
}

/**
 * Node's own require, created relative to the plugin's folder so its `node_modules` resolve (a
 * bare `require(variable)` in this bundled file would go through the bundler's shim instead).
 */
export function nodeRequire(absPath: string): unknown {
  return createRequire(join(resolve(absPath, '..'), 'package.json'))(absPath)
}

/**
 * Drop from `cache` (Node's require cache by default) every module whose file sits inside `dir`.
 * Only that: the cache holds this host's own modules, Node's built-ins' wrappers and every other
 * plugin's code too, and a path built from plugin data must never make the host forget those
 * (the next require of a core module would load a second copy, with state of its own). Keys are
 * real paths, so `dir` is realpath'd first (a linked folder reached through a symlink would match
 * nothing); the comparison is by whole path segments (`/p/foo` is not inside `/p/fo`). Returns the
 * number of entries dropped.
 *
 * Known limit (dev reload only): a dependency that lives outside the plugin folder (a parent or
 * monorepo `node_modules`, a symlinked file pointing elsewhere) keeps its cached copy across
 * reloads; restart the host (reopen the window) to pick those changes up.
 */
export function clearRequireCache(dir: string, cache?: Record<string, unknown>): number {
  let root: string
  try {
    root = realpathSync(dir)
  } catch {
    root = resolve(dir)
  }
  // A filesystem root would match everything: refuse it outright.
  if (resolve(root, '..') === root) return 0
  const target = cache ?? createRequire(join(root, 'package.json')).cache
  const prefix = root.endsWith(sep) ? root : root + sep
  let dropped = 0
  for (const key of Object.keys(target)) {
    if (key.startsWith(prefix)) {
      delete target[key]
      dropped++
    }
  }
  return dropped
}

/** Resolve with `p`, or reject with `message` after `ms`; the timer never outlives the race. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolvePromise(v)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(toError(err))
      }
    )
  })
}

/** `module.exports = { activate }`, or a transpiled ES module's `exports.default`. */
function asPluginModule(mod: unknown): PluginModule | undefined {
  const candidates = [mod, (mod as { default?: unknown } | null | undefined)?.default]
  for (const c of candidates) {
    if ((typeof c === 'object' || typeof c === 'function') && c !== null) {
      if (typeof (c as { activate?: unknown }).activate === 'function') return c as PluginModule
    }
  }
  return undefined
}

export class PluginLoader {
  private readonly loaded = new Map<string, Loaded>()
  /** Reloads in progress by plugin id: covers the gap between unload and the new activation. */
  private readonly reloading = new Map<string, Reloading>()
  /**
   * The host's one service registry (ctx.services of every plugin goes through it). The loader
   * owns it because it owns the lifecycle the registry depends on: declarations are set before
   * activate, implementations dropped at every release, and activations awaited by calls.
   */
  readonly services: ServiceRegistry
  private readonly requireModule: (absPath: string) => unknown
  private readonly activateTimeoutMs: number
  private readonly deactivateTimeoutMs: number
  private readonly log: (message: string) => void
  private readonly clearModules: (dir: string) => void

  constructor(private readonly options: LoaderOptions) {
    this.requireModule = options.requireModule ?? nodeRequire
    this.clearModules = options.clearModules ?? ((dir) => void clearRequireCache(dir))
    this.activateTimeoutMs = options.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS
    this.deactivateTimeoutMs = options.deactivateTimeoutMs ?? DEACTIVATE_TIMEOUT_MS
    this.log = options.log ?? ((m) => console.error(m))
    this.services = new ServiceRegistry({
      activationOf: (id) => this.activationOf(id),
      isActivating: (id) => this.isActivating(id),
      log: options.pluginLog
    })
  }

  /**
   * The plugin's activation for service calls: during a reload, the NEW copy's (unload deletes the
   * entry before activateAll adds it back, and a call in that window must wait, not fail as
   * missing); else the loaded entry's; undefined when the plugin is not loaded.
   */
  activationOf(id: string): Promise<PluginRunState> | undefined {
    return this.reloading.get(id)?.promise ?? this.loaded.get(id)?.activation
  }

  /** True while `activationOf(id)` is unsettled, the whole reload included. */
  isActivating(id: string): boolean {
    if (this.reloading.has(id)) return true
    const l = this.loaded.get(id)
    return l !== undefined && l.activation !== undefined && l.settled !== true
  }

  /** Every plugin's state, in activation order. */
  states(): PluginRunState[] {
    return [...this.loaded.values()].map((l) => l.state)
  }

  /** Load and activate `specs` (ids already loaded are skipped). Never rejects. */
  async activateAll(specs: readonly HostPluginSpec[]): Promise<PluginRunState[]> {
    const fresh = specs.filter((s) => !this.loaded.has(s.id))
    return Promise.all(
      fresh.map((s) => {
        // activate() registers the entry synchronously, before its first await.
        const raw = this.activate(s)
        const entry = this.loaded.get(s.id)
        const activation = raw.then((state) => {
          if (entry) entry.settled = true
          return state
        })
        if (entry) entry.activation = activation
        return activation
      })
    )
  }

  /**
   * Reload one plugin in place (a linked dev folder changed): deactivate the running copy (its ctx
   * is released), forget its modules, activate from the files as they are now. The other plugins
   * of the host are not touched. Never rejects.
   */
  async reload(spec: HostPluginSpec): Promise<PluginRunState> {
    // A second reload of the same id while one runs chains onto it (main serialises reloads, but a
    // late one must not leave the first's waiters on a promise nobody settles).
    const previous = this.reloading.get(spec.id)
    if (previous) await previous.promise
    let settle!: (state: PluginRunState) => void
    const promise = new Promise<PluginRunState>((r) => (settle = r))
    const reloading: Reloading = { promise, settle }
    this.reloading.set(spec.id, reloading)
    // The new declarations at once (a reload may change them): a call resolved during the gap is
    // routed by what the new copy will provide, and waits for it.
    this.services.setSpec(spec)
    let state: PluginRunState = { id: spec.id, state: 'errored', error: 'activation failed' }
    try {
      await this.unload(spec.id, { keepSpec: true })
      try {
        this.clearModules(spec.dir)
      } catch (err) {
        this.log(`plugin ${spec.id}: clearing its modules failed: ${errorText(err)}`)
      }
      const [s] = await this.activateAll([spec])
      if (s) state = s
      return state
    } finally {
      if (this.reloading.get(spec.id) === reloading) this.reloading.delete(spec.id)
      settle(state)
    }
  }

  /** Deactivate one plugin and forget it (its manifest became invalid). No-op when not loaded. */
  async unload(id: string, options: { keepSpec?: boolean } = {}): Promise<void> {
    const l = this.loaded.get(id)
    // Its declarations go at once (unless a reload replaces them): calls to it fail as missing
    // from now on, rather than waiting on a plugin that is leaving.
    if (!options.keepSpec) this.services.removeSpec(id)
    if (!l) return
    this.loaded.delete(id)
    await this.deactivate(l)
  }

  /** Call every active plugin's `deactivate` (each capped), concurrently. Never rejects. */
  async deactivateAll(): Promise<void> {
    const all = [...this.loaded.values()]
    this.loaded.clear()
    for (const l of all) this.services.removeSpec(l.spec.id)
    await Promise.all(all.map((l) => this.deactivate(l)))
  }

  private async activate(spec: HostPluginSpec): Promise<PluginRunState> {
    const entry: Loaded = { spec, state: { id: spec.id, state: 'active' } }
    this.loaded.set(spec.id, entry)
    // Before any plugin code runs: another plugin's call made while this one activates must find
    // it as a provider and wait for it, and this plugin's own provide/use check against it.
    this.services.setSpec(spec)
    const fail = (error: string): PluginRunState => {
      this.log(`plugin ${spec.id}: ${error}`)
      entry.state = { id: spec.id, state: 'errored', error }
      // An errored plugin gets no deactivate(), and a half-run activate() may already have
      // scheduled work or registered commands: take them back now.
      this.release(spec)
      return entry.state
    }
    if (!isAbsolute(spec.dir) || typeof spec.main !== 'string' || spec.main === '') {
      return fail('bad plugin location')
    }
    if (spec.invalid !== undefined) return fail(spec.invalid)
    let loadedModule: PluginModule | undefined
    try {
      loadedModule = asPluginModule(this.requireModule(resolve(spec.dir, spec.main)))
    } catch (err) {
      return fail(`loading ${spec.main} failed: ${errorText(err)}`)
    }
    if (!loadedModule) return fail(`${spec.main} does not export an activate() function`)
    const mod = loadedModule
    entry.module = mod
    let ctx: PluginContext
    try {
      ctx = this.options.makeContext(spec)
    } catch (err) {
      return fail(`cannot create its context: ${errorText(err)}`)
    }
    const seconds = Math.round(this.activateTimeoutMs / 1000)
    // The root of the service call chain: a call this activate makes (or a provider method makes
    // for it) back into this still-activating plugin is a cycle, failed at once, not a 10 s hang.
    const frame = this.services.beginActivate(spec.id)
    try {
      // Through a then: a synchronous throw in activate becomes a rejection like an async one.
      // What activate returns is ignored: a plugin offers an API to others with ctx.services.
      await withTimeout(
        Promise.resolve().then(() => frame.run(() => mod.activate(ctx))),
        this.activateTimeoutMs,
        `activate() did not finish within ${seconds} s`
      )
      return entry.state
    } catch (err) {
      // A late-settling activate is left to finish on its own; the plugin stays errored and its
      // eventual return value is ignored like any other.
      return fail(`activate() failed: ${errorText(err)}`)
    } finally {
      // Settled or timed out: nothing waits on this activate any more, whatever it left running.
      frame.end()
    }
  }

  private async deactivate(l: Loaded): Promise<void> {
    // A deactivate request can arrive while activate() is still running (main closes the window or
    // restarts the host right after asking to activate): wait for it to settle rather than tear down
    // half a setup, or skip a plugin whose late success would then leak what it set up. Capped by
    // main, which kills the host after its deactivate grace regardless.
    await l.activation
    try {
      // An errored plugin never finished activating: its deactivate would run against half a setup.
      if (l.state.state !== 'active' || !l.module?.deactivate) return
      const mod = l.module
      try {
        await withTimeout(
          Promise.resolve().then(() => mod.deactivate?.()),
          this.deactivateTimeoutMs,
          `deactivate() did not finish within ${Math.round(this.deactivateTimeoutMs / 1000)} s`
        )
      } catch (err) {
        this.log(`plugin ${l.spec.id}: ${errorText(err)}`)
      }
    } finally {
      this.release(l.spec)
    }
  }

  private release(spec: HostPluginSpec): void {
    // Its implementations and subscriptions go first, so no call reaches a copy that is gone.
    this.services.release(spec.id)
    try {
      this.options.release?.(spec)
    } catch (err) {
      this.log(`plugin ${spec.id}: releasing its context failed: ${errorText(err)}`)
    }
  }
}
