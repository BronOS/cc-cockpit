// Per-project service provider picks (plan: plugin services, Task 5): the Plugins page's status and
// its "Plugin used for <service>" select. The project id always comes from the router (the asking
// window), never from the renderer; the service and plugin names in a payload are checked against
// the set the project's host runs, so a renderer cannot pick a plugin of another project or one
// that does not provide the service.
//
// The open-file pick (friction round 1, Task 12) lives here too: same page, same record map, same
// selection rule, under the reserved key OPEN_FILE_PICK. Its value is a plugin of the set that
// declares `contributes.openFile`, or BUILTIN_VIEWER. It needs no host restart: main routes each
// click itself (sessions/open-file.ts) and reads the pick then.
//
// Slot picks (design-next §2) too, under `@slot:<type>`: a plugin of the set that declares the
// type in `contributes.slots`, or SLOT_NONE to turn the type off. No restart either: the host does
// not choose a slot's provider, main does when it lays the slot out.
import { SERVICE_NAME_PATTERN } from '../../shared/manifest'
import {
  BUILTIN_VIEWER,
  OPEN_FILE_PICK,
  openFileStatus,
  providersOf,
  serviceStatus,
  slotStatus,
  type OpenFilePlugin,
  type PluginServicesView,
  type ServicePlugin,
  type SlotPlugin
} from '../../shared/services'
import { SLOT_NONE, SLOT_PICK_PREFIX, slotTypeOfPickKey } from '../../shared/slots'

export interface ServiceChoicesDeps {
  /** The plugins the project's host runs, with their `services`, `openFile` and `slots` (HostManager.servicePlugins). */
  plugins(projectId: string): Promise<(ServicePlugin & OpenFilePlugin & SlotPlugin)[]>
  /** The project record's picks (ProjectRegistry.serviceProviders). */
  choices(projectId: string): Record<string, string>
  /** Save one pick, or clear it with null; true when the record changed. */
  setChoice(projectId: string, service: string, pluginId: string | null): boolean
  /** Restart the project's host: the picks travel with `activate`, so a change needs a new launch. */
  restart(projectId: string): Promise<void>
}

export class ServiceChoices {
  constructor(private readonly deps: ServiceChoicesDeps) {}

  /** `serviceStatus`, `openFileStatus` and `slotStatus` over the host's set and the stored picks (a stale pick reads as none). */
  async status(projectId: string): Promise<PluginServicesView> {
    const plugins = await this.deps.plugins(projectId)
    const choices = this.deps.choices(projectId)
    return { ...serviceStatus(plugins, choices), openFile: openFileStatus(plugins, choices), slots: slotStatus(plugins, choices) }
  }

  /**
   * Pick the plugin that answers `service` in this project, or clear the pick with null. The
   * service must be one some plugin of the project's set provides or uses; a plugin must be one of
   * its providers there. Restarts the host only when the stored value changed.
   */
  async setProvider(projectId: string, service: unknown, pluginId: unknown): Promise<void> {
    if (service === OPEN_FILE_PICK) return this.setOpenFile(projectId, pluginId)
    if (typeof service === 'string' && service.startsWith(SLOT_PICK_PREFIX)) return this.setSlot(projectId, service, pluginId)
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

  /**
   * The plugin that takes a Sessions panel file click in this project: one of the project's plugins
   * that declare `contributes.openFile`, BUILTIN_VIEWER, or null to clear the pick. No restart.
   */
  private async setOpenFile(projectId: string, pluginId: unknown): Promise<void> {
    if (pluginId !== null && typeof pluginId !== 'string') throw new Error('pluginId must be a string or null')
    if (pluginId !== null && pluginId !== BUILTIN_VIEWER) {
      const plugins = await this.deps.plugins(projectId)
      if (!plugins.some((p) => p.id === pluginId && p.openFile !== undefined)) {
        throw new Error(`${pluginId} does not open files in this project`)
      }
    }
    this.deps.setChoice(projectId, OPEN_FILE_PICK, pluginId)
  }

  /**
   * The plugin that draws slots of a type in this project: one of the project's plugins that
   * declare the type in `contributes.slots`, SLOT_NONE (off), or null to clear the pick. No restart.
   */
  private async setSlot(projectId: string, key: string, pluginId: unknown): Promise<void> {
    const type = slotTypeOfPickKey(key)
    if (type === undefined) throw new Error('bad slot type')
    if (pluginId !== null && typeof pluginId !== 'string') throw new Error('pluginId must be a string or null')
    if (pluginId !== null && pluginId !== SLOT_NONE) {
      const plugins = await this.deps.plugins(projectId)
      if (!plugins.some((p) => p.id === pluginId && (p.slots ?? []).some((sl) => sl.type === type))) {
        throw new Error(`${pluginId} does not provide slot "${type}" in this project`)
      }
    }
    this.deps.setChoice(projectId, key, pluginId)
  }
}
