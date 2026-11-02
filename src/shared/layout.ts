// Zone layout of a project window (design §4): three zones (left, right, bottom), each with an
// ordered list of panels, plus a list of hidden panels. Pure and immutable: every operation takes
// a LayoutState and returns a new one (the SAME object when nothing changed, so a caller can skip
// a store write with `next === prev`). No DOM, Electron or Node imports: main persists it in the
// project record and the renderer (Task 18) renders it, both through this one module.
//
// A panel is identified by its `panelKey`: `core/sessions` for the built-in Sessions panel or
// `<pluginId>/<panelId>` for a plugin's. Whether a panel EXISTS is not this module's call: the
// caller passes the available panels to `reconcile` (core panels plus panels of the plugins
// enabled for the project), and everything else here only moves what is already placed.

import { isPlainObject } from './guards'

export type ZoneId = 'left' | 'right' | 'bottom'
export const ZONE_IDS: readonly ZoneId[] = ['left', 'right', 'bottom']

/** Pixels along the stacking axis (height for left/right, width for bottom) of one panel. */
export const DEFAULT_PANEL_SIZE = 240
/** Pixels across the zone (width for left/right, height for bottom). */
export const DEFAULT_ZONE_SIZE: Record<ZoneId, number> = { left: 280, right: 320, bottom: 240 }
/** Clamp bounds for any size; keeps a corrupt file or a wild drag from producing an unusable zone. */
export const MIN_SIZE = 48
export const MAX_SIZE = 4000
/** Cap on placements remembered for disabled plugins / hidden panels, oldest dropped first. */
export const MAX_REMEMBERED = 100
/** A panel key is a short string (it is also an object key in the persisted file). */
const MAX_KEY_LENGTH = 200

export interface PanelPlacement {
  panelKey: string
  open: boolean
  size: number
}

export interface ZoneState {
  collapsed: boolean
  size: number
  panels: PanelPlacement[]
}

/** Where a panel sat when it left the zones (hidden, or its plugin was disabled). */
export interface RememberedPlacement {
  zone: ZoneId
  open: boolean
  size: number
  /** True while the panel is in `hidden`; such an entry lives until `unhidePanel`. */
  hidden: boolean
}

export interface LayoutState {
  zones: Record<ZoneId, ZoneState>
  /** Panels the user hid; they show only under the "..." menu of a strip. */
  hidden: string[]
  /**
   * panelKey -> last placement of a panel that is hidden or whose plugin is disabled, so hiding
   * and unhiding, or disabling and re-enabling a plugin, brings the panel back where it was.
   */
  remembered: Record<string, RememberedPlacement>
}

/** A panel the caller says exists right now (core panel, or from an enabled plugin). */
export interface AvailablePanel {
  panelKey: string
  defaultZone: ZoneId
  /** Open on first appearance. Default false. */
  defaultOpen?: boolean
}

export function defaultLayout(): LayoutState {
  return {
    zones: {
      left: { collapsed: false, size: DEFAULT_ZONE_SIZE.left, panels: [] },
      right: { collapsed: false, size: DEFAULT_ZONE_SIZE.right, panels: [] },
      bottom: { collapsed: false, size: DEFAULT_ZONE_SIZE.bottom, panels: [] }
    },
    hidden: [],
    remembered: {}
  }
}

export const isZoneId = (value: unknown): value is ZoneId =>
  typeof value === 'string' && (ZONE_IDS as readonly string[]).includes(value)

export function clampSize(size: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(size)))
}

/** The zone a panel is placed in, or undefined (hidden, unknown). */
export function zoneOf(layout: LayoutState, panelKey: string): ZoneId | undefined {
  return ZONE_IDS.find((z) => layout.zones[z].panels.some((p) => p.panelKey === panelKey))
}

export function isHidden(layout: LayoutState, panelKey: string): boolean {
  return layout.hidden.includes(panelKey)
}

/** Open a closed panel or close an open one. Opening also expands a collapsed zone. */
export function togglePanel(layout: LayoutState, panelKey: string): LayoutState {
  const zone = zoneOf(layout, panelKey)
  if (!zone) return layout
  const opening = !layout.zones[zone].panels.find((p) => p.panelKey === panelKey)!.open
  return withZone(layout, zone, (z) => ({
    ...z,
    // An icon click in a collapsed zone must show the panel, not toggle it invisibly.
    collapsed: opening ? false : z.collapsed,
    panels: z.panels.map((p) => (p.panelKey === panelKey ? { ...p, open: opening } : p))
  }))
}

/**
 * Move a panel to the end of `zone`, keeping its open state and size. A hidden panel is unhidden
 * by the move (the user picked a place for it). Moving within the same zone sends it to the end.
 */
export function movePanel(layout: LayoutState, panelKey: string, zone: ZoneId): LayoutState {
  if (!isZoneId(zone)) return layout
  const from = zoneOf(layout, panelKey)
  let placement: PanelPlacement
  if (from) {
    placement = layout.zones[from].panels.find((p) => p.panelKey === panelKey)!
  } else if (isHidden(layout, panelKey)) {
    const mem = layout.remembered[panelKey]
    placement = { panelKey, open: mem?.open ?? false, size: mem?.size ?? DEFAULT_PANEL_SIZE }
  } else {
    return layout
  }
  const next = removePlaced(layout, panelKey)
  return withZone(next, zone, (z) => ({ ...z, panels: [...z.panels, placement] }))
}

/** Take a placed panel out of the zones into `hidden`, remembering where it was. */
export function hidePanel(layout: LayoutState, panelKey: string): LayoutState {
  const zone = zoneOf(layout, panelKey)
  if (!zone) return layout
  const placement = layout.zones[zone].panels.find((p) => p.panelKey === panelKey)!
  const next = removePlaced(layout, panelKey)
  return {
    ...next,
    hidden: [...next.hidden, panelKey],
    remembered: remember(
      next.remembered,
      panelKey,
      { zone, open: placement.open, size: placement.size, hidden: true },
      [...next.hidden, panelKey]
    )
  }
}

/**
 * Put a hidden panel back in its remembered zone (or `fallbackZone` when nothing was remembered),
 * with its remembered open state and size.
 */
export function unhidePanel(
  layout: LayoutState,
  panelKey: string,
  fallbackZone: ZoneId = 'left'
): LayoutState {
  if (!isHidden(layout, panelKey)) return layout
  const mem = layout.remembered[panelKey]
  const remembered = { ...layout.remembered }
  delete remembered[panelKey]
  const next: LayoutState = {
    ...layout,
    hidden: layout.hidden.filter((k) => k !== panelKey),
    remembered
  }
  const open = mem?.open ?? false
  return withZone(next, mem?.zone ?? fallbackZone, (z) => ({
    ...z,
    // Same rule as togglePanel: an open panel must not come back invisible inside a collapsed zone.
    collapsed: open ? false : z.collapsed,
    panels: [...z.panels, { panelKey, open, size: mem?.size ?? DEFAULT_PANEL_SIZE }]
  }))
}

/**
 * Make a panel visible (ctx.panels.show): a hidden one comes back to its remembered zone, a closed
 * one opens, and its zone expands. There is no "selected" panel in a zone (every open panel is
 * shown, stacked), so open in an expanded zone is what showing it means. Unchanged when it is
 * already shown, or the layout does not know it.
 */
export function showPanel(layout: LayoutState, panelKey: string, fallbackZone: ZoneId = 'left'): LayoutState {
  let next = isHidden(layout, panelKey) ? unhidePanel(layout, panelKey, fallbackZone) : layout
  const zone = zoneOf(next, panelKey)
  if (!zone) return layout
  // togglePanel opens a closed panel and expands its zone with it.
  if (!panelIn(next, zone, panelKey).open) next = togglePanel(next, panelKey)
  return setZoneCollapsed(next, zone, false)
}

/** Set one panel's size (clamped). Non-finite sizes are ignored. */
export function resizePanel(layout: LayoutState, panelKey: string, size: number): LayoutState {
  const zone = zoneOf(layout, panelKey)
  if (!zone || !Number.isFinite(size)) return layout
  const clamped = clampSize(size)
  if (panelIn(layout, zone, panelKey).size === clamped) return layout
  return withZone(layout, zone, (z) => ({
    ...z,
    panels: z.panels.map((p) => (p.panelKey === panelKey ? { ...p, size: clamped } : p))
  }))
}

/** Set a zone's size (clamped). Non-finite sizes are ignored. */
export function resizeZone(layout: LayoutState, zone: ZoneId, size: number): LayoutState {
  if (!isZoneId(zone) || !Number.isFinite(size)) return layout
  if (layout.zones[zone].size === clampSize(size)) return layout
  return withZone(layout, zone, (z) => ({ ...z, size: clampSize(size) }))
}

/** Collapse or expand a zone; with `collapsed` omitted, flip it. Panels keep their open state. */
export function setZoneCollapsed(
  layout: LayoutState,
  zone: ZoneId,
  collapsed?: boolean
): LayoutState {
  if (!isZoneId(zone)) return layout
  const value = collapsed ?? !layout.zones[zone].collapsed
  if (layout.zones[zone].collapsed === value) return layout
  return withZone(layout, zone, (z) => ({ ...z, collapsed: value }))
}

/**
 * Bring the layout in line with the panels that exist now.
 *  - A placed or hidden panel that is no longer available (its plugin was disabled or removed) is
 *    dropped, but its placement is remembered.
 *  - An available panel not in the layout returns to its remembered placement if there is one,
 *    otherwise it is added to its default zone.
 * Order inside a zone is preserved; new panels are appended in `available` order.
 */
export function reconcile(layout: LayoutState, available: readonly AvailablePanel[]): LayoutState {
  const byKey = new Map<string, AvailablePanel>()
  for (const a of available) if (!byKey.has(a.panelKey)) byKey.set(a.panelKey, a)

  let remembered = layout.remembered
  const zones = { ...layout.zones }
  for (const z of ZONE_IDS) {
    const gone = zones[z].panels.filter((p) => !byKey.has(p.panelKey))
    if (gone.length === 0) continue
    for (const p of gone) {
      remembered = remember(
        remembered,
        p.panelKey,
        { zone: z, open: p.open, size: p.size, hidden: false },
        layout.hidden
      )
    }
    zones[z] = { ...zones[z], panels: zones[z].panels.filter((p) => byKey.has(p.panelKey)) }
  }
  // A hidden panel already has its remembered entry (hidden: true); just drop it from the list.
  const hidden = layout.hidden.filter((k) => byKey.has(k))

  // Hidden panels that just left `hidden` (plugin disabled) leave their entry behind; cap now.
  let next: LayoutState = { zones, hidden, remembered: capRemembered(remembered, hidden) }
  for (const [key, panel] of byKey) {
    if (zoneOf(next, key) || isHidden(next, key)) continue
    const mem = next.remembered[key]
    if (mem?.hidden) {
      next = { ...next, hidden: [...next.hidden, key] }
      continue
    }
    if (mem) {
      const rest = { ...next.remembered }
      delete rest[key]
      next = { ...next, remembered: rest }
    }
    const placement: PanelPlacement = {
      panelKey: key,
      open: mem?.open ?? panel.defaultOpen ?? false,
      size: mem?.size ?? DEFAULT_PANEL_SIZE
    }
    // defaultZone may come from a plugin manifest: a bad value must not throw inside withZone.
    const target = mem?.zone ?? (isZoneId(panel.defaultZone) ? panel.defaultZone : 'left')
    next = withZone(next, target, (z) => ({
      ...z,
      panels: [...z.panels, placement]
    }))
  }
  // Same content, same object: lets callers skip the store write.
  return JSON.stringify(next) === JSON.stringify(layout) ? layout : next
}

/**
 * Turn whatever the project file holds into a valid LayoutState. Old records carry `{}` (Task 4
 * placeholder) and a hand-edited or damaged file can hold anything; unusable parts fall back to
 * defaults and a panel listed twice keeps its first place (zones left, right, bottom, then hidden).
 */
export function normalizeLayout(raw: unknown): LayoutState {
  const out = defaultLayout()
  if (!isPlainObject(raw)) return out
  const seen = new Set<string>()
  const zonesRaw = isPlainObject(raw.zones) ? raw.zones : {}
  for (const z of ZONE_IDS) {
    const zr = zonesRaw[z]
    if (!isPlainObject(zr)) continue
    if (typeof zr.collapsed === 'boolean') out.zones[z].collapsed = zr.collapsed
    if (isSize(zr.size)) out.zones[z].size = clampSize(zr.size)
    if (!Array.isArray(zr.panels)) continue
    for (const p of zr.panels) {
      if (!isPlainObject(p) || !isPanelKey(p.panelKey) || seen.has(p.panelKey)) continue
      seen.add(p.panelKey)
      out.zones[z].panels.push({
        panelKey: p.panelKey,
        open: p.open === true,
        size: isSize(p.size) ? clampSize(p.size) : DEFAULT_PANEL_SIZE
      })
    }
  }
  const placed = new Set(seen)
  if (Array.isArray(raw.hidden)) {
    for (const k of raw.hidden) {
      if (!isPanelKey(k) || seen.has(k)) continue
      seen.add(k)
      out.hidden.push(k)
    }
  }
  if (isPlainObject(raw.remembered)) {
    for (const [key, m] of Object.entries(raw.remembered)) {
      // An entry for a panel that is placed now is stale.
      if (!isPanelKey(key) || placed.has(key) || !isPlainObject(m) || !isZoneId(m.zone)) continue
      out.remembered[key] = {
        zone: m.zone,
        open: m.open === true,
        size: isSize(m.size) ? clampSize(m.size) : DEFAULT_PANEL_SIZE,
        // A panel hidden and then dropped by reconcile (plugin disabled) is out of `hidden` but
        // its entry still says hidden: keep that so re-enabling restores it hidden.
        hidden: m.hidden === true || out.hidden.includes(key)
      }
    }
  }
  out.remembered = capRemembered(out.remembered, out.hidden)
  return out
}

function panelIn(layout: LayoutState, zone: ZoneId, panelKey: string): PanelPlacement {
  return layout.zones[zone].panels.find((p) => p.panelKey === panelKey)!
}

function withZone(
  layout: LayoutState,
  zone: ZoneId,
  change: (z: ZoneState) => ZoneState
): LayoutState {
  return { ...layout, zones: { ...layout.zones, [zone]: change(layout.zones[zone]) } }
}

function removePlaced(layout: LayoutState, panelKey: string): LayoutState {
  const zones = { ...layout.zones }
  for (const z of ZONE_IDS) {
    if (zones[z].panels.some((p) => p.panelKey === panelKey)) {
      zones[z] = { ...zones[z], panels: zones[z].panels.filter((p) => p.panelKey !== panelKey) }
    }
  }
  const remembered = { ...layout.remembered }
  delete remembered[panelKey]
  return { ...layout, zones, hidden: layout.hidden.filter((k) => k !== panelKey), remembered }
}

function remember(
  current: Record<string, RememberedPlacement>,
  key: string,
  placement: RememberedPlacement,
  hidden: readonly string[]
): Record<string, RememberedPlacement> {
  const next = { ...current }
  delete next[key] // re-insert so the newest entry is last
  next[key] = placement
  return capRemembered(next, hidden)
}

function capRemembered(
  map: Record<string, RememberedPlacement>,
  hidden: readonly string[]
): Record<string, RememberedPlacement> {
  const keys = Object.keys(map)
  if (keys.length <= MAX_REMEMBERED) return map
  const next = { ...map }
  // Hidden panels' entries are load-bearing (unhide needs the zone): drop non-hidden ones first.
  for (const k of keys) {
    if (Object.keys(next).length <= MAX_REMEMBERED) break
    if (!next[k]!.hidden) delete next[k]
  }
  // Entries of panels hidden and then dropped (plugin disabled/removed) are not in `hidden`, so
  // nothing would ever unhide them: without this they would grow past the cap forever. Keep
  // entries of panels still in `hidden`, drop the oldest of the rest.
  for (const k of keys) {
    if (Object.keys(next).length <= MAX_REMEMBERED) break
    if (k in next && !hidden.includes(k)) delete next[k]
  }
  return next
}

const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPanelKey = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_LENGTH && v.includes('/')
