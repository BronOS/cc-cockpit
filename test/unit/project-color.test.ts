// The project colour value (shared/project-color.ts): the strict check the setter runs, the
// lenient read of a user-writable record, and the CSS every surface draws it with.
import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES } from '../../src/main/themes/theme-service'
import {
  checkProjectColor,
  PROJECT_PALETTE,
  projectColorCss,
  projectColorName,
  projectColorOf
} from '../../src/shared/project-color'

describe('checkProjectColor', () => {
  it('takes the palette names, a #rrggbb in any case (stored in lower case) and null for none', () => {
    for (const name of PROJECT_PALETTE) expect(checkProjectColor(name)).toBe(name)
    expect(checkProjectColor('#12abef')).toBe('#12abef')
    expect(checkProjectColor('#12ABEF')).toBe('#12abef')
    expect(checkProjectColor('#000000')).toBe('#000000')
    expect(checkProjectColor(null)).toBeNull()
  })

  it('refuses everything else with the reason', () => {
    const bad: unknown[] = [
      'Blue',
      'BLUE',
      'pink',
      'gray',
      '',
      '#fff',
      '#12abe',
      '#12abef0',
      '#12abefaa',
      '12abef#',
      ' #12abef',
      '#12abef ',
      '#12abeg',
      '#12abéf',
      'rgb(1, 2, 3)',
      'var(--cc-bg)',
      'url(x)',
      '#'.repeat(10_000),
      undefined,
      7,
      true,
      ['blue'],
      { color: 'blue' }
    ]
    for (const value of bad) {
      expect(() => checkProjectColor(value), JSON.stringify(value)).toThrow(/project colour|palette colour/)
    }
  })
})

describe('projectColorOf (a stored value)', () => {
  it('reads anything but a palette name or #rrggbb as none, a hex in lower case', () => {
    expect(projectColorOf('teal')).toBe('teal')
    expect(projectColorOf('#ABCDEF')).toBe('#abcdef')
    for (const value of ['Teal', '#abc', 5, null, undefined, {}, 'url(x)']) expect(projectColorOf(value)).toBeUndefined()
  })
})

describe('projectColorCss and projectColorName', () => {
  it('a palette colour is its theme token, a custom one the hex itself', () => {
    expect(projectColorCss('blue')).toBe('var(--cc-project-blue)')
    expect(projectColorCss('#12abef')).toBe('#12abef')
    expect(projectColorName('grey')).toBe('Grey')
    expect(projectColorName('#12abef')).toBe('Custom #12abef')
  })

  it('both built-in themes define a token for every palette colour', () => {
    for (const theme of BUILTIN_THEMES) {
      for (const name of PROJECT_PALETTE) expect(theme.vars, `${theme.id} ${name}`).toHaveProperty(`--cc-project-${name}`)
    }
  })
})
