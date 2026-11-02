// Checks for the window background setting (shared/window-background.ts), shaped like
// terminal-font.ts: `windowBackgroundOf` reads what app.json holds (user-writable, so tolerant:
// each damaged field falls back to its own default, a bad opacity never costing the switch), and
// `windowBackgroundPatchOf` checks what the settings page sends (strict: refused with a reason).
import { isPlainObject } from '../../shared/guards'
import {
  DEFAULT_WINDOW_BACKGROUND,
  isSeeThroughArea,
  WINDOW_OPACITY_RANGE,
  type WindowBackground
} from '../../shared/window-background'

/**
 * A whole percent in range. Not rounded into range: a stored 120 or 0.85 (someone wrote a
 * fraction by hand) is damaged, and the default is a safer reading than 100 % or 40 %.
 */
function isOpacity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= WINDOW_OPACITY_RANGE.min &&
    value <= WINDOW_OPACITY_RANGE.max
  )
}

/** The fields of the stored `windowBackground` that are set and good; the rest are left out. */
export function storedWindowBackgroundFields(stored: unknown): Partial<WindowBackground> {
  const s = isPlainObject(stored) ? stored : {}
  const out: Partial<WindowBackground> = {}
  if (typeof s['transparent'] === 'boolean') out.transparent = s['transparent']
  if (isOpacity(s['opacity'])) out.opacity = s['opacity']
  if (typeof s['blur'] === 'boolean') out.blur = s['blur']
  if (isSeeThroughArea(s['area'])) out.area = s['area']
  return out
}

/** The stored `windowBackground`, each missing or damaged field replaced by its default. */
export function windowBackgroundOf(stored: unknown): WindowBackground {
  return { ...DEFAULT_WINDOW_BACKGROUND, ...storedWindowBackgroundFields(stored) }
}

/**
 * A change from the settings page: some of the fields, each checked; an unknown field or a bad
 * value refuses the whole change (nothing is half-applied).
 */
export function windowBackgroundPatchOf(value: unknown): Partial<WindowBackground> {
  if (!isPlainObject(value)) throw new Error('give the window background fields to change')
  const patch: Partial<WindowBackground> = {}
  for (const [key, field] of Object.entries(value)) {
    if (key === 'transparent' || key === 'blur') {
      if (typeof field !== 'boolean') throw new Error(`${key} must be true or false`)
      patch[key] = field
    } else if (key === 'opacity') {
      if (!isOpacity(field)) {
        throw new Error(`the background opacity must be a whole percent from ${WINDOW_OPACITY_RANGE.min} to ${WINDOW_OPACITY_RANGE.max}`)
      }
      patch.opacity = field
    } else if (key === 'area') {
      if (!isSeeThroughArea(field)) throw new Error("the see-through area must be 'window' or 'main'")
      patch.area = field
    } else {
      throw new Error(`unknown window background field: ${key.slice(0, 40)}`)
    }
  }
  return patch
}
