// ctx.sessions (design §5 › sessions): this project window's Claude tabs. The host only asks; main
// answers from its own session registry, scoped to the project it spawned this host for, and every
// send goes through main's send gate (typed only while the tab waits for input, else queued). See
// src/main/plugins/host-api.ts for the checks on main's side.
//
// onChange: main pushes a `sessions` event with the project's whole list whenever one of its tabs
// changes (throttled there); the hub here fans it out to every plugin's listeners.
//
// Scope `all` (design-next §4.1): summaries of every window's Claude tabs, for a plugin whose
// manifest declares `"access": { "sessions": "all-windows" }`. The check here is the fast error;
// main checks the declaration again for list, and sends `sessions.all` only to a host that runs such
// a plugin. focus reaches any window's tab, close and openFile only this window's (main decides).
import type { Disposer, PluginContext, SendResult, SessionInfo, SessionSummary } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { checkSessionName } from '../../shared/session-name'
import { checkSessionOptions } from '../../shared/session-options'
import { checkCommandArgv } from '../../shared/tab-commands'

type Listener = (sessions: SessionInfo[]) => void
type AllListener = (sessions: SessionSummary[]) => void

export interface SessionsApiDeps {
  pluginId: string
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  /** Throws when the plugin is deactivated. */
  alive(): void
  /** Rejects (instead of throwing) when the plugin is deactivated. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  hub: SessionsHub
  /** The manifest declares `access.sessions: 'all-windows'` (scope `all`). */
  sessionsAll?: boolean
}

/** The `sessions` listeners of every plugin of one host. */
export class SessionsHub {
  private readonly listeners = new Map<string, Set<Listener>>()
  /** Scope `all` listeners (the `sessions.all` event). */
  private readonly allListeners = new Map<string, Set<AllListener>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  add(pluginId: string, listener: Listener): Disposer {
    return addTo(this.listeners, pluginId, listener)
  }

  addAll(pluginId: string, listener: AllListener): Disposer {
    return addTo(this.allListeners, pluginId, listener)
  }

  /** The plugin is gone: its listeners hear nothing more. */
  removePlugin(pluginId: string): void {
    this.listeners.delete(pluginId)
    this.allListeners.delete(pluginId)
  }

  /** Main's `sessions.all` event: `{ sessions: SessionSummary[] }`, to the scope `all` listeners. */
  handleAllEvent(params: unknown): void {
    const sessions = (params as { sessions?: unknown } | null)?.sessions
    if (!Array.isArray(sessions)) return
    fanOut(this.allListeners, sessions, this.log)
  }

  /**
   * Main's `sessions` event: `{ sessions: SessionInfo[] }`. Each listener gets its own copy, so a
   * plugin that mutates the array does not change what the next one sees. A throwing listener is
   * logged against its plugin and does not stop the others.
   */
  handleEvent(params: unknown): void {
    const sessions = (params as { sessions?: unknown } | null)?.sessions
    if (!Array.isArray(sessions)) return
    fanOut(this.listeners, sessions, this.log)
  }
}

function addTo<L extends (sessions: never[]) => void>(map: Map<string, Set<L>>, pluginId: string, listener: L): Disposer {
  const set = map.get(pluginId) ?? new Set<L>()
  // A wrapper per registration: the same function added twice is two subscriptions, and each
  // disposer removes only its own.
  const entry = ((sessions: never[]) => listener(sessions)) as L
  set.add(entry)
  map.set(pluginId, set)
  return () => {
    set.delete(entry)
    if (set.size === 0 && map.get(pluginId) === set) map.delete(pluginId)
  }
}

/** Each listener gets its own copy; a throwing one is logged against its plugin and does not stop the others. */
function fanOut<L extends (sessions: never[]) => void>(
  map: Map<string, Set<L>>,
  sessions: unknown[],
  log: (pluginId: string, message: string) => void
): void {
  for (const [pluginId, set] of [...map]) {
    for (const listener of [...set]) {
      try {
        listener(structuredClone(sessions) as never[])
      } catch (err) {
        log(pluginId, `a sessions.onChange listener threw: ${errorText(err)}`)
      }
    }
  }
}

/** The scope option of list / onChange: 'window' (the default) or 'all', which needs the declaration. */
function scopeOf(what: string, options: unknown, sessionsAll: boolean): 'window' | 'all' {
  if (options === undefined || options === null) return 'window'
  if (typeof options !== 'object') throw new TypeError(`${what}: options must be an object`)
  const scope = (options as { scope?: unknown }).scope
  if (scope === undefined || scope === 'window') return 'window'
  if (scope !== 'all') throw new TypeError(`${what}: scope must be "window" or "all"`)
  if (!sessionsAll) throw new Error(`${what}: scope "all" needs "access": { "sessions": "all-windows" } in plugin.json`)
  return 'all'
}

function checkTabId(what: string, tabId: unknown): asserts tabId is string {
  if (typeof tabId !== 'string' || tabId === '') throw new TypeError(`${what} needs a tab id`)
}

export function createSessionsApi(deps: SessionsApiDeps): PluginContext['sessions'] {
  const { pluginId, call, guardAsync } = deps
  const sessionsAll = deps.sessionsAll === true
  const api = {
    list: (options?: { scope?: 'window' | 'all' }) =>
      guardAsync(async () => {
        if (scopeOf('sessions.list', options, sessionsAll) === 'window') return (await call('sessions.list', { pluginId, scope: 'window' })) as SessionInfo[]
        return (await call('sessions.list', { pluginId, scope: 'all' })) as SessionSummary[]
      }),
    onChange: (listener: Listener | AllListener, options?: { scope?: 'window' | 'all' }): Disposer => {
      deps.alive()
      if (typeof listener !== 'function') throw new TypeError('sessions.onChange needs a function')
      if (scopeOf('sessions.onChange', options, sessionsAll) === 'all') return deps.hub.addAll(pluginId, listener as AllListener)
      return deps.hub.add(pluginId, listener as Listener)
    },
    focus: (tabId: string) =>
      guardAsync(async () => {
        checkTabId('sessions.focus', tabId)
        return (await call('sessions.focus', { pluginId, tabId })) as boolean
      }),
    close: (tabId: string) =>
      guardAsync(async () => {
        checkTabId('sessions.close', tabId)
        // No RPC timeout: a running tab's dialog waits for the person, and main bounds that wait itself
        // (answering `closed: false` when it gives up), so the call always settles.
        return (await call('sessions.close', { pluginId, tabId }, { timeoutMs: Infinity })) as { closed: boolean }
      }),
    openFile: (tabId: string, path: string) =>
      guardAsync(async () => {
        checkTabId('sessions.openFile', tabId)
        if (typeof path !== 'string' || path === '') throw new TypeError('sessions.openFile needs a path')
        await call('sessions.openFile', { pluginId, tabId, path })
      }),
    rename: (tabId: string, name: string | null) =>
      guardAsync(async () => {
        checkTabId('sessions.rename', tabId)
        // Checked here for the fast error; main checks again (shared/session-name.ts).
        const checked = checkSessionName(name)
        if (!checked.ok) throw new TypeError(`sessions.rename: ${checked.reason}`)
        await call('sessions.rename', { pluginId, tabId, name: checked.value })
      }),
    send: (tabId: string, text: string) =>
      guardAsync(async () => {
        if (typeof tabId !== 'string' || typeof text !== 'string') {
          throw new TypeError('sessions.send needs a tab id and text')
        }
        return (await call('sessions.send', { pluginId, tabId, text })) as SendResult
      }),
    open: (options: { cwd?: string; prompt?: string; focus?: boolean; model?: string; effort?: string } = {}) =>
      guardAsync(async () => {
        const { cwd, prompt, focus, model, effort } = (options ?? {}) as {
          cwd?: unknown
          prompt?: unknown
          focus?: unknown
          model?: unknown
          effort?: unknown
        }
        if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('sessions.open: cwd must be a string')
        if (prompt !== undefined && typeof prompt !== 'string') {
          throw new TypeError('sessions.open: prompt must be a string')
        }
        if (focus !== undefined && typeof focus !== 'boolean') throw new TypeError('sessions.open: focus must be a boolean')
        // Fast error naming the field; main checks again (shared/session-options.ts).
        const checked = checkSessionOptions({ model, effort })
        if (!checked.ok) throw new TypeError(`sessions.open: ${checked.reason}`)
        // Sent only when asked for: a request without them is the same as before the options existed.
        return (await call('sessions.open', {
          pluginId,
          cwd,
          prompt,
          ...(focus ? { focus: true } : {}),
          ...(checked.model ? { model: checked.model } : {}),
          ...(checked.effort ? { effort: checked.effort } : {})
        })) as { tabId: string }
      }),
    // A plain shell tab (the person's "+" > shell): only a cwd and focus, never a command, argv or
    // env; main checks the cwd and the shared open budget again.
    openShell: (options: { cwd?: string; focus?: boolean } = {}) =>
      guardAsync(async () => {
        const { cwd, focus } = (options ?? {}) as { cwd?: unknown; focus?: unknown }
        if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('sessions.openShell: cwd must be a string')
        if (focus !== undefined && typeof focus !== 'boolean') {
          throw new TypeError('sessions.openShell: focus must be a boolean')
        }
        return (await call('sessions.openShell', {
          pluginId,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(focus ? { focus: true } : {})
        })) as { tabId: string }
      }),
    // A command tab running `argv` with no shell, marked with this plugin. Only argv, cwd, title and
    // focus are sent (never an env); the argv rule is checked here for the fast error, and main checks
    // everything again (the title too) and spends the shared open budget.
    openCommand: (options: { argv: string[]; cwd?: string; title?: string; focus?: boolean }) =>
      guardAsync(async () => {
        const { argv, cwd, title, focus } = (options ?? {}) as { argv?: unknown; cwd?: unknown; title?: unknown; focus?: unknown }
        const checked = checkCommandArgv(argv)
        if (!checked.ok) throw new TypeError(`sessions.openCommand: ${checked.reason}`)
        if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('sessions.openCommand: cwd must be a string')
        if (title !== undefined && typeof title !== 'string') throw new TypeError('sessions.openCommand: title must be a string')
        if (focus !== undefined && typeof focus !== 'boolean') {
          throw new TypeError('sessions.openCommand: focus must be a boolean')
        }
        return (await call('sessions.openCommand', {
          pluginId,
          argv: checked.value,
          ...(cwd !== undefined ? { cwd } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(focus ? { focus: true } : {})
        })) as { tabId: string }
      })
  }
  return Object.freeze(api) as PluginContext['sessions']
}
