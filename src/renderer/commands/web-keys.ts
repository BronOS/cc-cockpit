// The web shell's key table (design-web.md §5.2 "Keys"). A browser keeps some chords for itself:
// it closes the browser tab on Ctrl/Cmd+W, opens one on Ctrl/Cmd+T and a window on Ctrl/Cmd+N,
// reopens a closed tab on Ctrl/Cmd+Shift+T and switches tabs on Ctrl+Tab, and a page never sees
// those keys (preventDefault cannot stop them). The cockpit's commands bound to such a chord (New
// Claude Tab Cmd+T, Close Tab Cmd+W, the Ctrl+Tab switcher, ...) get the same chord with Alt
// (Option) added in a browser: Ctrl+Alt+T, Ctrl+Alt+W, Ctrl+Alt+Tab, ⌥⌘T on a Mac. A chord the
// browser does not keep stays as it is. docs/features.md lists the mapping.
//
// Which chords a browser keeps depends on the BROWSER's platform (a Mac browser keeps Cmd+W, not
// Ctrl+W), while the table main sends is resolved for the host's platform: a Linux host's Ctrl+W is
// free in a Mac browser and stays Ctrl+W there. When the alternative is already another command's
// chord, the command keeps no chord in the browser (the palette still runs it) rather than steal it.
//
// Only the renderer's table changes: main, the desktop window and Settings › Keys keep the host's
// chords, and a chord rebound in Settings to one the browser does not keep is used as it is.
// DOM-free, so unit tests load it.
import type { CommandsView } from '../../shared/ipc'
import { splitChord } from '../../shared/keys'

/** The letters whose primary-modifier chords (with or without Shift) the browser keeps. */
const KEPT_LETTERS = new Set(['w', 't', 'n'])

/** Canonical modifier order (shared/keys.ts): `ctrl+alt+shift+meta+key`. */
const ORDER = ['ctrl', 'alt', 'shift', 'meta']

/**
 * Whether a browser on this platform keeps `chord` (canonical) for itself: the primary modifier
 * (Cmd on a Mac, Ctrl elsewhere) with W, T or N, optionally with Shift; Ctrl+Tab and Ctrl+Shift+Tab
 * on every platform.
 */
export function browserKeeps(chord: string, mac: boolean): boolean {
  const parts = splitChord(chord)
  if (!parts) return false
  const mods = parts.mods.filter((m) => m !== 'shift')
  if (mods.length !== 1) return false
  if (parts.key === 'tab') return mods[0] === 'ctrl'
  return mods[0] === (mac ? 'meta' : 'ctrl') && KEPT_LETTERS.has(parts.key)
}

/** `chord` with Alt added, in canonical order (`ctrl+shift+w` -> `ctrl+alt+shift+w`). */
export function withAlt(chord: string): string {
  const parts = splitChord(chord)
  if (!parts || parts.mods.includes('alt')) return chord
  const mods = [...parts.mods, 'alt'].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
  return [...mods, parts.key].join('+')
}

/**
 * The key table for the web shell: every chord the browser keeps moved to its Alt alternative, or
 * dropped when another command already has that alternative. A new view object; `view` is untouched.
 */
export function webKeyTable(view: CommandsView, mac: boolean): CommandsView {
  const taken = new Set<string>()
  for (const c of view.commands) if (c.key && !browserKeeps(c.key, mac)) taken.add(c.key)
  const commands = view.commands.map((c) => {
    if (!c.key || !browserKeeps(c.key, mac)) return c
    const alt = withAlt(c.key)
    const out = { ...c }
    if (taken.has(alt)) delete out.key
    else {
      out.key = alt
      taken.add(alt)
    }
    return out
  })
  return { ...view, commands }
}
