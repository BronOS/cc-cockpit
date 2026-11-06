// Slots (design-next §2): a place in one plugin's panel (or in the app's chrome) where another
// plugin draws its own page. The rules every side shares live here: the type name, the caps, the
// app's own slot types and the pick key. Pure, with no runtime import, on purpose: the manifest
// check, the Plugins page, main's placement checks and the plugin host all read these, and a copy
// would drift.
import type { JsonValue } from '../sdk/types'

/**
 * A slot type: a plain lower-case word, like a service name. It is part of a pick key
 * (`@slot:<type>` in `serviceProviders`), a Settings label and an error-message fragment.
 */
export const SLOT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/**
 * Slot types the app places itself (the top bar's `sessions-strip`, design-next §4). A plugin may
 * provide one (that is how the sessions plugin fills it), but a panel may not place one: the app's
 * chrome is not a plugin's to lay out.
 */
export const APP_SLOT_TYPES: readonly string[] = ['sessions-strip']

export function isAppSlotType(type: string): boolean {
  return APP_SLOT_TYPES.includes(type)
}

/** At most this many `contributes.slots` entries per plugin. */
export const MAX_PROVIDER_SLOTS = 10
/** At most this many slot types in one panel's `slots` list. */
export const MAX_PANEL_SLOT_TYPES = 4
/** At most this many placements in one `ctx.panels.slots` call. */
export const MAX_SLOT_PLACEMENTS = 4
/** Placement heights (and a provider's `minHeight`/`maxHeight`) are whole pixels in this range. */
export const SLOT_HEIGHT_MIN = 24
export const SLOT_HEIGHT_MAX = 600
/**
 * A top-bar slot page's `ccPanel.slot.setWidth` is whole pixels in this range. 0 is allowed on
 * purpose: a strip with nothing to show takes no room, so the whole bar drags the window (macOS).
 * The max only keeps a number sane; the bar's own cap, which always leaves a drag gap, is the
 * shell's (styles.css `.slot-frame-top-bar`).
 */
export const SLOT_WIDTH_MIN = 0
export const SLOT_WIDTH_MAX = 4096
/** A placement's `params`, as JSON, is at most this many bytes. */
export const MAX_SLOT_PARAMS_BYTES = 4 * 1024
/** At most this many slot frames are drawn per window; extra placements are not drawn. */
export const MAX_SLOT_FRAMES_PER_WINDOW = 8

/**
 * The pick of a slot's provider is stored next to the service picks (project record
 * `serviceProviders`) under `@slot:<type>`: `@` never starts a service name, so the key cannot
 * collide with one, and every walk of the picks as services skips `@` keys (CLAUDE.md).
 */
export const SLOT_PICK_PREFIX = '@slot:'
/** The pick value that turns a slot off for the project: `@` never starts a plugin id. */
export const SLOT_NONE = '@none'

/** The pick key of slot `type`. */
export function slotPickKey(type: string): string {
  return SLOT_PICK_PREFIX + type
}

/** The slot type a pick key names, or undefined when `key` is not a well-formed slot pick key. */
export function slotTypeOfPickKey(key: string): string | undefined {
  if (!key.startsWith(SLOT_PICK_PREFIX)) return undefined
  const type = key.slice(SLOT_PICK_PREFIX.length)
  return SLOT_TYPE_PATTERN.test(type) ? type : undefined
}

/** A plugin's `contributes.slots` entry: it can draw slots of `type` with the page at `entry`. */
export interface SlotContribution {
  type: string
  /** Plugin-relative path to the slot's html page. */
  entry: string
  /** What the slot shows, for people (the guide's meaning of the type is the contract). */
  title?: string
  /** Px; the placement's height is clamped to these. Defaults: SLOT_HEIGHT_MIN and SLOT_HEIGHT_MAX. */
  minHeight?: number
  maxHeight?: number
}

// ---------------------------------------------------------------------------------------------
// Placements (`ctx.panels.slots`) and frames. The host side checks a call with parseSlotPlacements
// for a fast error; main checks it again with the same function (HostApi `panels.slots`), because
// a host is not trusted to have used ctx.

/** Where a placement goes in its panel's column: above or below the panel's own frame. */
export type SlotPosition = 'top' | 'bottom'

/** A placement as checked: a known position, a whole height in range, `params` a clean JSON copy. */
export interface SlotPlacement {
  type: string
  position: SlotPosition
  /** Px, a whole number in [SLOT_HEIGHT_MIN, SLOT_HEIGHT_MAX]; main clamps it to the provider's min/max too. */
  height: number
  /** Plain JSON (a parsed copy), at most MAX_SLOT_PARAMS_BYTES as JSON; handed to the provider only. */
  params?: JsonValue
}

/** What a slot frame sits in, as the provider sees it (`SlotInstance.host`). */
export type SlotHost = { kind: 'panel'; pluginId: string; panelId: string } | { kind: 'app'; place: 'top-bar' }

/**
 * `raw` (a `ctx.panels.slots` argument) checked: null (clear), or at most MAX_SLOT_PLACEMENTS
 * placements. A height outside the range is clamped, not refused (the design's "clamped"; a
 * fraction is rounded), but it must be a finite number. `params` goes through JSON once: what is
 * kept is the parsed copy, so a getter, a prototype or a function cannot ride along, and the byte
 * count is that of the text the provider will get. Throws an Error naming `panels.slots` and the
 * rule. Which types a panel may place is the caller's check (the manifest, the app slot types).
 */
export function parseSlotPlacements(raw: unknown): SlotPlacement[] | null {
  if (raw === null) return null
  if (!Array.isArray(raw)) throw new Error('panels.slots: placements must be an array or null')
  if (raw.length > MAX_SLOT_PLACEMENTS) throw new Error(`panels.slots: at most ${MAX_SLOT_PLACEMENTS} placements`)
  return raw.map((p: unknown, i): SlotPlacement => {
    if (typeof p !== 'object' || p === null || Array.isArray(p)) throw new Error(`panels.slots: placement ${i} must be an object`)
    const { type, position, height, params } = p as Record<string, unknown>
    if (typeof type !== 'string' || !SLOT_TYPE_PATTERN.test(type)) {
      throw new Error(`panels.slots: placement ${i}: type must match ${SLOT_TYPE_PATTERN.source}`)
    }
    if (position !== 'top' && position !== 'bottom') throw new Error(`panels.slots: placement ${i}: position must be "top" or "bottom"`)
    if (typeof height !== 'number' || !Number.isFinite(height)) throw new Error(`panels.slots: placement ${i}: height must be a number`)
    const out: SlotPlacement = { type, position, height: clampSlotHeight(height, SLOT_HEIGHT_MIN, SLOT_HEIGHT_MAX) }
    if (params !== undefined) out.params = slotParamsOf(params, i)
    return out
  })
}

/** `height` rounded and kept within [min, max]. */
export function clampSlotHeight(height: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(height)))
}

function slotParamsOf(params: unknown, i: number): JsonValue {
  let text: string | undefined
  try {
    text = JSON.stringify(params)
  } catch {
    // A cycle or a BigInt: the same answer as a function, without the engine's text.
    text = undefined
  }
  if (text === undefined) throw new Error(`panels.slots: placement ${i}: params must be plain JSON`)
  if (new TextEncoder().encode(text).length > MAX_SLOT_PARAMS_BYTES) {
    throw new Error(`panels.slots: placement ${i}: params are larger than ${MAX_SLOT_PARAMS_BYTES} bytes as JSON`)
  }
  return JSON.parse(text) as JsonValue
}

/**
 * A frame's id: main makes it (`s<n>`), the renderer and the provider only pass it back. Checked
 * against this before any lookup, so junk from a renderer is not carried any further.
 */
export const SLOT_FRAME_ID_PATTERN = /^s[0-9]{1,15}$/

/**
 * Slot frames get their MessagePort on the panels' channel (PANEL_PORT_CHANNEL, the preload and
 * the renderer's port bus unchanged), under this key instead of a panel key: `@` never starts a
 * plugin id, so it cannot collide with one.
 */
export function slotPortKey(frameId: string): string {
  return `@slot/${frameId}`
}
