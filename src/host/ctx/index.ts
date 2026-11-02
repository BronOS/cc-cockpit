// The `ctx` each plugin's `activate(ctx)` gets (design §5; type: src/sdk/types.ts).
//
// It holds settings, storage, secrets, oauth, schedule, exec, commands, cli, services, log and notify; sessions, badge, overlay,
// panel messaging and webview panels (ctx/sessions.ts, ctx/ui.ts, ctx/webview.ts; the panel ports
// themselves arrive from main next to the RPC, see host/index.ts).
//
// Authority: everything here that touches the outside is decided by main and handed over in the
// plugin's `HostPluginSpec` (project folder, data dir, storage file, declared command ids, the
// validated settings). Nothing is built from plugin input, and every request to main (register a
// command, show a notification) is checked there against the host's own project and plugins.
import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import {
  PLUGIN_API_VERSION,
  type CliHandler,
  type Disposer,
  type ExecOptions,
  type ExecResult,
  type JsonValue,
  type OAuthSpec,
  type OAuthTokens,
  type PluginContext,
  type PluginLogger,
  type PluginSettings,
  type ServiceHandle
} from '../../sdk/types'
import { errorText, toError } from '../../shared/error-text'
import { normalizeCliResult, type PluginCliResult } from '../../shared/plugin-cli'
import { capText } from '../../shared/text'
import type { HostPluginSpec } from '../loader'
import type { ServiceRegistry } from '../services'
import { killChild, runExec } from './exec'
import { createScheduler, type Scheduler } from './schedule'
import { createSessionsApi, SessionsHub } from './sessions'
import { SettingsHolder } from './settings'
import { createStorage, type StorageHandle } from './storage'
import { createUiApi, PanelPorts, type PanelPort } from './ui'
import { createWebviewApi, WebviewHub } from './webview'

export type LogLevel = 'info' | 'warn' | 'error'

export interface ContextDeps {
  /** Where `ctx.log` goes (the host forwards it to main as a `log` event). */
  log(pluginId: string, level: LogLevel, text: string): void
  /**
   * A request to main (`commands.register`, `notify`, `sessions.*`, `badge`, `overlay.open`,
   * `secrets.*`, `oauth.*`).
   * Default: rejects (no connection to main). `timeoutMs: Infinity` waits until main answers or the
   * connection closes (an overlay is open as long as the user wants).
   */
  call?(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  /** A one-way event to main (`status`). Default: dropped. */
  emit?(event: string, params: unknown): void
  /** The environment children of `ctx.exec` get (default: this process's). */
  env?: NodeJS.ProcessEnv
  /**
   * The host's service registry (`ctx.services`); a getter because the loader that owns it is
   * built after the contexts. Absent: every `ctx.services` call throws.
   */
  services?: () => ServiceRegistry
  /** Test knobs. */
  scheduleTimeoutMs?: number
  execMaxOutputBytes?: number
  storageDebounceMs?: number
}

const MAX_LOG_LINE = 4000
/** Notification text as main shows it; longer text is cut in main too, this saves the round trip. */
const MAX_NOTIFY_LENGTH = 500

/** One log line from console-style arguments; capped so one call cannot flood main's log. */
export function formatLogArgs(args: readonly unknown[]): string {
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.stack ?? a.message
      try {
        return JSON.stringify(a) ?? String(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
  return capText(text, MAX_LOG_LINE)
}

/** What the host keeps per activated plugin. */
interface Runtime {
  spec: HostPluginSpec
  settings: SettingsHolder
  scheduler: Scheduler
  storage: StorageHandle
  commands: Map<string, () => unknown>
  /** `ctx.cli.register` handlers by command name. */
  cli: Map<string, CliHandler>
  /** This ctx's `ccc <name>` calls still running: aborted (and answered) at dispose. */
  cliCalls: Set<CliRun>
  children: Set<ChildProcess>
  /** Settles each of this ctx's ctx.oauth calls still waiting on main (rejected at dispose). */
  oauthCalls: Set<(err: Error) => void>
  /** This ctx called ctx.webview.navigate: main has views of it to close at dispose. */
  webviewUsed: boolean
  dataDirReady: boolean
  disposed: boolean
}

/** One running `ccc <name>` call: `cancel` aborts the handler's signal and answers main at once. */
interface CliRun {
  cancel(reason: string): void
}

/** The ctx objects of one plugin host, and what has to be cleaned up behind them. */
export class HostContexts {
  private readonly runtimes = new Map<string, Runtime>()
  /** Running `ccc <name>` calls by main's call id, for the `cli.cancel` event. */
  private readonly cliById = new Map<number, CliRun>()
  private readonly sessions: SessionsHub
  private readonly ports: PanelPorts
  private readonly webviews: WebviewHub

  constructor(private readonly deps: ContextDeps) {
    this.sessions = new SessionsHub((pluginId, m) => deps.log(pluginId, 'error', m))
    this.ports = new PanelPorts((pluginId, m) => deps.log(pluginId, 'warn', m))
    this.webviews = new WebviewHub((pluginId, m) => deps.log(pluginId, 'error', m))
  }

  /** Build the ctx for one plugin (the loader's `makeContext`). */
  create(spec: HostPluginSpec): PluginContext {
    // A second context for the same id (a plugin reloaded in place, Task 29) replaces the first.
    this.dispose(spec.id)
    const deps = this.deps
    const logAs = (level: LogLevel, text: string): void => deps.log(spec.id, level, text)
    const logger: PluginLogger = {
      info: (...args) => logAs('info', formatLogArgs(args)),
      warn: (...args) => logAs('warn', formatLogArgs(args)),
      error: (...args) => logAs('error', formatLogArgs(args))
    }
    const call = (method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown> =>
      deps.call ? deps.call(method, params, options) : Promise.reject(new Error('no connection to the app'))

    const rt: Runtime = {
      spec,
      settings: new SettingsHolder(spec.settings, (m) => logAs('warn', m)),
      scheduler: createScheduler({
        ...(deps.scheduleTimeoutMs !== undefined ? { runTimeoutMs: deps.scheduleTimeoutMs } : {}),
        log: (m) => logAs('error', m),
        // The ⚠ on the plugin's panel icons (main: HostManager 'status' event).
        report: (error) => deps.emit?.('status', { pluginId: spec.id, error: error ?? null })
      }),
      storage: createStorage({
        file: spec.storageFile,
        log: (m) => logAs('warn', m),
        ...(deps.storageDebounceMs !== undefined ? { debounceMs: deps.storageDebounceMs } : {})
      }),
      commands: new Map(),
      cli: new Map(),
      cliCalls: new Set(),
      children: new Set(),
      oauthCalls: new Set(),
      webviewUsed: false,
      dataDirReady: false,
      disposed: false
    }
    this.runtimes.set(spec.id, rt)

    /** After deactivate (or a failed activate) a plugin's leftover timers and promises must do nothing. */
    const servicesOf = (): ServiceRegistry => {
      const registry = deps.services?.()
      if (!registry) throw new Error('ctx.services is not available in this host')
      return registry
    }
    const alive = (): void => {
      if (rt.disposed) throw new Error('the plugin is deactivated')
    }
    const guardAsync = <T>(body: () => Promise<T>): Promise<T> => {
      try {
        alive()
        return body()
      } catch (err) {
        return Promise.reject(toError(err))
      }
    }

    const storage = {
      get: <T extends JsonValue = JsonValue>(key: string) => guardAsync(() => rt.storage.storage.get<T>(key)),
      set: (key: string, value: JsonValue) => guardAsync(() => rt.storage.storage.set(key, value)),
      delete: (key: string) => guardAsync(() => rt.storage.storage.delete(key)),
      keys: () => guardAsync(() => rt.storage.storage.keys())
    }

    // An RPC, unlike storage: only main has the keychain (safeStorage). Main checks the key, the
    // value and the plugin id again; `pluginId` is this plugin's own. No timeout: the first
    // keychain access can wait on a macOS "allow access" prompt for as long as the user takes.
    const secretsCall = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      guardAsync(() => call(method, { pluginId: spec.id, ...params }, { timeoutMs: Infinity }))
    const secrets = {
      get: (key: string) => secretsCall('secrets.get', { key }) as Promise<string | null>,
      set: async (key: string, value: string) => {
        await secretsCall('secrets.set', { key, value })
      },
      delete: async (key: string) => {
        await secretsCall('secrets.delete', { key })
      },
      keys: () => secretsCall('secrets.keys', {}) as Promise<string[]>
    }

    // Also an RPC: the browser (Electron's shell) and the loopback server are main's. Main checks
    // the spec, the plugin id and the limits. No timeout for authorize: it waits for the user in the
    // browser (main gives up after 5 minutes). refresh keeps the default: main's token request
    // times out after 15 s, well inside it.
    //
    // Bound to this ctx: dispose (deactivate, unload, reload, a failed or timed-out activate, the
    // host stopping: every way a ctx ends goes through it) rejects the call here at once and tells
    // main, which aborts it (closes the loopback, drops the token request). Tokens main sends
    // after that settle nothing: they never reach the disposed copy's code.
    const oauthCall = (method: string, params: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<OAuthTokens> =>
      guardAsync(
        () =>
          new Promise<OAuthTokens>((resolve, reject) => {
            rt.oauthCalls.add(reject)
            call(method, { pluginId: spec.id, ...params }, options)
              .then((tokens) => resolve(tokens as OAuthTokens), reject)
              .finally(() => rt.oauthCalls.delete(reject))
          })
      )
    const oauth = {
      authorize: (s: OAuthSpec) => oauthCall('oauth.authorize', { spec: s }, { timeoutMs: Infinity }),
      refresh: (s: OAuthSpec, refreshToken: string) => oauthCall('oauth.refresh', { spec: s, refreshToken })
    }

    const exec = (argv: readonly string[], options?: ExecOptions): Promise<ExecResult> =>
      guardAsync(() =>
        runExec(argv, options, {
          projectDir: spec.projectDir,
          env: deps.env ?? process.env,
          children: rt.children,
          alive,
          ...(deps.execMaxOutputBytes !== undefined ? { maxOutputBytes: deps.execMaxOutputBytes } : {})
        })
      )

    const register = (id: string, run: () => unknown): Disposer => {
      alive()
      if (typeof id !== 'string' || typeof run !== 'function') {
        throw new TypeError('commands.register needs an id and a function')
      }
      // The manifest is the contract: main only shows (and binds keys to) declared commands, and
      // refuses a register for any other id too. Failing here gives the plugin author the error at
      // the call site rather than a silent no-op.
      if (!spec.commands.includes(id)) {
        throw new Error(`command "${id}" is not declared in plugin.json contributes.commands`)
      }
      if (rt.commands.has(id)) throw new Error(`command "${id}" is already registered`)
      rt.commands.set(id, run)
      void call('commands.register', { pluginId: spec.id, id }).catch((err: unknown) => {
        logAs('error', `registering command "${id}" with the app failed: ${errorText(err)}`)
      })
      return () => {
        if (rt.commands.get(id) !== run) return
        rt.commands.delete(id)
        void call('commands.unregister', { pluginId: spec.id, id }).catch(() => {})
      }
    }

    // Like commands.register, but local only: main routes `ccc <name>` by the manifest (it owns the
    // name-clash rules), so there is nothing to tell it. A name the manifest does not declare is
    // refused here, at the call site, where the plugin author sees it.
    const registerCli = (name: string, handler: CliHandler): Disposer => {
      alive()
      if (typeof name !== 'string' || typeof handler !== 'function') {
        throw new TypeError('cli.register needs a name and a function')
      }
      if (!(spec.cli ?? []).includes(name)) {
        throw new Error(`cli command "${name}" is not declared in plugin.json contributes.cli`)
      }
      if (rt.cli.has(name)) throw new Error(`cli command "${name}" is already registered`)
      rt.cli.set(name, handler)
      return () => {
        if (rt.cli.get(name) === handler) rt.cli.delete(name)
      }
    }

    const notify = (text: string): Promise<void> =>
      guardAsync(async () => {
        if (typeof text !== 'string' || text === '') throw new TypeError('notify needs some text')
        await call('notify', { pluginId: spec.id, text: text.slice(0, MAX_NOTIFY_LENGTH) })
      })

    const ui = createUiApi({
      pluginId: spec.id,
      panels: spec.panels,
      webviewPanels: spec.webviewPanels ?? [],
      call,
      alive,
      guardAsync,
      ports: this.ports,
      logError: (m) => logAs('error', m)
    })

    return Object.freeze({
      api: PLUGIN_API_VERSION,
      pluginId: spec.id,
      // Getters: the snapshot is replaced when main pushes new settings, and the data dir is made
      // the first time a plugin asks for it ("created on demand").
      get settings(): PluginSettings {
        return rt.settings.current
      },
      onSettingsChange: (listener: (settings: PluginSettings) => void) => {
        alive()
        return rt.settings.onChange(listener)
      },
      storage: Object.freeze(storage),
      secrets: Object.freeze(secrets),
      oauth: Object.freeze(oauth),
      get dataDir(): string {
        alive()
        if (!rt.dataDirReady) {
          mkdirSync(spec.dataDir, { recursive: true, mode: 0o700 })
          rt.dataDirReady = true
        }
        return spec.dataDir
      },
      schedule: (seconds: number, fn: () => unknown) => {
        alive()
        return rt.scheduler.schedule(seconds, fn)
      },
      exec,
      panels: ui.panels,
      badge: ui.badge,
      overlay: ui.overlay,
      webview: createWebviewApi({
        pluginId: spec.id,
        webviewPanels: spec.webviewPanels ?? [],
        call,
        alive,
        guardAsync,
        hub: this.webviews,
        used: () => {
          rt.webviewUsed = true
        }
      }),
      sessions: createSessionsApi({ pluginId: spec.id, call, alive, guardAsync, hub: this.sessions }),
      commands: Object.freeze({ register }),
      cli: Object.freeze({ register: registerCli }),
      services: Object.freeze({
        provide: (name: string, impl: Record<string, (...args: never[]) => unknown>) => {
          alive()
          servicesOf().provide(spec.id, name, impl)
        },
        use: (name: string) => {
          alive()
          return servicesOf().use(spec.id, name) as ServiceHandle
        },
        emit: (name: string, event: string, data?: unknown) => {
          alive()
          servicesOf().emit(spec.id, name, event, data)
        },
        // The registry answers from the call frame, keyed by the id bound here, so a plugin can only
        // learn who is calling it. No alive() check, unlike the members above: a call already running
        // when the plugin is released finishes on the old copy (see ServiceRegistry.release), and a
        // read with no side effect must not break it.
        caller: () => servicesOf().caller(spec.id)
      }),
      log: Object.freeze(logger),
      notify
    })
  }

  /**
   * The plugin is done (deactivated, or its activate failed): stop its schedules, kill its
   * running children, write its storage, hand its commands back, end its sign-ins. Idempotent.
   */
  dispose(pluginId: string): void {
    const rt = this.runtimes.get(pluginId)
    if (!rt || rt.disposed) return
    rt.disposed = true
    this.runtimes.delete(pluginId)
    if (rt.oauthCalls.size > 0 || rt.webviewUsed || (rt.spec.webviewPanels?.length ?? 0) > 0) {
      // Main aborts the plugin's pending authorize and refreshes and closes its web views
      // (HostApi.contextDisposed). Sent before anything else of the id can be: a new copy's
      // create() runs this first, and the port keeps order, so main never takes the new copy's
      // sign-in (or view) for this one. Only when there is something: main has no sign-in of this
      // ctx that the host is not still waiting on (main answers each call only after its entry is
      // gone), and a view only after a navigate; a plugin with webview panels always
      // tells, since its panel reports placements before any navigate and main keeps them.
      this.deps.emit?.('plugin.disposed', { pluginId })
    }
    if (rt.oauthCalls.size > 0) {
      const gone = new Error('the plugin is deactivated')
      for (const reject of rt.oauthCalls) reject(gone)
      rt.oauthCalls.clear()
    }
    rt.scheduler.dispose()
    rt.settings.clear()
    // A `ccc <name>` still running for this copy answers now (exit 1) and its handler's signal
    // aborts: main frees the call's slot when the answer arrives, and the caller is not left
    // waiting the full 30 s for a plugin that is gone.
    for (const run of [...rt.cliCalls]) run.cancel('the plugin is deactivated')
    rt.cliCalls.clear()
    rt.cli.clear()
    this.sessions.removePlugin(pluginId)
    this.ports.removePlugin(pluginId)
    this.webviews.removePlugin(pluginId)
    for (const child of rt.children) killChild(child)
    rt.children.clear()
    // Before the host is killed (main waits at most 5 s for deactivate): the debounce window must
    // not swallow the plugin's last writes.
    rt.storage.flush()
    for (const id of rt.commands.keys()) {
      void this.deps.call?.('commands.unregister', { pluginId, id })?.catch(() => {})
    }
    rt.commands.clear()
  }

  disposeAll(): void {
    for (const id of [...this.runtimes.keys()]) this.dispose(id)
  }

  /**
   * Kill every plugin's running children and write its pending storage NOW, without disposing
   * anything: the plugins' deactivate() still runs after this and may still use storage.
   *
   * Why not leave it to dispose: dispose runs after a plugin's deactivate(), which the loader
   * caps at 5 s after first awaiting a still-pending activate (up to 10 s), while main kills the
   * host 5 s after asking. Children are `detached` (their own process group), so no kill of the
   * host reaches them, and their timeout timer dies with the host: they would run unbounded, and
   * the last debounce window of storage writes would be lost. Synchronous (process.kill and
   * JsonFile.flush both are), so it also works from a process 'exit' handler.
   */
  killChildrenAndFlush(): void {
    for (const rt of this.runtimes.values()) {
      for (const child of rt.children) killChild(child)
      rt.children.clear()
      rt.storage.flush()
    }
  }

  /**
   * Attach a panel's MessagePort (host/index.ts calls this when main hands the host a port tagged
   * with plugin and panel id). Only for a plugin that runs here and a panel its manifest declares;
   * false (and the port closed) otherwise.
   */
  attachPanelPort(pluginId: string, panelId: string, port: PanelPort): boolean {
    const rt = this.runtimes.get(pluginId)
    if (!rt || rt.disposed || !rt.spec.panels.includes(panelId)) {
      port.close()
      return false
    }
    this.ports.attach(pluginId, panelId, port)
    return true
  }

  /** The panel's page went away (closed, reloading): close its port (only `port`, when given). */
  detachPanelPort(pluginId: string, panelId: string, port?: PanelPort): void {
    this.ports.detach(pluginId, panelId, port)
  }

  /**
   * One-way events from main: `settings` `{ pluginId, project, app }` and `sessions`
   * `{ sessions }` (this project's tabs changed).
   */
  handleEvent(event: string, params: unknown): void {
    if (event === 'cli.cancel') {
      // Main gave up on the call (Ctrl+C on `ccc`, or its 30 s timeout) and has answered it
      // already; this only tells the handler, through its signal, to stop.
      const callId = (params as { callId?: unknown } | null)?.callId
      if (typeof callId === 'number') this.cliById.get(callId)?.cancel('the call was cancelled')
      return
    }
    if (event === 'sessions') {
      this.sessions.handleEvent(params)
      return
    }
    if (event === 'webview.navigated') {
      // Only a plugin that runs here (a late event for a disposed copy finds no listeners anyway).
      const pluginId = (params as { pluginId?: unknown } | null)?.pluginId
      if (typeof pluginId === 'string' && this.runtimes.has(pluginId)) this.webviews.handleEvent(params)
      return
    }
    if (event !== 'settings') return
    const pluginId = (params as { pluginId?: unknown } | null)?.pluginId
    if (typeof pluginId !== 'string') return
    this.runtimes.get(pluginId)?.settings.update(params)
  }

  /**
   * Main runs `ccc <name> …` (`cli.run { pluginId, name, argv, stdin, cwd, callId }`). Resolves
   * with the result, capped (main caps again: it does not trust the host). A handler that throws
   * or rejects is exit 1 with its message on stderr; one that is cancelled (dispose, or main's
   * `cli.cancel`) is exit 1 right away, whatever the handler does after.
   */
  runCli(params: unknown): Promise<PluginCliResult> {
    let call: ReturnType<typeof parseCliRun>
    try {
      call = parseCliRun(params)
    } catch (err) {
      return Promise.reject(toError(err))
    }
    const rt = this.runtimes.get(call.pluginId)
    const handler = rt?.cli.get(call.name)
    if (!rt || rt.disposed || !handler) {
      return Promise.reject(new Error(`${call.name}: the plugin has not registered this command (ctx.cli.register)`))
    }
    const prefix = `ccc ${call.name}: `
    return new Promise<PluginCliResult>((resolve) => {
      const controller = new AbortController()
      let settled = false
      const finish = (result: PluginCliResult): void => {
        if (settled) return
        settled = true
        rt.cliCalls.delete(run)
        if (call.callId !== undefined && this.cliById.get(call.callId) === run) this.cliById.delete(call.callId)
        resolve(result)
      }
      const run: CliRun = {
        cancel: (reason) => {
          controller.abort(new Error(reason))
          finish({ stdout: '', stderr: `${prefix}${reason}\n`, code: 1 })
        }
      }
      rt.cliCalls.add(run)
      if (call.callId !== undefined) this.cliById.set(call.callId, run)
      const callInfo = Object.freeze({ stdin: call.stdin, cwd: call.cwd, signal: controller.signal })
      // Through a resolved promise: a handler that throws synchronously lands in the same catch.
      // So does a result whose normalizing throws (a plugin's `get stdout() { throw … }`): in the
      // fulfilment callback it was an unhandled rejection, and this call hung until main's timeout.
      // The message is read guarded too: an Error's `message` can be a throwing getter as well.
      const failed = (err: unknown): PluginCliResult => {
        let text: string
        try {
          text = errorText(err)
        } catch {
          text = 'the command failed'
        }
        return normalizeCliResult({ stderr: `${prefix}${text}\n`, code: 1 })
      }
      Promise.resolve()
        .then(() => handler([...call.argv], callInfo))
        .then((value) => normalizeCliResult(value))
        .then(finish, (err: unknown) => finish(failed(err)))
    })
  }

  /** Main asks to run a command a plugin registered: `{ pluginId, id }`. */
  async runCommand(params: unknown): Promise<null> {
    const { pluginId, id } = (params ?? {}) as { pluginId?: unknown; id?: unknown }
    if (typeof pluginId !== 'string' || typeof id !== 'string') throw new Error('command.run: pluginId and id must be strings')
    const run = this.runtimes.get(pluginId)?.commands.get(id)
    if (!run) throw new Error(`command ${pluginId}/${id} is not registered`)
    await run()
    return null
  }
}

/**
 * The params main sends with `cli.run`, checked. Main built them, but the argv and stdin are a
 * caller's, so the shapes are verified before any reaches plugin code.
 */
function parseCliRun(params: unknown): {
  pluginId: string
  name: string
  argv: string[]
  stdin: string
  cwd: string
  callId: number | undefined
} {
  const { pluginId, name, argv, stdin, cwd, callId } = (params ?? {}) as Record<string, unknown>
  if (typeof pluginId !== 'string' || typeof name !== 'string') throw new Error('cli.run: pluginId and name must be strings')
  if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw new Error('cli.run: argv must be an array of strings')
  if (typeof cwd !== 'string') throw new Error('cli.run: cwd must be a string')
  return {
    pluginId,
    name,
    argv: argv as string[],
    stdin: typeof stdin === 'string' ? stdin : '',
    cwd,
    callId: typeof callId === 'number' ? callId : undefined
  }
}

/** One ctx on its own (tests). The host process uses `HostContexts` to also route events. */
export function createContext(spec: HostPluginSpec, deps: ContextDeps): PluginContext {
  return new HostContexts(deps).create(spec)
}
