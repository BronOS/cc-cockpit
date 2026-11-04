// ctx.sessions (design §5 › sessions): this project window's Claude tabs. The host only asks; main
// answers from its own session registry, scoped to the project it spawned this host for, and every
// send goes through main's send gate (typed only while the tab waits for input, else queued). See
// src/main/plugins/host-api.ts for the checks on main's side.
//
// onChange: main pushes a `sessions` event with the project's whole list whenever one of its tabs
// changes (throttled there); the hub here fans it out to every plugin's listeners.
import type { Disposer, PluginContext, SendResult, SessionInfo } from '../../sdk/types'
import { errorText } from '../../shared/error-text'

type Listener = (sessions: SessionInfo[]) => void

export interface SessionsApiDeps {
  pluginId: string
  call(method: string, params: unknown): Promise<unknown>
  /** Throws when the plugin is deactivated. */
  alive(): void
  /** Rejects (instead of throwing) when the plugin is deactivated. */
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  hub: SessionsHub
}

/** The `sessions` listeners of every plugin of one host. */
export class SessionsHub {
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  add(pluginId: string, listener: Listener): Disposer {
    const set = this.listeners.get(pluginId) ?? new Set<Listener>()
    // A wrapper per registration: the same function added twice is two subscriptions, and each
    // disposer removes only its own.
    const entry: Listener = (sessions) => listener(sessions)
    set.add(entry)
    this.listeners.set(pluginId, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.listeners.get(pluginId) === set) this.listeners.delete(pluginId)
    }
  }

  /** The plugin is gone: its listeners hear nothing more. */
  removePlugin(pluginId: string): void {
    this.listeners.delete(pluginId)
  }

  /**
   * Main's `sessions` event: `{ sessions: SessionInfo[] }`. Each listener gets its own copy, so a
   * plugin that mutates the array does not change what the next one sees. A throwing listener is
   * logged against its plugin and does not stop the others.
   */
  handleEvent(params: unknown): void {
    const sessions = (params as { sessions?: unknown } | null)?.sessions
    if (!Array.isArray(sessions)) return
    for (const [pluginId, set] of [...this.listeners]) {
      for (const listener of [...set]) {
        try {
          listener(structuredClone(sessions) as SessionInfo[])
        } catch (err) {
          this.log(pluginId, `a sessions.onChange listener threw: ${errorText(err)}`)
        }
      }
    }
  }
}

export function createSessionsApi(deps: SessionsApiDeps): PluginContext['sessions'] {
  const { pluginId, call, guardAsync } = deps
  return Object.freeze({
    list: () => guardAsync(async () => (await call('sessions.list', {})) as SessionInfo[]),
    onChange: (listener: Listener): Disposer => {
      deps.alive()
      if (typeof listener !== 'function') throw new TypeError('sessions.onChange needs a function')
      return deps.hub.add(pluginId, listener)
    },
    send: (tabId: string, text: string) =>
      guardAsync(async () => {
        if (typeof tabId !== 'string' || typeof text !== 'string') {
          throw new TypeError('sessions.send needs a tab id and text')
        }
        return (await call('sessions.send', { pluginId, tabId, text })) as SendResult
      }),
    open: (options: { cwd?: string; prompt?: string; focus?: boolean } = {}) =>
      guardAsync(async () => {
        const { cwd, prompt, focus } = (options ?? {}) as { cwd?: unknown; prompt?: unknown; focus?: unknown }
        if (cwd !== undefined && typeof cwd !== 'string') throw new TypeError('sessions.open: cwd must be a string')
        if (prompt !== undefined && typeof prompt !== 'string') {
          throw new TypeError('sessions.open: prompt must be a string')
        }
        if (focus !== undefined && typeof focus !== 'boolean') throw new TypeError('sessions.open: focus must be a boolean')
        // Sent only when asked for: a request without it is the same as before the option existed.
        return (await call('sessions.open', { pluginId, cwd, prompt, ...(focus ? { focus: true } : {}) })) as { tabId: string }
      })
  })
}
