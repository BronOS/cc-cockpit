// The see-through window background (Settings › Appearance › Window; `app.json` ›
// `windowBackground`). Only the backgrounds of a project window's own surfaces (the top bar, the
// tab bar, the terminal, the side and bottom zones) let the desktop through; text, icons, borders
// and the accent stay solid, and so do menus, the palette, dialogs, overlays and the settings
// screen (they are read, not glanced at). Shared so main validates against the same limits the
// settings page puts on its slider.

export interface WindowBackground {
  /**
   * Project windows are made transparent. Read by main when it creates a project window: Electron
   * cannot make an existing window transparent (or opaque again), so a change applies to project
   * windows opened afterwards, after a restart, and to a window reopened for it (`window.reopen`).
   */
  transparent: boolean
  /** How much of the theme's background colour the surfaces keep, in percent (WINDOW_OPACITY_RANGE). */
  opacity: number
  /**
   * Blur what is behind (macOS vibrancy, Windows 11 acrylic). Applied to the windows that were
   * made transparent, live; Linux has no such effect in Electron.
   */
  blur: boolean
  /**
   * Which surfaces let the desktop through: the whole window, or the main area only (the top bar,
   * the tab bar and the terminal) with the side and bottom zones (icon strips, panels) solid.
   * Live, like the opacity: it only picks which surfaces carry the glass.
   */
  area: SeeThroughArea
}

/** WindowBackground.area: 'window' (every shell surface) or 'main' (panels and their strips solid). */
export type SeeThroughArea = 'window' | 'main'

export function isSeeThroughArea(value: unknown): value is SeeThroughArea {
  return value === 'window' || value === 'main'
}

/**
 * Below 40 % the terminal's text sits on whatever the desktop shows (a white page behind a dark
 * theme) and stops being readable; 100 % is opaque but still a transparent window (it can go back
 * down live). Whole percents: a slider step, and app.json never holds 0.8500000001.
 */
export const WINDOW_OPACITY_RANGE = Object.freeze({ min: 40, max: 100 })

/**
 * Blur off: on macOS the vibrancy material is a near-solid grey tint (worse in dark mode), and in
 * the first manual test a window at 73 % with blur on looked opaque, as if the setting did nothing.
 */
export const DEFAULT_WINDOW_BACKGROUND: Readonly<WindowBackground> = Object.freeze({
  transparent: false,
  opacity: 80,
  blur: false,
  area: 'window'
})

/**
 * What blurring the background means on this platform, for the settings page: macOS vibrancy,
 * Windows acrylic (Windows 11 22H2 and later; no effect before), or nothing (Linux: Electron has
 * no blur-behind there). Decided by main from `process.platform`.
 */
export type BlurSupport = 'vibrancy' | 'acrylic' | 'none'
