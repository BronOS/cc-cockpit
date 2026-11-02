import { describe, expect, it } from 'vitest'
import {
  TITLE_BAR_HEIGHT,
  blurCall,
  blurSupport,
  projectWindowBackground,
  projectWindowChrome
} from '../../src/main/windows/window-chrome'

describe('projectWindowChrome', () => {
  it('hides the native title bar on macOS and centres the traffic lights on the page bar', () => {
    const options = projectWindowChrome('darwin')
    expect(options.titleBarStyle).toBe('hiddenInset')
    // 12px lights on the 40px bar: (40 - 12) / 2.
    expect(options.trafficLightPosition).toEqual({ x: 16, y: (TITLE_BAR_HEIGHT - 12) / 2 })
    // The frame stays: only the bar goes, so the window keeps its rounded corners, shadow and lights.
    expect(options.frame).toBeUndefined()
  })

  it('keeps the native frame everywhere else', () => {
    for (const platform of ['linux', 'win32', 'freebsd'] as const) {
      expect(projectWindowChrome(platform)).toEqual({})
    }
  })
})

describe('projectWindowBackground', () => {
  const platforms = ['darwin', 'win32', 'linux'] as const

  it('adds nothing when the window is opaque, whatever the blur says', () => {
    for (const platform of platforms) {
      expect(projectWindowBackground(platform, { transparent: false, blur: true })).toEqual({})
      expect(projectWindowBackground(platform, { transparent: false, blur: false })).toEqual({})
    }
  })

  it('makes the window transparent over a fully transparent background colour on every platform', () => {
    for (const platform of platforms) {
      const options = projectWindowBackground(platform, { transparent: true, blur: false })
      expect(options.transparent).toBe(true)
      // #AARRGGBB: alpha 0, or createWindow's opaque theme colour would fill the window.
      expect(options.backgroundColor).toBe('#00000000')
      expect(options.vibrancy).toBeUndefined()
      expect(options.backgroundMaterial).toBeUndefined()
    }
  })

  it('blurs with under-window vibrancy on macOS, kept active when the window loses focus', () => {
    expect(projectWindowBackground('darwin', { transparent: true, blur: true })).toEqual({
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'under-window',
      visualEffectState: 'active'
    })
    expect(projectWindowBackground('darwin', { transparent: true, blur: false }).visualEffectState).toBe('active')
  })

  it('blurs with the acrylic material on Windows and not at all on Linux', () => {
    expect(projectWindowBackground('win32', { transparent: true, blur: true })).toEqual({
      transparent: true,
      backgroundColor: '#00000000',
      backgroundMaterial: 'acrylic'
    })
    expect(projectWindowBackground('linux', { transparent: true, blur: true })).toEqual({
      transparent: true,
      backgroundColor: '#00000000'
    })
  })
})

describe('blurCall and blurSupport', () => {
  it('turns the blur on and off live through vibrancy on macOS and the material on Windows', () => {
    expect(blurCall('darwin', true)).toEqual({ kind: 'vibrancy', type: 'under-window' })
    expect(blurCall('darwin', false)).toEqual({ kind: 'vibrancy', type: null })
    expect(blurCall('win32', true)).toEqual({ kind: 'material', material: 'acrylic' })
    expect(blurCall('win32', false)).toEqual({ kind: 'material', material: 'none' })
  })

  it('has nothing to call on Linux, and says so to the settings page', () => {
    expect(blurCall('linux', true)).toBeUndefined()
    expect(blurCall('linux', false)).toBeUndefined()
    expect(blurSupport('darwin')).toBe('vibrancy')
    expect(blurSupport('win32')).toBe('acrylic')
    expect(blurSupport('linux')).toBe('none')
    expect(blurSupport('freebsd')).toBe('none')
  })
})
