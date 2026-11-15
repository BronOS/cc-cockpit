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
import { chordWith, splitChord } from '../../shared/keys'
import { parseInGroupCommandId } from '../../shared/tab-commands'

/** The letters whose primary-modifier chords (with or without Shift) the browser keeps. */
const KEPT_LETTERS = new Set(['w', 't', 'n'])

/**
 * Whether a browser on this platform keeps `chord` (canonical) for itself: the primary modifier
 * (Cmd on a Mac, Ctrl elsewhere) with W, T or N, optionally with Shift; Ctrl+Tab and Ctrl+Shift+Tab
 * on every platform; and on a Mac ⌥⌘← / ⌥⌘→ (Chrome's previous / next tab), which the split view's
 * Focus Pane Left / Right use (D10).
 */
export function browserKeeps(chord: string, mac: boolean): boolean {
  const parts = splitChord(chord)
  if (!parts) return false
  if (mac && (parts.key === 'left' || parts.key === 'right') && parts.mods.join('+') === 'alt+meta') return true
  const mods = parts.mods.filter((m) => m !== 'shift')
  if (mods.length !== 1) return false
  if (parts.key === 'tab') return mods[0] === 'ctrl'
  return mods[0] === (mac ? 'meta' : 'ctrl') && KEPT_LETTERS.has(parts.key)
}

/** `chord` with Alt added, in canonical order (`ctrl+shift+w` -> `ctrl+alt+shift+w`). */
export function withAlt(chord: string): string {
  return chordWith(chord, 'alt')
}

/**
 * The browser's stand-in for a kept chord: Alt added, or Ctrl when it has Alt already (⌥⌘← becomes
 * ⌃⌥⌘←, which Chrome on a Mac leaves to the page).
 */
export function alternativeOf(chord: string): string {
  const parts = splitChord(chord)
  return parts?.mods.includes('alt') ? chordWith(chord, 'ctrl') : withAlt(chord)
}

/**
 * The key table for the web shell: every chord the browser keeps moved to its Alt alternative, or
 * dropped when another command already has that alternative. A new view object; `view` is untouched.
 *
 * The "… in Group" commands (design-split-pages.md §4) yield instead: their default is their base's
 * chord plus Alt, which is exactly where a browser's New Claude Tab (Cmd+T kept) and New Shell Tab
 * (Cmd+Shift+T kept) move. Decided by the person (2026-11-14): in a browser New Claude Tab keeps
 * Ctrl+Alt+T and New Shell Tab Ctrl+Alt+Shift+T, and the derived commands lose a chord a moved one
 * takes (no chord in a browser by default; the palette runs them, Split Right / Down still open the
 * New tab menu, and a chord the person gives them elsewhere is kept). The desktop and the Mac remote
 * window (the desktop table, keybindings.ts) keep Cmd/Ctrl+Alt+T for "… in Group".
 */
export function webKeyTable(view: CommandsView, mac: boolean): CommandsView {
  const yields = (id: string): boolean => parseInGroupCommandId(id) !== undefined
  const taken = new Set<string>()
  for (const c of view.commands) if (c.key && !browserKeeps(c.key, mac) && !yields(c.id)) taken.add(c.key)
  // The command with `key` when no command took it yet (which it now holds), else with no chord.
  const assign = <C extends { key?: string }>(c: C, key: string): C => {
    const out = { ...c }
    if (taken.has(key)) delete out.key
    else {
      out.key = key
      taken.add(key)
    }
    return out
  }
  const moved = view.commands.map((c) => (!c.key || !browserKeeps(c.key, mac) || yields(c.id) ? c : assign(c, alternativeOf(c.key))))
  // A derived chord the browser keeps (one the person gave it) moves like any other, when free.
  const commands = moved.map((c) => (!c.key || !yields(c.id) ? c : assign(c, browserKeeps(c.key, mac) ? alternativeOf(c.key) : c.key)))
  return { ...view, commands }
}
