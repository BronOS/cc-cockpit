// Checks for the terminal font setting (shared/terminal-font.ts). Two readers with one set of
// rules: `terminalFontOf` reads what app.json holds (user-writable, so tolerant: each damaged field
// falls back to its default on its own, a bad size never costing the family), and
// `terminalFontPatchOf` checks what a settings page sends (strict: refused with a reason).
//
// Why the family is checked beyond its type: xterm's DOM renderer writes it raw into a <style>
// rule (`font-family: ${fontFamily};`), so `;`, `{` or `}` would end the declaration or the rule
// and let the value restyle the page, and a comment opener would swallow the rest of the rule.
// Font names never contain them. Control characters (a pasted newline, NUL) are refused too: no
// font has one, and they would only make the CSS invalid in ways that are hard to see.
import { isPlainObject } from '../../shared/guards'
import {
  DEFAULT_TERMINAL_FONT,
  LEGACY_DEFAULT_FAMILY,
  MAX_FONT_FAMILY_LENGTH,
  TERMINAL_FONT_RANGES,
  TERMINAL_FONT_WEIGHTS,
  type TerminalFont,
  type TerminalFontWeight
} from '../../shared/terminal-font'

// C0 controls, DEL and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const CSS_BREAKERS = /[;{}]|\/\*/

/** Why `value` cannot be a font family, or undefined when it can. */
function familyProblem(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'give the font family as text'
  if (value.trim() === '') return 'give a font family'
  if (value.length > MAX_FONT_FAMILY_LENGTH) return `the font family is longer than ${MAX_FONT_FAMILY_LENGTH} characters`
  if (CONTROL.test(value)) return 'the font family has a control character in it'
  if (CSS_BREAKERS.test(value)) return 'the font family may not contain ; { } or /*'
  return undefined
}

type NumberField = keyof typeof TERMINAL_FONT_RANGES

const NUMBER_NAMES: Record<NumberField, string> = {
  size: 'the font size',
  lineHeight: 'the line height',
  letterSpacing: 'the letter spacing'
}

function numberProblem(field: NumberField, value: unknown): string | undefined {
  const { min, max } = TERMINAL_FONT_RANGES[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return `${NUMBER_NAMES[field]} must be a number from ${min} to ${max}`
  }
  return undefined
}

function isWeight(value: unknown): value is TerminalFontWeight {
  return typeof value === 'string' && (TERMINAL_FONT_WEIGHTS as readonly string[]).includes(value)
}

/**
 * The fields of the stored `terminalFont` the user set and that are good; missing, damaged and
 * inherited ones are left out. The family that was the default before the fonts were bundled
 * (LEGACY_DEFAULT_FAMILY) is left out too: the old setter stored the whole font on any change, so
 * that list in app.json means "changed the size once", not "picked Menlo", and the user gets the
 * bundled default like everyone who never set a family.
 */
export function storedTerminalFontFields(stored: unknown): Partial<TerminalFont> {
  const s = isPlainObject(stored) ? stored : {}
  const out: Partial<TerminalFont> = {}
  const has = (key: keyof TerminalFont): boolean => Object.hasOwn(s, key)
  if (has('family') && familyProblem(s['family']) === undefined && s['family'] !== LEGACY_DEFAULT_FAMILY) {
    out.family = s['family'] as string
  }
  for (const key of ['size', 'lineHeight', 'letterSpacing'] as const) {
    if (has(key) && numberProblem(key, s[key]) === undefined) out[key] = s[key] as number
  }
  for (const key of ['weight', 'boldWeight'] as const) {
    if (has(key) && isWeight(s[key])) out[key] = s[key]
  }
  return out
}

/** The stored `terminalFont`, each field that is missing or damaged replaced by its default. */
export function terminalFontOf(stored: unknown): TerminalFont {
  return { ...DEFAULT_TERMINAL_FONT, ...storedTerminalFontFields(stored) }
}

const FIELDS: ReadonlyArray<keyof TerminalFont> = ['family', 'size', 'lineHeight', 'letterSpacing', 'weight', 'boldWeight']

/**
 * A change from the settings page: some of the fields, each checked; an unknown field or a bad
 * value refuses the whole change (nothing is half-applied). The family is stored trimmed.
 */
export function terminalFontPatchOf(value: unknown): Partial<TerminalFont> {
  if (!isPlainObject(value)) throw new Error('give the terminal font fields to change, or null for the defaults')
  const patch: Partial<TerminalFont> = {}
  for (const [key, field] of Object.entries(value)) {
    if (!(FIELDS as readonly string[]).includes(key)) throw new Error(`unknown terminal font field: ${key.slice(0, 40)}`)
    if (key === 'family') {
      const problem = familyProblem(field)
      if (problem) throw new Error(problem)
      patch.family = (field as string).trim()
    } else if (key === 'weight' || key === 'boldWeight') {
      if (!isWeight(field)) throw new Error(`the ${key === 'weight' ? 'weight' : 'bold weight'} must be one of ${TERMINAL_FONT_WEIGHTS.join(', ')}`)
      patch[key] = field
    } else {
      const problem = numberProblem(key as NumberField, field)
      if (problem) throw new Error(problem)
      patch[key as NumberField] = field as number
    }
  }
  return patch
}
