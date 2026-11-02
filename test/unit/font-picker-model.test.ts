// The terminal font dropdown's model (renderer/settings/font-picker-model.ts): its sections for a
// filter and each state of the installed list, what a pick stores, which option the stored family
// is, and the keyboard highlight.
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_OPTION,
  fontLabel,
  fontList,
  installedFamilyOf,
  installedValue,
  INSTALLED_NOTES,
  isCustomValue,
  moveActive,
  selectedOptionId,
  type FontList,
  type InstalledFonts
} from '../../src/renderer/settings/font-picker-model'
import { DEFAULT_TERMINAL_FONT } from '../../src/shared/terminal-font'

const READY: InstalledFonts = { state: 'ready', families: ['3270 Nerd Font', 'Fira Code', 'Menlo'] }

/** Each section as its id and its rows (an option's label, or `note: <text>`). */
const shape = (list: FontList): Array<[string, string[]]> =>
  list.sections.map((s) => [s.id, s.entries.map((e) => (e.kind === 'option' ? e.option.label : `note: ${e.text}`))])

describe('fontList', () => {
  it('lists Bundled, Installed, then Custom… last', () => {
    const list = fontList(READY, '')
    expect(shape(list)).toEqual([
      ['bundled', ['JetBrains Mono Nerd Font', 'MesloLGS NF']],
      ['installed', ['3270 Nerd Font', 'Fira Code', 'Menlo']],
      ['custom', ['Custom…']]
    ])
    expect(list.sections.map((s) => s.title)).toEqual(['Bundled', 'Installed', null])
    expect(list.options.map((o) => o.label)).toEqual([
      'JetBrains Mono Nerd Font',
      'MesloLGS NF',
      '3270 Nerd Font',
      'Fira Code',
      'Menlo',
      'Custom…'
    ])
    expect(list.options.at(-1)).toEqual(CUSTOM_OPTION)
  })

  it('stores a bundled font as its Cockpit family plus monospace, an installed one as its CSS name', () => {
    const [jetbrains, meslo, n3270, fira] = fontList(READY, '').options
    expect(jetbrains!.value).toBe(DEFAULT_TERMINAL_FONT.family)
    expect(jetbrains!.value).toBe('"Cockpit JetBrains Mono NF", monospace')
    expect(meslo!.value).toBe('"Cockpit MesloLGS NF", monospace')
    // A name starting with a digit is quoted (an unquoted CSS word may not).
    expect(n3270!.value).toBe('"3270 Nerd Font", monospace')
    expect(fira!.value).toBe('Fira Code, monospace')
  })

  it('says why the installed section is empty instead of listing', () => {
    for (const state of [{ state: 'idle' }, { state: 'loading' }] as const) {
      expect(shape(fontList(state, ''))[1]).toEqual(['installed', [`note: ${INSTALLED_NOTES.loading}`]])
    }
    expect(shape(fontList({ state: 'unavailable' }, ''))[1]).toEqual(['installed', [`note: ${INSTALLED_NOTES.unavailable}`]])
    expect(shape(fontList({ state: 'ready', families: [] }, ''))[1]).toEqual(['installed', [`note: ${INSTALLED_NOTES.none}`]])
    // A note is not an option: ↑/↓ skip it.
    expect(fontList({ state: 'unavailable' }, '').options.map((o) => o.id)).toEqual(['jetbrains-mono-nf', 'meslolgs-nf', 'custom'])
  })

  it('filters on the shown name, ignoring case and spaces, and drops a section with no match', () => {
    expect(shape(fontList(READY, '  MESLO '))).toEqual([
      ['bundled', ['MesloLGS NF']],
      ['custom', ['Custom…']]
    ])
    expect(shape(fontList(READY, 'nerd'))).toEqual([
      ['bundled', ['JetBrains Mono Nerd Font']],
      ['installed', ['3270 Nerd Font']],
      ['custom', ['Custom…']]
    ])
    // Custom… stays whatever is typed: a family nobody lists can still be typed in.
    expect(shape(fontList(READY, 'zzz'))).toEqual([['custom', ['Custom…']]])
    // An installed list that cannot be filtered keeps saying why.
    expect(shape(fontList({ state: 'unavailable' }, 'zzz'))).toEqual([
      ['installed', [`note: ${INSTALLED_NOTES.unavailable}`]],
      ['custom', ['Custom…']]
    ])
  })

  it('gives every option a DOM-safe unique id whatever the family name holds', () => {
    const ids = fontList({ state: 'ready', families: ['A "B"', 'A "B" ', 'C\\D'] }, '').options.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[\w-]+$/)
  })
})

describe('the stored family', () => {
  it('names the bundled, installed or custom pick it is', () => {
    expect(fontLabel(DEFAULT_TERMINAL_FONT.family)).toBe('JetBrains Mono Nerd Font')
    expect(fontLabel('"Cockpit MesloLGS NF", monospace')).toBe('MesloLGS NF')
    expect(fontLabel('Menlo, monospace')).toBe('Menlo')
    expect(fontLabel('"3270 Nerd Font", monospace')).toBe('3270 Nerd Font')
    expect(fontLabel('Menlo, Monaco, "Courier New", monospace')).toBe('Custom')
    expect(fontLabel('Menlo')).toBe('Custom')
  })

  it('reads an installed pick from the value alone, round trip only', () => {
    for (const family of ['Menlo', 'Fira Code', '3270 Nerd Font', 'A "quoted" \\ name']) {
      expect(installedFamilyOf(installedValue(family))).toBe(family)
    }
    // Names Menlo, but is not what a pick stores: the Custom… field shows the exact list.
    expect(installedFamilyOf('"Menlo", monospace')).toBeNull()
    expect(installedFamilyOf('Menlo, monospace, serif')).toBeNull()
    expect(installedFamilyOf('Menlo,monospace')).toBeNull()
  })

  it('shows the Custom… field only for a value no pick stores', () => {
    expect(isCustomValue(DEFAULT_TERMINAL_FONT.family)).toBe(false)
    expect(isCustomValue('"Cockpit MesloLGS NF", monospace')).toBe(false)
    expect(isCustomValue('Fira Code, monospace')).toBe(false)
    expect(isCustomValue('"Courier New", monospace, serif')).toBe(true)
    expect(isCustomValue('"Cockpit MesloLGS NF"')).toBe(true)
  })

  it('selects the option it is, Custom… when none', () => {
    const { options } = fontList(READY, '')
    expect(selectedOptionId(DEFAULT_TERMINAL_FONT.family, options)).toBe('jetbrains-mono-nf')
    expect(selectedOptionId('Fira Code, monospace', options)).toBe('installed-1')
    expect(selectedOptionId('Iosevka, monospace', options)).toBe('custom')
    expect(selectedOptionId('x', [])).toBe('custom')
  })
})

describe('moveActive', () => {
  const { options } = fontList(READY, '')
  it('steps and stops at the ends', () => {
    expect(moveActive(options, 'jetbrains-mono-nf', 1)).toBe('meslolgs-nf')
    expect(moveActive(options, 'meslolgs-nf', -1)).toBe('jetbrains-mono-nf')
    expect(moveActive(options, 'jetbrains-mono-nf', -1)).toBe('jetbrains-mono-nf')
    expect(moveActive(options, 'custom', 1)).toBe('custom')
  })
  it('lands on the first option from a highlight the list no longer has', () => {
    expect(moveActive(options, null, 1)).toBe('jetbrains-mono-nf')
    expect(moveActive(options, 'installed-99', -1)).toBe('jetbrains-mono-nf')
    expect(moveActive([], 'custom', 1)).toBeNull()
  })
})
