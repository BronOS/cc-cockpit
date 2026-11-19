// Which plugins guests see (design-guests §6, §16.1, D-17): the owner's per-plugin setting, an app-wide
// value (`app.json › pluginGuestAccess`) with a per-project override (the project record's), hidden by
// default, bundled plugins included. The rule is shared/guest-access.ts (`guestVisibility`, `guestPort`), the
// one the Plugins page reads through `PluginView.guestAccess`; this service only feeds it the stored values
// and the manifest, so main and the page cannot disagree.
//
// Read live on every call (a port connect, a page path, a guest filter): nothing is cached, so a change
// holds for the next call. Who may set what (`shown` is a widening, owner views only, D-11) is the router's;
// the service takes no caller (main/ipc/guest-deps.ts).
//
// What a plugin's guests can do with it is generic data the page turns into text (spec-review 18): the
// manifest's `guests.aware` and the port each role gets, never a plugin's own words.

import { errorText } from '../../shared/error-text'
import { guestPort, guestVisibility, guestVisibilityOf, type GuestAccessResult, type GuestVisibility } from '../../shared/guest-access'
import type { PluginManifest } from '../../shared/manifest'
import type { GuestRole } from '../../shared/views'
import type { PluginGuestAccessService } from '../ipc/guest-deps'
import { warnLog } from '../warn-log'

/** Where the values live (ProjectRegistry). */
export interface GuestAccessRecords {
  pluginGuestAccess(target: 'app' | { projectId: string }): Record<string, unknown>
  setPluginGuestAccess(target: 'app' | { projectId: string }, pluginId: string, value: GuestVisibility | null): boolean
  dropPluginGuestAccess(pluginId: string): void
}

export interface PluginGuestAccessDeps {
  records: GuestAccessRecords
  /**
   * The installed plugin (bundled, folder or git) with its manifest, or undefined when no plugin has the id
   * (PluginInstaller.get). A plugin whose manifest did not load has none: it is hidden (no `aware`), and its
   * stored value is kept for when it loads again.
   */
  installed(pluginId: string): { manifest?: Pick<PluginManifest, 'guests' | 'access'> } | undefined
  /** A project id the registry knows (ProjectRegistry.get), for a project override. */
  knownProject(projectId: string): boolean
}

/** What the Plugins page shows for one plugin (PluginView.guestAccess). */
export type PluginGuestAccessView = GuestAccessResult & {
  appValue?: GuestVisibility
  projectValue?: GuestVisibility
}

export class PluginGuestAccessStore implements PluginGuestAccessService {
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: PluginGuestAccessDeps) {}

  /**
   * The rule's answer for the plugin in the project (no project: the app value only, as on the global page),
   * with the stored values. Undefined for an id no installed plugin has.
   */
  view(pluginId: string, projectId?: string): PluginGuestAccessView | undefined {
    const plugin = this.deps.installed(pluginId)
    if (plugin === undefined) return undefined
    const appValue = guestVisibilityOf(this.stored('app', pluginId))
    const projectValue = projectId !== undefined ? guestVisibilityOf(this.stored({ projectId }, pluginId)) : undefined
    const result = guestVisibility({ manifest: plugin.manifest, appValue, projectValue })
    return {
      ...result,
      ...(appValue !== undefined ? { appValue } : {}),
      ...(projectValue !== undefined ? { projectValue } : {})
    }
  }

  visible(projectId: string, pluginId: string): boolean {
    return this.view(pluginId, projectId)?.effective === 'shown'
  }

  port(projectId: string, pluginId: string, role: GuestRole): 'none' | 'oneWay' | 'full' {
    const view = this.view(pluginId, projectId)
    return view === undefined ? 'none' : guestPort(view, role)
  }

  set(pluginId: string, target: 'app' | 'project', value: GuestVisibility | null, projectId?: string): boolean {
    if (typeof pluginId !== 'string' || this.deps.installed(pluginId) === undefined) return false
    if (value !== null && guestVisibilityOf(value) === undefined) return false
    if (target !== 'app' && target !== 'project') return false
    if (target === 'project' && (typeof projectId !== 'string' || !this.deps.knownProject(projectId))) return false
    const changed = this.deps.records.setPluginGuestAccess(target === 'app' ? 'app' : { projectId: projectId as string }, pluginId, value)
    if (changed) this.emit()
    return true
  }

  /** The plugin was uninstalled: its values go everywhere, so a reinstall starts hidden (like `pluginLimits`). */
  drop(pluginId: string): void {
    this.deps.records.dropPluginGuestAccess(pluginId)
    this.emit()
  }

  onChange(listener: () => void): () => void {
    const entry = (): void => listener()
    this.listeners.add(entry)
    return () => void this.listeners.delete(entry)
  }

  private stored(target: 'app' | { projectId: string }, pluginId: string): unknown {
    const values = this.deps.records.pluginGuestAccess(target)
    return Object.hasOwn(values, pluginId) ? values[pluginId] : undefined
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (err) {
        warnLog(`plugin guest access: a change listener threw: ${errorText(err)}`)
      }
    }
  }
}
