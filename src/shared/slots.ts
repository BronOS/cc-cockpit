// Slots (design-next §2): a place in one plugin's panel (or in the app's chrome) where another
// plugin draws its own page. The rules every side shares live here: the type name, the caps, the
// app's own slot types and the pick key. Pure and import-free on purpose: the manifest check, the
// Plugins page, main's placement checks and the plugin host all read these, and a copy would drift.

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
