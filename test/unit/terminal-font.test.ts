// The terminal font setting's checks (main/settings/terminal-font.ts): a tolerant reader for what
// app.json holds and a strict one for what the settings page sends.
import { describe, expect, it } from 'vitest'
import { storedTerminalFontFields, terminalFontOf, terminalFontPatchOf } from '../../src/main/settings/terminal-font'
import {
  BUNDLED_TERMINAL_FONTS,
  bundledFontValue,
  DEFAULT_TERMINAL_FONT,
  LEGACY_DEFAULT_FAMILY,
  MAX_FONT_FAMILY_LENGTH,
  type TerminalFont
} from '../../src/shared/terminal-font'

describe('terminalFontOf (app.json, user-writable)', () => {
  it('is the defaults when nothing usable is stored', () => {
    for (const stored of [undefined, null, 'Menlo', 13, [], ['Menlo']]) {
      expect(terminalFontOf(stored)).toEqual(DEFAULT_TERMINAL_FONT)
    }
    expect(DEFAULT_TERMINAL_FONT).toEqual({
      // The bundled JetBrains Mono NF (renderer/assets/fonts), monospace while it loads.
      family: '"Cockpit JetBrains Mono NF", monospace',
      size: 13,
      lineHeight: 1,
      letterSpacing: 0,
      weight: 'normal',
      boldWeight: 'bold'
    })
  })

  it('gives an unset family the bundled JetBrains Mono NF and keeps a family the user set', () => {
    expect(terminalFontOf({ size: 16 })).toEqual({ ...DEFAULT_TERMINAL_FONT, size: 16 })
    expect(terminalFontOf({ size: 16 }).family).toBe(bundledFontValue(BUNDLED_TERMINAL_FONTS[0]!))
    for (const family of ['"MesloLGS NF", monospace', 'Menlo', '"Cockpit MesloLGS NF", monospace', 'Menlo, monospace']) {
      expect(terminalFontOf({ family }).family).toBe(family)
    }
  })

  it('reads the pre-bundling default family, stored by the old whole-font setter, as unset', () => {
    // An app.json written by changing only the size: the user never picked Menlo.
    const stored = { family: LEGACY_DEFAULT_FAMILY, size: 15 }
    expect(terminalFontOf(stored)).toEqual({ ...DEFAULT_TERMINAL_FONT, size: 15 })
    expect(storedTerminalFontFields(stored)).toEqual({ size: 15 })
    // Anything else naming Menlo is a pick and is kept.
    expect(terminalFontOf({ family: 'Menlo, Monaco, monospace' }).family).toBe('Menlo, Monaco, monospace')
  })

  it('keeps every good field', () => {
    const font = { family: '"MesloLGS NF", monospace', size: 14.5, lineHeight: 1.2, letterSpacing: -1, weight: '300', boldWeight: '800' }
    expect(terminalFontOf(font)).toEqual(font)
  })

  it('replaces each damaged field by its own default, keeping the rest', () => {
    const cases: Array<[keyof TerminalFont, unknown]> = [
      ['family', ''],
      ['family', '   '],
      ['family', 42],
      ['family', 'a'.repeat(MAX_FONT_FAMILY_LENGTH + 1)],
      ['family', 'Menlo\nx'],
      ['family', 'Menlo; } body { display: none'],
      ['family', 'Menlo /* x'],
      ['size', 5],
      ['size', 73],
      ['size', '13'],
      ['size', Number.NaN],
      ['size', Number.POSITIVE_INFINITY],
      ['lineHeight', 0.9],
      ['lineHeight', 2.5],
      ['letterSpacing', -6],
      ['letterSpacing', 11],
      ['weight', 'heavy'],
      ['weight', 700],
      ['boldWeight', 'BOLD'],
      ['boldWeight', null]
    ]
    const good: TerminalFont = { family: 'Iosevka', size: 20, lineHeight: 1.5, letterSpacing: 2, weight: '300', boldWeight: '900' }
    for (const [field, bad] of cases) {
      const read = terminalFontOf({ ...good, [field]: bad })
      expect(read, `${field}=${String(bad)}`).toEqual({ ...good, [field]: DEFAULT_TERMINAL_FONT[field] })
    }
  })

  it('takes the range ends and a family exactly at the length limit', () => {
    const font = terminalFontOf({ family: 'a'.repeat(MAX_FONT_FAMILY_LENGTH), size: 6, lineHeight: 2, letterSpacing: -5 })
    expect(font).toMatchObject({ size: 6, lineHeight: 2, letterSpacing: -5 })
    expect(font.family).toHaveLength(MAX_FONT_FAMILY_LENGTH)
    expect(terminalFontOf({ size: 72, lineHeight: 1, letterSpacing: 10 })).toMatchObject({ size: 72, lineHeight: 1, letterSpacing: 10 })
  })

  it('does not read inherited keys', () => {
    const stored = Object.create({ size: 20 }) as object
    expect(terminalFontOf(stored).size).toBe(13)
  })
})

describe('storedTerminalFontFields (what the setter merges into)', () => {
  it('keeps only the good fields that are there, filling in no default', () => {
    expect(storedTerminalFontFields(undefined)).toEqual({})
    expect(storedTerminalFontFields({ size: 'huge', family: 'Iosevka', weight: '300', colour: 'red' })).toEqual({
      family: 'Iosevka',
      weight: '300'
    })
    const full: TerminalFont = { family: 'Iosevka', size: 20, lineHeight: 1.5, letterSpacing: 2, weight: '300', boldWeight: '900' }
    expect(storedTerminalFontFields(full)).toEqual(full)
  })
})

describe('terminalFontPatchOf (a settings page)', () => {
  it('passes the fields given, the family trimmed', () => {
    expect(terminalFontPatchOf({})).toEqual({})
    expect(terminalFontPatchOf({ family: '  JetBrainsMono Nerd Font  ', size: 16 })).toEqual({
      family: 'JetBrainsMono Nerd Font',
      size: 16
    })
    expect(terminalFontPatchOf({ lineHeight: 1.25, letterSpacing: 0.5, weight: 'normal', boldWeight: '600' })).toEqual({
      lineHeight: 1.25,
      letterSpacing: 0.5,
      weight: 'normal',
      boldWeight: '600'
    })
  })

  it.each([
    ['not an object', 'Menlo', /or null for the defaults/],
    ['an array', [], /or null for the defaults/],
    ['null (the reset is the service’s)', null, /or null for the defaults/],
    ['an unknown field', { colour: 'red' }, /unknown terminal font field: colour/],
    ['a prototype-named field', JSON.parse('{"__proto__": {"size": 1}}') as unknown, /unknown terminal font field: __proto__/],
    ['an empty family', { family: ' ' }, /give a font family/],
    ['a family that is not text', { family: ['Menlo'] }, /as text/],
    ['an over-long family', { family: 'a'.repeat(MAX_FONT_FAMILY_LENGTH + 1) }, /longer than 512/],
    ['a family with a newline', { family: 'Menlo\n' }, /control character/],
    ['a family with NUL', { family: 'Menlo\u0000' }, /control character/],
    ['a family with a C1 control', { family: 'Menlo\u0085' }, /control character/],
    ['a family that ends the CSS rule', { family: 'x} .xterm{display:none' }, /may not contain/],
    ['a family with a semicolon', { family: 'x; color: red' }, /may not contain/],
    ['a family opening a comment', { family: 'x /* y' }, /may not contain/],
    ['a size too small', { size: 5.5 }, /font size must be a number from 6 to 72/],
    ['a size as text', { size: '14' }, /font size must be/],
    ['a NaN size', { size: Number.NaN }, /font size must be/],
    ['a line height under 1 (xterm throws)', { lineHeight: 0.8 }, /line height must be a number from 1 to 2/],
    ['letter spacing too wide', { letterSpacing: 10.5 }, /letter spacing must be a number from -5 to 10/],
    ['an unknown weight', { weight: 'heavy' }, /weight must be one of/],
    ['a numeric weight', { boldWeight: 700 }, /bold weight must be one of/],
    ['one bad field among good ones', { family: 'Menlo', size: 100 }, /font size/]
  ])('refuses %s', (_name, value, message) => {
    expect(() => terminalFontPatchOf(value)).toThrow(message)
  })
})
