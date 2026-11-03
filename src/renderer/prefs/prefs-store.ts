// The app settings the shell page applies itself (ShellPrefs: where a tab's close button sits, how
// many changed files a session lists, when the side zones give way to a narrow terminal, the
// terminals' font, a transparent window's background opacity), kept like the theme: read from main once per page load and replaced whenever
// main pushes a change, so a pick in one window's settings shows in every window without a reload.
// Components read it through `usePrefs`; plain code through `currentPrefs` / `onPrefs`.
import { useSyncExternalStore } from 'react'
import type { ShellPrefs } from '../../shared/ipc'
import { SESSION_FILES_SHOWN_DEFAULT } from '../../shared/session-files'
import { DEFAULT_TERMINAL_FONT } from '../../shared/terminal-font'
import { DEFAULT_WINDOW_BACKGROUND } from '../../shared/window-background'
import { MIN_TERMINAL_WIDTH_DEFAULT, ZONE_AUTO_HIDE_DEFAULT } from '../../shared/zone-auto-hide'
import { loadTerminalFont } from '../tabs/terminal-font'

/** What a page shows before main has answered (and if it never does): the app's defaults. */
export const DEFAULT_PREFS: ShellPrefs = {
  tabCloseSide: 'right',
  sessionFilesShown: SESSION_FILES_SHOWN_DEFAULT,
  zoneAutoHide: ZONE_AUTO_HIDE_DEFAULT,
  minTerminalWidth: MIN_TERMINAL_WIDTH_DEFAULT,
  terminalFont: { ...DEFAULT_TERMINAL_FONT },
  backgroundOpacity: DEFAULT_WINDOW_BACKGROUND.opacity,
  seeThroughArea: DEFAULT_WINDOW_BACKGROUND.area
}

let prefs: ShellPrefs = DEFAULT_PREFS
const listeners = new Set<(prefs: ShellPrefs) => void>()

/** Replace the prefs (main's answer or push) and tell every listener. */
export function setPrefs(next: ShellPrefs): void {
  prefs = next
  for (const listener of listeners) listener(prefs)
}

export function currentPrefs(): ShellPrefs {
  return prefs
}

/** Be told when the prefs change; returns the unsubscribe function. */
export function onPrefs(listener: (prefs: ShellPrefs) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The current prefs; the component re-renders when they change. */
export function usePrefs(): ShellPrefs {
  return useSyncExternalStore(onPrefs, currentPrefs)
}

/** Fetch the prefs, then follow changes. Call once per page load, before the first render. */
export async function startPrefs(): Promise<void> {
  // Subscribed first: a change between the two cannot be lost. A push that lands while the font
  // loads below is newer than the answer, which must then not overwrite it.
  let pushed = false
  window.cockpit.on('prefs.changed', (next) => {
    pushed = true
    setPrefs(next)
  })
  const first = await window.cockpit.invoke('prefs.get')
  // Before the first terminal measures its cell (they are made after the first render).
  await loadTerminalFont(first.terminalFont)
  if (!pushed) setPrefs(first)
}
