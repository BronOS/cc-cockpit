// What the settings overlay (design §6) does in main: projects and plugins.
// Plain TypeScript over injected pieces (registry, installer, plugin settings store), so
// unit tests drive it with fakes; src/main/index.ts wires the real ones and router.ts exposes it
// over IPC (`settings.*`), where the sender's window is resolved before any of this runs.
//
// Authority and decisions:
//  - The data is app-wide (projects, plugins), so any project window may change it. The
//    renderer only ever names ids (a project id, a plugin id); main looks
//    each up in its own tables and takes manifests, argv, URLs and paths from its own records.
//  - A project that has a window cannot be relinked or removed from here: its tabs, host and
//    overlays are live, and a record deleted under a running window would be recreated by the next
//    save. Close the window first. (Relink is further limited to projects whose folder is gone,
//    the case it exists for.)
//  - A plugin's app-wide settings are validated here against the manifest's schema (validate.ts:
//    no regexes, no code), whatever the renderer's form thought. The renderer's form has no
//    validator of its own (its ajv would need 'unsafe-eval'); main's answer is the authority.
//  - Secret fields (plugin-settings.ts) are stored encrypted under `setting:app:<field>` in the
//    plugin's secret store, by main itself (no ctx.secrets rate limit or key cap); the renderer only
//    ever learns whether each one is set.
//  - The global values of a plugin's project fields (design-next §5.2) are edited here too, on the
//    plugin's global page: `app.json` › `pluginProjectDefaults[pluginId]`, secret ones under
//    `setting:projectDefault:<field>`. A save is checked alone (what a project with no overrides
//    gets) and merged with every open project's overrides, and refused naming the first project it
//    would make invalid. Only the projects whose effective values changed hear of it.
import type { MarketplaceView, PluginAppSettingsView, PluginSettingsSaveResult, PluginView, SettingsProject } from '../../shared/ipc'
import type { ProjectRecord, ProjectView } from '../../shared/types'
import { seesAllSessions } from '../../shared/manifest'
import { checkMarketplaceUrl } from '../marketplace/fetch-index'
import type { MarketplaceService } from '../marketplace/marketplace-service'
import { buildMarketplaceView, repoChangeFrom, resolveMarketplace, type MarketplaceViewInput } from '../marketplace/marketplace-view'
import { offAppWide } from '../plugins/enablement'
import type { InstalledPlugin, PluginInstaller } from '../plugins/installer'
import type { PluginEntry } from '../plugins/plugin-index'
import { isPlainObject } from '../../shared/guards'
import { appSettingKey, projectDefaultSettingKey } from '../secrets/plugin-secrets'
import { checkFormSettings, effectiveProjectValues, saveSettingsForm, settingsViewOf, type SecretSettingsStore } from './plugin-settings'

/** The slice of ProjectRegistry the settings use. */
export interface SettingsProjects {
  list(): ProjectView[]
  get(id: string): ProjectView | undefined
  relink(id: string, newPath: string): ProjectView
  forget(id: string): void
  update(id: string, mutate: (record: ProjectRecord) => void): void
}

export interface SettingsDeps {
  projects: SettingsProjects
  /** A window shows this project right now (main's window table). */
  hasWindow(projectId: string): boolean
  /** Open or focus the window of a folder (WindowManager.openPath). */
  openProjectPath(path: string): void
  /** Native folder dialog parented to a window; the chosen path, or undefined when cancelled. */
  pickFolder(windowId: number, title: string): Promise<string | undefined>
  plugins: Pick<PluginInstaller, 'list' | 'get' | 'install' | 'link' | 'update' | 'uninstall' | 'applyRevocations'>
  /** The marketplace indexes (fetch, cache, revocation lookups). */
  marketplace: Pick<MarketplaceService, 'list' | 'refresh' | 'revocationFor' | 'revocationWarnings' | 'prune'>
  /** Store the configured index URLs (`app.json` › `marketplaces`); already checked here. */
  setMarketplaceUrls(urls: string[]): void
  /** `app.json` › `pluginRepos`: the git URL each id was last installed from, kept past an uninstall. `set` is on disk when it returns, or throws. */
  pluginRepos: { get(pluginId: string): string | undefined; set(pluginId: string, repo: string): void }
  /** Take a plugin id out of every project's enabled list, on disk when it returns, or throw (a repo change must not start new code unasked). */
  disableEverywhere(pluginId: string): void
  /** Some project still lists this id as on, or may: a record that cannot be read counts (ProjectRegistry.pluginMayBeEnabled). */
  enabledInAProject(pluginId: string): boolean
  /** `app.json` › `pluginSettings[pluginId]`, as stored. */
  appPluginSettings: { get(pluginId: string): unknown; set(pluginId: string, value: Record<string, unknown>): void }
  /**
   * `app.json` › `disabledBundled`: `get` as stored (user-writable, so anything), `set` stores the
   * cleaned list (an empty one removes the key).
   */
  bundledOff: { get(): unknown; set(ids: string[]): void }
  /**
   * A bundled plugin's "Off in all projects" flipped: restart the open hosts whose project it changes
   * (the ones whose own switch has it on), as a per-project toggle restarts its host.
   */
  bundledOffChanged(pluginId: string): Promise<void>
  /** Plugin settings changed: tell every open host (HostManager.settingsChanged per window). */
  pluginSettingsChanged(): Promise<void>
  /** Where secret fields are stored (PluginSecrets; it also updates the hosts' decrypted cache). */
  secrets: SecretSettingsStore
  /** `app.json` › `pluginProjectDefaults[pluginId]`: the global values of the plugin's project fields, `get` as stored. */
  projectDefaults: { get(pluginId: string): unknown; set(pluginId: string, value: Record<string, unknown>): void }
  /** The projects with a window now (their hosts run): a global save is checked against, and told to, these. */
  openProjectIds(): string[]
  /**
   * What the plugin's host in the project gets now (index.ts hostSettingsOf, as text, secrets
   * included: it never leaves main), so a global save tells only the projects it changed.
   */
  settingsFingerprint(projectId: string, pluginId: string): string
  /** One plugin's settings changed in one project: push them to it (HostManager.settingsChanged). */
  projectSettingsChanged(projectId: string, pluginId: string): Promise<void>
}

const MAX_MARKETPLACE_URLS = 20

export class SettingsService {
  constructor(private readonly deps: SettingsDeps) {}

  // -------------------------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------------------------

  projects(): SettingsProject[] {
    return this.deps.projects.list().map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      missing: p.missing,
      open: this.deps.hasWindow(p.id)
    }))
  }

  openProject(id: unknown): void {
    const project = this.project(id)
    if (project.missing) throw new Error('the project folder is missing; relink it first')
    this.deps.openProjectPath(project.path)
  }

  /**
   * Point a project whose folder is gone at a new one. Its saved tabs are dropped (a Claude
   * session is stored under the folder it ran in, so `--resume` from elsewhere would not find
   * it). The project is not opened: the user opens it from the list.
   */
  async relinkProject(windowId: number, id: string): Promise<boolean> {
    this.assertRelinkable(id)
    const path = await this.deps.pickFolder(windowId, 'Choose the new folder')
    if (path === undefined) return false
    // The dialog is open for as long as the user takes: look again.
    this.assertRelinkable(id)
    this.deps.projects.relink(id, path)
    this.deps.projects.update(id, (r) => {
      r.tabs = []
    })
    return true
  }

  removeProject(id: unknown): void {
    const project = this.project(id)
    if (this.deps.hasWindow(project.id)) throw new Error('the project has a window; close it first')
    this.deps.projects.forget(project.id)
  }

  private project(id: unknown): ProjectView {
    const project = typeof id === 'string' ? this.deps.projects.get(id) : undefined
    if (!project) throw new Error('unknown project')
    return project
  }

  private assertRelinkable(id: string): void {
    const project = this.project(id)
    if (!project.missing) throw new Error('the project folder is not missing')
    if (this.deps.hasWindow(id)) throw new Error('the project has a window; close it first')
  }

  // -------------------------------------------------------------------------------------------
  // Plugins
  // -------------------------------------------------------------------------------------------

  plugins(): PluginView[] {
    return this.deps.plugins.list().map((p) => this.pluginView(p))
  }

  async installPlugin(url: unknown, tag: unknown): Promise<PluginView> {
    if (typeof url !== 'string' || typeof tag !== 'string') throw new Error('give a git URL and a tag')
    // The installer validates URL and tag (installer.ts) before any git process starts.
    return this.pluginView(await this.deps.plugins.install(url.trim(), tag.trim(), undefined, (entry) => this.rememberRepo(entry)))
  }

  /**
   * Record where a git plugin came from, for the warning when a listing later names another repository.
   * Before the record is written (a restart starts whatever plugins.json lists), and on disk by then;
   * a write that fails throws and refuses the install. No write when it already says this. An uninstall
   * catches the throw (uninstallPlugin).
   */
  private rememberRepo(entry: PluginEntry): void {
    if (entry.source.kind === 'git' && this.deps.pluginRepos.get(entry.id) !== entry.source.url) {
      this.deps.pluginRepos.set(entry.id, entry.source.url)
    }
  }

  async linkPlugin(windowId: number): Promise<boolean> {
    const folder = await this.deps.pickFolder(windowId, 'Choose the plugin folder')
    if (folder === undefined) return false
    await this.deps.plugins.link(folder)
    return true
  }

  async updatePlugin(id: unknown, tag: unknown): Promise<PluginView> {
    if (typeof id !== 'string' || typeof tag !== 'string') throw new Error('give the plugin and a tag')
    return this.pluginView(await this.deps.plugins.update(id, tag.trim()))
  }

  async uninstallPlugin(id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('give the plugin')
    // The record is the last evidence of what ran here: history that lost a write earlier (before it
    // was durable) is corrected now, or reinstalling the older repo would skip the repo-change check.
    // Best effort: uninstall is the way out of a bad or revoked plugin and plugins.json does not depend
    // on app.json. A read-only app.json (EACCES, or a newer schemaVersion after a downgrade) loads as
    // defaults, so every plugin looks uncorrected, and refusing here blocked uninstalling all of them
    // (review finding). The cost is the older-repo case above, only after a write already failed once.
    await this.deps.plugins.uninstall(id, (entry) => {
      try {
        this.rememberRepo(entry)
      } catch (err) {
        console.warn(`uninstall of ${entry.id}: repository history not updated: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
  }

  /**
   * "Off in all projects" for a bundled plugin (design: bundled reviewer and editor plan, "App-wide
   * off"). Only a bundled plugin has it: a third-party one is per project by design (§5), and the
   * record would be ignored for it anyway (enablement.ts offAppWide). Setting what is already stored
   * changes nothing and restarts nothing.
   */
  async setBundledOff(id: unknown, off: unknown): Promise<void> {
    if (typeof id !== 'string' || typeof off !== 'boolean') throw new Error('give the plugin and on or off')
    const plugin = this.deps.plugins.get(id)
    if (!plugin) throw new Error('unknown plugin')
    if (plugin.source.kind !== 'bundled') throw new Error(`${id} is not built in; turn it off per project under This project`)
    const stored = this.deps.bundledOff.get()
    // app.json is user-writable: keep only the strings, once each.
    const current = [...new Set(Array.isArray(stored) ? stored.filter((x): x is string => typeof x === 'string') : [])]
    if (current.includes(id) === off) return
    this.deps.bundledOff.set(off ? [...current, id] : current.filter((x) => x !== id))
    await this.deps.bundledOffChanged(id)
  }

  // -------------------------------------------------------------------------------------------
  // Marketplace
  // -------------------------------------------------------------------------------------------

  private marketplaceInput(): MarketplaceViewInput {
    const { marketplace, plugins, pluginRepos } = this.deps
    return {
      states: marketplace.list(),
      installed: plugins.list(),
      lastRepo: (id) => pluginRepos.get(id),
      enabledInAProject: (id) => this.deps.enabledInAProject(id),
      revocationFor: (q) => marketplace.revocationFor(q),
      revocationWarnings: (q) => marketplace.revocationWarnings(q)
    }
  }

  /** A snapshot of the saved lists. It starts no fetch (the Plugins tab reads it too); the Marketplace page refreshes a stale index itself. */
  marketplace(): MarketplaceView {
    return buildMarketplaceView(this.marketplaceInput())
  }

  async refreshMarketplace(): Promise<MarketplaceView> {
    await this.deps.marketplace.refresh()
    // onRefreshed only queues applyRevocations; waiting for it (same queue) makes the view show a
    // plugin this very refresh revoked.
    await this.deps.plugins.applyRevocations().catch(() => {})
    return buildMarketplaceView(this.marketplaceInput())
  }

  /** Replace the index list. A refused URL refuses the whole call and stores nothing. */
  async setMarketplaceUrls(urls: unknown): Promise<MarketplaceView> {
    if (!Array.isArray(urls) || urls.length > MAX_MARKETPLACE_URLS) throw new Error('give a list of index URLs')
    const out: string[] = []
    for (const u of urls) {
      const checked = checkMarketplaceUrl(u)
      if ('problem' in checked) throw new Error(`${typeof u === 'string' ? u : 'index URL'}: ${checked.problem}`)
      if (!out.includes(checked.url)) out.push(checked.url)
    }
    this.deps.setMarketplaceUrls(out)
    // A removed index loses its listing and cache; the default and recorded indexes stay (authorities).
    this.deps.marketplace.prune()
    return this.refreshMarketplace()
  }

  /**
   * The listing `indexUrl` + `id` as main's own validated state has it, and only if its button would
   * be `action`. Repo, tag and commit come from here, never from the renderer.
   */
  private marketplaceEntry(indexUrl: unknown, id: unknown, action: 'install' | 'update', expected: unknown) {
    if (typeof indexUrl !== 'string' || typeof id !== 'string') throw new Error('give the index and the plugin')
    const found = resolveMarketplace(this.marketplaceInput()).entries.find((e) => e.view.indexUrl === indexUrl && e.view.id === id)
    if (!found) throw new Error('unknown marketplace entry')
    if (found.view.action !== action) {
      const at = found.view.installedVersion
      if (found.view.note === undefined && action === 'update' && at !== undefined) {
        throw new Error(`${id} is at version ${at} now; ${found.view.version} is not an update`)
      }
      throw new Error(found.view.note ?? `${id} cannot be ${action === 'install' ? 'installed' : 'updated'} from this index`)
    }
    // The confirmation showed one repo and commit; the index may have changed in main since (a refresh
    // in another window). Never install what the user was not shown: refuse, the page re-renders.
    const x = expected as { repo?: unknown; commit?: unknown } | null | undefined
    if (x?.repo !== found.entry.repo || x?.commit !== found.entry.commit) {
      throw new Error(`${id} changed in the marketplace since you opened this prompt; review it again`)
    }
    return found
  }

  async installMarketplace(indexUrl: unknown, id: unknown, expected: unknown): Promise<PluginView> {
    const { entry: e } = this.marketplaceEntry(indexUrl, id, 'install', expected)
    return this.pluginView(
      await this.deps.plugins.install(
        e.repo,
        e.tag,
        { commit: e.commit, id: e.id, version: e.version, marketplace: indexUrl as string },
        // Only once the clone passed every check: a refused install must leave the projects' switches
        // alone. Before it is recorded, and on disk by then: the new code must not start in a project
        // that still has the id on (an uninstall keeps `enabledPlugins`) with the old repo's data, in
        // this run or after a crash. A write that fails throws, and nothing is installed.
        // Asked here, in the installer's queue, not taken from the view above: an install and an uninstall
        // queued ahead of this one can change the id's repository history while the clone waits.
        // History only after the switches: written first, a failed disable would leave it saying this
        // repo, and a retry would see no change and start the plugin with the old switches on.
        // The listing is asked again first, as updateMarketplace does: an index that revoked this commit
        // during the clone and was then removed took its revocation with it (prune: a pending install is
        // no authority yet), so the installer's own check only sees "unknown" by now (review finding).
        (entry) => {
          this.marketplaceEntry(indexUrl, id, 'install', expected)
          if (repoChangeFrom(e.id, e.repo, this.marketplaceInput()) !== undefined) this.deps.disableEverywhere(e.id)
          this.rememberRepo(entry)
        }
      )
    )
  }

  async updateMarketplace(indexUrl: unknown, id: unknown, expected: unknown): Promise<PluginView> {
    const { entry: e } = this.marketplaceEntry(indexUrl, id, 'update', expected)
    return this.pluginView(
      await this.deps.plugins.update(
        e.id,
        e.tag,
        { commit: e.commit, id: e.id, version: e.version, marketplace: indexUrl as string },
        // The check above ran before this waited its turn: an update queued ahead may have installed
        // something newer, and the installer would then silently downgrade to this one (review finding).
        // Asked again in the queue, with the same rules as the button; a changed answer refuses.
        () => void this.marketplaceEntry(indexUrl, id, 'update', expected)
      )
    )
  }

  /**
   * Store a plugin's app-wide settings. Validated against the manifest's `settings.app` schema
   * (defaults applied); a failure stores nothing and lists the reasons. `secrets` sets or clears
   * secret fields (encrypted first: a keychain that refuses also stores nothing). On success every
   * open host hears of it (running plugins get the new values, one that was disabled for invalid
   * settings starts).
   */
  async savePluginSettings(id: unknown, values: unknown, secrets?: unknown): Promise<PluginSettingsSaveResult> {
    const plugin = typeof id === 'string' ? this.deps.plugins.get(id) : undefined
    if (!plugin?.manifest) throw new Error('unknown plugin')
    const schema = plugin.manifest.contributes?.settings?.app
    if (schema === undefined) throw new Error(`${plugin.id} declares no app-wide settings`)
    return saveSettingsForm({
      pluginId: plugin.id,
      schema,
      values,
      secrets,
      keyOf: appSettingKey,
      store: this.deps.secrets,
      save: (value) => this.deps.appPluginSettings.set(plugin.id, value),
      announce: () => this.deps.pluginSettingsChanged()
    })
  }

  /**
   * Store the global values of a plugin's project fields (design-next §5.2), what every project
   * that does not override a field gets. Checked alone (defaults applied, as stored) and merged
   * with each open project's overrides; a failure stores nothing, and one that an open project's
   * overrides cause names the project. `secrets` sets or clears the global value of secret project
   * fields. On success every open project whose effective values changed hears of it.
   */
  async saveProjectDefaults(id: unknown, values: unknown, secrets?: unknown): Promise<PluginSettingsSaveResult> {
    const plugin = typeof id === 'string' ? this.deps.plugins.get(id) : undefined
    if (!plugin?.manifest) throw new Error('unknown plugin')
    const schema = plugin.manifest.contributes?.settings?.project
    if (schema === undefined) throw new Error(`${plugin.id} declares no project settings`)
    const before = new Map<string, string>()
    return saveSettingsForm({
      pluginId: plugin.id,
      schema,
      values,
      secrets,
      keyOf: projectDefaultSettingKey,
      store: this.deps.secrets,
      refuse: (value) => {
        for (const projectId of this.deps.openProjectIds()) {
          const project = this.deps.projects.get(projectId)
          if (!project) continue
          const overrides = isPlainObject(project.pluginSettings) && Object.hasOwn(project.pluginSettings, plugin.id) ? project.pluginSettings[plugin.id] : undefined
          // A project with no overrides gets the global value alone, which was checked already.
          if (overrides === undefined) continue
          const checked = checkFormSettings(schema, effectiveProjectValues(value, overrides))
          if (!checked.ok) {
            // Overrides that are not a plain object are damaged (hand-edited file): no global value fixes that.
            if (!isPlainObject(overrides)) return [`the stored settings of the project ${project.name} for this plugin are damaged (fix or clear them in the project's settings)`]
            return [`the project ${project.name} overrides fields this value does not fit (change it there first): ${checked.errors.join('; ')}`]
          }
        }
        return []
      },
      beforeWrite: () => {
        for (const projectId of this.deps.openProjectIds()) before.set(projectId, this.deps.settingsFingerprint(projectId, plugin.id))
      },
      save: (value) => this.deps.projectDefaults.set(plugin.id, value),
      announce: async () => {
        for (const projectId of this.deps.openProjectIds()) {
          // A project opened during the save has no before-state: it may have started on the old values.
          if (before.get(projectId) === this.deps.settingsFingerprint(projectId, plugin.id)) continue
          await this.deps.projectSettingsChanged(projectId, plugin.id)
        }
      }
    })
  }

  /**
   * The global values of the plugin's project fields as its global page shows them (stored values
   * with defaults, secret fields as set or not); undefined when it declares no project settings.
   */
  pluginProjectDefaults(id: unknown): PluginAppSettingsView | undefined {
    const plugin = typeof id === 'string' ? this.deps.plugins.get(id) : undefined
    if (!plugin?.manifest) throw new Error(`unknown plugin: ${String(id)}`)
    const schema = plugin.manifest.contributes?.settings?.project
    if (schema === undefined) return undefined
    return settingsViewOf(schema, this.deps.projectDefaults.get(plugin.id), (f) => this.deps.secrets.hasSetting(plugin.id, projectDefaultSettingKey(f)))
  }

  /**
   * The plugin's app-wide settings as the Plugins page shows them (stored values with defaults,
   * secret fields as set or not); undefined when it declares none. `ccc plugin config` reads this
   * (main/settings/plugin-config.ts), so both show the same thing.
   */
  pluginAppSettings(id: unknown): PluginAppSettingsView | undefined {
    const plugin = typeof id === 'string' ? this.deps.plugins.get(id) : undefined
    if (!plugin?.manifest) throw new Error(`unknown plugin: ${String(id)}`)
    return this.appSettingsView(plugin)
  }

  private appSettingsView(p: InstalledPlugin): PluginAppSettingsView | undefined {
    const schema = p.manifest?.contributes?.settings?.app
    if (schema === undefined) return undefined
    return settingsViewOf(schema, this.deps.appPluginSettings.get(p.id), (f) => this.deps.secrets.hasSetting(p.id, appSettingKey(f)))
  }

  private pluginView(p: InstalledPlugin): PluginView {
    const view: PluginView = {
      id: p.id,
      name: p.manifest?.name ?? p.id,
      version: p.version,
      source:
        p.source.kind === 'git'
          ? { kind: 'git', url: p.source.url, tag: p.source.tag }
          : p.source.kind === 'linked'
            ? { kind: 'linked', path: p.source.path }
            : { kind: 'bundled' },
      state: p.state
    }
    const appSettings = this.appSettingsView(p)
    if (appSettings !== undefined) view.appSettings = appSettings
    // The html page (design-next §5.4) shows under the form; whether it can talk to the plugin here is
    // asked by the page itself (`settingsPage.info`, the window's project).
    if (p.state.ok && p.manifest?.contributes?.settings?.page?.scopes.includes('app') === true) view.settingsPage = true
    if (p.source.kind === 'bundled') view.offInAllProjects = offAppWide(p, this.deps.bundledOff.get())
    if (seesAllSessions(p.manifest)) view.seesAllSessions = true
    return view
  }
}
