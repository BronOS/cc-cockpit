// ctx.settingsPage (design-next §5.4): the backend of a plugin's html settings page, the page from
// `contributes.settings.page` that Settings shows under the plugin's schema form.
//
//   ctx.settingsPage.onOpen(listener)   the page opened in this window; the listener gets a
//                                       SettingsPageInstance { scope, post, onMessage, onClose }
//
// The page is the shell's: it mounts it and main hands this host one end of its channel, tagged
// `{ "settingsPageOpen": { pluginId, id, scope } }` with the port in the transfer list
// (src/main/plugins/host-manager.ts sendSettingsPagePort, host/index.ts receivePort). One page per
// plugin at a time: a new open ends the older one first (main closes it too). The page ends with
// main's `settingsPage.close { pluginId, id }` event, or when its end of the port closes. Messages
// follow the panel rules (host/ctx/ui.ts): ONE JSON string each, the same 1 MiB cap. A page in a
// remote (browser) view comes with that view in its tag (`view`), and its message listeners run in
// it (origin-view.ts), as a panel's do: what they open or focus shows on that screen.
//
// The page has no settings API: the plugin keeps what it edits where it wants and never posts a
// secret to it (a page is a web page; the guide says so).
import type { Disposer, PluginContext, SettingsPageInstance } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import type { SettingsPageScope } from '../../shared/manifest'
import { isSettingsPageScope, SETTINGS_PAGE_ID_PATTERN } from '../../shared/settings-page'
import { viewIdOf, type ViewId } from '../../shared/views'
import { PortLine } from './port-line'
import type { PanelPort } from './ui'

/** main's tag is a handful of short fields. */
const MAX_TAG_LENGTH = 512

export interface SettingsPageOpenTag {
  pluginId: string
  id: string
  scope: SettingsPageScope
  /** The remote view the page is in; absent for the desktop's page. */
  view?: ViewId
}

/** main's port message `{ "settingsPageOpen": {...} }` (sent with the port), or undefined for anything else. */
export function settingsPageOpenTag(data: unknown): SettingsPageOpenTag | undefined {
  if (typeof data !== 'string' || data.length > MAX_TAG_LENGTH) return undefined
  try {
    const tag = (JSON.parse(data) as { settingsPageOpen?: Record<string, unknown> } | null)?.settingsPageOpen
    if (typeof tag !== 'object' || tag === null) return undefined
    const { pluginId, id, scope } = tag
    if (typeof pluginId !== 'string' || typeof id !== 'string' || !SETTINGS_PAGE_ID_PATTERN.test(id)) return undefined
    if (!isSettingsPageScope(scope)) return undefined
    // A view main did not mint is refused, never read as the desktop's page (as slots.ts does).
    const view = viewIdOf(tag.view)
    if (tag.view !== undefined && view === undefined) return undefined
    return { pluginId, id, scope, ...(view !== undefined ? { view } : {}) }
  } catch {
    // Not one of main's port messages.
  }
  return undefined
}

/** The open page of one plugin. */
interface Page {
  readonly pluginId: string
  readonly id: string
  /** The line to the page, in the remote view it is in (undefined for the desktop's). */
  readonly line: PortLine
}

/** The open settings pages and `onOpen` listeners of every plugin of one host. */
export class SettingsPageHub {
  /** pluginId -> listeners. */
  private readonly openers = new Map<string, Set<(page: SettingsPageInstance) => void>>()
  /** pluginId -> its one open page. */
  private readonly pages = new Map<string, Page>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  onOpen(pluginId: string, listener: (page: SettingsPageInstance) => void): Disposer {
    const set = this.openers.get(pluginId) ?? new Set<(page: SettingsPageInstance) => void>()
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry = (page: SettingsPageInstance): void => listener(page)
    set.add(entry)
    this.openers.set(pluginId, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.openers.get(pluginId) === set) this.openers.delete(pluginId)
    }
  }

  /**
   * A page opened (host/index.ts calls this for main's `settingsPageOpen` port). The caller checked
   * the plugin runs here and declares the scope. The plugin's open page, if any, ends first.
   */
  open(tag: SettingsPageOpenTag, port: PanelPort): void {
    const old = this.pages.get(tag.pluginId)
    if (old) old.line.end()
    const line = new PortLine(
      port,
      tag.view,
      { kind: 'settings page', who: 'the settings page', postTo: '' },
      (message) => this.log(tag.pluginId, message),
      () => {
        if (this.pages.get(tag.pluginId) === page) this.pages.delete(tag.pluginId)
      }
    )
    const page: Page = { pluginId: tag.pluginId, id: tag.id, line }
    this.pages.set(tag.pluginId, page)
    const instance = this.instanceOf(page, tag.scope)
    const listeners = [...(this.openers.get(tag.pluginId) ?? [])]
    if (listeners.length === 0) this.log(tag.pluginId, 'the settings page opened but no settingsPage.onOpen listener is registered (yet)')
    for (const listener of listeners) {
      try {
        listener(instance)
      } catch (err) {
        this.log(tag.pluginId, `a settingsPage.onOpen listener threw: ${errorText(err)}`)
      }
    }
  }

  /** main's `settingsPage.close { pluginId, id }`, or the page's port closing (`port`: only that page's own). */
  close(pluginId: string, id: string, port?: PanelPort): void {
    const page = this.pages.get(pluginId)
    if (page && page.id === id && (port === undefined || page.line.port === port)) page.line.end()
  }

  /** The plugin is gone: its page ends (onClose runs) and its listeners drop. */
  removePlugin(pluginId: string): void {
    this.pages.get(pluginId)?.line.end()
    this.openers.delete(pluginId)
  }

  /** Whether the plugin has a page open (tests). */
  isOpen(pluginId: string): boolean {
    return this.pages.has(pluginId)
  }

  private instanceOf(page: Page, scope: SettingsPageScope): SettingsPageInstance {
    const { post, onMessage, onClose } = page.line
    return Object.freeze({ scope, post, onMessage, onClose })
  }

}

export interface SettingsPageApiDeps {
  pluginId: string
  /** The manifest declares `contributes.settings.page`; `onOpen` throws otherwise. */
  declared: boolean
  /** Throws when the plugin is deactivated. */
  alive(): void
  hub: SettingsPageHub
}

export function createSettingsPageApi(deps: SettingsPageApiDeps): PluginContext['settingsPage'] {
  return Object.freeze({
    onOpen: (listener: (page: SettingsPageInstance) => void): Disposer => {
      deps.alive()
      if (!deps.declared) throw new Error('settingsPage.onOpen: plugin.json declares no contributes.settings.page')
      if (typeof listener !== 'function') throw new TypeError('settingsPage.onOpen needs a function')
      return deps.hub.onOpen(deps.pluginId, listener)
    }
  })
}
