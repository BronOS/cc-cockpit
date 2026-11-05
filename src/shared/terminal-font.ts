// The terminal font (Settings › Appearance › Terminal; `app.json` › `terminalFont`): what
// every xterm in the app draws with (tabs and terminal overlays), apart from the app UI's own
// font. Shared so main validates against the same limits the settings page puts on its inputs.

/**
 * xterm's `fontWeight` / `fontWeightBold` values. xterm also takes a number 1–1000, but silently
 * swaps anything it does not know for its default, so main offers (and accepts) only these.
 */
export const TERMINAL_FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const

export type TerminalFontWeight = (typeof TERMINAL_FONT_WEIGHTS)[number]

export interface TerminalFont {
  /** A CSS font-family list, e.g. `"MesloLGS NF", monospace`. */
  family: string
  /** Pixels. */
  size: number
  /** A multiple of the cell height xterm measures for the font. */
  lineHeight: number
  /** Extra pixels between cells (negative pulls them together). */
  letterSpacing: number
  weight: TerminalFontWeight
  boldWeight: TerminalFontWeight
}

/**
 * A font that ships with the app (renderer/assets/fonts, declared with @font-face in fonts.css; no
 * system install). `family` is the @font-face name, prefixed "Cockpit" so it can never resolve to
 * a copy the user has installed under the real name (an older version, or the non-Mono Nerd
 * variant with wide icons), which would make the cell measure differently from machine to machine.
 */
export interface BundledTerminalFont {
  /** Stable key (the option's id in the settings dropdown). */
  id: string
  /** What the settings page shows. */
  label: string
  /** The @font-face family. */
  family: string
}

export const BUNDLED_TERMINAL_FONTS: readonly BundledTerminalFont[] = Object.freeze([
  // The Nerd Fonts "Mono" variant: its icons are one cell wide, as a terminal grid needs (the
  // plain variant draws them wider and they run into the next character).
  Object.freeze({ id: 'jetbrains-mono-nf', label: 'JetBrains Mono Nerd Font', family: 'Cockpit JetBrains Mono NF' }),
  // powerlevel10k's recommended font (romkatv/powerlevel10k-media).
  Object.freeze({ id: 'meslolgs-nf', label: 'MesloLGS NF', family: 'Cockpit MesloLGS NF' })
])

/**
 * The CSS font list stored for a bundled font: its family, then `monospace` for the moment it
 * has not loaded yet.
 */
export function bundledFontValue(font: Pick<BundledTerminalFont, 'family'>): string {
  return `"${font.family}", monospace`
}

/**
 * The default family before the fonts were bundled. A settings change used to store the whole
 * font, so an app.json written by changing only the size holds this exact list although the user
 * never picked it; main reads it as "not set" (main/settings/terminal-font.ts).
 */
export const LEGACY_DEFAULT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'

/**
 * What every terminal draws with until the user picks something else: the bundled JetBrains
 * Mono NF, so a zsh or starship theme's icons draw out of the box.
 */
export const DEFAULT_TERMINAL_FONT: Readonly<TerminalFont> = Object.freeze({
  family: bundledFontValue(BUNDLED_TERMINAL_FONTS[0]!),
  size: 13,
  lineHeight: 1,
  letterSpacing: 0,
  weight: 'normal',
  boldWeight: 'bold'
})

/**
 * Inclusive ranges of the numeric fields. lineHeight starts at 1: xterm 6 throws on anything less
 * ("lineHeight cannot be less than 1"), which would break every terminal created after the change.
 */
export const TERMINAL_FONT_RANGES = {
  size: { min: 6, max: 72 },
  lineHeight: { min: 1, max: 2 },
  letterSpacing: { min: -5, max: 10 }
} as const

/** Longest family list accepted; a real one is a few names. */
export const MAX_FONT_FAMILY_LENGTH = 512
