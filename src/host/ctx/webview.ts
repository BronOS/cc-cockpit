// ctx.webview (plan B Task 7): drive the native web view of one of the plugin's own `"kind":
// "webview"` panels. The view lives in main (only main can create one safely); every call is a
// request that main checks again against the host's own window and the plugin's declared webview
// panels (src/main/plugins/host-api.ts), and main decides what a target may be and where a page
// may go (src/main/webview/webview-manager.ts). Here the panel id is checked at the call site, so
// a plugin author sees the mistake where it is made.
//
//   navigate(panelId, target)   an http(s) URL or an absolute file path (served read-only through
//                               cc-preview://); resolves once the page loaded (at most 10 s),
//                               rejects when it failed to load first
//   back / forward / reload     no-ops before the first navigate (there is no view yet)
//   current(panelId)            { url, title, error? }, empty strings before the first navigate
//   onNavigate(panelId, fn)     the page committed, failed or its title changed (main's
//                               `webview.navigated`)
import type { Disposer, PluginContext, WebviewPage } from '../../sdk/types'
import { errorText } from '../../shared/error-text'

type NavigateListener = (page: WebviewPage) => void

/** A page from main: url and title strings, `error` only when main sent a non-empty string. */
function pageOf(url: string, title: string, error: unknown): WebviewPage {
  return typeof error === 'string' && error !== '' ? { url, title, error } : { url, title }
}

/** onNavigate listeners of every plugin of one host, keyed `<pluginId>/<panelId>`. */
export class WebviewHub {
  private readonly listeners = new Map<string, Set<NavigateListener>>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  on(pluginId: string, panelId: string, listener: NavigateListener): Disposer {
    const key = `${pluginId}/${panelId}`
    const set = this.listeners.get(key) ?? new Set<NavigateListener>()
    const entry: NavigateListener = (page) => listener(page)
    set.add(entry)
    this.listeners.set(key, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key)
    }
  }

  /** main's `webview.navigated { pluginId, panelId, url, title, error? }`; anything malformed is dropped. */
  handleEvent(params: unknown): void {
    const { pluginId, panelId, url, title, error } = (params ?? {}) as Record<string, unknown>
    if (typeof pluginId !== 'string' || typeof panelId !== 'string' || typeof url !== 'string' || typeof title !== 'string') return
    for (const listener of [...(this.listeners.get(`${pluginId}/${panelId}`) ?? [])]) {
      try {
        // Each listener gets its own object: one cannot change what the next one sees.
        listener(pageOf(url, title, error))
      } catch (err) {
        this.log(pluginId, `a webview.onNavigate listener threw: ${errorText(err)}`)
      }
    }
  }

  removePlugin(pluginId: string): void {
    const prefix = `${pluginId}/`
    for (const key of [...this.listeners.keys()]) if (key.startsWith(prefix)) this.listeners.delete(key)
  }
}

export interface WebviewApiDeps {
  pluginId: string
  /** The plugin's declared panels of kind `webview` (main sent them in the spec). */
  webviewPanels: readonly string[]
  call(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  alive(): void
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  hub: WebviewHub
  /** The ctx drove a view: its dispose must tell main (the `plugin.disposed` event), which closes it. */
  used(): void
}

export function createWebviewApi(deps: WebviewApiDeps): PluginContext['webview'] {
  const { pluginId } = deps
  /** At the call site, synchronously (like ctx.badge): main would refuse it too, but only later. */
  const declared = (panelId: unknown, what: string): string => {
    deps.alive()
    if (typeof panelId !== 'string' || !deps.webviewPanels.includes(panelId)) {
      throw new Error(`webview.${what}: panel "${String(panelId)}" is not a "webview" panel declared in plugin.json contributes.panels`)
    }
    return panelId
  }
  const request = (method: string, panelId: string, extra: Record<string, unknown> = {}): Promise<unknown> =>
    deps.guardAsync(() => deps.call(`webview.${method}`, { pluginId, panelId, ...extra }))
  return Object.freeze({
    navigate: (panelId: string, target: string): Promise<void> => {
      const id = declared(panelId, 'navigate')
      if (typeof target !== 'string' || target === '') throw new TypeError('webview.navigate needs a URL or an absolute file path')
      deps.used()
      return request('navigate', id, { target }).then(() => undefined)
    },
    back: (panelId: string): Promise<void> => request('back', declared(panelId, 'back')).then(() => undefined),
    forward: (panelId: string): Promise<void> => request('forward', declared(panelId, 'forward')).then(() => undefined),
    reload: (panelId: string): Promise<void> => request('reload', declared(panelId, 'reload')).then(() => undefined),
    current: (panelId: string): Promise<WebviewPage> =>
      request('current', declared(panelId, 'current')).then((raw) => {
        const page = raw as Partial<WebviewPage> | null
        return pageOf(typeof page?.url === 'string' ? page.url : '', typeof page?.title === 'string' ? page.title : '', page?.error)
      }),
    onNavigate: (panelId: string, listener: (page: WebviewPage) => void): Disposer => {
      const id = declared(panelId, 'onNavigate')
      if (typeof listener !== 'function') throw new TypeError('webview.onNavigate needs a function')
      return deps.hub.on(pluginId, id, listener)
    }
  })
}
