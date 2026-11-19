// Which plugins a guest sees (design-guests §6, §16.1): the owner's per-plugin setting, an app-wide value
// with a per-project override like other plugin settings, hidden by default, bundled plugins included
// (no special case for `cockpit.*`: a bundled plugin is hidden until the owner shows it, like any other).
//
// One resolver for main (port tags, page paths, the guest filters) and the Plugins page (through
// `PluginView.guestAccess`), as `serviceStatus` is for services, so the page never shows a plugin as
// shown that main keeps hidden.
//
// Pure: no Node, DOM or Electron imports.

import { isGuestAware, seesAllSessions, type PluginManifest } from './manifest'
import type { GuestRole } from './views'

export type GuestVisibility = 'hidden' | 'shown'

/** What the resolver reads: the manifest's declarations and the two stored values (absent = use the next). */
export interface GuestAccessInput {
  manifest: Pick<PluginManifest, 'guests' | 'access'> | undefined
  /** `app.json › pluginGuestAccess[id]`. */
  appValue: GuestVisibility | undefined
  /** The project record's `pluginGuestAccess[id]`. */
  projectValue: GuestVisibility | undefined
}

export interface GuestAccessResult {
  /** What guests get: `hidden` whenever `blocked`, whatever the stored values say. */
  effective: GuestVisibility
  /** Where the value came from (the Plugins page says "from global" / "this project"). */
  source: 'project' | 'app' | 'default'
  /** The manifest declares `guests.aware`. */
  aware: boolean
  /**
   * Hidden whatever the owner sets. `all-windows`: the plugin sees every window's sessions (other
   * projects) and does not declare that it checks the viewer, so its panel could show a guest another
   * project.
   */
  blocked?: 'all-windows'
}

/** A stored value from untrusted input (`app.json` and the projects file are user-writable): anything else is absent. */
export function guestVisibilityOf(raw: unknown): GuestVisibility | undefined {
  return raw === 'hidden' || raw === 'shown' ? raw : undefined
}

/** The effective visibility of one plugin for guests of one project. Default hidden. */
export function guestVisibility(input: GuestAccessInput): GuestAccessResult {
  const aware = isGuestAware(input.manifest)
  const projectValue = guestVisibilityOf(input.projectValue)
  const appValue = guestVisibilityOf(input.appValue)
  const [stored, source]: [GuestVisibility, GuestAccessResult['source']] =
    projectValue !== undefined ? [projectValue, 'project'] : appValue !== undefined ? [appValue, 'app'] : ['hidden', 'default']
  if (seesAllSessions(input.manifest) && !aware) return { effective: 'hidden', source, aware, blocked: 'all-windows' }
  return { effective: stored, source, aware }
}

/**
 * The port a guest of `role` gets to the plugin's pages (D-17): none while the plugin is hidden; a
 * write guest a full port (trusted to type into the host's shell anyway); a read guest a full port
 * only when the plugin is guest-aware, else one-way (main drops the page's messages to the host,
 * so a plugin that never checks `access` cannot be driven to change state by a watcher).
 */
export function guestPort(r: GuestAccessResult, role: GuestRole): 'none' | 'oneWay' | 'full' {
  if (r.effective !== 'shown' || r.blocked !== undefined) return 'none'
  if (role === 'write' || r.aware) return 'full'
  return 'oneWay'
}
