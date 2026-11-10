// Which panels exist for a project, and the project's zone layout reconciled with them (Task 18).
// main owns this: the renderer asks for the view and sends layouts back, and main re-validates
// every one against the panels that exist, so a page cannot place a panel that is not there.
//
// Panels are those of the project's enabled plugins (`setPluginPanels`). Core has none of its own:
// the Sessions panel it once had is the bundled cockpit.sessions plugin's now (design-next §4), and
// a stored layout's old key for it is renamed on read (RENAMED_PANEL_KEYS, shared/layout.ts). A
// panel's badge, error and header (ctx.panels.header) are plugin-reported state kept here, not in
// the persisted layout.
//
// Slots (design-next §2) follow the header's path: a panel's placements (ctx.panels.slots, checked
// by HostApi) are kept here per project and panel, and every view resolves them into the frames the
// shell draws (`PanelInfo.slots`, `LayoutView.appSlots`): the provider is asked for at each view
// (`slotProvider`: the project's pick among the running plugins that declare the type), the height
// clamped to the provider's min/max, and at most MAX_SLOT_FRAMES_PER_WINDOW frames drawn (one
// window per project, so per project here), the app's own first. A frame's id is kept for as long
// as what it shows is the same (host, position, type, params, provider and the provider's copy):
// a new id is a new frame, which the shell remounts and the provider's host hears as close + open.
// `refreshSlots` is how a pick change or a provider starting, reloading or stopping reaches the
// window: it publishes only when the frames changed.
import type { JsonValue } from '../../sdk/types'
import type { PanelKind } from '../../shared/manifest'
import type { LayoutView, PanelBadge, PanelHeaderInfo, PanelInfo, PanelSettingsTarget, SlotFrameInfo } from '../../shared/ipc'
import {
  APP_SLOT_TYPES,
  clampSlotHeight,
  MAX_SLOT_FRAMES_PER_WINDOW,
  type SlotHost,
  type SlotPlacement,
  type SlotPosition
} from '../../shared/slots'
import {
  ZONE_IDS,
  geometryOf,
  isZoneId,
  movePanel,
  normalizeLayout,
  reconcile,
  showPanel,
  withGeometry,
  zoneOf,
  type AvailablePanel,
  type LayoutState,
  type ZoneId
} from '../../shared/layout'
import { pluginFileUrl } from '../plugins/plugin-protocol'

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
  /** The manifest's `slots`: the slot types this panel may place (HostApi checks a placement against it). */
  slots?: string[]
  /** Where the panel's gear opens Settings (its plugin's settings); absent: the plugin has none, no gear. */
  settings?: PanelSettingsTarget
}

/** Who draws slots of a type in a project now (HostManager.slotProvider). */
export interface SlotProviderInfo {
  pluginId: string
  /** The `contributes.slots` entry's page, relative to the plugin folder. */
  entry: string
  minHeight: number
  maxHeight: number
  /** Bumped each time the plugin is (re)activated: a new copy gets new frames (remount). */
  epoch: number
}

/** A drawn frame as main keeps it: what the shell gets, plus what only the provider gets. */
export interface SlotFrameRecord {
  info: SlotFrameInfo
  host: SlotHost
  params?: JsonValue
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
  /** Who draws slots of `type` in the project now, or undefined (none, "None", ambiguous, not running). Absent: no slots. */
  slotProvider?(projectId: string, type: string): SlotProviderInfo | undefined
  /** The project's set of frame ids changed (PanelPortHub.slotFramesChanged closes the ones that went). */
  framesChanged?(projectId: string, ids: ReadonlySet<string>): void
  /** A placement of `pluginId`'s panel is not drawn (over the frame cap): a line for that plugin's log. */
  slotLog?(projectId: string, pluginId: string, text: string): void
}

const MAX_BADGE_COUNT = 99_999
const MAX_ERROR_LENGTH = 500

export class LayoutService {
  /** projectId -> pluginId -> declared panels. */
  private readonly plugin = new Map<string, Map<string, PluginPanelDef[]>>()
  /** projectId -> panelKey -> reported badge/error. */
  private readonly status = new Map<string, Map<string, PanelStatus>>()
  /** projectId -> panelKey -> the placements its plugin set (ctx.panels.slots, checked by HostApi). */
  private readonly placements = new Map<string, Map<string, SlotPlacement[]>>()
  /** projectId -> frame identity (see frameIdentity) -> its id, as of the last view. */
  private readonly frameIds = new Map<string, Map<string, string>>()
  /** projectId -> frame id -> the frame, as of the last view (what a connect is looked up in). */
  private readonly frames = new Map<string, Map<string, SlotFrameRecord>>()
  /** projectId -> frame id -> the height its page asked for (`slots.height`), clamped. */
  private readonly pageHeights = new Map<string, Map<string, number>>()
  /** projectId -> identities over the frame cap already logged (once each, not on every view). */
  private readonly dropped = new Map<string, Set<string>>()
  /** projectId -> the slot frames of the last view sent to the window, as JSON (refreshSlots). */
  private readonly sentSlots = new Map<string, string>()
  private nextFrame = 1

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
    return this.viewOf(projectId, reconcile(stored, this.available(projectId)))
  }

  /**
   * Store a layout the renderer sent. Whatever it holds is normalized and reconciled first;
   * unusable parts fall back to defaults rather than throwing. Answers with what was stored.
   * `keepGeometry` (a remote view's edit, design-web.md §5.1): zone sizes, collapsed zones and
   * panel sizes stay the stored ones (the desktop's), whatever the layout sent says; the remote
   * view keeps its own in the browser. Only the shared part (placement, order, open, hidden) is taken.
   */
  set(projectId: string, raw: unknown, opts: { keepGeometry?: boolean } = {}): LayoutView | undefined {
    const stored = this.deps.getLayout(projectId)
    if (!stored) return undefined
    // A user edit (a toggle, a splitter) can arrive before the plugin host has declared its
    // panels: the window shows its layout at once, the host launch takes a moment. The page never
    // saw those panels (view() leaves them out), so a plain reconcile would move them into
    // `remembered`, from where they return at the END of their zone and the user's order is lost,
    // the same trap view() avoids. They keep their stored place instead, until declared.
    const pending = this.pendingPanels(projectId, stored)
    const sent = normalizeLayout(raw)
    const next = keepPlaces(opts.keepGeometry === true ? withGeometry(sent, geometryOf(stored)) : sent, stored, pending)
    const pendingAvailable = pending.map((panelKey) => ({ panelKey, defaultZone: zoneOf(stored, panelKey) ?? 'left' }))
    const layout = reconcile(next, [...this.available(projectId), ...pendingAvailable])
    this.deps.setLayout(projectId, layout)
    // The page gets the layout of the panels it can show, as from view().
    return this.viewOf(projectId, reconcile(layout, this.available(projectId)))
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
    if (zoneOf(current, panelKey) === zone) return this.viewOf(projectId, current)
    const next = movePanel(current, panelKey, zone)
    // movePanel leaves a layout alone when the panel is neither placed nor hidden.
    if (next === current) throw new Error('unknown panel')
    const view = this.set(projectId, next)
    if (view) this.send(projectId, view)
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
    if (view) this.send(projectId, { ...view, reveal: panelKey })
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

  /**
   * Set (null clears) the slot placements of a plugin panel (ctx.panels.slots). HostApi checked
   * them (the panel is the caller's, the types are in its manifest `slots` and none is an app
   * type, the caps); stored as given. False for a panel the project does not have.
   * The same placements again publish nothing.
   */
  setSlots(projectId: string, panelKey: string, placements: readonly SlotPlacement[] | null): boolean {
    if (!this.hasKey(projectId, panelKey)) return false
    const map = this.placements.get(projectId) ?? new Map<string, SlotPlacement[]>()
    const before = JSON.stringify(map.get(panelKey) ?? null)
    if (placements === null || placements.length === 0) map.delete(panelKey)
    else map.set(panelKey, placements.map((p) => ({ ...p })))
    if (map.size === 0) this.placements.delete(projectId)
    else this.placements.set(projectId, map)
    if (JSON.stringify(map.get(panelKey) ?? null) !== before) this.publish(projectId)
    return true
  }

  /**
   * A slot page's `ccPanel.slot.setHeight` (`slots.height`, from the project's window): kept within
   * [minHeight, the frame's height] and published. False for a frame the project does not draw now
   * or one in the top bar (its height is the bar's). An unchanged height publishes nothing.
   */
  setSlotHeight(projectId: string, frameId: string, height: unknown): boolean {
    const frame = this.frames.get(projectId)?.get(frameId)
    if (!frame || frame.info.position === 'top-bar') return false
    if (typeof height !== 'number' || !Number.isFinite(height)) return false
    const px = clampSlotHeight(height, frame.info.minHeight, frame.info.height)
    const map = this.pageHeights.get(projectId) ?? new Map<string, number>()
    if (map.get(frameId) === px) return true
    map.set(frameId, px)
    this.pageHeights.set(projectId, map)
    this.publish(projectId)
    return true
  }

  /** A frame the project draws now (as of the last view), for its port (PanelPortHub.connectSlot). */
  slotFrame(projectId: string, frameId: string): SlotFrameRecord | undefined {
    return this.frames.get(projectId)?.get(frameId)
  }

  /**
   * Who draws a slot may have changed (a pick, a provider started, reloaded, stopped or was turned
   * off): send the view when its frames differ from the ones the window has. Nothing otherwise.
   */
  refreshSlots(projectId: string): void {
    const view = this.view(projectId)
    if (!view) {
      // No stored layout, so no view and no resolveSlots: frames recorded earlier must not stay
      // open in the port hub, so the hub is told there are none.
      this.sentSlots.delete(projectId)
      if (this.frames.delete(projectId)) this.deps.framesChanged?.(projectId, new Set())
      return
    }
    if (slotsJson(view) !== this.sentSlots.get(projectId)) this.send(projectId, view)
  }

  /** Forget a closed project's panels, statuses and slots (the stored layout stays). */
  closeProject(projectId: string): void {
    this.plugin.delete(projectId)
    this.status.delete(projectId)
    this.placements.delete(projectId)
    this.frameIds.delete(projectId)
    this.pageHeights.delete(projectId)
    this.dropped.delete(projectId)
    this.sentSlots.delete(projectId)
    if (this.frames.delete(projectId)) this.deps.framesChanged?.(projectId, new Set())
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
    if (view) this.send(projectId, view)
  }

  /** Every view to the window goes here: what it was sent of the slots is what refreshSlots compares. */
  private send(projectId: string, view: LayoutView): void {
    this.sentSlots.set(projectId, slotsJson(view))
    this.deps.publish(projectId, view)
  }

  private hasKey(projectId: string, panelKey: string): boolean {
    return this.available(projectId).some((p) => p.panelKey === panelKey)
  }

  /** A panel that is gone must not come back with the badge (or header, or slots) it had when its plugin returns. */
  private dropStaleStatus(projectId: string): void {
    for (const store of [this.status, this.placements] as Map<string, Map<string, unknown>>[]) {
      const map = store.get(projectId)
      if (!map) continue
      for (const key of [...map.keys()]) if (!this.hasKey(projectId, key)) map.delete(key)
      if (map.size === 0) store.delete(projectId)
    }
  }

  private available(projectId: string): AvailablePanel[] {
    const out: AvailablePanel[] = []
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

  /** A view of `layout` with the project's panels and slot frames. */
  private viewOf(projectId: string, layout: LayoutState): LayoutView {
    const { panels, app } = this.infosAndSlots(projectId)
    return app.length > 0 ? { layout, panels, appSlots: app } : { layout, panels }
  }

  /** The panels with their status and slot frames, and the app's own frames. */
  private infosAndSlots(projectId: string): { panels: PanelInfo[]; app: SlotFrameInfo[] } {
    const slots = this.resolveSlots(projectId)
    const status = this.status.get(projectId)
    const withStatus = (info: PanelInfo): PanelInfo => {
      const s = status?.get(info.panelKey)
      const frames = slots.byPanel.get(info.panelKey)
      const out = s ? { ...info, ...s } : info
      return frames ? { ...out, slots: frames } : out
    }
    const out: PanelInfo[] = []
    for (const [pluginId, panels] of this.plugin.get(projectId) ?? []) {
      for (const p of panels) {
        out.push(
          withStatus({
            panelKey: `${pluginId}/${p.id}`,
            title: p.title,
            ...(p.icon ? { iconSrc: pluginFileUrl(pluginId, p.icon) } : {}),
            ...(p.entry ? { src: pluginFileUrl(pluginId, p.entry) } : {}),
            ...(p.kind === 'webview' ? { kind: 'webview' as const } : {}),
            ...(p.settings !== undefined ? { settings: p.settings } : {})
          })
        )
      }
    }
    return { panels: out, app: slots.app }
  }

  /**
   * The project's slot frames: the app's own (each app slot type with a provider, in the top bar),
   * then each plugin panel's placements in panel order, each with the provider drawing it now. Only
   * the first MAX_SLOT_FRAMES_PER_WINDOW are drawn; a placement over the cap is logged once in its
   * host plugin's log. Records the frames for connects, keeps the ids of frames that did not
   * change, and tells `framesChanged` when the set of ids did.
   */
  private resolveSlots(projectId: string): { app: SlotFrameInfo[]; byPanel: Map<string, SlotFrameInfo[]> } {
    const app: SlotFrameInfo[] = []
    const byPanel = new Map<string, SlotFrameInfo[]>()
    const resolve = this.deps.slotProvider
    const before = this.frames.get(projectId)
    if (!resolve) return { app, byPanel }
    const oldIds = this.frameIds.get(projectId)
    const ids = new Map<string, string>()
    const records = new Map<string, SlotFrameRecord>()
    const loggedBefore = this.dropped.get(projectId)
    const dropped = new Set<string>()
    const heights = this.pageHeights.get(projectId)
    const add = (hostKey: string, host: SlotHost, index: number, p: { type: string; position: SlotPosition | 'top-bar'; height?: number; params?: JsonValue }): SlotFrameInfo | undefined => {
      let provider: SlotProviderInfo | undefined
      try {
        provider = resolve(projectId, p.type)
      } catch {
        provider = undefined
      }
      if (!provider) return undefined
      const identity = [hostKey, p.position, index, p.type, p.params === undefined ? '' : JSON.stringify(p.params), provider.pluginId, provider.epoch].join('\n')
      if (records.size >= MAX_SLOT_FRAMES_PER_WINDOW) {
        dropped.add(identity)
        if (host.kind === 'panel' && !loggedBefore?.has(identity)) {
          this.deps.slotLog?.(
            projectId,
            host.pluginId,
            `slot "${p.type}" of panel ${host.panelId} is not drawn: at most ${MAX_SLOT_FRAMES_PER_WINDOW} slot frames per window`
          )
        }
        return undefined
      }
      const id = oldIds?.get(identity) ?? `s${this.nextFrame++}`
      ids.set(identity, id)
      // A top-bar frame has the bar's fixed height; the provider's minHeight stands in for it.
      const height = p.height === undefined ? provider.minHeight : clampSlotHeight(p.height, provider.minHeight, provider.maxHeight)
      const page = heights?.get(id)
      const info: SlotFrameInfo = {
        id,
        type: p.type,
        pluginId: provider.pluginId,
        src: pluginFileUrl(provider.pluginId, provider.entry),
        position: p.position,
        height,
        minHeight: provider.minHeight,
        ...(page !== undefined ? { pageHeight: clampSlotHeight(page, provider.minHeight, height) } : {})
      }
      records.set(id, { info, host, ...(p.params !== undefined ? { params: p.params } : {}) })
      return info
    }
    for (const type of APP_SLOT_TYPES) {
      const info = add('@app/top-bar', { kind: 'app', place: 'top-bar' }, 0, { type, position: 'top-bar' })
      if (info) app.push(info)
    }
    const placed = this.placements.get(projectId)
    for (const [pluginId, panels] of this.plugin.get(projectId) ?? []) {
      for (const panel of panels) {
        const key = `${pluginId}/${panel.id}`
        const frames: SlotFrameInfo[] = []
        ;(placed?.get(key) ?? []).forEach((p, i) => {
          const info = add(key, { kind: 'panel', pluginId, panelId: panel.id }, i, p)
          if (info) frames.push(info)
        })
        if (frames.length > 0) byPanel.set(key, frames)
      }
    }
    setOrDelete(this.frameIds, projectId, ids)
    setOrDelete(this.frames, projectId, records)
    if (dropped.size > 0) this.dropped.set(projectId, dropped)
    else this.dropped.delete(projectId)
    if (heights) {
      for (const id of [...heights.keys()]) if (!records.has(id)) heights.delete(id)
      if (heights.size === 0) this.pageHeights.delete(projectId)
    }
    const same = (before?.size ?? 0) === records.size && [...records.keys()].every((id) => before?.has(id))
    if (!same) this.deps.framesChanged?.(projectId, new Set(records.keys()))
    return { app, byPanel }
  }
}

function setOrDelete<V>(store: Map<string, Map<string, V>>, projectId: string, map: Map<string, V>): void {
  if (map.size > 0) store.set(projectId, map)
  else store.delete(projectId)
}

/** The slot frames of a view (app and panels), as JSON: what refreshSlots compares. */
function slotsJson(view: LayoutView): string {
  return JSON.stringify([view.appSlots ?? [], view.panels.map((p) => p.slots ?? [])])
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
