// Plugin install, link, update and uninstall (design §5 Lifecycle; plan Task 24).
//
// install: clone a git URL at a tag into a staging folder inside `<data>/plugins/`, validate the
//   manifest, rename the folder to `<data>/plugins/<id>@<version>/` (same filesystem, so the move
//   is one atomic rename) and record the source in plugins.json.
// link:    a local dev folder; validated and recorded, never copied and never deleted.
// update:  clone the new tag side by side, switch the index entry, let the hosts reload, then
//   remove the old folder.
// uninstall: drop the index entry, the folder and the plugin's secrets; per-project plugin data
//   stays. Secrets go on purpose: they are credentials, and a sign-in outliving the plugin the user
//   removed would be a surprise (a reinstall signs in again).
//
// Untrusted input everywhere: the URL and tag come from the user (or a pasted link), the repo
// content from whoever controls it. So: argv-only git with a validated URL behind `--`, no remote
// helpers or unexpected transports, no prompts, a hard timeout; the manifest is validated before
// any of it is used in a path; a marketplace install also pins the exact commit, checked in the
// staging folder, because a tag can move after the index listed it; every folder this module deletes is recomputed from a validated
// id and version and checked to sit directly in `<data>/plugins/`. A failure at any step leaves
// nothing behind: no staging folder, no install folder, no index entry.
//
// Pure Node: git runs through an injectable runner; themes go to an injected registry.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { errorText } from '../../shared/error-text'
import { cloneArgs, gitEnv, gitTagProblem, gitUrlProblem } from '../../shared/git-source'
import { isPlainObject } from '../../shared/guards'
import {
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_PATTERN,
  PLUGIN_VERSION_PATTERN,
  RESERVED_PLUGIN_ID_MESSAGE,
  isReservedPluginId,
  type PluginManifest
} from '../../shared/manifest'
import type { Theme } from '../../shared/theme'
import type { Env } from '../env/login-env'
import { liveChildren } from '../child-registry'
import { killChild } from '../kill-child'
import { within } from '../path-within'
import { dataPaths, pluginInstallDir } from '../paths'
import type { BundledPluginSpec } from './bundled'
import { type CliClaim, cliLossReason, settleCliNames } from './cli-ownership'
import {
  GIT_COMMIT_PATTERN,
  MAX_MARKETPLACE_URL_LENGTH,
  type PluginEntry,
  type PluginIndex,
  type PluginRevocation,
  type PluginSource,
  type PluginState
} from './plugin-index'
import { insideReadProblemText, loadManifest, readInside } from './validate'

// ---------------------------------------------------------------------------------------------
// git runner
// ---------------------------------------------------------------------------------------------

export interface GitResult {
  code: number | null
  /** The start of stdout (capped): what a query like `rev-parse` prints; a clone prints nothing here. */
  stdout: string
  /** The tail of stderr (capped), for the error shown to the user. */
  stderr: string
}

export interface GitRunOptions {
  cwd: string
  env: Env
  timeoutMs: number
}

/** Runs `git <args>` (argv, no shell); rejects when git cannot be started or times out. */
export type GitRunner = (args: string[], options: GitRunOptions) => Promise<GitResult>

export const GIT_TIMEOUT_MS = 120_000
const STDERR_CAP = 16 * 1024
export const GIT_STDOUT_CAP = 64 * 1024

/**
 * Default runner. `detached: true` (setsid): git and the ssh it starts get a new process group with
 * no controlling terminal, so a timeout kills all of them, and ssh cannot open /dev/tty to ask for
 * a passphrase (when the app runs from a terminal with `npm run dev`, it would otherwise prompt
 * there and hang the install). stdin is closed for the same reason.
 */
export const defaultGitRunner: GitRunner = (args, { cwd, env, timeoutMs }) =>
  new Promise((resolvePromise, reject) => {
    // Tracked for app quit: quitting mid-clone ends the 2 min timer below, not git and its ssh.
    const child = liveChildren.track(spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }))
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (err: Error | null, code: number | null = null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolvePromise({ code, stdout, stderr })
    }
    const timer = setTimeout(() => {
      // pid is undefined when the spawn itself failed; its 'error' settles, nothing to kill.
      if (child.pid !== undefined) killChild(child)
      finish(new Error(`git timed out after ${Math.round(timeoutMs / 1000)} s`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      // Keep the head, and keep reading past the cap: a full pipe would stall git until the timeout.
      if (stdout.length < GIT_STDOUT_CAP) stdout = (stdout + chunk).slice(0, GIT_STDOUT_CAP)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Keep the tail: git prints the actual error last.
      stderr = (stderr + chunk).slice(-STDERR_CAP)
    })
    child.on('error', (err: NodeJS.ErrnoException) =>
      finish(err.code === 'ENOENT' ? new Error('git is not installed or not on PATH') : err)
    )
    child.on('close', (code) => finish(null, code))
  })

// ---------------------------------------------------------------------------------------------
// Installer
// ---------------------------------------------------------------------------------------------

/** Every refusal and failure the user should see; `reasons` lists manifest errors one per line. */
export class PluginInstallError extends Error {
  constructor(
    message: string,
    readonly reasons: string[] = []
  ) {
    super(reasons.length > 0 ? `${message}: ${reasons.join('; ')}` : message)
    this.name = 'PluginInstallError'
  }
}

/**
 * What a marketplace index says this install must be. The index is untrusted and a tag can move, so
 * the clone is compared with all of it in the staging folder, before anything reaches `plugins/`.
 */
export interface InstallPin {
  commit: string
  id: string
  version: string
  /** The URL of the index that listed it, recorded on the plugin. */
  marketplace: string
}

/** Why the clone is not what `pin` promised (naming both sides), or null when it matches. */
function pinProblem(pin: InstallPin | undefined, manifest: PluginManifest, commit: string, recorded?: string): string | null {
  if (pin === undefined) return null
  // What is written must survive a reload: parseEntry drops a longer value, and the plugin would lose its index.
  if (pin.marketplace.length > MAX_MARKETPLACE_URL_LENGTH) return `the marketplace index URL is longer than ${MAX_MARKETPLACE_URL_LENGTH} characters`
  // Another index listing the same public commit must not take over revocation from the recorded one.
  if (recorded !== undefined && pin.marketplace !== recorded) return `${manifest.id} is recorded from another marketplace index (${recorded}), not ${pin.marketplace}`
  if (commit !== pin.commit) return `the tag is at commit ${commit}, but the marketplace index pins ${pin.commit}`
  if (manifest.id !== pin.id) return `the tag contains plugin "${manifest.id}", but the marketplace index lists "${pin.id}"`
  if (manifest.version !== pin.version) return `the tag contains version ${manifest.version}, but the marketplace index lists ${pin.version}`
  return null
}

/** The slice of ThemeService the installer uses. */
export interface ThemeRegistry {
  register(input: unknown): Theme
  unregister(id: string): void
}

export interface InstalledPlugin extends PluginEntry {
  /** The folder the plugin runs from. */
  dir: string
  /** Set when the manifest validated (state ok). */
  manifest?: PluginManifest
  /** Registered (namespaced) theme ids. */
  themes: string[]
}

export interface InstallerOptions {
  dataDir: string
  index: PluginIndex
  themes: ThemeRegistry
  /** The env git runs with (the login env; awaited so an install right at launch gets PATH). */
  env: () => Env | Promise<Env>
  runGit?: GitRunner
  gitTimeoutMs?: number
  /**
   * Plugin `id` was updated (index now names the new folder) or uninstalled (no entry): every
   * running plugin host must reload or drop it. Resolves once no host runs code from the previous
   * folder, which is then deleted. Task 25's host manager provides it; until then (and whenever no
   * host is running) the default resolves at once and the old folder goes immediately.
   * Also called after an install or a link (index already holds the entry): a project may have the
   * plugin enabled from before an uninstall, and its open host must start it now.
   */
  reloadHosts?: (id: string) => Promise<void>
  /**
   * A folder is about to be linked under this id, in the queue and before it is recorded (every way
   * of linking comes through here: Settings, `ccc plugin link`). Index.ts forgets the id's repository
   * history: it no longer says what ran under the id. A throw refuses the link.
   */
  beforeLink?: (id: string) => void
  /**
   * The set of plugins changed (loaded, installed, linked, updated, uninstalled). The dev watcher
   * re-reads the linked folders from `list()` here.
   */
  onChange?: () => void
  /**
   * The plugins shipped with the app (bundled.ts): indexed at every load, validated like any other,
   * never copied and never uninstalled. Absent or empty = none (and the entries a previous run
   * recorded for them are dropped).
   */
  bundled?: readonly BundledPluginSpec[]
  /**
   * Does an index with authority over this plugin revoke this commit? Asked for every git plugin at
   * load, before an install or update is committed, and each time a plugin is handed out (view). So it
   * must be cheap and must not throw. Absent = nothing is ever revoked. Undefined
   * = unknown (an index with authority has no usable copy): a revocation already recorded stays.
   * `recordedSource`: the index that issued the revocation already recorded, which can withdraw it.
   */
  revocation?: (plugin: { id: string; commit: string; marketplace?: string; recordedSource?: string }) => PluginRevocation | null | undefined
  /** Plugins that just became revoked (at load or in applyRevocations), for one notice to the user. */
  onRevoked?: (plugins: { id: string; revoked: PluginRevocation }[]) => void
  /** The plugin's `ctx.secrets` store (plugin-secrets.ts), emptied on uninstall. */
  secrets?: { removePlugin(pluginId: string): void }
  log?: (message: string) => void
}

/** Staging folders live in `<data>/plugins/` (same filesystem as the target) under this prefix. */
const STAGING_PREFIX = '.tmp-'
const MAX_THEME_BYTES = 256 * 1024

export class PluginInstaller {
  private readonly pluginsDir: string
  private readonly runGit: GitRunner
  private readonly gitTimeoutMs: number
  private readonly reloadHosts: (id: string) => Promise<void>
  private readonly log: (message: string) => void
  /** Per plugin id: the validated manifest and the theme ids registered for it. */
  private readonly loaded = new Map<string, { manifest?: PluginManifest; themes: string[] }>()
  /** Every operation runs after the previous one: two installs of one id must not race to rename. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: InstallerOptions) {
    this.pluginsDir = resolve(dataPaths(options.dataDir).pluginsDir)
    this.runGit = options.runGit ?? defaultGitRunner
    this.gitTimeoutMs = options.gitTimeoutMs ?? GIT_TIMEOUT_MS
    this.reloadHosts = options.reloadHosts ?? (async () => {})
    this.log = options.log ?? ((m) => console.warn(m))
  }

  list(): InstalledPlugin[] {
    return this.options.index.list().map((e) => this.view(e))
  }

  get(id: string): InstalledPlugin | undefined {
    const e = this.options.index.get(id)
    return e ? this.view(e) : undefined
  }

  /**
   * At launch: remove staging folders a crash left behind, validate every recorded plugin's
   * manifest (the folder may have been edited, or a linked one moved) and register the themes of
   * the valid ones. A plugin that fails stays in the index with the reason.
   */
  load(): Promise<void> {
    return this.serial(async () => {
      await this.sweepStaging()
      await this.syncBundled()
      // Clash order, so a bundled plugin's commands are known before any other plugin claims a name.
      const newlyRevoked: { id: string; revoked: PluginRevocation }[] = []
      for (const entry of this.clashOrder()) {
        const state = await this.refreshEntry(entry)
        // The state on disk says whether the user was already told in an earlier run.
        if (!state.ok && state.revoked && (entry.state.ok || !entry.state.revoked)) newlyRevoked.push({ id: entry.id, revoked: state.revoked })
      }
      await this.reconcileCliClashes()
      this.changed()
      this.notifyRevoked(newlyRevoked)
    })
  }

  /**
   * The marketplace indexes changed: check every git plugin against them again. `revalidate` skips
   * git plugins, so this does its own refresh and host reloads. A revoked plugin stops here and no
   * manifest stays in `loaded` for it (refreshEntry), or reconcileCliClashes would read its failed
   * state as a former name clash and set it ok again. A revocation the index withdrew brings the
   * plugin back the same way. Serial, like every other change to the set.
   *
   * This is what records a revocation and tells the user. Keeping the code from running before it gets
   * here is view's job: every lookup change queues this run (onRefreshed, or the settings call after a
   * prune), so a plugin view hid is always recorded and announced, once.
   */
  applyRevocations(): Promise<void> {
    return this.serial(async () => {
      const newlyRevoked: { id: string; revoked: PluginRevocation }[] = []
      const reload = new Set<string>()
      let touched = false
      for (const entry of this.clashOrder()) {
        if (entry.source.kind !== 'git') continue
        const found = this.revocationOf(entry)
        const was = entry.state.ok ? undefined : entry.state.revoked
        if (found?.reason === was?.reason && found?.source === was?.source) continue
        touched = true
        // What refreshEntry settled on, not `found`: an index may change while it awaits the manifest.
        const state = await this.refreshEntry(entry)
        const now = state.ok ? undefined : state.revoked
        // Only the wording moved: it was not running and still must not.
        if ((now !== undefined) === (was !== undefined)) continue
        reload.add(entry.id)
        if (now !== undefined) newlyRevoked.push({ id: entry.id, revoked: now })
      }
      if (!touched) return
      // A revoked plugin's `ccc` names are free now, and one that came back may claim its own again.
      for (const id of await this.reconcileCliClashes()) reload.add(id)
      for (const id of reload) await this.afterHostsReload(id)
      this.changed()
      this.notifyRevoked(newlyRevoked)
    })
  }

  /**
   * A linked plugin's folder changed (dev reload, Task 29): check its manifest again, move its
   * version, themes and ok/invalid state with the files. Resolves with the new state, or undefined
   * when `id` is not a linked plugin (unlinked meanwhile; git installs never change in place).
   */
  revalidate(id: string): Promise<PluginState | undefined> {
    return this.serial(async () => {
      const entry = this.options.index.get(id)
      if (!entry || entry.source.kind !== 'linked') return undefined
      const state = await this.refreshEntry(entry)
      // The dev watcher reloads this plugin's hosts itself; another one demoted or recovered by
      // the change is not its business.
      await this.reconcileAndReload(id)
      return this.options.index.get(id)?.state ?? state
    })
  }

  /**
   * Clone `url` at `tag`, validate (against `pin` when given), move into place and record it.
   * `beforeRecord` runs once the clone passed every check and is in place, with no await between it
   * and the record: a restart starts whatever plugins.json lists, so what decides whether a project
   * starts it must be on disk first, and a check made in it still holds when the record is written.
   * It gets the entry about to be recorded (a git URL says which id it is only once cloned). It never
   * runs for a refused install, and when it throws nothing is installed.
   */
  install(url: string, tag: string, pin?: InstallPin, beforeRecord?: (entry: PluginEntry) => void): Promise<InstalledPlugin> {
    return this.serial(async () => {
      this.checkWritable()
      const source = this.checkSource(url, tag)
      // A marketplace pin names the id before anything is cloned; a plain git URL says it only in
      // staging, checked first below, still before anything reaches plugins/.
      if (pin !== undefined && isReservedPluginId(pin.id)) throw new PluginInstallError(RESERVED_PLUGIN_ID_MESSAGE)
      const staged = await this.cloneAndValidate(source, (m, commit) => {
        if (isReservedPluginId(m.id)) return RESERVED_PLUGIN_ID_MESSAGE
        const mismatch = pinProblem(pin, m, commit) ?? this.revokedProblem(m.id, commit, pin?.marketplace)
        if (mismatch !== null) return mismatch
        const existing = this.options.index.get(m.id)
        if (existing) {
          if (existing.source.kind === 'bundled') return `${m.id} is built in; it updates with the app`
          return existing.source.kind === 'linked'
            ? `${m.id} is already linked from ${existing.source.path}; unlink it first`
            : `${m.id} is already installed (version ${existing.version}); update it instead`
        }
        return this.cliClash(m)
      })
      const entry: PluginEntry = {
        id: staged.manifest.id,
        version: staged.manifest.version,
        source,
        state: { ok: true },
        commit: staged.commit,
        ...(pin ? { marketplace: pin.marketplace } : {})
      }
      const dir = await this.commit(staged, entry, beforeRecord)
      this.loaded.set(entry.id, { manifest: staged.manifest, themes: await this.registerThemes(entry.id, dir, staged.manifest) })
      // An uninstall keeps the plugin in the projects' enabled lists: a reinstall must start it in
      // the open windows that still have it on, as enabling would (reloadHosts).
      await this.activate(entry.id)
      this.changed()
      return this.view(this.options.index.get(entry.id) ?? entry)
    })
  }

  /**
   * What `link(folder)` would link, without changing anything: the resolved folder, its manifest
   * data and whether this very folder is already linked. `ccc plugin link` shows these in a
   * confirm dialog before it links, so it needs them first. Throws what `link` would throw, except
   * for a folder that is already linked (`alreadyLinked`: nothing to link again, only to enable).
   */
  async inspectLink(folder: string): Promise<{ id: string; name: string; version: string; dir: string; alreadyLinked: boolean }> {
    const { real, manifest, alreadyLinked } = await this.checkLink(folder)
    return { id: manifest.id, name: manifest.name, version: manifest.version, dir: real, alreadyLinked }
  }

  /**
   * Record a local folder (plugin development). Nothing is copied; uninstall never deletes it.
   * `expectedId`: the id a person was shown and allowed (`ccc plugin link`); a folder whose manifest
   * now names another plugin is refused, since it changed while the confirm was open.
   * `keepLinked`: this same folder already linked under that id is no error, it stays as it is
   * (`ccc plugin link` decides that here, in the serial queue, not from the check before its
   * dialog: the folder may have been linked in Settings while the dialog was open).
   */
  link(folder: string, expectedId?: string, options: { keepLinked?: boolean } = {}): Promise<InstalledPlugin> {
    return this.serial(async () => {
      const { real, manifest, alreadyLinked } = await this.checkLink(folder, expectedId)
      if (alreadyLinked) {
        // Kept as it is, nothing written: also with a read-only plugins.json, as before.
        const existing = this.options.index.get(manifest.id)
        if (options.keepLinked === true && existing) return this.view(existing)
        throw new PluginInstallError(`${manifest.id} is already installed (version ${manifest.version}); uninstall it first`)
      }
      this.checkWritable()
      const entry: PluginEntry = { id: manifest.id, version: manifest.version, source: { kind: 'linked', path: real }, state: { ok: true } }
      this.options.beforeLink?.(manifest.id)
      this.options.index.put(entry)
      this.loaded.set(manifest.id, { manifest, themes: await this.registerThemes(manifest.id, real, manifest) })
      // A relink after an uninstall: same as install above.
      await this.activate(manifest.id)
      this.changed()
      return this.view(entry)
    })
  }

  /** The checks of `link`; `alreadyLinked` is this same folder under the same id. */
  private async checkLink(
    folder: string,
    expectedId?: string
  ): Promise<{ real: string; manifest: PluginManifest; alreadyLinked: boolean }> {
    if (typeof folder !== 'string' || !isAbsolute(folder)) throw new PluginInstallError('the folder must be an absolute path')
    let real: string
    try {
      real = await fs.realpath(folder)
    } catch {
      throw new PluginInstallError(`folder not found: ${folder}`)
    }
    // A folder inside plugins/ is managed by this installer: an orphan sweep or a later install
    // of the same id@version would delete what the user thinks of as their dev folder.
    if (within(this.pluginsDir, real) || within(await this.realPluginsDir(), real)) {
      throw new PluginInstallError('cannot link a folder inside the app\'s plugins directory')
    }
    const result = await loadManifest(real)
    if (!result.ok) throw new PluginInstallError('invalid plugin', result.errors)
    const { manifest } = result
    // Before the existing-entry check: linking a copy of a bundled plugin must say why, not "uninstall it first".
    if (isReservedPluginId(manifest.id)) throw new PluginInstallError(RESERVED_PLUGIN_ID_MESSAGE)
    if (expectedId !== undefined && manifest.id !== expectedId) {
      throw new PluginInstallError(`the plugin in ${real} changed while waiting (it is ${manifest.id} now, not ${expectedId})`)
    }
    const existing = this.options.index.get(manifest.id)
    if (existing) {
      if (existing.source.kind === 'linked' && existing.source.path === real) return { real, manifest, alreadyLinked: true }
      throw new PluginInstallError(`${manifest.id} is already installed (version ${existing.version}); uninstall it first`)
    }
    const clash = this.cliClash(manifest)
    if (clash !== null) throw new PluginInstallError(clash)
    return { real, manifest, alreadyLinked: false }
  }

  /**
   * Install `tag` of an installed plugin's repo side by side, switch the index entry to it, let the
   * hosts reload, then remove the old folder. `pin` is checked like install's. An update without one
   * stays in the same repo, so the plugin keeps its recorded index: dropping it would also drop that
   * index's say over revoking the plugin. `beforeRecord` is install's: this queue may have moved the
   * plugin on since the caller decided on this update, and when it throws nothing changes.
   */
  update(id: string, tag: string, pin?: InstallPin, beforeRecord?: (entry: PluginEntry) => void): Promise<InstalledPlugin> {
    return this.serial(async () => {
      this.checkWritable()
      const old = this.options.index.get(id)
      if (!old) throw new PluginInstallError(`${id} is not installed`)
      if (old.source.kind === 'bundled') throw new PluginInstallError(`${id} is built in; it updates with the app`)
      if (old.source.kind !== 'git') throw new PluginInstallError(`${id} is linked from a folder; it updates from there`)
      // A git record under a reserved id predates the reservation (or was hand-written): it no longer loads.
      if (isReservedPluginId(id)) throw new PluginInstallError(RESERVED_PLUGIN_ID_MESSAGE)
      const source = this.checkSource(old.source.url, tag)
      const staged = await this.cloneAndValidate(source, (m, commit) => {
        if (m.id !== id) return `the tag contains plugin "${m.id}", not "${id}"`
        const mismatch = pinProblem(pin, m, commit, old.marketplace) ?? this.revokedProblem(id, commit, pin?.marketplace ?? old.marketplace)
        if (mismatch !== null) return mismatch
        // Case-insensitive: on default APFS 1.0.0-rc and 1.0.0-RC are the same folder.
        if (m.version.toLowerCase() === old.version.toLowerCase()) return `${id} is already at version ${old.version}`
        return this.cliClash(m)
      })
      const marketplace = pin?.marketplace ?? old.marketplace
      const entry: PluginEntry = {
        id,
        version: staged.manifest.version,
        source,
        state: { ok: true },
        commit: staged.commit,
        ...(marketplace !== undefined ? { marketplace } : {})
      }
      const dir = await this.commit(staged, entry, beforeRecord)
      // Old ones out first: the theme ids are usually the same and register refuses a taken id.
      this.unregisterThemes(id)
      this.loaded.set(id, { manifest: staged.manifest, themes: await this.registerThemes(id, dir, staged.manifest) })
      await this.activate(id)
      await this.removeInstallDir(id, old.version)
      this.changed()
      return this.view(this.options.index.get(id) ?? entry)
    })
  }

  /**
   * Remove the index entry, the themes, the secrets and (for a git install) the folder. Plugin data
   * stays. `beforeRemove` runs in the queue while the record still says what was installed; when it
   * throws nothing is removed.
   */
  uninstall(id: string, beforeRemove?: (entry: PluginEntry) => void): Promise<void> {
    return this.serial(async () => {
      this.checkWritable()
      const entry = this.options.index.get(id)
      if (!entry) throw new PluginInstallError(`${id} is not installed`)
      // Shipped inside the app: it can only be switched off per project, and load() would index it again anyway.
      if (entry.source.kind === 'bundled') throw new PluginInstallError(`${id} is built in; turn it off in the project's plugin settings instead`)
      beforeRemove?.(entry)
      // Entry first: a crash before the folder is gone leaves a harmless orphan folder, never an
      // entry pointing at nothing.
      this.options.index.remove(id)
      this.unregisterThemes(id)
      this.loaded.delete(id)
      // A plugin that lost a command name to this one gets it back.
      const flipped = await this.reconcileCliClashes()
      // The watcher of a linked folder closes first: nothing is left to reload.
      this.changed()
      await this.afterHostsReload(id)
      await this.reloadFlipped(flipped, id)
      // After the hosts let go of it: no copy of the plugin is left to write a secret back in, and a
      // set still waiting on its encrypt is refused when it resolves (PluginSecrets.removePlugin).
      // A failed write is logged, not thrown: the plugin is already gone from the index, and the
      // folder must still be removed.
      try {
        this.options.secrets?.removePlugin(id)
      } catch (err) {
        this.log(`uninstall ${id}: removing its secrets failed: ${errorText(err)}`)
      }
      if (entry.source.kind === 'git') await this.removeInstallDir(id, entry.version)
    })
  }

  // -------------------------------------------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    // The queue itself never rejects, so one failed install does not fail every later call.
    this.queue = run.catch(() => {})
    return run
  }

  private checkWritable(): void {
    if (this.options.index.readOnly) {
      throw new PluginInstallError('plugins.json cannot be written (see the log); plugins cannot be changed')
    }
  }

  /** The enforced revocation of a recorded plugin; a linked or bundled one, or one with no commit, has none. */
  private revocationOf(entry: PluginEntry): PluginRevocation | null {
    if (entry.source.kind !== 'git' || entry.commit === undefined) return null
    const recorded = entry.state.ok ? undefined : entry.state.revoked
    const found = this.options.revocation?.({
      id: entry.id,
      commit: entry.commit,
      ...(entry.marketplace !== undefined ? { marketplace: entry.marketplace } : {}),
      ...(recorded !== undefined ? { recordedSource: recorded.source } : {})
    })
    // No index to ask (cache lost or corrupt, fetch failed): a failed fetch never clears a
    // revocation, only a good index without the entry does.
    if (found === undefined) return recorded ?? null
    return found
  }

  /** Why this commit may not be installed, on the git URL path too; the index it would be recorded from counts. */
  private revokedProblem(id: string, commit: string, marketplace: string | undefined): string | null {
    const revoked = this.options.revocation?.({ id, commit, ...(marketplace !== undefined ? { marketplace } : {}) })
    return revoked ? `${id} at commit ${commit} is revoked by ${revoked.source}: ${revoked.reason}` : null
  }

  /**
   * The new entry and its manifest are in place: settle the command names and reload the hosts. A
   * revocation that came in since the clone was checked needs nothing here: view hides the plugin from
   * the reload, so an update's old version goes and the new one does not start, and the queued
   * applyRevocations records it and tells the user.
   */
  private async activate(id: string): Promise<void> {
    await this.reconcileAndReload(id)
    await this.afterHostsReload(id)
  }

  /**
   * Stop a plugin if it is revoked by now; every revoked state is recorded here. Synchronous on
   * purpose: with no await between the look and the state change, no host can read an ok state in
   * between.
   */
  private stopIfRevoked(id: string): PluginRevocation | null {
    const entry = this.options.index.get(id)
    const revoked = entry ? this.revocationOf(entry) : null
    if (revoked === null) return null
    this.unregisterThemes(id)
    // No manifest stays, or reconcileCliClashes would read the failed state as a former name clash.
    this.loaded.set(id, { themes: [] })
    const state = revokedState(revoked)
    this.options.index.setState(id, state)
    this.log(`plugin ${id} disabled: ${state.reason}`)
    return revoked
  }

  private notifyRevoked(plugins: { id: string; revoked: PluginRevocation }[]): void {
    if (plugins.length === 0) return
    try {
      this.options.onRevoked?.(plugins)
    } catch (err) {
      this.log(`plugins: revocation listener failed: ${errorText(err)}`)
    }
  }

  private checkSource(url: string, tag: string): Extract<PluginSource, { kind: 'git' }> {
    const problem = gitUrlProblem(url) ?? gitTagProblem(tag)
    if (problem !== null) throw new PluginInstallError(problem)
    return { kind: 'git', url, tag }
  }

  private dirOf(entry: PluginEntry): string {
    if (entry.source.kind === 'linked') return entry.source.path
    if (entry.source.kind === 'bundled') {
      // From the allowlist, not the stored path: plugins.json is user-writable, and this folder is
      // read and served. An entry the allowlist does not know cannot get here (syncBundled drops it).
      const spec = this.options.bundled?.find((b) => b.id === entry.id)
      if (!spec) throw new PluginInstallError(`${entry.id} is not a bundled plugin of this app`)
      return spec.dir
    }
    return this.installDir(entry.id, entry.version)
  }

  /**
   * `<data>/plugins/<id>@<version>`, re-checked here although callers pass validated values:
   * this path is renamed onto and removed recursively.
   */
  private installDir(id: string, version: string): string {
    const dir = resolve(pluginInstallDir(this.options.dataDir, id, version))
    if (
      id.length > PLUGIN_ID_MAX_LENGTH ||
      !PLUGIN_ID_PATTERN.test(id) ||
      !PLUGIN_VERSION_PATTERN.test(version) ||
      dirname(dir) !== this.pluginsDir ||
      basename(dir) !== `${id}@${version}`
    ) {
      throw new PluginInstallError(`refusing plugin folder for ${JSON.stringify(id)}@${JSON.stringify(version)}`)
    }
    return dir
  }

  private async realPluginsDir(): Promise<string> {
    try {
      return await fs.realpath(this.pluginsDir)
    } catch {
      return this.pluginsDir
    }
  }

  /**
   * Clone into a fresh staging folder and validate what came out. `refuse` gets the valid manifest
   * and the cloned commit, and returns a reason to stop (already installed, wrong id, pin mismatch).
   * On any failure the staging folder is removed before the error propagates.
   */
  private async cloneAndValidate(
    source: { url: string; tag: string },
    refuse: (manifest: PluginManifest, commit: string) => string | null
  ): Promise<{ staging: string; repo: string; manifest: PluginManifest; commit: string }> {
    await fs.mkdir(this.pluginsDir, { recursive: true, mode: 0o700 })
    const staging = await fs.mkdtemp(join(this.pluginsDir, STAGING_PREFIX))
    try {
      const repo = join(staging, 'repo')
      const env = gitEnv(await this.options.env())
      let result: GitResult
      try {
        result = await this.runGit(cloneArgs(source.url, source.tag, repo), {
          cwd: staging,
          env,
          timeoutMs: this.gitTimeoutMs
        })
      } catch (err) {
        throw new PluginInstallError(`git clone failed: ${errorText(err)}`)
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)
        throw new PluginInstallError(`git clone failed (exit ${String(result.code)})${detail ? `: ${detail}` : ''}`)
      }
      // Before .git goes: afterwards nothing can say which commit these files are.
      const commit = await this.readCommit(repo, env)
      // The install folder is the plugin's files, nothing else: the pinned version lives in the
      // index, and cc-plugin:// (Task 28) or the dev watcher have no business seeing git internals.
      await fs.rm(join(repo, '.git'), { recursive: true, force: true })
      const validation = await loadManifest(repo)
      if (!validation.ok) throw new PluginInstallError('invalid plugin', validation.errors)
      const reason = refuse(validation.manifest, commit)
      if (reason !== null) throw new PluginInstallError(reason)
      return { staging, repo, manifest: validation.manifest, commit }
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true })
      throw err
    }
  }

  /**
   * The commit a fresh clone is at. `clone --branch <tag>` leaves HEAD detached on the commit itself,
   * so an annotated tag gives the commit and not the tag object. Refusing anything else fails the
   * install: revocation matches on this value, so a plugin must not be recorded with a wrong one.
   */
  private async readCommit(repo: string, env: Env): Promise<string> {
    let result: GitResult
    try {
      result = await this.runGit(['rev-parse', '--verify', 'HEAD'], { cwd: repo, env, timeoutMs: this.gitTimeoutMs })
    } catch (err) {
      throw new PluginInstallError(`git rev-parse failed: ${errorText(err)}`)
    }
    const commit = result.stdout.trim()
    if (result.code !== 0 || !GIT_COMMIT_PATTERN.test(commit)) {
      throw new PluginInstallError(`could not read the cloned commit (git rev-parse exit ${String(result.code)})`)
    }
    return commit
  }

  /** Move a validated clone into place and record it (replacing the entry); returns its folder. */
  private async commit(
    staged: { staging: string; repo: string; manifest: PluginManifest; commit: string },
    entry: PluginEntry,
    beforeRecord?: (entry: PluginEntry) => void
  ): Promise<string> {
    try {
      const target = this.installDir(entry.id, entry.version)
      const recorded = this.options.index.get(entry.id)
      // The callers' refusals rule this out; never replace a folder the index points at.
      if (recorded?.source.kind === 'git' && recorded.version.toLowerCase() === entry.version.toLowerCase()) {
        throw new PluginInstallError(`${entry.id}@${entry.version} is already installed`)
      }
      // A folder already there is left over from a crash between the rename and the index write
      // (or a failed index write): ours, unreferenced, replaced.
      if (await exists(target)) {
        this.log(`plugins: removing unrecorded folder ${target} before installing over it`)
        await fs.rm(target, { recursive: true, force: true })
      }
      await fs.rename(staged.repo, target)
      try {
        // Asked again after the last await: the clone was checked before the rename, and a revocation
        // arriving since must not get as far as plugins.json. No await from here to the put, so one
        // arriving after it is view's to hide. beforeRecord runs here for the same reason: run before the
        // rename, its listing check went stale when an index revoked the commit and was removed during
        // these awaits. Prune takes the revocation with the index (a pending install is no authority), so
        // this check sees only "unknown" and the commit got through (review finding).
        const revoked = this.revokedProblem(entry.id, staged.commit, entry.marketplace)
        if (revoked !== null) throw new PluginInstallError(revoked)
        beforeRecord?.(entry)
        this.options.index.put(entry)
      } catch (err) {
        // Not recorded: do not leave an unreferenced folder behind a reported failure.
        await fs.rm(target, { recursive: true, force: true })
        throw err
      }
      return target
    } finally {
      await fs.rm(staged.staging, { recursive: true, force: true })
    }
  }

  private async afterHostsReload(id: string): Promise<void> {
    try {
      await this.reloadHosts(id)
    } catch (err) {
      // The index already moved on; the old folder goes anyway (a host still holding it keeps its
      // loaded code in memory, and restarts from the new entry).
      this.log(`plugins: reloading hosts for ${id} failed: ${errorText(err)}`)
    }
  }

  private async removeInstallDir(id: string, version: string): Promise<void> {
    try {
      // rm does not follow symlinks: a link inside the plugin to $HOME is unlinked, not emptied.
      await fs.rm(this.installDir(id, version), { recursive: true, force: true })
    } catch (err) {
      this.log(`plugins: could not remove the folder of ${id}@${version}: ${errorText(err)}`)
    }
  }

  /**
   * Make the index hold exactly the bundled plugins this run ships: record each allowlisted folder
   * (version from its manifest, `enabledByDefault` from the allowlist, never from the manifest),
   * drop entries a previous run recorded for a bundled plugin that is no longer shipped (or is
   * switched off by the test switch). Validation itself is refreshEntry's, like any other entry: a
   * bad bundled manifest stays in the index as a disabled plugin with the reason.
   *
   * A git or linked record holding a bundled id (a user who linked the reviewer from its own repo
   * before it shipped, or a hand-edited plugins.json) is dropped: `cockpit.*` loads only from the
   * bundled root (refreshEntry), so keeping it would leave the plugin off. Project enablement,
   * settings, storage and secrets are keyed by the id and carry over to the bundled copy. A git
   * record's folder goes with it, or nothing would ever remove it.
   */
  private async syncBundled(): Promise<void> {
    const specs = this.options.bundled ?? []
    const wanted = new Set(specs.map((s) => s.id))
    try {
      for (const e of this.options.index.list()) {
        if (e.source.kind === 'bundled' && !wanted.has(e.id)) this.options.index.remove(e.id)
      }
      for (const spec of specs) {
        const existing = this.options.index.get(spec.id)
        // Checked before a non-bundled record is dropped: with the bundled folder missing (a broken
        // package) nothing would replace the user's working copy.
        if (!(await exists(spec.dir))) {
          this.log(`bundled plugin ${spec.id} skipped: ${spec.dir} is missing`)
          if (existing?.source.kind === 'bundled') this.options.index.remove(spec.id)
          continue
        }
        if (existing && existing.source.kind !== 'bundled') {
          const from = existing.source.kind === 'linked' ? `linked from ${existing.source.path}` : `installed from ${existing.source.url}`
          this.options.index.remove(spec.id)
          this.log(`plugin ${spec.id} ${from} dropped: the app ships it; the built-in copy is used`)
          if (existing.source.kind === 'git') await this.removeInstallDir(spec.id, existing.version)
        }
        // The dropped non-bundled record's state and version must not carry into the bundled entry.
        const prior = existing?.source.kind === 'bundled' ? existing : undefined
        const result = await loadManifest(spec.dir)
        const entry: PluginEntry = {
          id: spec.id,
          // A manifest that does not load has no version; keep the last one so the entry stays valid.
          version: result.ok ? result.manifest.version : (prior?.version ?? '0.0.0'),
          source: { kind: 'bundled', path: spec.dir },
          state: prior?.state ?? { ok: true },
          ...(spec.enabledByDefault ? { enabledByDefault: true } : {})
        }
        // Every start runs this: an unchanged entry is not worth a write.
        if (prior && JSON.stringify(prior) === JSON.stringify(entry)) continue
        this.options.index.put(entry)
      }
    } catch (err) {
      // A plugins.json that cannot be written (read-only): the bundled plugins are then simply not
      // indexed this run; the rest of load() goes on.
      this.log(`indexing the bundled plugins failed: ${errorText(err)}`)
    }
  }

  /**
   * The index in clash order: bundled plugins first (the app's own commands are never displaced by
   * a plugin a person linked), then the index's insertion order (stable across restarts).
   */
  private clashOrder(): PluginEntry[] {
    // A bundled entry the allowlist does not know is skipped: syncBundled drops it, but its
    // index.remove can fail (read-only plugins.json) and dirOf would then throw out of load().
    const all = this.options.index.list().filter((e) => e.source.kind !== 'bundled' || this.options.bundled?.some((b) => b.id === e.id))
    return [...all.filter((e) => e.source.kind === 'bundled'), ...all.filter((e) => e.source.kind !== 'bundled')]
  }

  private async sweepStaging(): Promise<void> {
    let names: string[]
    try {
      names = await fs.readdir(this.pluginsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.startsWith(STAGING_PREFIX)) continue
      await fs.rm(join(this.pluginsDir, name), { recursive: true, force: true }).catch((err: unknown) => {
        this.log(`plugins: could not remove ${name}: ${errorText(err)}`)
      })
    }
  }

  /**
   * Register the plugin's themes as `<pluginId>/<themeId>` (contribution ids are namespaced at
   * runtime). A theme that cannot be read or does not validate (including a namespaced id over the
   * theme id limit) is skipped and logged; the rest of the plugin still works.
   */
  private async registerThemes(pluginId: string, dir: string, manifest: PluginManifest): Promise<string[]> {
    return this.registerRead(pluginId, await this.readThemes(pluginId, dir, manifest))
  }

  /** The reading half of registerThemes: the only part that awaits. */
  private async readThemes(pluginId: string, dir: string, manifest: PluginManifest): Promise<ReadTheme[]> {
    const read: ReadTheme[] = []
    for (const t of manifest.contributes?.themes ?? []) {
      try {
        read.push({ id: t.id, raw: await readPluginJson(dir, t.file, MAX_THEME_BYTES) })
      } catch (err) {
        this.log(`plugin ${pluginId}: theme "${t.id}" skipped: ${errorText(err)}`)
      }
    }
    return read
  }

  /**
   * The registering half of registerThemes. Synchronous, so refreshEntry can do it right after its look.
   * Themes reach the app without passing view, so this is their gate: a plugin revoked by now, not
   * recorded yet (install, or a name clash recovering), must not flip the active theme to it and back.
   */
  private registerRead(pluginId: string, themes: readonly ReadTheme[]): string[] {
    const entry = this.options.index.get(pluginId)
    if (entry && this.revocationOf(entry) !== null) return []
    const ids: string[] = []
    for (const t of themes) {
      const themeId = `${pluginId}/${t.id}`
      try {
        const input = isPlainObject(t.raw) ? { ...t.raw, id: themeId } : t.raw
        ids.push(this.options.themes.register(input).id)
      } catch (err) {
        this.log(`plugin ${pluginId}: theme "${t.id}" skipped: ${errorText(err)}`)
      }
    }
    return ids
  }

  private unregisterThemes(id: string): void {
    const l = this.loaded.get(id)
    if (!l) return
    for (const themeId of l.themes) this.options.themes.unregister(themeId)
    l.themes = []
  }

  /**
   * Why `entry` may not load under its id, or null. A reserved id loads only as a bundled entry the
   * allowlist knows: a linked folder or a hand-edited plugins.json record is refused here, at load,
   * which is the authority (the install-time refusals only give a better message earlier). dirOf
   * takes a bundled entry's folder from the allowlist, never from the record.
   */
  private reservedProblem(entry: PluginEntry): string | null {
    if (!isReservedPluginId(entry.id)) return null
    if (entry.source.kind === 'bundled' && this.options.bundled?.some((b) => b.id === entry.id)) return null
    return `${RESERVED_PLUGIN_ID_MESSAGE}; this copy (${entry.source.kind}) does not load; uninstall it`
  }

  /**
   * Validate one recorded plugin's manifest again and bring the index, the loaded view and the
   * registered themes in line with it. The folder may have been edited (a linked one moved), so a
   * plugin that fails stays in the index with the reason. Its old themes go first: a theme id is
   * usually the same before and after, and `register` refuses a taken id.
   *
   * The revocation look comes after the last await, with everything it guards published synchronously
   * behind it, and it is what records the revoked state (view only hides one not recorded yet). Only
   * reading comes first, so a revoked plugin never has its themes registered, not even for a moment:
   * the active theme would flip to it and back.
   */
  private async refreshEntry(entry: PluginEntry): Promise<PluginState> {
    const dir = this.dirOf(entry)
    const result = await loadManifest(dir)
    const reserved = this.reservedProblem(entry)
    let state: PluginState
    if (reserved !== null) {
      state = { ok: false, reason: reserved }
    } else if (!result.ok) {
      state = { ok: false, reason: `invalid plugin: ${result.errors.slice(0, 5).join('; ')}` }
    } else if (result.manifest.id !== entry.id) {
      state = { ok: false, reason: `plugin.json now has id "${result.manifest.id}", installed as "${entry.id}"` }
    } else if (entry.source.kind === 'git' && result.manifest.version !== entry.version) {
      state = { ok: false, reason: `plugin.json now has version ${result.manifest.version}, installed as ${entry.version}` }
    } else {
      state = { ok: true }
    }
    // A manifest that takes a name an earlier plugin owns is a loser from the start: deciding it
    // here avoids writing ok to the index and flipping it back in reconcileCliClashes.
    const lost = state.ok && result.ok ? this.cliLoss(entry.id, result.manifest) : null
    if (lost !== null) state = { ok: false, reason: lost }
    const themes = state.ok && result.ok ? await this.readThemes(entry.id, dir, result.manifest) : []
    // Whatever else is wrong, a revocation is what the user can act on, so it replaces any state above.
    const revoked = this.stopIfRevoked(entry.id)
    if (revoked !== null) return revokedState(revoked)
    this.unregisterThemes(entry.id)
    if (lost !== null && result.ok) {
      this.log(`plugin ${entry.id} disabled: ${lost}`)
      // The manifest stays so the plugin can win its name back (reconcileCliClashes).
      this.loaded.set(entry.id, { manifest: result.manifest, themes: [] })
    } else if (state.ok && result.ok) {
      // A linked folder's version moves with the developer's edits.
      if (result.manifest.version !== entry.version) {
        try {
          this.options.index.put({ ...entry, version: result.manifest.version, state })
        } catch (err) {
          this.log(`plugin ${entry.id}: recording version ${result.manifest.version} failed: ${errorText(err)}`)
        }
      }
      this.loaded.set(entry.id, { manifest: result.manifest, themes: this.registerRead(entry.id, themes) })
    } else {
      this.loaded.set(entry.id, { themes: [] })
      if (!state.ok) this.log(`plugin ${entry.id} disabled: ${state.reason}`)
    }
    this.options.index.setState(entry.id, state)
    return state
  }

  /** The `cli` claims of `entries` (clash order), from their manifests in `loaded`; one with none claims nothing. */
  private cliClaims(entries: readonly PluginEntry[]): CliClaim[] {
    return entries.flatMap((e) => {
      const manifest = this.loaded.get(e.id)?.manifest
      return manifest === undefined ? [] : [{ id: e.id, names: cliNamesOf(manifest) }]
    })
  }

  /**
   * Why `manifest` (about to be installed, linked or updated) may not take its `cli` names: another
   * indexed plugin that is running fine already owns one. Names that plugin's id so the user knows
   * what to unlink. Null when there is no clash. (The newcomer goes last: it never displaces anyone.)
   */
  private cliClash(manifest: PluginManifest): string | null {
    const others = this.clashOrder().filter((e) => e.id !== manifest.id && e.state.ok)
    const loss = settleCliNames([...this.cliClaims(others), { id: manifest.id, names: cliNamesOf(manifest) }]).lost.get(manifest.id)
    return loss === undefined ? null : cliLossReason(loss)
  }

  /**
   * The clash reason when an index entry before `id` owns one of `manifest`'s `cli` names (the
   * same bundled-first, then first-come order reconcileCliClashes settles), else null.
   */
  private cliLoss(id: string, manifest: PluginManifest): string | null {
    const order = this.clashOrder()
    const at = order.findIndex((e) => e.id === id)
    const before = at === -1 ? order : order.slice(0, at)
    const loss = settleCliNames([...this.cliClaims(before), { id, names: cliNamesOf(manifest) }]).lost.get(id)
    return loss === undefined ? null : cliLossReason(loss)
  }

  /**
   * Settle who owns each `ccc` command name across the whole index. Run after every change to the
   * set (start, install, link, update, uninstall, dev reload), because a linked manifest can be
   * edited to take a name another plugin has, and an uninstall can free one. The winner is fixed
   * and needs no stored order of its own: a bundled plugin first, then the earlier index entry (the
   * index keeps insertion order across restarts; settleCliNames applies the rule). The loser keeps
   * its manifest in `loaded` (so it can win again) but is marked not ok with the clash as the
   * reason, which stops it from activating and drops its themes. A plugin with any other failure
   * has no manifest in `loaded` and is not touched here. Returns the ids whose state it changed, so
   * the caller can reload their hosts (a demoted plugin's running host still serves its commands; a
   * recovered one has none).
   */
  private async reconcileCliClashes(): Promise<string[]> {
    const flipped: string[] = []
    const order = this.clashOrder()
    const { lost } = settleCliNames(this.cliClaims(order))
    for (const entry of order) {
      const manifest = this.loaded.get(entry.id)?.manifest
      if (manifest === undefined) continue
      const loss = lost.get(entry.id)
      if (loss !== undefined) {
        if (entry.state.ok) {
          const reason = cliLossReason(loss)
          this.unregisterThemes(entry.id)
          this.options.index.setState(entry.id, { ok: false, reason })
          this.log(`plugin ${entry.id} disabled: ${reason}`)
          flipped.push(entry.id)
        }
      } else if (!entry.state.ok) {
        // It lost before and nothing blocks it now; refreshEntry would have set ok for any other
        // reason, so this state can only be a former clash. (A plugin with a revocation recorded has no
        // manifest in `loaded`, so the check above already skipped it. One revoked but not recorded yet
        // goes on: view keeps it from the hosts, registerRead keeps its themes out.)
        this.options.index.setState(entry.id, { ok: true })
        const l = this.loaded.get(entry.id)
        if (l) l.themes = await this.registerThemes(entry.id, this.dirOf(entry), manifest)
        flipped.push(entry.id)
      }
    }
    return flipped
  }

  /** reconcileCliClashes, then reload the hosts it flipped (all but `skip`, which the caller reloads). */
  private async reconcileAndReload(skip?: string): Promise<void> {
    await this.reloadFlipped(await this.reconcileCliClashes(), skip)
  }

  /** Reload the hosts of plugins whose state reconcileCliClashes flipped, except `skip` (reloaded by the caller). */
  private async reloadFlipped(flipped: readonly string[], skip?: string): Promise<void> {
    for (const id of flipped) if (id !== skip) await this.afterHostsReload(id)
  }

  /** The index changed (load, install, link, update, uninstall): the dev watcher re-syncs. */
  private changed(): void {
    try {
      this.options.onChange?.()
    } catch (err) {
      this.log(`plugins: change listener failed: ${errorText(err)}`)
    }
  }

  /**
   * The one door to a plugin's manifest and folder: hosts, panels, the preview protocol, CLI
   * contributions and Settings all read list() or get(). So the revocation is enforced here, against
   * the current lookup and whatever the index says. An index can change at any await, and each way to
   * an ok state (install, restore, a name clash recovering) was a chance to start revoked code before the
   * queued applyRevocations stopped it. Read-only: recording and the notice stay with that run.
   * A plugin already running is stopped by that run too, when it reloads the hosts.
   */
  private view(entry: PluginEntry): InstalledPlugin {
    const l = this.loaded.get(entry.id)
    const revoked = entry.state.ok ? this.revocationOf(entry) : null
    // A reserved id outside the bundled set never gets as far as a host, whatever the index says
    // (refreshEntry records the refusal; this covers a record no refresh has seen yet).
    const foreign = entry.state.ok ? this.reservedProblem(entry) : null
    const state: PluginState = revoked !== null ? revokedState(revoked) : foreign !== null ? { ok: false, reason: foreign } : entry.state
    let dir: string
    try {
      dir = this.dirOf(entry)
    } catch {
      dir = ''
    }
    return { ...entry, state, dir, manifest: state.ok ? l?.manifest : undefined, themes: [...(l?.themes ?? [])] }
  }
}

/** A theme file's parsed content, not validated or registered yet. */
interface ReadTheme {
  id: string
  raw: unknown
}

function revokedState(revoked: PluginRevocation): Extract<PluginState, { ok: false }> {
  return { ok: false, reason: `revoked by ${revoked.source}: ${revoked.reason}`, revoked }
}

function cliNamesOf(manifest: PluginManifest): string[] {
  return (manifest.contributes?.cli ?? []).map((c) => c.name)
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch {
    return false
  }
}

/** Read a JSON file the manifest names, re-checking that it resolves inside the plugin folder. */
async function readPluginJson(dir: string, rel: string, maxBytes: number): Promise<unknown> {
  const root = await fs.realpath(dir)
  // The real path resolveInside checked, read through a verified descriptor (not the link).
  const file = await readInside(root, rel, maxBytes)
  if (!file.ok) throw new Error(`${rel}${insideReadProblemText(file.problem, maxBytes)}`)
  return JSON.parse(file.data.toString('utf8')) as unknown
}
