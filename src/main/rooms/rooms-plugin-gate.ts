// A room ends when its plugin is switched off in its project (or in all projects), uninstalled or revoked
// (design-rooms.md §1; enablement.ts roomEndReason says which). Two halves of one rule, both here so neither can
// drift from the other:
// - the sweep (`sweep`): main runs it whenever the plugin set may have changed (after the plugins load, on every
//   installer change, after a switch on the Plugins page or "Off in all projects") and it ends the live rooms whose
//   plugin is off; never before the load finished nor after a failed one, when every plugin would look removed and
//   every room would end;
// - the refusal (`offWhy`, HostApi's `roomsOff`): every ctx.rooms call is checked at call time. Hosts restart one
//   after another after a switch, and an uninstall awaits the other hosts' settings before any restart, so a host can
//   still run the old plugin seconds after the sweep. Without the refusal it could create a room, mint an invite or
//   open a member then, and nothing would end it until the next change (review finding M1, task 10).
import { roomEndReason, type EnablementPlugin, type EnablementRecord } from '../plugins/enablement'
import type { RoomOwner } from './room-registry'

export interface RoomsPluginGateDeps {
  /** The installed plugin (undefined once uninstalled) and whether the marketplace revoked it. */
  plugin(pluginId: string): { plugin: EnablementPlugin; revoked: boolean } | undefined
  /** The project's record (ProjectRegistry.enablementRecord): 'unknown' when unreadable, undefined when gone. */
  project(projectId: string): EnablementRecord | 'unknown' | undefined
  /** `AppSettings.disabledBundled` now ("Off in all projects"). */
  disabledBundled(): unknown
  /** RoomService.endRoomsOfPluginsOff. */
  endRoomsOfPluginsOff(offWhy: (owner: RoomOwner) => string | undefined): void
}

export class RoomsPluginGate {
  private ready = false

  constructor(private readonly deps: RoomsPluginGateDeps) {}

  /** Why the owner's rooms end now (the log's reason, and the refusal's), or undefined while its plugin is on there. */
  offWhy(owner: RoomOwner): string | undefined {
    const installed = this.deps.plugin(owner.pluginId)
    return roomEndReason(this.deps.project(owner.projectId), installed?.plugin, installed?.revoked === true, this.deps.disabledBundled())
  }

  /** The plugins finished loading: from now on the sweep runs, and it runs once now. Never after a failed load. */
  loaded(failed: boolean): void {
    if (failed) return
    this.ready = true
    this.sweep()
  }

  /** End the live rooms whose plugin is off; a no-op until the plugins loaded. */
  sweep(): void {
    if (!this.ready) return
    this.deps.endRoomsOfPluginsOff((owner) => this.offWhy(owner))
  }
}
