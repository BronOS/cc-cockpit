// A project's colour (Settings › This project › Colour; `ProjectRecord.color`): a mark to tell
// project windows apart, shown as a line along the window's top edge, a tint of its top bar and a
// dot wherever the project is named (its title-bar chip, other windows' top strips, the picker).
// None by default. Shared so main validates against the same palette the settings page offers and
// every surface turns a value into CSS the same way.
//
// A value is one of eight named palette colours, like Finder tags, or a custom `#rrggbb`. The
// palette names are theme tokens (`--cc-project-<name>` in src/themes/*.json, tuned per theme to
// read on its bars; a plugin theme inherits the ones it leaves out from the built-in of its kind),
// so a theme switch re-colours them. A custom hex is the user's exact pick and is used as-is in
// every theme.

export const PROJECT_PALETTE = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'grey'] as const

export type ProjectPaletteColor = (typeof PROJECT_PALETTE)[number]

/** A palette name, or a custom colour as lowercase `#rrggbb` (the only spelling ever stored). */
export type ProjectColor = ProjectPaletteColor | `#${string}`

/** What the settings page calls each palette colour ("Colour: Blue"). */
export const PROJECT_COLOR_LABEL: Readonly<Record<ProjectPaletteColor, string>> = Object.freeze({
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  grey: 'Grey'
})

export function isPaletteColor(value: unknown): value is ProjectPaletteColor {
  return typeof value === 'string' && (PROJECT_PALETTE as readonly string[]).includes(value)
}

const HEX_DIGITS = '0123456789abcdefABCDEF'

/**
 * `#rrggbb` in either case, nothing else (no `#rgb`, no alpha, no names, no spaces). A length
 * check and a character loop rather than a regex: the value comes from a user-writable file or a
 * renderer, and a plain loop over seven characters has nothing to backtrack.
 */
function isHex6(value: string): boolean {
  if (value.length !== 7 || value[0] !== '#') return false
  for (let i = 1; i < 7; i++) {
    if (!HEX_DIGITS.includes(value[i]!)) return false
  }
  return true
}

/**
 * The colour a stored value stands for, or undefined (none). Lenient on purpose: the record file
 * is user-writable, so anything that is not a palette name or a `#rrggbb` (a number, `"#fff"`,
 * `"Blue"`, an object) reads as no colour instead of failing the project. A hex comes back lower
 * case, as the setter stores it.
 */
export function projectColorOf(value: unknown): ProjectColor | undefined {
  if (isPaletteColor(value)) return value
  if (typeof value === 'string' && isHex6(value)) return value.toLowerCase() as ProjectColor
  return undefined
}

/**
 * A colour the user asked for, checked strictly (Settings › This project): a palette name, a
 * `#rrggbb` (normalised to lower case), or null for none. Anything else throws with the reason,
 * and nothing is stored.
 */
export function checkProjectColor(value: unknown): ProjectColor | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new Error('give a palette colour, a #rrggbb colour or none')
  const color = projectColorOf(value)
  if (color === undefined) {
    throw new Error(`not a project colour: use one of ${PROJECT_PALETTE.join(', ')} or #rrggbb`)
  }
  return color
}

/** The CSS value of a colour: its theme token for a palette name, the hex itself for a custom one. */
export function projectColorCss(color: ProjectColor): string {
  return isPaletteColor(color) ? `var(--cc-project-${color})` : color
}

/** How a colour is named to a screen reader and in tooltips ("Blue", "Custom #12abef"). */
export function projectColorName(color: ProjectColor): string {
  return isPaletteColor(color) ? PROJECT_COLOR_LABEL[color] : `Custom ${color}`
}
