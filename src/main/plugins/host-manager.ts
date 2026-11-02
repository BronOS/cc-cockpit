// One plugin host process per project window (design §2, §5 Lifecycle; plan Task 25).
//
//   open      window opened: declare the enabled plugins' panels, spawn a host when at least one of
//             them has host code (`main`), and activate them there.
//   close     window closed: `deactivate` (5 s cap), then kill.
//   crash     the host exited on its own: restart after 1, 2, 4 … s (capped at 30 s); the fifth
//             crash within 2 minutes stops trying and every panel of the host's plugins shows
//             "plugin stopped: Restart" until `restart()` (the panel's Restart button, Task 28).
//   reload    a plugin was updated or uninstalled (installer.reloadHosts): every host running it
//             is restarted from the current index (the old folder is about to go).
//   devReload a linked dev folder changed (dev-watch.ts, `devReload`): ONE plugin is deactivated,
//             its modules forgotten and activated again inside each running host, the other
//             plugins and the process untouched; its panels reload. An invalid manifest takes the
//             plugin down with the reason on its panels. What cannot be done in place (no host
//             process, a plugin this launch did not start) falls back to a whole-host restart.
//
// Authority: the host's identity is the process main spawned for a project, kept in this table.
// Nothing a host sends names a project; its RPC endpoint is created per process, so a handler
// (Tasks 26-28) always knows which project is asking. Plugins sharing one host can post on its
// parent port in each other's name; they are trusted code the user installed, and the boundary
// main enforces is the project, not the plugin.
//
// What a host may ask of main (Task 26), each checked against THIS host's own project and plugin
// list, whatever ids the request names:
//   commands.register / commands.unregister  only ids the plugin's manifest declares
//   notify                                   rate-capped per plugin, text capped
// plus sessions, badge and overlay (Task 27), handled by a HostApi (host-api.ts) built per host
// process with the same scope, revoked (every request refused) as soon as the host starts
// stopping or its window closes, and disposed when that process goes.
// Panel ports (Task 28): main hands the host one end of a panel's channel next to the RPC, as a
// `{ panelPort: { pluginId, panelId } }` message with the port in its transfer list; the ids are
// main's (panel-ports.ts checks them against `runningPanels`), never the renderer's.
// Plugin CLI commands (`ccc <name>`, plan B Task 5): runCli hands a call to the host serving the
// project, only for a plugin of the last launch that declares the name and activated in the
// current process, with a 30 s limit (exit 124) and at most MAX_CLI_IN_FLIGHT calls per plugin.
// A plugin reloading or a host starting is waited for within that limit (runCli explains why).
// Which plugin owns a name, and whether it is enabled, the socket handler decided from main's own
// index first (socket/handlers.ts); this re-checks against what the host actually runs.
// Main hands the host everything it needs at activation (HostPluginSpec: project folder, data dir,
// storage file, declared commands, validated settings); the host builds no path from plugin input.
//
// No Electron import: the process comes from a HostProcessFactory (host-process.ts is the real
// one); unit tests pass a fake and drive time with fake timers.
import { join } from 'node:path'
import { errorText } from '../../shared/error-text'
import { PLUGIN_STOPPED_TEXT } from '../../shared/ipc'
import { ACTIVATE_TIMEOUT_MS, type HostPluginSpec, type PluginRunState } from '../../host/loader'
import { RpcEndpoint, RpcTimeoutError, type RpcPort } from '../../host/rpc'
import type { CliContribution, PluginManifest } from '../../shared/manifest'
import { CLI_CALL_TIMEOUT_MS, CLI_TIMEOUT_CODE, MAX_CLI_IN_FLIGHT, type PluginCliResult } from '../../shared/plugin-cli'
import { capText } from '../../shared/text'
import type { PluginCommandDef } from '../commands/command-registry'
import type { Env } from '../env/login-env'
import type { LayoutService, PluginPanelDef } from '../layout/layout-service'
import { callCli } from './cli-call'
import { HostApi, type HostApiDeps } from './host-api'

/** Time a window's host gets to run every plugin's deactivate() before it is killed. */
export const DEACTIVATE_GRACE_MS = 5_000
/**
 * Margin on top of the loader's activate limit, PER PLUGIN: the loader requires the plugins'
 * modules one after another (a synchronous `require` cannot be time-boxed) before their activate
 * budgets run, so a window with several slow-to-load plugins legitimately takes longer. A fixed
 * margin would have main kill a healthy host, count a crash and end at "plugin stopped".
 */
const ACTIVATE_RPC_MARGIN_MS = 5_000
/** After a kill, how long to wait for the exit event before moving on regardless. */
const KILL_WAIT_MS = 2_000
export const RESTART_BASE_MS = 1_000
export const RESTART_MAX_MS = 30_000
export const CRASH_WINDOW_MS = 2 * 60_000
export const MAX_CRASHES = 5
/** How often runCli looks again while a plugin is on its way in (see runCli). */
export const CLI_READY_POLL_MS = 50
/** What a given-up host's panels show; PluginPanel offers Restart for exactly this text. */
export const STOPPED_TEXT = PLUGIN_STOPPED_TEXT
const MAX_LOG_TEXT = 4000
/**
 * A plugin's error as shown on its panels (pushed to every renderer). The host reports it; only the
 * 1 MiB message cap would bound it otherwise.
 */
const MAX_PLUGIN_ERROR_TEXT = 500
/** ctx.log lines main writes per host per window; a plugin logging in a tight loop floods no further. */
export const LOG_WINDOW_MS = 10_000
export const MAX_LOG_LINES_PER_WINDOW = 100
/**
 * ctx.notify: system notifications one plugin may show per window; a plugin cannot spam the
 * desktop. Counted per plugin, not per host: one noisy plugin must not use up the budget of the
 * others sharing its window.
 */
export const NOTIFY_WINDOW_MS = 60_000
export const MAX_NOTIFICATIONS_PER_WINDOW = 10
const MAX_NOTIFY_TEXT = 500
/** The file name of a plugin's KV store inside its data dir (ctx.storage). */
export const STORAGE_FILE_NAME = 'storage.json'

/** How long main waits for a host to answer `activate` for `count` plugins before killing it. */
export function activateBudgetMs(count: number, activateTimeoutMs = ACTIVATE_TIMEOUT_MS): number {
  return activateTimeoutMs + ACTIVATE_RPC_MARGIN_MS * Math.max(1, count)
}

/** Restart delay after the n-th crash in a row (1-based): 1, 2, 4, 8, 16, 30, 30 … seconds. */
export function restartDelay(consecutive: number): number {
  return Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.max(0, consecutive - 1))
}

/**
 * Variables a host keeps from the login env. Allow-listed rather than "everything but secrets":
 * main's env may carry tokens (an exported GITHUB_TOKEN, cloud credentials) that the user never
 * meant for every plugin. Plugins bring their own sign-ins (design §6); what is kept is what Node
 * and the tools a plugin runs need to work (PATH for exec, locale, temp dir, proxies and CA
 * bundles for network access).
 */
const HOST_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TZ',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR'
]

export function hostEnv(base: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (HOST_ENV_KEYS.includes(k) || k.startsWith('LC_')) out[k] = v
  }
  return out
}

export interface HostSpawnOptions {
  env: Record<string, string>
  /** The project folder (undefined: the app's own cwd). */
  cwd: string | undefined
  /** Process name, also the prefix of its output lines in main's log. */
  name: string
}

/** A running host as main sees it. */
export interface HostProcess {
  readonly port: RpcPort
  /** Called once, when the process is gone (crash, kill or its own exit). */
  onExit(listener: (code: number) => void): void
  kill(): void
  /**
   * Post `message` (a JSON string) with `port` in its transfer list: a panel's end of its channel
   * (Electron's MessagePortMain in the app). Throws when the process has exited.
   */
  transferPort(message: string, port: unknown): void
}

export interface HostProcessFactory {
  spawn(options: HostSpawnOptions): HostProcess
}

/** An enabled, valid plugin of a project, as main resolved it from the index. */
export interface HostPlugin {
  id: string
  /** The plugin's folder (absolute). */
  dir: string
  /** Git installs: the commit in that folder (see HostPluginSource). */
  commit?: string
  /** Manifest `main`; a plugin without one (themes or static panels only) needs no host. */
  main?: string
  panels: PluginPanelDef[]
  /** The manifest's `contributes.commands`: the only ids the plugin may register. */
  commands?: PluginCommandDef[]
  /** The manifest's `contributes.cli`: the `ccc <name>` commands main routes to this plugin. */
  cli?: CliContribution[]
  /** The manifest's `services` (validated): what the plugin provides to and uses from others. */
  services?: PluginManifest['services']
}

/**
 * What a listed plugin is, to tell it from a replacement. The folder alone cannot: it is named
 * `<id>@<version>`, so uninstalling a plugin and installing another repository's at the same version
 * (review finding) reuses it. The commit is what differs then.
 */
export type HostPluginSource = Pick<HostPlugin, 'dir' | 'commit'>

/**
 * What this installed plugin may run as in a project right now; undefined when it may not run. In one
 * place so that a launch's listing and the check before its activation cannot disagree on the terms.
 */
export function hostPluginSource(
  plugin: { dir: string; commit?: string; manifest?: unknown; state: { ok: boolean } } | undefined,
  enabled: boolean
): HostPluginSource | undefined {
  if (!enabled || !plugin?.manifest || !plugin.state.ok || plugin.dir === '') return undefined
  return { dir: plugin.dir, ...(plugin.commit !== undefined ? { commit: plugin.commit } : {}) }
}

/** One `ccc <name> …` call as the socket handler checked it. */
export interface HostCliCall {
  name: string
  /** Everything after the name, verbatim. */
  argv: string[]
  /** '' unless the command declares `stdin: true` (already within MAX_CLI_IO_BYTES encoded). */
  stdin: string
  /** The caller's working directory (absolute). */
  cwd: string
}

/** Settings of one plugin in one project, validated against its manifest schemas. */
export type HostSettings =
  | { ok: true; project: Record<string, unknown>; app: Record<string, unknown> }
  | { ok: false; reason: string }

/** Where a ctx request came from, for the services below. */
export interface HostSource {
  projectId: string
  pluginId: string
}

export interface HostCommandSink {
  add(projectId: string, pluginId: string, def: PluginCommandDef): void
  /** Remove every command of the plugin in the project. */
  clear(projectId: string, pluginId: string): void
  remove(projectId: string, pluginId: string, id: string): void
}

export interface PluginLogEntry {
  pluginId: string
  projectId: string
  level: 'info' | 'warn' | 'error'
  /** One line (line breaks already escaped). */
  text: string
}

export type HostPluginStatus =
  | { id: string; state: 'starting' }
  | { id: string; state: 'active' }
  | { id: string; state: 'errored'; error: string }
  | { id: string; state: 'stopped' }

export interface HostStatus {
  /** A host process is running for the project. */
  running: boolean
  /** Crashed MAX_CRASHES times within CRASH_WINDOW_MS; only `restart` starts it again. */
  stopped: boolean
  plugins: HostPluginStatus[]
}

export interface HostManagerDeps {
  factory: HostProcessFactory
  /**
   * The project's enabled plugins that validated (awaited: the index loads at launch). Every
   * launch and dev reload awaits this before it builds a spec, so it is also where anything
   * `settings` needs is prepared asynchronously (index.ts decrypts the secret settings fields here).
   */
  plugins(projectId: string): Promise<HostPlugin[]> | HostPlugin[]
  /** The login env (awaited: it is captured asynchronously at launch). */
  env(): Promise<Env> | Env
  projectPath(projectId: string): string | undefined
  /** Display name for the process. */
  projectName?(projectId: string): string | undefined
  layouts: Pick<LayoutService, 'setPluginPanels' | 'setError'>
  /** `ctx.dataDir` for a plugin in a project (`<data>/plugin-data/<projectId>/<pluginId>/`). */
  pluginDataDir(projectId: string, pluginId: string): string
  /**
   * The plugin's validated settings (defaults applied). A failure disables the plugin: it is not
   * started and its panels show the reason. Default: no settings. Synchronous on purpose: a
   * `settings` push and a spec build read it with no await between the read and the send, so no
   * newer save can slip in between (async preparation belongs in `plugins`).
   */
  settings?(projectId: string, pluginId: string): HostSettings
  /**
   * What this plugin may run as in this project right now (undefined: it may not run), read when a
   * spec is built. `plugins` is listed before waits of seconds (decrypting, the login env, a previous
   * host closing), and during them the plugin can be replaced or switched off: the settings check
   * below reads the current record, so it would pass for the replacement while the launch went on to
   * run the listed folder, and a replacement at the same version is in that very folder by then, with
   * the project's switch already off (disablePluginEverywhere).
   */
  pluginSource?(projectId: string, pluginId: string): HostPluginSource | undefined
  /**
   * The project's service provider picks (`{ [service]: pluginId }`), sent with every activate.
   * Read at the activate itself, so a restart picks up a changed choice. Default: none.
   */
  serviceProviders?(projectId: string): Record<string, string>
  /** The project's command registry: commands appear when a plugin registers them. */
  commands?: HostCommandSink
  /** `ctx.notify`: show a system notification. */
  notify?(text: string, source: HostSource): void
  /** `ctx.log`: append a line to `<data>/logs/<pluginId>.log` (rotation is the writer's). */
  pluginLog?(entry: PluginLogEntry): void
  /** Sessions, badges and overlays for plugins (host-api.ts). Without it those requests are unknown methods. */
  api?: HostApiDeps
  /**
   * A launch finished activating these plugins in the project's host: their panel pages reload and
   * connect to it (panel-ports.ts hostReady). Not called for a launch that failed or was replaced.
   */
  onPluginsReady?(projectId: string, pluginIds: string[]): void
  activateTimeoutMs?: number
  /** Test knob (default CLI_CALL_TIMEOUT_MS). */
  cliTimeoutMs?: number
  log?: (message: string) => void
}

interface HostRecord {
  projectId: string
  windowId: number
  /** Bumped by every launch; an older launch that resumes after an await gives up. */
  gen: number
  proc?: HostProcess
  rpc?: RpcEndpoint
  /** The sessions/badge/overlay handlers of `proc` (one per process: its overlays and badges go with it). */
  api?: HostApi
  /** Resolves when `proc` has exited. */
  exited?: Promise<void>
  /**
   * Settles when the launch's `activate` call does (set while it runs). A dev reload waits for it:
   * a `plugin.reload` sent while the host is still activating that plugin would deactivate a
   * half-activated copy, and the launch's own ready signal would come after the reload's.
   */
  activating?: Promise<void>
  /** An exit now is ours (close, restart), not a crash. */
  stopping: boolean
  closed: boolean
  /** The plugins of the last launch (their panels are declared in the layout). */
  plugins: HostPlugin[]
  status: Map<string, HostPluginStatus>
  /** Plugins of the last launch that were not started because their settings are invalid. */
  disabled: Set<string>
  /** The plugin ids the current process was started with: the only ones its requests may name. */
  ids: Set<string>
  /** devReload steps of this host run one after another (a second change waits for the first). */
  reloads: Promise<void>
  /**
   * Plugins with a `plugin.reload` in flight (devReload), from the settings read for its spec until
   * the host answers; the value says whether settingsChanged came meanwhile. The host deactivates
   * the old copy first (up to the grace) and activates the new one from the spec: a `settings`
   * event sent in between reaches the old context, which is then thrown away, and the new copy
   * would run on the values from before the save. settingsChanged leaves such a plugin out and
   * reloadIn pushes the values as they are once the new copy runs.
   */
  reloading: Map<string, boolean>
  /** Plugins whose activate() succeeded in the current process (they can take panel ports). */
  ran: Set<string>
  /**
   * launch() and restart() calls under way (nested: a restart's own launch counts twice). While
   * one runs, a plugin of this host is on its way in, not gone: runCli waits for it (see there).
   */
  starting: number
  /** Full ids (`<pluginId>/<id>`) of the commands the host registered, for `runCommand`. */
  registered: Set<string>
  /**
   * `ccc <name>` calls running per plugin id (runCli's cap). Per record, not per process: a call
   * outlives a host restart only until the old endpoint's close rejects it, and its `finally`
   * decrements the same count it incremented.
   */
  cliInFlight: Map<string, number>
  /** ctx.notify rate cap, per plugin id: start of its current window and notifications shown in it. */
  notifyWindows: Map<string, { start: number; count: number }>
  /** Crash times within the last CRASH_WINDOW_MS. */
  crashes: number[]
  /** Crashes in a row, for the backoff; reset by a host that lived CRASH_WINDOW_MS. */
  consecutive: number
  startedAt: number
  restartTimer?: ReturnType<typeof setTimeout>
  gaveUp: boolean
  /** ctx.log rate cap: start of the current window, lines written in it, lines dropped in it. */
  logWindowStart: number
  logCount: number
  logDropped: number
}

export class HostManager {
  private readonly hosts = new Map<string, HostRecord>()
  /**
   * Hosts whose window closed and that are still deactivating (up to 5 s). They are out of `hosts`
   * (the project may open a new window meanwhile), but on quit the windows close first and
   * disposeAll() runs right after: it must still kill these, not leave them to Electron.
   */
  private readonly closing = new Set<HostRecord>()
  /**
   * Per project, settles once every host closed for it so far is gone. A launch for the project
   * waits for it (see launch()): the window reopened within the ~7 s a closing host may take must
   * not get a second host beside the dying one. Both would share each plugin's storage.json, and
   * the old host's last flush (on deactivate or SIGTERM) would overwrite what the new one wrote
   * with its stale cached snapshot; its commands.unregister calls during deactivate would also
   * remove commands the new host had registered under the same project and plugin ids.
   */
  private readonly closes = new Map<string, Promise<void>>()
  private readonly log: (message: string) => void
  private readonly activateTimeoutMs: number
  /** Ids of runCli calls, so a `cli.cancel` event names one call in the host. */
  private nextCliCall = 1

  constructor(private readonly deps: HostManagerDeps) {
    this.log = deps.log ?? ((m) => console.warn(m))
    this.activateTimeoutMs = deps.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS
  }

  /** A project window opened. Resolves once its plugins have activated (or failed). */
  open(projectId: string, windowId: number): Promise<void> {
    if (this.hosts.has(projectId)) return Promise.resolve()
    const rec: HostRecord = {
      projectId,
      windowId,
      gen: 0,
      stopping: false,
      closed: false,
      plugins: [],
      status: new Map(),
      disabled: new Set(),
      ids: new Set(),
      reloads: Promise.resolve(),
      reloading: new Map(),
      ran: new Set(),
      starting: 0,
      registered: new Set(),
      cliInFlight: new Map(),
      notifyWindows: new Map(),
      crashes: [],
      consecutive: 0,
      startedAt: 0,
      gaveUp: false,
      logWindowStart: 0,
      logCount: 0,
      logDropped: 0
    }
    this.hosts.set(projectId, rec)
    return this.launch(rec)
  }

  /** The project window closed: deactivate (capped), kill. Resolves once the process is gone. */
  async close(projectId: string): Promise<void> {
    const rec = this.hosts.get(projectId)
    if (!rec) return
    this.hosts.delete(projectId)
    rec.closed = true
    rec.gen++
    // From the moment the window is gone the host speaks for nobody: revoke its API now, not when
    // the process is gone (up to DEACTIVATE_GRACE_MS + KILL_WAIT_MS later). Its requests name only
    // the project, so a stalled deactivate in a project reopened meanwhile could otherwise list
    // and type into the NEW window's tabs. stopProcess revokes too; this also covers a close that
    // waits behind an earlier one (`previous` below) before stopProcess runs.
    rec.api?.revoke()
    this.clearTimer(rec)
    this.closing.add(rec)
    const stop = async (): Promise<void> => {
      try {
        await this.stopProcess(rec)
      } finally {
        this.closing.delete(rec)
        this.clearCommands(rec)
      }
    }
    // Chained on an earlier close of the same project still under way (close, reopen, close again
    // within the grace): the reopened window's host never spawned, but the next launch must still
    // wait for the first host, so the map entry has to cover both.
    const previous = this.closes.get(projectId)
    const done = previous ? previous.then(stop) : stop()
    const settled = done.catch(() => {})
    this.closes.set(projectId, settled)
    try {
      await done
    } finally {
      if (this.closes.get(projectId) === settled) this.closes.delete(projectId)
    }
  }

  /**
   * Start a project's host again from the current index, with a fresh crash budget: the Restart
   * of "plugin stopped: Restart", and a plugin update. Resolves once activation is done.
   */
  async restart(projectId: string): Promise<void> {
    const rec = this.hosts.get(projectId)
    if (!rec) return
    rec.starting++
    try {
      await this.restartSteps(rec)
    } finally {
      rec.starting--
    }
  }

  private async restartSteps(rec: HostRecord): Promise<void> {
    this.clearTimer(rec)
    rec.crashes = []
    rec.consecutive = 0
    rec.gaveUp = false
    // Before the await: a launch already under way must not spawn a second process meanwhile.
    rec.gen++
    await this.stopProcess(rec)
    if (rec.closed) return
    await this.launch(rec)
    // A launch signals only the plugins it activated in the host. A static-only plugin (panels,
    // no `main`) has nothing to activate, so after an update or a re-enable its open panels would
    // keep the old page until the window reopened: reload them here (devReload does the same).
    // Not on a crash restart (that launches from a timer): static pages did not change then.
    if (rec.closed || this.hosts.get(rec.projectId) !== rec) return
    const statics = rec.plugins.filter((p) => !(typeof p.main === 'string' && p.main !== '')).map((p) => p.id)
    if (statics.length > 0) this.signalReady(rec, statics)
  }

  /**
   * The project's set of enabled plugins changed (settings › This project). The launch is what
   * reads the set (`deps.plugins`), declares the panels of the plugins that are in it and drops
   * those of the ones that are not, so the answer is a restart: a plugin turned off is
   * deactivated and its process goes, one turned on starts, and the others restart with them
   * (one host process serves the whole window; per-plugin hot add/remove is not worth a second
   * code path). A project without a host (its window is closing) has nothing to restart.
   * Resolves once the new set has activated.
   */
  async enabledChanged(projectId: string): Promise<void> {
    await this.restart(projectId)
  }

  /**
   * The panel's Restart (`plugins.restart`): restart only a host that gave up after repeated
   * crashes. Renderer input must not be able to kill a healthy host (dropping its plugins'
   * in-memory state) or wipe a crash budget that is still counting; a second click, or a panel of
   * the same host clicked meanwhile, finds `gaveUp` already cleared and does nothing.
   */
  async restartStopped(projectId: string): Promise<void> {
    if (!this.hosts.get(projectId)?.gaveUp) return
    await this.restart(projectId)
  }

  /**
   * Plugin `id` changed on disk (installed, linked, updated or uninstalled): restart every host
   * that runs it, so none keeps code from the old folder (the installer awaits this before deleting
   * that folder), and every host whose project has it enabled without running it. The second set
   * is the (re)install case: an uninstall keeps the plugin in the projects' enabled lists (settings
   * go on showing it on), the restart after it dropped the plugin from the host, and installing or
   * linking it again must bring its runtime, panels and commands back the way enabling does,
   * not only after a toggle or a window reopen.
   */
  async reloadPlugin(id: string): Promise<void> {
    const affected = await Promise.all(
      [...this.hosts.values()].map(async (r): Promise<HostRecord | undefined> => {
        if (r.plugins.some((p) => p.id === id)) return r
        try {
          // The installer has already written the index: the list holds the plugin when it is
          // enabled here and valid.
          return (await this.deps.plugins(r.projectId)).some((p) => p.id === id) ? r : undefined
        } catch (err) {
          this.log(`plugin host ${r.projectId}: cannot list plugins to reload ${id}: ${errorText(err)}`)
          return undefined
        }
      })
    )
    // restart() looks the project up again: a window closed during the listing is skipped there.
    await Promise.all(affected.flatMap((r) => (r ? [this.restart(r.projectId)] : [])))
  }

  /**
   * A linked dev plugin's folder changed (dev-watch.ts, after the installer re-validated its
   * manifest): reload `id` in every open host. `problem` is the reason the manifest is invalid, if
   * it is: the plugin is taken down and its panels show it. Hosts are handled independently and a
   * failure in one is logged, not thrown. Resolves once every host is done.
   */
  async devReload(id: string, problem?: string): Promise<void> {
    await Promise.all(
      [...this.hosts.values()].map((rec) => {
        const run = rec.reloads.then(() => this.reloadIn(rec, id, problem))
        rec.reloads = run.catch((err: unknown) => {
          this.log(`plugin host ${rec.projectId}: reloading ${id} failed: ${errorText(err)}`)
        })
        return rec.reloads
      })
    )
  }

  /**
   * A plugin's settings (project or app-wide) changed in `projectId`. Valid new values are pushed
   * to the running plugins (`ctx.onSettingsChange`). If a plugin that runs is now invalid, or one
   * that was disabled for invalid settings is valid again, the host restarts: the launch is what
   * decides who runs, so the answer is the same as at window open. With `pluginId` only that
   * plugin is looked at (a project settings save changes one plugin's values): the others would
   * get a `settings` event for nothing and may refetch or reset on it.
   */
  async settingsChanged(projectId: string, pluginId?: string): Promise<void> {
    const rec = this.hosts.get(projectId)
    if (!rec || !this.deps.settings) return
    let restartNeeded = false
    for (const p of rec.plugins) {
      if (typeof p.main !== 'string' || p.main === '') continue
      if (pluginId !== undefined && p.id !== pluginId) continue
      const settings = this.settingsOf(projectId, p.id)
      if (rec.disabled.has(p.id)) {
        if (settings.ok) restartNeeded = true
      } else if (!settings.ok) {
        restartNeeded = true
      } else if (rec.reloading.has(p.id)) {
        // Its old copy is going away mid-reload: reloadIn pushes these once the new copy runs.
        rec.reloading.set(p.id, true)
      } else {
        rec.rpc?.emit('settings', { pluginId: p.id, project: settings.project, app: settings.app })
      }
    }
    if (restartNeeded) await this.restart(projectId)
  }

  /**
   * Run a plugin command (`<pluginId>/<id>`) in the project's host. Only a command the host
   * registered with main is accepted; the host re-checks, but the id came from a renderer.
   */
  async runCommand(projectId: string, commandId: string): Promise<void> {
    const rec = this.hosts.get(projectId)
    if (!rec?.rpc || !rec.registered.has(commandId)) throw new Error(`unknown command: ${commandId}`)
    // Plugin ids hold no slash and neither do contribution ids, so the last slash splits them.
    const slash = commandId.lastIndexOf('/')
    // No RPC timeout: a palette command that asks something awaits `ctx.overlay.open` (itself
    // called with no timeout, ui.ts) and is still running long after the default 30 s. It ends
    // with the command or rejects when the host exits (the endpoint's close rejects every call).
    await rec.rpc.call('command.run', { pluginId: commandId.slice(0, slash), id: commandId.slice(slash + 1) }, { timeoutMs: Infinity })
  }

  /**
   * Run `ccc <name> …` in the project's host for `pluginId`. The plugin must be one this host's
   * last launch got (enabled and valid) that declares `name`, and must have activated in the
   * current process; the host then runs the handler the plugin registered. Throws (the CLI prints
   * it, exit 1) for anything that keeps the call from starting: no such command here, the plugin
   * not running, MAX_CLI_IN_FLIGHT calls of it already running, the caller already gone.
   *
   * A plugin on its way in is waited for, not refused (Task 2 of the friction round): a linked
   * plugin reloading (its old copy is disposed, the new one not yet active), and the host
   * launching or restarting (window open, app start, an enable or an update). The dev loop walks
   * straight into that gap: edit, the app reloads by itself, run the command. The wait polls
   * (CLI_READY_POLL_MS) rather than hooking each transition: "on its way in" is read from several
   * fields (`starting`, `reloading`, `ran`) that change in many places, and a missed notification
   * would be a hang. The wait and the call share ONE limit (CLI_CALL_TIMEOUT_MS from the request):
   * a plugin that is still not active then is exit 124, like a handler that does not answer. A
   * crashed host waiting out its restart backoff is not "on its way in": refused as not running.
   *
   * Once started, the call (callCli, cli-call.ts) ends in one of four ways, and each frees its slot:
   *   - the host answers: the result, re-capped here (the host is not trusted to cap);
   *   - the limit passes: exit 124 with a message, and the host is told to cancel;
   *   - `peerGone` aborts (Ctrl+C on `ccc`): rejected, and the host is told to cancel;
   *   - the host exits or the plugin's ctx is disposed: the endpoint's close, or the host's own
   *     answer for a disposed ctx (exit 1), settles it.
   * The `cli.cancel` event only aborts the handler's signal; a late answer is dropped. So
   * MAX_CLI_IN_FLIGHT counts the calls main still waits for (a call waiting for the plugin to
   * come up included): a handler that ignores its signal can keep running after a timeout or
   * Ctrl+C, and its slot is already free.
   */
  async runCli(projectId: string, pluginId: string, call: HostCliCall, peerGone?: AbortSignal): Promise<PluginCliResult> {
    const limitMs = this.deps.cliTimeoutMs ?? CLI_CALL_TIMEOUT_MS
    const deadline = Date.now() + limitMs
    const rec = this.hosts.get(projectId)
    if (!rec || (!this.declaresCli(rec, pluginId, call.name) && !this.cliComing(rec, pluginId))) {
      // Also what a plugin enabled after this host's last launch gets (it is not in rec.plugins yet).
      throw unknownCli(call.name)
    }
    const busy = rec.cliInFlight.get(pluginId) ?? 0
    if (busy >= MAX_CLI_IN_FLIGHT) {
      throw new Error(`${call.name}: plugin ${pluginId} already runs ${MAX_CLI_IN_FLIGHT} commands; try again when one ends`)
    }
    if (peerGone?.aborted) throw new Error(`${call.name}: the caller went away`)
    rec.cliInFlight.set(pluginId, busy + 1)
    try {
      if (!(await this.waitCliReady(rec, pluginId, call.name, deadline, peerGone))) {
        return { stdout: '', stderr: `ccc ${call.name}: plugin ${pluginId} did not become active within ${Math.round(limitMs / 1000)} s\n`, code: CLI_TIMEOUT_CODE }
      }
      // After the wait the launch or reload may have changed what the plugin declares.
      if (this.hosts.get(projectId) !== rec || !this.declaresCli(rec, pluginId, call.name)) throw unknownCli(call.name)
      // Read fresh, after the wait, never cached across an await: only the host that serves the
      // project now may answer.
      const rpc = rec.rpc
      if (!rpc || !rec.proc || rec.stopping || !rec.ran.has(pluginId)) {
        throw new Error(`${call.name}: plugin ${pluginId} is not running in this window`)
      }
      return await callCli(
        rpc,
        { pluginId, name: call.name, argv: call.argv, stdin: call.stdin, cwd: call.cwd },
        {
          name: call.name,
          callId: this.nextCliCall++,
          // What the wait left of the limit; at least 1 ms so a call that just made it still asks.
          timeoutMs: Math.max(1, deadline - Date.now()),
          limitMs,
          ...(peerGone ? { peerGone } : {})
        }
      )
    } finally {
      const left = (rec.cliInFlight.get(pluginId) ?? 1) - 1
      if (left > 0) rec.cliInFlight.set(pluginId, left)
      else rec.cliInFlight.delete(pluginId)
    }
  }

  /** The plugin of the host's last launch declares the command `name`. */
  private declaresCli(rec: HostRecord, pluginId: string, name: string): boolean {
    return (rec.plugins.find((p) => p.id === pluginId)?.cli ?? []).some((c) => c.name === name)
  }

  /**
   * The plugin is not active yet but on its way in: a launch or restart of this host is under way
   * (window open, app start, enable, update), or a dev reload swaps its copy (`reloading` is set
   * from the moment reloadIn drops it from `ran` until the host answers `plugin.reload`).
   */
  private cliComing(rec: HostRecord, pluginId: string): boolean {
    if (rec.closed || this.hosts.get(rec.projectId) !== rec) return false
    return rec.starting > 0 || rec.reloading.has(pluginId)
  }

  /**
   * Wait until the plugin runs in the host or is no longer on its way in. False when `deadline`
   * passed first; rejects when the caller went away meanwhile. The caller re-checks what it needs.
   */
  private async waitCliReady(rec: HostRecord, pluginId: string, name: string, deadline: number, peerGone?: AbortSignal): Promise<boolean> {
    for (;;) {
      if (peerGone?.aborted) throw new Error(`${name}: the caller went away`)
      const ready = rec.rpc !== undefined && rec.proc !== undefined && !rec.stopping && rec.ran.has(pluginId) && !rec.reloading.has(pluginId)
      if (ready || !this.cliComing(rec, pluginId)) return true
      const left = deadline - Date.now()
      if (left <= 0) return false
      await pause(Math.min(CLI_READY_POLL_MS, left), peerGone)
    }
  }

  /**
   * The panel ids `pluginId` declares when it runs in the project's host right now (activated;
   * a scheduled job failing since does not stop it), else undefined: no host, a plugin that is
   * starting, failed to activate the last time it was told, was disabled or given up on, or one
   * this host does not run. The strings are main's own records.
   */
  runningPanels(projectId: string, pluginId: string): readonly string[] | undefined {
    const rec = this.hosts.get(projectId)
    if (!rec?.proc || rec.stopping || !rec.ran.has(pluginId)) return undefined
    return rec.plugins.find((p) => p.id === pluginId)?.panels.map((p) => p.id)
  }

  /**
   * Hand the project's host one end of a panel's channel, tagged with the plugin and panel id
   * (the caller took them from `runningPanels`). False when there is no host process to take it.
   */
  sendPanelPort(projectId: string, pluginId: string, panelId: string, port: unknown): boolean {
    const proc = this.hosts.get(projectId)?.proc
    if (!proc) return false
    proc.transferPort(JSON.stringify({ panelPort: { pluginId, panelId } }), port)
    return true
  }

  /** App quitting: kill every host now (no deactivate; main is about to exit). */
  disposeAll(): void {
    for (const rec of [...this.hosts.values(), ...this.closing]) {
      rec.closed = true
      rec.gen++
      rec.stopping = true
      this.clearTimer(rec)
      rec.proc?.kill()
      rec.rpc?.close('app quitting')
      this.disposeApi(rec)
      this.clearCommands(rec)
    }
    this.hosts.clear()
    this.closing.clear()
  }

  status(projectId: string): HostStatus | undefined {
    const rec = this.hosts.get(projectId)
    if (!rec) return undefined
    return { running: rec.proc !== undefined, stopped: rec.gaveUp, plugins: [...rec.status.values()] }
  }

  /**
   * The plugins a launch of this project's host would hand specs to, with their `services`: the
   * enabled plugins with host code whose settings validate and whose folder is the listed one
   * (buildSpec's checks, without its side effects). A plugin dropped for invalid settings is in
   * neither this set nor the host's, so the Plugins page's warnings and a call's error agree.
   */
  async servicePlugins(projectId: string): Promise<{ id: string; services?: HostPlugin['services'] }[]> {
    const plugins = await this.deps.plugins(projectId)
    return plugins
      .filter((p) => typeof p.main === 'string' && p.main !== '')
      .filter((p) => {
        const current = this.deps.pluginSource ? this.deps.pluginSource(projectId, p.id) : p
        if (current?.dir !== p.dir || current.commit !== p.commit) return false
        return this.settingsOf(projectId, p.id).ok
      })
      .map((p) => (p.services !== undefined ? { id: p.id, services: p.services } : { id: p.id }))
  }

  // -------------------------------------------------------------------------------------------

  private async launch(rec: HostRecord): Promise<void> {
    rec.starting++
    try {
      await this.launchSteps(rec)
    } finally {
      rec.starting--
    }
  }

  private async launchSteps(rec: HostRecord): Promise<void> {
    const gen = ++rec.gen
    rec.restartTimer = undefined
    let plugins: HostPlugin[]
    try {
      plugins = await this.deps.plugins(rec.projectId)
    } catch (err) {
      if (rec.closed || gen !== rec.gen) return
      // On a crash restart the panels still say "restarting in N s": replace that with the reason,
      // or it would stay there forever (no retry follows; the user can Restart).
      this.failLaunch(rec, `cannot list plugins: ${errorText(err)}`)
      return
    }
    if (rec.closed || gen !== rec.gen) return
    this.declarePanels(rec, plugins)
    const runnable = plugins.filter((p) => typeof p.main === 'string' && p.main !== '')
    rec.status = new Map(runnable.map((p) => [p.id, { id: p.id, state: 'starting' } as HostPluginStatus]))
    rec.disabled = new Set()
    rec.ran = new Set()
    for (const p of runnable) this.setPanelError(rec, p.id, undefined)
    // No host code to run: no process (most windows have no plugin, and a process each is waste).
    if (runnable.length === 0) return
    let env: Env
    try {
      env = await this.deps.env()
    } catch (err) {
      if (rec.closed || gen !== rec.gen) return
      this.failLaunch(rec, `no environment: ${errorText(err)}`)
      return
    }
    if (rec.closed || gen !== rec.gen) return
    // The previous window's host of this project is still deactivating: wait until it is gone
    // before spawning (see `closes`; at most the deactivate grace plus the kill wait). In launch()
    // rather than open() because restart, settingsChanged, a dev reload and the crash timer all
    // launch too; after the panels are declared, so the reopened window shows them as starting.
    // Before the specs are built, so the settings they carry are read after the wait: a
    // settingsChanged meanwhile has no rpc to push to (its `settings` event went nowhere) and,
    // with specs built earlier, activate would get the values from before the change. A plugin
    // that turns invalid meanwhile makes settingsChanged restart, whose gen bump ends this launch.
    const previous = this.closes.get(rec.projectId)
    if (previous) {
      await previous
      if (rec.closed || gen !== rec.gen) return
    }

    // What each plugin is told (see HostPluginSpec). A plugin whose settings do not validate is
    // disabled with the reason on its panels; the others still start.
    const projectDir = this.deps.projectPath(rec.projectId)
    if (projectDir === undefined) {
      this.failLaunch(rec, 'the project folder is unknown')
      return
    }
    const specs: HostPluginSpec[] = []
    for (const p of runnable) {
      const spec = this.buildSpec(rec, p, projectDir)
      if (spec) specs.push(spec)
    }
    if (specs.length === 0) return

    const name = `cc-cockpit plugin host (${this.deps.projectName?.(rec.projectId) ?? rec.projectId})`
    let proc: HostProcess
    try {
      proc = this.deps.factory.spawn({ env: hostEnv(env), cwd: this.deps.projectPath(rec.projectId), name })
    } catch (err) {
      this.log(`plugin host ${rec.projectId}: spawn failed: ${errorText(err)}`)
      this.markAll(rec, (id) => ({ id, state: 'errored', error: `plugin host did not start: ${errorText(err)}` }))
      return
    }
    const ids = new Set(specs.map((s) => s.id))
    rec.ids = ids
    // Only the plugins this launch actually starts; `rpc` is assigned below, before any event can
    // go out (the first one waits for a session change and a timer).
    const api = this.deps.api
      ? new HostApi(
          this.deps.api,
          {
            projectId: rec.projectId,
            windowId: rec.windowId,
            projectDir,
            plugins: specs.map((s) => ({ id: s.id, dir: s.dir, panels: s.panels, webviewPanels: s.webviewPanels ?? [] }))
          },
          (event, params) => rpc.emit(event, params)
        )
      : undefined
    const rpc = new RpcEndpoint({
      port: proc.port,
      // Host -> main requests. Panel ports go the other way only (sendPanelPort).
      handlers: {
        'commands.register': (params) => this.registerCommand(rec, ids, params),
        'commands.unregister': (params) => this.unregisterCommand(rec, ids, params),
        notify: (params) => this.notifyFromHost(rec, ids, params),
        ...api?.handlers
      },
      onEvent: (event, params) => {
        // A plugin's ctx ended inside the host (any reason): its sign-ins end too. This process's
        // own HostApi, not rec.api: a host being replaced must not touch the next one's calls.
        if (event === 'plugin.disposed') api?.contextDisposed(params)
        else this.onEvent(rec, ids, event, params)
      },
      log: (m) => this.log(`plugin host ${rec.projectId}: ${m}`)
    })
    rec.proc = proc
    rec.rpc = rpc
    rec.api = api
    rec.stopping = false
    rec.startedAt = Date.now()
    rec.exited = new Promise((resolve) => {
      proc.onExit((code) => {
        this.exited(rec, proc, code)
        resolve()
      })
    })

    // A dev reload that arrives meanwhile waits for this (HostRecord.activating): settled only once
    // the states are applied and the panels told, on every way out of this block.
    let doneActivating: () => void = () => {}
    rec.activating = new Promise<void>((resolve) => (doneActivating = resolve))
    try {
      let states: unknown
      try {
        states = await rpc.call(
          'activate',
          { plugins: specs, serviceProviders: this.serviceProvidersOf(rec.projectId) },
          { timeoutMs: activateBudgetMs(specs.length, this.activateTimeoutMs) }
        )
      } catch (err) {
        if (rec.proc !== proc || rec.stopping) return
        if (err instanceof RpcTimeoutError) {
          // The loader caps each activate, so a host that does not answer is stuck (a synchronous
          // endless loop in some plugin): kill it, and the exit is handled as a crash.
          this.log(`plugin host ${rec.projectId}: activate unanswered, killing the host`)
          proc.kill()
        } else {
          this.log(`plugin host ${rec.projectId}: activate failed: ${errorText(err)}`)
        }
        return
      }
      if (rec.proc !== proc || rec.stopping) return
      this.applyStates(rec, ids, states)
      try {
        this.deps.onPluginsReady?.(rec.projectId, [...ids])
      } catch (err) {
        this.log(`plugin host ${rec.projectId}: ${errorText(err)}`)
      }
    } finally {
      doneActivating()
    }
  }

  /**
   * What the host is told for one plugin (see HostPluginSpec). A plugin whose settings do not
   * validate is disabled with the reason on its panels and gets no spec; the others still start.
   */
  private buildSpec(rec: HostRecord, p: HostPlugin, projectDir: string): HostPluginSpec | undefined {
    // No await from here to the spawn. A plugin that changed gets no spec: the install or update that
    // changed it also reloads the hosts, and that launch lists it again and clears this reason.
    const current = this.deps.pluginSource ? this.deps.pluginSource(rec.projectId, p.id) : p
    const stale = current?.dir !== p.dir || current.commit !== p.commit
    const settings: HostSettings = stale ? { ok: false, reason: 'it changed while starting' } : this.settingsOf(rec.projectId, p.id)
    if (!settings.ok) {
      const error = capText(`plugin disabled: ${settings.reason}`, MAX_PLUGIN_ERROR_TEXT)
      this.log(`plugin ${p.id} (${rec.projectId}): ${error}`)
      rec.disabled.add(p.id)
      rec.status.set(p.id, { id: p.id, state: 'errored', error })
      this.setPanelError(rec, p.id, error)
      return undefined
    }
    const dataDir = this.deps.pluginDataDir(rec.projectId, p.id)
    return {
      id: p.id,
      dir: p.dir,
      main: p.main as string,
      projectDir,
      dataDir,
      storageFile: join(dataDir, STORAGE_FILE_NAME),
      commands: (p.commands ?? []).map((c) => c.id),
      panels: p.panels.map((panel) => panel.id),
      webviewPanels: p.panels.filter((panel) => panel.kind === 'webview').map((panel) => panel.id),
      cli: (p.cli ?? []).map((c) => c.name),
      ...(p.services !== undefined ? { services: p.services } : {}),
      settings: {
        project: settings.project as HostPluginSpec['settings']['project'],
        app: settings.app as HostPluginSpec['settings']['app']
      }
    }
  }

  /** The project's provider picks; a throwing dependency means none (logged), not a failed launch. */
  private serviceProvidersOf(projectId: string): Record<string, string> {
    try {
      return { ...(this.deps.serviceProviders?.(projectId) ?? {}) }
    } catch (err) {
      this.log(`plugin host ${projectId}: reading service providers failed: ${errorText(err)}`)
      return {}
    }
  }

  /** devReload for one host (see there). */
  private async reloadIn(rec: HostRecord, id: string, problem: string | undefined): Promise<void> {
    // A launch still activating finishes first (HostRecord.activating); settled at once otherwise.
    await rec.activating
    if (rec.closed || this.hosts.get(rec.projectId) !== rec) return
    const old = rec.plugins.find((p) => p.id === id)
    if (problem !== undefined) {
      if (old) await this.takeDown(rec, old, `plugin disabled: ${problem}`)
      return
    }
    let plugins: HostPlugin[]
    try {
      plugins = await this.deps.plugins(rec.projectId)
    } catch (err) {
      this.log(`plugin host ${rec.projectId}: cannot list plugins to reload ${id}: ${errorText(err)}`)
      return
    }
    if (rec.closed || this.hosts.get(rec.projectId) !== rec) return
    const next = plugins.find((p) => p.id === id)
    if (!next) {
      // Not enabled in this project (nothing to do), or gone between the check and now.
      if (old) await this.takeDown(rec, old, 'plugin disabled: it is no longer available')
      return
    }
    const hasMain = typeof next.main === 'string' && next.main !== ''
    const inHost = rec.proc !== undefined && !rec.stopping && !rec.gaveUp && rec.ids.has(id)
    // Not running in this process: a new launch decides who runs (settings, the process itself).
    if (hasMain && !inHost) {
      await this.restart(rec.projectId)
      return
    }
    // Replace the plugin in the host's records and the layout: new panels, new commands.
    rec.plugins = old ? rec.plugins.map((p) => (p.id === id ? next : p)) : [...rec.plugins, next]
    this.deps.layouts.setPluginPanels(rec.projectId, id, next.panels)
    rec.disabled.delete(id)
    rec.ran.delete(id)
    this.dropCommands(rec, id)
    const proc = rec.proc
    if (!hasMain) {
      // Static panels only now: whatever ran in the host goes, the panels just reload.
      if (inHost) await this.unloadInHost(rec, id)
      // The window may have closed (or the host been replaced) during the unload RPC.
      if (rec.closed || this.hosts.get(rec.projectId) !== rec) return
      rec.status.delete(id)
      this.setPanelError(rec, id, undefined)
      this.signalReady(rec, id)
      return
    }
    const projectDir = this.deps.projectPath(rec.projectId)
    if (projectDir === undefined) {
      this.takeDownRecorded(rec, id, 'plugin disabled: the project folder is unknown')
      return
    }
    // Marked before buildSpec reads the settings, cleared once the new copy is running or failed
    // (see HostRecord.reloading). The launch path needs no such mark: its specs are built after
    // its last await and sent with `activate`, which the host handles in order and creates every
    // context for synchronously, so any later `settings` event finds the new context.
    rec.reloading.set(id, false)
    try {
      await this.reloadSpec(rec, id, next, projectDir, proc)
    } finally {
      rec.reloading.delete(id)
    }
  }

  /** The in-host part of reloadIn for a plugin with host code: build its spec, swap the copy. */
  private async reloadSpec(rec: HostRecord, id: string, next: HostPlugin, projectDir: string, proc: HostProcess | undefined): Promise<void> {
    const spec = this.buildSpec(rec, next, projectDir)
    if (!spec) {
      // Settings no longer validate: buildSpec put the reason on the panels; stop the old copy.
      await this.unloadInHost(rec, id)
      return
    }
    rec.status.set(id, { id, state: 'starting' })
    this.setPanelError(rec, id, undefined)
    rec.api?.updatePlugin({ id, dir: next.dir, panels: spec.panels, webviewPanels: spec.webviewPanels ?? [] })
    let state: unknown
    try {
      state = await rec.rpc?.call('plugin.reload', { plugin: spec }, {
        // The host deactivates the old copy first (up to the grace) and then activates the new
        // one (the activate budget): a slow deactivate must not make a healthy host look stuck.
        timeoutMs: activateBudgetMs(1, this.activateTimeoutMs) + DEACTIVATE_GRACE_MS
      })
    } catch (err) {
      if (rec.proc !== proc || rec.stopping) return
      if (err instanceof RpcTimeoutError) {
        // The same as a launch: the loader caps activate, so an unanswered call is a stuck host.
        this.log(`plugin host ${rec.projectId}: reload of ${id} unanswered, killing the host`)
        proc?.kill()
      } else {
        this.log(`plugin host ${rec.projectId}: reload of ${id} failed: ${errorText(err)}`)
        this.takeDownRecorded(rec, id, `reload failed: ${errorText(err)}`)
      }
      return
    }
    if (rec.proc !== proc || rec.stopping) return
    // Only this plugin: applyStates marks every id of the set that the host did not report.
    this.applyStates(rec, new Set([id]), [state])
    // Settings saved while the host swapped the copies: the new one started from the spec's older
    // values. Invalid ones need nothing here: settingsChanged restarted the host for them.
    if (rec.reloading.get(id) === true && rec.ran.has(id)) {
      const settings = this.settingsOf(rec.projectId, id)
      if (settings.ok) rec.rpc?.emit('settings', { pluginId: id, project: settings.project, app: settings.app })
    }
    this.signalReady(rec, id)
  }

  /**
   * An invalid manifest (or settings, or a vanished plugin): stop the plugin's code, drop its
   * commands and show `reason` on its panels. The panels stay declared (from the last good
   * manifest) so the reason has an icon to sit on; a new launch drops them with the plugin.
   */
  private async takeDown(rec: HostRecord, plugin: HostPlugin, reason: string): Promise<void> {
    if (rec.proc !== undefined && !rec.stopping && rec.ids.has(plugin.id)) await this.unloadInHost(rec, plugin.id)
    // Same re-check as after any await in reloadIn: a window closed during the unload must not
    // get status, panel errors or a ready signal written for a project that is gone.
    if (rec.closed || this.hosts.get(rec.projectId) !== rec) return
    this.takeDownRecorded(rec, plugin.id, reason)
  }

  private takeDownRecorded(rec: HostRecord, id: string, reason: string): void {
    const error = capText(reason, MAX_PLUGIN_ERROR_TEXT)
    this.log(`plugin ${id} (${rec.projectId}): ${error}`)
    rec.ran.delete(id)
    // Keeps the reason through a later crash's markAll.
    rec.disabled.add(id)
    this.dropCommands(rec, id)
    rec.status.set(id, { id, state: 'errored', error })
    this.setPanelError(rec, id, error)
  }

  /**
   * Deactivate one plugin inside the running host (its release hook frees its ctx, and the
   * host's `plugin.disposed` event then ends its sign-ins: HostApi.contextDisposed).
   */
  private async unloadInHost(rec: HostRecord, id: string): Promise<void> {
    const proc = rec.proc
    try {
      await rec.rpc?.call('plugin.unload', { pluginId: id }, { timeoutMs: DEACTIVATE_GRACE_MS })
    } catch (err) {
      this.log(`plugin host ${rec.projectId}: unloading ${id} failed: ${errorText(err)}`)
      // A deactivate that hangs leaves the old copy running next to the new one: restart is the
      // clean answer, as for any host that stopped answering.
      if (rec.proc === proc && err instanceof RpcTimeoutError) proc?.kill()
    }
    rec.ran.delete(id)
  }

  /** The plugin's commands leave the registry; the host registers them again when it activates. */
  private dropCommands(rec: HostRecord, id: string): void {
    for (const full of [...rec.registered]) {
      if (full.startsWith(`${id}/`)) rec.registered.delete(full)
    }
    this.deps.commands?.clear(rec.projectId, id)
  }

  private signalReady(rec: HostRecord, ids: string | string[]): void {
    try {
      this.deps.onPluginsReady?.(rec.projectId, typeof ids === 'string' ? [ids] : ids)
    } catch (err) {
      this.log(`plugin host ${rec.projectId}: ${errorText(err)}`)
    }
  }

  /** Apply the host's per-plugin result, trusting only entries for plugins this host runs. */
  private applyStates(rec: HostRecord, ids: Set<string>, states: unknown): void {
    const seen = new Set<string>()
    if (Array.isArray(states)) {
      for (const s of states as Partial<PluginRunState & { error: unknown }>[]) {
        if (typeof s !== 'object' || s === null || typeof s.id !== 'string' || !ids.has(s.id)) continue
        seen.add(s.id)
        if (s.state === 'active') {
          rec.ran.add(s.id)
          // launch() set every plugin 'starting', so 'errored' here is a scheduled job that failed
          // while activate() was still running (its first tick can come 1 s after schedule). The
          // host reports only transitions: clearing it now would hide the ⚠ for as long as the
          // job keeps failing. Its recovery event clears it.
          if (rec.status.get(s.id)?.state === 'errored') continue
          rec.status.set(s.id, { id: s.id, state: 'active' })
          this.setPanelError(rec, s.id, undefined)
        } else {
          const error =
            typeof s.error === 'string' && s.error !== '' ? capText(s.error, MAX_PLUGIN_ERROR_TEXT) : 'activation failed'
          rec.status.set(s.id, { id: s.id, state: 'errored', error })
          this.setPanelError(rec, s.id, error)
        }
      }
    }
    for (const id of ids) {
      if (seen.has(id)) continue
      rec.status.set(id, { id, state: 'errored', error: 'the plugin host did not report it' })
      this.setPanelError(rec, id, 'the plugin host did not report it')
    }
  }

  private exited(rec: HostRecord, proc: HostProcess, code: number): void {
    if (rec.proc !== proc) return
    rec.rpc?.close('plugin host exited')
    this.disposeApi(rec)
    rec.proc = undefined
    rec.rpc = undefined
    // The host's commands die with it: the palette must not offer what nobody can run.
    this.clearCommands(rec)
    if (rec.stopping || rec.closed) return

    const now = Date.now()
    // A host that ran a whole window long was healthy: this crash starts a new backoff series.
    if (now - rec.startedAt >= CRASH_WINDOW_MS) rec.consecutive = 0
    rec.consecutive++
    rec.crashes = [...rec.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    this.log(`plugin host ${rec.projectId} exited unexpectedly (code ${code})`)
    if (rec.crashes.length >= MAX_CRASHES) {
      rec.gaveUp = true
      this.log(`plugin host ${rec.projectId}: ${MAX_CRASHES} crashes within ${CRASH_WINDOW_MS / 1000} s, not restarting`)
      this.markAll(rec, (id) => ({ id, state: 'stopped' }), STOPPED_TEXT)
      return
    }
    const delay = restartDelay(rec.consecutive)
    this.markAll(rec, (id) => ({
      id,
      state: 'errored',
      error: `plugin host crashed; restarting in ${Math.round(delay / 1000)} s`
    }))
    rec.restartTimer = setTimeout(() => {
      // Nobody awaits a timer's launch: a throw in it (the layout service, a dep) would be an
      // unhandled rejection in main and leave the panels on "restarting in N s".
      this.launch(rec).catch((err: unknown) => {
        if (!rec.closed) this.failLaunch(rec, errorText(err))
      })
    }, delay)
  }

  /** Ask the host to deactivate (capped), kill it, wait for the exit. No-op without a process. */
  private async stopProcess(rec: HostRecord): Promise<void> {
    const proc = rec.proc
    const rpc = rec.rpc
    const exited = rec.exited
    if (!proc) return
    rec.stopping = true
    // Before the deactivate await: the dying host's sessions/badge/overlay requests are
    // refused from here on (HostApi.revoke). They check only the project id, and a window
    // reopened during the grace makes that project id another window's.
    rec.api?.revoke()
    try {
      await rpc?.call('deactivate', {}, { timeoutMs: DEACTIVATE_GRACE_MS })
    } catch (err) {
      this.log(`plugin host ${rec.projectId}: deactivate: ${errorText(err)}`)
    }
    proc.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, KILL_WAIT_MS)
      })
    ])
    clearTimeout(timer)
    if (rec.proc === proc) {
      // No exit event in time; forget the process anyway so a new one can start.
      rpc?.close('plugin host stopped')
      this.disposeApi(rec)
      rec.proc = undefined
      rec.rpc = undefined
    }
    this.clearCommands(rec)
  }

  private onEvent(rec: HostRecord, ids: Set<string>, event: string, params: unknown): void {
    if (event === 'status') this.onPluginStatus(rec, ids, params)
    if (event !== 'log') return
    const { pluginId, level, text } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || !ids.has(pluginId) || typeof text !== 'string') return
    const lvl = level === 'error' || level === 'warn' ? level : 'info'
    // Fixed-window cap per host: ctx.log in a tight loop must not flood main's log. The drop count
    // is reported once, with the first line of the next window.
    const now = Date.now()
    if (now - rec.logWindowStart >= LOG_WINDOW_MS) {
      if (rec.logDropped > 0) {
        const cap = `${MAX_LOG_LINES_PER_WINDOW} in ${LOG_WINDOW_MS / 1000} s`
        this.log(`plugin host ${rec.projectId}: ${rec.logDropped} plugin log lines dropped (over ${cap})`)
      }
      rec.logWindowStart = now
      rec.logCount = 0
      rec.logDropped = 0
    }
    if (rec.logCount >= MAX_LOG_LINES_PER_WINDOW) {
      rec.logDropped++
      return
    }
    rec.logCount++
    // One plugin line is one log line: an embedded line break could forge a line that reads as
    // another plugin's ("plugin x.other (p1) error: ...") or as main's own.
    const oneLine = text.slice(0, MAX_LOG_TEXT).replace(/\r\n|[\r\n\u2028\u2029]/g, '\\n')
    this.log(`plugin ${pluginId} (${rec.projectId}) ${lvl}: ${oneLine}`)
    try {
      this.deps.pluginLog?.({ pluginId, projectId: rec.projectId, level: lvl, text: oneLine })
    } catch (err) {
      this.log(`plugin ${pluginId}: writing its log failed: ${errorText(err)}`)
    }
  }

  /**
   * A plugin's scheduled job started failing (`error`: text) or works again (`error`: null): the
   * ⚠ on its panel icons. Only a plugin this host runs, and a recovery only clears an error that
   * is showing (never turns a plugin that failed to activate into an active one).
   */
  private onPluginStatus(rec: HostRecord, ids: Set<string>, params: unknown): void {
    // A host whose window closed is only deactivating: the project's panels (in the layout, keyed
    // by project) may already be a reopened window's, and its ⚠ is not this host's to set.
    if (rec.closed) return
    const { pluginId, error } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || !ids.has(pluginId)) return
    if (typeof error === 'string') {
      const text = capText(error, MAX_PLUGIN_ERROR_TEXT)
      rec.status.set(pluginId, { id: pluginId, state: 'errored', error: text })
      this.setPanelError(rec, pluginId, text)
    } else if (error === null && rec.status.get(pluginId)?.state === 'errored') {
      rec.status.set(pluginId, { id: pluginId, state: 'active' })
      this.setPanelError(rec, pluginId, undefined)
    }
  }

  private registerCommand(rec: HostRecord, ids: Set<string>, params: unknown): null {
    // A host whose window closed is only deactivating: a command it adds now would outlive it in
    // the registry (or land among a newer host's commands for the same project).
    if (rec.closed) throw new Error('commands: the window is closing')
    const { plugin, id } = this.commandOf(rec, ids, params)
    const def = (plugin.commands ?? []).find((c) => c.id === id)
    if (!def) throw new Error(`command "${id}" is not declared in the manifest of ${plugin.id}`)
    this.deps.commands?.add(rec.projectId, plugin.id, def)
    rec.registered.add(`${plugin.id}/${id}`)
    return null
  }

  private unregisterCommand(rec: HostRecord, ids: Set<string>, params: unknown): null {
    const { plugin, id } = this.commandOf(rec, ids, params)
    this.deps.commands?.remove(rec.projectId, plugin.id, id)
    rec.registered.delete(`${plugin.id}/${id}`)
    return null
  }

  /** The plugin and command id a host request names, only if this host runs that plugin. */
  private commandOf(rec: HostRecord, ids: Set<string>, params: unknown): { plugin: HostPlugin; id: string } {
    const { pluginId, id } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof id !== 'string' || !ids.has(pluginId)) {
      throw new Error('commands: unknown plugin')
    }
    const plugin = rec.plugins.find((p) => p.id === pluginId)
    if (!plugin) throw new Error('commands: unknown plugin')
    return { plugin, id }
  }

  private notifyFromHost(rec: HostRecord, ids: Set<string>, params: unknown): null {
    // Like registerCommand: a host whose window closed speaks for no window any more.
    if (rec.closed) throw new Error('notify: the window is closing')
    const { pluginId, text } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || !ids.has(pluginId)) throw new Error('notify: unknown plugin')
    if (typeof text !== 'string' || text.trim() === '') throw new Error('notify: text must be a non-empty string')
    if (!this.deps.notify) throw new Error('notify: notifications are not available')
    const now = Date.now()
    let win = rec.notifyWindows.get(pluginId)
    if (!win || now - win.start >= NOTIFY_WINDOW_MS) {
      // pluginId is one of `ids` (checked above), so the map holds at most one entry per plugin.
      win = { start: now, count: 0 }
      rec.notifyWindows.set(pluginId, win)
    }
    if (win.count >= MAX_NOTIFICATIONS_PER_WINDOW) {
      throw new Error(`notify: more than ${MAX_NOTIFICATIONS_PER_WINDOW} notifications in ${NOTIFY_WINDOW_MS / 1000} s`)
    }
    win.count++
    this.deps.notify(capText(text, MAX_NOTIFY_TEXT), { projectId: rec.projectId, pluginId })
    return null
  }

  /** The plugin's settings, or a failing result when the settings service throws. */
  private settingsOf(projectId: string, pluginId: string): HostSettings {
    if (!this.deps.settings) return { ok: true, project: {}, app: {} }
    try {
      return this.deps.settings(projectId, pluginId)
    } catch (err) {
      return { ok: false, reason: `settings cannot be read: ${errorText(err)}` }
    }
  }

  /**
   * Take the host's commands out of the project's command registry. The registry is keyed by
   * project and plugin, not by host: when the window was reopened while this host was still
   * deactivating (close() waits up to ~7 s), a newer record serves the project. Its launch waits
   * for this close (`closes`), so it has registered nothing yet and every command of this host is
   * removed; still one by one, and skipping any the newer one has, so the registry stays right
   * whatever order the two run in.
   */
  private clearCommands(rec: HostRecord): void {
    const newer = this.newerHost(rec)
    if (newer) {
      for (const full of rec.registered) {
        if (newer.registered.has(full)) continue
        // `<pluginId>/<id>`: a plugin id never holds a slash (PLUGIN_ID_PATTERN).
        const slash = full.indexOf('/')
        this.deps.commands?.remove(rec.projectId, full.slice(0, slash), full.slice(slash + 1))
      }
    } else {
      for (const p of rec.plugins) this.deps.commands?.clear(rec.projectId, p.id)
    }
    rec.registered.clear()
  }

  /** The host that now serves `rec`'s project, when that is not `rec` (see clearCommands). */
  private newerHost(rec: HostRecord): HostRecord | undefined {
    const current = this.hosts.get(rec.projectId)
    return current !== undefined && current !== rec ? current : undefined
  }

  /** A launch could not start the host: log it and show why on every panel of its plugins. */
  private failLaunch(rec: HostRecord, reason: string): void {
    this.log(`plugin host ${rec.projectId}: ${reason}`)
    const error = capText(`plugin host did not start: ${reason}`, MAX_PLUGIN_ERROR_TEXT)
    this.markAll(rec, (id) => ({ id, state: 'errored', error }))
  }

  /** Make the layout's plugin panels those of `plugins`, dropping panels of plugins now gone. */
  private declarePanels(rec: HostRecord, plugins: HostPlugin[]): void {
    const now = new Set(plugins.map((p) => p.id))
    for (const old of rec.plugins) {
      if (!now.has(old.id)) this.deps.layouts.setPluginPanels(rec.projectId, old.id, [])
    }
    for (const p of plugins) this.deps.layouts.setPluginPanels(rec.projectId, p.id, p.panels)
    rec.plugins = plugins
  }

  private markAll(rec: HostRecord, status: (id: string) => HostPluginStatus, panelText?: string): void {
    for (const id of rec.status.keys()) {
      // A plugin disabled for its settings keeps its own reason; a crash did not change that.
      if (rec.disabled.has(id)) continue
      const s = status(id)
      rec.status.set(id, s)
      this.setPanelError(rec, id, panelText ?? (s.state === 'errored' ? s.error : undefined))
    }
  }

  /** The ⚠ on each of a plugin's panel icons (undefined clears it). */
  private setPanelError(rec: HostRecord, pluginId: string, error: string | undefined): void {
    const plugin = rec.plugins.find((p) => p.id === pluginId)
    for (const panel of plugin?.panels ?? []) {
      // Only the ⚠: a badge the plugin set stays (an activate that ends after its first badge
      // clears the 'starting' error, a failing job comes and goes).
      this.deps.layouts.setError(rec.projectId, `${pluginId}/${panel.id}`, error)
    }
  }

  /** The process is gone or going: its overlays are dismissed and its badges cleared. */
  private disposeApi(rec: HostRecord): void {
    // Badges live per project and panel key in the layout. When the window was reopened while
    // this host was still deactivating, a newer record serves the project; its launch waits for
    // this close (`closes`), but whatever it has badged is left to it all the same.
    const newer = this.newerHost(rec)
    try {
      rec.api?.dispose(newer ? (key) => newer.api?.hasBadged(key) === true : undefined)
    } catch (err) {
      this.log(`plugin host ${rec.projectId}: ${errorText(err)}`)
    }
    rec.api = undefined
  }

  private clearTimer(rec: HostRecord): void {
    if (rec.restartTimer !== undefined) clearTimeout(rec.restartTimer)
    rec.restartTimer = undefined
  }
}

function unknownCli(name: string): Error {
  return new Error(`unknown command: ${name} (if its plugin was enabled just now, reload the project's plugins first)`)
}

/** Resolve after `ms`, or at once when `signal` aborts (the loop above then sees it). */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}
