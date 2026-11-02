// Turns the see-through background on for this window (see-through.ts) and keeps it in step: the
// opacity with the prefs main pushes (a slider move in any window's settings), the terminal glass's
// colour with the theme. Called once, by App, when `window.info` says main made the window
// transparent, before the shell renders (its tab terminals read `isSeeThrough` when they are made).
import { currentPrefs, onPrefs } from '../prefs/prefs-store'
import { applySeeThroughArea, applyTerminalBase, applyWindowAlpha, markSeeThrough, setSeeThrough } from './see-through'
import { currentXtermTheme, onXtermTheme } from './theme-store'

export function startSeeThrough(): void {
  const root = document.documentElement
  setSeeThrough(true)
  applyWindowAlpha(root, currentPrefs().backgroundOpacity)
  applySeeThroughArea(root, currentPrefs().seeThroughArea)
  applyTerminalBase(root, currentXtermTheme())
  markSeeThrough(root)
  // For the page's life: the window stays transparent until it closes.
  onPrefs((prefs) => {
    applyWindowAlpha(root, prefs.backgroundOpacity)
    applySeeThroughArea(root, prefs.seeThroughArea)
  })
  onXtermTheme((xterm) => applyTerminalBase(root, xterm))
}
