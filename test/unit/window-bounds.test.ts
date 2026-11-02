import { describe, expect, it } from 'vitest'
import { fitBounds, sanitizeBounds, type Rect } from '../../src/main/windows/window-bounds'

// A laptop (primary) with a larger external display to its right.
const screen: Rect[] = [
  { x: 0, y: 25, width: 1440, height: 875 },
  { x: 1440, y: 0, width: 1920, height: 1080 }
]

describe('sanitizeBounds', () => {
  it('keeps well-formed bounds and only true flags', () => {
    expect(sanitizeBounds({ x: 10, y: 20, width: 900, height: 650 })).toEqual({
      x: 10,
      y: 20,
      width: 900,
      height: 650
    })
    expect(
      sanitizeBounds({ x: 10, y: 20, width: 900, height: 650, maximized: true, fullScreen: false })
    ).toEqual({ x: 10, y: 20, width: 900, height: 650, maximized: true })
    expect(sanitizeBounds({ width: 900, height: 650, fullScreen: true })).toEqual({
      width: 900,
      height: 650,
      fullScreen: true
    })
  })

  it('drops a value without a usable size (default size)', () => {
    for (const bad of [
      undefined,
      null,
      'big',
      [900, 650],
      {},
      { width: 900 },
      { width: '900', height: 650 },
      { width: 900, height: Number.NaN },
      { width: Infinity, height: 650 },
      { width: 0, height: 650 },
      { width: -900, height: 650 }
    ]) {
      expect(sanitizeBounds(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('keeps the size but drops a half or broken position (OS-centred)', () => {
    expect(sanitizeBounds({ x: 10, width: 900, height: 650 })).toEqual({ width: 900, height: 650 })
    expect(sanitizeBounds({ x: '10', y: 20, width: 900, height: 650 })).toEqual({
      width: 900,
      height: 650
    })
    expect(sanitizeBounds({ x: 10, y: Number.NaN, width: 900, height: 650 })).toEqual({
      width: 900,
      height: 650
    })
  })

  it('rounds, raises a tiny size to the minimum and caps an absurd one; non-true flags are off', () => {
    expect(
      sanitizeBounds({ x: 10.4, y: 20.6, width: 100, height: 1e9, maximized: 'yes', fullScreen: 1 })
    ).toEqual({ x: 10, y: 21, width: 480, height: 16384 })
  })
})

describe('fitBounds', () => {
  it('keeps bounds that are on a display, including the second one and across both', () => {
    expect(fitBounds({ x: 10, y: 30, width: 800, height: 600 }, screen)).toEqual({
      x: 10,
      y: 30,
      width: 800,
      height: 600
    })
    expect(fitBounds({ x: 2000, y: 100, width: 800, height: 600 }, screen)).toEqual({
      x: 2000,
      y: 100,
      width: 800,
      height: 600
    })
    // Spanning both displays is a real setup; it must not be shrunk onto one of them.
    expect(fitBounds({ x: 1000, y: 100, width: 1200, height: 700 }, screen)?.width).toBe(1200)
  })

  it('clamps a window that shows only a sliver fully onto that display', () => {
    expect(fitBounds({ x: -790, y: 30, width: 800, height: 600 }, screen)).toEqual({
      x: 0,
      y: 30,
      width: 800,
      height: 600
    })
  })

  it('moves a window from an unplugged display onto the nearest one, shrunk to fit', () => {
    // Was on a third display further right: the external one is nearest.
    expect(fitBounds({ x: 4000, y: 100, width: 800, height: 600 }, screen)).toEqual({
      x: 2560,
      y: 100,
      width: 800,
      height: 600
    })
    // Was on a big display left of the laptop, and bigger than the laptop: shrunk to its work area.
    expect(fitBounds({ x: -3000, y: 0, width: 2560, height: 1400 }, screen)).toEqual({
      x: 0,
      y: 25,
      width: 1440,
      height: 875
    })
    // Below everything (resolution dropped): the nearest display by distance wins.
    expect(fitBounds({ x: 1500, y: 3000, width: 800, height: 600 }, screen)).toEqual({
      x: 1500,
      y: 480,
      width: 800,
      height: 600
    })
  })

  it('keeps the flags while fitting', () => {
    expect(fitBounds({ x: 4000, y: 100, width: 800, height: 600, maximized: true }, screen)).toEqual({
      x: 2560,
      y: 100,
      width: 800,
      height: 600,
      maximized: true
    })
    expect(fitBounds({ x: 10, y: 30, width: 800, height: 600, fullScreen: true }, screen)).toEqual({
      x: 10,
      y: 30,
      width: 800,
      height: 600,
      fullScreen: true
    })
  })

  it('size only: capped to the primary display, no position (the OS centres it)', () => {
    expect(fitBounds({ width: 800, height: 600 }, screen)).toEqual({ width: 800, height: 600 })
    expect(fitBounds({ width: 3000, height: 2000 }, screen)).toEqual({ width: 1440, height: 875 })
  })

  it('passes missing bounds through (default size), and bounds when no display is known', () => {
    expect(fitBounds(undefined, screen)).toBeUndefined()
    expect(fitBounds({ x: 9000, y: 9000, width: 800, height: 600 }, [])).toEqual({
      x: 9000,
      y: 9000,
      width: 800,
      height: 600
    })
  })
})
