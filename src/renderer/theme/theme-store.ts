// The DOM-free half of theming: apply a theme's variables to a root element and keep the xterm
// palette terminals start with. Split from apply-theme.ts (which touches window/document) so unit
// tests, which run in plain Node, can cover it with a fake root.
import type { Theme, XtermTheme } from '../../shared/theme'

type ThemeListener = (xterm: XtermTheme) => void

/** The part of an HTMLElement applyTheme needs; structural so tests can pass a fake. */
export interface ThemeRoot {
  style: {
    colorScheme: string
    setProperty(name: string, value: string): void
    removeProperty(name: string): unknown
  }
}

let applied: string[] = []
let xterm: XtermTheme = {}
let current: Theme | undefined
const listeners = new Set<ThemeListener>()
const themeListeners = new Set<(theme: Theme) => void>()

/** Put `theme` on `root`; variables of the previous theme that this one lacks are removed. */
export function applyTheme(theme: Theme, root: ThemeRoot): void {
  for (const name of applied) {
    if (!(name in theme.vars)) root.style.removeProperty(name)
  }
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value)
  applied = Object.keys(theme.vars)
  root.style.colorScheme = theme.kind
  xterm = theme.xterm
  current = theme
  for (const listener of listeners) listener(xterm)
  for (const listener of themeListeners) listener(theme)
}

/** The theme applied last (undefined before the first one); plugin frames get its variables. */
export function currentTheme(): Theme | undefined {
  return current
}

/** Be told when the theme changes (plugin frames re-post it); returns the unsubscribe function. */
export function onTheme(listener: (theme: Theme) => void): () => void {
  themeListeners.add(listener)
  return () => {
    themeListeners.delete(listener)
  }
}

/** The palette terminals created now should start with. */
export function currentXtermTheme(): XtermTheme {
  return xterm
}

/** Be told when the palette changes; returns the unsubscribe function. */
export function onXtermTheme(listener: ThemeListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
