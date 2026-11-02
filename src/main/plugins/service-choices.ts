// Per-project service provider picks (plan: plugin services, Task 5): the Plugins page's status and
// its "Plugin used for <service>" select. The project id always comes from the router (the asking
// window), never from the renderer; the service and plugin names in a payload are checked against
// the set the project's host runs, so a renderer cannot pick a plugin of another project or one
// that does not provide the service.
import { SERVICE_NAME_PATTERN } from '../../shared/manifest'
import { providersOf, serviceStatus, type ServicePlugin, type ServicesStatus } from '../../shared/services'

export interface ServiceChoicesDeps {
  /** The plugins the project's host runs, with their `services` (HostManager.servicePlugins). */
  plugins(projectId: string): Promise<ServicePlugin[]>
  /** The project record's picks (ProjectRegistry.serviceProviders). */
  choices(projectId: string): Record<string, string>
  /** Save one pick, or clear it with null; true when the record changed. */
  setChoice(projectId: string, service: string, pluginId: string | null): boolean
  /** Restart the project's host: the picks travel with `activate`, so a change needs a new launch. */
  restart(projectId: string): Promise<void>
}

export class ServiceChoices {
  constructor(private readonly deps: ServiceChoicesDeps) {}

  /** `serviceStatus` over the host's set and the stored picks (a stale pick reads as none). */
  async status(projectId: string): Promise<ServicesStatus> {
    return serviceStatus(await this.deps.plugins(projectId), this.deps.choices(projectId))
  }

  /**
   * Pick the plugin that answers `service` in this project, or clear the pick with null. The
   * service must be one some plugin of the project's set provides or uses; a plugin must be one of
   * its providers there. Restarts the host only when the stored value changed.
   */
  async setProvider(projectId: string, service: unknown, pluginId: unknown): Promise<void> {
    if (typeof service !== 'string' || !SERVICE_NAME_PATTERN.test(service)) throw new Error('bad service name')
    if (pluginId !== null && typeof pluginId !== 'string') throw new Error('pluginId must be a string or null')
    const plugins = await this.deps.plugins(projectId)
    const known = plugins.some(
      (p) => Object.hasOwn(p.services?.provides ?? {}, service) || Object.hasOwn(p.services?.uses ?? {}, service)
    )
    if (!known) throw new Error(`no plugin in this project provides or uses service "${service}"`)
    if (pluginId !== null && !providersOf(service, plugins).includes(pluginId)) {
      throw new Error(`${pluginId} does not provide service "${service}" in this project`)
    }
    if (this.deps.setChoice(projectId, service, pluginId)) await this.deps.restart(projectId)
  }
}
