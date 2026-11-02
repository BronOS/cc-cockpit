// The terminal font dropdown's pure logic (Settings › Appearance and keys › Terminal › Font
// family): which sections and options it lists for a filter, what a pick stores, which option the
// stored value is, and where the keyboard highlight goes. DOM-free so the unit tests (plain Node)
// cover it; the component is TerminalFontPicker.tsx.
//
// Whatever is picked is stored as today, a CSS font list in `terminalFont.family`, so main's
// checks and every terminal stay as they were: a bundled font as `"Cockpit … NF", monospace`, an
// installed one as `<its CSS name>, monospace`, and Custom… as whatever the user types.
import { BUNDLED_TERMINAL_FONTS, bundledFontValue } from '../../shared/terminal-font'
import { cssFamilyName } from './local-fonts'

export interface FontOption {
  /** Unique among the options; part of the option's DOM id (aria-activedescendant). */
  id: string
  kind: 'bundled' | 'installed' | 'custom'
  /** The friendly name shown (and filtered on). */
  label: string
  /** The CSS font list a pick stores and the option draws its name with; '' for Custom… */
  value: string
}

/**
 * The Installed section's source: not asked yet, being listed (queryLocalFonts can take a few
 * seconds the first time), cannot be listed (no API, permission refused), or the family names.
 */
export type InstalledFonts =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'unavailable' }
  | { state: 'ready'; families: readonly string[] }

/** A row of a section: an option, or a line saying why there are none (drawn as a disabled option). */
export type FontEntry = { kind: 'option'; option: FontOption } | { kind: 'note'; text: string }

export interface FontSection {
  id: 'bundled' | 'installed' | 'custom'
  /** Shown as the group's heading; the Custom… entry has none. */
  title: string | null
  entries: FontEntry[]
}

export interface FontList {
  sections: FontSection[]
  /** Every selectable option in display order: what ↑/↓ walk through. */
  options: FontOption[]
}

export const CUSTOM_OPTION: Readonly<FontOption> = Object.freeze({ id: 'custom', kind: 'custom', label: 'Custom…', value: '' })

export const INSTALLED_NOTES = {
  loading: 'Listing the installed fonts…',
  unavailable: 'The installed fonts cannot be listed here; choose Custom… and type the family name.',
  none: 'No monospaced fonts are installed.'
} as const

/** What picking an installed family stores: its CSS name, then `monospace` for a missing glyph's fallback. */
export function installedValue(family: string): string {
  return `${cssFamilyName(family)}, monospace`
}

export function bundledOptions(): FontOption[] {
  return BUNDLED_TERMINAL_FONTS.map((f) => ({ id: f.id, kind: 'bundled', label: f.label, value: bundledFontValue(f) }))
}

export function installedOptions(families: readonly string[]): FontOption[] {
  // The index keeps ids unique and DOM-safe whatever the family name holds (spaces, quotes).
  return families.map((family, i) => ({ id: `installed-${i}`, kind: 'installed', label: family, value: installedValue(family) }))
}

function matches(option: FontOption, q: string): boolean {
  return q === '' || option.label.toLowerCase().includes(q)
}

/**
 * The sections for `query` (case and surrounding spaces ignored, matched on the shown name):
 * Bundled, Installed, then Custom… on its own. While filtering, a section left with no match is
 * dropped, but Installed keeps its note when it has no list to filter (still listing, or cannot
 * list: that is worth saying whatever is typed), and Custom… is always there, so a family that is
 * not listed can still be typed.
 */
export function fontList(installed: InstalledFonts, query: string): FontList {
  const q = query.trim().toLowerCase()
  const sections: FontSection[] = []
  const bundled = bundledOptions().filter((o) => matches(o, q))
  if (bundled.length > 0 || q === '') {
    sections.push({ id: 'bundled', title: 'Bundled', entries: bundled.map((option) => ({ kind: 'option', option })) })
  }
  let installedEntries: FontEntry[] | null
  if (installed.state === 'ready') {
    const options = installedOptions(installed.families).filter((o) => matches(o, q))
    if (installed.families.length === 0) installedEntries = [{ kind: 'note', text: INSTALLED_NOTES.none }]
    // A list with no match for the filter (an empty filter matches every family).
    else if (options.length === 0) installedEntries = null
    else installedEntries = options.map((option) => ({ kind: 'option', option }))
  } else {
    installedEntries = [{ kind: 'note', text: installed.state === 'unavailable' ? INSTALLED_NOTES.unavailable : INSTALLED_NOTES.loading }]
  }
  if (installedEntries) sections.push({ id: 'installed', title: 'Installed', entries: installedEntries })
  sections.push({ id: 'custom', title: null, entries: [{ kind: 'option', option: CUSTOM_OPTION }] })
  const options = sections.flatMap((s) => s.entries.flatMap((e) => (e.kind === 'option' ? [e.option] : [])))
  return { sections, options }
}

// One CSS family name as cssFamilyName writes it: plain words, or a double-quoted string with
// `"` and `\` escaped. Followed by the `, monospace` installedValue appends.
const INSTALLED_VALUE = /^(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_-][\w-]*(?: [A-Za-z_-][\w-]*)*)), monospace$/

/**
 * The family name when `value` is exactly what picking an installed family stores (`Menlo,
 * monospace`, `"3270 Nerd Font", monospace`), else null. Read from the value alone, so the
 * dropdown names the font before (or without) the installed list.
 */
export function installedFamilyOf(value: string): string | null {
  const m = INSTALLED_VALUE.exec(value)
  if (!m) return null
  const family = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]!
  // Round trip: `"Menlo", monospace` names Menlo too, but is not what a pick stores; it reads as
  // custom so the field that shows the exact list stays open.
  return installedValue(family) === value ? family : null
}

/** The bundled option `value` is, or undefined. */
export function bundledOptionOf(value: string): FontOption | undefined {
  return bundledOptions().find((o) => o.value === value)
}

/** Whether `value` is none of the dropdown's picks: the Custom… field is shown for it. */
export function isCustomValue(value: string): boolean {
  return bundledOptionOf(value) === undefined && installedFamilyOf(value) === null
}

/** What the closed dropdown shows for the stored family. */
export function fontLabel(value: string): string {
  return bundledOptionOf(value)?.label ?? installedFamilyOf(value) ?? 'Custom'
}

/** The id of the option the stored family is (highlighted when the list opens), among `options`. */
export function selectedOptionId(value: string, options: readonly FontOption[]): string {
  return options.find((o) => o.kind !== 'custom' && o.value === value)?.id ?? CUSTOM_OPTION.id
}

/**
 * Where ↑ (-1) or ↓ (+1) moves the highlight from the option `from`: the next one that way,
 * stopping at the ends (as the project picker does). A highlight the list no longer has (filtered
 * out, or nothing yet) lands on the first option.
 */
export function moveActive(options: readonly FontOption[], from: string | null, step: 1 | -1): string | null {
  if (options.length === 0) return null
  const i = options.findIndex((o) => o.id === from)
  if (i < 0) return options[0]!.id
  return options[Math.min(options.length - 1, Math.max(0, i + step))]!.id
}
