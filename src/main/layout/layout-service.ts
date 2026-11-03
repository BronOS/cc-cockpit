// Which panels exist for a project, and the project's zone layout reconciled with them (Task 18).
// main owns this: the renderer asks for the view and sends layouts back, and main re-validates
// every one against the panels that exist, so a page cannot place a panel that is not there.
//
// Panels come from two places: the core ones below and, per project, those of its enabled plugins
// (Task 25 and later call `setPluginPanels`). A panel's badge, error and header (ctx.panels.header)
// are plugin-reported state kept here, not in the persisted layout.
import type { PanelKind } from '../../shared/manifest'
import type { LayoutView, PanelBadge, PanelHeaderInfo, PanelInfo } from '../../shared/ipc'
import {
  ZONE_IDS,
  isZoneId,
  movePanel,
  normalizeLayout,
  reconcile,
  showPanel,
  zoneOf,
  type AvailablePanel,
  type LayoutState,
  type ZoneId
} from '../../shared/layout'
import { pluginFileUrl } from '../plugins/plugin-protocol'

interface CorePanel {
  panelKey: string
  title: string
  icon: string
  defaultZone: ZoneId
}

/** Core panels. `core/sessions` is the built-in Sessions panel (renderer/sessions/SessionsPanel.tsx). */
export const CORE_PANELS: readonly CorePanel[] = [
  { panelKey: 'core/sessions', title: 'Sessions', icon: 'S', defaultZone: 'right' }
]

/** A panel a plugin's manifest declares (design §5: id, title, entry, defaultZone). */
export interface PluginPanelDef {
  id: string
  title: string
  /** The manifest's `icon`: an image file, relative to the plugin folder (served at cc-plugin://). */
  icon?: string
  defaultZone: ZoneId
  /** The manifest's `entry`: the page, relative to the plugin folder (served at cc-plugin://). */
  entry?: string
  /** The manifest's `kind`; absent is `html`. A `webview` panel has no `entry` (webview-manager.ts). */
  kind?: PanelKind
}

export interface PanelStatus {
  badge?: PanelBadge
  error?: string
  /** Already checked and built by HostApi (host-api.ts), the only caller; stored as given. */
  header?: PanelHeaderInfo
}

export interface LayoutServiceDeps {
  /** The project's stored layout; undefined for an unknown project. */
  getLayout(projectId: string): LayoutState | undefined
  setLayout(projectId: string, layout: LayoutState): void
  /** Tell the project's window the view changed (a no-op when it has none open). */
  publish(projectId: string, view: LayoutView): void
  /**
   * The plugins enabled for the project (its record). A stored panel of an enabled plugin that has
   * not declared its panels yet is kept in place by `set` (see there). Absent: none are.
   */
  enabledPlugins?(projectId: string): readonly string[]
}

const MAX_BADGE_COUNT = 99_999
const MAX_ERROR_LENGTH = 500

export class LayoutService {
  /** projectId -> pluginId -> declared panels. */
  private readonly plugin = new Map<string, Map<string, PluginPanelDef[]>>()
  /** projectId -> panelKey -> reported badge/error. */
  private readonly status = new Map<string, Map<string, PanelStatus>>()

  constructor(private readonly deps: LayoutServiceDeps) {}

  /**
   * The project's layout reconciled with its panels. Never stored from here: `layout.get` at
   * window open runs before any plugin has declared its panels, and storing that reconcile would
   * move every plugin panel into `remembered`, from where it comes back at the END of its zone,
   * so the user's panel order would be lost on every reopen. Only `set` (a user edit) stores; a
   * stale entry is reconciled away on every read until then.
   */
  view(projectId: string): LayoutView | undefined {
    const stored = this.deps.getLayout(projectId)
    if (!stored) return undefined
    return { layout: reconcile(stored, this.available(projectId)), panels: this.infos(projectId) }
  }

  /**
   * Store a layout the renderer sent. Whatever it holds is normalized and reconciled first;
   * unusable parts fall back to defaults rather than throwing. Answers with what was stored.
   */
  set(projectId: string, raw: unknown): LayoutView | undefined {
    const stored = this.deps.getLayout(projectId)
    if (!stored) return undefined
    // A user edit (a toggle, a splitter) can arrive before the plugin host has declared its
    // panels: the window shows its layout at once, the host launch takes a moment. The page never
    // saw those panels (view() leaves them out), so a plain reconcile would move them into
    // `remembered`, from where they return at the END of their zone and the user's order is lost,
    // the same trap view() avoids. They keep their stored place instead, until declared.
    const pending = this.pendingPanels(projectId, stored)
    const next = keepPlaces(normalizeLayout(raw), stored, pending)
    const pendingAvailable = pending.map((panelKey) => ({ panelKey, defaultZone: zoneOf(stored, panelKey) ?? 'left' }))
    const layout = reconcile(next, [...this.available(projectId), ...pendingAvailable])
    this.deps.setLayout(projectId, layout)
    // The page gets the layout of the panels it can show, as from view().
    return { layout: reconcile(layout, this.available(projectId)), panels: this.infos(projectId) }
  }

  /**
   * Panels the stored layout places or hides whose plugin is enabled for the project but has not
   * declared any panels yet. A disabled plugin's panels are not pending: they go to `remembered`.
   */
  private pendingPanels(projectId: string, stored: LayoutState): string[] {
    const enabled = new Set(this.deps.enabledPlugins?.(projectId) ?? [])
    if (enabled.size === 0) return []
    const declared = this.plugin.get(projectId)
    const keys = [...ZONE_IDS.flatMap((z) => stored.zones[z].panels.map((p) => p.panelKey)), ...stored.hidden]
    return keys.filter((key) => {
      const pluginId = key.slice(0, key.indexOf('/'))
      return enabled.has(pluginId) && !declared?.has(pluginId)
    })
  }

  /**
   * Move a panel to the end of `zone` (a hidden one comes back), the settings screen's "panel
   * zone" choice. Stores and publishes like a user edit of the layout. Throws for a zone or panel
   * that does not exist for the project; a panel already in the zone stays where it is.
   */
  move(projectId: string, panelKey: string, zone: unknown): LayoutView | undefined {
    if (!isZoneId(zone)) throw new Error('unknown zone')
    const stored = this.deps.getLayout(projectId)
    if (!stored) return undefined
    const current = reconcile(stored, this.available(projectId))
    if (zoneOf(current, panelKey) === zone) return { layout: current, panels: this.infos(projectId) }
    const next = movePanel(current, panelKey, zone)
    // movePanel leaves a layout alone when the panel is neither placed nor hidden.
    if (next === current) throw new Error('unknown panel')
    const view = this.set(projectId, next)
    if (view) this.deps.publish(projectId, view)
    return view
  }

  /**
   * Show a panel (ctx.panels.show): unhidden, opened, its zone expanded (shared/layout.ts
   * showPanel). Stores like a user edit when that changes anything. Publishes either way, with
   * `reveal` set: a panel already open in an expanded zone may still be off screen because the
   * window auto-hid that zone for a narrow terminal (renderer/zones/auto-hide.ts), which the stored
   * layout does not record. False for a panel the project does not have now.
   */
  show(projectId: string, panelKey: string): boolean {
    if (!this.hasKey(projectId, panelKey)) return false
    const stored = this.deps.getLayout(projectId)
    if (!stored) return false
    const current = reconcile(stored, this.available(projectId))
    const fallback = this.available(projectId).find((p) => p.panelKey === panelKey)?.defaultZone ?? 'left'
    const next = showPanel(current, panelKey, fallback)
    const view = next === current ? this.view(projectId) : this.set(projectId, next)
    if (view) this.deps.publish(projectId, { ...view, reveal: panelKey })
    return true
  }

  /**
   * The plugin and panel id of `panelKey` when it is a `"kind": "webview"` panel the project has
   * now (a plugin of it declared it), else undefined: the renderer's webview reports name a panel
   * by key, and only these may reach the view manager.
   */
  webviewPanel(projectId: string, panelKey: unknown): { pluginId: string; panelId: string } | undefined {
    if (typeof panelKey !== 'string') return undefined
    const cut = panelKey.lastIndexOf('/')
    if (cut <= 0) return undefined
    const pluginId = panelKey.slice(0, cut)
    const panelId = panelKey.slice(cut + 1)
    const def = this.plugin.get(projectId)?.get(pluginId)?.find((p) => p.id === panelId)
    return def?.kind === 'webview' ? { pluginId, panelId } : undefined
  }

  /** Replace the panels one plugin declares for a project (empty: the plugin has none/is off). */
  setPluginPanels(projectId: string, pluginId: string, panels: readonly PluginPanelDef[]): void {
    const byPlugin = this.plugin.get(projectId) ?? new Map<string, PluginPanelDef[]>()
    if (panels.length === 0) byPlugin.delete(pluginId)
    else byPlugin.set(pluginId, [...panels])
    if (byPlugin.size === 0) this.plugin.delete(projectId)
    else this.plugin.set(projectId, byPlugin)
    this.dropStaleStatus(projectId)
    this.publish(projectId)
  }

  /**
   * Set (or with `undefined` clear) the badge and error of a panel. False for a panel that does
   * not exist for the project. A count is clamped to a non-negative integer; 0 shows no badge.
   */
  setStatus(projectId: string, panelKey: string, status: PanelStatus | undefined): boolean {
    if (!this.hasKey(projectId, panelKey)) return false
    const clean = status ? cleanStatus(status) : undefined
    const map = this.status.get(projectId) ?? new Map<string, PanelStatus>()
    if (clean) map.set(panelKey, clean)
    else map.delete(panelKey)
    if (map.size === 0) this.status.delete(projectId)
    else this.status.set(projectId, map)
    this.publish(projectId)
    return true
  }

  /**
   * Set (null clears) only the badge of a panel, keeping its error: a plugin's ctx.badge must not
   * hide the ⚠ of its failing job, and the ⚠ coming or going must not wipe the badge. False for
   * a panel that does not exist for the project. An unchanged badge publishes nothing, so a
   * plugin that sets the same count on every tick does not redraw the window each time.
   */
  setBadge(projectId: string, panelKey: string, badge: PanelBadge | null): boolean {
    return this.patch(projectId, panelKey, { badge: badge ?? undefined })
  }

  /**
   * Set (null clears) only the header of a panel, keeping its badge and error. False for a panel
   * the project does not have; an unchanged header publishes nothing (a plugin that sets the same
   * "updated 2 min ago" on every tick does not redraw the window each time). See setBadge.
   */
  setHeader(projectId: string, panelKey: string, header: PanelHeaderInfo | null): boolean {
    return this.patch(projectId, panelKey, { header: header ?? undefined })
  }

  /** Set (undefined clears) only the error (⚠) of a panel, keeping its badge. See setBadge. */
  setError(projectId: string, panelKey: string, error: string | undefined): boolean {
    return this.patch(projectId, panelKey, { error })
  }

  /** Forget a closed project's panels and statuses (the stored layout stays). */
  closeProject(projectId: string): void {
    this.plugin.delete(projectId)
    this.status.delete(projectId)
  }

  /** Replace the fields `change` names (an undefined value clears one) and keep the others. */
  private patch(projectId: string, panelKey: string, change: PanelStatus): boolean {
    if (!this.hasKey(projectId, panelKey)) return false
    const current = this.status.get(projectId)?.get(panelKey)
    const next: PanelStatus = { ...current }
    if ('badge' in change) {
      if (change.badge === undefined) delete next.badge
      else next.badge = change.badge
    }
    if ('error' in change) {
      if (change.error === undefined) delete next.error
      else next.error = change.error
    }
    if ('header' in change) {
      if (change.header === undefined) delete next.header
      else next.header = change.header
    }
    const clean = cleanStatus(next)
    if (JSON.stringify(clean) === JSON.stringify(current)) return true
    return this.setStatus(projectId, panelKey, clean)
  }

  private publish(projectId: string): void {
    const view = this.view(projectId)
    if (view) this.deps.publish(projectId, view)
  }

  private hasKey(projectId: string, panelKey: string): boolean {
    return this.available(projectId).some((p) => p.panelKey === panelKey)
  }

  /** A panel that is gone must not come back with the badge (or header) it had when its plugin returns. */
  private dropStaleStatus(projectId: string): void {
    const map = this.status.get(projectId)
    if (!map) return
    for (const key of [...map.keys()]) if (!this.hasKey(projectId, key)) map.delete(key)
    if (map.size === 0) this.status.delete(projectId)
  }

  private available(projectId: string): AvailablePanel[] {
    const out: AvailablePanel[] = CORE_PANELS.map((p) => ({
      panelKey: p.panelKey,
      defaultZone: p.defaultZone
    }))
    for (const [pluginId, panels] of this.plugin.get(projectId) ?? []) {
      for (const p of panels) {
        out.push({
          panelKey: `${pluginId}/${p.id}`,
          // A manifest value; `reconcile` also guards, but keep the type honest here.
          defaultZone: isZoneId(p.defaultZone) ? p.defaultZone : 'left'
        })
      }
    }
    return out
  }

  private infos(projectId: string): PanelInfo[] {
    const status = this.status.get(projectId)
    const withStatus = (info: PanelInfo): PanelInfo => {
      const s = status?.get(info.panelKey)
      return s ? { ...info, ...s } : info
    }
    const out: PanelInfo[] = CORE_PANELS.map((p) =>
      withStatus({ panelKey: p.panelKey, title: p.title, icon: p.icon })
    )
    for (const [pluginId, panels] of this.plugin.get(projectId) ?? []) {
      for (const p of panels) {
        out.push(
          withStatus({
            panelKey: `${pluginId}/${p.id}`,
            title: p.title,
            ...(p.icon ? { iconSrc: pluginFileUrl(pluginId, p.icon) } : {}),
            ...(p.entry ? { src: pluginFileUrl(pluginId, p.entry) } : {}),
            ...(p.kind === 'webview' ? { kind: 'webview' as const } : {})
          })
        )
      }
    }
    return out
  }
}

/**
 * `layout` with each of `keys` put back where `stored` has it: hidden stays hidden, a placed one
 * goes back into its stored zone at its stored index (clamped), with its open state and size. A
 * key `layout` already holds keeps the place `layout` gives it.
 */
function keepPlaces(layout: LayoutState, stored: LayoutState, keys: readonly string[]): LayoutState {
  let out = layout
  for (const key of keys) {
    if (zoneOf(out, key) !== undefined || out.hidden.includes(key)) continue
    // The page's copy may carry a `remembered` entry for it (the view moved it there); the stored
    // one is the real one (a hidden panel's says where it comes back to).
    const remembered = { ...out.remembered }
    delete remembered[key]
    const kept = stored.remembered[key]
    if (kept && stored.hidden.includes(key)) remembered[key] = { ...kept }
    out = { ...out, remembered }
    if (stored.hidden.includes(key)) {
      out = { ...out, hidden: [...out.hidden, key] }
      continue
    }
    const zone = zoneOf(stored, key)
    if (zone === undefined) continue
    const index = stored.zones[zone].panels.findIndex((p) => p.panelKey === key)
    const placement = stored.zones[zone].panels[index]!
    const panels = [...out.zones[zone].panels]
    panels.splice(Math.min(index, panels.length), 0, { ...placement })
    out = { ...out, zones: { ...out.zones, [zone]: { ...out.zones[zone], panels } } }
  }
  return out
}

function cleanStatus(status: PanelStatus): PanelStatus | undefined {
  const out: PanelStatus = {}
  const badge = status.badge
  if (badge?.kind === 'dot') out.badge = { kind: 'dot' }
  else if (badge?.kind === 'count' && Number.isFinite(badge.count)) {
    const count = Math.min(MAX_BADGE_COUNT, Math.max(0, Math.floor(badge.count)))
    if (count > 0) out.badge = { kind: 'count', count }
  }
  if (typeof status.error === 'string' && status.error !== '') {
    out.error = status.error.slice(0, MAX_ERROR_LENGTH)
  }
  if (status.header && (status.header.meta !== undefined || (status.header.actions?.length ?? 0) > 0)) {
    out.header = status.header
  }
  return out.badge || out.error || out.header ? out : undefined
}
