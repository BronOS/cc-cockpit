// The see-through background in the renderer (renderer/theme/see-through.ts): the glass alpha and
// class on the root, the terminal glass's colour, and the palette and xterm options a see-through
// tab terminal gets (TerminalSession spreads xtermLookOptions into xterm's options).
import { describe, expect, it } from 'vitest'
import {
  applySeeThroughArea,
  applyTerminalBase,
  applyWindowAlpha,
  markSeeThrough,
  rgbOf,
  SEE_THROUGH_CLASS,
  seeThroughXterm,
  SOLID_PANELS_CLASS,
  windowAlpha,
  xtermLookOptions,
  type SeeThroughRoot
} from '../../src/renderer/theme/see-through'

function fakeRoot(): SeeThroughRoot & { classes: string[]; props: Record<string, string> } {
  const classes: string[] = []
  const props: Record<string, string> = {}
  return {
    classes,
    props,
    classList: {
      add: (name) => void classes.push(name),
      toggle: (name, force) => {
        const at = classes.indexOf(name)
        if (force && at < 0) classes.push(name)
        if (!force && at >= 0) classes.splice(at, 1)
      }
    },
    style: {
      setProperty: (name, value) => {
        props[name] = value
      }
    }
  }
}

describe('rgbOf', () => {
  it('reads every hex form, ignoring the alpha', () => {
    expect(rgbOf('#000000')).toEqual({ r: 0, g: 0, b: 0 })
    expect(rgbOf('#faf8f6')).toEqual({ r: 250, g: 248, b: 246 })
    expect(rgbOf('#FAF8F6')).toEqual({ r: 250, g: 248, b: 246 })
    expect(rgbOf('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc })
    expect(rgbOf('#abcd')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc })
    expect(rgbOf('#11223380')).toEqual({ r: 0x11, g: 0x22, b: 0x33 })
  })

  it('reads rgb()/rgba() with commas or spaces, numbers or percents', () => {
    expect(rgbOf('rgb(26, 24, 23)')).toEqual({ r: 26, g: 24, b: 23 })
    expect(rgbOf('rgba(217, 119, 87, 0.14)')).toEqual({ r: 217, g: 119, b: 87 })
    expect(rgbOf('rgb(26 24 23 / 50%)')).toEqual({ r: 26, g: 24, b: 23 })
    expect(rgbOf('rgb(100%, 50%, 0%)')).toEqual({ r: 255, g: 128, b: 0 })
    expect(rgbOf('rgb(300, -4, 12.6)')).toEqual({ r: 255, g: 0, b: 13 })
  })

  it('reads hsl()/hsla() as CSS converts it', () => {
    expect(rgbOf('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0 })
    expect(rgbOf('hsl(120deg 100% 25%)')).toEqual({ r: 0, g: 128, b: 0 })
    expect(rgbOf('hsla(240, 100%, 50%, 0.3)')).toEqual({ r: 0, g: 0, b: 255 })
    expect(rgbOf('hsl(0, 0%, 100%)')).toEqual({ r: 255, g: 255, b: 255 })
    expect(rgbOf('hsl(-120, 100%, 50%)')).toEqual({ r: 0, g: 0, b: 255 })
  })

  it('refuses anything else', () => {
    for (const bad of ['', 'black', '#12', '#12345', 'rgb(1, 2)', 'rgb(a, b, c)', 'color-mix(in srgb, red, blue)', 'var(--cc-bg)']) {
      expect(rgbOf(bad), bad).toBeUndefined()
    }
  })
})

describe('seeThroughXterm', () => {
  it("makes the background transparent in the theme's own colour and keeps the rest", () => {
    const theme = { background: '#faf8f6', foreground: '#222222', red: '#cd3131' }
    expect(seeThroughXterm(theme)).toEqual({
      background: 'rgba(250, 248, 246, 0)',
      // The block cursor's text would otherwise be drawn in the (now transparent) background.
      cursorAccent: 'rgb(250, 248, 246)',
      foreground: '#222222',
      red: '#cd3131'
    })
    // A copy: the theme store's palette is shared by every terminal.
    expect(theme.background).toBe('#faf8f6')
  })

  it("keeps a theme's own cursor accent", () => {
    expect(seeThroughXterm({ background: '#000', cursorAccent: '#ff0000' }).cursorAccent).toBe('#ff0000')
  })

  it("uses xterm's default black when the theme sets no background", () => {
    expect(seeThroughXterm({})).toEqual({ background: 'rgba(0, 0, 0, 0)', cursorAccent: 'rgb(0, 0, 0)' })
  })

  it('leaves a palette it cannot read opaque', () => {
    expect(seeThroughXterm({ background: 'black', foreground: '#fff' })).toEqual({ background: 'black', foreground: '#fff' })
  })
})

describe('the root', () => {
  it('turns the percent into a CSS alpha, guarded against a non-number', () => {
    expect(windowAlpha(85)).toBe('0.85')
    expect(windowAlpha(40)).toBe('0.4')
    expect(windowAlpha(100)).toBe('1')
    expect(windowAlpha(140)).toBe('1')
    expect(windowAlpha(-3)).toBe('0')
    expect(windowAlpha(Number.NaN)).toBe('1')
  })

  it('sets the class, the alpha and the terminal glass colour', () => {
    const root = fakeRoot()
    markSeeThrough(root)
    applyWindowAlpha(root, 60)
    applyTerminalBase(root, { background: 'hsl(0, 0%, 100%)' })
    expect(root.classes).toEqual([SEE_THROUGH_CLASS])
    expect(root.props).toEqual({ '--cc-window-alpha': '0.6', '--cc-terminal-glass-base': 'rgb(255, 255, 255)' })
  })

  it('keeps the panels solid only for the main area, switching both ways live', () => {
    const root = fakeRoot()
    applySeeThroughArea(root, 'window')
    expect(root.classes).toEqual([])
    applySeeThroughArea(root, 'main')
    applySeeThroughArea(root, 'main')
    expect(root.classes).toEqual([SOLID_PANELS_CLASS])
    applySeeThroughArea(root, 'window')
    expect(root.classes).toEqual([])
  })

  it('leaves the terminal glass on --cc-terminal-bg when xterm has no readable background', () => {
    const root = fakeRoot()
    applyTerminalBase(root, {})
    applyTerminalBase(root, { background: 'black' })
    expect(root.props).toEqual({})
  })
})

describe('xtermLookOptions', () => {
  const dark = { background: '#000000', foreground: '#dddddd' }

  it('gives a see-through tab terminal the transparent palette and allowTransparency', () => {
    expect(xtermLookOptions(true, dark)).toEqual({
      theme: { background: 'rgba(0, 0, 0, 0)', cursorAccent: 'rgb(0, 0, 0)', foreground: '#dddddd' },
      allowTransparency: true
    })
  })

  it('leaves opaque windows and overlays without the transparency cost, the palette as the theme has it', () => {
    const options = xtermLookOptions(false, dark)
    expect(options).toEqual({ theme: dark })
    expect(options).not.toHaveProperty('allowTransparency')
    // A copy: xterm repaints on assignment, and the store's palette is shared by every terminal.
    expect(options.theme).not.toBe(dark)
  })

  it('follows a theme switch: the new background, still transparent', () => {
    expect(xtermLookOptions(true, { background: '#faf8f6', foreground: '#222222' }).theme).toEqual({
      background: 'rgba(250, 248, 246, 0)',
      cursorAccent: 'rgb(250, 248, 246)',
      foreground: '#222222'
    })
  })
})
